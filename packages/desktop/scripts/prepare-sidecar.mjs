import { copyFileSync, chmodSync, cpSync, lstatSync, mkdirSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const sidecarRoot = resolve(desktopRoot, "src-tauri/resources/sidecar");
const serverRoot = resolve(sidecarRoot, "server");
const nodeBinDir = resolve(sidecarRoot, "node/bin");
const nodeBin = resolve(nodeBinDir, process.platform === "win32" ? "node.exe" : "node");

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runPnpm(args, extraEnv = {}) {
  run("corepack", ["pnpm", ...args], extraEnv);
}

function materializeSymlinks(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(path), readlinkSync(path));
      rmSync(path, { recursive: true, force: true });
      cpSync(target, path, { recursive: true, dereference: true });
      if (lstatSync(path).isDirectory()) {
        materializeSymlinks(path);
      }
      continue;
    }

    if (stat.isDirectory()) {
      materializeSymlinks(path);
    }
  }
}

function copyRuntimeDependency(packageName) {
  const source = resolve(serverRoot, "node_modules/.pnpm/node_modules", packageName);
  const target = resolve(serverRoot, "node_modules", packageName);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
}

function hoistPnpmRuntimeDependencies() {
  const sourceRoot = resolve(serverRoot, "node_modules/.pnpm/node_modules");
  for (const entry of readdirSync(sourceRoot)) {
    if (entry === ".bin") continue;

    if (entry.startsWith("@")) {
      for (const scopedEntry of readdirSync(resolve(sourceRoot, entry))) {
        copyRuntimeDependency(`${entry}/${scopedEntry}`);
      }
      continue;
    }

    copyRuntimeDependency(entry);
  }
}

rmSync(sidecarRoot, { recursive: true, force: true });
mkdirSync(nodeBinDir, { recursive: true });

runPnpm(["--filter", "@bmo/core", "build"]);
runPnpm(["--filter", "@bmo/server", "build"]);
runPnpm(["--filter", "@bmo/server", "deploy", "--prod", serverRoot], {
  CI: "true",
});
materializeSymlinks(resolve(serverRoot, "node_modules"));
hoistPnpmRuntimeDependencies();
materializeSymlinks(resolve(serverRoot, "node_modules"));

copyFileSync(process.execPath, nodeBin);
chmodSync(nodeBin, 0o755);

writeFileSync(
  resolve(sidecarRoot, "manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      entrypoint: "server/dist/index.js",
    },
    null,
    2
  )
);

console.log(`Prepared BMO sidecar resources at ${sidecarRoot}`);
