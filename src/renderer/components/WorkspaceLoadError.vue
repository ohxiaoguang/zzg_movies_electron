<script setup lang="ts">
function reload(): void { window.location.reload(); }
</script>
<template>
  <main class="workspace-status" role="alert">
    <p>影片库加载失败，请重新加载。</p>
    <button type="button" @click="reload">重新加载</button>
  </main>
</template>
<style scoped>
.workspace-status { min-height: 100vh; display: grid; place-content: center; }
</style>
