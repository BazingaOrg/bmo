import { basename, extname } from "node:path";
import TurndownService from "turndown";

export const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
export const PDF_EXTENSIONS = new Set([".pdf"]);
export const WORD_EXTENSIONS = new Set([".docx"]);
export const SHEET_EXTENSIONS = new Set([".xlsx", ".xls", ".csv"]);
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"]);

export function titleFromPath(path: string): string {
  const ext = extname(path);
  return basename(path, ext);
}

export function looksLikeUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function inferExtension(pathOrUrl: string): string {
  try {
    const url = new URL(pathOrUrl);
    return extname(url.pathname).toLowerCase();
  } catch {
    return extname(pathOrUrl).toLowerCase();
  }
}

export function markdownTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").trim();
}

export function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  });
  turndown.keep(["table", "thead", "tbody", "tr", "th", "td"]);
  return turndown.turndown(html);
}

export function isProbablyPlainUrl(text: string): boolean {
  const trimmed = text.trim();
  return looksLikeUrl(trimmed) && !/\s/.test(trimmed);
}

export function mimeFromExtension(ext: string): string {
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "application/octet-stream";
}
