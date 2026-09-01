<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { ActorDto, CustomCategoryDto, FilmDetailDto, FilmPartDto, FilmUpdatePatch } from '../../../shared/contracts';
import type { AssetType } from '../../../shared/enums';
import { mediaUrl } from '../../api';
import { useLibraryStore } from '../../stores/library';
import { useScanStore } from '../../stores/scan';
import { useResonanceStore } from '../../stores/resonance';
import FilmDetailHeader, { type SelectedCategoryItem } from './FilmDetailHeader.vue';
import FilmDetailPlayer from './FilmDetailPlayer.vue';
import FilmSegmentEditor from './FilmSegmentEditor.vue';

const props = defineProps<{ modelValue: boolean; filmId: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; updated: [] }>();
const router = useRouter();
const library = useLibraryStore();
const scan = useScanStore();
const resonance = useResonanceStore();
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
interface CategorySelection { ids: string[]; newNames: string[]; }
interface PendingSave { patch?: FilmUpdatePatch; favorite?: boolean; categories?: CategorySelection; }

const detail = ref<FilmDetailDto | null>(null);
const categoryOptions = ref<CustomCategoryDto[]>([]);
const actorCounts = ref<Record<string, number>>({});
const loading = ref(false);
const activeDetailTab = ref<'segments' | 'images'>('segments');
const activeSidebarSections = ref<string[]>([]);
const detailPlayer = ref<InstanceType<typeof FilmDetailPlayer> | null>(null);
const segmentEditor = ref<InstanceType<typeof FilmSegmentEditor> | null>(null);
const playbackPosition = reactive({ currentSeconds: 0, durationSeconds: 0, partId: '' });
const imageIndex = ref(0);
const imageViewerVisible = ref(false);
const brokenImageIds = ref(new Set<string>());
const hydrated = ref(false);
const saveState = ref<SaveState>('idle');
const saveError = ref('');
const rescanStarting = ref(false);
const form = reactive({ title: '', originalTitle: '', favorite: false, rating: 0, notes: '', categoryIds: [] as string[], newCategoryNames: [] as string[] });

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightSave: Promise<void> | null = null;
let activeFilmId: string | null = null;
let changeVersion = 0;
let pendingSave: PendingSave = {};
let lastSavedPatch: FilmUpdatePatch = {};
let rescanJobId: string | null = null;

const poster = computed(() => assetOf('poster') ?? assetOf('thumb') ?? (detail.value ? mediaUrl('poster', detail.value.id) : null));
const commentImages = computed(() => (detail.value?.images ?? []).filter((image) => image.assetType === 'comment' && !image.missing && !brokenImageIds.value.has(image.id)));
const stillImages = computed(() => (detail.value?.images ?? []).filter((image) => image.assetType !== 'comment' && !image.missing && !brokenImageIds.value.has(image.id)));
const images = computed(() => [...commentImages.value, ...stillImages.value]);
const currentImage = computed(() => images.value[imageIndex.value] ?? null);
const currentImageUrl = computed(() => currentImage.value ? mediaUrl('asset', currentImage.value.id) : null);
const selectedCategories = computed<SelectedCategoryItem[]>(() => {
  const selected: SelectedCategoryItem[] = [];
  for (const id of form.categoryIds) {
    const category = categoryOptions.value.find((item) => item.id === id) ?? detail.value?.customCategories.find((item) => item.id === id);
    if (category) selected.push({ key: `id:${id}`, id, name: category.name });
  }
  for (const name of form.newCategoryNames) selected.push({ key: `new:${name.toLocaleLowerCase()}`, id: null, name });
  return selected;
});
const saveStateLabel = computed(() => saveState.value === 'saving' ? '正在保存…' : saveState.value === 'dirty' ? '待保存' : saveState.value === 'saved' ? '已保存' : saveState.value === 'error' ? `保存失败：${saveError.value}` : '');
const rescanBusy = computed(() => rescanStarting.value || Boolean(rescanJobId && scan.progress?.jobId === rescanJobId && scan.progress.status === 'running'));

function captureVrView() {
  return detailPlayer.value?.getCurrentVrView() ?? null;
}

watch(() => [props.modelValue, props.filmId], () => {
  if (props.modelValue) void load();
  else {
    detailPlayer.value?.releasePlayback();
    cleanupGallery();
  }
}, { immediate: true });
watch([imageIndex, images], () => {
  if (imageIndex.value >= images.value.length) imageIndex.value = Math.max(0, images.value.length - 1);
  preloadAdjacentImages();
}, { flush: 'post' });
watch(() => scan.progress, (progress) => {
  if (!progress || progress.jobId !== rescanJobId || progress.status === 'running') return;
  const completed = progress.status === 'completed';
  rescanJobId = null;
  emit('updated');
  if (completed) {
    ElMessage.success('当前影片目录扫描完成');
    if (props.modelValue && props.filmId) void load();
  }
});

async function load(): Promise<void> {
  const filmId = props.filmId;
  if (!filmId) return;
  activeFilmId = filmId;
  hydrated.value = false;
  actorCounts.value = {};
  Object.assign(playbackPosition, { currentSeconds: 0, durationSeconds: 0, partId: '' });
  resetSaveQueue();
  loading.value = true;
  try {
    const [filmResult, categoryResult, actorResult] = await Promise.all([
      window.filmLibrary.films.detail(filmId),
      window.filmLibrary.categories.list(),
      window.filmLibrary.actors.list(),
    ]);
    if (activeFilmId !== filmId) return;
    if (!filmResult.ok) { ElMessage.error(filmResult.error.message); return; }
    detail.value = filmResult.data;
    if (categoryResult.ok) categoryOptions.value = categoryResult.data;
    if (actorResult.ok) actorCounts.value = actorCountIndex(actorResult.data);
    mergeCategories(filmResult.data);
    syncForm(filmResult.data);
    imageIndex.value = 0;
    activeDetailTab.value = 'segments';
    await nextTick();
    hydrated.value = true;
    preloadAdjacentImages();
  } catch (error) {
    console.error('[film-detail] load failed', error);
    ElMessage.error('影片详情加载失败，请查看日志');
  } finally {
    loading.value = false;
  }
}

function syncForm(value: FilmDetailDto): void {
  Object.assign(form, { title: value.title, originalTitle: value.originalTitle ?? '', favorite: value.favorite, rating: value.rating, notes: value.notes, categoryIds: value.customCategories.map((item) => item.id), newCategoryNames: [] });
  lastSavedPatch = { title: form.title, originalTitle: form.originalTitle, rating: Number(form.rating), notes: form.notes };
  pendingSave = {};
  saveError.value = '';
  saveState.value = 'idle';
}

function schedule(delay: number): void {
  if (!hydrated.value || !detail.value) return;
  changeVersion += 1;
  saveState.value = 'dirty';
  saveError.value = '';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void flushPending(); }, delay);
}

function schedulePatch(patch: FilmUpdatePatch, delay: number): void {
  if (!hydrated.value) return;
  const changed = Object.entries(patch).some(([key, value]) => JSON.stringify(lastSavedPatch[key as keyof FilmUpdatePatch]) !== JSON.stringify(value));
  if (!changed && !pendingSave.patch) return;
  pendingSave.patch = { ...pendingSave.patch, ...patch };
  schedule(delay);
}

function queueFavorite(value: boolean): void {
  form.favorite = value;
  pendingSave.favorite = value;
  schedule(0);
}
function queueCategories(): void {
  pendingSave.categories = { ids: [...form.categoryIds], newNames: [...form.newCategoryNames] };
  schedule(200);
}
function addCategory(value: string): void {
  const normalized = value.trim();
  if (!normalized) return;
  const existing = categoryOptions.value.find((item) => item.id === normalized || item.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === normalized.replace(/\s+/g, ' ').toLocaleLowerCase());
  if (existing) {
    if (!form.categoryIds.includes(existing.id)) form.categoryIds.push(existing.id);
  } else if (!form.newCategoryNames.some((name) => name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) form.newCategoryNames.push(normalized.slice(0, 200));
  queueCategories();
}
function removeCategory(item: SelectedCategoryItem): void {
  if (item.id) form.categoryIds = form.categoryIds.filter((id) => id !== item.id);
  else form.newCategoryNames = form.newCategoryNames.filter((name) => name.toLocaleLowerCase() !== item.name.toLocaleLowerCase());
  queueCategories();
}

async function flushPending(): Promise<void> {
  if (inFlightSave) {
    await inFlightSave;
    if (hasPending()) await flushPending();
    return;
  }
  if (!detail.value || !hasPending()) return;
  const filmId = detail.value.id;
  const batch = pendingSave;
  const requestVersion = changeVersion;
  pendingSave = {};
  saveState.value = 'saving';
  inFlightSave = sendBatch(filmId, batch, requestVersion);
  try { await inFlightSave; } finally {
    inFlightSave = null;
    if (hasPending() && (saveState.value as SaveState) !== 'error') void flushPending();
  }
}

async function sendBatch(filmId: string, batch: PendingSave, requestVersion: number): Promise<void> {
  try {
    let confirmed = detail.value!;
    if (batch.favorite !== undefined) {
      const result = await window.filmLibrary.films.updateFavorite(filmId, batch.favorite);
      if (!result.ok) throw new Error(result.error.message);
      confirmed = result.data;
    }
    if (batch.categories) {
      const result = await window.filmLibrary.films.updateCategories(filmId, batch.categories.ids, batch.categories.newNames);
      if (!result.ok) throw new Error(result.error.message);
      confirmed = result.data;
    }
    if (batch.patch && Object.keys(batch.patch).length) {
      const result = await window.filmLibrary.films.updatePatch(filmId, batch.patch);
      if (!result.ok) throw new Error(result.error.message);
      confirmed = result.data;
    }
    mergeCategories(confirmed);
    const hasNewerInput = requestVersion !== changeVersion;
    if (detail.value?.id === filmId) {
      detail.value = hasNewerInput ? applyCurrentForm(confirmed) : confirmed;
      if (!hasNewerInput) syncForm(confirmed);
    }
    saveError.value = '';
    saveState.value = hasNewerInput ? 'dirty' : 'saved';
    emit('updated');
  } catch (error) {
    pendingSave = {
      patch: batch.patch || pendingSave.patch ? { ...batch.patch, ...pendingSave.patch } : undefined,
      favorite: pendingSave.favorite ?? batch.favorite,
      categories: pendingSave.categories ?? batch.categories,
    };
    saveState.value = 'error';
    saveError.value = error instanceof Error ? error.message : '未知错误';
    console.error('[film-detail] auto-save failed', { filmId, error });
  }
}

function applyCurrentForm(value: FilmDetailDto): FilmDetailDto {
  const known = selectedCategories.value.filter((item): item is SelectedCategoryItem & { id: string } => Boolean(item.id)).map((item) => ({ id: item.id, name: item.name, sortOrder: categoryOptions.value.find((category) => category.id === item.id)?.sortOrder ?? 0 }));
  return { ...value, title: form.title, originalTitle: form.originalTitle || null, favorite: form.favorite, rating: form.rating, notes: form.notes, customCategories: known, organizationState: selectedCategories.value.length ? 'organized' : 'unorganized' };
}
function mergeCategories(value: FilmDetailDto): void {
  const known = new Set(categoryOptions.value.map((item) => item.id));
  for (const category of value.customCategories) if (!known.has(category.id)) categoryOptions.value.push(category);
  categoryOptions.value.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}
function hasPending(): boolean { return Boolean(pendingSave.patch || pendingSave.favorite !== undefined || pendingSave.categories); }
function retrySave(): void { if (hasPending()) { saveState.value = 'dirty'; saveError.value = ''; void flushPending(); } }
function resetSaveQueue(): void { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; pendingSave = {}; inFlightSave = null; saveError.value = ''; saveState.value = 'idle'; lastSavedPatch = {}; }
function queueTitle(): void { schedulePatch({ title: form.title }, 500); }
function queueOriginalTitle(): void { schedulePatch({ originalTitle: form.originalTitle }, 500); }
function queueRating(): void { schedulePatch({ rating: Number(form.rating) }, 150); }
function queueNotes(): void { schedulePatch({ notes: form.notes }, 800); }

async function flushBeforeClose(): Promise<boolean> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (hasPending()) await flushPending();
  if (inFlightSave) await Promise.race([inFlightSave, timeout(3000)]);
  if (saveState.value !== 'error') return true;
  try { await ElMessageBox.confirm('还有修改没有保存。点击“重试”后再关闭，取消则保留详情页。', '保存失败', { confirmButtonText: '重试', cancelButtonText: '取消关闭', type: 'warning' }); }
  catch { return false; }
  retrySave();
  if (inFlightSave) await Promise.race([inFlightSave, timeout(3000)]);
  return saveState.value !== 'error' && !hasPending();
}
function timeout(milliseconds: number): Promise<false> { return new Promise((resolve) => setTimeout(() => resolve(false), milliseconds)); }

async function showPart(part: FilmPartDto): Promise<void> { const result = await window.filmLibrary.films.partsShowInFolder(part.id); if (!result.ok) ElMessage.error(result.error.message); }
async function showPrimaryFolder(): Promise<void> { if (detail.value?.parts[0]) await showPart(detail.value.parts[0]); }

async function chooseForceImport(): Promise<void> {
  let mode: 'force-merge' | 'force-replace';
  try {
    await ElMessageBox.confirm('合并会保留当前字段并合并 NFO 标签；替换会以 NFO 内容覆盖对应元数据。我的分类和收藏均不受影响。', '选择 NFO 导入方式', { confirmButtonText: '合并导入', cancelButtonText: '替换导入', distinguishCancelAndClose: true, type: 'warning' });
    mode = 'force-merge';
  } catch (reason) { if (reason !== 'cancel') return; mode = 'force-replace'; }
  await importNfo(mode);
}
async function importNfo(mode: 'supplement' | 'force-merge' | 'force-replace'): Promise<void> {
  if (!detail.value) return;
  const result = await window.filmLibrary.films.importNfo(detail.value.id, mode);
  if (!result.ok) { ElMessage.error(result.error.message); return; }
  detail.value = result.data;
  hydrated.value = false;
  mergeCategories(result.data);
  syncForm(result.data);
  await nextTick();
  hydrated.value = true;
  emit('updated');
}

async function rescanDirectory(): Promise<void> {
  if (!detail.value || rescanBusy.value) return;
  await flushPending();
  if (saveState.value === 'error') { ElMessage.error('请先解决当前详情保存失败问题'); return; }
  rescanStarting.value = true;
  scan.listen();
  try {
    const result = await window.filmLibrary.films.rescan(detail.value.id);
    if (!result.ok) { ElMessage.error(result.error.message); return; }
    rescanJobId = result.data.jobId;
    scan.dialogVisible = true;
    ElMessage.success('已开始重新扫描当前影片目录');
  } finally {
    rescanStarting.value = false;
  }
}

async function playWithLocalPlayer(): Promise<void> {
  if (!detail.value) return;
  const part = detail.value.parts.find((item) => item.id === playbackPosition.partId && !item.missing)
    ?? detail.value.parts.find((item) => !item.missing);
  detailPlayer.value?.stopPlayback();
  const result = part
    ? await window.filmLibrary.films.partsOpen(part.id)
    : await window.filmLibrary.films.open(detail.value.id);
  if (!result.ok) ElMessage.error(result.error.message);
}

function assetOf(type: AssetType): string | null { const asset = detail.value?.assets.find((item) => item.assetType === type && !item.missing); return asset ? mediaUrl('asset', asset.id) : null; }
function previousImage(): void { if (images.value.length) imageIndex.value = (imageIndex.value - 1 + images.value.length) % images.value.length; }
function nextImage(): void { if (images.value.length) imageIndex.value = (imageIndex.value + 1) % images.value.length; }
function preloadAdjacentImages(): void { if (!images.value.length) return; for (const offset of [-1, 0, 1]) { const item = images.value[(imageIndex.value + offset + images.value.length) % images.value.length]; if (item) { const image = new Image(); image.src = mediaUrl('asset', item.id); } } }
function markImageMissing(): void { if (currentImage.value) brokenImageIds.value = new Set([...brokenImageIds.value, currentImage.value.id]); }
function openImage(index: number): void { imageIndex.value = index; imageViewerVisible.value = true; }
function updateSegments(segments: FilmDetailDto['segments']): void {
  if (!detail.value) return;
  detail.value = { ...detail.value, segments, highlightSegmentCount: segments.filter((segment) => segment.includeInPreview).length };
  emit('updated');
}
function updatePlaybackPosition(currentSeconds: number, durationSeconds: number, partId: string): void {
  Object.assign(playbackPosition, { currentSeconds, durationSeconds, partId });
}
function addToResonance(): void {
  if (!detail.value) return;
  const snapshot = detailPlayer.value?.getPlaybackSnapshot();
  if (!snapshot) {
    ElMessage.warning('当前没有可加入共鸣球的视频');
    return;
  }
  detailPlayer.value?.stopPlayback();
  const result = resonance.add({
    filmId: detail.value.id,
    partId: snapshot.partId,
    title: detail.value.title,
    filename: snapshot.filename,
    currentSeconds: snapshot.currentSeconds,
    durationSeconds: snapshot.durationSeconds,
    aspectRatio: snapshot.isVr ? 16 / 9 : snapshot.width / snapshot.height,
    isVr: snapshot.isVr,
    vrView: snapshot.vrView,
  });
  ElMessage.success(result === 'added' ? '已添加进共鸣球，当前视频已暂停' : '已更新共鸣球中的播放进度，当前视频已暂停');
}
function handleKeydown(event: KeyboardEvent): void {
  if (!props.modelValue || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
  if (imageViewerVisible.value) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); previousImage(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); nextImage(); }
    else if (event.key === 'Escape') imageViewerVisible.value = false;
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    detailPlayer.value?.togglePlayback();
  } else if (event.key.toLowerCase() === 'i') {
    event.preventDefault();
    activeDetailTab.value = 'segments';
    void nextTick(() => segmentEditor.value?.markStart());
  } else if (event.key.toLowerCase() === 'o') {
    event.preventDefault();
    activeDetailTab.value = 'segments';
    void nextTick(() => segmentEditor.value?.markEnd());
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    event.stopPropagation();
    const delta = event.shiftKey
      ? library.settings.detailPlayerFineSeekStepSeconds
      : library.settings.detailPlayerSeekStepSeconds;
    detailPlayer.value?.seekRelative(event.key === 'ArrowLeft' ? -delta : delta);
  }
}
function cleanupGallery(): void { brokenImageIds.value = new Set(); imageViewerVisible.value = false; }
function actorCountIndex(actors: ActorDto[]): Record<string, number> { return Object.fromEntries(actors.map((actor) => [actor.name.toLocaleLowerCase(), actor.filmCount])); }
function actorCount(name: string): number { return actorCounts.value[name.toLocaleLowerCase()] ?? 0; }
async function close(): Promise<boolean> {
  detailPlayer.value?.releasePlayback();
  if (!(await flushBeforeClose())) return false;
  cleanupGallery();
  activeFilmId = null;
  emit('update:modelValue', false);
  return true;
}
async function filterByActor(name: string): Promise<void> { if (await close()) await router.push({ path: '/library', query: { actor: name } }); }

window.addEventListener('keydown', handleKeydown, true);
onBeforeUnmount(() => { window.removeEventListener('keydown', handleKeydown, true); detailPlayer.value?.releasePlayback(); if (saveTimer) clearTimeout(saveTimer); });
</script>

<template>
  <el-drawer :model-value="modelValue" class="film-detail-drawer" size="100vw" title="影片详情" @close="close">
    <div v-if="loading" class="detail-loading"><el-skeleton :rows="10" animated /></div>
    <template v-else-if="detail">
      <div class="detail-workbench">
        <aside class="detail-sidebar">
          <FilmDetailHeader :detail="detail" :poster="poster" :favorite="form.favorite" :categories="selectedCategories" :category-options="categoryOptions" :save-state="saveState" :save-state-label="saveStateLabel" :rescan-busy="rescanBusy" @favorite-change="queueFavorite" @category-add="addCategory" @category-remove="removeCategory" @retry="retrySave" @play="detailPlayer?.playOriginal()" @local-player="playWithLocalPlayer" @show-folder="showPrimaryFolder" @rescan="rescanDirectory" />

          <el-collapse v-model="activeSidebarSections" class="sidebar-info-collapse">
            <el-collapse-item title="基本信息" name="basic">
              <section class="sidebar-section"><div class="section-heading"><span>本地资料</span></div><el-form label-position="top" class="detail-form"><el-form-item label="标题"><el-input v-model="form.title" @input="queueTitle" /></el-form-item><el-form-item label="原始标题"><el-input v-model="form.originalTitle" @input="queueOriginalTitle" /></el-form-item><el-form-item label="评分"><el-input-number v-model="form.rating" :min="0" :max="10" :step="0.5" @change="queueRating" /></el-form-item><el-form-item label="备注"><el-input v-model="form.notes" type="textarea" :rows="3" placeholder="只保存在本地数据库" @input="queueNotes" /></el-form-item></el-form></section>
              <section class="sidebar-section nfo-tags-section"><div class="section-heading"><span>NFO 标签 <small>来自 NFO，只读</small></span></div><div class="nfo-tags"><el-tag v-for="tag in detail.nfoTags" :key="tag.id" effect="plain">{{ tag.name }}</el-tag><span v-if="!detail.nfoTags.length" class="muted">暂无 NFO 标签</span></div></section>
              <section class="sidebar-section info-section"><div class="section-heading"><span>影片简介</span></div><p class="plot">{{ detail.plot || detail.outline || '暂无简介' }}</p><div class="fact-grid"><span>导演</span><strong>{{ detail.directors.join(' · ') || '—' }}</strong><span>演员</span><strong v-if="detail.actors.length" class="actor-links"><button v-for="actor in detail.actors" :key="actor" type="button" @click="filterByActor(actor)">{{ actor }}（{{ actorCount(actor) }} 部）</button></strong><strong v-else>—</strong></div></section>
            </el-collapse-item>

            <el-collapse-item title="详细信息" name="details">
              <section v-if="detail.parts.length" class="sidebar-section"><div class="section-heading"><span>影片文件</span><span class="muted">{{ detail.parts.length }} 个</span></div><div class="parts-list"><div v-for="part in detail.parts" :key="part.id" class="part-row"><div><strong>{{ part.partType === 'single' ? '单文件' : `${part.partType.toUpperCase()} ${part.partNumber}` }}</strong><span class="text-mono">{{ part.filename }}</span></div><div><el-tag v-if="part.missing" type="danger" size="small">缺失</el-tag><el-button text size="small" :disabled="part.missing" @click="detailPlayer?.selectPart(part.id)">播放</el-button><el-button text size="small" :disabled="part.missing" @click="showPart(part)">定位</el-button></div></div></div></section>
              <section class="sidebar-section info-section"><div class="section-heading"><span>NFO 与文件信息</span><div><el-button text size="small" @click="importNfo('supplement')">补充空字段</el-button><el-button text size="small" @click="chooseForceImport">重新导入</el-button></div></div><div class="fact-grid"><span>来源</span><strong>{{ detail.sourceName }}</strong><span>主文件</span><strong class="text-mono">{{ detail.relativePath }}</strong><span>容器</span><strong>{{ detail.containerFormat || '—' }}</strong><span>视频</span><strong>{{ detail.videoCodec || '—' }} {{ detail.width && detail.height ? `${detail.width}×${detail.height}` : '' }}</strong><span>NFO</span><strong>{{ detail.nfoStatus === 'ok' ? '已读取' : detail.nfoStatus === 'error' ? '读取失败' : '未找到' }}</strong></div><p v-if="detail.nfoError" class="error-text">{{ detail.nfoError }}</p></section>
            </el-collapse-item>
          </el-collapse>
        </aside>

        <main class="detail-main-column">
          <FilmDetailPlayer
            v-if="modelValue"
            ref="detailPlayer"
            :film="detail"
            :segments="detail.segments"
            @position-change="updatePlaybackPosition"
            @add-to-resonance="addToResonance"
          />

          <el-tabs v-model="activeDetailTab" class="detail-content-tabs" tab-position="right">
        <el-tab-pane label="片段标注" name="segments">
          <FilmSegmentEditor
            ref="segmentEditor"
            :film="detail"
            :current-seconds="playbackPosition.currentSeconds"
            :selected-part-id="playbackPosition.partId"
            :capture-vr-view="captureVrView"
            @change="updateSegments"
            @play="detailPlayer?.playSegment($event)"
          />
        </el-tab-pane>

        <el-tab-pane label="图片" name="images">
          <div v-if="images.length" class="image-groups-row">
            <section v-if="commentImages.length" class="tab-section media-section comment-image-section"><div class="section-heading"><span>精彩评论</span><small>{{ commentImages.length }} 张 · 点击缩略图查看大图</small></div><div class="image-thumbnail-grid"><button v-for="(image, index) in commentImages" :key="image.id" type="button" @click="openImage(index)"><img :src="mediaUrl('asset', image.id)" :alt="`精彩评论 ${index + 1}`" loading="lazy" /></button></div></section>
            <section v-if="stillImages.length" class="tab-section media-section"><div class="section-heading"><span>剧照</span><small>{{ stillImages.length }} 张 · 点击缩略图查看大图</small></div><div class="image-thumbnail-grid"><button v-for="(image, index) in stillImages" :key="image.id" type="button" @click="openImage(commentImages.length + index)"><img :src="mediaUrl('asset', image.id)" :alt="`剧照 ${index + 1}`" loading="lazy" /></button></div></section>
          </div>
          <div v-if="!images.length" class="media-empty">暂无图片</div>
        </el-tab-pane>

          </el-tabs>
        </main>
      </div>
    </template>
    <el-dialog v-model="imageViewerVisible" append-to-body class="image-viewer-dialog" width="96vw" top="2vh" :show-close="true">
      <div class="image-viewer-stage">
        <img v-if="currentImageUrl" :src="currentImageUrl" :alt="detail?.title || '影片图片'" @error="markImageMissing" />
        <button v-if="images.length > 1" type="button" class="viewer-arrow left" aria-label="上一张" @click="previousImage">‹</button>
        <button v-if="images.length > 1" type="button" class="viewer-arrow right" aria-label="下一张" @click="nextImage">›</button>
        <span class="viewer-count">{{ imageIndex + 1 }} / {{ images.length }}</span>
      </div>
    </el-dialog>
  </el-drawer>
</template>

<style scoped>
:global(.film-detail-drawer .el-drawer__body) { min-height: 0; padding: 0 18px 18px; overflow: hidden; }
:global(.film-detail-drawer .el-drawer__header) { height: 34px; min-height: 34px; margin-bottom: 0; padding: 4px 14px; }
:global(.film-detail-drawer .el-drawer__title) { font-size: 13px; line-height: 1; }
:global(.film-detail-drawer .el-drawer__close-btn) { width: 28px; height: 28px; }
.detail-loading { height: 100%; overflow: auto; }
.detail-workbench { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(0, 3fr); height: 100%; min-height: 0; gap: 18px; overflow: hidden; }
.detail-sidebar { min-width: 0; min-height: 0; padding-right: 14px; overflow: auto; border-right: 1px solid var(--line); scrollbar-width: thin; }
.sidebar-info-collapse { margin-top: 8px; border-color: var(--line); }
.sidebar-info-collapse :deep(.el-collapse-item__header) { height: 30px; color: var(--ink); background: transparent; font-size: 11px; font-weight: 750; }
.sidebar-info-collapse :deep(.el-collapse-item__wrap) { border-color: var(--line); background: transparent; }
.sidebar-info-collapse :deep(.el-collapse-item__content) { padding-bottom: 8px; color: inherit; }
.sidebar-section { padding: 8px 0; border-top: 1px solid var(--line); }
.sidebar-section:first-child { border-top: 0; }
.detail-sidebar .detail-form { grid-template-columns: 1fr; gap: 0; }
.detail-sidebar .detail-form :deep(.el-form-item:last-child) { grid-column: auto; }
.detail-sidebar .info-section p { margin: 0 0 8px; font-size: 10px; line-height: 1.5; }
.detail-sidebar .fact-grid { grid-template-columns: 52px minmax(0, 1fr); gap: 6px 7px; font-size: 10px; }
.detail-sidebar .part-row { padding: 7px; align-items: stretch; flex-direction: column; gap: 4px; }
.detail-sidebar .part-row > div:last-child { display: flex; justify-content: flex-end; }
.detail-sidebar .section-heading { margin-bottom: 6px; font-size: 11px; }
.detail-sidebar .actor-links { gap: 4px; }
.detail-sidebar .actor-links button { padding: 2px 6px; font-size: 9px; }
.detail-main-column { display: grid; grid-template-rows: minmax(0, 1fr) 128px; min-width: 0; min-height: 0; overflow: hidden; }
.detail-content-tabs { display: flex; min-height: 0; padding-top: 4px; flex-direction: row; overflow: hidden; border-top: 1px solid var(--line); }
.detail-content-tabs :deep(.el-tabs__header.is-right) { z-index: 5; order: 2; width: 88px; margin: 0 0 0 8px; padding: 0; flex: 0 0 auto; background: #171b24; }
.detail-content-tabs :deep(.el-tabs__nav-wrap::after) { background-color: var(--line); }
.detail-content-tabs :deep(.el-tabs__item.is-right) { height: 29px; justify-content: flex-start; padding: 0 10px; font-size: 11px; }
.detail-content-tabs :deep(.el-tabs__content) { min-width: 0; min-height: 0; order: 1; flex: 1; overflow: auto; scrollbar-gutter: stable; }
.detail-content-tabs :deep(.el-tab-pane) { min-height: 100%; }
.tab-section { padding: 10px 0; border-top: 1px solid var(--line); }
.tab-section:first-child { border-top: 0; }
.media-section { padding-top: 8px; }
.image-groups-row { display: flex; min-width: 0; gap: 16px; }
.image-groups-row .tab-section { min-width: 0; padding-top: 8px; flex: 1 1 0; border-top: 0; }
.image-groups-row .comment-image-section:not(:only-child) { width: max-content; max-width: calc(100% - 152px); flex: 0 1 auto; }
.image-groups-row .comment-image-section:not(:only-child) .image-thumbnail-grid { width: max-content; max-width: 100%; }
.image-groups-row .tab-section + .tab-section { padding-left: 16px; border-left: 1px solid var(--line); }
.image-thumbnail-grid { display: flex; min-width: 0; padding: 2px; overflow-x: auto; gap: 8px; scrollbar-width: thin; }
.image-thumbnail-grid button { width: 120px; min-width: 120px; padding: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 7px; background: #090b0f; cursor: zoom-in; aspect-ratio: 16 / 9; }
.image-thumbnail-grid button:hover, .image-thumbnail-grid button:focus-visible { border-color: var(--accent); outline: 2px solid rgba(152,227,194,.3); }
.image-thumbnail-grid img { display: block; width: 100%; height: 100%; object-fit: cover; }
.comment-image-section .image-thumbnail-grid button { aspect-ratio: 4 / 3; }
.comment-image-section .image-thumbnail-grid img { object-fit: contain; background: #050609; }
:global(.image-viewer-dialog) { height: 96vh; margin-bottom: 0; overflow: hidden; background: #080a0e; }
:global(.image-viewer-dialog .el-dialog__header) { height: 30px; margin: 0; padding: 0; }
:global(.image-viewer-dialog .el-dialog__body) { box-sizing: border-box; height: calc(100% - 30px); padding: 0 12px 12px; }
.image-viewer-stage { position: relative; display: grid; width: 100%; height: 100%; place-items: center; overflow: hidden; background: #050609; }
.image-viewer-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
.viewer-arrow { position: absolute; top: 50%; width: 46px; height: 64px; padding: 0; border: 0; border-radius: 9px; color: #fff; background: rgba(0,0,0,.55); font-size: 38px; transform: translateY(-50%); cursor: pointer; }
.viewer-arrow.left { left: 14px; }
.viewer-arrow.right { right: 14px; }
.viewer-count { position: absolute; right: 16px; bottom: 14px; padding: 5px 9px; border-radius: 6px; color: #fff; background: rgba(0,0,0,.58); font-size: 11px; }
.media-empty { padding: 42px 0; color: var(--muted); text-align: center; }
.parts-list { display: grid; gap: 8px; }
.part-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(21,24,33,.65); }
.part-row > div:first-child { display: grid; min-width: 0; gap: 4px; }
.part-row .text-mono { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.section-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; color: var(--ink); font-size: 12px; font-weight: 750; }
.section-heading small { margin-left: 5px; color: var(--muted); font-size: 10px; font-weight: 500; }
.detail-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; }
.detail-form :deep(.el-form-item) { margin-bottom: 8px; }
.detail-form :deep(.el-form-item:last-child) { grid-column: 1 / -1; }
.nfo-tags { display: flex; min-width: 0; flex-wrap: wrap; gap: 7px; overflow: hidden; }
.info-section p { color: var(--muted); font-size: 13px; line-height: 1.7; }
.fact-grid { display: grid; grid-template-columns: 70px 1fr; gap: 9px 10px; font-size: 12px; }
.fact-grid span { color: var(--subtle); }
.fact-grid strong { overflow-wrap: anywhere; color: var(--muted); font-weight: 500; }
.actor-links { display: flex; flex-wrap: wrap; gap: 6px; }
.actor-links button { padding: 3px 8px; border: 1px solid rgba(152,227,194,.26); border-radius: 999px; color: var(--accent); background: rgba(152,227,194,.08); font: inherit; cursor: pointer; }
.actor-links button:hover { border-color: rgba(152,227,194,.55); background: rgba(152,227,194,.14); }
.actor-links button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.error-text { color: #ff9b9b !important; }
.muted { color: var(--muted); }
@media (max-width: 760px) {
  :deep(.el-drawer) { width: 94vw !important; }
  :global(.film-detail-drawer .el-drawer__body) { overflow: auto; }
  .detail-workbench { display: block; height: auto; overflow: visible; }
  .detail-sidebar { padding-right: 0; overflow: visible; border-right: 0; }
  .detail-main-column { display: block; overflow: visible; }
  .detail-main-column { grid-template-rows: auto; }
  .detail-content-tabs { min-height: 180px; }
  .detail-content-tabs :deep(.el-tabs__item.is-right) { padding-inline: 8px; }
  .detail-content-tabs :deep(.el-tabs__content) { overflow: visible; }
  .detail-form { grid-template-columns: 1fr; }
  .detail-form :deep(.el-form-item:last-child) { grid-column: auto; }
  .part-row { align-items: stretch; flex-direction: column; }
}
</style>
