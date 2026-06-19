import Anthropic from "@anthropic-ai/sdk";
import { type DB } from "../db/index.js";
import { searchKnowledge } from "../search/hybrid.js";

const MODEL = process.env.BMO_CHAT_MODEL ?? "claude-sonnet-4-6";
const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `你是 BMO，一台可爱的个人知识库小机器人。用户会把日常浏览的内容投喂给你，你负责记住它们。

规则：
1. 仅当用户的问题可能与其投喂过的具体内容相关时，才调用 search_knowledge；闲聊、通用知识、写代码等问题直接回答，不要调用。
2. 引用库内信息时，必须在句末标注来源，格式：【来源：文档标题】。
3. 工具返回"未找到相关内容"时，如实告知用户你的库里还没有这方面的记忆，不要编造。
4. 回答简洁自然，偶尔流露一点 BMO 式的俏皮，但不过度。`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_knowledge",
    description:
      "在用户的个人知识库中检索其投喂过的内容。仅当问题可能与用户读过/存过的具体内容相关时调用；闲聊、通用知识、写代码等问题不要调用。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索查询，使用可能出现在原文中的关键词" },
        top_k: { type: "integer", description: "返回条数，默认 5" },
      },
      required: ["query"],
    },
  },
];

/** 执行工具：把检索结果格式化为带来源元数据的文本，供模型生成引用 */
async function executeTool(db: DB, name: string, input: Record<string, unknown>): Promise<string> {
  if (name !== "search_knowledge") return `未知工具: ${name}`;
  const hits = await searchKnowledge(db, String(input.query ?? ""), Number(input.top_k ?? 5));
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
  onText?: (text: string) => void;
  onToolUse?: (name: string, input: unknown) => void;
}

/**
 * 手写 agent loop（Phase 0 用非流式，逻辑最清晰；流式留给 Phase 1 的 SSE）：
 *   while 未达 MAX_ITERATIONS:
 *     调模型 → 按 stop_reason 分支
 *       end_turn   → 输出文本，结束
 *       tool_use   → 执行工具，把 tool_result 回填进 messages，继续循环
 */
export async function runAgent(
  db: DB,
  messages: Anthropic.MessageParam[],
  events: AgentEvents = {}
): Promise<Anthropic.MessageParam[]> {
  const client = new Anthropic(); // 读取 ANTHROPIC_API_KEY

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text") events.onText?.(block.text);
    }

    if (response.stop_reason !== "tool_use") return messages; // end_turn / max_tokens 等

    // 同一轮可能有多个并行工具调用，逐个执行并一次性回填
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      events.onToolUse?.(block.name, block.input);
      const result = await executeTool(db, block.name, block.input as Record<string, unknown>);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  events.onText?.("（达到最大迭代次数，先停在这里）");
  return messages;
}
