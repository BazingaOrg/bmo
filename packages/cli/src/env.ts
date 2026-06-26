import dotenv from "dotenv";

// 必须在任何读取 process.env 的模块（@bmo/core 在 import 期就读 EMBEDDING_DIM 等）之前执行，
// 所以独立成一个 side-effect 模块，并在 index.ts 里作为第一个 import 引入。
//
// override: true —— BMO 的 .env 必须盖过外层 shell 已有的 ANTHROPIC_* 变量。
// 否则当用户本机用 Claude Code（其 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 常驻环境）时，
// BMO 会无声地打到错误端点、用错凭据。
dotenv.config({ override: true });
