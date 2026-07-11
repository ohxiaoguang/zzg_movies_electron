<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { CollectionTag, Refresh } from '@element-plus/icons-vue';
import type { TagDto } from '../../shared/contracts';

const tags = ref<TagDto[]>([]);
const loading = ref(false);
async function load(): Promise<void> { loading.value = true; const result = await window.filmLibrary.tags.list(); if (result.ok) tags.value = result.data; loading.value = false; }
onMounted(() => void load());
</script>

<template>
  <div class="page-wrap"><div class="page-heading"><div><div class="eyebrow">TAXONOMY</div><h1 class="page-title">标签管理</h1><p class="page-caption">标签来自 NFO 导入或影片详情中的手动编辑。</p></div><el-button :loading="loading" @click="load"><Refresh />刷新</el-button></div><div v-if="tags.length" class="tag-cloud"><div v-for="tag in tags" :key="tag.id" class="tag-card"><div class="tag-icon"><CollectionTag /></div><div><strong>{{ tag.name }}</strong><span>{{ tag.filmCount }} 部影片</span></div></div></div><div v-else class="empty-state"><div><CollectionTag :size="38" /><p>扫描影片后，NFO 中的 tag 会显示在这里。</p></div></div></div>
</template>

<style scoped>
.page-heading > .el-button svg { width: 15px; margin-right: 5px; }.tag-cloud { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 13px; }.tag-card { display: flex; align-items: center; gap: 12px; padding: 17px; border: 1px solid var(--line); border-radius: 13px; background: rgba(21,24,33,.8); }.tag-icon { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 9px; color: var(--accent); background: rgba(152,227,194,.1); }.tag-card strong, .tag-card span { display: block; }.tag-card strong { font-size: 13px; }.tag-card span { margin-top: 4px; color: var(--muted); font-size: 11px; }
</style>
