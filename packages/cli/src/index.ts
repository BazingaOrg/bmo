#!/usr/bin/env node
import "./env.js"; // 必须第一个 import：在 @bmo/core 读 env 之前用 .env 覆盖 shell 变量
import { Command } from "commander";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  eatSource,
  generateWeeklyDigest,
  isParseError,
  looksLikeUrl,
  openDb,
  reembedKnowledge,
  runAgent,
  updateEnvFile,
  type ChatMessage,
  type ParseSource,
} from "@bmo/core";
import { runDoctor } from "./doctor.js";

const program = new Command();
program.name("bmo").description("BMO — 个人知识吞噬者 CLI").version("0.1.0");

/* ── bmo doctor ────────────────────────────────────────── */
program
  .command("doctor")
  .description("环境自检：投喂前确认 Kimi 对话与本地 embedding 两条链路通不通")
  .action(runDoctor);

/* ── bmo digest ────────────────────────────────────────── */
program
  .command("digest")
  .description("生成本周消化报告")
  .option("--force", "即使 7 天内已有周报也重新生成")
  .action(async (opts: { force?: boolean }) => {
    const db = openDb();
    try {
      const digest = await generateWeeklyDigest(db, { force: opts.force });
      console.log(digest.markdown);
    } finally {
      db.close();
    }
  });

/* ── bmo eat ───────────────────────────────────────────── */
program
  .command("eat")
  .description("投喂内容：文件路径、URL，或配合 --text 直接喂纯文字")
  .argument("[input]", "文件路径、URL 或文字内容")
  .option("-t, --text", "把参数当作纯文字而非文件路径")
  .option("--title <title>", "自定义标题")
  .action(async (input: string | undefined, opts: { text?: boolean; title?: string }) => {
    if (!input) {
      console.error("要喂点什么？用法：bmo eat 文章.md 或 bmo eat -t \"一段文字\"");
      process.exit(1);
    }
    const db = openDb();
    const source: ParseSource = opts.text
      ? { kind: "text", text: input, title: opts.title }
      : looksLikeUrl(input)
        ? { kind: "url", url: input, title: opts.title }
        : { kind: "file", path: input, title: opts.title };

    process.stdout.write("咀嚼中…");
    try {
      const result = await eatSource(db, source);
      console.log(`\r咔嚓——已吞下《${result.title}》，切成 ${result.chunkCount} 块。`);
    } catch (error) {
      console.error(`\r投喂失败：${formatError(error)}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

/* ── bmo reembed ───────────────────────────────────────── */
program
  .command("reembed")
  .description("渐进重建全库 embedding，支持切换模型/维度且不删除文档")
  .requiredOption("--model <model>", "新的 embedding 模型名")
  .option("--base-url <url>", "新的 embedding API base URL")
  .option("--api-key <key>", "新的 embedding API key")
  .option("--dim <dim>", "新的 embedding 维度；不填则先探测")
  .option("--batch-size <size>", "每批处理 chunks 数", "32")
  .action(async (opts: { model: string; baseUrl?: string; apiKey?: string; dim?: string; batchSize?: string }) => {
    const db = openDb();
    try {
      const result = await reembedKnowledge(db, {
        model: opts.model,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        dim: opts.dim ? Number(opts.dim) : undefined,
        batchSize: opts.batchSize ? Number(opts.batchSize) : undefined,
        onProgress: (progress) => {
          process.stdout.write(`\r迁移 embedding：${progress.migrated}/${progress.total} · ${progress.model} · ${progress.dim} 维`);
        },
      });
      console.log(`\n完成：${result.total} 个 chunks 已迁移到 ${result.model} (${result.dim} 维)。`);
      const envPath = reembedEnvPath();
      updateEnvFile(envPath, {
        EMBEDDING_BASE_URL: opts.baseUrl,
        EMBEDDING_API_KEY: opts.apiKey,
        EMBEDDING_MODEL: result.model,
        EMBEDDING_DIM: String(result.dim),
      });
      console.log(`已写入 embedding 配置：${envPath}`);
    } finally {
      db.close();
    }
  });

/* ── bmo chat ──────────────────────────────────────────── */
program
  .command("chat")
  .description("和 BMO 聊天（Agent 自主决定是否检索知识库）")
  .action(async () => {
    const db = openDb();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const messages: ChatMessage[] = [];
    console.log("BMO 上线。输入 exit 退出。\n");

    for (;;) {
      let line: string;
      try {
        line = (await rl.question("你 > ")).trim();
      } catch {
        break; // stdin 关闭(EOF / Ctrl-D / 管道结束):优雅退出,不抛 ERR_USE_AFTER_CLOSE
      }
      if (!line) continue;
      if (line === "exit" || line === "quit") break;

      messages.push({ role: "user", content: line });
      try {
        let totalHits = 0;
        let searched = false;
        await runAgent(db, messages, {
          onToolUse: (_name, input) =>
            console.log(`  ⚙ 翻找记忆：${JSON.stringify((input as { query?: string }).query)}`),
          onSearchResult: (hits) => {
            searched = true;
            totalHits += hits;
          },
          onText: (text) => console.log(`BMO > ${text}\n`),
        });
        // provenance 图例：基于"是否查库、命中几条"这一事实，而非模型自报
        if (!searched) console.log("  💭 来源：BMO 的通用知识(本轮未查库)\n");
        else if (totalHits > 0) console.log(`  📚 来源：你的库(参考 ${totalHits} 条记忆，见上方【来源】)\n`);
        else console.log("  🔍 查了你的库，但没找到相关记忆 → 以上为通用知识\n");
      } catch (e) {
        // 单次调用失败不该崩掉整个会话：丢掉这条未答的输入，保持消息序列干净，继续聊
        messages.pop();
        console.log(`BMO > 唔，刚才出了点岔子：${(e as Error).message}\n`);
      }
    }
    rl.close();
  });

program.parseAsync();

function formatError(error: unknown): string {
  if (isParseError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function reembedEnvPath(): string {
  return process.env.BMO_REEMBED_ENV_PATH ?? resolve(process.cwd(), ".env");
}
