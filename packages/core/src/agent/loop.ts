import OpenAI from "openai";
import { type DB } from "../db/index.js";
import { searchKnowledge, type SearchHit } from "../search/hybrid.js";

const MODEL = process.env.BMO_CHAT_MODEL ?? "kimi-k2.6";
const MAX_ITERATIONS = 8;
// 注意：kimi-k2.6 这个模型只接受 temperature=1（其它值 API 直接报 400），
// Moonshot 已按 temperature=1 调好它的工具调用，照用即可。换别的模型可用 env 覆盖。
const TEMPERATURE = Number(process.env.BMO_CHAT_TEMPERATURE ?? 1);

const SYSTEM_PROMPT = `你是 BMO，一台可爱的个人知识库小机器人。用户会把日常浏览的内容投喂给你，你负责记住它们。

规则：
1. 当问题涉及具体的人物、公司、产品、观点、数据、书籍或任何专有名词时，优先调用 search_knowledge——即使你自认为知道答案，用户更想要的是他亲手存进库里的那一版，而不是你的通用知识。只有纯问候、闲聊、写代码、纯数学计算这类明显与个人收藏无关的问题，才直接回答、不调用。
2. 引用库内信息时，必须在句末标注来源，格式：【来源：文档标题】。
3. 工具返回"未找到相关内容"时，如实告知用户你的库里还没有这方面的记忆，不要编造，也不要硬凑通用知识冒充库内内容。
4. 回答简洁自然，偶尔流露一点 BMO 式的俏皮，但不过度。`;

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "在用户的个人知识库中检索其投喂过的内容。仅当问题可能与用户读过/存过的具体内容相关时调用；闲聊、通用知识、写代码等问题不要调用。",
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
];

type MaybePromise<T> = T | Promise<T>;

/** 执行工具：把检索结果格式化为带来源元数据的文本，供模型生成引用 */
async function executeTool(
  db: DB,
  name: string,
  input: Record<string, unknown>,
  events: AgentEvents
): Promise<string> {
  if (name !== "search_knowledge") return `未知工具: ${name}`;
  const hits = await searchKnowledge(db, String(input.query ?? ""), Number(input.top_k ?? 5));
  // provenance 的事实来源：客观告诉调用方这次查库命中了几条（不依赖模型自报）
  await events.onSearchResult?.(hits.length);
  await events.onSearchHits?.(hits);
  if (hits.length === 0) return "未找到相关内容。";
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] 来源《${h.documentTitle}》(${h.sourceType}${h.sourceUrl ? ` ${h.sourceUrl}` : ""})` +
        `${h.similarity != null ? ` 相似度 ${h.similarity.toFixed(2)}` : ""}\n${h.text}`
    )
    .join("\n\n---\n\n");
}

export interface AgentEvents {
  onText?: (text: string) => MaybePromise<void>;
  onTextDelta?: (delta: string) => MaybePromise<void>;
  onToolUse?: (name: string, input: unknown) => MaybePromise<void>;
  /** 每次查库后回调命中条数：0 = 查了但库里没有；>0 = 查到了。用于生成 provenance 标记 */
  onSearchResult?: (hits: number) => MaybePromise<void>;
  /** 每次查库命中的完整来源，用于 UI 展开来源卡片 */
  onSearchHits?: (hits: SearchHit[]) => MaybePromise<void>;
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type ToolCallAccumulator = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

function appendToolCallDelta(
  toolCalls: ToolCallAccumulator[],
  delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall
): void {
  const index = delta.index;
  const existing =
    toolCalls[index] ??
    ({
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    } satisfies ToolCallAccumulator);

  if (delta.id) existing.id = delta.id;
  if (delta.type === "function") existing.type = "function";
  if (delta.function?.name) existing.function.name += delta.function.name;
  if (delta.function?.arguments) existing.function.arguments += delta.function.arguments;

  toolCalls[index] = existing;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * 手写 agent loop（Phase 0 非流式，逻辑最清晰；流式留给 Phase 1 的 SSE）。
 * 走 Kimi 官方 OpenAI 兼容端点（BMO_CHAT_BASE_URL=https://api.moonshot.cn/v1）：
 *   while 未达 MAX_ITERATIONS:
 *     调模型 → 看 message.tool_calls
 *       无 tool_calls → 输出文本，结束
 *       有 tool_calls → 逐个执行，把每个 {role:"tool", tool_call_id} 回填进 messages，继续循环
 *
 * system prompt 不写进 messages（避免跨轮重复累积），每次请求时临时前置。
 */
export async function runAgent(
  db: DB,
  messages: ChatMessage[],
  events: AgentEvents = {}
): Promise<ChatMessage[]> {
  const client = new OpenAI({
    baseURL: process.env.BMO_CHAT_BASE_URL,
    apiKey: process.env.BMO_CHAT_API_KEY,
  });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      temperature: TEMPERATURE,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: TOOLS,
    });

    const msg = res.choices[0]?.message;
    if (!msg) return messages;

    if (msg.content) await events.onText?.(msg.content);

    // 回填 assistant 消息（可能带 tool_calls，此时 content 可能为 null）
    const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: msg.content,
    };
    if (msg.tool_calls?.length) assistant.tool_calls = msg.tool_calls;
    messages.push(assistant);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) return messages; // 没有工具调用 = 收尾

    // 同一轮可能有多个工具调用，逐个执行并各自回填一条 tool 消息
    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* 参数 JSON 损坏时按空参数处理 */
      }
      await events.onToolUse?.(tc.function.name, args);
      const result = await executeTool(db, tc.function.name, args, events);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  await events.onText?.("（达到最大迭代次数，先停在这里）");
  return messages;
}

/**
 * Phase 1 流式 agent loop。
 *
 * Kimi/OpenAI 兼容流式工具调用会把 tool_calls 拆在多个 chunk 中返回，
 * 因此必须按 index 累积 id/name/arguments，收齐本轮 assistant 消息后再执行工具。
 */
export async function runAgentStream(
  db: DB,
  messages: ChatMessage[],
  events: AgentEvents = {}
): Promise<ChatMessage[]> {
  const client = new OpenAI({
    baseURL: process.env.BMO_CHAT_BASE_URL,
    apiKey: process.env.BMO_CHAT_API_KEY,
  });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      temperature: TEMPERATURE,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: TOOLS,
      stream: true,
    });

    let content = "";
    const toolCalls: ToolCallAccumulator[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        await events.onTextDelta?.(delta.content);
      }

      for (const toolCallDelta of delta.tool_calls ?? []) {
        appendToolCallDelta(toolCalls, toolCallDelta);
      }
    }

    const validToolCalls = toolCalls.filter((tc) => tc.id && tc.function.name);
    const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: content || null,
    };
    if (validToolCalls.length > 0) assistant.tool_calls = validToolCalls;

    messages.push(assistant);
    if (validToolCalls.length === 0) {
      if (content) await events.onText?.(content);
      return messages;
    }

    for (const tc of validToolCalls) {
      const args = parseToolArguments(tc.function.arguments);
      await events.onToolUse?.(tc.function.name, args);
      const result = await executeTool(db, tc.function.name, args, events);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  const stopText = "（达到最大迭代次数，先停在这里）";
  await events.onTextDelta?.(stopText);
  await events.onText?.(stopText);
  return messages;
}
