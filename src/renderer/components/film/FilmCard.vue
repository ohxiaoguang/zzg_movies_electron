<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { VideoCamera } from '@element-plus/icons-vue';
import type { FilmSummaryDto } from '../../../shared/contracts';
import { mediaUrl } from '../../api';
import { claimPreview, releasePreview } from '../../composables/usePreviewManager';

const props = defineProps<{
  film: FilmSummaryDto;
  hoverDelay: number;
  slideshowInterval: number;
  width: number;
}>();
const emit = defineEmits<{ select: [film: FilmSummaryDto] }>();

const root = ref<HTMLElement | null>(null);
const video = ref<HTMLVideoElement | null>(null);
const hovered = ref(false);
const mode = ref<'poster' | 'video' | 'slideshow'>('poster');
const imageIndex = ref(0);
const posterFailed = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let slideshowTimer: ReturnType<typeof setInterval> | null = null;
let observer: IntersectionObserver | null = null;

const posterSource = computed(() => (props.film.posterAssetId ? mediaUrl('asset', props.film.posterAssetId) : null));
const slideshowSource = computed(() => {
  const assetId = props.film.previewImageAssetIds[imageIndex.value];
  return assetId ? mediaUrl('asset', assetId) : null;
});
const cardStyle = computed(() => ({ width: `${props.width}px` }));
const statusLabel = computed(() => ({ unorganized: '未整理', want: '想看', watching: '在看', watched: '已看' }[props.film.status]));

function enter(): void {
  hovered.value = true;
  if (releaseTimer) clearTimeout(releaseTimer);
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => void startPreview(), props.hoverDelay);
}

function leave(): void {
  hovered.value = false;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = null;
  stopSlideshow();
  if (video.value) releasePreview(props.film.id, video.value);
  releaseTimer = setTimeout(() => resetVisual(), 300);
}

async function startPreview(): Promise<void> {
  if (!hovered.value) return;
  if (props.film.previewAssetId && video.value) {
    mode.value = 'video';
    claimPreview(props.film.id, video.value);
    video.value.src = mediaUrl('asset', props.film.previewAssetId);
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
  if (video.value) releasePreview(props.film.id, video.value);
  if (props.film.previewImageAssetIds.length) startSlideshow();
  else resetVisual();
}

function startSlideshow(): void {
  if (!hovered.value || !props.film.previewImageAssetIds.length) return;
  mode.value = 'slideshow';
  imageIndex.value = 0;
  preloadNextImage();
  stopSlideshow();
  if (props.film.previewImageAssetIds.length > 1) {
    slideshowTimer = setInterval(() => {
      if (!hovered.value) return;
      imageIndex.value = (imageIndex.value + 1) % props.film.previewImageAssetIds.length;
      preloadNextImage();
    }, props.slideshowInterval);
  }
}

function preloadNextImage(): void {
  const ids = props.film.previewImageAssetIds;
  const current = ids[imageIndex.value];
  const next = ids[(imageIndex.value + 1) % ids.length];
  for (const id of [current, next]) {
    if (id) {
      const image = new Image();
      image.src = mediaUrl('asset', id);
    }
  }
}

function stopSlideshow(): void {
  if (slideshowTimer) clearInterval(slideshowTimer);
  slideshowTimer = null;
}

function resetVisual(): void {
  mode.value = 'poster';
  imageIndex.value = 0;
  if (video.value) {
    releasePreview(props.film.id, video.value);
    video.value.removeAttribute('src');
    video.value.load();
  }
}

function onVideoError(): void {
  if (hovered.value) fallbackToImages();
}

function onPosterError(): void {
  posterFailed.value = true;
}

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (!entries[0]?.isIntersecting) {
      hovered.value = false;
      if (hoverTimer) clearTimeout(hoverTimer);
      stopSlideshow();
      if (video.value) releasePreview(props.film.id, video.value);
      resetVisual();
    }
  }, { threshold: 0.05 });
  if (root.value) observer.observe(root.value);
  void nextTick();
});

onBeforeUnmount(() => {
  if (hoverTimer) clearTimeout(hoverTimer);
  if (releaseTimer) clearTimeout(releaseTimer);
  stopSlideshow();
  observer?.disconnect();
  if (video.value) releasePreview(props.film.id, video.value);
});
</script>

<template>
  <article ref="root" class="film-card" :style="cardStyle" @mouseenter="enter" @mouseleave="leave" @click="emit('select', film)">
    <div class="film-poster">
      <div v-if="!posterSource || posterFailed" class="poster-placeholder">
        <VideoCamera :size="32" />
        <span>{{ film.title.slice(0, 1) }}</span>
      </div>
      <img v-else class="poster-image" :class="{ faded: mode !== 'poster' }" :src="posterSource" :alt="film.title" @error="onPosterError" />
      <img v-if="mode === 'slideshow' && slideshowSource" class="slideshow-image" :src="slideshowSource" :alt="film.title" />
      <video ref="video" class="preview-video" :class="{ active: mode === 'video' }" muted loop playsinline preload="metadata" @error="onVideoError" />
      <div class="film-card-topline">
        <el-tag v-if="film.missing" size="small" type="danger">缺失</el-tag>
        <span v-if="film.favorite" class="favorite-mark">★</span>
      </div>
      <div class="film-card-bottomline">
        <span v-if="statusLabel" class="status-chip">{{ statusLabel }}</span>
        <span v-if="film.rating > 0" class="rating-chip">★ {{ film.rating.toFixed(1) }}</span>
      </div>
    </div>
    <div class="film-card-info">
      <div class="film-card-title" :title="film.title">{{ film.title }}</div>
      <div class="film-card-meta"><span>{{ film.year || '—' }}</span><span>{{ film.sourceName }}</span></div>
    </div>
  </article>
</template>

<style scoped>
.film-card { cursor: pointer; min-width: 160px; transition: transform .25s ease, filter .25s ease; }
.film-card:hover { transform: translateY(-4px); filter: brightness(1.04); }
.film-poster { position: relative; aspect-ratio: 2 / 3; overflow: hidden; border-radius: 13px; background: #202532; box-shadow: 0 14px 32px rgba(0, 0, 0, .22); }
.poster-image, .slideshow-image, .preview-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: opacity .35s ease; }
.poster-image { opacity: 1; }
.poster-image.faded { opacity: 0; }
.slideshow-image { opacity: 1; animation: fade-in .4s ease; }
.preview-video { opacity: 0; pointer-events: none; }
.preview-video.active { opacity: 1; }
.poster-placeholder { display: flex; height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #778096; background: linear-gradient(155deg, #242a38, #171a24); }
.poster-placeholder span { color: #9fa7b8; font-size: 38px; font-weight: 800; }
.film-card-topline, .film-card-bottomline { position: absolute; right: 10px; left: 10px; display: flex; align-items: center; justify-content: space-between; }
.film-card-topline { top: 10px; }
.film-card-bottomline { bottom: 10px; }
.favorite-mark { color: #ffd98b; font-size: 19px; text-shadow: 0 2px 8px #000; }
.status-chip, .rating-chip { padding: 4px 7px; border-radius: 6px; color: #eef3f1; background: rgba(9, 12, 16, .68); font-size: 10px; backdrop-filter: blur(8px); }
.rating-chip { color: #ffe1a1; }
.film-card-info { padding: 10px 2px 4px; }
.film-card-title { overflow: hidden; color: var(--ink); font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.film-card-meta { display: flex; justify-content: space-between; gap: 10px; margin-top: 5px; overflow: hidden; color: var(--muted); font-size: 11px; }
.film-card-meta span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
</style>
