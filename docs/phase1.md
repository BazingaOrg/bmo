# BMO Phase 1 · 桌面化执行计划

> 把 Phase 0 验证过的 core(入库 + hybrid 检索 + agent loop)装进一个住在菜单栏里的 Tauri 应用：
> 全局快捷键浮窗投喂 + 流式对话界面 + provenance 来源标记。
>
> 本文是 step-by-step 施工图。总纲见 [`plan.md`](./plan.md);Phase 0 成果见根 `README.md`。

---

## 0. 目标与验收标准

**交付**：一个 macOS 桌面应用——菜单栏常驻(无 Dock 图标)、`⌘⇧M` 唤起 Spotlight 式浮窗投喂、主窗口里和 BMO 流式对话并看到引用来源。

**验收清单**：
1. App 启动后菜单栏出现 BMO 图标,点开有菜单;关闭窗口 App 不退出(常驻)。
2. 任意应用中按 `⌘⇧M` → 浮窗在 300ms 内弹出并聚焦;`Esc` 收起。
3. 浮窗里**粘贴文字 / 拖入文件 / 截图**任一方式,**从按快捷键到投喂完成 ≤ 3 秒**,并有"已吞下"反馈。
4. 主窗口对话**流式逐字输出**;涉及库内内容时实时显示 `⚙ 翻找记忆` → 回答带 `【来源】` → 末尾有 `📚/💭/🔍` 来源徽章。
5. 退出 App 时 sidecar 进程被干净杀掉(无僵尸 node 进程残留)。

**不做**(留给后续):食谱 tab、成长 tab、PDF/Word/URL 解析、截图走视觉模型、rerank、MCP。Phase 1 只做**浮窗 + 对话**两个界面。

---

## 1. 前置准备

| 项 | 说明 |
|---|---|
| **Rust toolchain** | Tauri v2 的壳是 Rust,必须装:`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh`,装完 `rustc --version` 验证。我们几乎不写 Rust,但编译壳需要它。 |
| **Tauri 系统依赖** | macOS 需 Xcode Command Line Tools:`xcode-select --install`。 |
| **Tauri CLI** | 作为 devDependency 装进 desktop 包(下文),不全局装。 |
| **沿用环境** | Kimi(`BMO_CHAT_*`)+ 本地 Ollama bge-m3(`EMBEDDING_*`)。sidecar 复用 `packages/cli/.env` 同款变量。 |

> ⚠️ Tauri 首次 `build`/`dev` 会编译 Rust 依赖,耗时较长(几分钟),属正常。

---

## 2. 架构与新增包结构

```
Tauri 壳(Rust + WebView)
  ├─ 启动时 spawn ──► Node sidecar(packages/server, Hono, 监听 127.0.0.1:随机端口)
  │                      └─ 复用 @bmo/core:openDb / eat / runAgent(改流式)
  └─ WebView 加载 ──► Vue 前端(packages/desktop/src)
                         └─ 通过 HTTP + SSE 和 sidecar 通信
```

**新增两个包**(core / cli 不动,继续作为薄壳之一):

| 包 | 角色 | 技术 |
|---|---|---|
| `packages/server` | Node sidecar:把 core 包成 HTTP + SSE 服务 | Hono + @hono/node-server |
| `packages/desktop` | Tauri 壳 + Vue 前端 | Tauri v2 + Vue 3 + Vite + Pinia + Tailwind |

**为什么分两个包**:sidecar(server)和壳(desktop)生命周期不同、Phase 3 的 MCP 还要复用 server 的逻辑。core 永远与界面无关。

---

## 3. Milestone A · sidecar 化 core(Hono HTTP + SSE)

> 目标:**没有任何 UI 也能用 curl 跑通投喂和流式对话**。这是 Phase 1 风险最低、最该先做的一步。

### A1. 建 `packages/server`
- `pnpm create` 一个 TS 包,依赖 `hono`、`@hono/node-server`、`@bmo/core`、`dotenv`。
- 入口 `src/index.ts`:`dotenv` override 加载 → 监听 `127.0.0.1:0`(随机端口)→ **把实际端口打印到 stdout**(壳要读它)。

### A2. 把 `runAgent` 改成流式(core 改动)
- 现在 `runAgent` 非流式、整段返回。新增**流式版本**:`chat.completions.create({ ..., stream: true })`,逐 chunk 累积 `delta.content` 和 `delta.tool_calls`。
- 复用并扩展 `AgentEvents`:加 `onTextDelta?(delta: string)`;`onToolUse` / `onSearchResult` 保留。
- 工具调用在流式下的要点:`tool_calls` 是跨 chunk 累积的(`index` 对齐、`arguments` 字符串拼接),收齐后再执行、回填、继续循环。
- 文件:`packages/core/src/agent/loop.ts`(新增 `runAgentStream` 或给 `runAgent` 加 streaming 开关)。

### A3. HTTP 端点(Hono)
| 方法 | 路径 | 作用 | 返回 |
|---|---|---|---|
| GET | `/health` | 健康检查(壳轮询用) | `{ ok: true }` |
| POST | `/eat` | 投喂(text / 文件内容) | `{ documentId, chunkCount }` |
| POST | `/chat` | 流式对话 | **SSE**:`text` / `tool` / `provenance` / `done` 事件 |
| GET | `/documents` | (可选)列出已吞文档,为后续食谱 tab 铺路 | `Document[]` |

- `/chat` 用 SSE:把 `onTextDelta` → `event: text`、`onToolUse` → `event: tool`、`onSearchResult` 汇总 → `event: provenance`、结束 → `event: done`。
- 会话状态:Phase 1 先**前端持有 messages 数组**,每次 POST 整个历史过来(无状态 sidecar 最简单)。

### A4. 验证(无 UI)
```bash
pnpm --filter @bmo/server dev      # 启动,记下打印的端口
curl localhost:<port>/health
curl -X POST localhost:<port>/eat -d '{"text":"测试内容","title":"t"}'
curl -N -X POST localhost:<port>/chat -d '{"messages":[{"role":"user","content":"..."}]}'  # 看 SSE 流
```
**Milestone A 完成 = curl 能流式聊天 + 投喂。**

---

## 4. Milestone B · Tauri 壳 + sidecar 生命周期

> 目标:Tauri 应用能启动、自动拉起并管理 sidecar、菜单栏常驻。这是**工程难点**。

### B1. 脚手架 `packages/desktop`
- `pnpm create tauri-app`(选 Vue + TS + Vite),并入 monorepo。
- 装 Tauri 插件:`global-shortcut`、`clipboard-manager`、`shell`、`notification`、`autostart`,以及 tray 能力。

### B2. sidecar 生命周期(Rust 侧少量代码)
- **打包 sidecar**:开发期直接 spawn `pnpm --filter @bmo/server dev`;分发期不强压单二进制,而是把 Node runtime + `packages/server` production deploy 结果打进 Tauri resources,由 Rust 从 resources 启动 `node server/dist/index.js --port=0`。`bun build --compile` / `pkg` 单二进制只作为后续优化,不阻塞 Phase 1。
- **启动**:App 启动时 spawn sidecar,**读它 stdout 的端口号**,存进 Tauri state,暴露给前端(`/health` 轮询直到 ready)。
- **健康检查**:前端启动时轮询 `/health`,未就绪显示"BMO 启动中"。
- **退出清理**:监听 Tauri 退出 / window 销毁事件,`kill` sidecar 子进程,确保无僵尸。
- 文件:`packages/desktop/src-tauri/src/lib.rs`(spawn/读端口/kill)。

### B3. 菜单栏常驻
- `tauri.conf.json`:`macOSPrivateApi`、隐藏 Dock 图标(`ActivationPolicy::Accessory`)。
- Tray 图标 + 菜单(显示主窗口 / 退出)。
- 关闭主窗口 = 隐藏而非退出。

**Milestone B 完成 = App 起来、菜单栏有图标、sidecar 自动起停干净。**

---

## 5. Milestone C · 浮窗 + 全局快捷键 + 投喂

> 目标:`⌘⇧M` 三秒投喂闭环——产品的核心入口。

### C1. 浮窗窗口
- 第二个 Tauri window:无边框、透明、置顶、居中、失焦自动隐藏(Spotlight 式)。
- 默认隐藏,不进 Dock/任务栏。

### C2. 全局快捷键
- `global-shortcut` 注册 `⌘⇧M` → 显示并聚焦浮窗;`Esc` → 隐藏。

### C3. 三种投喂方式(浮窗 Vue UI)
| 方式 | 实现 |
|---|---|
| **纯文字 / 链接** | 输入框 / 粘贴(clipboard-manager);链接先按文字入库,URL 解析留 Phase 2 |
| **文件拖入** | Tauri file-drop 事件 → 读路径 → 传给 `/eat`(Phase 1 先支持 .md/.txt,与 CLI 一致) |
| **截图** | `shell` 插件调 `screencapture -i /tmp/x.png` 框选 → Phase 1 先把图存盘 + 记录路径占位(视觉转写留 Phase 2) |

### C4. 反馈
- 投喂中:小机器人咀嚼动画(占位即可,打磨在 E)。
- 完成:`notification` 或浮窗内 toast「咔嚓——已吞下 1 篇,切成 N 块」,随后浮窗收起。

**Milestone C 完成 = 任意 App 里 `⌘⇧M` → 投喂 → ≤3 秒收起。(验收标准 #3)**

---

## 6. Milestone D · 主窗口 + 流式对话 + provenance UI

> 目标:把 Phase 0 的 CLI 对话体验,升级成图形化流式界面 + 来源可视化。

### D1. 主窗口 + 对话 tab
- Vue + Pinia 管理 messages;Tab 结构留好(对话 / 后续食谱 / 成长),Phase 1 只实现对话。

### D2. SSE 流式渲染
- 连 `/chat` 的 SSE:`text` 事件逐字 append、`tool` 事件显示 `⚙ 翻找记忆：query`、`provenance` 事件渲染徽章、`done` 结束。
- Markdown 渲染回答(代码块、加粗等)。

### D3. provenance 可视化(承接上一轮设计讨论)
- **每条回答的徽章**(由 sidecar 的 `provenance` 事件驱动,来自客观事实非模型自报):
  - 🟩 `基于你的库 · N 条` / ⬜ `通用知识` / 🟡 `查了没命中`
- **句级来源**:回答里的 `【来源：标题】` 解析成可点击 chip;点击展开**来源卡片**(显示该 chunk 文本 + 相似度;数据来自 `SearchHit.similarity`)。
- **固定 legend**:聊天区角落一个小图例(🟩库内 · ⬜通用),像 chart legend。
- (可选)chip 上标相似度:`段永平-理念 · 强相关 0.82`。

**Milestone D 完成 = 流式对话 + 来源徽章/卡片可用。(验收标准 #4)**

---

## 7. Milestone E · Design tokens + 微交互打磨

> 目标:从"能用"到"玩具感的效率工具"。

### E1. Design tokens 写进 Tailwind 配置(第一天就定,不返工)
| Token | 值 |
|---|---|
| 主色 BMO 青 | `#63C5B5` |
| 深色底 | `#0F5C55` |
| 浅色底(奶油白) | `#FDF6E3` |
| 点缀红 / 黄 | `#E4504B` / `#F5C84C` |
| 圆角 | 12–16px |
| 字体 | 苹方 / 思源黑体;数字代码 JetBrains Mono |
| 间距 | 4pt 网格 |

深浅色跟随系统。

### E2. 微交互(养成感)
- 投喂咀嚼动画;完成 toast 带性格文案。
- 检索中"眼睛转圈"。
- 引用卡片点开溯源。
- 空状态文案:「我还很饿,喂我点东西吧」。

**Milestone E 完成 = 视觉与微交互到位。**

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| sidecar 打包(依赖 node 运行时) | 开发期直接 spawn `pnpm`;分发期嵌入 Node runtime + server resources。单二进制会被 `better-sqlite3` / `sqlite-vec` 原生依赖卡住,暂不作为 Phase 1 路线 |
| Tauri Rust 编译耗时/环境坑 | 先装好 rustup + Xcode CLT;首次编译慢属正常 |
| 流式下 tool_calls 累积易错 | Milestone A 用 curl 充分测;`index` 对齐 + `arguments` 拼接写单测 |
| sidecar 端口冲突 | 监听 `:0` 随机端口,壳读 stdout 拿实际端口 |
| 退出残留僵尸 node | B2 显式 kill;并在 sidecar 加"父进程消失即自杀"兜底 |
| 全局快捷键被占用 | 注册失败时提示用户改键 |

---

## 9. 完成定义(Definition of Done)

- [ ] Milestone A:curl 能流式对话 + 投喂(core 流式化 + Hono sidecar)
- [ ] Milestone B:Tauri 应用菜单栏常驻 + sidecar 自动起停干净
- [ ] Milestone C:`⌘⇧M` 浮窗三秒投喂闭环(文字/文件/截图占位)
- [ ] Milestone D:流式对话界面 + provenance 徽章/来源卡片/legend
- [ ] Milestone E:design tokens + 微交互打磨
- [ ] 跑通第 0 节全部 5 条验收标准

**推荐施工顺序**:A → B → C/D(可并行)→ E。先把 sidecar(A)跑通,后面壳和前端都是在稳定的 HTTP 接口上搭。
