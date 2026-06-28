import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import OpenAI from "openai";
import { ParseError, assertNonEmptyMarkdown, type ParsedDoc } from "./types.js";
import { mimeFromExtension, titleFromPath } from "./utils.js";

const MAX_IMAGE_BYTES = Number(process.env.BMO_VISION_MAX_IMAGE_BYTES ?? 8 * 1024 * 1024);

export async function parseImage(path: string, title?: string): Promise<ParsedDoc> {
  const model = process.env.BMO_VISION_MODEL;
  if (!model) throw new ParseError("vision-model-missing", "缺少 BMO_VISION_MODEL，无法把截图转成 Markdown");

  try {
    const info = await stat(path);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new ParseError("vision-image-too-large", `图片过大（${Math.round(info.size / 1024 / 1024)}MB），请先压缩后再投喂`);
    }

    const data = await readFile(path);
    const mime = mimeFromExtension(extname(path).toLowerCase());
    const client = new OpenAI({
      baseURL: process.env.BMO_VISION_BASE_URL ?? process.env.BMO_CHAT_BASE_URL,
      apiKey: process.env.BMO_VISION_API_KEY ?? process.env.BMO_CHAT_API_KEY,
    });
    const res = await client.chat.completions.create({
      model,
      temperature: Number(process.env.BMO_VISION_TEMPERATURE ?? 0.2),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "请把这张截图中的文字、表格、图表和关键视觉结构转写成干净的 Markdown。保留层级、列表、表格和可读的图表说明，只输出 Markdown。",
            },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${data.toString("base64")}` },
            },
          ],
        },
      ],
    });
    const markdown = assertNonEmptyMarkdown(res.choices[0]?.message.content ?? "", "vision-empty");
    return {
      title: title ?? titleFromPath(path),
      markdown,
      sourceType: "image",
      rawPath: path,
      metadata: { model },
    };
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("vision-parse-failed", `图片视觉转写失败：${errorMessage(error)}`, { cause: error });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
