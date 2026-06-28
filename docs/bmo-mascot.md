# `<Bmo>` 吉祥物组件 · 纯 SVG + 表情动画

> Phase 4 Milestone A 的核心交付:一个**原创**的小机器角色组件,替换全项目的 lucide `Bot` 占位。
> 一个 `<Bmo :mood :size>` 搞定侧栏头像、对话头像、空状态、浮窗、加载态。

> ⚠️ **原创声明**:这是我们自己设计的"圆角掌机 + 屏幕脸 + 小天线 + 短脚"角色,取"会吃纸片的方脸小机器"
> 这股气质,**不复刻任何现有商标角色**的具体造型。配色复用项目的 `--bmo-*` token(有 fallback)。

---

## 1. 角色解剖

```
        ·         ← 小天线(yellow 点)
   ╭─────────╮
   │ ┌─────┐ │
   │ │ ● ● │ │    ← 屏幕脸:点状眼睛
   │ │  ◡  │ │    ← 嘴(idle 微笑 / eating 张开 / happy 大笑)
   │ └─────┘ │ ◦  ← 侧边按钮(yellow/red 设备细节)
   ╰─────────╯ ◦
     ▭     ▭       ← 两只短脚
```

**5 个表情(mood)**:`idle`(眨眼+轻浮动)/ `eating`(张嘴咀嚼+纸片送入)/ `thinking`(眼睛左右扫)/ `happy`(弯眼大笑+小跳)/ `sleepy`(半闭眼+Zzz)。

---

## 2. 组件代码 `packages/desktop/src/components/Bmo.vue`

```vue
<script setup lang="ts">
export type BmoMood = "idle" | "eating" | "thinking" | "happy" | "sleepy";
withDefaults(defineProps<{ mood?: BmoMood; size?: number }>(), { mood: "idle", size: 96 });
</script>

<template>
  <svg
    :width="size"
    :height="size * 1.25"
    viewBox="0 0 120 150"
    :class="['bmo', `bmo--${mood}`]"
    role="img"
    aria-label="BMO"
  >
    <!-- 天线 -->
    <line class="bmo-antenna" x1="60" y1="6" x2="60" y2="14" />
    <circle class="bmo-antenna-tip" cx="60" cy="5" r="3.5" />

    <!-- 脚 -->
    <rect class="bmo-foot" x="34" y="126" width="18" height="15" rx="7" />
    <rect class="bmo-foot" x="68" y="126" width="18" height="15" rx="7" />

    <!-- 身体(会随 mood 浮动/跳) -->
    <g class="bmo-body-group">
      <rect class="bmo-body" x="14" y="12" width="92" height="118" rx="28" />

      <!-- 侧边按钮(设备细节) -->
      <circle class="bmo-btn bmo-btn--y" cx="100" cy="58" r="4" />
      <circle class="bmo-btn bmo-btn--r" cx="100" cy="72" r="4" />

      <!-- 屏幕脸 -->
      <rect class="bmo-screen" x="28" y="30" width="64" height="56" rx="16" />

      <!-- 腮红 -->
      <ellipse class="bmo-cheek" cx="40" cy="66" rx="4" ry="2.4" />
      <ellipse class="bmo-cheek" cx="80" cy="66" rx="4" ry="2.4" />

      <!-- 默认眼睛(点) -->
      <circle class="bmo-eye bmo-eye--l" cx="47" cy="54" r="6.5" />
      <circle class="bmo-eye bmo-eye--r" cx="73" cy="54" r="6.5" />

      <!-- happy 弯眼(默认隐藏) -->
      <path class="bmo-eye-happy" d="M40 56 Q47 48 54 56" />
      <path class="bmo-eye-happy" d="M66 56 Q73 48 80 56" />

      <!-- 嘴:idle 扁椭圆 / eating 撑开 -->
      <ellipse class="bmo-mouth" cx="60" cy="71" rx="9" ry="2.6" />
      <!-- happy 大笑(默认隐藏) -->
      <path class="bmo-smile" d="M49 69 Q60 80 71 69" />

      <!-- eating 纸片(默认隐藏) -->
      <rect class="bmo-paper" x="54" y="92" width="12" height="11" rx="2" />

      <!-- sleepy 的 Zzz(默认隐藏) -->
      <g class="bmo-zzz">
        <text x="92" y="36" class="bmo-z bmo-z--1">z</text>
        <text x="99" y="28" class="bmo-z bmo-z--2">z</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.bmo {
  --c-body: var(--bmo-teal, #63c5b5);
  --c-screen: #0e3d39;
  --c-face: #8ff0dc;
  --c-foot: #3a9e8f;
  --c-yellow: var(--bmo-yellow, #f5c84c);
  --c-red: var(--bmo-red, #e4504b);
  display: block;
  overflow: visible;
}

.bmo-antenna { stroke: var(--c-foot); stroke-width: 3; stroke-linecap: round; }
.bmo-antenna-tip { fill: var(--c-yellow); }
.bmo-body { fill: var(--c-body); }
.bmo-foot { fill: var(--c-foot); }
.bmo-screen { fill: var(--c-screen); }
.bmo-btn--y { fill: var(--c-yellow); }
.bmo-btn--r { fill: var(--c-red); }
.bmo-cheek { fill: var(--c-red); opacity: 0.35; }
.bmo-eye { fill: var(--c-face); transform-box: fill-box; transform-origin: center; }
.bmo-eye-happy { fill: none; stroke: var(--c-face); stroke-width: 4; stroke-linecap: round; opacity: 0; }
.bmo-mouth { fill: var(--c-face); transform-box: fill-box; transform-origin: center; }
.bmo-smile { fill: none; stroke: var(--c-face); stroke-width: 4; stroke-linecap: round; opacity: 0; }
.bmo-paper { fill: var(--bmo-cream, #fdf6e3); stroke: var(--c-foot); stroke-width: 1; opacity: 0; }
.bmo-zzz { opacity: 0; }
.bmo-z { fill: var(--c-face); font: 600 13px/1 ui-sans-serif, sans-serif; }
.bmo-z--2 { font-size: 10px; }

/* ── idle:轻浮动 + 眨眼 ── */
.bmo--idle .bmo-body-group { animation: bmo-bob 3.6s ease-in-out infinite; }
.bmo--idle .bmo-eye { animation: bmo-blink 4.2s infinite; }

/* ── eating:咀嚼 + 纸片送入 ── */
.bmo--eating .bmo-mouth { animation: bmo-chew 0.42s ease-in-out infinite; }
.bmo--eating .bmo-paper { animation: bmo-feed 0.9s ease-in infinite; }
.bmo--eating .bmo-body-group { animation: bmo-bob 0.9s ease-in-out infinite; }

/* ── thinking:眼睛左右扫 ── */
.bmo--thinking .bmo-eye { animation: bmo-scan 1.3s ease-in-out infinite; }

/* ── happy:弯眼 + 大笑 + 小跳 ── */
.bmo--happy .bmo-eye { opacity: 0; }
.bmo--happy .bmo-eye-happy { opacity: 1; }
.bmo--happy .bmo-mouth { opacity: 0; }
.bmo--happy .bmo-smile { opacity: 1; }
.bmo--happy .bmo-body-group { animation: bmo-hop 0.7s ease-in-out infinite; }

/* ── sleepy:半闭眼 + Zzz ── */
.bmo--sleepy .bmo-eye { transform: scaleY(0.16); }
.bmo--sleepy .bmo-mouth { ry: 1.5; }
.bmo--sleepy .bmo-zzz { opacity: 1; animation: bmo-float 2.4s ease-in-out infinite; }
.bmo--sleepy .bmo-body-group { animation: bmo-bob 5s ease-in-out infinite; }

@keyframes bmo-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes bmo-hop { 0%, 100% { transform: translateY(0); } 35% { transform: translateY(-7px); } 70% { transform: translateY(0); } }
@keyframes bmo-blink { 0%, 90%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
@keyframes bmo-chew { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(3); } }
@keyframes bmo-scan { 0%, 100% { transform: translateX(-3px); } 50% { transform: translateX(3px); } }
@keyframes bmo-feed {
  0% { opacity: 0; transform: translateY(22px); }
  30% { opacity: 1; }
  100% { opacity: 0; transform: translateY(-20px); }
}
@keyframes bmo-float { 0%, 100% { transform: translateY(0); opacity: 0.4; } 50% { transform: translateY(-4px); opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .bmo *, .bmo .bmo-body-group { animation: none !important; }
}
</style>
```

---

## 3. 接入方式

### 替换所有 `Bot` 占位
```vue
<!-- 旧 --> <Bot :size="22" />
<!-- 新 --> <Bmo :size="40" :mood="bmoMood" />
```
侧栏头像、对话 assistant 头像、空状态、浮窗左侧统统换成 `<Bmo>`。

### mood 由应用状态驱动
| 场景 | mood |
|---|---|
| 投喂中(浮窗 `status==='eating'`) | `eating` |
| 完成投喂 / 查到库内(`provenance.totalHits>0`) | `happy` |
| 检索 / 联网中(`toolQuery` 有值 / `chat.busy`) | `thinking` |
| 空闲 | `idle` |
| 久未操作(可选,计时器) | `sleepy` |

示例(对话头像):
```ts
const bmoMood = computed<BmoMood>(() =>
  chat.busy ? "thinking" : lastAnswerHadHits.value ? "happy" : "idle"
);
```

### tray 菜单栏图标
菜单栏图标尺寸小(~22px),用**简化版**:只画屏幕脸 + 两个点眼(去掉脚/天线/按钮),导出成 PNG/ICNS 给 Tauri tray;或单独做一个 `BmoGlyph.vue` 精简版。

### reduced-motion
组件内已带 `@media (prefers-reduced-motion: reduce)` 兜底:动画全停,角色静止在当前表情,不闪。

---

## 4. 验收

- [ ] `<Bmo>` 渲染出"圆角掌机 + 屏幕脸"的小机器,5 个 mood 都有可见区别
- [ ] 投喂时张嘴咀嚼 + 纸片送入;检索时眼睛扫;查到时弯眼大笑小跳;空闲眨眼浮动
- [ ] 全项目 `Bot` 占位清零,tray 也换成像素脸
- [ ] 深浅色下都好看(配色走 `--bmo-*` token)
- [ ] `prefers-reduced-motion` 下不闪、静止可读
