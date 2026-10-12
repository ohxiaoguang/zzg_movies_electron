<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { FilmDetailDto } from '../../../shared/contracts';
import { mediaUrl } from '../../api';
const props = defineProps<{ modelValue: boolean; film: FilmDetailDto }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; change: [detail: FilmDetailDto] }>();
const busy = ref(false);
const images = computed(() => props.film.images.filter((image) => !image.missing));
async function choose(assetId: string | null): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const response = await window.filmLibrary.films.setCover(props.film.id, assetId);
    if (!response.ok) { ElMessage.error(response.error.message); return; }
    emit('change', response.data);
    ElMessage.success(assetId ? '影片封面已更新' : '已恢复默认封面');
    emit('update:modelValue', false);
  } catch { ElMessage.error('封面保存失败，请重试'); }
  finally { busy.value = false; }
}
async function importImage(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    const response = await window.filmLibrary.films.importCover(props.film.id);
    if (!response.ok) { ElMessage.error(response.error.message); return; }
    if (!response.data) return;
    emit('change', response.data);
    ElMessage.success('图片已复制到影片同级目录，并设为封面');
    emit('update:modelValue', false);
  } catch { ElMessage.error('图片导入失败，请重试'); }
  finally { busy.value = false; }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue" title="设置影片封面" width="min(760px, 94vw)" append-to-body
    :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy"
    @update:model-value="emit('update:modelValue', $event)">
    <p class="cover-help">选择已有图片或截取的 GIF 作为封面。导入本地图片会复制到影片同级目录，保留原文件。</p>
    <div class="cover-grid">
      <button v-for="image in images" :key="image.id" type="button" :disabled="busy" :class="{ selected: image.id === film.posterAssetId }" @click="choose(image.id)">
        <img :src="mediaUrl('asset', image.id)" alt="候选封面" loading="lazy" />
        <span>{{ image.relativePath.split(/[\\/]/).pop() }}</span>
        <small v-if="image.customCover">自定义封面</small>
      </button>
    </div>
    <p v-if="!images.length" class="cover-help">暂无已有图片，可以导入本地图片，或在播放器中截取 GIF。</p>
    <template #footer>
      <el-button :disabled="busy" @click="choose(null)">恢复默认封面</el-button>
      <el-button type="primary" :loading="busy" @click="importImage">选择本地图片 / GIF</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.cover-help { color: var(--subtle); font-size: 12px; }
.cover-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; max-height: 55vh; overflow: auto; }
.cover-grid button { display: grid; gap: 6px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); cursor: pointer; text-align: left; }
.cover-grid button:hover, .cover-grid button.selected { border-color: var(--accent); }
.cover-grid img { width: 100%; height: 120px; object-fit: contain; background: #090b0f; }
.cover-grid span { font-size: 11px; overflow-wrap: anywhere; }
.cover-grid small { color: var(--accent); }
</style>
