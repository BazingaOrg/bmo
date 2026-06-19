# BMO · 项目计划

> Feed it everything you read. 一台住在菜单栏里的小机器，吞下你日常浏览的一切，消化成你的第二大脑。

本文件是 BMO 的设计与路线总纲，记录所有架构决策、技术选型与阶段目标。运行方式见 `README.md`。

---

## 0. 项目目标

**产品目标**：本地优先（local-first）的个人知识库 + 对话助手。快捷键随手投喂（截图 / 文件 / 链接 / 文字），对话时由 Agent 自主判断是否检索库内信息并带引用作答。产品哲学是"养成"——喂得越多，它越懂你，数据飞轮是唯一的"养成系统"。

**学习目标**：通过一个自己每天真实使用的产品，把 LLM 应用全链路串起来——agent loop、function calling、RAG、MCP、evals、orchestration——并产出一个面试可脱稿讲解的项目。

**命名说明**：项目名 BMO（中文「比莫」），向 Adventure Time 致敬。吉祥物为一台青绿色的原创小机器：方脸、点状眼睛、会张嘴吃纸片。⚠️ BMO 是 Cartoon Network 的角色商标，个人练手与开源自用没有实际风险，但若将来公开发布到 App Store 或商业化，需要改名（备选：Memo / Nom）并确保吉祥物形象为原创，不复刻原角色设计。

---

## 1. 范围与克制

**做**：四类输入（截图、文件、链接、纯文字）→ 统一入库 → hybrid 检索 → 带引用的对话 → MCP 对外暴露 → 每周消化报告。

**不做**（至少 v1 不做）：

- 多端同步、移动端、Web 版
- 知识图谱可视化
- 自动爬取 / 浏览器历史监听（必须用户主动投喂——这是产品边界，也是隐私边界）
- 笔记编辑器（BMO 是吞噬者，不是 Obsidian）
- 账号体系（单机单用户）

---

## 2. 核心设计决策

### 决策一：检索是 Agent 的工具，不是每轮硬塞的 RAG

把知识库包装成 `search_knowledge` 工具交给模型，由模型自主判断"这个问题需不需要查库"。闲聊不查、通用知识不查、讨论具体话题才查——这就是"不盲目添加"的实现机制。三道保险：

1. 工具 description 中明确调用条件（仅当问题可能与用户收藏内容相关）；
2. 检索结果带相似度分数，低于阈值时工具返回"未找到相关内容"，模型据此不引用；
3. 回答中引用库内信息必须标注来源（`【来源：文档标题】`），用户一眼可辨"哪些是它记得的"。

### 决策二：一切内容入库前归一化为 Markdown + 元数据

PDF、网页、截图、表格、纯文字，管道第一站都是"解析为带元数据的 Markdown"。切块、embedding、检索、引用展示只面对一种格式；新增输入类型 = 新增一个 parser，核心管道不动。

### 决策三：SQLite 而非 Postgres

本地单用户场景下 Postgres 是运维负担（装、起进程、迁移）。SQLite 是嵌入式单文件库：零配置、随应用走、备份即复制文件，完全符合 local-first。向量检索用 sqlite-vec 扩展，全文检索用内置 FTS5，两路融合做 hybrid search。

---

## 3. 总体架构

```
┌─ 采集层（Tauri / Vue）────────────┐
│ 快捷键截图 │ 文件拖入 │ 链接 │ 文字 │
└──────────────┬───────────────────┘
               ▼
┌─ 入库管道（Node sidecar）─────────┐
│ 统一解析 → Markdown + 元数据       │
│ → 切块 Chunking → Embedding       │
└──────────────┬───────────────────┘
               ▼
┌─ 存储 ───────────────────────────┐
│ SQLite 单文件（FTS5 + sqlite-vec）│
└──────┬───────────────────┬──────┘
       ▼ 工具调用           ▼
┌─ Agent Loop ─────┐  ┌─ MCP Server ─────────┐
│ Claude API + 工具 │  │ Claude Desktop/Code  │
│ ↕ 聊天界面（SSE） │  │ 直接查询同一个库      │
└──────────────────┘  └──────────────────────┘
```

**进程模型 · Tauri + Node sidecar**：Tauri 原生后端是 Rust，但 BMO 的核心逻辑（better-sqlite3、各解析器、agent loop）全在 Node 生态，没法跑在 Rust 里也不该跑在 webview 里。所以 Tauri（壳 + 前端 WebView）启动时拉起一个 **Node sidecar** 进程（Hono 监听 localhost 随机端口），核心逻辑都在 sidecar 中，前端通过 HTTP + SSE 通信。

这套架构的好处：①不写 Rust；②流式输出走 SSE 非常自然；③Phase 3 的 MCP server 就是同一个 core 包换一个 stdio 入口，零迁移。代价是要管理 sidecar 的生命周期（启动、健康检查、退出清理），这本身就是很好的工程练习。

仓库组织为 pnpm monorepo，`packages/core` 与界面无关，CLI（Phase 0）/ 桌面 App（Phase 1）/ MCP server（Phase 3）都是 core 的薄壳。这样后续三个阶段不是推倒重来，而是给同一个核心换出口。

---

## 4. 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 语言 / 工程 | TypeScript + pnpm monorepo + Vitest | packages: `core` / `cli` / `desktop` / `mcp` |
| 桌面壳 | Tauri v2 | 插件：global-shortcut、clipboard-manager、shell、tray、notification、autostart |
| 前端 | Vue 3 + Vite + Pinia + Tailwind CSS | 主场技术，重点投入交互打磨 |
| 逻辑进程 | Node sidecar + Hono（HTTP + SSE） | better-sqlite3 等原生模块的宿主 |
| 数据库 | SQLite + better-sqlite3 + sqlite-vec + FTS5 | Drizzle ORM 管 schema 与迁移（Phase 1 引入） |
| LLM 客户端 | `@anthropic-ai/sdk`，手写 agent loop | 不上 LangChain；Phase 1 加流式 |
| Embedding 客户端 | OpenAI 兼容协议；起步 API，Phase 3 可切本地 | 见第 5 节 |
| 解析 | unpdf（PDF）/ mammoth（Word）/ SheetJS（表格）/ @mozilla/readability + linkedom + turndown（URL） | Phase 2 接入，全部输出 Markdown |
| 截图理解 | Claude 视觉能力（主力）；macOS Vision OCR（离线兜底） | Phase 2 / Phase 3 |
| MCP | `@modelcontextprotocol/sdk`（stdio） | Phase 3 |
| 打包 | Tauri bundler；sidecar 可用 `bun build --compile` 打成单二进制 | 自用阶段跳过签名公证 |

---

## 5. 模型选型

整个项目其实只有**一个模型是第一天就必须有的：embedding 模型**，其余都是同一个 Claude API 或可选项。

| 角色 | 选型 | 阶段 |
|---|---|---|
| 对话 / Agent 主力 | Claude API（Sonnet 级） | Phase 0 起 |
| 截图 → Markdown | 同一个 Claude API 的视觉能力，不需要单独模型 | Phase 2 |
| **Embedding（必需）** | 起步：API（OpenAI text-embedding-3-small 1536 维 或 Qwen `text-embedding-v3` 1024 维，中文更友好）；Phase 3 切本地 Ollama bge-m3 | Phase 0 起 |
| Rerank（可选） | bge-reranker-v2-m3 本地，或 Jina / Cohere rerank API | Phase 2 |
| 离线摘要小模型（可选） | Qwen 8B 或 Gemma 4 12B 级别，Ollama Q4 量化 | 可选 |
| OCR 兜底 | Apple Vision framework（不是 LLM，走 ANE） | Phase 3 |

**两个要点**：

1. Agent loop 的工具调用质量直接决定"不盲目引用"能不能成立，所以对话主力别省，用 Claude。
2. embedding 模型一旦选定，向量维度就和它绑死了（schema 里 `embedding_model` 版本字段就是为渐进式重建预留）。换模型不是简单替换 API key，而是**全库重新计算向量**。

**关于 DiffusionGemma**：不适合进 BMO 主链路。它解决的是生成速度问题（块状并行去噪），但 BMO 的瓶颈是检索质量与回答可靠性，不是生成速度；Google 自己也说它"为了速度牺牲质量，在所有公开基准上落后于标准 Gemma 4"，而我们恰恰需要可靠的工具调用与忠实引用。它的甜点场景是行内编辑、代码补全这类对延迟极度敏感的工作流，那是另一类产品。如果将来想做"全离线模式"，应该选标准自回归的 Gemma 4 12B 这类模型。

---

## 6. M 芯片利用策略

**原则**：本地负责高频、低难度、隐私敏感的任务；云端负责高难度推理。Local-first 的核心承诺是数据（SQLite 文件）永远在本机，推理位置是可切换的实现细节，不为"全本地"牺牲回答质量。

| 能力 | 用法 | 阶段 |
|---|---|---|
| Metal GPU | Ollama / llama.cpp 自动走 Metal 加速；本地 bge-m3 做 embedding 毫秒级 | Phase 3 |
| ANE 神经引擎 | macOS Vision framework（VNRecognizeTextRequest）做 OCR：中文好、离线、免费；约 50 行 Swift 编译成 CLI sidecar 调用 | Phase 3 |
| 统一内存 | 24GB / 16GB 都可同时跑 embedding 模型与 App；进阶可玩苹果官方 MLX 框架 | 可选 |
| 本地小模型 | Ollama 跑 Qwen 8B / Gemma 4 12B 级模型做离线摘要，仅作"断网模式"兜底 | 可选 |

针对 24GB M4 的实际预算：bge-m3 做 embedding 占 1–2GB；将来加 8B–12B Q4 量化模型占 5–8GB，加上系统、浏览器、App 本身，日常完全余裕。

---

## 7. 数据模型

```sql
CREATE TABLE documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  source_type TEXT NOT NULL,        -- text | url | pdf | docx | xlsx | image
  source_url  TEXT,
  raw_path    TEXT,                 -- 原始文件副本路径（应用数据目录）
  markdown    TEXT NOT NULL,        -- 归一化后的全文
  created_at  INTEGER NOT NULL
);

CREATE TABLE chunks (
  id              TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents(id),
  seq             INTEGER NOT NULL,
  text            TEXT NOT NULL,
  embedding_model TEXT NOT NULL,    -- 版本字段：换模型时支持渐进式重建
  created_at      INTEGER NOT NULL
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, content='chunks', content_rowid='rowid',
  tokenize='trigram'                -- 中文场景关键，见下方说明
);

CREATE VIRTUAL TABLE vec_chunks USING vec0(
  embedding float[1536] distance_metric=cosine  -- 维度在建表时固定
);
```

**Phase 0 实操中发现的三个坑**（已在代码中处理，写在这里避免后续重蹈）：

1. **vec0 的 rowid 必须用 `BigInt` 绑定**。better-sqlite3 把 JS number 一律按 double 绑定，而 sqlite-vec 严格校验 SQLITE_INTEGER，传 number 直接报 `Only integers are allowed`。所有 `insertVec.run(...)` 必须 `BigInt(info.lastInsertRowid)`。

2. **FTS5 默认分词器对中文无效**。`unicode61`（默认值）不切分中文，全文检索会形同虚设。必须用 `tokenize='trigram'`（三字滑窗），中英混合都能搜。代价：查询词需 ≥3 字符；代码里对短查询和非法 FTS 语法做了静默降级，仅依赖向量召回。

3. **embedding 维度在建表时固定**。换 embedding 模型必须同步改 `EMBEDDING_DIM` 并重建向量。`embedding_model` 版本字段就是为此而设——可识别旧向量、支持后台渐进式重算，而不是删库重来。

**切块策略**（起步值，Phase 2 用 eval 调参）：递归切块，按 `\n## / \n### / \n\n / \n / 。 / .` 优先级降级；目标 1000 字符 / 块（中文约 500–600 token）；约 120 字符重叠；不足 100 字符的孤立标题向后合并避免噪音块。

---

## 8. 检索与 Agent 设计

### Hybrid 检索流程

1. FTS5（BM25）与 sqlite-vec（余弦相似度）各召回 top-20；
2. 用 RRF（倒数排名融合，`score = Σ 1/(60 + rank)`）合并取 top-k；
3. **阈值过滤**：纯向量命中且相似度低于阈值（默认 0.3）的丢弃；全军覆没则返回空——这是"不盲目引用"在工程层面的实现，让 Agent 如实告诉用户"库里没有相关内容"。

中文专有名词靠 BM25 兜底（trigram 对短词友好），语义改写靠向量兜底，两者互补。Phase 2 可选 LLM rerank 进一步提质。

### 工具定义

```json
{
  "name": "search_knowledge",
  "description": "在用户的个人知识库中检索其投喂过的内容。仅当问题可能与用户读过/存过的具体内容相关时调用；闲聊、通用知识、写代码等问题不要调用。",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "top_k": { "type": "integer", "default": 5 }
    },
    "required": ["query"]
  }
}
```

工具结果中附带文档标题、来源类型、URL、相似度——这些元数据是模型生成`【来源：...】`引用的依据。

### Agent loop 要点

呼应已学知识：

- `MAX_ITERATIONS` 上限（8），防止失控；
- 按 `stop_reason` 分支：`end_turn` / `max_tokens` 结束，`tool_use` 执行工具并把 `tool_result` 回填进 `messages` 后继续循环；
- 同一轮可能有多个并行工具调用，需要一次性收集所有 `tool_use` 块再统一回填；
- Phase 0 用非流式（逻辑最清晰），Phase 1 改流式接 SSE，把 text delta 实时推给前端。

---

## 9. UI / UX 设计规范

**定位**：Raycast 的骨架，BMO 的灵魂——"玩具感的效率工具"，可爱但克制。

### 双形态

1. **快速捕获浮窗**（核心入口）：菜单栏常驻，无 Dock 图标干扰；全局快捷键 `⌘⇧M` 唤起 Spotlight 式悬浮窗；支持拖入文件、粘贴链接/文字、一键截图；Esc 关闭；投喂完成即收起，全程 ≤ 3 秒。
2. **主窗口**：三个 tab——「对话」（流式聊天 + 引用卡片）、「食谱」（已吞内容的库视图，按来源类型筛选）、「成长」（统计面板：吞了多少篇、多少块、最常被引用的来源、每周消化报告）。

### Design Tokens

| Token | 值 | 用途 |
|---|---|---|
| 主色 | `#63C5B5` | BMO 青，按钮 / 高亮 / 吉祥物 |
| 深色底 | `#0F5C55` | 深色模式背景（BMO 屏幕深青） |
| 浅色底 | `#FDF6E3` | 奶油白，浅色模式背景 |
| 点缀红 | `#E4504B` | 删除 / 警示 / 吉祥物按钮 |
| 点缀黄 | `#F5C84C` | 高亮 / 引用标记 |
| 圆角 | 12–16px | 大圆角，玩具感 |
| 字体 | 苹方 / 思源黑体；数字与代码用 JetBrains Mono | |
| 间距 | 4pt 网格 | |

**克制项**：Phase 1 只实现浮窗 + 对话两个界面；但 design tokens（颜色 / 圆角 / 间距 / 字体）第一天就定下来写进 Tailwind 配置，后续不返工。深浅色跟随系统。

### 微交互即养成

- 投喂时小机器人播放像素风咀嚼动画
- 完成 toast：「咔嚓——已吞下 1 篇，切成 9 块」
- 检索中眼睛转圈
- 引用卡片可点开溯源到原文块
- 空状态文案带性格：「我还很饿，喂我点东西吧」

养成感不需要等级和宠物系统：即时反馈 + 统计面板 + 每周消化报告就足够立住"越用越顺手"的感觉。

---

## 10. 路线图

### Phase 0 · CLI 核心环（第 1–2 周）✅ 骨架已就绪

| | |
|---|---|
| 交付 | `bmo eat <文件/文字>` 入库；`bmo chat` 进入带工具的对话 |
| 技术点 | monorepo 搭建；SQLite + sqlite-vec + FTS5 三件套验证；递归切块；embedding 入库；FTS5 + sqlite-vec + RRF 融合；手写 agent loop + `search_knowledge`（带阈值） |
| **验收清单** | ① 喂 10 篇真实文章；② 问相关问题：能命中并以`【来源：标题】`格式引用；③ 问无关问题（如"今天天气怎么样"）：模型不调用工具、不乱引；④ 问库里没有的话题：BMO 如实说"还没吃过这方面的内容" |
| 学习映射 | function calling、tool schema 设计、chunking 策略、检索融合 |

### Phase 1 · 桌面化（第 3–5 周）

| | |
|---|---|
| 交付 | Tauri 应用：菜单栏常驻 + `⌘⇧M` 浮窗 + 流式对话界面 |
| 技术点 | sidecar 生命周期管理（启动 / 健康检查 / 退出清理）；global-shortcut；clipboard；shell 调 `screencapture -i` 实现框选截图；SSE 流式渲染；引用卡片；tray 常驻 |
| 验收 | 任意应用中，从按下快捷键到完成一次投喂 ≤ 3 秒 |
| 学习映射 | 进程间通信、流式 UI、桌面应用工程化 |

### Phase 2 · 解析与检索质量（第 6–8 周）

| | |
|---|---|
| 交付 | PDF / Word / 表格 / URL 四类 parser；截图走 Claude 视觉转 Markdown；引用溯源 UI；eval harness |
| 技术点 | 各 parser 接入与异常处理（超时、加密 PDF、反爬页面）；可调相似度阈值；可选 LLM rerank；30 条「query → 期望文档」标注集，跑 recall@5 / MRR，调 chunk 参数看指标曲线变化 |
| 验收 | recall@5 ≥ 0.8（自标集）；四类输入全部可入库 |
| 学习映射 | RAG 调优方法论、evals 落地 |

### Phase 3 · MCP + 养成 + 本地化（第 9–11 周）

| | |
|---|---|
| 交付 | MCP server（`search_memo` / `add_note`）注册进 Claude Desktop & Claude Code；每周消化报告；本地 embedding 切换；Vision OCR 兜底 |
| 技术点 | stdio MCP；周报 agent = 按 embedding 聚类 → 分组摘要 → 汇总（Orchestrator-Workers 实战）；Ollama bge-m3 + 向量渐进重建；Swift Vision sidecar |
| 验收 | 在 Claude Code 里能直接查 BMO 的库；每周一收到消化报告；离线模式可用 |
| 学习映射 | MCP、orchestration、本地推理、embedding 迁移工程 |

---

## 11. 风险与备选

| 风险 | 应对 |
|---|---|
| sidecar 打包分发复杂（依赖 Node 运行时） | 自用阶段直接要求本机有 Node；后期 `bun build --compile` 打单二进制 |
| sqlite-vec 在 better-sqlite3 中的扩展加载 | Phase 0 已通过 `pnpm verify:db` 验证；vec0 rowid `BigInt` 绑定坑已记录 |
| Tauri + sidecar 心智负担过重 | 备选：Electron（全 JS、一个进程，包体大）；core 包与壳无关，迁移成本低 |
| 换 embedding 模型需重建全量向量 | `embedding_model` 版本字段 + 后台渐进重算 |
| 截图走视觉模型的成本 | 高频用户切 Vision OCR 本地兜底；或仅对含图表的截图走视觉模型 |
| FTS5 中文短查询命中率低 | trigram 已是最佳实践；进一步可引入 jieba 预分词作为可选方案 |

---

## 12. 下一步

当前位置：Phase 0 骨架已就绪并通过三件套验证。下一步按 Phase 0 验收清单（第 10 节）执行：

1. 配置 `.env`：填入 `ANTHROPIC_API_KEY` 与 `EMBEDDING_API_KEY`；
2. 喂 10 篇真实文章（自己最近读的最有代表性，比如 agent 工程文章、猪周期分析、几篇 Bilibili 简介等）；
3. 跑四类对话测试（相关引用 / 无关不引 / 库内未覆盖 / 闲聊），记录是否符合预期；
4. 通过则进入 Phase 1（Tauri 桌面化），不通过则记录失败 case，回头调 prompt / 阈值 / chunk 参数。

具体运行命令见 `README.md`。