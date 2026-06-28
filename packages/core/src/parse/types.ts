import type { EatInput } from "../ingest/index.js";

export type SourceType = EatInput["sourceType"];

export interface ParsedDoc {
  title: string;
  markdown: string;
  sourceType: SourceType;
  sourceUrl?: string;
  rawPath?: string;
  metadata?: Record<string, unknown>;
}

export type ParseSource =
  | { kind: "text"; text: string; title?: string }
  | { kind: "file"; path: string; title?: string }
  | { kind: "url"; url: string; title?: string };

export class ParseError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ParseError";
    this.code = code;
  }
}

export function isParseError(error: unknown): error is ParseError {
  return error instanceof ParseError;
}

export function assertNonEmptyMarkdown(markdown: string, code = "empty-content"): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) throw new ParseError(code, "解析结果为空，没东西可吃");
  return normalized;
}
