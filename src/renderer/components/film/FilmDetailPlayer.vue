<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { DesktopSubtitleTrackDto, FilmDetailDto, FilmSegmentDto } from '../../../shared/contracts';
import { mediaUrl } from '../../api';
import { SphericalVideoRenderer } from '../../media/SphericalVideoRenderer';

const props = defineProps<{
  film: FilmDetailDto;
  segments: FilmSegmentDto[];
}>();

const emit = defineEmits<{
  positionChange: [currentSeconds: number, durationSeconds: number, partId: string];
  addToResonance: [];
}>();

interface FilmPlaybackSnapshot {
  partId: string;
  filename: string;
  currentSeconds: number;
  durationSeconds: number;
  width: number;
  height: number;
}

type PlaybackSourceMode = 'direct' | 'compatibility';

const video = ref<HTMLVideoElement | null>(null);
const vrCanvas = ref<HTMLCanvasElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const stageSlot = ref<HTMLElement | null>(null);
const selectedPartId = ref('');
const currentSeconds = ref(0);
const durationSeconds = ref(0);
const sequenceIndex = ref(-1);
const activeSegment = ref<FilmSegmentDto | null>(null);
const mediaActive = ref(true);
const playbackSourceMode = ref<PlaybackSourceMode>('direct');
const compatibilityReady = ref(false);
const playbackError = ref('');
const vrEnabled = ref(false);
const vrSaving = ref(false);
const vrRenderError = ref('');
const isPlaying = ref(false);
const isMuted = ref(false);
const activeSubtitleText = ref('');
const partVrModes = ref(new Map<string, boolean>());
const intrinsicSize = ref({ width: 0, height: 0 });
const stageSize = ref<{ width: string; height: string }>({ width: '100%', height: '100%' });
const fittedSize = ref<{ width: string; height: string }>({ width: '100%', height: '100%' });
const subtitleTracks = ref<DesktopSubtitleTrackDto[]>([]);
const selectedSubtitleIndex = ref('');
const subtitleUrl = ref('');
const subtitleBusy = ref(false);
const subtitleError = ref('');
let stageObserver: ResizeObserver | null = null;
let sphericalRenderer: SphericalVideoRenderer | null = null;
let playbackGeneration = 0;
let subtitleGeneration = 0;
let resumeAfterFallbackSeconds: number | null = null;
let resumeAfterFallbackPlayback = false;

const availableParts = computed(() => props.film.parts.filter((part) => !part.missing));
const selectedPart = computed(() => availableParts.value.find((part) => part.id === selectedPartId.value) ?? null);
const source = computed(() => {
  if (!mediaActive.value || !selectedPartId.value) return '';
  return mediaUrl(playbackSourceMode.value === 'direct' ? 'original-part' : 'part', selectedPartId.value);
});
const playbackModeLabel = computed(() => {
  if (playbackSourceMode.value === 'direct') return '原片直放';
  return compatibilityReady.value ? '兼容版本' : '正在准备兼容版本…';
});
const selectedPartSegments = computed(() => props.segments.filter((segment) => segment.filmFileId === selectedPartId.value));
const previewSegments = computed(() => props.segments.filter((segment) => segment.includeInPreview));
const supportedSubtitleTracks = computed(() => subtitleTracks.value.filter((track) => track.supported));

watch(() => props.film.id, () => {
  partVrModes.value = new Map(props.film.parts.map((part) => [part.id, part.isVr]));
  mediaActive.value = true;
  playbackSourceMode.value = 'direct';
  compatibilityReady.value = false;
  playbackError.value = '';
  selectedPartId.value = availableParts.value[0]?.id ?? '';
  currentSeconds.value = 0;
  durationSeconds.value = 0;
  sequenceIndex.value = -1;
  activeSegment.value = null;
  intrinsicSize.value = { width: 0, height: 0 };
  stageSize.value = { width: '100%', height: '100%' };
  fittedSize.value = { width: '100%', height: '100%' };
}, { immediate: true });

watch(selectedPartId, (partId, previousPartId) => {
  if (previousPartId) void window.filmLibrary.films.cancelPreview(previousPartId);
  mediaActive.value = true;
  playbackSourceMode.value = 'direct';
  compatibilityReady.value = false;
  playbackError.value = '';
  resumeAfterFallbackSeconds = null;
  resumeAfterFallbackPlayback = false;
  vrEnabled.value = partVrModes.value.get(partId) ?? false;
  vrRenderError.value = '';
  currentSeconds.value = 0;
  durationSeconds.value = 0;
  intrinsicSize.value = { width: 0, height: 0 };
  fittedSize.value = { width: '100%', height: '100%' };
  void loadSubtitleTracks();
  emitPosition();
}, { immediate: true });

watch(stageSlot, (nextSlot) => {
  stageObserver?.disconnect();
  stageObserver = null;
  if (!nextSlot) return;
  stageObserver = new ResizeObserver(() => fitPlayerToSlot());
  stageObserver.observe(nextSlot);
  void nextTick(fitVideoToStage);
});

watch([vrCanvas, video, vrEnabled], ([canvas, element, enabled]) => {
  destroySphericalRenderer();
  vrRenderError.value = '';
  if (!enabled || !canvas || !element) return;
  try {
    sphericalRenderer = new SphericalVideoRenderer(element, canvas, (message) => {
      vrRenderError.value = `VR 画面渲染失败：${message}`;
    });
  } catch (error) {
    vrRenderError.value = error instanceof Error && error.message === 'WEBGL_UNAVAILABLE'
      ? '当前设备未启用 WebGL，无法显示 VR 画面'
      : 'VR 播放器初始化失败';
  }
}, { flush: 'post' });

function onLoadedMetadata(): void {
  const element = video.value;
  durationSeconds.value = Number.isFinite(element?.duration) ? element!.duration : 0;
  intrinsicSize.value = {
    width: element?.videoWidth || 0,
    height: element?.videoHeight || 0,
  };
  fitVideoToStage();
  if (playbackSourceMode.value === 'compatibility') compatibilityReady.value = true;
  if (element && resumeAfterFallbackSeconds !== null) {
    element.currentTime = Math.max(0, Math.min(element.duration || Number.POSITIVE_INFINITY, resumeAfterFallbackSeconds));
    const shouldResume = resumeAfterFallbackPlayback;
    resumeAfterFallbackSeconds = null;
    resumeAfterFallbackPlayback = false;
    if (shouldResume) void element.play().catch(() => undefined);
  }
  syncPlaybackState();
  emitPosition();
}

function onPlaybackError(event: Event): void {
  const element = event.currentTarget as HTMLVideoElement;
  if (!mediaActive.value || !selectedPartId.value) return;
  if (playbackSourceMode.value === 'direct') {
    const expectedSource = mediaUrl('original-part', selectedPartId.value);
    if (element.currentSrc && element.currentSrc !== expectedSource && element.getAttribute('src') !== expectedSource) return;
    resumeAfterFallbackSeconds = Number.isFinite(element.currentTime) ? element.currentTime : currentSeconds.value;
    resumeAfterFallbackPlayback = !element.paused || activeSegment.value !== null;
    compatibilityReady.value = false;
    playbackError.value = '';
    playbackSourceMode.value = 'compatibility';
    ElMessage.info('原片无法直接播放，正在自动准备兼容版本');
    return;
  }
  playbackError.value = '兼容版本也无法播放，请尝试使用本地播放器';
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
  mediaActive.value = true;
  const generation = ++playbackGeneration;
  sequenceIndex.value = -1;
  activeSegment.value = null;
  await nextTick();
  if (generation !== playbackGeneration) return;
  await video.value?.play().catch(() => undefined);
}

async function playSegment(segment: FilmSegmentDto): Promise<void> {
  mediaActive.value = true;
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
  mediaActive.value = true;
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

function syncPlaybackState(): void {
  isPlaying.value = !(video.value?.paused ?? true);
  isMuted.value = video.value?.muted ?? false;
}

function toggleMute(): void {
  const element = video.value;
  if (!element) return;
  element.muted = !element.muted;
  syncPlaybackState();
}

function resetVrView(): void {
  sphericalRenderer?.resetView();
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await stage.value?.requestFullscreen();
}

async function saveVrMode(value: boolean): Promise<void> {
  const partId = selectedPartId.value;
  if (!partId || vrSaving.value) return;
  const previous = partVrModes.value.get(partId) ?? false;
  vrEnabled.value = value;
  vrSaving.value = true;
  const result = await window.filmLibrary.films.updatePartVr(partId, value);
  if (partId !== selectedPartId.value) {
    vrSaving.value = false;
    return;
  }
  if (!result.ok) {
    vrEnabled.value = previous;
    ElMessage.error(result.error.message);
  } else {
    partVrModes.value = new Map(partVrModes.value).set(partId, result.data.isVr);
    vrEnabled.value = result.data.isVr;
  }
  vrSaving.value = false;
}

function stopPlayback(): void {
  playbackGeneration += 1;
  sequenceIndex.value = -1;
  activeSegment.value = null;
  video.value?.pause();
  syncPlaybackState();
}

function releasePlayback(): void {
  stopPlayback();
  if (!mediaActive.value) return;
  const partId = selectedPartId.value;
  if (partId) void window.filmLibrary.films.cancelPreview(partId);
  mediaActive.value = false;
  resumeAfterFallbackSeconds = null;
  resumeAfterFallbackPlayback = false;
  subtitleGeneration += 1;
  resetSubtitleState();
  const element = video.value;
  if (!element) return;
  element.removeAttribute('src');
  element.load();
}

function getPlaybackSnapshot(): FilmPlaybackSnapshot | null {
  const part = selectedPart.value;
  if (!part) return null;
  const element = video.value;
  return {
    partId: part.id,
    filename: part.filename,
    currentSeconds: element?.currentTime ?? currentSeconds.value,
    durationSeconds: Number.isFinite(element?.duration) ? element!.duration : durationSeconds.value,
    width: element?.videoWidth || props.film.width || 16,
    height: element?.videoHeight || props.film.height || 9,
  };
}

async function loadSubtitleTracks(): Promise<void> {
  const partId = selectedPartId.value;
  const generation = ++subtitleGeneration;
  resetSubtitleState();
  if (!partId) return;
  subtitleBusy.value = true;
  const result = await window.filmLibrary.films.subtitleTracks(partId);
  if (generation !== subtitleGeneration || partId !== selectedPartId.value) return;
  subtitleBusy.value = false;
  if (!result.ok) {
    subtitleError.value = result.error.message;
    return;
  }
  subtitleTracks.value = result.data;
  const firstSupportedTrack = supportedSubtitleTracks.value[0];
  if (firstSupportedTrack) await selectSubtitle(String(firstSupportedTrack.index));
}

async function selectSubtitle(index: string): Promise<void> {
  const partId = selectedPartId.value;
  const generation = ++subtitleGeneration;
  selectedSubtitleIndex.value = index;
  subtitleError.value = '';
  releaseSubtitleUrl();
  disableTextTracks();
  if (!partId || !index) return;
  subtitleBusy.value = true;
  const result = await window.filmLibrary.films.subtitleContent(partId, Number(index));
  if (
    generation !== subtitleGeneration
    || partId !== selectedPartId.value
    || index !== selectedSubtitleIndex.value
  ) {
    return;
  }
  subtitleBusy.value = false;
  if (!result.ok) {
    subtitleError.value = result.error.message;
    selectedSubtitleIndex.value = '';
    return;
  }
  subtitleUrl.value = URL.createObjectURL(new Blob([result.data], { type: 'text/vtt;charset=utf-8' }));
  await nextTick();
  showSelectedTextTrack();
}

function subtitleLabel(track: DesktopSubtitleTrackDto): string {
  const details = [track.language, track.codec].filter(Boolean).join(' · ');
  return track.title || details || `字幕 ${track.index}`;
}

function selectedSubtitleLabel(): string {
  const track = supportedSubtitleTracks.value.find((item) => String(item.index) === selectedSubtitleIndex.value);
  return track ? subtitleLabel(track) : '字幕';
}

function showSelectedTextTrack(): void {
  const tracks = video.value?.textTracks;
  if (!tracks) return;
  for (let index = 0; index < tracks.length; index += 1) {
    tracks[index]!.mode = index === tracks.length - 1 ? 'showing' : 'disabled';
    tracks[index]!.oncuechange = index === tracks.length - 1
      ? () => updateActiveSubtitleText(tracks[index]!)
      : null;
  }
  const selected = tracks[tracks.length - 1];
  if (selected) updateActiveSubtitleText(selected);
}

function disableTextTracks(): void {
  const tracks = video.value?.textTracks;
  activeSubtitleText.value = '';
  if (!tracks) return;
  for (let index = 0; index < tracks.length; index += 1) {
    tracks[index]!.mode = 'disabled';
    tracks[index]!.oncuechange = null;
  }
}

function updateActiveSubtitleText(track: TextTrack): void {
  activeSubtitleText.value = Array.from(track.activeCues ?? [])
    .map((cue) => (cue as VTTCue).text || '')
    .filter(Boolean)
    .join('\n');
}

function resetSubtitleState(): void {
  subtitleTracks.value = [];
  selectedSubtitleIndex.value = '';
  subtitleBusy.value = false;
  subtitleError.value = '';
  disableTextTracks();
  releaseSubtitleUrl();
}

function releaseSubtitleUrl(): void {
  if (!subtitleUrl.value) return;
  URL.revokeObjectURL(subtitleUrl.value);
  subtitleUrl.value = '';
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

function destroySphericalRenderer(): void {
  sphericalRenderer?.dispose();
  sphericalRenderer = null;
}

defineExpose({ playSegment, playPreview, playOriginal, selectPart, seekRelative, togglePlayback, stopPlayback, releasePlayback, getPlaybackSnapshot });
onBeforeUnmount(() => {
  stageObserver?.disconnect();
  destroySphericalRenderer();
  releasePlayback();
});
</script>

<template>
  <section class="detail-player">
    <div class="player-toolbar">
      <div class="player-context">
        <strong>原片播放器</strong>
        <span v-if="selectedPart">{{ selectedPart.filename }}</span>
        <small v-if="source" class="playback-mode-badge" :class="{ fallback: playbackSourceMode === 'compatibility' }">{{ playbackModeLabel }}</small>
      </div>
      <div class="player-actions">
        <span class="vr-mode-label">是否 VR</span>
        <el-select v-model="vrEnabled" class="vr-mode-select" aria-label="是否 VR 视频" :loading="vrSaving" :disabled="vrSaving || !selectedPart" @change="saveVrMode">
          <el-option label="否" :value="false" />
          <el-option label="是（360°）" :value="true" />
        </el-select>
        <el-select
          v-if="source"
          :model-value="selectedSubtitleIndex"
          class="subtitle-select"
          aria-label="选择字幕"
          :disabled="subtitleBusy || !supportedSubtitleTracks.length"
          :loading="subtitleBusy"
          :placeholder="subtitleError || '关闭字幕'"
          @change="selectSubtitle"
        >
          <el-option
            :label="subtitleError ? '字幕加载失败' : subtitleBusy ? '正在加载字幕…' : subtitleTracks.length ? '关闭字幕' : '无可用字幕'"
            value=""
          />
          <el-option
            v-for="track in subtitleTracks"
            :key="track.index"
            :label="`${subtitleLabel(track)}${track.supported ? '' : '（不支持）'}`"
            :value="String(track.index)"
            :disabled="!track.supported"
          />
        </el-select>
        <el-select v-if="availableParts.length > 1" :model-value="selectedPartId" class="part-select" aria-label="选择影片文件" @change="selectPart">
          <el-option v-for="part in availableParts" :key="part.id" :label="`${part.partType.toUpperCase()} ${part.partNumber} · ${part.filename}`" :value="part.id" />
        </el-select>
        <el-button class="resonance-add-button" size="small" :disabled="!source" @click="emit('addToResonance')">添加进共鸣球</el-button>
        <el-button size="small" @click="playOriginal">继续播放原片</el-button>
        <el-button type="primary" size="small" :disabled="!previewSegments.length" @click="playPreview">连续播放精彩片段</el-button>
      </div>
    </div>

    <div v-if="source" ref="stageSlot" class="player-stage-slot">
      <div ref="stage" class="player-stage" :style="stageSize">
        <video
          ref="video"
          class="detail-player-video"
          :class="{ 'vr-video-source': vrEnabled }"
          crossorigin="anonymous"
          :src="source"
          :style="fittedSize"
          :data-video-width="intrinsicSize.width"
          :data-video-height="intrinsicSize.height"
          :controls="!vrEnabled"
          playsinline
          preload="metadata"
          @loadedmetadata="onLoadedMetadata"
          @error="onPlaybackError"
          @timeupdate="onTimeUpdate"
          @play="syncPlaybackState"
          @pause="syncPlaybackState"
          @volumechange="syncPlaybackState"
        >
          <track
            v-if="subtitleUrl"
            kind="subtitles"
            :src="subtitleUrl"
            srclang="und"
            :label="selectedSubtitleLabel()"
            default
            @load="showSelectedTextTrack"
          />
        </video>
        <canvas v-if="vrEnabled" ref="vrCanvas" class="vr-video-canvas" aria-label="360° VR 视频画面，拖动鼠标转动视角，滚轮缩放" />
        <div v-if="vrEnabled" class="vr-player-hint">拖动转动视角 · 滚轮缩放</div>
        <div v-if="vrEnabled" class="vr-player-controls">
          <button type="button" @click="togglePlayback">{{ isPlaying ? '暂停' : '播放' }}</button>
          <button type="button" @click="toggleMute">{{ isMuted ? '取消静音' : '静音' }}</button>
          <button type="button" @click="resetVrView">视角复位</button>
          <button type="button" @click="toggleFullscreen">全屏</button>
        </div>
        <p v-if="vrEnabled && activeSubtitleText" class="vr-subtitle-overlay">{{ activeSubtitleText }}</p>
        <div v-if="vrEnabled && vrRenderError" class="vr-render-error">{{ vrRenderError }}</div>
        <div v-if="playbackError" class="playback-error">{{ playbackError }}</div>
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
.playback-mode-badge { flex: 0 0 auto; padding: 2px 6px; border: 1px solid rgba(122,211,167,.35); border-radius: 999px; color: #9be0bf; font-size: 9px; font-weight: 600; white-space: nowrap; }
.playback-mode-badge.fallback { border-color: rgba(238,188,105,.35); color: #efc47d; }
.player-actions { display: flex; min-width: 0; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.part-select { width: min(320px, 32vw); }
.subtitle-select { width: min(210px, 22vw); }
.vr-mode-label { flex: 0 0 auto; color: var(--muted); font-size: 10px; }
.vr-mode-select { width: 108px; }
.resonance-add-button { --el-button-text-color: #b7f2da; --el-button-border-color: rgba(152,227,194,.42); --el-button-bg-color: rgba(54,115,94,.16); }
.player-stage-slot { display: grid; width: 100%; height: 100%; min-height: 0; place-items: center; overflow: hidden; }
.player-stage { position: relative; display: grid; max-width: 100%; max-height: 100%; aspect-ratio: 16 / 9; place-items: center; overflow: hidden; border-radius: 9px; background: #050609; box-shadow: 0 16px 42px rgba(0, 0, 0, .28); }
.detail-player-video { display: block; min-width: 0; min-height: 0; max-width: 100%; max-height: 100%; flex: 0 0 auto; object-fit: contain !important; object-position: 50% 50%; background: #050609; }
.detail-player-video.vr-video-source { opacity: 0; pointer-events: none; }
.detail-player-video::cue { color: #fff; background: rgba(0, 0, 0, .72); font-size: 55%; line-height: 1.25; }
.vr-video-canvas { position: absolute; z-index: 1; inset: 0; display: block; width: 100%; height: 100%; cursor: grab; background: #000; }
.vr-video-canvas.dragging { cursor: grabbing; }
.vr-player-hint { position: absolute; z-index: 4; top: 10px; right: 10px; padding: 5px 8px; border-radius: 6px; color: rgba(255,255,255,.72); background: rgba(0,0,0,.48); font-size: 10px; pointer-events: none; }
.vr-player-controls { position: absolute; z-index: 4; right: 10px; bottom: 10px; left: 10px; display: flex; justify-content: center; gap: 6px; pointer-events: none; }
.vr-player-controls button { padding: 5px 9px; border: 1px solid rgba(255,255,255,.28); border-radius: 6px; color: #fff; background: rgba(0,0,0,.62); font: inherit; font-size: 10px; cursor: pointer; pointer-events: auto; }
.vr-player-controls button:hover, .vr-player-controls button:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }
.vr-subtitle-overlay { position: absolute; z-index: 3; right: 12%; bottom: 48px; left: 12%; margin: 0; color: #fff; font-size: 15px; line-height: 1.35; text-align: center; text-shadow: 0 1px 3px #000, 0 1px 8px #000; white-space: pre-line; pointer-events: none; }
.vr-render-error { position: absolute; z-index: 5; inset: 0; display: grid; padding: 20px; place-items: center; color: #ffb4b4; background: rgba(0,0,0,.82); font-size: 12px; text-align: center; }
.playback-error { position: absolute; z-index: 6; inset: 0; display: grid; padding: 20px; place-items: center; color: #ffb4b4; background: rgba(0,0,0,.86); font-size: 12px; text-align: center; }
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
  .subtitle-select { width: 100%; }
  .detail-player { height: auto; overflow: visible; }
  .player-stage { height: auto; aspect-ratio: 16 / 9; }
  .player-timeline-row { grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .timeline-time { display: none; }
}
</style>
