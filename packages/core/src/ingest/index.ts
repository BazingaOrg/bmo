import { nanoid } from "nanoid";
import { type DB, vecToBlob } from "../db/index.js";

/* ──────────────── 切块 ──────────────── */

const SEPARATORS = ["\n## ", "\n### ", "\n\n", "\n", "。", ". "];
const DEFAULT_MAX_CHARS = 1000; // 中文场景下约 500-600 token，Phase 2 用 eval 调参
const DEFAULT_OVERLAP = 120;

/** 递归切块：优先按大结构切，切不动再降级到小分隔符 */
export function chunkText(text: string, maxChars = chunkConfig().maxChars): string[] {
  const out: string[] = [];
  split(text.trim(), 0, out, maxChars);
  return withOverlap(mergeTiny(out.filter((c) => c.trim().length > 0)), chunkConfig().overlap);
}

export function chunkConfig(): { maxChars: number; overlap: number } {
  return {
    maxChars: positiveInt(process.env.BMO_CHUNK_MAX_CHARS, DEFAULT_MAX_CHARS),
    overlap: nonNegativeInt(process.env.BMO_CHUNK_OVERLAP, DEFAULT_OVERLAP),
  };
}

/** 不足 100 字符的碎块（如孤立标题）向后合并，避免浪费 embedding、污染检索 */
function mergeTiny(chunks: string[], min = 100): string[] {
  const out: string[] = [];
  let carry = "";
  for (const c of chunks) {
    const piece = carry ? carry + "\n" + c : c;
    if (piece.length < min) {
      carry = piece;
    } else {
      out.push(piece);
      carry = "";
    }
  }
  if (carry) {
    if (out.length > 0) out[out.length - 1] += "\n" + carry;
    else out.push(carry);
  }
  return out;
}

function split(text: string, sepIdx: number, out: string[], maxChars: number): void {
  if (text.length <= maxChars) {
    out.push(text);
    return;
  }
  if (sepIdx >= SEPARATORS.length) {
    for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
    return;
  }
  const sep = SEPARATORS[sepIdx];
  const parts = text.split(sep);
  if (parts.length === 1) {
    split(text, sepIdx + 1, out, maxChars);
    return;
  }
  let buf = "";
  for (const part of parts) {
    const piece = buf ? buf + sep + part : part;
    if (piece.length > maxChars && buf) {
      split(buf, sepIdx + 1, out, maxChars);
      buf = part;
    } else {
      buf = piece;
    }
  }
  if (buf) split(buf, sepIdx + 1, out, maxChars);
}

/** 给相邻块加少量重叠，缓解切断句义 */
function withOverlap(chunks: string[], overlap: number): string[] {
  if (overlap <= 0) return chunks;
  return chunks.map((c, i) => (i === 0 ? c : chunks[i - 1].slice(-overlap) + c));
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/* ──────────────── Embedding ──────────────── */

const BASE_URL = process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1";
const API_KEY = process.env.EMBEDDING_API_KEY ?? "";
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";

/** 调任何 OpenAI 兼容端点拿向量（OpenAI / DashScope / SiliconFlow 均可） */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Embedding API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/* ──────────────── 入库（eat）──────────────── */

export interface EatInput {
  title: string;
  markdown: string;
  sourceType: "text" | "url" | "pdf" | "docx" | "xlsx" | "image";
  sourceUrl?: string;
  rawPath?: string;
}

export interface EatResult {
  documentId: string;
  chunkCount: number;
}

/** 吞下一份内容：建文档 → 切块 → embedding → 写 chunks + 向量表 */
export async function eat(db: DB, input: EatInput): Promise<EatResult> {
  const pieces = chunkText(input.markdown);
  if (pieces.length === 0) throw new Error("内容为空，没东西可吃");

  // 批量 embedding（一次最多 64 条，避免请求过大）
  const vectors: number[][] = [];
  for (let i = 0; i < pieces.length; i += 64) {
    vectors.push(...(await embed(pieces.slice(i, i + 64))));
  }

  const docId = nanoid();
  const now = Date.now();

  const insertDoc = db.prepare(
    `INSERT INTO documents (id, title, source_type, source_url, raw_path, markdown, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (id, document_id, seq, text, embedding_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertVec = db.prepare(`INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`);

  // 事务保证文档、块、向量三者一致
  db.transaction(() => {
    insertDoc.run(docId, input.title, input.sourceType, input.sourceUrl ?? null, input.rawPath ?? null, input.markdown, now);
    pieces.forEach((text, seq) => {
      const info = insertChunk.run(nanoid(), docId, seq, text, EMBEDDING_MODEL, now);
      // 坑：better-sqlite3 把 JS number 按 double 绑定，而 vec0 的 rowid 严格要求
      // SQLITE_INTEGER，必须用 BigInt 绑定，否则报 "Only integers are allowed"
      insertVec.run(BigInt(info.lastInsertRowid), vecToBlob(vectors[seq]));
    });
  })();

  return { documentId: docId, chunkCount: pieces.length };
}
