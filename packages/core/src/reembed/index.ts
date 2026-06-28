import type { DB } from "../db/index.js";
import { vecToBlob } from "../db/index.js";
import { embed, type EmbedOptions } from "../ingest/index.js";

export interface ReembedOptions extends EmbedOptions {
  model: string;
  dim?: number;
  batchSize?: number;
  onProgress?: (progress: ReembedProgress) => void;
}

export interface ReembedProgress {
  migrated: number;
  total: number;
  model: string;
  dim: number;
}

// 用普通表暂存新向量（可续跑）。不能用 vec0 临时表再 RENAME——vec0 的 shadow 表
// （vec_chunks_chunks / _rowids / _vector_chunks00）不会跟着改名，RENAME 后整表查询直接报
// "no such table: vec_chunks_chunks"，会把检索彻底搞坏。
const STAGING_TABLE = "reembed_staging";
const STATE_TABLE = "reembed_state";

type ReembedState = {
  model: string;
  dim: number;
  baseUrl: string;
  apiKeyFingerprint: string;
};

export async function reembedKnowledge(db: DB, options: ReembedOptions): Promise<ReembedProgress> {
  const model = options.model.trim();
  if (!model) throw new Error("reembed 需要 --model");
  const batchSize = options.batchSize ?? 32;
  const dim = options.dim ?? (await detectDim(options));
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`无效 embedding 维度：${dim}`);

  db.exec(`CREATE TABLE IF NOT EXISTS ${STAGING_TABLE} (rowid INTEGER PRIMARY KEY, embedding BLOB NOT NULL)`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      base_url TEXT NOT NULL,
      api_key_fingerprint TEXT NOT NULL
    )`
  );

  const state = desiredState(model, dim, options);
  const previousState = readState(db);
  if (!sameState(previousState, state)) {
    db.exec(`DELETE FROM ${STAGING_TABLE}`);
    writeState(db, state);
  }

  const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM chunks`).get() as { count: number }).count);
  let migrated = Number((db.prepare(`SELECT COUNT(*) AS count FROM ${STAGING_TABLE}`).get() as { count: number }).count);
  options.onProgress?.({ migrated, total, model, dim });

  // 1) 重算所有 chunk 的向量，暂存进普通表（可中断续跑：只取尚未迁的）
  for (;;) {
    const rows = db
      .prepare(
        `SELECT c.rowid, c.text
         FROM chunks c
         LEFT JOIN ${STAGING_TABLE} s ON s.rowid = c.rowid
         WHERE s.rowid IS NULL
         ORDER BY c.rowid
         LIMIT ?`
      )
      .all(batchSize) as { rowid: number; text: string }[];
    if (rows.length === 0) break;

    const vectors = await embed(
      rows.map((row) => row.text),
      options
    );
    const insert = db.prepare(`INSERT OR REPLACE INTO ${STAGING_TABLE} (rowid, embedding) VALUES (?, ?)`);
    db.transaction(() => {
      rows.forEach((row, index) => insert.run(BigInt(row.rowid), vecToBlob(vectors[index])));
    })();

    migrated += rows.length;
    options.onProgress?.({ migrated, total, model, dim });
  }

  // 2) 原子切换：重建 vec_chunks 到新维度，从暂存表灌入，清理。
  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS vec_chunks`);
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine)`);
    const insertVec = db.prepare(`INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`);
    const staged = db.prepare(`SELECT rowid, embedding FROM ${STAGING_TABLE}`).all() as {
      rowid: number;
      embedding: Buffer;
    }[];
    for (const row of staged) insertVec.run(BigInt(row.rowid), row.embedding);
    db.exec(`DROP TABLE ${STAGING_TABLE}`);
    db.exec(`DROP TABLE ${STATE_TABLE}`);
    db.prepare(`UPDATE chunks SET embedding_model = ?`).run(model);
  })();

  // 3) 同步运行时 embedding 配置：embed() 按 call-time 读 process.env，更新后本进程的
  // searchKnowledge 会立刻用新模型嵌入查询，与刚迁好的新维向量表对齐。跨进程持久化由调用方负责。
  if (options.baseUrl) process.env.EMBEDDING_BASE_URL = options.baseUrl;
  if (options.apiKey) process.env.EMBEDDING_API_KEY = options.apiKey;
  process.env.EMBEDDING_MODEL = model;
  process.env.EMBEDDING_DIM = String(dim);

  return { migrated: total, total, model, dim };
}

function desiredState(model: string, dim: number, options: ReembedOptions): ReembedState {
  return {
    model,
    dim,
    baseUrl: options.baseUrl ?? process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",
    apiKeyFingerprint: fingerprint(options.apiKey ?? process.env.EMBEDDING_API_KEY ?? ""),
  };
}

function readState(db: DB): ReembedState | null {
  const row = db
    .prepare(
      `SELECT model, dim, base_url AS baseUrl, api_key_fingerprint AS apiKeyFingerprint
       FROM ${STATE_TABLE}
       WHERE id = 1`
    )
    .get() as ReembedState | undefined;
  return row ?? null;
}

function writeState(db: DB, state: ReembedState): void {
  db.prepare(
    `INSERT OR REPLACE INTO ${STATE_TABLE} (id, model, dim, base_url, api_key_fingerprint)
     VALUES (1, ?, ?, ?, ?)`
  ).run(state.model, state.dim, state.baseUrl, state.apiKeyFingerprint);
}

function sameState(a: ReembedState | null, b: ReembedState): boolean {
  return !!a && a.model === b.model && a.dim === b.dim && a.baseUrl === b.baseUrl && a.apiKeyFingerprint === b.apiKeyFingerprint;
}

function fingerprint(value: string): string {
  if (!value) return "";
  return `${value.length}:${value.slice(0, 4)}:${value.slice(-4)}`;
}

async function detectDim(options: ReembedOptions): Promise<number> {
  const [vector] = await embed(["BMO reembed dimension probe"], options);
  if (!vector?.length) throw new Error("无法检测新 embedding 模型维度");
  return vector.length;
}
