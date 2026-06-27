import dotenv from "dotenv";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// sidecar 被 Tauri 用 `pnpm --filter @bmo/server dev` 拉起时，cwd 是 packages/server，
// 那里没有 .env。所以不能靠 cwd，必须用绝对路径加载，否则桌面端拿不到 Kimi key / embedding 配置。
const here = dirname(fileURLToPath(import.meta.url)); // dev: packages/server/src
const repoRoot = resolve(here, "../../.."); // → 仓库根

// 开发：复用 CLI 那份已验证的配置（单一来源，不重复维护密钥）。
dotenv.config({ path: resolve(repoRoot, "packages/cli/.env") });
// 生产：打包后没有仓库结构，用户态配置放 ~/.bmo/.env，优先级最高。
dotenv.config({ path: resolve(homedir(), ".bmo/.env"), override: true });
