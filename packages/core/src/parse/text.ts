import { readFile } from "node:fs/promises";
import { ParseError, assertNonEmptyMarkdown, type ParsedDoc } from "./types.js";
import { titleFromPath } from "./utils.js";

export async function parseTextFile(path: string, title?: string): Promise<ParsedDoc> {
  try {
    const markdown = assertNonEmptyMarkdown(await readFile(path, "utf-8"));
    return {
      title: title ?? titleFromPath(path),
      markdown,
      sourceType: "text",
      rawPath: path,
    };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("text-read-failed", `读取文本文件失败：${errorMessage(error)}`, { cause: error });
  }
}

export function parseText(text: string, title?: string): ParsedDoc {
  const markdown = assertNonEmptyMarkdown(text);
  return {
    title: title ?? markdown.slice(0, 24) + (markdown.length > 24 ? "..." : ""),
    markdown,
    sourceType: "text",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
