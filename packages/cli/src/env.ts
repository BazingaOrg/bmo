import dotenv from "dotenv";

// 必须在任何读取 process.env 的模块（@bmo/core 在 import 期就读 EMBEDDING_DIM 等）之前执行，
// 所以独立成一个 side-effect 模块，并在 index.ts 里作为第一个 import 引入。
//
// override: true —— BMO 的 .env 必须盖过外层 shell 已有的同名变量。
// 用户本机跑 Claude Code 时常驻 ANTHROPIC_* / 可能有 OPENAI_* 等环境变量，
// 不覆盖的话 BMO 会无声地读到外层值、打到错误端点或用错凭据。
dotenv.config({ override: true });
