/**
 * 第一天的风险验证脚本：better-sqlite3 + sqlite-vec + FTS5 三件套。
 * 不需要任何 API key。跑通即说明整个存储链路在你机器上成立。
 *   pnpm verify:db
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, vecToBlob, EMBEDDING_DIM } from "./db/index.js";

const dbPath = join(mkdtempSync(join(tmpdir(), "bmo-")), "verify.db");
const db = openDb(dbPath);
console.log(`✓ 打开数据库并加载 sqlite-vec：${dbPath}`);

// 插入一条假文档 + 两个块（向量用随机数，不调 API）
db.prepare(
  `INSERT INTO documents (id, title, source_type, markdown, created_at) VALUES (?, ?, ?, ?, ?)`
).run("doc1", "测试文档：猪周期与能繁母猪", "text", "全文略", Date.now());

const insertChunk = db.prepare(
  `INSERT INTO chunks (id, document_id, seq, text, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, ?)`
);
const insertVec = db.prepare(`INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`);

const fakeVec = () => Array.from({ length: EMBEDDING_DIM }, () => Math.random() - 0.5);
const texts = ["能繁母猪存栏量持续去化，猪周期接近底部区域。", "Agent loop 的核心是按 stop_reason 分支并回填 tool_result。"];
texts.forEach((t, i) => {
  const info = insertChunk.run(`c${i}`, "doc1", i, t, "fake-model", Date.now());
  insertVec.run(BigInt(info.lastInsertRowid), vecToBlob(fakeVec())); // vec0 rowid 必须 BigInt
});
console.log("✓ 写入 documents / chunks / vec_chunks");

const vecHits = db
  .prepare(`SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = 2 ORDER BY distance`)
  .all(vecToBlob(fakeVec()));
console.log(`✓ 向量检索返回 ${vecHits.length} 条`);

const ftsHits = db.prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 5`).all(`"能繁母猪"`);
console.log(`✓ FTS5(trigram) 中文检索返回 ${ftsHits.length} 条`);

if (vecHits.length === 2 && ftsHits.length === 1) {
  console.log("\n🎉 三件套验证通过，BMO 的胃没有问题，可以开始投喂了。");
} else {
  console.error("\n✗ 结果数量不符，检查上面的输出");
  process.exit(1);
}
