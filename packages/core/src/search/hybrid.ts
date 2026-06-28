import { type DB, vecToBlob } from "../db/index.js";
import { embed } from "../ingest/index.js";

export interface SearchHit {
  chunkRowid: number;
  documentId: string;
  chunkSeq: number;
  text: string;
  documentTitle: string;
  sourceType: string;
  sourceUrl: string | null;
  /** 向量余弦相似度（0~1，纯关键词命中时为 null） */
  similarity: number | null;
  /** RRF 融合分，仅用于排序 */
  score: number;
}

const DEFAULT_RRF_K = 60;
const DEFAULT_RECALL_K = 20; // 每路召回数
// 0.5 由 Phase 2 eval 在 69 篇真实语料 + 30 条标注上调出:recall@5 仍 0.96(无损),
// 同时把无关查询的误召回从 100% 砍到 40%。想更严可调到 0.55(负样本零误召,但 recall 降到 0.92)。
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

export interface SearchConfig {
  rrfK: number;
  recallK: number;
  similarityThreshold: number;
}

export function searchConfig(): SearchConfig {
  return {
    rrfK: positiveNumber(process.env.BMO_RRF_K, DEFAULT_RRF_K),
    recallK: positiveInt(process.env.BMO_RECALL_K, DEFAULT_RECALL_K),
    similarityThreshold: boundedNumber(
      process.env.BMO_SIMILARITY_THRESHOLD ?? process.env.SIMILARITY_THRESHOLD,
      DEFAULT_SIMILARITY_THRESHOLD,
      0,
      1
    ),
  };
}

/**
 * Hybrid 检索：
 *  1. FTS5(BM25) 与 sqlite-vec(cosine) 各召回 top-20
 *  2. RRF 融合：score = Σ 1/(60 + rank)
 *  3. 阈值过滤：纯向量命中且相似度低于阈值的丢弃；全军覆没则返回空数组，
 *     让 Agent 如实告诉用户"库里没有相关内容"——这就是"不盲目引用"的底层机制
 */
export async function searchKnowledge(db: DB, query: string, topK = 5): Promise<SearchHit[]> {
  const config = searchConfig();
  const [qVec] = await embed([query]);

  // 向量召回：distance 为余弦距离，相似度 = 1 - distance
  const vecRows = db
    .prepare(
      `SELECT rowid, distance FROM vec_chunks
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`
    )
    .all(vecToBlob(qVec), config.recallK) as { rowid: number; distance: number }[];

  // 关键词召回：trigram 要求查询 >= 3 字符；非法语法（特殊符号）时静默降级为纯向量
  let ftsRows: { rowid: number }[] = [];
  if (query.trim().length >= 3) {
    try {
      ftsRows = db
        .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`)
        .all(`"${query.replace(/"/g, '""')}"`, config.recallK) as { rowid: number }[];
    } catch {
      /* FTS 语法错误不致命 */
    }
  }

  // RRF 融合
  const fused = new Map<number, { score: number; similarity: number | null }>();
  vecRows.forEach((r, rank) => {
    fused.set(r.rowid, { score: 1 / (config.rrfK + rank + 1), similarity: 1 - r.distance });
  });
  ftsRows.forEach((r, rank) => {
    const prev = fused.get(r.rowid);
    fused.set(r.rowid, {
      score: (prev?.score ?? 0) + 1 / (config.rrfK + rank + 1),
      similarity: prev?.similarity ?? null,
    });
  });

  const ftsSet = new Set(ftsRows.map((r) => r.rowid));
  const ranked = [...fused.entries()]
    // 阈值：关键词命中的保留；纯向量命中需达到相似度下限
    .filter(([rowid, v]) => ftsSet.has(rowid) || (v.similarity ?? 0) >= config.similarityThreshold)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topK);

  if (ranked.length === 0) return [];

  const getChunk = db.prepare(
    `SELECT c.rowid AS chunkRowid, c.document_id AS documentId, c.seq AS chunkSeq,
            c.text, d.title AS documentTitle,
            d.source_type AS sourceType, d.source_url AS sourceUrl
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.rowid = ?`
  );

  return ranked.map(([rowid, v]) => {
    const row = getChunk.get(rowid) as Omit<SearchHit, "similarity" | "score">;
    return { ...row, similarity: v.similarity, score: v.score };
  });
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
