#!/usr/bin/env node
import "./env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { randomBytes } from "node:crypto";
import {
  ParseError,
  eatSource,
  isParseError,
  openDb,
  generateWeeklyDigest,
  knowledgeStats,
  latestDigest,
  listDigests,
  runAgentStream,
  type ChatMessage,
  type ParseSource,
  type SearchHit,
  type WebSource,
} from "@bmo/core";
import { readRuntimeSettings, updateRuntimeSettings, type SettingsPatch } from "./settings.js";

type EatRequest = {
  text?: string;
  title?: string;
  sourceUrl?: string;
  rawPath?: string;
};

type ChatRequest = {
  messages?: ChatMessage[];
};

type DocumentRow = {
  id: string;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  rawPath: string | null;
  createdAt: number;
  chunkCount: number;
};

type DocumentDetail = DocumentRow & {
  markdown: string;
  chunks: { rowid: number; seq: number; text: string }[];
};

const db = openDb();
void maybeGenerateDigestOnStartup();
const app = new Hono();
const authToken = process.env.BMO_SERVER_TOKEN ?? randomBytes(32).toString("hex");
const allowedOrigins = getAllowedOrigins();
const parentPid = Number(process.env.BMO_PARENT_PID);

app.use(
  "*",
  cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : ""),
    allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
  })
);

app.use("*", async (c, next) => {
  const header = c.req.header("Authorization");
  if (header !== `Bearer ${authToken}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

app.get("/settings", (c) => c.json({ settings: readRuntimeSettings() }));

app.patch("/settings", async (c) => {
  try {
    const input = await readJson<SettingsPatch>(c.req.raw);
    return c.json({ settings: updateRuntimeSettings(input) });
  } catch (error) {
    return c.json({ error: formatError(error) }, 400);
  }
});

app.get("/digests", (c) =>
  c.json({
    latest: latestDigest(db),
    digests: listDigests(db),
    stats: knowledgeStats(db),
  })
);

app.post("/digests/generate", async (c) => {
  try {
    const digest = await generateWeeklyDigest(db, { force: true });
    return c.json({ digest, latest: digest, digests: listDigests(db), stats: knowledgeStats(db) });
  } catch (error) {
    return c.json({ error: formatError(error) }, 500);
  }
});

app.post("/eat", async (c) => {
  try {
    const input = await readJson<EatRequest>(c.req.raw);
    const source = eatRequestToSource(input);
    const result = await eatSource(db, source);
    return c.json({ documentId: result.documentId, chunkCount: result.chunkCount, title: result.title });
  } catch (error) {
    return c.json({ error: formatError(error) }, isParseError(error) ? 400 : 500);
  }
});

app.post("/chat", async (c) => {
  const input = await readJson<ChatRequest>(c.req.raw);
  const messages = normalizeMessages(input.messages);

  return streamSSE(c, async (stream) => {
    let searched = false;
    let totalHits = 0;
    const provenance = new Map<number, SearchHit>();
    let webSearched = false;
    const webSources = new Map<string, WebSource>();

    try {
      await runAgentStream(db, messages, {
        onTextDelta: async (delta) => {
          await stream.writeSSE({ event: "text", data: JSON.stringify({ delta }) });
        },
        onToolUse: async (name, toolInput) => {
          await stream.writeSSE({ event: "tool", data: JSON.stringify({ name, input: toolInput }) });
        },
        onSearchResult: (hits) => {
          searched = true;
          totalHits += hits;
        },
        onSearchHits: (hits) => {
          for (const hit of hits) provenance.set(hit.chunkRowid, hit);
        },
        onWebSearch: (payload) => {
          webSearched = true;
          for (const source of payload.sources) webSources.set(source.url, source);
        },
      });

      await stream.writeSSE({
        event: "provenance",
        data: JSON.stringify({
          searched,
          totalHits,
          hits: [...provenance.values()],
          webSearched,
          webSources: [...webSources.values()],
        }),
      });
      await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true }) });
    } catch (error) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      });
    }
  });
});

app.get("/documents", (c) => {
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.source_type AS sourceType, d.source_url AS sourceUrl,
              d.raw_path AS rawPath, d.created_at AS createdAt, COUNT(c.id) AS chunkCount
       FROM documents d
       LEFT JOIN chunks c ON c.document_id = d.id
       GROUP BY d.id
       ORDER BY d.created_at DESC
       LIMIT 50`
    )
    .all() as DocumentRow[];

  return c.json({ documents: rows });
});

app.get("/documents/:id", (c) => {
  const id = c.req.param("id");
  const row = db
    .prepare(
      `SELECT d.id, d.title, d.source_type AS sourceType, d.source_url AS sourceUrl,
              d.raw_path AS rawPath, d.markdown, d.created_at AS createdAt, COUNT(c.id) AS chunkCount
       FROM documents d
       LEFT JOIN chunks c ON c.document_id = d.id
       WHERE d.id = ?
       GROUP BY d.id`
    )
    .get(id) as DocumentDetail | undefined;

  if (!row) return c.json({ error: "Document not found" }, 404);
  row.chunks = db
    .prepare(`SELECT rowid, seq, text FROM chunks WHERE document_id = ? ORDER BY seq`)
    .all(id) as DocumentDetail["chunks"];
  return c.json({ document: row });
});

const requestedPort = Number(process.env.PORT ?? getArgValue("--port") ?? 0);
const hostname = process.env.HOST ?? "127.0.0.1";
const server = serve({ fetch: app.fetch, hostname, port: requestedPort }, (info) => {
  process.stdout.write(`BMO_SERVER_PORT=${info.port}\n`);
  process.stdout.write(`BMO_SERVER_TOKEN=${authToken}\n`);
});

function shutdown(): void {
  server.close();
  db.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      shutdown();
    }
  }, 5_000).unref();
}

async function maybeGenerateDigestOnStartup(): Promise<void> {
  try {
    const latest = latestDigest(db);
    if (!latest || Date.now() - latest.periodEnd >= 7 * 24 * 60 * 60 * 1000) {
      await generateWeeklyDigest(db);
    }
  } catch {
    /* 周报生成失败不应阻断 sidecar 启动；成长 tab 可手动重试并显示错误。 */
  }
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.body) return {} as T;
  const text = await request.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

function eatRequestToSource(input: EatRequest): ParseSource {
  const title = input.title?.trim() || undefined;
  const rawPath = input.rawPath?.trim();
  const sourceUrl = input.sourceUrl?.trim();
  const text = input.text ?? "";

  if (rawPath) return { kind: "file", path: rawPath, title };
  if (sourceUrl) return { kind: "url", url: sourceUrl, title };
  if (text.trim()) return { kind: "text", text, title };
  throw new ParseError("empty-content", "内容为空，没东西可吃");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeMessages(messages: ChatRequest["messages"]): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((message) => {
    if (!message || typeof message !== "object") return false;
    const role = (message as { role?: unknown }).role;
    return role === "user" || role === "assistant" || role === "tool" || role === "system";
  });
}

function getArgValue(name: string): string | undefined {
  const withEquals = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function getAllowedOrigins(): Set<string> {
  const configured = process.env.BMO_ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()) ?? [];
  return new Set([
    "http://127.0.0.1:1420",
    "http://localhost:1420",
    "tauri://localhost",
    "http://tauri.localhost",
    ...configured.filter(Boolean),
  ]);
}
