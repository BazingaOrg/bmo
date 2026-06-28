import "./env.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eatSource, openDb, searchKnowledge, type ParseSource, type SearchHit } from "@bmo/core";

type EvalCase = {
  query: string;
  expectedDocTitles?: string[];
};

type EvalRow = {
  query: string;
  expectedDocTitles: string[];
  hits: string[];
  rank: number | null;
  reciprocalRank: number;
};

type EvalSummary = {
  total: number;
  positive: number;
  negative: number;
  recallAt5: number;
  mrr: number;
  negativeAccuracy: number | null;
};

type CorpusItem = ParseSource;

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const DEFAULT_DATASET = resolve(PACKAGE_ROOT, "dataset.jsonl");
const DEFAULT_EVAL_DB = resolve(PACKAGE_ROOT, ".tmp/eval.db");
const TOP_K = Number(process.env.BMO_EVAL_TOP_K ?? 5);

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--sweep")) {
    await runSweep();
    return;
  }

  const datasetPath = resolve(process.env.BMO_EVAL_DATASET ?? DEFAULT_DATASET);
  const dataset = readDataset(datasetPath);
  const dbPath = resolve(process.env.BMO_EVAL_DB_PATH ?? DEFAULT_EVAL_DB);
  if (args.has("--rebuild")) await rebuildEvalDb(dbPath);
  const db = openDb(dbPath);
  try {
    const rows: EvalRow[] = [];
    for (const item of dataset) {
      const hits = await searchKnowledge(db, item.query, TOP_K);
      rows.push(scoreCase(item, hits));
    }

    const summary = summarize(rows);
    if (args.has("--json")) {
      console.log(JSON.stringify({ summary, rows }, null, 2));
      return;
    }

    printReport(datasetPath, dbPath, summary, rows);
  } finally {
    db.close();
  }
}

function readDataset(path: string): EvalCase[] {
  if (!existsSync(path)) throw new Error(`找不到 eval dataset：${path}`);
  const rows = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvalCase;
      } catch (error) {
        throw new Error(`dataset 第 ${index + 1} 行不是合法 JSON：${errorMessage(error)}`);
      }
    });

  const invalid = rows.findIndex((row) => !row.query || !Array.isArray(row.expectedDocTitles));
  if (invalid >= 0) throw new Error(`dataset 第 ${invalid + 1} 行需要 { query, expectedDocTitles }`);
  return rows;
}

async function rebuildEvalDb(dbPath: string): Promise<void> {
  const corpusPath = process.env.BMO_EVAL_CORPUS;
  if (!corpusPath) throw new Error("--rebuild 需要设置 BMO_EVAL_CORPUS，指向 corpus.jsonl");
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });

  const corpus = readCorpus(resolve(corpusPath));
  const db = openDb(dbPath);
  try {
    for (const item of corpus) {
      await eatSource(db, normalizeCorpusItem(item, corpusPath));
    }
  } finally {
    db.close();
  }
}

function readCorpus(path: string): CorpusItem[] {
  if (!existsSync(path)) throw new Error(`找不到 eval corpus：${path}`);
  const rows = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line) as CorpusItem;
      } catch (error) {
        throw new Error(`corpus 第 ${index + 1} 行不是合法 JSON：${errorMessage(error)}`);
      }
    });

  const invalid = rows.findIndex((row) => !row || !["file", "url", "text"].includes(row.kind));
  if (invalid >= 0) throw new Error(`corpus 第 ${invalid + 1} 行需要 ParseSource 结构`);
  return rows;
}

function normalizeCorpusItem(item: CorpusItem, corpusPath: string): CorpusItem {
  if (item.kind !== "file" || isAbsolute(item.path)) return item;
  return { ...item, path: resolve(dirname(resolve(corpusPath)), item.path) };
}

function scoreCase(item: EvalCase, hits: SearchHit[]): EvalRow {
  const expected = item.expectedDocTitles ?? [];
  const hitTitles = hits.map((hit) => hit.documentTitle);
  const rankIndex = expected.length === 0 ? -1 : hitTitles.findIndex((title) => expected.includes(title));
  return {
    query: item.query,
    expectedDocTitles: expected,
    hits: hitTitles,
    rank: rankIndex >= 0 ? rankIndex + 1 : null,
    reciprocalRank: rankIndex >= 0 ? 1 / (rankIndex + 1) : 0,
  };
}

function summarize(rows: EvalRow[]): EvalSummary {
  const positives = rows.filter((row) => row.expectedDocTitles.length > 0);
  const negatives = rows.filter((row) => row.expectedDocTitles.length === 0);
  const recalled = positives.filter((row) => row.rank != null).length;
  const negativeCorrect = negatives.filter((row) => row.hits.length === 0).length;

  return {
    total: rows.length,
    positive: positives.length,
    negative: negatives.length,
    recallAt5: positives.length > 0 ? recalled / positives.length : 0,
    mrr: positives.length > 0 ? positives.reduce((sum, row) => sum + row.reciprocalRank, 0) / positives.length : 0,
    negativeAccuracy: negatives.length > 0 ? negativeCorrect / negatives.length : null,
  };
}

function printReport(datasetPath: string, dbPath: string, summary: EvalSummary, rows: EvalRow[]): void {
  console.log(`Dataset: ${datasetPath}`);
  console.log(`DB:      ${dbPath}`);
  console.log(`Cases: ${summary.total} (${summary.positive} positive, ${summary.negative} negative)`);
  if (summary.total < 30) console.log(`Warning: Phase 2 目标是至少 30 条标注，当前只有 ${summary.total} 条。`);
  console.log(`recall@5: ${summary.recallAt5.toFixed(3)}`);
  console.log(`MRR:      ${summary.mrr.toFixed(3)}`);
  if (summary.negativeAccuracy != null) console.log(`neg acc:  ${summary.negativeAccuracy.toFixed(3)}`);
  console.log("");

  for (const row of rows) {
    const status = row.expectedDocTitles.length === 0 ? (row.hits.length === 0 ? "NEG OK" : "NEG MISS") : row.rank ? `HIT @${row.rank}` : "MISS";
    console.log(`[${status}] ${row.query}`);
    console.log(`  expected: ${row.expectedDocTitles.length ? row.expectedDocTitles.join(", ") : "(none)"}`);
    console.log(`  hits:     ${row.hits.length ? row.hits.join(" | ") : "(none)"}`);
  }
}

/**
 * 进程内扫参（不再 spawn 子进程——旧版子进程产出空 JSON 会整轮失败）。
 * 阈值 / recallK 是运行时参数，搜索时从 env 现取；chunk 参数只在入库生效，
 * 故仅当提供 BMO_EVAL_CORPUS 时才逐组合重建独立库。
 */
async function runSweep(): Promise<void> {
  const parseList = (value: string): string[] => value.split(",").map((v) => v.trim()).filter(Boolean);
  const thresholds = parseList(process.env.BMO_EVAL_SWEEP_THRESHOLDS ?? "0.2,0.3,0.4,0.5");
  const recallKs = parseList(process.env.BMO_EVAL_SWEEP_RECALL_K ?? "10,20,40");
  const rebuild = Boolean(process.env.BMO_EVAL_CORPUS);
  const chunkMaxChars = rebuild
    ? parseList(process.env.BMO_EVAL_SWEEP_CHUNK_MAX_CHARS ?? process.env.BMO_CHUNK_MAX_CHARS ?? "1000")
    : [process.env.BMO_CHUNK_MAX_CHARS ?? "-"];
  const chunkOverlaps = rebuild
    ? parseList(process.env.BMO_EVAL_SWEEP_CHUNK_OVERLAP ?? process.env.BMO_CHUNK_OVERLAP ?? "120")
    : [process.env.BMO_CHUNK_OVERLAP ?? "-"];

  const dataset = readDataset(resolve(process.env.BMO_EVAL_DATASET ?? DEFAULT_DATASET));
  const existingDbPath = resolve(process.env.BMO_EVAL_DB_PATH ?? DEFAULT_EVAL_DB);

  console.log("threshold\trecall_k\tchunk_max\toverlap\trecall@5\tMRR\tneg_acc");
  for (const threshold of thresholds) {
    for (const recallK of recallKs) {
      for (const chunkMax of chunkMaxChars) {
        for (const overlap of chunkOverlaps) {
          process.env.BMO_SIMILARITY_THRESHOLD = threshold;
          process.env.BMO_RECALL_K = recallK;

          let dbPath = existingDbPath;
          if (rebuild) {
            process.env.BMO_CHUNK_MAX_CHARS = chunkMax;
            process.env.BMO_CHUNK_OVERLAP = overlap;
            dbPath = resolve(PACKAGE_ROOT, `.tmp/eval-${threshold}-${recallK}-${chunkMax}-${overlap}.db`);
            await rebuildEvalDb(dbPath);
          }

          const db = openDb(dbPath);
          let summary: EvalSummary;
          try {
            const rows: EvalRow[] = [];
            for (const item of dataset) rows.push(scoreCase(item, await searchKnowledge(db, item.query, TOP_K)));
            summary = summarize(rows);
          } finally {
            db.close();
          }

          const negAcc = summary.negativeAccuracy == null ? "-" : summary.negativeAccuracy.toFixed(3);
          console.log(
            `${threshold}\t${recallK}\t${chunkMax}\t${overlap}\t${summary.recallAt5.toFixed(3)}\t${summary.mrr.toFixed(3)}\t${negAcc}`
          );
        }
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
