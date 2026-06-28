import { existsSync } from "node:fs";
import OpenAI from "openai";
import { openDb, defaultDbPath, embed, EMBEDDING_MODEL, EMBEDDING_DIM } from "@bmo/core";

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

/**
 * 环境自检：在正式投喂前一键确认 Kimi(对话)与本地 bge-m3(向量)两条链路通不通。
 * 专治这条路线最容易踩的两个坑：embedding 维度对不上、Kimi 端点/model id 填错。
 */
export async function runDoctor(): Promise<void> {
  let fatal = false;
  console.log("BMO 自检\n");

  /* ── 1. Embedding：本地 Ollama bge-m3 ─────────────────────── */
  console.log("【Embedding】本地向量链路");
  const embBase = process.env.EMBEDDING_BASE_URL ?? "https://api.openai.com/v1";
  console.log(`  端点 ${embBase} · 模型 ${EMBEDDING_MODEL} · 期望维度 ${EMBEDDING_DIM}`);
  try {
    const [vec] = await embed(["BMO 自检向量"]);
    if (!vec || vec.length === 0) {
      bad("embedding 返回空向量");
      fatal = true;
    } else if (vec.length !== EMBEDDING_DIM) {
      bad(`维度不匹配：模型实际输出 ${vec.length} 维，但 EMBEDDING_DIM=${EMBEDDING_DIM}`);
      warn(`把 .env 的 EMBEDDING_DIM 改成 ${vec.length}（注意：改维度后若已有旧库需重建）`);
      fatal = true;
    } else {
      ok(`拿到 ${vec.length} 维向量，与 EMBEDDING_DIM 一致`);
    }
  } catch (e) {
    bad(`调用失败：${(e as Error).message}`);
    if (embBase.includes("localhost") || embBase.includes("127.0.0.1")) {
      warn("本地端点不通——确认 Ollama 在跑（ollama serve）且已 ollama pull bge-m3");
    }
    fatal = true;
  }

  /* ── 2. Chat / Agent：Kimi(官方 OpenAI 兼容端点) ───────────── */
  console.log("\n【Chat】Kimi 对话链路");
  const chatBase = process.env.BMO_CHAT_BASE_URL ?? "(未设)";
  const chatModel = process.env.BMO_CHAT_MODEL ?? "";
  console.log(`  端点 ${chatBase} · 模型 ${chatModel || "(未设)"}`);
  if (!process.env.BMO_CHAT_API_KEY) {
    warn("未填 BMO_CHAT_API_KEY，跳过对话自检——填入 Kimi key 后重跑 bmo doctor");
  } else if (!chatModel) {
    warn("未设 BMO_CHAT_MODEL，跳过——填入 Kimi 的 model id 后重跑");
  } else {
    try {
      const client = new OpenAI({
        baseURL: process.env.BMO_CHAT_BASE_URL,
        apiKey: process.env.BMO_CHAT_API_KEY,
      });
      const res = await client.chat.completions.create({
        model: chatModel,
        max_tokens: 16,
        messages: [{ role: "user", content: "只回复两个字：在吗" }],
      });
      const text = res.choices[0]?.message?.content;
      ok(`Kimi 通了，模型 ${res.model} 回复：${text?.trim() || "(无文本)"}`);
    } catch (e) {
      bad(`调用失败：${(e as Error).message}`);
      warn("常见原因：model id 不对 / key 无效 / 端点地址不对。核对 Moonshot 控制台的可用 model id");
      fatal = true;
    }
  }

  /* ── 3. Vision：Kimi 多模态截图转写 ─────────────────────── */
  console.log("\n【Vision】Kimi 图片解析链路");
  const visionBase = process.env.BMO_VISION_BASE_URL ?? process.env.BMO_CHAT_BASE_URL ?? "(未设)";
  const visionModel = process.env.BMO_VISION_MODEL ?? "";
  const visionKey = process.env.BMO_VISION_API_KEY ?? process.env.BMO_CHAT_API_KEY;
  console.log(`  端点 ${visionBase} · 模型 ${visionModel || "(未设)"}`);
  if (!visionKey) {
    warn("未填 BMO_VISION_API_KEY 或 BMO_CHAT_API_KEY，跳过 vision 自检——截图投喂会失败");
  } else if (!visionModel) {
    warn("未设 BMO_VISION_MODEL，跳过 vision 自检——截图投喂会提示缺少模型");
  } else {
    try {
      const client = new OpenAI({
        baseURL: process.env.BMO_VISION_BASE_URL ?? process.env.BMO_CHAT_BASE_URL,
        apiKey: visionKey,
      });
      const res = await client.chat.completions.create({
        model: visionModel,
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "这是一张 1x1 测试图。只回复：vision ok" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG}` },
              },
            ],
          },
        ],
      });
      ok(`Vision 通了，模型 ${res.model} 回复：${res.choices[0]?.message?.content?.trim() || "(无文本)"}`);
    } catch (e) {
      bad(`调用失败：${(e as Error).message}`);
      warn("常见原因：BMO_VISION_MODEL 不支持图片 / key 无效 / 端点地址不对。截图投喂依赖这个链路。");
      fatal = true;
    }
  }

  /* ── 4. 数据库：维度一致性 ────────────────────────────────── */
  console.log("\n【DB】SQLite + 向量表");
  const dbPath = defaultDbPath();
  if (!existsSync(dbPath)) {
    ok(`尚未建库，首次 eat 时会按 EMBEDDING_DIM=${EMBEDDING_DIM} 建表 · ${dbPath}`);
  } else {
    try {
      const db = openDb(dbPath);
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'")
        .get() as { sql?: string } | undefined;
      const m = row?.sql?.match(/float\[(\d+)\]/);
      const builtDim = m ? Number(m[1]) : null;
      if (builtDim === EMBEDDING_DIM) ok(`已有库，向量表维度 ${builtDim}，与当前一致 · ${dbPath}`);
      else {
        bad(`已有库维度 ${builtDim}，但 EMBEDDING_DIM=${EMBEDDING_DIM} —— 换了模型/维度`);
        warn("需重建：删除旧库（rm ~/.bmo/bmo.db*）后重新 eat，或保留旧维度");
        fatal = true;
      }
      db.close();
    } catch (e) {
      bad(`打开数据库失败：${(e as Error).message}`);
      fatal = true;
    }
  }

  console.log("");
  if (fatal) {
    console.log("\x1b[31m自检未通过，先按上面提示修复再投喂。\x1b[0m");
    process.exit(1);
  }
  console.log("\x1b[32m自检通过，BMO 准备好开吃了。\x1b[0m");
}
