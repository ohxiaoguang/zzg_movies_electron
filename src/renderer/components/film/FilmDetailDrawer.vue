<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { FilmDetailDto } from '../../../shared/contracts';
import type { AssetType, FilmStatus } from '../../../shared/enums';
import { mediaUrl } from '../../api';

const props = defineProps<{ modelValue: boolean; filmId: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; updated: [] }>();
const detail = ref<FilmDetailDto | null>(null);
const loading = ref(false);
const saving = ref(false);
const form = reactive<{ title: string; status: FilmStatus; favorite: boolean; rating: number; notes: string; tags: string }>({
  title: '', status: 'unorganized', favorite: false, rating: 0, notes: '', tags: '',
});

const poster = computed(() => assetOf('poster') ?? assetOf('thumb'));
const fanart = computed(() => assetOf('fanart') ?? assetOf('extra_fanart'));
const preview = computed(() => detail.value?.previewAssetId ? mediaUrl('asset', detail.value.previewAssetId) : null);

watch(() => [props.modelValue, props.filmId], () => { if (props.modelValue) void load(); }, { immediate: true });

async function load(): Promise<void> {
  if (!props.filmId) return;
  loading.value = true;
  const result = await window.filmLibrary.films.detail(props.filmId);
  if (result.ok) {
    detail.value = result.data;
    Object.assign(form, { title: result.data.title, status: result.data.status, favorite: result.data.favorite, rating: result.data.rating, notes: result.data.notes, tags: result.data.tags.join(', ') });
  } else ElMessage.error(result.error.message);
  loading.value = false;
}

async function save(): Promise<void> {
  if (!detail.value) return;
  saving.value = true;
  const result = await window.filmLibrary.films.update({ id: detail.value.id, title: form.title, status: form.status, favorite: form.favorite, rating: form.rating, notes: form.notes, tags: form.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) });
  if (result.ok) { detail.value = result.data; ElMessage.success('已保存'); emit('updated'); }
  else ElMessage.error(result.error.message);
  saving.value = false;
}

async function action(kind: 'open' | 'folder'): Promise<void> {
  if (!detail.value) return;
  const result = kind === 'open' ? await window.filmLibrary.films.open(detail.value.id) : await window.filmLibrary.films.showInFolder(detail.value.id);
  if (!result.ok) ElMessage.error(result.error.message);
}

async function importNfo(mode: 'supplement' | 'force'): Promise<void> {
  if (!detail.value) return;
  const result = await window.filmLibrary.films.importNfo(detail.value.id, mode);
  if (result.ok) { detail.value = result.data; Object.assign(form, { title: result.data.title, status: result.data.status, favorite: result.data.favorite, rating: result.data.rating, notes: result.data.notes, tags: result.data.tags.join(', ') }); emit('updated'); ElMessage.success(mode === 'force' ? '已强制导入 NFO' : '已补充空字段'); }
  else ElMessage.error(result.error.message);
}

function assetOf(type: AssetType): string | null {
  const asset = detail.value?.assets.find((item) => item.assetType === type && !item.missing);
  return asset ? mediaUrl('asset', asset.id) : null;
}

function close(): void { emit('update:modelValue', false); }
</script>

<template>
  <el-drawer :model-value="modelValue" size="560px" title="影片详情" @close="close">
    <div v-if="loading" class="detail-loading"><el-skeleton :rows="10" animated /></div>
    <template v-else-if="detail">
      <div class="detail-hero">
        <div class="detail-poster"><img v-if="poster" :src="poster" alt="" /><div v-else class="poster-placeholder">{{ detail.title.slice(0, 1) }}</div></div>
        <div class="detail-head">
          <div class="eyebrow">FILM PROFILE</div>
          <h2>{{ detail.title }}</h2>
          <div class="detail-subtitle">{{ detail.originalTitle || '暂无原始标题' }} · {{ detail.year || '年份未知' }}</div>
          <div class="detail-actions"><el-button type="primary" size="small" @click="action('open')">播放原片</el-button><el-button size="small" @click="action('folder')">打开目录</el-button></div>
          <div v-if="detail.missing" class="missing-banner">原始影片或来源当前不可用</div>
        </div>
      </div>
      <div v-if="fanart || preview" class="media-strip">
        <img v-if="fanart" :src="fanart" alt="fanart" />
        <video v-if="preview" :src="preview" controls muted playsinline preload="metadata" />
      </div>
      <section class="detail-section">
        <div class="section-heading"><span>资料与状态</span><el-button text type="primary" :loading="saving" @click="save">保存修改</el-button></div>
        <el-form label-position="top" class="detail-form">
          <el-form-item label="标题"><el-input v-model="form.title" /></el-form-item>
          <div class="form-row"><el-form-item label="状态"><el-select v-model="form.status"><el-option label="未整理" value="unorganized" /><el-option label="想看" value="want" /><el-option label="正在观看" value="watching" /><el-option label="已看" value="watched" /></el-select></el-form-item><el-form-item label="评分"><el-input-number v-model="form.rating" :min="0" :max="10" :step="0.5" /></el-form-item></div>
          <el-form-item label="收藏"><el-switch v-model="form.favorite" active-text="已收藏" /></el-form-item>
          <el-form-item label="标签"><el-input v-model="form.tags" placeholder="使用逗号分隔，例如：科幻, 经典" /></el-form-item>
          <el-form-item label="备注"><el-input v-model="form.notes" type="textarea" :rows="4" placeholder="只保存在本地数据库" /></el-form-item>
        </el-form>
      </section>
      <section class="detail-section info-section"><div class="section-heading"><span>NFO 摘要</span><div><el-button text size="small" @click="importNfo('supplement')">补充空字段</el-button><el-button text size="small" @click="importNfo('force')">强制重新导入</el-button></div></div><p class="plot">{{ detail.plot || detail.outline || '暂无简介' }}</p><div class="fact-grid"><span>类型</span><strong>{{ detail.genres.join(' · ') || '—' }}</strong><span>导演</span><strong>{{ detail.directors.join(' · ') || '—' }}</strong><span>演员</span><strong>{{ detail.actors.slice(0, 5).join(' · ') || '—' }}</strong></div></section>
      <section class="detail-section info-section"><div class="section-heading"><span>文件信息</span></div><div class="fact-grid"><span>来源</span><strong>{{ detail.sourceName }}</strong><span>相对路径</span><strong class="text-mono">{{ detail.relativePath }}</strong><span>容器</span><strong>{{ detail.containerFormat || '—' }}</strong><span>视频</span><strong>{{ detail.videoCodec || '—' }} {{ detail.width && detail.height ? `${detail.width}×${detail.height}` : '' }}</strong><span>NFO</span><strong>{{ detail.nfoStatus === 'ok' ? '已读取' : detail.nfoStatus === 'error' ? '读取失败' : '未找到' }}</strong></div><p v-if="detail.nfoError" class="error-text">{{ detail.nfoError }}</p></section>
    </template>
  </el-drawer>
</template>

<style scoped>
.detail-hero { display: flex; gap: 18px; }
.detail-poster { width: 118px; height: 174px; flex: 0 0 auto; overflow: hidden; border-radius: 10px; background: #252b38; }
.detail-poster img { width: 100%; height: 100%; object-fit: cover; }
.poster-placeholder { display: grid; height: 100%; place-items: center; color: #95a0b3; font-size: 40px; font-weight: 800; }
.detail-head h2 { margin: 3px 0 8px; font-size: 23px; line-height: 1.25; }
.detail-subtitle { color: var(--muted); font-size: 12px; }
.detail-actions { display: flex; gap: 7px; margin-top: 18px; }
.missing-banner { margin-top: 14px; color: #ff9b9b; font-size: 12px; }
.media-strip { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 22px 0; }
.media-strip img, .media-strip video { width: 100%; height: 132px; border-radius: 8px; object-fit: cover; background: #10131a; }
.detail-section { padding: 20px 0; border-top: 1px solid var(--line); }
.section-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; color: var(--ink); font-size: 13px; font-weight: 750; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-row .el-select, .form-row .el-input-number { width: 100%; }
.detail-form :deep(.el-form-item) { margin-bottom: 14px; }
.info-section p { color: var(--muted); font-size: 13px; line-height: 1.7; }
.fact-grid { display: grid; grid-template-columns: 70px 1fr; gap: 9px 10px; font-size: 12px; }
.fact-grid span { color: var(--subtle); }
.fact-grid strong { overflow: hidden; color: var(--muted); font-weight: 500; text-overflow: ellipsis; }
.error-text { color: #ff9b9b !important; }
</style>
