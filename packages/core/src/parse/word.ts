import mammoth from "mammoth";
import { ParseError, assertNonEmptyMarkdown, type ParsedDoc } from "./types.js";
import { htmlToMarkdown, titleFromPath } from "./utils.js";

export async function parseWord(path: string, title?: string): Promise<ParsedDoc> {
  try {
    const result = await mammoth.convertToHtml({ path });
    const markdown = assertNonEmptyMarkdown(htmlToMarkdown(result.value), "word-empty");
    return {
      title: title ?? titleFromPath(path),
      markdown,
      sourceType: "docx",
      rawPath: path,
      metadata: {
        warnings: result.messages.map((message) => message.message),
      },
    };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("word-parse-failed", `Word 解析失败：${errorMessage(error)}`, { cause: error });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
