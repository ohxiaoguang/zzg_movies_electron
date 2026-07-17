<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { ActorDto, CustomCategoryDto, FilmDetailDto, FilmPartDto, FilmUpdatePatch } from '../../../shared/contracts';
import type { AssetType } from '../../../shared/enums';
import { mediaUrl } from '../../api';
import { useScanStore } from '../../stores/scan';
import FilmDetailHeader, { type SelectedCategoryItem } from './FilmDetailHeader.vue';

const props = defineProps<{ modelValue: boolean; filmId: string | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; updated: [] }>();
const router = useRouter();
const scan = useScanStore();
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
interface CategorySelection { ids: string[]; newNames: string[]; }
interface PendingSave { patch?: FilmUpdatePatch; favorite?: boolean; categories?: CategorySelection; }

const detail = ref<FilmDetailDto | null>(null);
const categoryOptions = ref<CustomCategoryDto[]>([]);
const actorCounts = ref<Record<string, number>>({});
const loading = ref(false);
const partsVisible = ref(false);
const activeMediaTab = ref<'images' | 'video'>('images');
const imageIndex = ref(0);
const galleryImage = ref<HTMLImageElement | null>(null);
const thumbnailStripRef = ref<HTMLElement | null>(null);
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
const thumbnailRefs = new Map<string, HTMLElement>();

const poster = computed(() => assetOf('poster') ?? assetOf('thumb'));
const preview = computed(() => detail.value && (detail.value.previewAssetId || detail.value.allowOriginalPreview)
  ? mediaUrl('preview', detail.value.id)
  : null);
const images = computed(() => (detail.value?.images ?? []).filter((image) => !image.missing && !brokenImageIds.value.has(image.id)));
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

watch(() => [props.modelValue, props.filmId], () => {
  if (props.modelValue) void load();
  else cleanupGallery();
}, { immediate: true });
watch([imageIndex, images], () => {
  if (imageIndex.value >= images.value.length) imageIndex.value = Math.max(0, images.value.length - 1);
  preloadAdjacentImages();
  void scrollActiveThumbnail();
}, { flush: 'post' });
watch(activeMediaTab, () => void scrollActiveThumbnail());
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
    activeMediaTab.value = filmResult.data.images.length ? 'images' : 'video';
    await nextTick();
    hydrated.value = true;
    preloadAdjacentImages();
    await scrollActiveThumbnail();
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

async function openFilm(): Promise<void> {
  if (!detail.value) return;
  if (detail.value.parts.length > 1) { partsVisible.value = true; return; }
  const part = detail.value.parts[0];
  const result = part ? await window.filmLibrary.films.partsOpen(part.id) : await window.filmLibrary.films.open(detail.value.id);
  if (!result.ok) ElMessage.error(result.error.message);
}
async function openPart(part: FilmPartDto): Promise<void> { const result = await window.filmLibrary.films.partsOpen(part.id); if (!result.ok) ElMessage.error(result.error.message); }
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

function assetOf(type: AssetType): string | null { const asset = detail.value?.assets.find((item) => item.assetType === type && !item.missing); return asset ? mediaUrl('asset', asset.id) : null; }
function previousImage(): void { if (images.value.length) imageIndex.value = (imageIndex.value - 1 + images.value.length) % images.value.length; }
function nextImage(): void { if (images.value.length) imageIndex.value = (imageIndex.value + 1) % images.value.length; }
function preloadAdjacentImages(): void { if (!images.value.length) return; for (const offset of [-1, 0, 1]) { const item = images.value[(imageIndex.value + offset + images.value.length) % images.value.length]; if (item) { const image = new Image(); image.src = mediaUrl('asset', item.id); } } }
function setThumbnailRef(id: string, value: unknown): void { if (value instanceof HTMLElement) thumbnailRefs.set(id, value); else thumbnailRefs.delete(id); }
async function scrollActiveThumbnail(): Promise<void> { await nextTick(); const strip = thumbnailStripRef.value; const thumbnail = currentImage.value ? thumbnailRefs.get(currentImage.value.id) : null; if (!strip || !thumbnail || !strip.contains(thumbnail)) return; const stripRect = strip.getBoundingClientRect(); const rect = thumbnail.getBoundingClientRect(); if (rect.left < stripRect.left || rect.right > stripRect.right) thumbnail.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }); }
function markImageMissing(): void { if (currentImage.value) brokenImageIds.value = new Set([...brokenImageIds.value, currentImage.value.id]); }
function handleKeydown(event: KeyboardEvent): void { if (!props.modelValue || activeMediaTab.value !== 'images' || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return; if (event.key === 'ArrowLeft') { event.preventDefault(); previousImage(); } if (event.key === 'ArrowRight') { event.preventDefault(); nextImage(); } }
function cleanupGallery(): void { brokenImageIds.value = new Set(); thumbnailRefs.clear(); }
function actorCountIndex(actors: ActorDto[]): Record<string, number> { return Object.fromEntries(actors.map((actor) => [actor.name.toLocaleLowerCase(), actor.filmCount])); }
function actorCount(name: string): number { return actorCounts.value[name.toLocaleLowerCase()] ?? 0; }
async function close(): Promise<boolean> { if (!(await flushBeforeClose())) return false; cleanupGallery(); activeFilmId = null; emit('update:modelValue', false); return true; }
async function filterByActor(name: string): Promise<void> { if (await close()) await router.push({ path: '/library', query: { actor: name } }); }

window.addEventListener('keydown', handleKeydown);
document.addEventListener('fullscreenchange', scrollActiveThumbnail);
onBeforeUnmount(() => { window.removeEventListener('keydown', handleKeydown); document.removeEventListener('fullscreenchange', scrollActiveThumbnail); if (saveTimer) clearTimeout(saveTimer); thumbnailRefs.clear(); });
</script>

<template>
  <el-drawer :model-value="modelValue" size="min(720px, 94vw)" title="影片详情" @close="close">
    <div v-if="loading" class="detail-loading"><el-skeleton :rows="10" animated /></div>
    <template v-else-if="detail">
      <FilmDetailHeader :detail="detail" :poster="poster" :favorite="form.favorite" :categories="selectedCategories" :category-options="categoryOptions" :save-state="saveState" :save-state-label="saveStateLabel" :rescan-busy="rescanBusy" @favorite-change="queueFavorite" @category-add="addCategory" @category-remove="removeCategory" @retry="retrySave" @play="openFilm" @show-folder="showPrimaryFolder" @rescan="rescanDirectory" />

      <section v-if="preview || images.length" class="detail-section media-section"><el-tabs v-model="activeMediaTab"><el-tab-pane v-if="preview" label="预览视频" name="video"><video class="detail-video" :src="preview" controls muted playsinline preload="metadata" /></el-tab-pane><el-tab-pane v-if="images.length" label="图片图库" name="images"><div class="gallery-main"><img v-if="currentImageUrl" ref="galleryImage" :src="currentImageUrl" alt="影片图片" @error="markImageMissing" @click="galleryImage?.requestFullscreen?.()" /><button v-if="images.length > 1" class="gallery-arrow left" aria-label="上一张" @click.stop="previousImage">‹</button><button v-if="images.length > 1" class="gallery-arrow right" aria-label="下一张" @click.stop="nextImage">›</button><span class="gallery-count">{{ imageIndex + 1 }} / {{ images.length }}</span></div><div ref="thumbnailStripRef" class="gallery-thumbs"><button v-for="(image, index) in images" :key="image.id" :ref="(element) => setThumbnailRef(image.id, element)" :class="{ active: index === imageIndex }" @click="imageIndex = index"><img :src="mediaUrl('asset', image.id)" alt="缩略图" /></button></div></el-tab-pane></el-tabs></section>
      <div v-else class="media-empty">暂无预览视频或图片</div>

      <section v-if="detail.parts.length" class="detail-section"><div class="section-heading"><span>分段文件</span><span class="muted">{{ detail.parts.length }} 个</span></div><div class="parts-list"><div v-for="part in detail.parts" :key="part.id" class="part-row"><div><strong>{{ part.partType === 'single' ? '单文件' : `${part.partType.toUpperCase()} ${part.partNumber}` }}</strong><span class="text-mono">{{ part.filename }}</span></div><div><el-tag v-if="part.missing" type="danger" size="small">缺失</el-tag><el-button text size="small" :disabled="part.missing" @click="openPart(part)">播放</el-button><el-button text size="small" :disabled="part.missing" @click="showPart(part)">定位</el-button></div></div></div></section>

      <section class="detail-section"><div class="section-heading"><span>本地资料</span></div><el-form label-position="top" class="detail-form"><el-form-item label="标题"><el-input v-model="form.title" @input="queueTitle" /></el-form-item><el-form-item label="原始标题"><el-input v-model="form.originalTitle" @input="queueOriginalTitle" /></el-form-item><el-form-item label="评分"><el-input-number v-model="form.rating" :min="0" :max="10" :step="0.5" @change="queueRating" /></el-form-item><el-form-item label="备注"><el-input v-model="form.notes" type="textarea" :rows="4" placeholder="只保存在本地数据库" @input="queueNotes" /></el-form-item></el-form></section>
      <section class="detail-section nfo-tags-section"><div class="section-heading"><span>NFO 标签 <small>来自 NFO，只读</small></span></div><div class="nfo-tags"><el-tag v-for="tag in detail.nfoTags" :key="tag.id" effect="plain">{{ tag.name }}</el-tag><span v-if="!detail.nfoTags.length" class="muted">暂无 NFO 标签</span></div></section>
      <section class="detail-section info-section"><div class="section-heading"><span>NFO 摘要</span><div><el-button text size="small" @click="importNfo('supplement')">补充空字段</el-button><el-button text size="small" @click="chooseForceImport">强制重新导入</el-button></div></div><p class="plot">{{ detail.plot || detail.outline || '暂无简介' }}</p><div class="fact-grid"><span>导演</span><strong>{{ detail.directors.join(' · ') || '—' }}</strong><span>演员</span><strong v-if="detail.actors.length" class="actor-links"><button v-for="actor in detail.actors" :key="actor" type="button" @click="filterByActor(actor)">{{ actor }}（{{ actorCount(actor) }} 部）</button></strong><strong v-else>—</strong></div></section>
      <section class="detail-section info-section"><div class="section-heading"><span>文件信息</span></div><div class="fact-grid"><span>来源</span><strong>{{ detail.sourceName }}</strong><span>主文件</span><strong class="text-mono">{{ detail.relativePath }}</strong><span>容器</span><strong>{{ detail.containerFormat || '—' }}</strong><span>视频</span><strong>{{ detail.videoCodec || '—' }} {{ detail.width && detail.height ? `${detail.width}×${detail.height}` : '' }}</strong><span>NFO</span><strong>{{ detail.nfoStatus === 'ok' ? '已读取' : detail.nfoStatus === 'error' ? '读取失败' : '未找到' }}</strong></div><p v-if="detail.nfoError" class="error-text">{{ detail.nfoError }}</p></section>
    </template>
    <el-dialog v-model="partsVisible" append-to-body title="选择分段" width="520px"><div class="parts-list"><div v-for="part in detail?.parts" :key="part.id" class="part-row"><span>{{ part.filename }}</span><el-button type="primary" size="small" :disabled="part.missing" @click="partsVisible = false; openPart(part)">播放</el-button></div></div></el-dialog>
  </el-drawer>
</template>

<style scoped>
.detail-section { padding: 20px 0; border-top: 1px solid var(--line); }.media-section { padding-top: 12px; }.detail-video { width: 100%; max-height: 360px; background: #090b0f; }.gallery-main { position: relative; display: grid; height: min(420px, 52vh); place-items: center; overflow: hidden; border-radius: 10px; background: #090b0f; }.gallery-main img { width: 100%; height: 100%; object-fit: contain; cursor: zoom-in; }.gallery-arrow { position: absolute; top: 50%; width: 36px; height: 52px; border: 0; border-radius: 9px; color: #fff; background: rgba(0,0,0,.55); font-size: 34px; transform: translateY(-50%); cursor: pointer; }.gallery-arrow.left { left: 12px; }.gallery-arrow.right { right: 12px; }.gallery-count { position: absolute; right: 12px; bottom: 10px; padding: 4px 8px; border-radius: 5px; color: #fff; background: rgba(0,0,0,.55); font-size: 11px; }.gallery-thumbs { display: flex; gap: 8px; margin-top: 10px; overflow-x: auto; overflow-y: hidden; scroll-behavior: smooth; }.gallery-thumbs button { width: 64px; height: 48px; padding: 2px; flex: 0 0 auto; border: 2px solid transparent; border-radius: 6px; background: #141820; cursor: pointer; }.gallery-thumbs button.active { border-color: var(--accent); }.gallery-thumbs img { width: 100%; height: 100%; object-fit: cover; }.media-empty { padding: 34px 0; color: var(--muted); text-align: center; }.parts-list { display: grid; gap: 8px; }.part-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: rgba(21,24,33,.65); }.part-row > div:first-child { display: grid; min-width: 0; gap: 4px; }.part-row .text-mono { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }.section-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; color: var(--ink); font-size: 13px; font-weight: 750; }.section-heading small { margin-left: 5px; color: var(--muted); font-size: 10px; font-weight: 500; }.detail-form :deep(.el-form-item) { margin-bottom: 14px; }.nfo-tags { display: flex; min-width: 0; flex-wrap: wrap; gap: 7px; overflow: hidden; }.info-section p { color: var(--muted); font-size: 13px; line-height: 1.7; }.fact-grid { display: grid; grid-template-columns: 70px 1fr; gap: 9px 10px; font-size: 12px; }.fact-grid span { color: var(--subtle); }.fact-grid strong { overflow-wrap: anywhere; color: var(--muted); font-weight: 500; }.actor-links { display: flex; flex-wrap: wrap; gap: 6px; }.actor-links button { padding: 3px 8px; border: 1px solid rgba(152,227,194,.26); border-radius: 999px; color: var(--accent); background: rgba(152,227,194,.08); font: inherit; cursor: pointer; }.actor-links button:hover { border-color: rgba(152,227,194,.55); background: rgba(152,227,194,.14); }.actor-links button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }.error-text { color: #ff9b9b !important; }.muted { color: var(--muted); }
</style>
