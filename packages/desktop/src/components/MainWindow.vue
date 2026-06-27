<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Bot, Brain, ChevronRight, Loader2, MessageCircle, Search, Send, Sparkles } from "lucide-vue-next";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { getDesktopStatus, getServerUrl, showCaptureWindow, type SearchHit } from "../api";
import { useChatStore, type UiMessage } from "../stores/chat";

const chat = useChatStore();
const draft = ref("");
const ready = ref(false);
const startupError = ref<string | null>(null);
const shortcutError = ref<string | null>(null);
const selectedHit = ref<SearchHit | null>(null);
const scrollArea = ref<HTMLElement | null>(null);

const subtitle = computed(() => (ready.value ? "sidecar ready" : "BMO 启动中"));

onMounted(async () => {
  try {
    shortcutError.value = (await getDesktopStatus()).shortcutError;
  } catch {
    shortcutError.value = null;
  }

  try {
    await getServerUrl();
    ready.value = true;
  } catch (error) {
    startupError.value = error instanceof Error ? error.message : String(error);
  }
});

watch(
  () => chat.messages.map((message) => message.content).join("|"),
  async () => {
    await nextTick();
    scrollArea.value?.scrollTo({ top: scrollArea.value.scrollHeight, behavior: "smooth" });
  }
);

async function submit(): Promise<void> {
  const content = draft.value;
  draft.value = "";
  await chat.send(content);
}

function renderMarkdown(content: string): string {
  const html = marked.parse(content || "", { async: false }) as string;
  return DOMPurify.sanitize(html);
}

function badge(message: UiMessage): { label: string; tone: string; icon: typeof Brain } {
  const provenance = message.provenance;
  if (!provenance) return { label: "生成中", tone: "bg-[#F5C84C]/25 text-[#6A4B00]", icon: Loader2 };
  if (!provenance.searched) return { label: "💭 通用知识", tone: "bg-[var(--bmo-surface)] text-[var(--bmo-muted)]", icon: Brain };
  if (provenance.totalHits === 0) return { label: "🔍 查了没命中", tone: "bg-[#F5C84C]/25 text-[#6A4B00]", icon: Search };
  return { label: `📚 基于你的库 · ${provenance.totalHits} 条`, tone: "bg-[#63C5B5]/25 text-[#0F5C55]", icon: Brain };
}

function sourceHits(message: UiMessage): SearchHit[] {
  const hits = message.provenance?.hits ?? [];
  const referenced = hits.filter((hit) => message.content.includes(`【来源：${hit.documentTitle}】`));
  return referenced.length > 0 ? referenced : hits;
}
</script>

<template>
  <main class="min-h-screen bg-[var(--bmo-canvas)] text-[var(--bmo-ink)]">
    <div class="grid h-screen grid-cols-[236px_1fr]">
      <aside class="flex flex-col justify-between bg-[var(--bmo-sidebar)] px-4 py-5 shadow-soft">
        <div>
          <div class="flex items-center gap-3">
            <div class="grid h-10 w-10 place-items-center rounded-bmo bg-[var(--bmo-deep)] text-[var(--bmo-cream)]">
              <Bot :size="22" />
            </div>
            <div>
              <p class="text-[18px] font-semibold leading-tight">BMO</p>
              <p class="font-mono text-[11px] uppercase tracking-normal text-[var(--bmo-muted)]">{{ subtitle }}</p>
            </div>
          </div>

          <nav class="mt-8 space-y-1">
            <button class="nav-item nav-item-active" type="button">
              <MessageCircle :size="17" />
              对话
            </button>
            <button class="nav-item" type="button" disabled>
              <Sparkles :size="17" />
              食谱
            </button>
            <button class="nav-item" type="button" disabled>
              <Brain :size="17" />
              成长
            </button>
          </nav>
        </div>

        <button class="bmo-button-secondary" type="button" @click="showCaptureWindow">
          <Sparkles :size="16" />
          喂点东西
        </button>
      </aside>

      <section class="flex min-w-0 flex-col">
        <header class="flex h-16 shrink-0 items-center justify-between border-b border-[rgba(15,92,85,0.12)] px-6">
          <div>
            <h1 class="text-[20px] font-semibold leading-none">和记忆聊天</h1>
            <p class="mt-1 text-sm text-[var(--bmo-muted)]">引用库内内容时会显示来源，没查库也会明说。</p>
          </div>
          <div class="legend">
            <span><i class="bg-[#63C5B5]" />库内</span>
            <span><i class="bg-white" />通用</span>
            <span><i class="bg-[#F5C84C]" />未命中</span>
          </div>
        </header>

        <div ref="scrollArea" class="flex-1 overflow-y-auto px-6 py-6">
          <div v-if="startupError || chat.error" class="mx-auto mb-4 max-w-3xl rounded-bmo bg-[rgba(228,80,75,0.12)] px-4 py-3 text-sm text-[var(--bmo-red)] shadow-soft">
            {{ startupError || chat.error }}
          </div>
          <div v-if="shortcutError" class="mx-auto mb-4 max-w-3xl rounded-bmo bg-[#F5C84C]/20 px-4 py-3 text-sm text-[#6A4B00] shadow-soft">
            {{ shortcutError }}。可以先从菜单栏打开投喂窗口。
          </div>

          <div v-if="chat.messages.length === 0" class="empty-state">
            <div class="grid h-12 w-12 place-items-center rounded-bmo-lg bg-[var(--bmo-deep)] text-[var(--bmo-cream)] shadow-lift">
              <Bot :size="26" />
            </div>
            <h2>我还很饿，喂我点东西吧</h2>
            <p>按 ⌘⇧M 投喂文字或文件，然后在这里问我你收藏过的内容。</p>
          </div>

          <div v-else class="mx-auto flex max-w-3xl flex-col gap-5">
            <article v-for="message in chat.messages" :key="message.id" :class="['message-row', message.role]">
              <div v-if="message.role === 'assistant'" class="assistant-avatar"><Bot :size="17" /></div>
              <div class="message-bubble">
                <div v-if="message.toolQuery" class="tool-line">
                  <Loader2 :size="14" class="animate-spin" />
                  ⚙ 翻找记忆：{{ message.toolQuery }}
                </div>
                <div class="prose-bmo" v-html="renderMarkdown(message.content || (message.status === 'streaming' ? '...' : ''))" />
                <div v-if="message.role === 'assistant'" class="mt-3 flex flex-wrap items-center gap-2">
                  <span :class="['source-badge', badge(message).tone]">
                    <component :is="badge(message).icon" :size="13" :class="{ 'animate-spin': badge(message).label === '生成中' }" />
                    {{ badge(message).label }}
                  </span>
                  <button
                    v-for="hit in sourceHits(message)"
                    :key="hit.chunkRowid"
                    class="source-chip"
                    type="button"
                    @click="selectedHit = hit"
                  >
                    {{ hit.documentTitle }}
                    <span v-if="hit.similarity != null">{{ hit.similarity.toFixed(2) }}</span>
                    <ChevronRight :size="13" />
                  </button>
                </div>
              </div>
            </article>
          </div>
        </div>

        <form class="composer" @submit.prevent="submit">
          <input
            v-model="draft"
            :disabled="chat.busy || !ready"
            autocomplete="off"
            placeholder="问 BMO 一个问题..."
            class="composer-input"
          />
          <button class="bmo-button" type="submit" :disabled="chat.busy || !draft.trim() || !ready" aria-label="发送">
            <Send :size="17" />
          </button>
        </form>
      </section>
    </div>

    <div v-if="selectedHit" class="source-panel" role="dialog" aria-label="来源卡片">
      <button class="source-panel-backdrop" type="button" aria-label="关闭来源卡片" @click="selectedHit = null" />
      <aside class="source-panel-card">
        <p class="font-mono text-[11px] uppercase text-[var(--bmo-muted)]">source chunk</p>
        <h2 class="mt-1 text-xl font-semibold">{{ selectedHit.documentTitle }}</h2>
        <p class="mt-2 text-sm text-[var(--bmo-muted)]">
          {{ selectedHit.sourceType }}
          <span v-if="selectedHit.similarity != null"> · 相似度 {{ selectedHit.similarity.toFixed(2) }}</span>
        </p>
        <div class="mt-5 rounded-bmo bg-[var(--bmo-canvas)] p-4 text-sm leading-7 text-[var(--bmo-ink)]">
          {{ selectedHit.text }}
        </div>
      </aside>
    </div>
  </main>
</template>
