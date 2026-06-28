import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { ParseError, assertNonEmptyMarkdown, type ParsedDoc } from "./types.js";
import { htmlToMarkdown, markdownTitle } from "./utils.js";

const FETCH_TIMEOUT_MS = Number(process.env.BMO_URL_FETCH_TIMEOUT_MS ?? 15_000);

export async function parseUrl(url: string, title?: string): Promise<ParsedDoc> {
  const normalizedUrl = normalizeUrl(url);
  try {
    const html = await fetchHtml(normalizedUrl);
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    const content = article?.content ?? document.querySelector("main")?.innerHTML ?? document.body?.innerHTML ?? "";
    const articleTitle = title ?? article?.title?.trim() ?? document.querySelector("title")?.textContent?.trim() ?? normalizedUrl;
    const markdown = assertNonEmptyMarkdown(`# ${markdownTitle(articleTitle)}\n\n${htmlToMarkdown(content)}`, "url-empty");
    return {
      title: articleTitle,
      markdown,
      sourceType: "url",
      sourceUrl: normalizedUrl,
      metadata: {
        byline: article?.byline ?? undefined,
        siteName: article?.siteName ?? undefined,
        excerpt: article?.excerpt ?? undefined,
        publishedTime: article?.publishedTime ?? undefined,
      },
    };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("url-parse-failed", `网页解析失败：${errorMessage(error)}`, { cause: error });
  }
}

function normalizeUrl(input: string): string {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ParseError("url-invalid", "只支持 http/https 网页链接");
    }
    return url.toString();
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("url-invalid", "这不是一个有效的网页链接", { cause: error });
  }
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "BMO/0.1 (+https://local.bmo)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) throw new ParseError("url-blocked", `网页抓取失败：HTTP ${res.status}，可能被登录或反爬限制`);
    if (!res.ok) throw new ParseError("url-fetch-failed", `网页抓取失败：HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("html") && !contentType.includes("text/plain")) {
      throw new ParseError("url-not-html", `链接返回的不是网页内容：${contentType}`);
    }
    return await res.text();
  } catch (error) {
    if (error instanceof ParseError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ParseError("url-timeout", "网页抓取超时，请稍后再试或改用文件投喂", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
