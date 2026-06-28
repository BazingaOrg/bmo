import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import * as XLSX from "xlsx";
import { ParseError, assertNonEmptyMarkdown, type ParsedDoc } from "./types.js";
import { titleFromPath } from "./utils.js";

const MAX_ROWS = Number(process.env.BMO_SHEET_MAX_ROWS ?? 200);
const MAX_COLS = Number(process.env.BMO_SHEET_MAX_COLS ?? 30);

export async function parseSheet(path: string, title?: string): Promise<ParsedDoc> {
  try {
    // CSV 必须按 UTF-8 文本解码,否则 SheetJS 用默认 codepage 会把中文读成乱码;
    // .xlsx 内部是 UTF-8 XML,走 buffer 即可。
    const workbook =
      extname(path).toLowerCase() === ".csv"
        ? XLSX.read(await readFile(path, "utf-8"), { type: "string" })
        : XLSX.read(await readFile(path), { type: "buffer" });
    const sections = workbook.SheetNames.map((sheetName) => sheetToMarkdown(sheetName, workbook.Sheets[sheetName])).filter(Boolean);
    const markdown = assertNonEmptyMarkdown(sections.join("\n\n"), "sheet-empty");
    return {
      title: title ?? titleFromPath(path),
      markdown,
      sourceType: "xlsx",
      rawPath: path,
      metadata: { sheets: workbook.SheetNames },
    };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("sheet-parse-failed", `表格解析失败：${errorMessage(error)}`, { cause: error });
  }
}

function sheetToMarkdown(sheetName: string, worksheet: XLSX.WorkSheet | undefined): string {
  if (!worksheet) return "";
  const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, blankrows: false, defval: "" });
  if (rows.length === 0) return "";

  const width = Math.min(
    MAX_COLS,
    Math.max(...rows.map((row) => row.length), 1)
  );
  const limitedRows = rows.slice(0, MAX_ROWS + 1);
  const tableRows = limitedRows.map((row) => Array.from({ length: width }, (_, index) => formatCell(row[index])));
  const [first, ...rest] = tableRows;
  const header = first.map((cell, index) => cell || `Column ${index + 1}`);
  const body = rest.length > 0 ? rest : [Array.from({ length: width }, () => "")];
  const truncated = rows.length > limitedRows.length || Math.max(...rows.map((row) => row.length)) > width;

  return [
    `## ${sheetName}`,
    "",
    markdownTable([header, ...body]),
    truncated ? `\n> 表格较大，仅展示前 ${Math.min(rows.length, MAX_ROWS + 1)} 行、前 ${width} 列。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function markdownTable(rows: string[][]): string {
  const [header, ...body] = rows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function formatCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
