<script setup lang="ts">
import { ref } from 'vue';
import { Refresh, Star } from '@element-plus/icons-vue';
import type { CustomCategoryDto, FilmDetailDto } from '../../../shared/contracts';

export interface SelectedCategoryItem {
  key: string;
  id: string | null;
  name: string;
}

defineProps<{
  detail: FilmDetailDto;
  poster: string | null;
  favorite: boolean;
  categories: SelectedCategoryItem[];
  categoryOptions: CustomCategoryDto[];
  saveState: string;
  saveStateLabel: string;
  rescanBusy: boolean;
}>();

const emit = defineEmits<{
  favoriteChange: [value: boolean];
  categoryAdd: [value: string];
  categoryRemove: [item: SelectedCategoryItem];
  retry: [];
  play: [];
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
      <div class="header-actions"><el-button type="primary" size="small" @click="emit('play')">{{ detail.parts.length > 1 ? '选择分段播放' : '播放原片' }}</el-button><el-button size="small" @click="emit('showFolder')">打开目录</el-button><el-button size="small" :loading="rescanBusy" @click="emit('rescan')"><Refresh />重新扫描目录</el-button></div>
      <div class="category-editor">
        <div class="category-label"><span>我的分类</span><span v-if="saveStateLabel" :class="['save-state', `save-${saveState}`]">{{ saveStateLabel }}<el-button v-if="saveState === 'error'" text type="danger" size="small" @click="emit('retry')">重试</el-button></span></div>
        <div class="selected-categories"><el-tag v-for="item in categories" :key="item.key" closable @close="emit('categoryRemove', item)">{{ item.name }}</el-tag><span v-if="!categories.length" class="muted">尚未分类</span></div>
        <el-select v-model="pickerValue" class="category-picker" filterable allow-create default-first-option clearable placeholder="搜索或输入新分类" @change="picked"><el-option v-for="category in categoryOptions" :key="category.id" :label="category.name" :value="category.id" /></el-select>
      </div>
      <div v-if="detail.availability !== 'available'" class="availability-warning">{{ detail.availability === 'partial_missing' ? `部分文件缺失 ${detail.existingFileCount}/${detail.totalFileCount}` : detail.availability === 'source_offline' ? '来源当前离线' : detail.availability === 'source_removed' ? '来源已删除' : '原始影片不可用' }}</div>
    </div>
  </header>
</template>

<style scoped>
.detail-sticky-header { position: sticky; top: 0; z-index: 6; display: flex; gap: 16px; min-width: 0; padding: 14px 4px 16px; border-bottom: 1px solid var(--line); background: #171b24; box-shadow: 0 10px 20px rgba(10,12,17,.18); }
.header-poster { width: 88px; height: 132px; display: grid; flex: 0 0 auto; overflow: hidden; place-items: center; border-radius: 9px; color: #95a0b3; background: #252b38; font-size: 30px; font-weight: 800; }.header-poster img { width: 100%; height: 100%; object-fit: cover; }
.header-content { min-width: 0; flex: 1; }.header-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }.header-title { min-width: 0; }.header-title h2 { margin: 2px 0 4px; overflow-wrap: anywhere; font-size: 21px; line-height: 1.2; }.header-title p, .header-title small { display: block; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.favorite-control { display: inline-flex; min-width: 94px; padding: 8px 11px; align-items: center; justify-content: center; gap: 6px; flex: 0 0 auto; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: #232936; cursor: pointer; }.favorite-control svg { width: 15px; }.favorite-control.active { border-color: rgba(255,217,139,.48); color: #ffe1a1; background: rgba(73,53,18,.55); }
.header-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 9px; }.header-actions :deep(.el-button svg) { width: 14px; margin-right: 4px; }.category-editor { margin-top: 12px; }.category-label { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; color: var(--ink); font-size: 12px; font-weight: 700; }.selected-categories { display: flex; min-width: 0; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; overflow: hidden; }.selected-categories :deep(.el-tag) { max-width: 100%; }.category-picker { width: min(320px, 100%); }.save-state { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 500; }.save-saving { color: var(--muted); }.save-dirty { color: var(--warm); }.save-saved { color: var(--accent); }.save-error { color: #ff9b9b; }.availability-warning { margin-top: 8px; color: #ffb18f; font-size: 11px; }.muted { color: var(--muted); font-size: 11px; }
@media (max-width: 560px) { .detail-sticky-header { flex-wrap: wrap; }.header-poster { width: 68px; height: 102px; }.header-content { flex-basis: calc(100% - 84px); }.header-title-row { flex-wrap: wrap; }.favorite-control { min-width: 0; }.category-editor { margin-left: calc(-84px); }.category-picker { width: 100%; } }
</style>
