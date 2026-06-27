#!/usr/bin/env node
import "./env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { eat, openDb, runAgentStream, type ChatMessage, type SearchHit } from "@bmo/core";

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

const db = openDb();
const app = new Hono();
const authToken = process.env.BMO_SERVER_TOKEN ?? randomBytes(32).toString("hex");
const allowedOrigins = getAllowedOrigins();
const parentPid = Number(process.env.BMO_PARENT_PID);

app.use(
  "*",
  cors({
    origin: (origin) => (allowedOrigins.has(origin) ? origin : ""),
    allowMethods: ["GET", "POST", "OPTIONS"],
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

app.post("/eat", async (c) => {
  const input = await readJson<EatRequest>(c.req.raw);
  const rawPath = input.rawPath?.trim();
  let markdown = input.text ?? "";
  let title = input.title?.trim();

  if (rawPath) {
    const ext = extname(rawPath).toLowerCase();
    if (![".md", ".markdown", ".txt"].includes(ext)) {
      return c.json({ error: `Phase 1 只吃 .md/.txt，${ext || "未知格式"} 留给 Phase 2` }, 400);
    }
    markdown = await readFile(rawPath, "utf-8");
    title ||= basename(rawPath, ext);
  }

  if (!markdown.trim()) return c.json({ error: "内容为空，没东西可吃" }, 400);
  title ||= markdown.trim().slice(0, 24) + (markdown.trim().length > 24 ? "..." : "");

  const result = await eat(db, {
    title,
    markdown,
    sourceType: rawPath ? "text" : input.sourceUrl ? "url" : "text",
    sourceUrl: input.sourceUrl,
    rawPath,
  });

  return c.json({ ...result, title });
});

app.post("/chat", async (c) => {
  const input = await readJson<ChatRequest>(c.req.raw);
  const messages = normalizeMessages(input.messages);

  return streamSSE(c, async (stream) => {
    let searched = false;
    let totalHits = 0;
    const provenance = new Map<number, SearchHit>();

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
      });

      await stream.writeSSE({
        event: "provenance",
        data: JSON.stringify({
          searched,
          totalHits,
          hits: [...provenance.values()],
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

async function readJson<T>(request: Request): Promise<T> {
  if (!request.body) return {} as T;
  const text = await request.text();
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
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
