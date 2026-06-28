# BMO Phase 3 · MCP + 养成 + 本地化执行计划

> 把 BMO 的库通过 MCP 暴露给 Claude Desktop / Claude Code;每周自动产出"消化报告";
> 补齐 embedding 迁移工程与离线 Vision OCR 兜底——"一个核心,三个出口"的最后一个出口。
>
> 本文是 step-by-step 施工图。总纲见 [`plan.md`](./plan.md);前序见 [`phase1.md`](./phase1.md)、[`phase2.md`](./phase2.md)。

---

## 0. 目标与验收标准

**交付**:① stdio MCP server(`search_memo` / `add_note`)注册进 Claude Desktop & Claude Code;② 每周消化报告(Orchestrator-Workers);③ embedding 迁移工程(换模型不删库);④ 离线 Vision OCR 兜底(Apple Vision)。

**验收清单**:
1. 在 **Claude Code / Claude Desktop 里直接调 BMO**:问"我库里关于猪周期的内容" → 它通过 MCP 调 `search_memo` 拿到你投喂过的内容并带来源。
2. 在 Claude 里说"帮我记一条:XXX" → 通过 `add_note` 入库,下次能搜到。
3. **每周一**收到一份消化报告(本周吞了多少、聚成哪几类主题、每类摘要、最常被引用来源)。
4. `bmo reembed` 能把全库迁移到新 embedding 模型而**不删数据**(渐进重建 + 版本字段)。
5. **离线模式**:断网时截图走 Apple Vision OCR(而非 Kimi vision)仍能转写入库。

**不做**(范围控制):多端同步、知识图谱、移动端。离线对话模型(本地 Qwen/Gemma)列为可选,不阻塞验收。

---

## 1. 前置准备

| 项 | 说明 |
|---|---|
| **MCP SDK** | `@modelcontextprotocol/sdk`(stdio transport)。装进新包 `packages/mcp`。 |
| **运行依赖** | MCP server 搜索要 embedding → 需 Ollama bge-m3 在跑;写库共用 `~/.bmo/bmo.db`。 |
| **周报模型** | 复用 Kimi(`BMO_CHAT_*`)做聚类摘要;离线时可切本地模型。 |
| **Swift 工具链** | Vision OCR sidecar 用 `swiftc` 编译(macOS 自带);约 50 行 Swift。 |
| **调度** | 周报定时用 macOS `launchd`(plist),不引第三方 cron。 |

---

## 2. 架构:第三个出口

```
        ┌─────────────── @bmo/core(不变)───────────────┐
        │  openDb / eatSource / searchKnowledge / embed   │
        └───┬───────────────┬───────────────┬────────────┘
            ▼               ▼               ▼
   packages/cli      packages/server   packages/mcp ← 新增
   (Phase 0)         (Phase 1/2)        (stdio MCP,Phase 3)
                                              │
                              Claude Desktop / Claude Code 作为 MCP 客户端
```

**关键**:MCP server 又是 core 的一层薄壳——只把 `searchKnowledge` / `eatSource` 包成 MCP 工具,模型由 MCP 客户端(Claude)自带,BMO 不出 chat 模型。周报/迁移/OCR 是 core + CLI 的扩展,不动既有出口。

---

## 3. Milestone A · MCP server(stdio)

> 目标:**在 Claude Code 里直接查/写 BMO 的库**。Phase 3 的头号交付。

### A1. 建 `packages/mcp`
- 依赖 `@modelcontextprotocol/sdk`、`@bmo/core`、`dotenv`。
- `src/env.ts` 绝对路径加载 `packages/cli/.env` + `~/.bmo/.env`(同 server/eval),拿到 EMBEDDING_*。
- `src/index.ts`:用 stdio transport 起一个 `McpServer`,开同一个 `~/.bmo/bmo.db`。

### A2. 暴露工具
| 工具 | 映射 | 说明 |
|---|---|---|
| `search_memo` | `searchKnowledge(db, query, top_k)` | 返回命中文本 + 标题 + 来源 + 相似度;description 里写清"查用户个人知识库" |
| `add_note` | `eatSource(db, {kind:"text", ...})` | 随手记一条入库 |
| `list_recent`(可选) | 查 documents 最近 N 条 | 让模型了解库里有什么 |

- 工具结果格式复用 Phase 0 的来源标注,Claude 那边就能带 `【来源】`。

### A3. 注册进客户端
- 产出一段配置片段(`claude_desktop_config.json` / Claude Code 的 mcp 配置):
  ```json
  { "mcpServers": { "bmo": { "command": "node", "args": ["<abs>/packages/mcp/dist/index.js"] } } }
  ```
- 文档写清:需 Ollama 在跑;打包后可指向单二进制。

### A4. 验证
- 在 Claude Code 里 `/mcp` 看到 bmo;问一个库内问题,确认走 `search_memo` 并带来源。

**Milestone A 完成 = Claude 里能查/写 BMO 库。(验收 #1、#2)**

---

## 4. Milestone B · 每周消化报告(Orchestrator-Workers)

> 目标:把"养成"做实——每周自动告诉你吃了什么、消化出什么。

### B1. 取数与聚类
- 取最近 7 天的 chunks(`created_at`)。
- 用已存向量做**聚类**(k-means 或基于余弦阈值的简单聚类),分成若干主题簇。

### B2. Orchestrator-Workers
- **Workers**:每个簇并发调 Kimi 出一段"这一簇讲了什么"的摘要。
- **Orchestrator**:把各簇摘要 + 统计(本周吞 N 篇/M 块、最常来源、来源类型分布)汇总成一份周报 Markdown。
- 这是 orchestration 的实战练习(对应学习映射)。

### B3. 投递与展示
- 存成文档(可入库,sourceType=text);桌面端"成长" tab 展示;`notification` 提醒。
- `bmo digest`(CLI)手动触发;**launchd plist** 每周一早上自动跑。

**Milestone B 完成 = 每周一收到消化报告。(验收 #3)**

---

## 5. Milestone C · Embedding 迁移工程(渐进重建)

> 目标:换 embedding 模型时**不删库**。注:我们当前已用本地 bge-m3,本里程碑是把"换模型"这条路打通,而非首次本地化。

### C1. 版本字段已就位
- `chunks.embedding_model` 已记录每块用的模型(Phase 0 建表时预留)。

### C2. 重建工具
- `bmo reembed --model <new> [--base-url ...]`:
  1. 若新模型维度不同 → 新建 `vec_chunks_v2(float[新维])`;
  2. 分批拉出 chunks → 用新模型 `embed` → 写新向量 + 更新 `embedding_model`;
  3. 全部迁完 → 切换检索读新表 → 删旧表。
- **渐进**:可中断续跑(按 embedding_model 过滤未迁的),不锁库。

### C3. 验证
- 迁到另一个 embedding 模型后,eval 的 recall@5 不崩;旧数据零丢失。

**Milestone C 完成 = 换 embedding 模型可平滑迁移。(验收 #4)**

---

## 6. Milestone D · 离线 Vision OCR 兜底(Apple Vision)

> 目标:断网/省钱时,截图不走 Kimi vision,改用本机 ANE 上的 Apple Vision OCR。

### D1. Swift sidecar
- ~50 行 Swift:`VNRecognizeTextRequest`(中文好、离线、走 ANE、免费),`swiftc` 编译成 `bmo-ocr <image>` CLI,输出纯文本。

### D2. 接进 image parser
- `parse/image.ts` 加分支:`BMO_VISION_MODE=ocr`(或检测断网)→ 调 `bmo-ocr` 取文字,而非 Kimi vision。
- OCR 出的是纯文字(无图表语义),作为离线兜底可接受;在线默认仍用 vision(质量更高)。

### D3. 验证
- 断网截图投喂,Apple Vision 转写入库成功。

**Milestone D 完成 = 离线截图可转写。(验收 #5)**

---

## 7. (可选)Milestone E · 离线对话模式

> 目标:完全断网也能用——本地小模型兜底对话。

- Ollama 跑 Qwen/Gemma 量化模型;`BMO_CHAT_BASE_URL` 指向本地。
- ⚠️ 本地模型 tool-calling 弱于 Kimi,"不盲目检索"质量会降——仅作断网兜底,默认仍用 Kimi。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| MCP server 启动时 Ollama 没跑 → 搜索失败 | 工具返回清晰错误提示"先启动 Ollama" |
| MCP 子进程拿不到 env | env.ts 绝对路径加载,同 server/eval |
| 周报聚类质量不稳 | 先用简单阈值聚类 + 数量上限,逐步引入 k-means |
| 重建 embedding 期间检索不一致 | 迁移期双表并存,切换原子化;失败可续跑 |
| Apple Vision 中文识别边界 | 仅作离线兜底,在线默认 vision;扫描件/复杂图表标注局限 |
| launchd plist 配置坑 | 提供现成 plist 模板 + `launchctl` 安装说明 |

---

## 9. 完成定义(Definition of Done)

- [ ] Milestone A:`packages/mcp` stdio server,Claude Code/Desktop 能 `search_memo` / `add_note`
- [ ] Milestone B:`bmo digest` + launchd 每周一消化报告(Orchestrator-Workers)
- [ ] Milestone C:`bmo reembed` 渐进迁移 embedding 模型,零数据丢失
- [ ] Milestone D:Apple Vision OCR sidecar,离线截图可转写
- [ ] (可选)Milestone E:本地模型离线对话
- [ ] 跑通第 0 节全部 5 条验收标准

**推荐施工顺序**:A(头号价值,先打通 MCP)→ B(养成主线)→ C/D(工程化与本地化,可并行)→ E 可选。
