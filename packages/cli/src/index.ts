#!/usr/bin/env node
import "./env.js"; // 必须第一个 import：在 @bmo/core 读 env 之前用 .env 覆盖 shell 变量
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { openDb, eat, runAgent, type ChatMessage } from "@bmo/core";
import { runDoctor } from "./doctor.js";

const program = new Command();
program.name("bmo").description("BMO — 个人知识吞噬者 (Phase 0 CLI)").version("0.1.0");

/* ── bmo doctor ────────────────────────────────────────── */
program
  .command("doctor")
  .description("环境自检：投喂前确认 Kimi 对话与本地 embedding 两条链路通不通")
  .action(runDoctor);

/* ── bmo eat ───────────────────────────────────────────── */
program
  .command("eat")
  .description("投喂内容：md/txt 文件路径，或配合 --text 直接喂纯文字")
  .argument("[input]", "文件路径或文字内容")
  .option("-t, --text", "把参数当作纯文字而非文件路径")
  .option("--title <title>", "自定义标题")
  .action(async (input: string | undefined, opts: { text?: boolean; title?: string }) => {
    if (!input) {
      console.error("要喂点什么？用法：bmo eat 文章.md 或 bmo eat -t \"一段文字\"");
      process.exit(1);
    }
    const db = openDb();
    let markdown: string;
    let title: string;

    if (opts.text) {
      markdown = input;
      title = opts.title ?? input.slice(0, 20) + (input.length > 20 ? "…" : "");
    } else {
      const path = resolve(input);
      const ext = extname(path).toLowerCase();
      if (![".md", ".markdown", ".txt"].includes(ext)) {
        console.error(`Phase 0 只吃 .md/.txt，${ext} 留给 Phase 2 的解析器`);
        process.exit(1);
      }
      markdown = readFileSync(path, "utf-8");
      title = opts.title ?? basename(path, ext);
    }

    process.stdout.write("咀嚼中…");
    const result = await eat(db, { title, markdown, sourceType: "text" });
    console.log(`\r咔嚓——已吞下《${title}》，切成 ${result.chunkCount} 块。`);
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
      const line = (await rl.question("你 > ")).trim();
      if (!line) continue;
      if (line === "exit" || line === "quit") break;

      messages.push({ role: "user", content: line });
      await runAgent(db, messages, {
        onToolUse: (_name, input) =>
          console.log(`  ⚙ 翻找记忆：${JSON.stringify((input as { query?: string }).query)}`),
        onText: (text) => console.log(`BMO > ${text}\n`),
      });
    }
    rl.close();
  });

program.parseAsync();
