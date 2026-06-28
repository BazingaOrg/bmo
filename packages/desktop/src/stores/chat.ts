import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { streamChat, type ChatMessage, type ProvenancePayload } from "../api";

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "streaming" | "done" | "error";
  toolQuery?: string;
  provenance?: ProvenancePayload;
};

export const useChatStore = defineStore("chat", () => {
  const messages = ref<UiMessage[]>([]);
  const busy = ref(false);
  const error = ref<string | null>(null);

  const apiMessages = computed<ChatMessage[]>(() =>
    messages.value
      .filter((message) => message.content.trim())
      .map((message) => ({ role: message.role, content: message.content }))
  );

  async function send(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || busy.value) return;

    error.value = null;
    messages.value.push({ id: crypto.randomUUID(), role: "user", content: trimmed });
    messages.value.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      status: "streaming",
    });
    // 关键：拿 push 之后数组里的响应式代理来改，否则改裸对象不触发重渲染、流式失效。
    const assistant = messages.value[messages.value.length - 1];
    busy.value = true;

    try {
      await streamChat(apiMessages.value, {
        onText(delta) {
          assistant.content += delta;
        },
        onTool(payload) {
          const input = payload.input as { query?: unknown };
          const name = payload.name === "$web_search" ? "web_search" : payload.name;
          assistant.toolQuery = `${name}: ${
            typeof input.query === "string" ? input.query : JSON.stringify(payload.input)
          }`;
        },
        onProvenance(payload) {
          assistant.provenance = payload;
        },
        onError(message) {
          assistant.status = "error";
          error.value = message;
        },
        onDone() {
          assistant.status = "done";
        },
      });
    } catch (caught) {
      assistant.status = "error";
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      busy.value = false;
      if (assistant.status === "streaming") assistant.status = "done";
    }
  }

  return { messages, busy, error, send };
});
