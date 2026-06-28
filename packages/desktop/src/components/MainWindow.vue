<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { Bot, Brain, ChevronRight, Loader2, MessageCircle, Save, Search, Send, SlidersHorizontal, Sparkles, X } from "lucide-vue-next";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  getDesktopStatus,
  generateDigest,
  getDocument,
  getDigests,
  getServerUrl,
  getSettings,
  showCaptureWindow,
  updateSettings,
  type DocumentDetail,
  type DigestPayload,
  type RuntimeSettings,
  type SearchHit,
  type WebSource,
} from "../api";
import { useChatStore, type UiMessage } from "../stores/chat";

const chat = useChatStore();
const draft = ref("");
const ready = ref(false);
const startupError = ref<string | null>(null);
const shortcutError = ref<string | null>(null);
const selectedHit = ref<SearchHit | null>(null);
const selectedDocument = ref<DocumentDetail | null>(null);
const sourceError = ref<string | null>(null);
const sourceLoading = ref(false);
const settingsOpen = ref(false);
const settingsBusy = ref(false);
const settingsFeedback = ref<string | null>(null);
const settingsDraft = ref<RuntimeSettings | null>(null);
const activeTab = ref<"chat" | "growth">("chat");
const digestPayload = ref<DigestPayload | null>(null);
const digestBusy = ref(false);
const digestError = ref<string | null>(null);
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
    await loadDigests();
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
  if (provenance.webSearched && provenance.totalHits > 0) return { label: `📚+🌐 库内 ${provenance.totalHits} · 联网`, tone: "bg-[#63C5B5]/25 text-[#0F5C55]", icon: Brain };
  if (provenance.webSearched) return { label: "🌐 联网", tone: "bg-[#63C5B5]/20 text-[#0F5C55]", icon: Search };
  if (!provenance.searched) return { label: "💭 通用知识", tone: "bg-[var(--bmo-surface)] text-[var(--bmo-muted)]", icon: Brain };
  if (provenance.totalHits === 0) return { label: "🔍 查了没命中", tone: "bg-[#F5C84C]/25 text-[#6A4B00]", icon: Search };
  return { label: `📚 基于你的库 · ${provenance.totalHits} 条`, tone: "bg-[#63C5B5]/25 text-[#0F5C55]", icon: Brain };
}

function sourceHits(message: UiMessage): SearchHit[] {
  const hits = message.provenance?.hits ?? [];
  const referenced = hits.filter((hit) => message.content.includes(`【来源：${hit.documentTitle}】`));
  return referenced.length > 0 ? referenced : hits;
}

function webSources(message: UiMessage): WebSource[] {
  return message.provenance?.webSources ?? [];
}

const sourceHighlightParts = computed(() => {
  if (!selectedHit.value || !selectedDocument.value) return [{ text: "", highlighted: false }];
  return splitForHighlight(selectedDocument.value.markdown, selectedHit.value.text);
});

async function openSource(hit: SearchHit): Promise<void> {
  selectedHit.value = hit;
  selectedDocument.value = null;
  sourceError.value = null;
  sourceLoading.value = true;
  try {
    selectedDocument.value = await getDocument(hit.documentId);
  } catch (error) {
    sourceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    sourceLoading.value = false;
  }
}

async function openSettings(): Promise<void> {
  settingsOpen.value = true;
  settingsFeedback.value = null;
  settingsBusy.value = true;
  try {
    settingsDraft.value = await getSettings();
  } catch (error) {
    settingsFeedback.value = error instanceof Error ? error.message : String(error);
  } finally {
    settingsBusy.value = false;
  }
}

async function saveSettings(): Promise<void> {
  if (!settingsDraft.value) return;
  settingsBusy.value = true;
  settingsFeedback.value = null;
  try {
    settingsDraft.value = await updateSettings({
      BMO_SIMILARITY_THRESHOLD: settingsDraft.value.similarityThreshold,
      BMO_RECALL_K: settingsDraft.value.recallK,
      BMO_RRF_K: settingsDraft.value.rrfK,
      BMO_CHUNK_MAX_CHARS: settingsDraft.value.chunkMaxChars,
      BMO_CHUNK_OVERLAP: settingsDraft.value.chunkOverlap,
    });
    settingsFeedback.value = "已保存";
  } catch (error) {
    settingsFeedback.value = error instanceof Error ? error.message : String(error);
  } finally {
    settingsBusy.value = false;
  }
}

async function loadDigests(): Promise<void> {
  digestBusy.value = true;
  digestError.value = null;
  try {
    digestPayload.value = await getDigests();
  } catch (error) {
    digestError.value = error instanceof Error ? error.message : String(error);
  } finally {
    digestBusy.value = false;
  }
}

async function refreshDigest(): Promise<void> {
  digestBusy.value = true;
  digestError.value = null;
  try {
    digestPayload.value = await generateDigest();
  } catch (error) {
    digestError.value = error instanceof Error ? error.message : String(error);
  } finally {
    digestBusy.value = false;
  }
}

function selectDigest(id: string): void {
  const digest = digestPayload.value?.digests.find((item) => item.id === id);
  if (digest && digestPayload.value) digestPayload.value.latest = digest;
}

function splitForHighlight(markdown: string, chunk: string): { text: string; highlighted: boolean }[] {
  const exact = markdown.indexOf(chunk);
  if (exact >= 0) return splitAt(markdown, exact, chunk.length);

  const normalizedChunk = chunk.trim();
  const candidates = [
    normalizedChunk,
    normalizedChunk.slice(Math.max(0, normalizedChunk.length - 800)),
    normalizedChunk.slice(0, 800),
  ].filter((candidate) => candidate.length >= 80);

  for (const candidate of candidates) {
    const index = markdown.indexOf(candidate);
    if (index >= 0) return splitAt(markdown, index, candidate.length);
  }
  return [{ text: markdown, highlighted: false }];
}

function splitAt(text: string, start: number, length: number): { text: string; highlighted: boolean }[] {
  return [
    { text: text.slice(0, start), highlighted: false },
    { text: text.slice(start, start + length), highlighted: true },
    { text: text.slice(start + length), highlighted: false },
  ].filter((part) => part.text.length > 0);
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
            <button :class="['nav-item', activeTab === 'chat' && 'nav-item-active']" type="button" @click="activeTab = 'chat'">
              <MessageCircle :size="17" />
              对话
            </button>
            <button class="nav-item" type="button" disabled>
              <Sparkles :size="17" />
              食谱
            </button>
            <button :class="['nav-item', activeTab === 'growth' && 'nav-item-active']" type="button" @click="activeTab = 'growth'; loadDigests()">
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

      <section v-if="activeTab === 'chat'" class="flex min-w-0 flex-col">
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
          <button class="icon-button" type="button" aria-label="检索设置" @click="openSettings">
            <SlidersHorizontal :size="18" />
          </button>
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
                    @click="openSource(hit)"
                  >
                    {{ hit.documentTitle }}
                    <span v-if="hit.similarity != null">{{ hit.similarity.toFixed(2) }}</span>
                    <ChevronRight :size="13" />
                  </button>
                  <a
                    v-for="source in webSources(message)"
                    :key="source.url"
                    class="source-chip"
                    :href="source.url"
                    target="_blank"
                    rel="noreferrer"
                  >
                    🌐 {{ source.title }}
                    <ChevronRight :size="13" />
                  </a>
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

      <section v-else class="flex min-w-0 flex-col">
        <header class="flex h-16 shrink-0 items-center justify-between border-b border-[rgba(15,92,85,0.12)] px-6">
          <div>
            <h1 class="text-[20px] font-semibold leading-none">成长</h1>
            <p class="mt-1 text-sm text-[var(--bmo-muted)]">本周消化报告和知识库体检。</p>
          </div>
          <button class="bmo-button" type="button" :disabled="digestBusy" @click="refreshDigest">
            <Loader2 v-if="digestBusy" :size="15" class="animate-spin" />
            <Sparkles v-else :size="15" />
            生成周报
          </button>
        </header>

        <div class="flex-1 overflow-y-auto px-6 py-6">
          <div v-if="digestError" class="mx-auto mb-4 max-w-4xl rounded-bmo bg-[rgba(228,80,75,0.12)] px-4 py-3 text-sm text-[var(--bmo-red)] shadow-soft">
            {{ digestError }}
          </div>
          <div class="mx-auto grid max-w-5xl gap-5">
            <div class="grid grid-cols-3 gap-4">
              <div class="rounded-bmo bg-[var(--bmo-surface)] p-4 shadow-soft">
                <p class="text-xs text-[var(--bmo-muted)]">文档</p>
                <p class="mt-2 text-2xl font-semibold">{{ digestPayload?.stats.documentCount ?? 0 }}</p>
              </div>
              <div class="rounded-bmo bg-[var(--bmo-surface)] p-4 shadow-soft">
                <p class="text-xs text-[var(--bmo-muted)]">知识块</p>
                <p class="mt-2 text-2xl font-semibold">{{ digestPayload?.stats.chunkCount ?? 0 }}</p>
              </div>
              <div class="rounded-bmo bg-[var(--bmo-surface)] p-4 shadow-soft">
                <p class="text-xs text-[var(--bmo-muted)]">周报</p>
                <p class="mt-2 text-2xl font-semibold">{{ digestPayload?.digests.length ?? 0 }}</p>
              </div>
            </div>

            <article class="rounded-bmo bg-[var(--bmo-surface)] p-5 shadow-soft">
              <div class="flex items-center justify-between gap-3">
                <h2 class="text-lg font-semibold">最新周报</h2>
                <span v-if="digestPayload?.latest" class="font-mono text-xs text-[var(--bmo-muted)]">
                  {{ new Date(digestPayload.latest.periodStart).toLocaleDateString() }} - {{ new Date(digestPayload.latest.periodEnd).toLocaleDateString() }}
                </span>
              </div>
              <div v-if="digestBusy && !digestPayload" class="mt-5 flex items-center gap-2 text-sm text-[var(--bmo-muted)]">
                <Loader2 :size="15" class="animate-spin" />
                读取中...
              </div>
              <div v-else-if="digestPayload?.latest" class="prose-bmo mt-4" v-html="renderMarkdown(digestPayload.latest.markdown)" />
              <p v-else class="mt-4 text-sm text-[var(--bmo-muted)]">还没有周报。</p>
            </article>

            <article class="rounded-bmo bg-[var(--bmo-surface)] p-5 shadow-soft">
              <h2 class="text-lg font-semibold">历史周报</h2>
              <div class="mt-4 grid gap-2">
                <button
                  v-for="digest in digestPayload?.digests ?? []"
                  :key="digest.id"
                  class="flex items-center justify-between rounded-bmo bg-[rgba(15,92,85,0.06)] px-3 py-2 text-left text-sm"
                  type="button"
                  @click="selectDigest(digest.id)"
                >
                  <span>{{ new Date(digest.periodStart).toLocaleDateString() }} - {{ new Date(digest.periodEnd).toLocaleDateString() }}</span>
                  <span class="text-[var(--bmo-muted)]">{{ digest.stats.chunkCount }} 块</span>
                </button>
                <p v-if="!digestPayload?.digests.length" class="text-sm text-[var(--bmo-muted)]">暂无历史周报。</p>
              </div>
            </article>
          </div>
        </div>
      </section>
    </div>

    <div v-if="selectedHit" class="source-panel" role="dialog" aria-label="来源卡片">
      <button class="source-panel-backdrop" type="button" aria-label="关闭来源卡片" @click="selectedHit = null" />
      <aside class="source-panel-card">
        <p class="font-mono text-[11px] uppercase text-[var(--bmo-muted)]">source document</p>
        <h2 class="mt-1 text-xl font-semibold">{{ selectedHit.documentTitle }}</h2>
        <p class="mt-2 text-sm text-[var(--bmo-muted)]">
          {{ selectedHit.sourceType }}
          <span v-if="selectedHit.similarity != null"> · 相似度 {{ selectedHit.similarity.toFixed(2) }}</span>
        </p>
        <a
          v-if="selectedHit.sourceUrl"
          class="mt-2 block truncate text-sm text-[var(--bmo-deep)] underline"
          :href="selectedHit.sourceUrl"
          target="_blank"
          rel="noreferrer"
        >
          {{ selectedHit.sourceUrl }}
        </a>

        <div v-if="sourceLoading" class="mt-5 flex items-center gap-2 text-sm text-[var(--bmo-muted)]">
          <Loader2 :size="15" class="animate-spin" />
          正在打开原文...
        </div>
        <div v-else-if="sourceError" class="mt-5 rounded-bmo bg-[rgba(228,80,75,0.12)] p-3 text-sm text-[var(--bmo-red)]">
          {{ sourceError }}
        </div>
        <div v-else-if="selectedDocument" class="mt-5">
          <div class="rounded-bmo bg-[var(--bmo-canvas)] p-4 font-mono text-xs leading-6 text-[var(--bmo-ink)] whitespace-pre-wrap">
            <template v-for="(part, index) in sourceHighlightParts" :key="index">
              <mark v-if="part.highlighted" class="rounded bg-[#F5C84C]/55 px-1 text-[var(--bmo-ink)]">{{ part.text }}</mark>
              <span v-else>{{ part.text }}</span>
            </template>
          </div>
          <div class="mt-4 rounded-bmo border border-[rgba(15,92,85,0.12)] p-4">
            <p class="font-mono text-[11px] uppercase text-[var(--bmo-muted)]">matched chunk</p>
            <p class="mt-2 whitespace-pre-wrap text-sm leading-7 text-[var(--bmo-ink)]">{{ selectedHit.text }}</p>
          </div>
        </div>
      </aside>
    </div>

    <div v-if="settingsOpen" class="source-panel" role="dialog" aria-label="检索设置">
      <button class="source-panel-backdrop" type="button" aria-label="关闭检索设置" @click="settingsOpen = false" />
      <aside class="source-panel-card">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="font-mono text-[11px] uppercase text-[var(--bmo-muted)]">retrieval settings</p>
            <h2 class="mt-1 text-xl font-semibold">检索参数</h2>
          </div>
          <button class="icon-button" type="button" aria-label="关闭" @click="settingsOpen = false">
            <X :size="18" />
          </button>
        </div>

        <div v-if="settingsBusy && !settingsDraft" class="mt-5 flex items-center gap-2 text-sm text-[var(--bmo-muted)]">
          <Loader2 :size="15" class="animate-spin" />
          读取中...
        </div>
        <form v-else-if="settingsDraft" class="mt-5 space-y-4" @submit.prevent="saveSettings">
          <label class="settings-field">
            <span>相似度阈值</span>
            <input v-model.number="settingsDraft.similarityThreshold" min="0" max="1" step="0.01" type="number" />
          </label>
          <label class="settings-field">
            <span>每路召回数</span>
            <input v-model.number="settingsDraft.recallK" min="1" step="1" type="number" />
          </label>
          <label class="settings-field">
            <span>RRF K</span>
            <input v-model.number="settingsDraft.rrfK" min="1" step="1" type="number" />
          </label>
          <label class="settings-field">
            <span>Chunk max chars</span>
            <input v-model.number="settingsDraft.chunkMaxChars" min="1" step="50" type="number" />
          </label>
          <label class="settings-field">
            <span>Chunk overlap</span>
            <input v-model.number="settingsDraft.chunkOverlap" min="0" step="10" type="number" />
          </label>
          <p class="truncate text-xs text-[var(--bmo-muted)]">{{ settingsDraft.envPath }}</p>
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm text-[var(--bmo-muted)]">{{ settingsFeedback }}</span>
            <button class="bmo-button" type="submit" :disabled="settingsBusy">
              <Loader2 v-if="settingsBusy" :size="15" class="animate-spin" />
              <Save v-else :size="15" />
              保存
            </button>
          </div>
        </form>
        <div v-else-if="settingsFeedback" class="mt-5 rounded-bmo bg-[rgba(228,80,75,0.12)] p-3 text-sm text-[var(--bmo-red)]">
          {{ settingsFeedback }}
        </div>
      </aside>
    </div>
  </main>
</template>
