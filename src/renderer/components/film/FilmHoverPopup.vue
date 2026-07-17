<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { FilmSummaryDto } from '../../../shared/contracts';
import { mediaUrl } from '../../api';
import { calculatePopupPosition, type PopupPosition } from '../../composables/hoverPopupGeometry';
import { claimPreview, releasePreview } from '../../composables/usePreviewManager';

const props = defineProps<{
  film: FilmSummaryDto;
  anchor: HTMLElement | null;
  slideshowInterval: number;
}>();

const emit = defineEmits<{
  enter: [];
  leave: [];
  close: [];
  select: [film: FilmSummaryDto];
  updated: [];
}>();

type PreviewMode = 'video' | 'slideshow' | 'empty';

const popup = ref<HTMLElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
const hasVideoPreview = computed(() => Boolean(props.film.previewAssetId || props.film.allowOriginalPreview));
const mode = ref<PreviewMode>(hasVideoPreview.value ? 'video' : props.film.previewImageAssetIds.length ? 'slideshow' : 'empty');
const imageIndex = ref(0);
const popupWidth = ref(520);
const position = ref<PopupPosition>({ left: 12, top: 12 });
const favorite = ref(props.film.favorite);
const favoriteSaving = ref(false);
const videoPreparing = ref(hasVideoPreview.value);
let slideshowTimer: ReturnType<typeof setInterval> | null = null;

const imageIds = computed(() => props.film.previewImageAssetIds);
const currentImageUrl = computed(() => {
  const id = imageIds.value[imageIndex.value];
  return id ? mediaUrl('asset', id) : null;
});
const popupStyle = computed(() => ({
  left: `${position.value.left}px`,
  top: `${position.value.top}px`,
  width: `${popupWidth.value}px`,
}));

watch(() => props.film.favorite, (value) => { favorite.value = value; });

function closeForViewportChange(): void {
  emit('close');
}

function calculateWidth(): number {
  const available = window.innerWidth - 24;
  return Math.min(520, Math.max(360, available));
}

async function positionPopup(): Promise<void> {
  if (!popup.value || !props.anchor) return;
  popupWidth.value = calculateWidth();
  await nextTick();
  const rect = props.anchor.getBoundingClientRect();
  const size = { width: popup.value.offsetWidth || popupWidth.value, height: popup.value.offsetHeight };
  position.value = calculatePopupPosition(rect, size, { width: window.innerWidth, height: window.innerHeight });
}

async function startPreview(): Promise<void> {
  await nextTick();
  if (hasVideoPreview.value && video.value) {
    mode.value = 'video';
    videoPreparing.value = true;
    claimPreview(props.film.id, video.value);
    video.value.src = mediaUrl('preview', props.film.id);
    video.value.load();
    try {
      await video.value.play();
    } catch {
      fallbackToImages();
    }
    return;
  }
  startSlideshow();
}

function fallbackToImages(): void {
  stopVideo();
  if (imageIds.value.length) startSlideshow();
  else mode.value = 'empty';
}

function startSlideshow(): void {
  stopSlideshow();
  if (!imageIds.value.length) {
    mode.value = 'empty';
    return;
  }
  mode.value = 'slideshow';
  imageIndex.value = 0;
  preloadImages();
  if (imageIds.value.length > 1) {
    slideshowTimer = setInterval(() => {
      imageIndex.value = (imageIndex.value + 1) % imageIds.value.length;
      preloadImages();
    }, props.slideshowInterval);
  }
}

function preloadImages(): void {
  const ids = imageIds.value;
  if (!ids.length) return;
  for (const id of [ids[imageIndex.value], ids[(imageIndex.value + 1) % ids.length]]) {
    if (!id) continue;
    const image = new Image();
    image.src = mediaUrl('asset', id);
  }
}

function stopSlideshow(): void {
  if (slideshowTimer) clearInterval(slideshowTimer);
  slideshowTimer = null;
}

function stopVideo(): void {
  if (!video.value) return;
  releasePreview(props.film.id, video.value);
}

function onVideoError(): void {
  videoPreparing.value = false;
  console.error('[preview] video playback failed', {
    filmId: props.film.id,
    mediaErrorCode: video.value?.error?.code ?? null,
    mediaErrorMessage: video.value?.error?.message ?? null,
    usesOriginal: !props.film.previewAssetId && props.film.allowOriginalPreview,
  });
  fallbackToImages();
}

function onVideoPlaying(): void {
  videoPreparing.value = false;
}

function onVideoWaiting(): void {
  videoPreparing.value = true;
}

async function openOriginal(): Promise<void> {
  const result = await window.filmLibrary.films.open(props.film.id);
  if (!result.ok) ElMessage.error(result.error.message);
}

function openDetails(): void {
  emit('select', props.film);
}

async function toggleFavorite(): Promise<void> {
  if (favoriteSaving.value) return;
  const nextValue = !favorite.value;
  favorite.value = nextValue;
  favoriteSaving.value = true;
  try {
    const result = await window.filmLibrary.films.updateFavorite(props.film.id, nextValue);
    if (!result.ok) throw new Error(result.error.message);
    emit('updated');
  } catch (error) {
    favorite.value = !nextValue;
    ElMessage.error(error instanceof Error ? error.message : '收藏保存失败');
  } finally {
    favoriteSaving.value = false;
  }
}

onMounted(() => {
  window.addEventListener('scroll', closeForViewportChange, true);
  window.addEventListener('resize', closeForViewportChange);
  window.addEventListener('hashchange', closeForViewportChange);
  window.addEventListener('popstate', closeForViewportChange);
  void positionPopup();
  void startPreview();
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', closeForViewportChange, true);
  window.removeEventListener('resize', closeForViewportChange);
  window.removeEventListener('hashchange', closeForViewportChange);
  window.removeEventListener('popstate', closeForViewportChange);
  stopSlideshow();
  stopVideo();
  popup.value = null;
  video.value = null;
});
</script>

<template>
  <Teleport to="body">
    <section ref="popup" class="film-hover-popup" :style="popupStyle" @mouseenter="$emit('enter')" @mouseleave="$emit('leave')">
      <div class="popup-media">
        <video v-if="mode === 'video'" ref="video" muted loop playsinline preload="metadata" @playing="onVideoPlaying" @waiting="onVideoWaiting" @error="onVideoError" />
        <div v-if="mode === 'video' && videoPreparing" class="preview-preparing"><span />正在准备视频预览…</div>
        <img v-else-if="mode === 'slideshow' && currentImageUrl" :src="currentImageUrl" :alt="film.title" />
        <div v-else class="popup-empty">暂无预览</div>
      </div>
      <div class="popup-content">
        <div class="popup-heading">
          <div class="popup-title" :title="film.title">{{ film.title }}</div>
          <span class="popup-status">{{ film.organizationState === 'organized' ? '已整理' : '未整理' }}</span>
        </div>
        <div class="popup-actions">
          <button type="button" class="popup-action popup-primary" @click.stop="openOriginal">播放原片</button>
          <button type="button" class="popup-action" @click.stop="openDetails">查看详情</button>
          <button type="button" class="popup-action popup-favorite" :class="{ active: favorite }" :disabled="favoriteSaving" :aria-pressed="favorite" @click.stop="toggleFavorite">{{ favorite ? '已收藏' : '收藏' }}</button>
        </div>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.film-hover-popup { position: fixed; z-index: 3000; box-sizing: border-box; max-width: calc(100vw - 24px); overflow: hidden; border: 1px solid rgba(255, 255, 255, .12); border-radius: 14px; color: var(--ink); background: #151923; box-shadow: 0 24px 60px rgba(0, 0, 0, .48); pointer-events: auto; }
.popup-media { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; }
.popup-media video, .popup-media img { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
.preview-preparing { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 9px; color: #d8dee8; background: rgba(0, 0, 0, .72); font-size: 12px; pointer-events: none; }
.preview-preparing span { width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.28); border-top-color: var(--accent); border-radius: 50%; animation: preview-spin .8s linear infinite; }
@keyframes preview-spin { to { transform: rotate(360deg); } }
.popup-empty { display: grid; width: 100%; height: 100%; place-items: center; color: var(--muted); font-size: 13px; }
.popup-content { padding: 12px 13px 13px; }
.popup-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.popup-title { min-width: 0; overflow: hidden; font-size: 14px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.popup-status { flex: 0 0 auto; color: var(--muted); font-size: 11px; }
.popup-actions { display: flex; gap: 7px; margin-top: 10px; }
.popup-action { min-width: 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 7px; color: var(--ink); background: #202633; cursor: pointer; font-size: 11px; }
.popup-action:hover { border-color: var(--accent); background: #293344; }
.popup-action:disabled { cursor: wait; opacity: .65; }
.popup-primary { border-color: var(--accent-strong); color: #07150f; background: var(--accent-strong); }
.popup-favorite.active { border-color: rgba(255, 217, 139, .55); color: #ffe1a1; }
</style>
