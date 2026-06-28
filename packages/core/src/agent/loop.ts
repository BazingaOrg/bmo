import OpenAI from "openai";
import { type DB } from "../db/index.js";
import { type SearchHit } from "../search/hybrid.js";
import {
  createToolRegistry,
  executeRegisteredTool,
  toolSchemas,
  type WebSource,
} from "./tools.js";

const MODEL = process.env.BMO_CHAT_MODEL ?? "kimi-k2.6";
const MAX_ITERATIONS = 8;
// 注意：kimi-k2.6 这个模型只接受 temperature=1（其它值 API 直接报 400），
// Moonshot 已按 temperature=1 调好它的工具调用，照用即可。换别的模型可用 env 覆盖。
const TEMPERATURE = Number(process.env.BMO_CHAT_TEMPERATURE ?? 1);

const SYSTEM_PROMPT = `你是 BMO，一台可爱的个人知识库小机器人。用户会把日常浏览的内容投喂给你，你负责记住它们。

规则：
1. 当问题涉及具体的人物、公司、产品、观点、数据、书籍或任何专有名词时，优先调用 search_knowledge——即使你自认为知道答案，用户更想要的是他亲手存进库里的那一版，而不是你的通用知识。只有纯问候、闲聊、写代码、纯数学计算这类明显与个人收藏无关的问题，才直接回答、不调用。
2. 你确实具备联网搜索能力：工具 $web_search。当且仅当问题需要库外的最新/实时信息（近期新闻、实时价格、当前政策、最近财报、今天/最近发生的事，或用户明确要求联网查）时调用它；调用后你会拿到真实搜索结果，请直接基于结果作答，并给出网页链接。绝不要声称自己"没有联网/搜索能力"——你有。若搜索结果为空或不足，如实说明并可请用户提供链接，但不要编造、也不要否认能力。纯库内问题、闲聊、已知常识、写代码、纯数学计算不要联网；需要读取某网页全文时才调用 fetch_url。
3. 引用库内信息时，必须在句末标注来源，格式：【来源：文档标题】。引用联网信息时必须给出网页链接。
4. 工具返回"未找到相关内容"时，如实告知用户你的库里还没有这方面的记忆，不要编造，也不要硬凑通用知识冒充库内内容。
5. 回答简洁自然，偶尔流露一点 BMO 式的俏皮，但不过度。`;

type MaybePromise<T> = T | Promise<T>;

export interface AgentEvents {
  onText?: (text: string) => MaybePromise<void>;
  onTextDelta?: (delta: string) => MaybePromise<void>;
  onToolUse?: (name: string, input: unknown) => MaybePromise<void>;
  /** 每次查库后回调命中条数：0 = 查了但库里没有；>0 = 查到了。用于生成 provenance 标记 */
  onSearchResult?: (hits: number) => MaybePromise<void>;
  /** 每次查库命中的完整来源，用于 UI 展开来源卡片 */
  onSearchHits?: (hits: SearchHit[]) => MaybePromise<void>;
  /** 联网工具命中的来源，用于 UI 展示网页 provenance */
  onWebSearch?: (payload: { query: string; sources: WebSource[] }) => MaybePromise<void>;
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

/** Moonshot 的 tool_call 实际形状（含非标准 builtin_function，绕开 SDK 联合类型） */
type RawToolCall = { id: string; type: string; function: { name: string; arguments: string } };

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

/** 工具执行失败不该崩掉整个 loop：把错误当成工具结果回填，让模型自行恢复（道歉/换路子）。 */
async function runTool(
  registry: ReturnType<typeof createToolRegistry>,
  context: { db: DB; events: AgentEvents },
  name: string,
  args: Record<string, unknown>,
  raw: string
): Promise<string> {
  try {
    return await executeRegisteredTool(registry, context, name, args, raw);
  } catch (error) {
    return `工具「${name}」执行失败：${error instanceof Error ? error.message : String(error)}`;
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
  const registry = createToolRegistry();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      temperature: TEMPERATURE,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: toolSchemas(registry) as OpenAI.Chat.Completions.ChatCompletionTool[],
      extra_body: { thinking: { type: "disabled" } },
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const msg = res.choices[0]?.message;
    if (!msg) return messages;

    if (msg.content) await events.onText?.(msg.content);

    // 回填 assistant 消息（可能带 tool_calls，此时 content 可能为 null）
    const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: msg.content,
    };
    // Moonshot 的 tool_calls 含非标准的 builtin_function（$web_search），SDK 联合类型对不上，
    // 统一按 {id,type,function} 处理。
    const toolCalls = (msg.tool_calls ?? []) as unknown as RawToolCall[];

    // 把 builtin_function 归一为 function——echo 回去时 Moonshot 才认得。
    if (toolCalls.length) {
      assistant.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
    messages.push(assistant);

    if (toolCalls.length === 0) return messages; // 没有工具调用 = 收尾

    // 同一轮可能有多个工具调用（含 builtin $web_search），逐个执行并各自回填一条 tool 消息
    for (const tc of toolCalls) {
      const raw = tc.function.arguments ?? "";
      const args = parseToolArguments(raw);
      await events.onToolUse?.(tc.function.name, args);
      const result = await runTool(registry, { db, events }, tc.function.name, args, raw);
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
  const registry = createToolRegistry();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      temperature: TEMPERATURE,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      tools: toolSchemas(registry) as OpenAI.Chat.Completions.ChatCompletionTool[],
      stream: true,
      extra_body: { thinking: { type: "disabled" } },
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

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
      // 第 5 个参数传原始 arguments 字符串：$web_search 必须原样 echo 回去
      const result = await runTool(registry, { db, events }, tc.function.name, args, tc.function.arguments);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  const stopText = "（达到最大迭代次数，先停在这里）";
  await events.onTextDelta?.(stopText);
  await events.onText?.(stopText);
  return messages;
}
