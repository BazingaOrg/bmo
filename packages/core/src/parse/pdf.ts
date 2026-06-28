import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { ParseError, assertNonEmptyMarkdown, type ParsedDoc } from "./types.js";
import { markdownTitle, titleFromPath } from "./utils.js";

export async function parsePdf(path: string, title?: string): Promise<ParsedDoc> {
  try {
    const data = new Uint8Array(await readFile(path));
    const pdf = await getDocumentProxy(data);
    const [{ totalPages, text }, meta] = await Promise.all([
      extractText(pdf, { mergePages: false }),
      getMeta(pdf).catch(() => null),
    ]);

    const pages = text
      .map((page, index) => formatPdfPage(page, index + 1))
      .filter((page) => page.trim().length > 0);
    if (pages.length === 0) {
      throw new ParseError("pdf-no-text", "这个 PDF 像是扫描件或纯图片，Phase 2 暂不做 OCR，请等 Phase 3 Vision OCR");
    }

    const pdfTitle = title ?? extractPdfTitle(meta) ?? titleFromPath(path);
    return {
      title: pdfTitle,
      markdown: assertNonEmptyMarkdown(`# ${markdownTitle(pdfTitle)}\n\n${pages.join("\n\n")}`),
      sourceType: "pdf",
      rawPath: path,
      metadata: { pages: totalPages },
    };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    const message = errorMessage(error);
    if (/password|encrypted/i.test(message)) {
      throw new ParseError("pdf-encrypted", "这个 PDF 需要密码或已加密，Phase 2 暂不支持加密 PDF", { cause: error });
    }
    throw new ParseError("pdf-parse-failed", `PDF 解析失败：${message}`, { cause: error });
  }
}

function formatPdfPage(page: string, pageNumber: number): string {
  const normalized = page
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n\n");
  return normalized ? `## Page ${pageNumber}\n\n${normalized}` : "";
}

function extractPdfTitle(meta: Awaited<ReturnType<typeof getMeta>> | null): string | undefined {
  const title = meta?.info?.Title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
