import OpenAI from "openai";
import { nanoid } from "nanoid";
import { blobToVec, type DB } from "../db/index.js";

const MODEL = process.env.BMO_DIGEST_MODEL ?? process.env.BMO_CHAT_MODEL ?? "kimi-k2.6";
const MAX_CLUSTERS = Number(process.env.BMO_DIGEST_MAX_CLUSTERS ?? 8);
const CLUSTER_THRESHOLD = Number(process.env.BMO_DIGEST_CLUSTER_THRESHOLD ?? 0.72);
const MAX_CHUNKS = Number(process.env.BMO_DIGEST_MAX_CHUNKS ?? 200);

export type DigestStats = {
  documentCount: number;
  chunkCount: number;
  sourceTypes: Record<string, number>;
  topSources: { title: string; count: number }[];
  clusters: { title: string; chunkCount: number; summary: string; sources: string[] }[];
};

export type DigestRow = {
  id: string;
  periodStart: number;
  periodEnd: number;
  markdown: string;
  stats: DigestStats;
  createdAt: number;
};

type ChunkRow = {
  rowid: number;
  text: string;
  documentTitle: string;
  sourceType: string;
  createdAt: number;
  embedding: Buffer;
};

type Cluster = {
  centroid: Float32Array;
  chunks: ChunkRow[];
};

export async function generateWeeklyDigest(
  db: DB,
  options: { now?: number; days?: number; force?: boolean } = {}
): Promise<DigestRow> {
  const now = options.now ?? Date.now();
  const days = options.days ?? 7;
  const periodEnd = now;
  const periodStart = now - days * 24 * 60 * 60 * 1000;

  if (!options.force) {
    const existing = latestDigest(db);
    if (existing && existing.periodEnd >= periodStart) return existing;
  }

  const chunks = recentChunks(db, periodStart, periodEnd);
  const clusters = clusterChunks(chunks);
  const summaries = await summarizeClusters(clusters);
  const stats = buildStats(chunks, summaries);
  const markdown = renderDigest(periodStart, periodEnd, stats);
  const row: DigestRow = {
    id: nanoid(),
    periodStart,
    periodEnd,
    markdown,
    stats,
    createdAt: now,
  };

  db.prepare(
    `INSERT INTO digests (id, period_start, period_end, markdown, stats_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.periodStart, row.periodEnd, row.markdown, JSON.stringify(row.stats), row.createdAt);

  return row;
}

export function latestDigest(db: DB): DigestRow | null {
  const row = db
    .prepare(
      `SELECT id, period_start AS periodStart, period_end AS periodEnd, markdown, stats_json AS statsJson, created_at AS createdAt
       FROM digests
       ORDER BY period_end DESC
       LIMIT 1`
    )
    .get() as (Omit<DigestRow, "stats"> & { statsJson: string }) | undefined;
  return row ? { ...row, stats: JSON.parse(row.statsJson) as DigestStats } : null;
}

export function listDigests(db: DB, limit = 20): DigestRow[] {
  const rows = db
    .prepare(
      `SELECT id, period_start AS periodStart, period_end AS periodEnd, markdown, stats_json AS statsJson, created_at AS createdAt
       FROM digests
       ORDER BY period_end DESC
       LIMIT ?`
    )
    .all(limit) as (Omit<DigestRow, "stats"> & { statsJson: string })[];
  return rows.map((row) => ({ ...row, stats: JSON.parse(row.statsJson) as DigestStats }));
}

export function knowledgeStats(db: DB): { documentCount: number; chunkCount: number; topSources: { title: string; count: number }[] } {
  const documentCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM documents`).get() as { count: number }).count);
  const chunkCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM chunks`).get() as { count: number }).count);
  const topSources = db
    .prepare(
      `SELECT d.title AS title, COUNT(c.id) AS count
       FROM chunks c JOIN documents d ON d.id = c.document_id
       GROUP BY d.id
       ORDER BY count DESC
       LIMIT 8`
    )
    .all() as { title: string; count: number }[];
  return { documentCount, chunkCount, topSources };
}

function recentChunks(db: DB, start: number, end: number): ChunkRow[] {
  return db
    .prepare(
      `SELECT c.rowid, c.text, c.created_at AS createdAt, d.title AS documentTitle,
              d.source_type AS sourceType, v.embedding AS embedding
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN vec_chunks v ON v.rowid = c.rowid
       WHERE c.created_at >= ? AND c.created_at <= ?
       ORDER BY c.created_at DESC
       LIMIT ?`
    )
    .all(start, end, MAX_CHUNKS) as ChunkRow[];
}

function clusterChunks(chunks: ChunkRow[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const chunk of chunks) {
    const vector = blobToVec(chunk.embedding);
    let best: { cluster: Cluster; score: number } | null = null;
    for (const cluster of clusters) {
      const score = cosine(vector, cluster.centroid);
      if (!best || score > best.score) best = { cluster, score };
    }
    if (best && best.score >= CLUSTER_THRESHOLD) {
      best.cluster.chunks.push(chunk);
      best.cluster.centroid = average(best.cluster.centroid, vector, best.cluster.chunks.length);
    } else if (clusters.length < MAX_CLUSTERS) {
      clusters.push({ centroid: vector, chunks: [chunk] });
    } else if (best) {
      best.cluster.chunks.push(chunk);
      best.cluster.centroid = average(best.cluster.centroid, vector, best.cluster.chunks.length);
    }
  }
  return clusters.sort((a, b) => b.chunks.length - a.chunks.length);
}

async function summarizeClusters(clusters: Cluster[]): Promise<DigestStats["clusters"]> {
  if (!process.env.BMO_CHAT_API_KEY) {
    return clusters.map((cluster, index) => fallbackClusterSummary(cluster, index));
  }

  const client = new OpenAI({
    baseURL: process.env.BMO_CHAT_BASE_URL,
    apiKey: process.env.BMO_CHAT_API_KEY,
  });
  return Promise.all(
    clusters.map(async (cluster, index) => {
      const sources = [...new Set(cluster.chunks.map((chunk) => chunk.documentTitle))].slice(0, 5);
      const sample = cluster.chunks
        .slice(0, 8)
        .map((chunk) => `来源《${chunk.documentTitle}》\n${chunk.text.slice(0, 1200)}`)
        .join("\n\n---\n\n");
      const fallback = fallbackClusterSummary(cluster, index);

      try {
        const res = await client.chat.completions.create({
          model: MODEL,
          max_tokens: 420,
          temperature: 1,
          messages: [
            {
              role: "system",
              content: "你是个人知识库的周报 worker。请为一组相近内容输出一个短标题和 2-3 句摘要，聚焦用户这周吃下的内容。",
            },
            {
              role: "user",
              content: `请总结这一簇内容。格式：第一行标题，第二行开始摘要。\n\n${sample}`,
            },
          ],
        });
        const text = res.choices[0]?.message.content?.trim() || "";
        const [titleLine, ...rest] = text.split(/\r?\n/).filter(Boolean);
        return {
          title: cleanTitle(titleLine) || fallback.title,
          chunkCount: cluster.chunks.length,
          summary: rest.join("\n").trim() || fallback.summary,
          sources,
        };
      } catch {
        return fallback;
      }
    })
  );
}

function fallbackClusterSummary(cluster: Cluster, index: number): DigestStats["clusters"][number] {
  const sources = [...new Set(cluster.chunks.map((chunk) => chunk.documentTitle))].slice(0, 5);
  return {
    title: sources[0] ? `主题 ${index + 1}: ${sources[0]}` : `主题 ${index + 1}`,
    chunkCount: cluster.chunks.length,
    summary: cluster.chunks[0]?.text.slice(0, 240) ?? "本周没有足够内容可总结。",
    sources,
  };
}

function buildStats(chunks: ChunkRow[], clusters: DigestStats["clusters"]): DigestStats {
  const sourceTypes: Record<string, number> = {};
  const sourceCounts = new Map<string, number>();
  for (const chunk of chunks) {
    sourceTypes[chunk.sourceType] = (sourceTypes[chunk.sourceType] ?? 0) + 1;
    sourceCounts.set(chunk.documentTitle, (sourceCounts.get(chunk.documentTitle) ?? 0) + 1);
  }
  return {
    documentCount: new Set(chunks.map((chunk) => chunk.documentTitle)).size,
    chunkCount: chunks.length,
    sourceTypes,
    topSources: [...sourceCounts.entries()]
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    clusters,
  };
}

function renderDigest(start: number, end: number, stats: DigestStats): string {
  const dateRange = `${new Date(start).toLocaleDateString()} - ${new Date(end).toLocaleDateString()}`;
  if (stats.chunkCount === 0) {
    return `# BMO 本周消化报告\n\n${dateRange}\n\n本周还没有新的投喂内容。`;
  }
  return [
    "# BMO 本周消化报告",
    "",
    dateRange,
    "",
    `本周吞下 ${stats.documentCount} 篇文档、${stats.chunkCount} 个知识块。`,
    "",
    "## 主题",
    "",
    ...stats.clusters.flatMap((cluster) => [
      `### ${cluster.title}`,
      "",
      cluster.summary,
      "",
      `来源：${cluster.sources.map((source) => `《${source}》`).join("、") || "无"}`,
      "",
    ]),
    "## 最常出现的来源",
    "",
    ...(stats.topSources.length ? stats.topSources.map((source) => `- 《${source.title}》: ${source.count} 块`) : ["- 无"]),
  ].join("\n");
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function average(previous: Float32Array, next: Float32Array, count: number): Float32Array {
  const out = new Float32Array(previous.length);
  for (let i = 0; i < previous.length; i++) out[i] = previous[i] + (next[i] - previous[i]) / count;
  return out;
}

function cleanTitle(title: string | undefined): string {
  return (title ?? "").replace(/^#+\s*/, "").replace(/^标题[:：]\s*/, "").trim();
}
