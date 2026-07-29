<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { FilmDetailDto, FilmSegmentDto } from '../../../shared/contracts';
import { mediaUrl } from '../../api';

const props = defineProps<{
  film: FilmDetailDto;
  segments: FilmSegmentDto[];
}>();

const emit = defineEmits<{
  positionChange: [currentSeconds: number, durationSeconds: number, partId: string];
}>();

const video = ref<HTMLVideoElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const stageSlot = ref<HTMLElement | null>(null);
const selectedPartId = ref('');
const currentSeconds = ref(0);
const durationSeconds = ref(0);
const sequenceIndex = ref(-1);
const activeSegment = ref<FilmSegmentDto | null>(null);
const intrinsicSize = ref({ width: 0, height: 0 });
const stageSize = ref<{ width: string; height: string }>({ width: '100%', height: '100%' });
const fittedSize = ref<{ width: string; height: string }>({ width: '100%', height: '100%' });
let stageObserver: ResizeObserver | null = null;
let playbackGeneration = 0;

const availableParts = computed(() => props.film.parts.filter((part) => !part.missing));
const selectedPart = computed(() => availableParts.value.find((part) => part.id === selectedPartId.value) ?? null);
const source = computed(() => selectedPartId.value ? mediaUrl('part', selectedPartId.value) : '');
const selectedPartSegments = computed(() => props.segments.filter((segment) => segment.filmFileId === selectedPartId.value));
const previewSegments = computed(() => props.segments.filter((segment) => segment.includeInPreview));

watch(() => props.film.id, () => {
  selectedPartId.value = availableParts.value[0]?.id ?? '';
  currentSeconds.value = 0;
  durationSeconds.value = 0;
  sequenceIndex.value = -1;
  activeSegment.value = null;
  intrinsicSize.value = { width: 0, height: 0 };
  stageSize.value = { width: '100%', height: '100%' };
  fittedSize.value = { width: '100%', height: '100%' };
}, { immediate: true });

watch(selectedPartId, () => {
  currentSeconds.value = 0;
  durationSeconds.value = 0;
  intrinsicSize.value = { width: 0, height: 0 };
  fittedSize.value = { width: '100%', height: '100%' };
  emitPosition();
});

watch(stageSlot, (nextSlot) => {
  stageObserver?.disconnect();
  stageObserver = null;
  if (!nextSlot) return;
  stageObserver = new ResizeObserver(() => fitPlayerToSlot());
  stageObserver.observe(nextSlot);
  void nextTick(fitVideoToStage);
});

function onLoadedMetadata(): void {
  const element = video.value;
  durationSeconds.value = Number.isFinite(element?.duration) ? element!.duration : 0;
  intrinsicSize.value = {
    width: element?.videoWidth || 0,
    height: element?.videoHeight || 0,
  };
  fitVideoToStage();
  emitPosition();
}

function fitVideoToStage(): void {
  fitPlayerToSlot();
}

function fitPlayerToSlot(): void {
  const container = stageSlot.value;
  if (!container) return;
  const availableWidth = container.clientWidth;
  const availableHeight = container.clientHeight;
  if (!availableWidth || !availableHeight) return;
  const stageWidth = Math.max(1, Math.floor(Math.min(availableWidth, availableHeight * (16 / 9))));
  const stageHeight = Math.max(1, Math.floor(stageWidth * (9 / 16)));
  stageSize.value = { width: `${stageWidth}px`, height: `${stageHeight}px` };
  const { width: videoWidth, height: videoHeight } = intrinsicSize.value;
  if (!videoWidth || !videoHeight) {
    fittedSize.value = { width: '100%', height: '100%' };
    return;
  }
  const scale = Math.min(stageWidth / videoWidth, stageHeight / videoHeight);
  fittedSize.value = {
    width: `${Math.max(1, Math.floor(videoWidth * scale))}px`,
    height: `${Math.max(1, Math.floor(videoHeight * scale))}px`,
  };
}

function onTimeUpdate(): void {
  const element = video.value;
  if (!element) return;
  currentSeconds.value = element.currentTime;
  emitPosition();
  const segment = activeSegment.value;
  if (!segment || element.currentTime + 0.05 < segment.endSeconds) return;
  if (sequenceIndex.value >= 0) {
    void playSequenceItem(sequenceIndex.value + 1);
  } else {
    element.pause();
    activeSegment.value = null;
  }
}

function emitPosition(): void {
  emit('positionChange', currentSeconds.value, durationSeconds.value, selectedPartId.value);
}

function timelineStyle(segment: FilmSegmentDto): Record<string, string> {
  const duration = durationSeconds.value || Math.max(segment.endSeconds, 1);
  return {
    left: `${Math.min(100, (segment.startSeconds / duration) * 100)}%`,
    width: `${Math.max(0.4, Math.min(100, ((segment.endSeconds - segment.startSeconds) / duration) * 100))}%`,
  };
}

function seekTimeline(event: MouseEvent): void {
  const element = video.value;
  const target = event.currentTarget as HTMLElement;
  if (!element || !durationSeconds.value) return;
  const rect = target.getBoundingClientRect();
  sequenceIndex.value = -1;
  activeSegment.value = null;
  element.currentTime = Math.max(0, Math.min(durationSeconds.value, ((event.clientX - rect.left) / rect.width) * durationSeconds.value));
}

async function playOriginal(): Promise<void> {
  const generation = ++playbackGeneration;
  sequenceIndex.value = -1;
  activeSegment.value = null;
  await nextTick();
  if (generation !== playbackGeneration) return;
  await video.value?.play().catch(() => undefined);
}

async function playSegment(segment: FilmSegmentDto): Promise<void> {
  sequenceIndex.value = -1;
  await seekAndPlay(segment);
}

async function playPreview(): Promise<void> {
  if (!previewSegments.value.length) return;
  await playSequenceItem(0);
}

async function playSequenceItem(index: number): Promise<void> {
  if (index >= previewSegments.value.length) {
    sequenceIndex.value = -1;
    activeSegment.value = null;
    video.value?.pause();
    return;
  }
  sequenceIndex.value = index;
  await seekAndPlay(previewSegments.value[index]!);
}

async function seekAndPlay(segment: FilmSegmentDto): Promise<void> {
  const generation = ++playbackGeneration;
  const sourceChanged = selectedPartId.value !== segment.filmFileId;
  selectedPartId.value = segment.filmFileId;
  activeSegment.value = segment;
  await nextTick();
  if (generation !== playbackGeneration) return;
  const element = video.value;
  if (!element) return;
  if (sourceChanged || element.readyState < 1) await waitForMetadata(element);
  if (generation !== playbackGeneration) return;
  element.currentTime = segment.startSeconds;
  currentSeconds.value = segment.startSeconds;
  emitPosition();
  await element.play().catch(() => undefined);
}

function selectPart(partId: string): void {
  if (!availableParts.value.some((part) => part.id === partId)) return;
  sequenceIndex.value = -1;
  activeSegment.value = null;
  selectedPartId.value = partId;
}

function seekRelative(deltaSeconds: number): void {
  const element = video.value;
  if (!element) return;
  sequenceIndex.value = -1;
  activeSegment.value = null;
  element.currentTime = Math.max(0, Math.min(durationSeconds.value || Number.POSITIVE_INFINITY, element.currentTime + deltaSeconds));
}

function togglePlayback(): void {
  const element = video.value;
  if (!element) return;
  if (element.paused) void element.play();
  else element.pause();
}

function stopPlayback(): void {
  playbackGeneration += 1;
  sequenceIndex.value = -1;
  activeSegment.value = null;
  video.value?.pause();
}

function waitForMetadata(element: HTMLVideoElement): Promise<void> {
  if (element.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => element.addEventListener('loadedmetadata', () => resolve(), { once: true }));
}

function formatTime(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
}

defineExpose({ playSegment, playPreview, playOriginal, selectPart, seekRelative, togglePlayback, stopPlayback });
onBeforeUnmount(() => {
  stageObserver?.disconnect();
  stopPlayback();
});
</script>

<template>
  <section class="detail-player">
    <div class="player-toolbar">
      <div class="player-context">
        <strong>原片播放器</strong>
        <span v-if="selectedPart">{{ selectedPart.filename }}</span>
      </div>
      <div class="player-actions">
        <el-select v-if="availableParts.length > 1" :model-value="selectedPartId" class="part-select" aria-label="选择影片文件" @change="selectPart">
          <el-option v-for="part in availableParts" :key="part.id" :label="`${part.partType.toUpperCase()} ${part.partNumber} · ${part.filename}`" :value="part.id" />
        </el-select>
        <el-button size="small" @click="playOriginal">继续播放原片</el-button>
        <el-button type="primary" size="small" :disabled="!previewSegments.length" @click="playPreview">连续播放精彩片段</el-button>
      </div>
    </div>

    <div v-if="source" ref="stageSlot" class="player-stage-slot">
      <div ref="stage" class="player-stage" :style="stageSize">
        <video
          ref="video"
          class="detail-player-video"
          :src="source"
          :style="fittedSize"
          :data-video-width="intrinsicSize.width"
          :data-video-height="intrinsicSize.height"
          controls
          playsinline
          preload="metadata"
          @loadedmetadata="onLoadedMetadata"
          @timeupdate="onTimeUpdate"
        />
        <div v-if="activeSegment" class="active-segment-label">
          <strong>{{ activeSegment.title || '未命名片段' }}</strong>
          <span>{{ formatTime(activeSegment.startSeconds) }} → {{ formatTime(activeSegment.endSeconds) }}</span>
        </div>
      </div>
    </div>
    <div v-else class="player-unavailable">当前没有可播放的影片文件</div>

    <div v-if="source" class="player-timeline-row">
      <span class="timeline-time">{{ formatTime(currentSeconds) }}</span>
      <div class="segment-timeline" title="点击时间轴跳转" @click="seekTimeline">
        <button
          v-for="segment in selectedPartSegments"
          :key="segment.id"
          type="button"
          class="timeline-segment"
          :class="{ disabled: !segment.includeInPreview, active: activeSegment?.id === segment.id }"
          :style="timelineStyle(segment)"
          :title="`${segment.title || '未命名片段'} · ${formatTime(segment.startSeconds)} → ${formatTime(segment.endSeconds)}`"
          :aria-label="segment.title || '未命名片段'"
          @click.stop="playSegment(segment)"
        />
        <i :style="{ left: `${durationSeconds ? (currentSeconds / durationSeconds) * 100 : 0}%` }" />
      </div>
      <span class="timeline-time">{{ formatTime(durationSeconds) }}</span>
    </div>
  </section>
</template>

<style scoped>
.detail-player { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; min-height: 0; gap: 5px; padding: 3px 0 7px; overflow: hidden; }
.player-toolbar { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 14px; }
.player-context { display: flex; min-width: 0; align-items: center; gap: 8px; }
.player-context strong { flex: 0 0 auto; font-size: 12px; }
.player-context span { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.player-actions { display: flex; min-width: 0; align-items: center; justify-content: flex-end; gap: 6px; }
.part-select { width: min(320px, 32vw); }
.player-stage-slot { display: grid; width: 100%; height: 100%; min-height: 0; place-items: center; overflow: hidden; }
.player-stage { position: relative; display: grid; max-width: 100%; max-height: 100%; aspect-ratio: 16 / 9; place-items: center; overflow: hidden; border-radius: 9px; background: #050609; box-shadow: 0 16px 42px rgba(0, 0, 0, .28); }
.detail-player-video { display: block; min-width: 0; min-height: 0; max-width: 100%; max-height: 100%; flex: 0 0 auto; object-fit: contain !important; object-position: 50% 50%; background: #050609; }
.active-segment-label { position: absolute; z-index: 2; top: 12px; left: 50%; display: flex; max-width: calc(100% - 32px); padding: 6px 11px; border-radius: 7px; color: rgba(255,255,255,.94); background: rgba(0,0,0,.48); font-size: 11px; transform: translateX(-50%); backdrop-filter: blur(4px); gap: 9px; pointer-events: none; }
.active-segment-label strong, .active-segment-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.active-segment-label span { color: rgba(255,255,255,.72); font-variant-numeric: tabular-nums; }
.player-unavailable { display: grid; min-height: 320px; place-items: center; border-radius: 11px; color: var(--muted); background: #050609; }
.player-timeline-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 7px; }
.timeline-time { min-width: 62px; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.timeline-time:last-child { text-align: right; }
.segment-timeline { position: relative; height: 18px; overflow: hidden; border-radius: 999px; background: #202630; cursor: pointer; }
.timeline-segment { position: absolute; z-index: 1; top: 3px; min-width: 4px; height: 12px; padding: 0; border: 0; border-radius: 4px; background: var(--accent); opacity: .9; cursor: pointer; }
.timeline-segment:hover, .timeline-segment:focus-visible, .timeline-segment.active { z-index: 3; outline: 2px solid #fff; outline-offset: -2px; opacity: 1; }
.timeline-segment.disabled { opacity: .32; }
.segment-timeline i { position: absolute; z-index: 2; top: 0; bottom: 0; width: 2px; background: #fff; box-shadow: 0 0 5px #000; pointer-events: none; }
@media (max-width: 760px) {
  .player-toolbar { align-items: stretch; flex-direction: column; }
  .player-actions { justify-content: flex-start; flex-wrap: wrap; }
  .part-select { width: 100%; }
  .detail-player { height: auto; overflow: visible; }
  .player-stage { height: auto; aspect-ratio: 16 / 9; }
  .player-timeline-row { grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .timeline-time { display: none; }
}
</style>
