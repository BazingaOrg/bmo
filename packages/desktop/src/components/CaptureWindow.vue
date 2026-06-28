<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Bot, ClipboardPaste, FileText, Image, Loader2, Send, X } from "lucide-vue-next";
import { captureScreenshot, eatFile, eatText, eatUrl, hideCurrentWindow, showMainWindow } from "../api";

const text = ref("");
const status = ref<"idle" | "eating" | "done" | "error">("idle");
const feedback = ref("粘贴文字、URL、文件，或截一张图");
const input = ref<HTMLTextAreaElement | null>(null);

const canSubmit = computed(() => text.value.trim().length > 0 && status.value !== "eating");

onMounted(async () => {
  input.value?.focus();
  await getCurrentWindow().onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    const [path] = event.payload.paths;
    if (path) await eatPath(path);
  });
});

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  const value = text.value.trim();
  await runEat(async () => (isPlainUrl(value) ? eatUrl(value) : eatText(text.value)), "咔嚓，已吞下这段内容");
  text.value = "";
}

async function pasteAndSubmit(): Promise<void> {
  if (status.value === "eating") return;
  await runEat(async () => {
    const clipboardText = (await readText()).trim();
    if (!clipboardText) throw new Error("剪贴板里没有可投喂的文字");
    text.value = clipboardText;
    return isPlainUrl(clipboardText) ? eatUrl(clipboardText) : eatText(clipboardText, "剪贴板");
  }, "咔嚓，已吞下剪贴板内容");
  text.value = "";
}

async function eatPath(path: string): Promise<void> {
  await runEat(async () => eatFile(path), "咔嚓，文件已吞下");
}

async function screenshot(): Promise<void> {
  await runEat(async () => {
    const path = await captureScreenshot();
    return eatFile(path);
  }, "截图已转写并吞下");
}

async function runEat(action: () => Promise<{ chunkCount: number }>, doneText: string): Promise<void> {
  status.value = "eating";
  feedback.value = "咀嚼中...";
  try {
    const result = await action();
    status.value = "done";
    feedback.value = `${doneText}，切成 ${result.chunkCount} 块`;
    await notifyEaten(feedback.value);
    window.setTimeout(() => {
      void hideCurrentWindow();
      status.value = "idle";
      feedback.value = "粘贴文字、URL、文件，或截一张图";
    }, 900);
  } catch (error) {
    status.value = "error";
    feedback.value = error instanceof Error ? error.message : String(error);
    window.setTimeout(() => input.value?.focus(), 50);
  }
}

function isPlainUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && !/\s/.test(value.trim());
  } catch {
    return false;
  }
}

async function notifyEaten(body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: "BMO 已吞下", body });
  } catch {
    /* 浮窗内反馈已足够，系统通知失败不阻断投喂 */
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    void hideCurrentWindow();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    void submit();
  }
}
</script>

<template>
  <main class="grid min-h-screen place-items-center bg-transparent p-5" @keydown="onKeydown">
    <section class="capture-shell">
      <div class="flex items-center gap-3">
        <div class="grid h-11 w-11 shrink-0 place-items-center rounded-bmo bg-[var(--bmo-deep)] text-[var(--bmo-cream)]">
          <Bot :size="24" />
        </div>
        <textarea
          ref="input"
          v-model="text"
          class="capture-input"
          placeholder="丢给 BMO..."
          rows="2"
          @keydown="onKeydown"
          @paste="feedback = '已接住剪贴板内容'"
        />
        <button class="icon-button" type="button" aria-label="关闭" @click="hideCurrentWindow">
          <X :size="18" />
        </button>
      </div>

      <div class="mt-4 flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-2 text-sm text-[var(--bmo-muted)]">
          <Loader2 v-if="status === 'eating'" :size="15" class="animate-spin" />
          <ClipboardPaste v-else-if="status === 'idle'" :size="15" />
          <Bot v-else :size="15" />
          <span class="truncate">{{ feedback }}</span>
        </div>

        <div class="flex shrink-0 items-center gap-2">
          <button class="capture-tool" type="button" :disabled="status === 'eating'" @click="showMainWindow">
            <Bot :size="15" />
            主窗口
          </button>
          <button class="capture-tool" type="button" :disabled="status === 'eating'" @click="pasteAndSubmit">
            <ClipboardPaste :size="15" />
            剪贴板
          </button>
          <button class="capture-tool" type="button" :disabled="status === 'eating'" @click="screenshot">
            <Image :size="15" />
            截图
          </button>
          <button class="capture-tool" type="button" :disabled="status === 'eating'" @click="feedback = '支持 PDF、Word、表格、Markdown、图片'">
            <FileText :size="15" />
            文件
          </button>
          <button class="bmo-button" type="button" :disabled="!canSubmit" aria-label="投喂" @click="submit">
            <Send :size="16" />
          </button>
        </div>
      </div>
    </section>
  </main>
</template>
