import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chunkConfig, searchConfig } from "@bmo/core";

const SETTINGS_KEYS = [
  "BMO_SIMILARITY_THRESHOLD",
  "BMO_RECALL_K",
  "BMO_RRF_K",
  "BMO_CHUNK_MAX_CHARS",
  "BMO_CHUNK_OVERLAP",
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export type RuntimeSettings = {
  similarityThreshold: number;
  recallK: number;
  rrfK: number;
  chunkMaxChars: number;
  chunkOverlap: number;
  envPath: string;
};

export type SettingsPatch = Partial<Record<SettingsKey, number>>;

export function settingsEnvPath(): string {
  return process.env.BMO_SETTINGS_ENV_PATH ?? join(homedir(), ".bmo", ".env");
}

export function readRuntimeSettings(): RuntimeSettings {
  const search = searchConfig();
  const chunk = chunkConfig();
  return {
    similarityThreshold: search.similarityThreshold,
    recallK: search.recallK,
    rrfK: search.rrfK,
    chunkMaxChars: chunk.maxChars,
    chunkOverlap: chunk.overlap,
    envPath: settingsEnvPath(),
  };
}

export function updateRuntimeSettings(patch: SettingsPatch): RuntimeSettings {
  validatePatch(patch);

  const envPath = settingsEnvPath();
  const next = new Map(readEnvFile(envPath));
  for (const key of SETTINGS_KEYS) {
    const value = patch[key];
    if (value == null) continue;
    const serialized = String(value);
    next.set(key, serialized);
    process.env[key] = serialized;
    if (key === "BMO_SIMILARITY_THRESHOLD") process.env.SIMILARITY_THRESHOLD = serialized;
  }

  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, serializeEnv(next), "utf-8");
  return readRuntimeSettings();
}

function validatePatch(patch: SettingsPatch): void {
  for (const key of Object.keys(patch) as SettingsKey[]) {
    if (!SETTINGS_KEYS.includes(key)) throw new Error(`不支持的设置项：${key}`);
    const value = patch[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} 必须是数字`);
  }

  if (patch.BMO_SIMILARITY_THRESHOLD != null && (patch.BMO_SIMILARITY_THRESHOLD < 0 || patch.BMO_SIMILARITY_THRESHOLD > 1)) {
    throw new Error("相似度阈值必须在 0 到 1 之间");
  }
  for (const key of ["BMO_RECALL_K", "BMO_RRF_K", "BMO_CHUNK_MAX_CHARS"] as const) {
    if (patch[key] != null && (!Number.isInteger(patch[key]) || patch[key] <= 0)) {
      throw new Error(`${key} 必须是正整数`);
    }
  }
  if (patch.BMO_CHUNK_OVERLAP != null && (!Number.isInteger(patch.BMO_CHUNK_OVERLAP) || patch.BMO_CHUNK_OVERLAP < 0)) {
    throw new Error("BMO_CHUNK_OVERLAP 必须是非负整数");
  }
  if (
    patch.BMO_CHUNK_MAX_CHARS != null &&
    patch.BMO_CHUNK_OVERLAP != null &&
    patch.BMO_CHUNK_OVERLAP >= patch.BMO_CHUNK_MAX_CHARS
  ) {
    throw new Error("chunk overlap 必须小于 chunk max chars");
  }
}

function readEnvFile(path: string): [string, string][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      if (index < 0) return null;
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as [string, string];
    })
    .filter((entry): entry is [string, string] => entry != null && entry[0].length > 0);
}

function serializeEnv(values: Map<string, string>): string {
  return `${[...values.entries()].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}
