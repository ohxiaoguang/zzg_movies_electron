<script setup lang="ts">
import { ref, watch } from 'vue';
import { FolderOpened, MoreFilled, Picture, Refresh, Star, VideoPlay } from '@element-plus/icons-vue';
import type { CustomCategoryDto, FilmDetailDto } from '../../../shared/contracts';

export interface SelectedCategoryItem {
  key: string;
  id: string | null;
  name: string;
}

const props = withDefaults(defineProps<{
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
  editCover: [];
}>();

const pickerValue = ref('');
const posterFailed = ref(false);
watch(() => props.poster, () => { posterFailed.value = false; });
function picked(value: string | undefined): void {
  const normalized = value?.trim() ?? '';
  pickerValue.value = '';
  if (normalized) emit('categoryAdd', normalized);
}
</script>

<template>
  <header class="detail-sticky-header">
    <button type="button" class="header-poster" aria-label="设置封面 / GIF" title="设置封面 / GIF" @click="emit('editCover')">
      <img v-if="poster && !posterFailed" :src="poster" :alt="`${detail.title}封面`" @error="posterFailed = true" />
      <span v-else class="poster-placeholder">{{ detail.title.slice(0, 1) }}</span>
      <span class="poster-edit-hint"><Picture />封面 / GIF</span>
    </button>
    <div class="header-content">
      <div class="header-title-row">
        <div class="header-title"><h2 :title="detail.title">{{ detail.title }}</h2><p :title="detail.originalTitle || ''">{{ detail.originalTitle || '暂无原标题' }} · {{ detail.year || '年份未知' }}</p><small>{{ detail.sourceName }} · 可用文件 {{ detail.existingFileCount }}/{{ detail.totalFileCount }}</small></div>
      </div>
      <div class="header-primary-actions">
        <button type="button" class="sidebar-button primary-play" @click="emit('play')"><VideoPlay />播放原片</button>
        <button type="button" class="sidebar-button favorite-control" :class="{ active: favorite }" :aria-pressed="favorite" @click="emit('favoriteChange', !favorite)"><Star />{{ favorite ? '已收藏' : '收藏' }}</button>
      </div>
      <div class="header-actions">
        <button type="button" class="sidebar-button" title="使用本地播放器播放" @click="emit('localPlayer')"><VideoPlay />本地播放</button>
        <button type="button" class="sidebar-button" @click="emit('showFolder')"><FolderOpened />打开目录</button>
      </div>
      <div v-if="showCategories" class="category-editor">
        <div class="category-label"><span>我的分类</span><el-dropdown trigger="click" @command="emit('rescan')"><button type="button" class="sidebar-more" aria-label="更多影片操作" :disabled="rescanBusy"><MoreFilled /><span>{{ rescanBusy ? '扫描中…' : '更多' }}</span></button><template #dropdown><el-dropdown-menu><el-dropdown-item command="rescan" :disabled="rescanBusy"><Refresh />重新扫描目录</el-dropdown-item></el-dropdown-menu></template></el-dropdown><span v-if="saveStateLabel" :class="['save-state', `save-${saveState}`]">{{ saveStateLabel }}<el-button v-if="saveState === 'error'" text type="danger" size="small" @click="emit('retry')">重试</el-button></span></div>
        <div class="selected-categories"><el-tag v-for="item in categories" :key="item.key" closable @close="emit('categoryRemove', item)">{{ item.name }}</el-tag><span v-if="!categories.length" class="muted">尚未分类</span></div>
        <el-select v-model="pickerValue" class="category-picker" filterable allow-create default-first-option clearable placeholder="搜索或输入新分类" @change="picked"><el-option v-for="category in categoryOptions" :key="category.id" :label="category.name" :value="category.id" /></el-select>
      </div>
      <div v-if="detail.availability !== 'available'" class="availability-warning">{{ detail.availability === 'partial_missing' ? `部分文件缺失 ${detail.existingFileCount}/${detail.totalFileCount}` : detail.availability === 'source_offline' ? '来源当前离线' : detail.availability === 'source_removed' ? '来源已删除' : '原始影片不可用' }}</div>
    </div>
  </header>
</template>

<style scoped>
.detail-sticky-header { position: relative; z-index: 6; display: flex; min-width: 0; padding: 2px 0 12px; flex: 0 0 auto; flex-direction: column; overflow: visible; background: transparent; }
.header-poster { position: relative; display: grid; width: 100%; max-height: 32vh; aspect-ratio: 16 / 9; margin: 0 0 14px; padding: 0; flex: 0 0 auto; overflow: hidden; place-items: center; border: 1px solid var(--line); border-radius: 10px; color: #95a0b3; background: #10131b; box-shadow: 0 8px 24px rgba(0,0,0,.2); cursor: pointer; }
.header-poster img { width: 100%; height: 100%; object-fit: contain; }
.poster-placeholder { font-size: 36px; font-weight: 800; }
.poster-edit-hint { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; color: #fff; background: rgba(0,0,0,.6); font-size: 11px; }
.poster-edit-hint svg { width: 14px; height: 14px; }
.header-poster:hover, .header-poster:focus-visible { border-color: var(--accent); }
.header-poster:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.header-content { display: flex; min-width: 0; flex-direction: column; }
.header-title-row, .header-title { min-width: 0; }
.header-title h2 { display: -webkit-box; margin: 0 0 7px; overflow: hidden; overflow-wrap: anywhere; -webkit-line-clamp: 3; -webkit-box-orient: vertical; font-size: 17px; line-height: 1.35; }
.header-title p, .header-title small { display: block; margin: 0; overflow: hidden; color: var(--muted); font-size: 11px; line-height: 1.6; text-overflow: ellipsis; white-space: nowrap; }
.header-primary-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-top: 14px; }
.header-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
.sidebar-button { display: inline-flex; min-width: 0; height: 34px; padding: 0 12px; align-items: center; justify-content: center; gap: 6px; border: 1px solid rgba(255,255,255,.13); border-radius: 7px; color: var(--ink); background: var(--panel-raised); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.sidebar-button svg { width: 15px; height: 15px; flex: 0 0 auto; }
.sidebar-button:hover { border-color: var(--accent); color: var(--accent); }
.sidebar-button:focus-visible, .sidebar-more:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.primary-play { border-color: var(--accent-strong); color: #10251c; background: var(--accent-strong); font-weight: 650; }
.primary-play:hover { color: #10251c; background: var(--accent); }
.favorite-control.active { border-color: rgba(255,217,139,.48); color: #ffe1a1; background: rgba(73,53,18,.35); }
.category-editor { min-height: 0; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.category-label { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: var(--ink); font-size: 12px; font-weight: 650; }
.category-label :deep(.el-dropdown) { margin-left: auto; }
.sidebar-more { display: inline-flex; align-items: center; gap: 4px; padding: 3px 0 3px 6px; border: 0; border-radius: 4px; color: var(--muted); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.sidebar-more svg { width: 14px; height: 14px; }.sidebar-more:hover { color: var(--accent); }.sidebar-more:disabled { opacity: .5; cursor: wait; }
.selected-categories { display: flex; min-width: 0; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; overflow: visible; }
.selected-categories :deep(.el-tag) { max-width: 100%; }.category-picker { width: 100%; }
.category-picker :deep(.el-select__wrapper) { min-height: 34px; border-radius: 7px; }
.save-state { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 500; }.save-saving { color: var(--muted); }.save-dirty { color: var(--warm); }.save-saved { color: var(--accent); }.save-error { color: #ff9b9b; }.availability-warning { margin-top: 8px; color: #ffb18f; font-size: 11px; }.muted { color: var(--muted); font-size: 11px; }
@media (max-width: 760px) { .detail-sticky-header { height: auto; overflow: visible; }.header-poster { max-width: 440px; max-height: none; margin-inline: auto; }.selected-categories { max-height: none; overflow: visible; } }
</style>
