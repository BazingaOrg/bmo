# BMO 🤖

> *Feed it everything you read.*
> 一台住在菜单栏里的小机器，吞下你日常浏览的一切，消化成你的第二大脑。

---

## ✨ Inspiration

灵感来自 Adventure Time 里那台又萌又靠谱的 BMO——它陪你聊天、帮你记事、永远在线。BMO 这个项目想做的就是把它从动画里搬出来，变成一台真实住在 Mac 菜单栏里的小机器。

它的产品哲学只有一个词：**养成**。市面上的笔记软件都太正经——你得"管理"它们，建文件夹、打标签、写格式。BMO 反着来：你只管随手喂，它负责消化、记住、在你需要时主动想起。喂得越多，它越懂你。数据飞轮是唯一的"养成系统"。

这也是一个学习载体：用一个自己每天真实使用的产品，把 LLM 应用全链路串起来——agent loop、function calling、RAG、MCP、evals、orchestration。

---

## 🍴 Features

**四种喂法**，一个快捷键搞定：

- 📸 **截图** — `⌘⇧M` 唤起，框选屏幕任意区域；走视觉模型转结构化 Markdown
- 📄 **文件** — PDF / Word / 表格 / Markdown 拖入即吃
- 🔗 **链接** — 粘贴 URL 自动抓正文、去广告、转 Markdown
- ✍️ **纯文字** — 一段感想、一句备忘，随手丢进来

**一种聊法**，由 Agent 自己决定要不要翻记忆：

- 闲聊不查、写代码不查、问通用知识不查
- 只在话题真的可能命中你的库时才检索
- 引用必标来源（`【来源：文章标题】`），可点开溯源到原文块
- 库里没有就如实说"还没吃过这方面的内容"，不编造

**Local-first**：所有数据存在本机一个 SQLite 文件里，备份 = 复制文件。云端只负责推理。

---

## 🧠 The Key Design Choice

> 检索不是每轮硬塞，而是 Agent 的一个工具。

传统 RAG 每轮对话都先检索、把结果塞进 prompt，闲聊时也会污染回答。BMO 把知识库包装成 `search_knowledge` 工具交给模型，由模型自主判断"这个问题需不需要查我的库"。三道保险：

1. 工具描述里明确什么时候该调用
2. 检索结果带相似度阈值，低于就告诉模型"没找到"
3. 引用必须标注来源，用户一眼可辨"哪些是它记得的"

这就是"不盲目添加"的底层机制，也比"无脑 RAG"省 token。

---

## 🏗️ Architecture

```
┌─ 采集（Tauri + Vue）────────────┐
│ 快捷键截图 │ 文件 │ 链接 │ 文字  │
└────────────┬───────────────────┘
             ▼  统一解析 → Markdown
┌─ 入库管道（Node sidecar）───────┐
│ 切块 → Embedding → SQLite       │
└────────────┬───────────────────┘
             ▼
┌─ Hybrid 检索 ──────────────────┐
│ FTS5 (BM25) + sqlite-vec (cos) │
│       → RRF 融合 + 阈值        │
└────────────┬───────────────────┘
             ▼ search_knowledge 工具
┌─ Agent Loop ──────┐  ┌─ MCP Server ─────┐
│ Claude + 手写循环 │  │ 暴露给 Claude     │
│ 流式对话 + 引用   │  │ Desktop / Code    │
└───────────────────┘  └──────────────────┘
```

**Monorepo · 一个核心，三个出口**：`packages/core` 与界面无关——CLI（Phase 0）、桌面 App（Phase 1）、MCP server（Phase 3）都是它的薄壳。换出口不重写核心。

**Tauri + Node sidecar**：壳层是 Tauri（Rust + WebView），核心逻辑跑在 Node sidecar 进程里（better-sqlite3、解析器、agent loop 都是 Node 生态），前端通过 HTTP + SSE 通信。这样 MCP server 阶段就是 sidecar 换一个 stdio 入口，零迁移。

---

## 🛠️ Tech Stack

| | |
|---|---|
| **桌面壳** | Tauri v2 + Vue 3 + Vite + Tailwind |
| **核心进程** | TypeScript + Node + Hono（HTTP/SSE） |
| **数据库** | SQLite + better-sqlite3 + sqlite-vec + FTS5(trigram) |
| **LLM** | `@anthropic-ai/sdk`，手写 agent loop（不上 LangChain） |
| **Embedding** | OpenAI 兼容协议（起步 API，可切本地 Ollama bge-m3） |
| **解析** | unpdf / mammoth / SheetJS / readability + turndown |
| **MCP** | `@modelcontextprotocol/sdk` |
| **M 芯片** | Metal（embedding 加速）、ANE（Vision OCR 兜底） |

---

## 🚀 Quick Start

```bash
pnpm install
pnpm verify:db        # 验证 SQLite + sqlite-vec + FTS5 三件套
cp .env.example packages/cli/.env  # 填入 API key
pnpm bmo eat 一篇文章.md
pnpm bmo chat
```

要求：Node >= 20 · pnpm 9 · macOS（Phase 1 起）

---

## 📍 Status

- [x] **Phase 0** — CLI 核心环：入库管道 + hybrid 检索 + agent loop ✅
- [ ] **Phase 1** — Tauri 桌面化：菜单栏常驻 + 快捷键浮窗 + 流式 UI
- [ ] **Phase 2** — 四类 parser + eval harness 调优
- [ ] **Phase 3** — MCP server + 每周消化报告 + 本地化推理

完整设计文档与路线图见 [`plan.md`](./plan.md)。

---

## 📚 Repo

```
packages/
├── core/   # 入库、检索、agent — 与界面无关
│   ├── db/        # SQLite + sqlite-vec + FTS5
│   ├── ingest/    # 切块 + embedding
│   ├── search/    # BM25 + 向量 + RRF
│   └── agent/     # 手写 agent loop + 工具
└── cli/    # bmo eat / bmo chat（Phase 0 出口）
```

---

## ⚠️ Notes

BMO 是 Cartoon Network 的角色商标。本项目自用与开源练手没问题，若将来商业化需要改名（备选：Memo / Nom）并确保吉祥物原创。