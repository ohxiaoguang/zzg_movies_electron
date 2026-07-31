<script setup lang="ts">
import { ref } from 'vue';
import { Refresh, Star } from '@element-plus/icons-vue';
import type { CustomCategoryDto, FilmDetailDto } from '../../../shared/contracts';

export interface SelectedCategoryItem {
  key: string;
  id: string | null;
  name: string;
}

withDefaults(defineProps<{
  detail: FilmDetailDto;
  poster: string | null;
  favorite: boolean;
  categories: SelectedCategoryItem[];
  categoryOptions: CustomCategoryDto[];
  saveState: string;
  saveStateLabel: string;
  rescanBusy: boolean;
  showCategories?: boolean;
}>(), { showCategories: true });

const emit = defineEmits<{
  favoriteChange: [value: boolean];
  categoryAdd: [value: string];
  categoryRemove: [item: SelectedCategoryItem];
  retry: [];
  play: [];
  localPlayer: [];
  showFolder: [];
  rescan: [];
}>();

const pickerValue = ref('');
function picked(value: string | undefined): void {
  const normalized = value?.trim() ?? '';
  pickerValue.value = '';
  if (normalized) emit('categoryAdd', normalized);
}
</script>

<template>
  <header class="detail-sticky-header">
    <div class="header-poster"><img v-if="poster" :src="poster" alt="" /><div v-else>{{ detail.title.slice(0, 1) }}</div></div>
    <div class="header-content">
      <div class="header-title-row">
        <div class="header-title"><div class="eyebrow">FILM PROFILE</div><h2>{{ detail.title }}</h2><p>{{ detail.originalTitle || '暂无原标题' }} · {{ detail.year || '年份未知' }}</p><small>{{ detail.sourceName }} · 可用文件 {{ detail.existingFileCount }}/{{ detail.totalFileCount }}</small></div>
        <button type="button" class="favorite-control" :class="{ active: favorite }" :aria-pressed="favorite" @click="emit('favoriteChange', !favorite)"><Star />{{ favorite ? '已收藏' : '收藏' }}</button>
      </div>
      <div class="header-actions"><el-button type="primary" size="small" @click="emit('play')">播放原片</el-button><el-button size="small" @click="emit('localPlayer')">使用本地播放器播放</el-button><el-button size="small" @click="emit('showFolder')">打开目录</el-button><el-button size="small" :loading="rescanBusy" @click="emit('rescan')"><Refresh />重新扫描目录</el-button></div>
      <div v-if="showCategories" class="category-editor">
        <div class="category-label"><span>我的分类</span><span v-if="saveStateLabel" :class="['save-state', `save-${saveState}`]">{{ saveStateLabel }}<el-button v-if="saveState === 'error'" text type="danger" size="small" @click="emit('retry')">重试</el-button></span></div>
        <div class="selected-categories"><el-tag v-for="item in categories" :key="item.key" closable @close="emit('categoryRemove', item)">{{ item.name }}</el-tag><span v-if="!categories.length" class="muted">尚未分类</span></div>
        <el-select v-model="pickerValue" class="category-picker" filterable allow-create default-first-option clearable placeholder="搜索或输入新分类" @change="picked"><el-option v-for="category in categoryOptions" :key="category.id" :label="category.name" :value="category.id" /></el-select>
      </div>
      <div v-if="detail.availability !== 'available'" class="availability-warning">{{ detail.availability === 'partial_missing' ? `部分文件缺失 ${detail.existingFileCount}/${detail.totalFileCount}` : detail.availability === 'source_offline' ? '来源当前离线' : detail.availability === 'source_removed' ? '来源已删除' : '原始影片不可用' }}</div>
    </div>
  </header>
</template>

<style scoped>
.detail-sticky-header { position: relative; z-index: 6; display: flex; min-width: 0; padding: 8px 2px; flex: 0 0 auto; flex-direction: column; overflow: visible; background: #171b24; }
.header-poster { display: grid; width: min(100%, 220px); max-height: 34vh; aspect-ratio: 2 / 3; margin: 0 auto 12px; flex: 0 1 auto; overflow: hidden; place-items: center; border-radius: 10px; color: #95a0b3; background: #252b38; box-shadow: 0 12px 28px rgba(0,0,0,.25); font-size: 30px; font-weight: 800; }.header-poster img { width: 100%; height: 100%; object-fit: cover; }
.header-content { display: flex; min-width: 0; flex-direction: column; }.header-title-row { display: grid; min-width: 0; gap: 8px; }.header-title { min-width: 0; }.header-title h2 { margin: 2px 0 4px; overflow-wrap: anywhere; font-size: 19px; line-height: 1.2; }.header-title p, .header-title small { display: block; margin: 0; overflow: hidden; color: var(--muted); font-size: 10px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.favorite-control { display: inline-flex; width: 100%; padding: 8px 11px; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: #232936; cursor: pointer; }.favorite-control svg { width: 15px; }.favorite-control.active { border-color: rgba(255,217,139,.48); color: #ffe1a1; background: rgba(73,53,18,.55); }
.header-actions { display: grid; grid-template-columns: 1fr; gap: 6px; margin-top: 8px; }.header-actions :deep(.el-button) { width: 100%; margin: 0; }.header-actions :deep(.el-button svg) { width: 14px; margin-right: 4px; }.category-editor { min-height: 0; margin-top: 12px; }.category-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; color: var(--ink); font-size: 11px; font-weight: 700; }.selected-categories { display: flex; min-width: 0; max-height: 72px; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; overflow: auto; }.selected-categories :deep(.el-tag) { max-width: 100%; }.category-picker { width: 100%; }.save-state { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 500; }.save-saving { color: var(--muted); }.save-dirty { color: var(--warm); }.save-saved { color: var(--accent); }.save-error { color: #ff9b9b; }.availability-warning { margin-top: 8px; color: #ffb18f; font-size: 10px; }.muted { color: var(--muted); font-size: 10px; }
@media (max-width: 760px) { .detail-sticky-header { height: auto; padding-right: 2px; overflow: visible; border-bottom: 1px solid var(--line); }.header-poster { width: 120px; max-height: none; }.header-title-row { grid-template-columns: minmax(0, 1fr) auto; }.favorite-control { width: auto; }.header-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }.selected-categories { max-height: none; overflow: visible; } }
</style>
