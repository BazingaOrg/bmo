import { invoke } from "@tauri-apps/api/core";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type EatResult = {
  documentId: string;
  chunkCount: number;
  title: string;
};

export type SearchHit = {
  chunkRowid: number;
  documentId: string;
  chunkSeq: number;
  text: string;
  documentTitle: string;
  sourceType: string;
  sourceUrl: string | null;
  similarity: number | null;
  score: number;
};

export type ProvenancePayload = {
  searched: boolean;
  totalHits: number;
  hits: SearchHit[];
};

export type DocumentDetail = {
  id: string;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  rawPath: string | null;
  markdown: string;
  createdAt: number;
  chunkCount: number;
  chunks: { rowid: number; seq: number; text: string }[];
};

export type RuntimeSettings = {
  similarityThreshold: number;
  recallK: number;
  rrfK: number;
  chunkMaxChars: number;
  chunkOverlap: number;
  envPath: string;
};

export type SettingsPatch = {
  BMO_SIMILARITY_THRESHOLD?: number;
  BMO_RECALL_K?: number;
  BMO_RRF_K?: number;
  BMO_CHUNK_MAX_CHARS?: number;
  BMO_CHUNK_OVERLAP?: number;
};

export type ChatStreamHandlers = {
  onText: (delta: string) => void;
  onTool: (payload: { name: string; input: unknown }) => void;
  onProvenance: (payload: ProvenancePayload) => void;
  onError: (message: string) => void;
  onDone: () => void;
};

type ServerCredentials = {
  url: string;
  token: string;
};

export type DesktopStatus = {
  shortcutError: string | null;
};

let cachedServerCredentials: ServerCredentials | null = null;

export async function getServerUrl(): Promise<string> {
  return (await getServerCredentials()).url;
}

export async function getDesktopStatus(): Promise<DesktopStatus> {
  return invoke<DesktopStatus>("desktop_status");
}

async function getServerCredentials(): Promise<ServerCredentials> {
  if (cachedServerCredentials) return cachedServerCredentials;

  for (let i = 0; i < 120; i++) {
    const credentials = await invoke<ServerCredentials | null>("server_credentials");
    if (credentials && (await isServerHealthy(credentials))) {
      cachedServerCredentials = credentials;
      return credentials;
    }
    await sleep(250);
  }

  throw new Error("BMO sidecar 还没有启动完成");
}

export async function eatText(text: string, title?: string): Promise<EatResult> {
  const server = await getServerCredentials();
  const res = await fetch(`${server.url}/eat`, {
    method: "POST",
    headers: authHeaders(server),
    body: JSON.stringify({ text, title }),
  });
  return readJsonResponse<EatResult>(res);
}

export async function eatUrl(sourceUrl: string, title?: string): Promise<EatResult> {
  const server = await getServerCredentials();
  const res = await fetch(`${server.url}/eat`, {
    method: "POST",
    headers: authHeaders(server),
    body: JSON.stringify({ sourceUrl, title }),
  });
  return readJsonResponse<EatResult>(res);
}

export async function eatFile(rawPath: string): Promise<EatResult> {
  const server = await getServerCredentials();
  const res = await fetch(`${server.url}/eat`, {
    method: "POST",
    headers: authHeaders(server),
    body: JSON.stringify({ rawPath }),
  });
  return readJsonResponse<EatResult>(res);
}

export async function getDocument(id: string): Promise<DocumentDetail> {
  const server = await getServerCredentials();
  const res = await fetch(`${server.url}/documents/${encodeURIComponent(id)}`, {
    headers: authHeaders(server),
  });
  const body = await readJsonResponse<{ document: DocumentDetail }>(res);
  return body.document;
}

export async function getSettings(): Promise<RuntimeSettings> {
  const server = await getServerCredentials();
  const res = await fetch(`${server.url}/settings`, {
    headers: authHeaders(server),
  });
  const body = await readJsonResponse<{ settings: RuntimeSettings }>(res);
  return body.settings;
}

export async function updateSettings(patch: SettingsPatch): Promise<RuntimeSettings> {
  const server = await getServerCredentials();
  const res = await fetch(`${server.url}/settings`, {
    method: "PATCH",
    headers: authHeaders(server),
    body: JSON.stringify(patch),
  });
  const body = await readJsonResponse<{ settings: RuntimeSettings }>(res);
  return body.settings;
}

export async function streamChat(messages: ChatMessage[], handlers: ChatStreamHandlers): Promise<void> {
  const server = await getServerCredentials();
  const res = await fetch(`${server.url}/chat`, {
    method: "POST",
    headers: authHeaders(server),
    body: JSON.stringify({ messages }),
  });

  if (!res.ok || !res.body) {
    throw new Error(await res.text());
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatchSseFrame(frame, handlers);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export async function showCaptureWindow(): Promise<void> {
  await invoke("show_capture");
}

export async function hideCurrentWindow(): Promise<void> {
  await invoke("hide_current_window");
}

export async function showMainWindow(): Promise<void> {
  await invoke("show_main");
}

export async function captureScreenshot(): Promise<string> {
  return invoke<string>("capture_screenshot");
}

function dispatchSseFrame(frame: string, handlers: ChatStreamHandlers): void {
  const event = frame
    .split("\n")
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim();
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");

  if (!event) return;

  if (event === "text") handlers.onText(JSON.parse(data).delta ?? "");
  if (event === "tool") handlers.onTool(JSON.parse(data));
  if (event === "provenance") handlers.onProvenance(JSON.parse(data));
  if (event === "error") handlers.onError(JSON.parse(data).message ?? "聊天流出错");
  if (event === "done") handlers.onDone();
}

function authHeaders(server: ServerCredentials): HeadersInit {
  return {
    Authorization: `Bearer ${server.token}`,
    "Content-Type": "application/json",
  };
}

async function isServerHealthy(server: ServerCredentials): Promise<boolean> {
  try {
    const res = await fetch(`${server.url}/health`, {
      headers: authHeaders(server),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function readJsonResponse<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? body.message ?? "请求失败");
  return body as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
