<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { DesktopSubtitleTrackDto, FilmDetailDto, FilmSegmentDto, VrViewDto } from '../../../shared/contracts';
import { mediaUrl } from '../../api';
import { useResonanceStore } from '../../stores/resonance';
import { DesktopPlaybackTracker, resumablePlayback } from '../../media/DesktopPlaybackTracker';
import { SphericalVideoRenderer } from '../../media/SphericalVideoRenderer';

const props = defineProps<{
  film: FilmDetailDto;
  segments: FilmSegmentDto[];
}>();

const emit = defineEmits<{
  positionChange: [currentSeconds: number, durationSeconds: number, partId: string];
  addToResonance: [];
  captureGif: [];
  fullscreenChange: [value: boolean];
  close: [];
}>();

interface FilmPlaybackSnapshot {
  partId: string;
  filename: string;
  currentSeconds: number;
  durationSeconds: number;
  width: number;
  height: number;
  isVr: boolean;
  vrView: VrViewDto | null;
}

type PlaybackSourceMode = 'direct' | 'compatibility';

const video = ref<HTMLVideoElement | null>(null);
const vrCanvas = ref<HTMLCanvasElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const stageSlot = ref<HTMLElement | null>(null);
const selectedPartId = ref('');
const currentSeconds = ref(0);
const durationSeconds = ref(0);
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
const nativeVideoFullscreen = ref(false);
const appFullscreen = ref(false);
const resonance = useResonanceStore();
const fullscreenButton = ref<HTMLButtonElement | null>(null);
const playbackOptionsVisible = ref(false);

function setAppFullscreen(value: boolean): void {
  playbackOptionsVisible.value = false;
  appFullscreen.value = value;
  resonance.playerFullscreen = value;
  if (value) resonance.expanded = false;
  emit('fullscreenChange', value);
  void nextTick(() => {
    fitPlayerToSlot();
    fullscreenButton.value?.focus({ preventScroll: true });
  });
}

function exitAppFullscreen(): boolean {
  if (!appFullscreen.value) return false;
  setAppFullscreen(false);
  return true;
}

function onFullscreenChange(): void {
  nativeVideoFullscreen.value = document.fullscreenElement === video.value && video.value !== null;
}

// A native video fullscreen excludes sibling overlays; use native cues there only.
watch(nativeVideoFullscreen, showSelectedTextTrack, { flush: 'post' });
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
let pendingResumeSeconds: number | null = null;
let openingResume: { partId: string; seconds: number } | null = null;
let trackedSource: { filmId: string; partId: string; started: boolean } | null = null;
let stopPlaybackFlush: (() => void) | null = null;
let playbackSaveErrorReported = false;
const playbackTracker = new DesktopPlaybackTracker(async (input) => {
  const result = await window.filmLibrary.films.savePlaybackProgress(input);
  if (!result.ok) throw new Error(result.error.message);
  playbackSaveErrorReported = false;
});

function reportPlaybackSaveError(): void {
  if (!playbackSaveErrorReported) ElMessage.warning('播放进度保存失败，将在下次保存时重试');
  playbackSaveErrorReported = true;
}

function savePlaybackPosition(force = false): Promise<void> {
  const element = video.value;
  if (!trackedSource?.started || !element || element.readyState < 1 || !Number.isFinite(element.currentTime)) return playbackTracker.flush();
  return playbackTracker.record({
    filmId: trackedSource.filmId, partId: trackedSource.partId,
    positionSeconds: element.currentTime,
    ...(Number.isFinite(element.duration) ? { durationSeconds: element.duration } : {}),
  }, force);
}

function onPlaying(): void {
  syncPlaybackState();
  if (trackedSource) trackedSource.started = true;
  void savePlaybackPosition(true).catch(reportPlaybackSaveError);
}

function onPaused(): void {
  syncPlaybackState();
  void savePlaybackPosition(true).catch(reportPlaybackSaveError);
}

async function flushPlaybackPosition(): Promise<void> {
  await savePlaybackPosition(true);
}

function restartPlayback(): void {
  pendingResumeSeconds = null;
  resumeAfterFallbackSeconds = null;
  activeSegment.value = null;
  const element = video.value;
  if (!element || element.readyState < 1) return;
  element.currentTime = 0;
  currentSeconds.value = 0;
  void savePlaybackPosition(true).catch(reportPlaybackSaveError);
  void element.play().catch(() => undefined);
}

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
const currentSegments = computed(() => selectedPartSegments.value.filter((segment) => currentSeconds.value >= segment.startSeconds && currentSeconds.value < segment.endSeconds));
const supportedSubtitleTracks = computed(() => subtitleTracks.value.filter((track) => track.supported));

watch(() => props.film.id, () => {
  partVrModes.value = new Map(props.film.parts.map((part) => [part.id, part.isVr]));
  mediaActive.value = true;
  playbackSourceMode.value = 'direct';
  compatibilityReady.value = false;
  playbackError.value = '';
  openingResume = resumablePlayback(props.film.playbackState, props.film.parts);
  selectedPartId.value = openingResume?.partId ?? availableParts.value[0]?.id ?? '';
  currentSeconds.value = 0;
  durationSeconds.value = 0;
  activeSegment.value = null;
  intrinsicSize.value = { width: 0, height: 0 };
  stageSize.value = { width: '100%', height: '100%' };
  fittedSize.value = { width: '100%', height: '100%' };
}, { immediate: true });

watch(selectedPartId, (partId, previousPartId) => {
  void savePlaybackPosition(true).catch(reportPlaybackSaveError);
  trackedSource = { filmId: props.film.id, partId, started: false };
  pendingResumeSeconds = openingResume?.partId === partId ? openingResume.seconds : null;
  openingResume = null;
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
  if (element && pendingResumeSeconds !== null && resumeAfterFallbackSeconds === null && !activeSegment.value) {
    const target = pendingResumeSeconds;
    pendingResumeSeconds = null;
    element.currentTime = target < element.duration - 1 ? target : 0;
    currentSeconds.value = element.currentTime;
  }
  if (element && resumeAfterFallbackSeconds !== null) {
    element.currentTime = Math.max(0, Math.min(element.duration || Number.POSITIVE_INFINITY, resumeAfterFallbackSeconds));
    const shouldResume = resumeAfterFallbackPlayback;
    resumeAfterFallbackSeconds = null;
    resumeAfterFallbackPlayback = false;
    if (shouldResume) void element.play().catch(() => undefined);
  }
  if (element) currentSeconds.value = element.currentTime;
  syncPlaybackState();
  emitPosition();
}

function onPlaybackError(event: Event): void {
  const element = event.currentTarget as HTMLVideoElement;
  if (!mediaActive.value || !selectedPartId.value) return;
  if (playbackSourceMode.value === 'direct') {
    const expectedSource = mediaUrl('original-part', selectedPartId.value);
    if (element.currentSrc && element.currentSrc !== expectedSource && element.getAttribute('src') !== expectedSource) return;
    resumeAfterFallbackSeconds = pendingResumeSeconds ?? (Number.isFinite(element.currentTime) ? element.currentTime : currentSeconds.value);
    pendingResumeSeconds = null;
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
  const { width: intrinsicWidth, height: intrinsicHeight } = intrinsicSize.value;
  const aspectRatio = appFullscreen.value && !vrEnabled.value && intrinsicWidth && intrinsicHeight
    ? intrinsicWidth / intrinsicHeight
    : 16 / 9;
  const stageWidth = Math.max(1, Math.floor(Math.min(availableWidth, availableHeight * aspectRatio)));
  const stageHeight = Math.max(1, Math.floor(stageWidth / aspectRatio));
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
  if (trackedSource?.started) void savePlaybackPosition().catch(reportPlaybackSaveError);
  if (activeSegment.value && element.currentTime >= activeSegment.value.endSeconds) activeSegment.value = null;
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
  if (!rect.width) return;
  playbackGeneration += 1;
  pendingResumeSeconds = null;
  activeSegment.value = null;
  element.currentTime = Math.max(0, Math.min(Math.max(0, durationSeconds.value - .25), ((event.clientX - rect.left) / rect.width) * durationSeconds.value));
  currentSeconds.value = element.currentTime;
  emitPosition();
  void element.play().catch(() => undefined);
}

async function playOriginal(): Promise<void> {
  mediaActive.value = true;
  const generation = ++playbackGeneration;
  activeSegment.value = null;
  await nextTick();
  if (generation !== playbackGeneration) return;
  await video.value?.play().catch(() => undefined);
}

async function playSegment(segment: FilmSegmentDto): Promise<void> {
  mediaActive.value = true;
  await seekAndPlay(segment);
}

async function seekAndPlay(segment: FilmSegmentDto): Promise<void> {
  const generation = ++playbackGeneration;
  const sourceChanged = selectedPartId.value !== segment.filmFileId;
  selectedPartId.value = segment.filmFileId;
  activeSegment.value = segment;
  await nextTick();
  if (generation !== playbackGeneration) return;
  pendingResumeSeconds = null;
  applyVrView(segment.vrView);
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
  pendingResumeSeconds = null;
  if (!availableParts.value.some((part) => part.id === partId)) return;
  activeSegment.value = null;
  mediaActive.value = true;
  selectedPartId.value = partId;
}

function seekRelative(deltaSeconds: number): void {
  pendingResumeSeconds = null;
  const element = video.value;
  if (!element) return;
  activeSegment.value = null;
  element.currentTime = Math.max(0, Math.min(durationSeconds.value || Number.POSITIVE_INFINITY, element.currentTime + deltaSeconds));
  currentSeconds.value = element.currentTime;
  emitPosition();
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

function applyVrView(view: VrViewDto | null): void {
  if (!vrEnabled.value) return;
  if (view) sphericalRenderer?.setView(view);
  else sphericalRenderer?.resetView();
}

function getCurrentVrView(): VrViewDto | null {
  return vrEnabled.value ? sphericalRenderer?.getView() ?? null : null;
}

function toggleFullscreen(): void {
  setAppFullscreen(!appFullscreen.value);
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
  activeSegment.value = null;
  video.value?.pause();
  syncPlaybackState();
}

function releasePlayback(): void {
  void savePlaybackPosition(true).catch(reportPlaybackSaveError);
  exitAppFullscreen();
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
    isVr: vrEnabled.value,
    vrView: getCurrentVrView(),
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
    tracks[index]!.mode = index === tracks.length - 1
      ? (nativeVideoFullscreen.value ? 'showing' : 'hidden')
      : 'disabled';
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
    .map((cue) => (cue as VTTCue).getCueAsHTML().textContent || '')
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

defineExpose({ playSegment, playOriginal, selectPart, seekRelative, togglePlayback, stopPlayback, releasePlayback, getPlaybackSnapshot, getCurrentVrView, exitAppFullscreen });
onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('pagehide', persistPlaybackOnHide);
  stopPlaybackFlush = window.filmLibrary.films.onPlaybackFlush(flushPlaybackPosition);
});
function persistPlaybackOnHide(): void { void flushPlaybackPosition().catch(reportPlaybackSaveError); }
onBeforeUnmount(() => {
  stopPlaybackFlush?.();
  window.removeEventListener('pagehide', persistPlaybackOnHide);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  stageObserver?.disconnect();
  destroySphericalRenderer();
  releasePlayback();
});
</script>

<template>
  <section class="detail-player" :class="{ 'is-app-fullscreen': appFullscreen }">
    <div class="player-toolbar">
      <div class="player-context">
        <strong>原片播放器</strong>
        <span v-if="selectedPart" :title="selectedPart.filename">{{ selectedPart.filename }}</span>
        <small v-if="source" class="playback-mode-badge" :class="{ fallback: playbackSourceMode === 'compatibility' }">{{ playbackModeLabel }}</small>
      </div>
      <div class="player-actions">
        <el-select
          v-if="source"
          :model-value="selectedSubtitleIndex"
          class="subtitle-select"
          size="small"
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
        <button v-if="appFullscreen" type="button" class="app-playback-button" @click="togglePlayback">{{ isPlaying ? '暂停' : '播放' }}</button>
        <button ref="fullscreenButton" type="button" class="app-fullscreen-button player-toolbar-button" :aria-pressed="appFullscreen" :disabled="!source" @click="toggleFullscreen">{{ appFullscreen ? '退出全屏' : '应用内全屏' }}</button>
        <el-dropdown v-if="appFullscreen && vrEnabled" class="fullscreen-vr-menu" trigger="click" @command="($event: string) => $event === 'mute' ? toggleMute() : resetVrView()">
          <button type="button" class="app-playback-button" aria-label="VR 播放选项">⋯</button>
          <template #dropdown><el-dropdown-menu><el-dropdown-item command="mute">{{ isMuted ? '取消静音' : '静音' }}</el-dropdown-item><el-dropdown-item command="reset">视角复位</el-dropdown-item></el-dropdown-menu></template>
        </el-dropdown>
        <el-select v-if="appFullscreen && availableParts.length > 1" :model-value="selectedPartId" class="part-select" aria-label="选择影片文件" @change="selectPart">
          <el-option v-for="part in availableParts" :key="part.id" :label="`${part.partType.toUpperCase()} ${part.partNumber} · ${part.filename}`" :value="part.id" />
        </el-select>
        <button v-if="!appFullscreen" type="button" class="player-toolbar-button" :disabled="!source" @click="emit('addToResonance')">加入共鸣球</button>
        <el-popover v-if="!appFullscreen" v-model:visible="playbackOptionsVisible" placement="bottom-end" trigger="click" :width="280" popper-class="playback-options-popover">
          <template #reference><button type="button" class="player-toolbar-button" aria-label="更多播放选项" :aria-expanded="playbackOptionsVisible">更多 ▾</button></template>
          <div class="playback-options">
            <strong class="playback-options-heading">播放设置</strong>
            <div class="playback-setting">
              <span>视频模式</span>
              <el-select v-model="vrEnabled" class="settings-select" aria-label="是否 VR 视频" :loading="vrSaving" :disabled="vrSaving || !selectedPart" @change="saveVrMode">
                <el-option label="普通视频" :value="false" />
                <el-option label="360° VR" :value="true" />
              </el-select>
            </div>
            <div v-if="availableParts.length > 1" class="playback-setting">
              <span>影片文件</span>
              <el-select :model-value="selectedPartId" class="settings-select" aria-label="选择影片文件" @change="selectPart">
                <el-option v-for="part in availableParts" :key="part.id" :label="`${part.partType.toUpperCase()} ${part.partNumber} · ${part.filename}`" :value="part.id" />
              </el-select>
            </div>

          </div>
        </el-popover>
        <el-tooltip v-if="!appFullscreen" content="关闭详情" placement="bottom" :show-after="200">
          <button type="button" class="player-toolbar-button player-icon-button" aria-label="关闭详情" @click="emit('close')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        </el-tooltip>
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
          controlslist="nofullscreen"
          playsinline
          preload="metadata"
          @loadedmetadata="onLoadedMetadata"
          @error="onPlaybackError"
          @timeupdate="onTimeUpdate"
          @seeking="onTimeUpdate"
          @seeked="onTimeUpdate"
          @play="syncPlaybackState"
          @pause="onPaused"
          @playing="onPlaying"
          @ended="onPaused"
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
          <button type="button" @click="toggleFullscreen">{{ appFullscreen ? '退出全屏' : '应用内全屏' }}</button>
        </div>
        <p v-if="activeSubtitleText && !nativeVideoFullscreen" class="player-subtitle-overlay"><span>{{ activeSubtitleText }}</span></p>
        <div v-if="vrEnabled && vrRenderError" class="vr-render-error">{{ vrRenderError }}</div>
        <div v-if="playbackError" class="playback-error">{{ playbackError }}</div>
        <div v-if="currentSegments.length" class="active-segment-labels">
          <div v-for="segment in currentSegments" :key="segment.id" class="active-segment-label">
            <strong>{{ segment.title || '未命名片段' }}</strong>
            <span>{{ formatTime(segment.startSeconds) }} → {{ formatTime(segment.endSeconds) }}</span>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="player-unavailable">当前没有可播放的影片文件</div>

    <div v-if="source" class="player-timeline-row">
      <span class="timeline-time">{{ formatTime(currentSeconds) }}</span>
      <div class="segment-timeline" aria-label="播放进度，点击时间轴跳转" @click="seekTimeline">
        <el-tooltip
          v-for="segment in selectedPartSegments"
          :key="segment.id"
          :content="`${segment.title || '未命名片段'} · ${formatTime(segment.startSeconds)} → ${formatTime(segment.endSeconds)}`"
          placement="top"
          :show-after="100"
        >
          <span
            class="timeline-segment"
            :class="{ disabled: !segment.includeInPreview, active: currentSegments.some((current) => current.id === segment.id) }"
            :style="timelineStyle(segment)"
            :aria-label="segment.title || '未命名片段'"
          />
        </el-tooltip>
        <i :style="{ left: `${durationSeconds ? (currentSeconds / durationSeconds) * 100 : 0}%` }" />
      </div>
      <span class="timeline-time total-time">{{ formatTime(durationSeconds) }}</span>
      <div class="timeline-actions">
        <el-tooltip content="继续播放原片" placement="top" :show-after="200">
          <span class="timeline-action"><button type="button" class="timeline-icon-button" aria-label="继续播放原片" :disabled="!source" @click="playOriginal"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z" /></svg></button></span>
        </el-tooltip>
        <el-tooltip content="从头播放" placement="top" :show-after="200">
          <span class="timeline-action"><button type="button" class="timeline-icon-button" aria-label="从头播放" :disabled="!durationSeconds || currentSeconds <= 0" @click="restartPlayback"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /></svg></button></span>
        </el-tooltip>
        <el-tooltip content="截取 GIF" placement="top" :show-after="200">
          <span class="timeline-action"><button type="button" class="timeline-icon-button" aria-label="截取 GIF" :disabled="!selectedPart || !durationSeconds" @click="emit('captureGif')"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="m8.2 8.2 12 12M8.2 15.8 20 4" /></svg></button></span>
        </el-tooltip>
      </div>
    </div>
  </section>
</template>

<style scoped>
.detail-player { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; height: 100%; min-height: 0; gap: 5px; padding: 3px 0 7px; overflow: hidden; }
.player-toolbar { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: nowrap; }
.player-context { display: flex; flex: 1 1 0; min-width: 0; align-items: center; gap: 8px; }
.player-context strong { flex: 0 0 auto; font-size: 12px; }
.player-context span { max-width: clamp(100px, 22vw, 280px); overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.playback-mode-badge { flex: 0 0 auto; padding: 2px 6px; border: 1px solid rgba(122,211,167,.35); border-radius: 999px; color: #9be0bf; font-size: 9px; font-weight: 600; white-space: nowrap; }
.playback-mode-badge.fallback { border-color: rgba(238,188,105,.35); color: #efc47d; }
.player-actions { display: flex; flex: 0 0 auto; min-width: 0; align-items: center; justify-content: flex-end; flex-wrap: nowrap; gap: 6px; }
.player-actions :deep(.el-button) { margin-left: 0; }
.playback-options { display: grid; gap: 12px; }
.playback-options-heading { color: var(--ink); font-size: 12px; }
.playback-setting { display: grid; gap: 6px; }
.playback-setting > span { color: var(--muted); font-size: 11px; }
.settings-select { width: 100%; }
:global(.playback-options-popover.el-popover) { background: var(--panel-raised); border-color: var(--line); color: var(--ink); }
.part-select { width: min(320px, 32vw); }
.subtitle-select { flex: 0 0 auto; width: clamp(120px, 15vw, 180px); }
.player-actions .player-toolbar-button { display: inline-flex; height: 28px; min-height: 28px; padding: 0 10px; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,.16); border-radius: 6px; background: var(--panel-raised); color: var(--ink); font: inherit; font-size: 12px; line-height: 1; white-space: nowrap; cursor: pointer; }
.player-actions .player-toolbar-button:hover:not(:disabled), .player-actions .player-toolbar-button[aria-expanded="true"] { border-color: var(--accent); background: rgba(152,227,194,.1); color: var(--accent); }
.player-actions .player-toolbar-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.player-actions .player-toolbar-button:disabled { opacity: .45; cursor: not-allowed; }
.player-actions .subtitle-select :deep(.el-select__wrapper) { height: 28px; min-height: 28px; border-radius: 6px; }
.player-stage-slot { display: grid; width: 100%; height: 100%; min-height: 0; place-items: center; overflow: hidden; }
.player-stage { position: relative; display: grid; max-width: 100%; max-height: 100%; aspect-ratio: 16 / 9; place-items: center; overflow: hidden; border-radius: 9px; background: #050609; box-shadow: 0 16px 42px rgba(0, 0, 0, .28); }
.detail-player-video { display: block; min-width: 0; min-height: 0; max-width: 100%; max-height: 100%; flex: 0 0 auto; object-fit: contain !important; object-position: 50% 50%; background: #050609; }
.detail-player-video.vr-video-source { opacity: 0; pointer-events: none; }
.detail-player-video::cue { color: #fff; background: rgba(0, 0, 0, .72); font-size: var(--subtitle-font-size, 24px); line-height: 1.25; }
.vr-video-canvas { position: absolute; z-index: 1; inset: 0; display: block; width: 100%; height: 100%; cursor: grab; background: #000; }
.vr-video-canvas.dragging { cursor: grabbing; }
.vr-player-hint { position: absolute; z-index: 4; top: 10px; right: 10px; padding: 5px 8px; border-radius: 6px; color: rgba(255,255,255,.72); background: rgba(0,0,0,.48); font-size: 10px; pointer-events: none; }
.vr-player-controls { position: absolute; z-index: 4; right: 10px; bottom: 10px; left: 10px; display: flex; justify-content: center; gap: 6px; pointer-events: none; }
.vr-player-controls button { padding: 5px 9px; border: 1px solid rgba(255,255,255,.28); border-radius: 6px; color: #fff; background: rgba(0,0,0,.62); font: inherit; font-size: 10px; cursor: pointer; pointer-events: auto; }
.vr-player-controls button:hover, .vr-player-controls button:focus-visible { border-color: var(--accent); color: var(--accent); outline: none; }
.player-subtitle-overlay { position: absolute; z-index: 3; right: 5%; bottom: 48px; left: 5%; margin: 0; color: #fff; font-size: var(--subtitle-font-size, 24px); line-height: 1.35; text-align: center; text-shadow: 0 1px 3px #000, 0 1px 8px #000; white-space: pre-line; overflow-wrap: anywhere; pointer-events: none; }
.player-subtitle-overlay span { padding: 2px 6px; border-radius: 4px; background: rgba(0,0,0,.72); box-decoration-break: clone; }
.vr-render-error { position: absolute; z-index: 5; inset: 0; display: grid; padding: 20px; place-items: center; color: #ffb4b4; background: rgba(0,0,0,.82); font-size: 12px; text-align: center; }
.playback-error { position: absolute; z-index: 6; inset: 0; display: grid; padding: 20px; place-items: center; color: #ffb4b4; background: rgba(0,0,0,.86); font-size: 12px; text-align: center; }
.active-segment-labels { position: absolute; z-index: 2; top: 12px; left: 16px; right: 16px; display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-start; gap: 6px; pointer-events: none; }
.active-segment-label { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; box-sizing: border-box; max-width: 100%; padding: 6px 11px; border-radius: 7px; color: rgba(255,255,255,.94); background: rgba(0,0,0,.48); font-size: 11px; backdrop-filter: blur(4px); gap: 3px 9px; }
.active-segment-label strong { min-width: 0; overflow-wrap: anywhere; }
.active-segment-label span { white-space: nowrap; }
.active-segment-label span { color: rgba(255,255,255,.72); font-variant-numeric: tabular-nums; }
.player-unavailable { display: grid; min-height: 320px; place-items: center; border-radius: 11px; color: var(--muted); background: #050609; }
.player-timeline-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 7px; }
.timeline-time { min-width: 62px; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.timeline-time.total-time { text-align: right; }
.timeline-actions { display: flex; align-items: center; gap: 4px; }
.timeline-action { display: inline-flex; }
.timeline-icon-button { display: inline-flex; width: 28px; height: 28px; padding: 5px; align-items: center; justify-content: center; border: 1px solid rgba(255,255,255,.16); border-radius: 6px; color: var(--ink); background: var(--panel-raised); cursor: pointer; }
.timeline-icon-button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: rgba(152,227,194,.1); }
.timeline-icon-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.timeline-icon-button:disabled { opacity: .45; cursor: not-allowed; }
.timeline-icon-button svg, .player-icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.player-actions .player-icon-button { width: 28px; padding: 5px; }
.segment-timeline { position: relative; height: 18px; overflow: hidden; border-radius: 999px; background: #202630; cursor: pointer; }
.timeline-segment { position: absolute; z-index: 1; top: 3px; min-width: 4px; height: 12px; padding: 0; border: 0; border-radius: 4px; background: var(--accent); opacity: .9; cursor: pointer; }
.timeline-segment:hover, .timeline-segment:focus-visible, .timeline-segment.active { z-index: 3; outline: 2px solid #fff; outline-offset: -2px; opacity: 1; }
.timeline-segment.disabled { opacity: .32; }
.segment-timeline i { position: absolute; z-index: 2; top: 0; bottom: 0; width: 2px; background: #fff; box-shadow: 0 0 5px #000; pointer-events: none; }
@media (max-width: 760px) {
  .player-toolbar { gap: 6px; }
  .player-context strong { display: none; }
  .part-select { width: 100%; }
  .subtitle-select { width: 120px; }
  .detail-player { height: auto; overflow: visible; }
  .player-stage { height: auto; aspect-ratio: 16 / 9; }
  .player-timeline-row { grid-template-columns: minmax(0, 1fr) auto; gap: 5px; }
  .timeline-time { display: none; }
}
.app-fullscreen-button, .app-playback-button { min-height: 32px; padding: 5px 12px; border: 1px solid var(--accent); border-radius: 6px; background: rgba(152,227,194,.1); color: var(--accent); font: inherit; font-size: 12px; cursor: pointer; touch-action: manipulation; }
.app-fullscreen-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.detail-player.is-app-fullscreen { position: fixed; z-index: 20; inset: 0; box-sizing: border-box; width: 100%; height: 100vh; height: 100dvh; padding: env(safe-area-inset-top) max(6px, env(safe-area-inset-right)) max(4px, env(safe-area-inset-bottom)) max(6px, env(safe-area-inset-left)); grid-template-rows: minmax(0, 1fr) 32px; grid-template-columns: auto minmax(48px, 1fr) auto auto minmax(70px, 130px) auto auto auto auto; align-items: center; gap: 4px 6px; overflow: hidden; background: #050609; }
.is-app-fullscreen .player-stage-slot { grid-column: 1 / -1; grid-row: 1; }
.is-app-fullscreen .player-toolbar, .is-app-fullscreen .player-actions, .is-app-fullscreen .player-timeline-row { display: contents; }
.is-app-fullscreen .player-context, .is-app-fullscreen .player-actions > :not(.app-fullscreen-button):not(.app-playback-button):not(.subtitle-select):not(.part-select):not(.fullscreen-vr-menu) { display: none; }
.is-app-fullscreen .player-stage { border-radius: 0; }
.is-app-fullscreen .timeline-time { display: inline; grid-row: 2; grid-column: 1; min-width: 0; font-size: 10px; }
.is-app-fullscreen .timeline-time.total-time { grid-column: 3; }
.is-app-fullscreen .segment-timeline { grid-row: 2; grid-column: 2; height: 20px; }
.is-app-fullscreen .timeline-segment { top: 4px; }
.is-app-fullscreen .timeline-actions { grid-row: 2; grid-column: 4; }
.is-app-fullscreen .subtitle-select { grid-row: 2; grid-column: 5; width: 100%; }
.is-app-fullscreen .app-playback-button { grid-row: 2; grid-column: 6; }
.is-app-fullscreen .part-select { grid-row: 2; grid-column: 7; width: 100px; }
.is-app-fullscreen .fullscreen-vr-menu { grid-row: 2; grid-column: 8; }
.is-app-fullscreen .app-fullscreen-button { grid-row: 2; grid-column: 9; }
.is-app-fullscreen .app-fullscreen-button, .is-app-fullscreen .app-playback-button { min-height: 28px; height: 28px; padding: 3px 8px; font-size: 11px; white-space: nowrap; }
.is-app-fullscreen .subtitle-select :deep(.el-select__wrapper), .is-app-fullscreen .part-select :deep(.el-select__wrapper) { min-height: 28px; padding-block: 0; }
.is-app-fullscreen .vr-player-controls { display: none; }
@media (max-width: 600px) {
  .detail-player.is-app-fullscreen { grid-template-columns: 0 minmax(48px, 1fr) 0 auto 74px auto auto auto auto; column-gap: 3px; }
  .is-app-fullscreen .timeline-time { visibility: hidden; overflow: hidden; }
  .is-app-fullscreen .part-select { width: 64px; }
}
@media (pointer: coarse) {
  .detail-player.is-app-fullscreen { grid-template-rows: minmax(0, 1fr) 36px; }
  .is-app-fullscreen .app-fullscreen-button, .is-app-fullscreen .app-playback-button { min-height: 36px; height: 36px; }
}
</style>
