import dotenv from "dotenv";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// 和 server 一样:eval 跑在 packages/eval cwd,没有 .env,必须用绝对路径加载,
// 否则 EMBEDDING_* 拿不到、embedding 直接 fetch failed。
const here = dirname(fileURLToPath(import.meta.url)); // packages/eval/src
const repoRoot = resolve(here, "../../..");
dotenv.config({ path: resolve(repoRoot, "packages/cli/.env") });
dotenv.config({ path: resolve(homedir(), ".bmo/.env"), override: true });
