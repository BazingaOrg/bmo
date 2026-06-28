import { resolve } from "node:path";
import { eat, type EatResult } from "../ingest/index.js";
import type { DB } from "../db/index.js";
import { parseImage } from "./image.js";
import { parsePdf } from "./pdf.js";
import { parseSheet } from "./sheet.js";
import { parseText, parseTextFile } from "./text.js";
import { parseUrl } from "./url.js";
import { ParseError, type ParsedDoc, type ParseSource } from "./types.js";
import { IMAGE_EXTENSIONS, PDF_EXTENSIONS, SHEET_EXTENSIONS, TEXT_EXTENSIONS, WORD_EXTENSIONS, inferExtension, isProbablyPlainUrl } from "./utils.js";
import { parseWord } from "./word.js";

export { ParseError, isParseError, type ParsedDoc, type ParseSource, type SourceType } from "./types.js";
export { looksLikeUrl } from "./utils.js";

export async function parseToMarkdown(source: ParseSource): Promise<ParsedDoc> {
  if (source.kind === "text") {
    if (isProbablyPlainUrl(source.text)) return parseUrl(source.text.trim(), source.title);
    return parseText(source.text, source.title);
  }
  if (source.kind === "url") return parseUrl(source.url, source.title);

  const path = resolve(source.path);
  const ext = inferExtension(path);
  if (TEXT_EXTENSIONS.has(ext)) return parseTextFile(path, source.title);
  if (PDF_EXTENSIONS.has(ext)) return parsePdf(path, source.title);
  if (WORD_EXTENSIONS.has(ext)) return parseWord(path, source.title);
  if (SHEET_EXTENSIONS.has(ext)) return parseSheet(path, source.title);
  if (IMAGE_EXTENSIONS.has(ext)) return parseImage(path, source.title);
  throw new ParseError("unsupported-source-type", `暂不支持 ${ext || "未知"} 格式`);
}

export async function eatSource(db: DB, source: ParseSource): Promise<EatResult & { title: string; parsed: ParsedDoc }> {
  const parsed = await parseToMarkdown(source);
  const result = await eat(db, {
    title: parsed.title,
    markdown: parsed.markdown,
    sourceType: parsed.sourceType,
    sourceUrl: parsed.sourceUrl,
    rawPath: parsed.rawPath,
  });
  return { ...result, title: parsed.title, parsed };
}
