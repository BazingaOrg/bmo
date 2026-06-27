<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import CaptureWindow from "./components/CaptureWindow.vue";
import MainWindow from "./components/MainWindow.vue";

const windowLabel = ref("main");

onMounted(async () => {
  const current = getCurrentWindow();
  windowLabel.value = current.label;
});
</script>

<template>
  <CaptureWindow v-if="windowLabel === 'capture'" />
  <MainWindow v-else />
</template>
