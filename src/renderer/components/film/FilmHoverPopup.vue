<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { FilmSegmentDto, FilmSummaryDto } from '../../../shared/contracts';
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
type PreviewChannel = 'highlights' | 'comments' | 'stills';

const popup = ref<HTMLElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
const hasVideoPreview = computed(() => props.film.highlightSegmentCount > 0);
const initialChannel = (): PreviewChannel => hasVideoPreview.value ? 'highlights' : props.film.commentImageCount ? 'comments' : 'stills';
const activeChannel = ref<PreviewChannel>(initialChannel());
const mode = ref<PreviewMode>('empty');
const imageIndex = ref(0);
const popupWidth = ref(520);
const commentAspectRatio = ref<number | null>(null);
const position = ref<PopupPosition>({ left: 12, top: 12 });
const favorite = ref(props.film.favorite);
const favoriteSaving = ref(false);
const videoPreparing = ref(hasVideoPreview.value);
const highlightSegments = ref<FilmSegmentDto[]>([]);
const segmentIndex = ref(-1);
const activeHighlight = computed(() => highlightSegments.value[segmentIndex.value] ?? null);
let slideshowTimer: ReturnType<typeof setInterval> | null = null;
let highlightPlaybackGeneration = 0;

const imageIds = computed(() => activeChannel.value === 'comments' ? props.film.commentImageAssetIds : props.film.previewImageAssetIds);
const currentImageUrl = computed(() => {
  const id = imageIds.value[imageIndex.value];
  return id ? mediaUrl('asset', id) : null;
});
const popupStyle = computed(() => ({
  left: `${position.value.left}px`,
  top: `${position.value.top}px`,
  width: `${popupWidth.value}px`,
}));
const mediaStyle = computed(() => activeChannel.value === 'comments' && commentAspectRatio.value
  ? { aspectRatio: String(commentAspectRatio.value) }
  : undefined);

watch(() => props.film.favorite, (value) => { favorite.value = value; });

function closeForViewportChange(): void {
  emit('close');
}

function calculateWidth(): number {
  const available = window.innerWidth - 24;
  if (activeChannel.value === 'comments' && commentAspectRatio.value) {
    return Math.min(1000, available, Math.max(520, commentAspectRatio.value * 220));
  }
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
  await activateChannel(initialChannel());
}

async function activateChannel(channel: PreviewChannel): Promise<void> {
  if (channel === 'highlights' && !hasVideoPreview.value) return;
  if (channel === 'comments' && !props.film.commentImageCount) return;
  if (channel === 'stills' && !props.film.previewImageAssetIds.length) return;
  stopSlideshow();
  stopVideo();
  activeChannel.value = channel;
  if (channel !== 'comments') commentAspectRatio.value = null;
  if (channel !== 'highlights') {
    startSlideshow();
    return;
  }
  mode.value = 'video';
  videoPreparing.value = true;
  await nextTick();
  if (!video.value) return;
  claimPreview(props.film.id, video.value);
  const result = await window.filmLibrary.films.detail(props.film.id);
  if (result.ok) {
    highlightSegments.value = result.data.segments.filter((segment) => segment.includeInPreview);
    if (highlightSegments.value.length) {
      await playHighlight(0).catch(fallbackToImages);
      return;
    }
  }
  fallbackToImages();
}

async function playHighlight(index: number): Promise<void> {
  const element = video.value;
  if (!element || !highlightSegments.value.length) return;
  const playbackGeneration = ++highlightPlaybackGeneration;
  const nextIndex = index % highlightSegments.value.length;
  const segment = highlightSegments.value[nextIndex]!;
  segmentIndex.value = nextIndex;
  videoPreparing.value = true;
  element.src = mediaUrl('part', segment.filmFileId);
  element.load();
  try {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = (): void => { cleanup(); resolve(); };
      const onError = (): void => { cleanup(); reject(new Error('SEGMENT_MEDIA_FAILED')); };
      const cleanup = (): void => {
        element.removeEventListener('loadedmetadata', onLoaded);
        element.removeEventListener('error', onError);
      };
      element.addEventListener('loadedmetadata', onLoaded, { once: true });
      element.addEventListener('error', onError, { once: true });
    });
  } catch (error) {
    if (playbackGeneration !== highlightPlaybackGeneration) return;
    throw error;
  }
  if (playbackGeneration !== highlightPlaybackGeneration || element !== video.value) return;
  element.currentTime = segment.startSeconds;
  await element.play();
}

function onVideoTimeUpdate(): void {
  const element = video.value;
  const segment = highlightSegments.value[segmentIndex.value];
  if (!element || !segment || element.currentTime + 0.05 < segment.endSeconds) return;
  void playHighlight(segmentIndex.value + 1).catch(fallbackToImages);
}

function fallbackToImages(): void {
  stopVideo();
  if (props.film.commentImageCount) void activateChannel('comments');
  else if (props.film.previewImageAssetIds.length) void activateChannel('stills');
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
  scheduleSlideshow();
}

function scheduleSlideshow(): void {
  stopSlideshow();
  if (imageIds.value.length > 1) {
    slideshowTimer = setInterval(() => {
      imageIndex.value = (imageIndex.value + 1) % imageIds.value.length;
      preloadImages();
    }, props.slideshowInterval);
  }
}

function selectImage(index: number): void {
  if (index < 0 || index >= imageIds.value.length) return;
  imageIndex.value = index;
  preloadImages();
  scheduleSlideshow();
}

function onPreviewImageLoad(event: Event): void {
  if (activeChannel.value !== 'comments') return;
  const element = event.currentTarget as HTMLImageElement;
  if (!element.naturalWidth || !element.naturalHeight) return;
  commentAspectRatio.value = element.naturalWidth / element.naturalHeight;
  void positionPopup();
}

function selectHighlight(index: number): void {
  if (index < 0 || index >= highlightSegments.value.length) return;
  void playHighlight(index).catch(fallbackToImages);
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
  highlightPlaybackGeneration += 1;
  if (!video.value) return;
  highlightSegments.value = [];
  segmentIndex.value = -1;
  releasePreview(props.film.id, video.value);
}

function onVideoError(): void {
  videoPreparing.value = false;
  console.error('[preview] video playback failed', {
    filmId: props.film.id,
    mediaErrorCode: video.value?.error?.code ?? null,
    mediaErrorMessage: video.value?.error?.message ?? null,
  });
  fallbackToImages();
}

function onVideoPlaying(): void {
  videoPreparing.value = false;
}

function onVideoWaiting(): void {
  videoPreparing.value = true;
}

function formatTime(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
}

async function openOriginal(): Promise<void> {
  const result = await window.filmLibrary.films.open(props.film.id);
  if (!result.ok) ElMessage.error(result.error.message);
}

async function showInFolder(): Promise<void> {
  const result = await window.filmLibrary.films.showInFolder(props.film.id);
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
      <div class="popup-media" :class="{ 'popup-media-image': mode !== 'video', 'popup-media-comment': activeChannel === 'comments' }" :style="mediaStyle">
        <video v-if="mode === 'video'" ref="video" muted :loop="!highlightSegments.length" playsinline preload="metadata" @playing="onVideoPlaying" @waiting="onVideoWaiting" @timeupdate="onVideoTimeUpdate" @error="onVideoError" />
        <img v-else-if="mode === 'slideshow' && currentImageUrl" :src="currentImageUrl" :alt="film.title" @load="onPreviewImageLoad" />
        <div v-else class="popup-empty">暂无预览</div>
        <div class="preview-channels" aria-label="预览内容切换">
          <button type="button" :class="{ active: activeChannel === 'highlights' }" :disabled="!film.highlightSegmentCount" @click.stop="activateChannel('highlights')">精彩片段</button>
          <button type="button" :class="{ active: activeChannel === 'comments' }" :disabled="!film.commentImageCount" @click.stop="activateChannel('comments')">评论</button>
          <button type="button" :class="{ active: activeChannel === 'stills' }" :disabled="!film.previewImageAssetIds.length" @click.stop="activateChannel('stills')">剧照</button>
        </div>
        <div v-if="mode === 'video' && activeHighlight" class="segment-preview-label">
          <strong>{{ activeHighlight.title || '未命名片段' }}</strong>
          <span>{{ formatTime(activeHighlight.startSeconds) }} → {{ formatTime(activeHighlight.endSeconds) }}</span>
        </div>
        <div v-if="mode === 'video' && videoPreparing" class="preview-preparing"><span />正在准备视频预览…</div>
        <div v-if="mode === 'slideshow' && imageIds.length > 1" class="preview-pagination" aria-label="预览图片切换">
          <button v-for="(_imageId, index) in imageIds" :key="_imageId" type="button" class="preview-dot" :class="{ active: imageIndex === index }" :aria-label="`显示第 ${index + 1} 张预览图`" :aria-current="imageIndex === index ? 'true' : undefined" @click.stop="selectImage(index)" />
        </div>
        <div v-if="mode === 'video' && highlightSegments.length > 1" class="preview-pagination" aria-label="预览片段切换">
          <button v-for="(segment, index) in highlightSegments" :key="segment.id" type="button" class="preview-dot" :class="{ active: segmentIndex === index }" :aria-label="`播放第 ${index + 1} 个预览片段${segment.title ? `：${segment.title}` : ''}`" :aria-current="segmentIndex === index ? 'true' : undefined" @click.stop="selectHighlight(index)" />
        </div>
      </div>
      <div class="popup-content">
        <div class="popup-heading">
          <div class="popup-title" :title="film.title">{{ film.title }}</div>
          <span class="popup-status">{{ film.organizationState === 'organized' ? '已整理' : '未整理' }}</span>
        </div>
        <div class="popup-actions">
          <button type="button" class="popup-action popup-primary" @click.stop="openOriginal">播放原片</button>
          <button type="button" class="popup-action" @click.stop="showInFolder">打开文件位置</button>
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
.popup-media-image { aspect-ratio: 800 / 537; }
.popup-media video, .popup-media img { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
.popup-media-image img { object-fit: cover; }
.popup-media-comment img { object-fit: contain; }
.preview-channels { position: absolute; z-index: 5; top: 10px; left: 50%; display: flex; padding: 3px; border-radius: 8px; background: rgba(0,0,0,.62); transform: translateX(-50%); backdrop-filter: blur(6px); gap: 2px; }
.preview-channels button { padding: 5px 8px; border: 0; border-radius: 6px; color: rgba(255,255,255,.68); background: transparent; cursor: pointer; font-size: 10px; white-space: nowrap; }
.preview-channels button.active { color: #0a1a13; background: var(--accent); }
.preview-channels button:disabled { cursor: not-allowed; opacity: .32; }
.preview-pagination { position: absolute; z-index: 3; bottom: 10px; left: 50%; display: flex; align-items: center; max-width: calc(100% - 28px); padding: 6px 8px; border-radius: 999px; background: rgba(0, 0, 0, .46); transform: translateX(-50%); gap: 7px; }
.preview-dot { width: 8px; height: 8px; padding: 0; border: 1px solid rgba(255, 255, 255, .5); border-radius: 50%; background: rgba(255, 255, 255, .3); cursor: pointer; transition: border-color .15s ease, background-color .15s ease, transform .15s ease; }
.preview-dot:hover, .preview-dot:focus-visible { border-color: #fff; background: rgba(255, 255, 255, .72); outline: none; transform: scale(1.2); }
.preview-dot.active { border-color: #fff; background: #fff; transform: scale(1.2); }
.segment-preview-label { position: absolute; z-index: 2; top: 48px; left: 50%; display: flex; max-width: calc(100% - 28px); padding: 5px 10px; border-radius: 6px; color: rgba(255,255,255,.9); background: rgba(0,0,0,.48); font-size: 11px; line-height: 1.35; transform: translateX(-50%); backdrop-filter: blur(3px); gap: 8px; pointer-events: none; }
.segment-preview-label strong, .segment-preview-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.segment-preview-label strong { max-width: 250px; }
.segment-preview-label span { color: rgba(255,255,255,.72); font-variant-numeric: tabular-nums; }
.preview-preparing { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 9px; color: #d8dee8; background: rgba(0, 0, 0, .72); font-size: 12px; pointer-events: none; }
.preview-preparing span { width: 15px; height: 15px; border: 2px solid rgba(255,255,255,.28); border-top-color: var(--accent); border-radius: 50%; animation: preview-spin .8s linear infinite; }
@keyframes preview-spin { to { transform: rotate(360deg); } }
.popup-empty { display: grid; width: 100%; height: 100%; place-items: center; color: var(--muted); font-size: 13px; }
.popup-content { padding: 12px 13px 13px; }
.popup-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.popup-title { min-width: 0; overflow: hidden; font-size: 14px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.popup-status { flex: 0 0 auto; color: var(--muted); font-size: 11px; }
.popup-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.popup-action { min-width: 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 7px; color: var(--ink); background: #202633; cursor: pointer; font-size: 11px; }
.popup-action:hover { border-color: var(--accent); background: #293344; }
.popup-action:disabled { cursor: wait; opacity: .65; }
.popup-primary { border-color: var(--accent-strong); color: #07150f; background: var(--accent-strong); }
.popup-favorite.active { border-color: rgba(255, 217, 139, .55); color: #ffe1a1; }
</style>
