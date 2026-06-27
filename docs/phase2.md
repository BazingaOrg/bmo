# BMO Phase 2 · 解析与检索质量执行计划

> 让 BMO 能吃下 PDF / Word / 表格 / 网页 / 截图(全部归一化为 Markdown),
> 并用 eval 把检索质量调到可量化的水平(recall@5 ≥ 0.8),引用能溯源到原文。
>
> 本文是 step-by-step 施工图。总纲见 [`plan.md`](./plan.md);Phase 1 见 [`phase1.md`](./phase1.md)。

---

## 0. 目标与验收标准

**交付**:四类文件 parser(PDF / Word / 表格 / URL)+ 截图走视觉模型转 Markdown;可量化的 eval harness;引用溯源 UI;可调检索参数。

**验收清单**:
1. 五种输入(PDF / .docx / .xlsx·csv / URL / 截图)都能投喂入库,产物是干净的 Markdown,坏输入(加密 PDF、反爬页面、空文件)有明确报错而非崩溃。
2. 自标 30 条「query → 期望文档」集合上,**recall@5 ≥ 0.8**;eval 一条命令出 recall@5 / MRR 数字。
3. 调 chunk 大小 / overlap / 相似度阈值时,能看到指标曲线变化并据此定参(不是拍脑袋)。
4. 对话里的来源 chip 点开能看到**原文档全文 + 高亮命中的 chunk**,不只是孤立片段。

**不做**(留给 Phase 3):本地 embedding 切换、Vision OCR 离线兜底、MCP、每周消化报告。Rerank 是**可选项**,只有 eval 证明有提升才保留。

---

## 1. 前置准备

| 项 | 说明 |
|---|---|
| **解析依赖** | `unpdf`(PDF)、`mammoth`(Word)、`xlsx`/SheetJS(表格)、`@mozilla/readability` + `linkedom` + `turndown`(URL)。装进 `@bmo/core`。 |
| **视觉模型** | 截图转写需 **Kimi 的视觉模型**(不是 Claude——我们整条栈是 Kimi)。先用一个请求确认当前可用的 vision model id(类似当初确认 `kimi-k2.6`),填 `BMO_VISION_MODEL`。⚠️ 纯文本的 `kimi-k2.6` 不一定带视觉。 |
| **Rerank(可选)** | `bge-reranker-v2-m3` 本地,或 Jina / Cohere rerank API。只有进到 Milestone C 才装。 |
| **标注集** | 需要先有真实库内容(把你最近读的文章喂进去),否则标注集无从谈起。 |

---

## 2. 架构:统一解析为 Markdown(对应决策二)

```
原始输入(pdf/docx/xlsx/url/image/text)
        │
        ▼  packages/core/src/parse/ 按类型分发
   parse(input) → { title, markdown, sourceType, metadata }
        │
        ▼  复用现有管道(一行都不用改)
   eat(db, { title, markdown, sourceType, ... })  →  切块 → embedding → 入库
```

**核心原则**:切块 / embedding / 检索 / 引用只面对 Markdown 一种格式。**新增输入类型 = 新增一个 parser,核心管道不动。** parser 全部输出 `{ title, markdown, metadata }`,坏输入抛带用户可读信息的错误。

`documents.source_type` 已支持 `text|url|pdf|docx|xlsx|image`(Phase 0 建表时就留了),所以 DB 不用动,parser 只要把 sourceType 填对。

---

## 3. Milestone A · 五类 parser(统一输出 Markdown)

> 目标:**五种输入都能 `bmo eat` / 浮窗投喂入库**,坏输入不崩。

### A1. parser 架构与分发
- 新建 `packages/core/src/parse/index.ts`:`parseToMarkdown(source)` 按扩展名 / 类型分发到具体 parser。
- 统一返回 `ParsedDoc { title; markdown; sourceType; metadata? }`。
- 每个 parser 自带异常处理,失败抛 `ParseError`(带中文可读原因)。

### A2. PDF — `unpdf`
- 抽取文本 → Markdown(保留标题/段落结构尽量)。
- 异常:**加密 PDF**(提示需密码,Phase 2 先拒绝)、**扫描件/纯图 PDF**(抽不出文字 → 提示"像是扫描件,Vision OCR 留 Phase 3")。

### A3. Word — `mammoth`
- `.docx` → HTML → Markdown(mammoth 转 HTML,再用 turndown 转 MD),保留标题/列表/表格。

### A4. 表格 — `xlsx`(SheetJS)
- `.xlsx` / `.csv` → 每个 sheet 转 Markdown 表格;大表截断 + 提示行数。

### A5. URL — `@mozilla/readability` + `linkedom` + `turndown`
- 抓 HTML → linkedom 构造 DOM → readability 提正文 → turndown 转 Markdown,去广告/导航。
- 异常:**超时**(加 fetch timeout)、**反爬/403**(提示抓取失败)、**正文为空**(readability 失败兜底)。
- `sourceUrl` 记进元数据,引用时可点回原网页。

### A6. 截图 / 图片 — Kimi 视觉
- 浮窗截图(Phase 1 已存盘并记了路径)→ 读图 → 调 **Kimi vision** 多模态,prompt 让它把图里的内容(图表、文字、结构)转成结构化 Markdown。
- `sourceType=image`,原图路径记进 `raw_path`。
- 异常:vision model 不可用 / 图过大 → 明确报错。

### A7. 接进投喂入口
- `core`:`eat` 之前先 `parseToMarkdown`;或新增 `eatSource()` 包一层。
- `server`:`/eat` 接受文件路径 / URL / 图片,按类型走 parser。
- `desktop` 浮窗:文件拖入支持 pdf/docx/xlsx;粘贴 URL 走 URL parser;截图走 vision。
- `cli`:`bmo eat` 放开扩展名限制,走同一套 parser。

**Milestone A 完成 = 五种输入全部可入库,坏输入有友好报错。(验收 #1)**

---

## 4. Milestone B · Eval harness + RAG 调优

> 目标:把"检索好不好"从感觉变成**数字**,并据此调参。

### B1. 标注集
- 新建 `packages/eval`(或 `core/eval`):`dataset.jsonl`,每条 `{ query, expectedDocTitles: [...] }`,**30 条**,基于你真实喂进去的内容人工标注。
- 覆盖:专有名词精确匹配、语义改写、跨文档、库内没有(负样本)。

### B2. 指标与 runner
- 实现 `recall@5`(期望文档是否进前 5)、`MRR`(第一个命中的倒数排名)。
- `pnpm eval` 跑全集,输出每条结果 + 汇总数字。

### B3. 可调参数 → 看指标曲线
- 把这些做成可配置:`chunk maxChars` / `overlap` / `SIMILARITY_THRESHOLD` / `RRF_K` / 每路 `RECALL_K`。
- 扫参(grid/逐个)跑 eval,记录指标随参数的变化,选最优组合。
- ⚠️ 改 chunk 参数需**重建向量库**(eval 用独立库,别动主库)。

### B4. 调到达标
- 迭代到 **recall@5 ≥ 0.8**;把最终参数写回默认值。

**Milestone B 完成 = `pnpm eval` 出数字且 recall@5 ≥ 0.8。(验收 #2、#3)**

---

## 5. Milestone C · Rerank(可选,eval 说了算)

> 目标:召回之后再精排一层,提升 top-k 精度——**只在 eval 证明有提升时才保留**。

### C1. 接 reranker
- 选型:`bge-reranker-v2-m3` 本地(需小服务/transformers,Ollama 对 rerank 支持有限),或 Jina / Cohere rerank API(省事但要 key)。
- 在 hybrid 检索 RRF 合并后、返回前,对候选做 rerank 重排取 top-k。

### C2. A/B 对比
- eval 跑 rerank on / off,比 recall@5 / MRR。
- 有提升才合并,并记成本/延迟代价;没提升就砍掉,不背包袱。

**Milestone C 完成 = 有 eval 支撑的 rerank 取舍决定。**

---

## 6. Milestone D · 引用溯源 UI 增强 + 可调阈值

> 目标:把 Phase 1 的来源卡片,升级成真正的"溯源到原文"。

### D1. 溯源到原文
- 来源 chip 点开 → 不只显示孤立 chunk,而是**原文档全文 + 高亮命中的那段**(用 chunk 在 markdown 中的位置定位)。
- 食谱 tab(若本阶段做)可点进文档看全文 + 它被切成的块。

### D2. 可调检索参数(连 eval 结论)
- 设置界面暴露相似度阈值等参数,默认值取 Milestone B 调出来的最优。
- 这也顺便落地 Phase 1 遗留的"生产配置/设置界面"需求(`~/.bmo/.env` 可由此写入)。

**Milestone D 完成 = 引用可溯源到原文 + 阈值可调。(验收 #4)**

---

## 7. Milestone E · 异常处理与健壮性收口

> 目标:各 parser 的边角 case 都有兜底,投喂永不静默失败。

- 加密 PDF / 扫描件 / 超大文件 / 反爬页面 / 空解析 / vision 失败:统一抛可读错误,浮窗与 CLI 都给明确提示。
- 投喂失败不污染库(解析失败就不进 eat)。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| Kimi vision 的 model id / 可用性 / 成本 | 先 list-models 确认 id;高频截图将来切 Phase 3 的 Vision OCR 本地兜底 |
| 扫描件 PDF 抽不出文字 | Phase 2 明确不支持,提示留 Phase 3 OCR |
| 反爬 / 付费墙网页 | 超时 + UA + 失败兜底提示;不硬刚 |
| parser 原生/重依赖打进 sidecar 包变大 | 接受;必要时按需懒加载 parser |
| 调 chunk 参数要重建全库 | eval 用独立库;主库重建走后台渐进(embedding_model 版本字段) |
| 标注集小(30 条)统计噪声 | 作为方向性指标,不追求小数点;必要时扩到 50 条 |

---

## 9. 完成定义(Definition of Done)

- [ ] Milestone A:五类输入(PDF/Word/表格/URL/截图)全部可入库,坏输入友好报错
- [ ] Milestone B:`pnpm eval` 出 recall@5 / MRR,且 recall@5 ≥ 0.8
- [ ] Milestone C:有 eval 支撑的 rerank 取舍(留或不留都要有数据)
- [ ] Milestone D:引用溯源到原文 + 阈值可调
- [ ] Milestone E:各 parser 异常兜底,投喂不静默失败
- [ ] 跑通第 0 节全部 4 条验收标准

**推荐施工顺序**:A(先有 parser 才有内容可调)→ B(把质量量化)→ C/D(按 B 的结论决定 rerank、做溯源 UI)→ E 收口。
