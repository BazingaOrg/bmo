import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readEnvFile(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  const entries = readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      if (index < 0) return null;
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as [string, string];
    })
    .filter((entry): entry is [string, string] => entry != null && entry[0].length > 0);
  return new Map(entries);
}

export function writeEnvFile(path: string, values: Map<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${[...values.entries()].map(([key, value]) => `${key}=${value}`).join("\n")}\n`, "utf-8");
}

export function updateEnvFile(path: string, patch: Record<string, string | undefined>): void {
  const next = readEnvFile(path);
  for (const [key, value] of Object.entries(patch)) {
    if (value != null) next.set(key, value);
  }
  writeEnvFile(path, next);
}
