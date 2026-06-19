import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DB = Database.Database;

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 1536);

export function defaultDbPath(): string {
  return process.env.BMO_DB_PATH ?? join(homedir(), ".bmo", "bmo.db");
}

/**
 * 打开数据库并完成初始化。
 * 这是全项目风险最高的一行链路：better-sqlite3 + sqlite-vec 扩展加载。
 * 跑 `pnpm verify:db` 验证它。
 */
export function openDb(path = defaultDbPath()): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  sqliteVec.load(db); // 加载向量扩展，提供 vec0 虚拟表
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      source_type TEXT NOT NULL,        -- text | url | pdf | docx | xlsx | image
      source_url  TEXT,
      raw_path    TEXT,
      markdown    TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id              TEXT PRIMARY KEY,
      document_id     TEXT NOT NULL REFERENCES documents(id),
      seq             INTEGER NOT NULL,
      text            TEXT NOT NULL,
      embedding_model TEXT NOT NULL,    -- 版本字段：换模型时支持渐进式重建
      created_at      INTEGER NOT NULL
    );

    -- 全文检索。tokenize='trigram' 对中文是务实选择：
    -- 默认 unicode61 不切分中文；trigram 按三字滑窗建索引，中英混合都能搜，
    -- 代价是查询词需 >= 3 个字符。后续可换 jieba 预分词方案。
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='rowid',
      tokenize='trigram'
    );

    -- 用触发器保持 FTS 与 chunks 同步
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
  `);

  // 向量表维度在建表时固定，所以单独建；rowid 与 chunks.rowid 一一对应
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${EMBEDDING_DIM}] distance_metric=cosine
    );
  `);
}

/** Float32Array -> BLOB，sqlite-vec 接受 float32 二进制 */
export function vecToBlob(v: number[] | Float32Array): Buffer {
  const f = v instanceof Float32Array ? v : new Float32Array(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
