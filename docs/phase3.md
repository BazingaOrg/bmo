# BMO Phase 3 · 联网 + 养成 + 工程化执行计划

> 让 BMO 在对话时能联网("我存过的 + 最新的"一起答)、每周自动产出消化报告(成长 tab)、
> 并补齐换 embedding 模型的迁移工程。
>
> 本文是 step-by-step 施工图。总纲见 [`plan.md`](./plan.md);前序见 [`phase1.md`](./phase1.md)、[`phase2.md`](./phase2.md)。

> **本阶段范围调整(基于讨论确定)**:
> - ❌ 砍掉离线对话(本地模型 tool-use 明显降档,无离线需求)与离线 Vision OCR(Kimi vision 已够用)。
> - 🔁 MCP 从"BMO 当 server 暴露给 Claude"改为"**BMO 当 client,对话时自己调工具**"——这才是"做进 BMO"、对日常有用。
> - 📊 每周消化报告投递走**桌面"成长" tab**(不做邮件/SMTP)。

---

## 0. 目标与验收标准

**交付**:① 对话时 BMO 能联网检索 + 抓取(`web_search` / `fetch_url`),与库内检索并用;② agent 工具层"来源无关",为后续插 MCP 工具预留;③ 每周消化报告在"成长" tab 展示;④ `bmo reembed` 换 embedding 模型不删库。

**验收清单**:
1. 问一个需要最新信息的问题(如"美光最近的财报数据,结合我库里的分析") → BMO **既调 `search_knowledge`(库) 又调 `web_search`/`fetch_url`(联网)**,回答里库内来源用`【来源：标题】`、联网来源给链接。
2. 闲聊/纯库内问题时,**不乱联网**(和"不盲目检索"同一套克制逻辑)。
3. 工具派发"来源无关":新增一个工具(native 或将来 MCP)不用改派发主干。
4. 进"成长" tab 能看到**本周消化报告**(吞了多少、聚成哪几类主题、每类摘要、最常引用来源)。
5. `bmo reembed --model <new>` 把全库迁到新 embedding 模型,**零数据丢失**,迁完 eval recall@5 不崩。

**不做**:离线对话、离线 OCR、MCP server(降级为可选学习项,见末节)、多端同步、知识图谱。

---

## 1. 前置准备

| 项 | 说明 |
|---|---|
| **Web search** | **不用第三方**:Kimi 自带内置 `$web_search`(已实测 `kimi-k2.6` 支持,服务端做搜索、按 token 计费)。`fetch_url` 复用 Phase 2 `parseUrl`,零新依赖。 |
| **沿用环境** | Kimi(对话/工具调用/联网)+ 本地 bge-m3(向量)。 |
| **(可选)MCP SDK** | 仅当将来做"可插拔 MCP 工具"或末节的 server 出口时才装 `@modelcontextprotocol/sdk`。 |

---

## 2. 架构:工具来源无关的 agent

```
对话 → runAgentStream
        └ TOOLS = [ 内置工具 ⊕ (将来) MCP 工具 ]   ← 合并成一个列表
              ├ search_knowledge   (本地库, 已有)
              ├ web_search         (联网搜, Phase 3 新增 native)
              ├ fetch_url          (抓正文, 复用 Phase 2 parseUrl)
              └ <future MCP tools> (预留:连外部 MCP server 自动发现)
        └ 派发按"工具名 → 处理器"查表,不关心工具来源
```

**关键**:把现在写死的 `if name === "search_knowledge"` 改成**注册表**(`Map<name, handler>` + schema 列表)。native 工具直接注册;将来 MCP client 把发现的工具也注册进同一张表。**先 native 联网,后插 MCP,派发主干不返工。**

---

## 3. Milestone A · 对话联网(工具来源无关 + web_search + fetch_url)

> 目标:BMO 对话时能"我的库 + 最新的"一起答——它甩开静态笔记和通用 Claude 的关键。

### A1. agent 工具改注册表(来源无关)
- 把 `loop.ts` 的工具定义 + 执行改成 `ToolRegistry`:`{ schema, handler }` 按名字注册;`runAgent/runAgentStream` 遍历注册表生成 `tools`,按名字派发。
- `search_knowledge` 迁成第一个注册项(行为不变,回归测试)。

### A2. `web_search` — 用 Kimi 内置 `$web_search`(不接第三方)
- 已实测 `kimi-k2.6` 支持:在 `tools` 里加 `{type:"builtin_function", function:{name:"$web_search"}}`,搜索由 Moonshot 服务端做(按 token 计费,一次约数千 tokens)。
- **特殊点**:它是「回填型」工具——模型吐出 `$web_search` 的 tool_call(arguments 里已带 search_id),客户端把这条 tool_call **原样 echo 回去**(role:"tool", content=arguments),Moonshot 再带搜索结果继续生成。
- 所以 A1 的注册表要分两类:**client 自己算的**(search_knowledge / fetch_url)和 **builtin 回填型**($web_search)。loop 加分支:`tool_call.type === "builtin_function"` → 回填 arguments;否则走本地 handler。
- 克制由模型自身判断(测过:说"需要联网"才触发,闲聊不触发),呼应验收 #2。

### A3. `fetch_url` (复用 Phase 2)
- 新工具 `fetch_url(url)` → 调 `parseUrl` 抓正文转 Markdown 返回(超时/反爬错误已在 Phase 2 处理好)。
- 典型链:`web_search` 拿到链接 → 模型挑一条 → `fetch_url` 读全文 → 结合库内作答。

### A4. provenance 扩展
- 联网来源在回答里给链接;桌面端来源徽章区分 📚 库内 / 🌐 联网,延续 Phase 1/2 的来源可视化。

**Milestone A 完成 = 对话能联网且克制、来源可辨。(验收 #1、#2、#3)**

---

## 4. Milestone B · 每周消化报告 + 成长 tab(Orchestrator-Workers)

> 目标:把"养成"做实——每周在成长 tab 告诉你吃了什么、消化出什么。

### B1. 取数与聚类
- 取最近 7 天 chunks;用已存向量做聚类(先简单余弦阈值聚类 + 簇数上限,后续可上 k-means)分主题簇。

### B2. Orchestrator-Workers
- **Workers**:每簇并发调 Kimi 出"这一簇讲了啥"的摘要。
- **Orchestrator**:汇总各簇摘要 + 统计(本周 N 篇/M 块、最常来源、来源类型分布)成一份周报 Markdown。

### B3. 成长 tab 展示 + 触发时机
- 桌面端启用"成长" tab:展示**最新周报 + 历史周报列表** + 基础统计(总篇/块、最常被引用来源)。
- 触发:`bmo digest` 手动 + **App 启动时检查"距上次≥7天就生成"**(无需 launchd,纯应用内调度)。
- 周报本身可入库(sourceType=text),让它也能被检索。

**Milestone B 完成 = 成长 tab 有每周消化报告。(验收 #4)**

---

## 5. Milestone C · Embedding 迁移工程(渐进重建)

> 目标:换 embedding 模型时**不删库**。(当前已用本地 bge-m3,本里程碑打通"换模型"这条路。)

### C1. 版本字段已就位
- `chunks.embedding_model` 已记录每块所用模型(Phase 0 预留)。

### C2. `bmo reembed`
- `bmo reembed --model <new> [--base-url/--dim ...]`:
  1. 维度变了 → 新建 `vec_chunks_v2(float[新维])`;
  2. 分批拉未迁 chunks → 新模型 `embed` → 写新向量 + 更新 `embedding_model`;
  3. 全迁完 → 检索切新表 → 删旧表。
- **可中断续跑**(按 `embedding_model` 过滤未迁),不锁库。

**Milestone C 完成 = 换 embedding 模型平滑迁移、零丢失。(验收 #5)**

---

## 6. (可选)BMO 当 MCP server / 接外部 MCP 工具

> 两个"将来想做再做"的扩展,本阶段不阻塞:

- **接外部 MCP 工具(client)**:A1 的注册表已预留——加一个 MCP client,连配置好的 MCP server,`listTools` → 注册进同一张表。这样 BMO 能像 Claude Desktop 那样插社区工具(GitHub/文件/行情…)。**当你想要可插拔扩展时再做。**
- **暴露为 MCP server**:`packages/mcp` 把 `search_memo`/`add_note` 暴露给 Claude Desktop/Code(core 的又一薄壳,约 150 行)。**纯学习/作品集向**,对日常用处不大(你的库内容和 coding session 不重叠)。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 联网工具被滥用(闲聊也搜) | description 写明调用条件;低相关时模型自抑(同"不盲目检索") |
| Kimi 内置搜索按 token 计费(一次数千) | 仅在模型判断需要时触发;web search 绑死 Kimi(已认可) |
| 抓取反爬/超时 | 复用 Phase 2 `parseUrl` 已有的超时/403 兜底 |
| 周报聚类质量不稳 | 先简单阈值聚类 + 簇数上限,逐步引入 k-means |
| 重建 embedding 期间检索不一致 | 迁移期双表并存,切换原子化,失败可续跑 |
| 投喂量小 → 周报很薄 | 周报按"过去 7 天",量小就如实简短,不硬凑 |

---

## 8. 完成定义(Definition of Done)

- [ ] Milestone A:agent 工具注册表(来源无关)+ `web_search` + `fetch_url`,对话能联网且克制
- [ ] Milestone B:成长 tab + 每周消化报告(Orchestrator-Workers,应用内调度)
- [ ] Milestone C:`bmo reembed` 渐进迁移 embedding 模型,零丢失
- [ ] 跑通第 0 节全部 5 条验收标准
- [ ] (可选)接外部 MCP 工具 / 暴露 MCP server

**推荐施工顺序**:A(联网,日常价值最高)→ B(养成主线)→ C(工程化)。MCP 的两个扩展按需再说。
