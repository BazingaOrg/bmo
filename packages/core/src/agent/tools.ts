import type OpenAI from "openai";
import type { DB } from "../db/index.js";
import { parseToMarkdown } from "../parse/index.js";
import { searchKnowledge, type SearchHit } from "../search/hybrid.js";
import type { AgentEvents } from "./loop.js";

export type AgentToolSchema = OpenAI.Chat.Completions.ChatCompletionTool | BuiltinToolSchema;

export interface BuiltinToolSchema {
  type: "builtin_function";
  function: {
    name: "$web_search";
  };
}

export interface WebSource {
  title: string;
  url: string;
  snippet?: string;
}

export type ToolHandler = (
  context: ToolContext,
  input: Record<string, unknown>,
  rawArguments: string
) => Promise<string>;

export interface ToolContext {
  db: DB;
  events: AgentEvents;
}

export interface RegisteredTool {
  schema: AgentToolSchema;
  handler: ToolHandler;
}

export type ToolRegistry = Map<string, RegisteredTool>;

export function createToolRegistry(): ToolRegistry {
  const registry: ToolRegistry = new Map();
  registerSearchKnowledge(registry);
  registerKimiWebSearch(registry);
  registerFetchUrl(registry);
  return registry;
}

export function toolSchemas(registry: ToolRegistry): AgentToolSchema[] {
  return [...registry.values()].map((tool) => tool.schema);
}

export async function executeRegisteredTool(
  registry: ToolRegistry,
  context: ToolContext,
  name: string,
  input: Record<string, unknown>,
  rawArguments: string
): Promise<string> {
  const tool = registry.get(name);
  if (!tool) return `未知工具: ${name}`;
  return tool.handler(context, input, rawArguments);
}

function registerSearchKnowledge(registry: ToolRegistry): void {
  registry.set("search_knowledge", {
    schema: {
      type: "function",
      function: {
        name: "search_knowledge",
        description:
          "在用户的个人知识库中检索其投喂过的内容。仅当问题可能与用户读过/存过的具体内容相关时调用；闲聊、通用知识、写代码等问题不要调用。若问题同时要求最新信息，应配合 web_search 使用。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "检索查询，使用可能出现在原文中的关键词" },
            top_k: { type: "integer", description: "返回条数，默认 5" },
          },
          required: ["query"],
        },
      },
    },
    handler: async ({ db, events }, input) => {
      const hits = await searchKnowledge(db, String(input.query ?? ""), Number(input.top_k ?? 5));
      await events.onSearchResult?.(hits.length);
      await events.onSearchHits?.(hits);
      if (hits.length === 0) return "未找到相关内容。";
      return formatKnowledgeHits(hits);
    },
  });
}

function registerKimiWebSearch(registry: ToolRegistry): void {
  registry.set("$web_search", {
    schema: {
      type: "builtin_function",
      function: { name: "$web_search" },
    },
    handler: async ({ events }, input, rawArguments) => {
      const sources = extractWebSources(input);
      await events.onWebSearch?.({ query: extractQuery(input), sources });
      // Moonshot $web_search 是"回填型":必须把模型给的 arguments 原样 echo 回去
      // （含 search_id），它据此注入服务端搜索结果。重新 JSON.stringify 会破坏匹配。
      return rawArguments || JSON.stringify(input);
    },
  });
}

function registerFetchUrl(registry: ToolRegistry): void {
  registry.set("fetch_url", {
    schema: {
      type: "function",
      function: {
        name: "fetch_url",
        description:
          "抓取一个网页链接并转成 Markdown。仅当 web_search 找到的结果需要阅读全文、或用户明确给出 URL 并要求结合网页内容时调用。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要抓取的 http/https URL" },
          },
          required: ["url"],
        },
      },
    },
    handler: async ({ events }, input) => {
      const url = String(input.url ?? "").trim();
      const parsed = await parseToMarkdown({ kind: "url", url });
      const source: WebSource = {
        title: parsed.title,
        url: parsed.sourceUrl ?? url,
        snippet: parsed.markdown.slice(0, 240),
      };
      await events.onWebSearch?.({ query: url, sources: [source] });
      return `来源《${parsed.title}》(${source.url})\n\n${parsed.markdown.slice(0, 12_000)}`;
    },
  });
}

function formatKnowledgeHits(hits: SearchHit[]): string {
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] 来源《${h.documentTitle}》(${h.sourceType}${h.sourceUrl ? ` ${h.sourceUrl}` : ""})` +
        `${h.similarity != null ? ` 相似度 ${h.similarity.toFixed(2)}` : ""}\n${h.text}`
    )
    .join("\n\n---\n\n");
}

function extractQuery(input: Record<string, unknown>): string {
  for (const key of ["query", "keyword", "search_query", "q"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function extractWebSources(input: unknown): WebSource[] {
  const out: WebSource[] = [];
  walk(input, out);
  const seen = new Set<string>();
  return out.filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function walk(value: unknown, out: WebSource[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
    return;
  }

  const record = value as Record<string, unknown>;
  const url = firstString(record, ["url", "link", "href"]);
  if (url && /^https?:\/\//.test(url)) {
    out.push({
      title: firstString(record, ["title", "name"]) ?? url,
      url,
      snippet: firstString(record, ["snippet", "summary", "content", "description"]),
    });
  }
  for (const nested of Object.values(record)) walk(nested, out);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
