<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Close, Delete, VideoPause, VideoPlay } from '@element-plus/icons-vue';
import { mediaUrl } from '../../api';
import { computeResonanceLayout } from '../../composables/resonanceLayout';
import { SphericalVideoRenderer } from '../../media/SphericalVideoRenderer';
import { useResonanceStore, type ResonanceVideo } from '../../stores/resonance';

const resonance = useResonanceStore();
const stage = ref<HTMLElement | null>(null);
const stageSize = ref({ width: 0, height: 0 });
const playingIds = ref(new Set<string>());
const clearPending = ref(false);
const videoElements = new Map<string, HTMLVideoElement>();
const canvasElements = new Map<string, HTMLCanvasElement>();
const sphericalRenderers = new Map<string, SphericalVideoRenderer>();
const vrActiveIds = ref(new Set<string>());
let stageObserver: ResizeObserver | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let vrHydrationGeneration = 0;

const layout = computed(() => computeResonanceLayout(
  resonance.videos.map((item) => ({ id: item.id, aspectRatio: item.aspectRatio })),
  stageSize.value.width,
  stageSize.value.height,
  8,
));
const layoutById = computed(() => new Map(layout.value.map((rect) => [rect.id, rect])));
const allPlaying = computed(() => resonance.count > 0 && playingIds.value.size === resonance.count);

watch(stage, (element) => {
  stageObserver?.disconnect();
  stageObserver = null;
  if (!element) return;
  stageObserver = new ResizeObserver(([entry]) => {
    const box = entry?.contentRect;
    if (box) stageSize.value = { width: box.width, height: box.height };
  });
  stageObserver.observe(element);
  stageSize.value = { width: element.clientWidth, height: element.clientHeight };
});

watch(() => resonance.expanded, async (expanded) => {
  if (!expanded) {
    vrHydrationGeneration += 1;
    pauseAll();
    return;
  }
  await nextTick();
  stage.value?.focus();
  void hydrateLegacyVrModes();
});

function tileStyle(id: string): Record<string, string> {
  const rect = layoutById.value.get(id);
  if (!rect) return { visibility: 'hidden' };
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

function registerVideo(item: ResonanceVideo, element: unknown): void {
  if (element instanceof HTMLVideoElement) {
    videoElements.set(item.id, element);
    ensureSphericalRenderer(item);
  } else {
    destroySphericalRenderer(item.id);
    videoElements.delete(item.id);
  }
}

function registerCanvas(item: ResonanceVideo, element: unknown): void {
  if (element instanceof HTMLCanvasElement) {
    canvasElements.set(item.id, element);
    ensureSphericalRenderer(item);
  } else {
    destroySphericalRenderer(item.id);
    canvasElements.delete(item.id);
  }
}

function initializeVideo(item: ResonanceVideo, event: Event): void {
  const element = event.currentTarget as HTMLVideoElement;
  if (!item.isVr) resonance.updateAspectRatio(item.id, element.videoWidth, element.videoHeight);
  const duration = Number.isFinite(element.duration) ? element.duration : item.durationSeconds;
  const target = Math.min(Math.max(0, item.currentSeconds), Math.max(0, duration - 0.05));
  if (Math.abs(element.currentTime - target) > 0.1) element.currentTime = target;
  resonance.updateProgress(item.id, target, duration);
}

function trackProgress(item: ResonanceVideo, event: Event): void {
  const element = event.currentTarget as HTMLVideoElement;
  resonance.updateProgress(item.id, element.currentTime, element.duration);
}

function markPlaying(id: string, playing: boolean): void {
  const next = new Set(playingIds.value);
  if (playing) next.add(id);
  else next.delete(id);
  playingIds.value = next;
}

function toggleOne(id: string): void {
  const element = videoElements.get(id);
  if (!element) return;
  if (element.paused) void element.play().catch(() => undefined);
  else element.pause();
}

function toggleAll(): void {
  if (allPlaying.value) pauseAll();
  else playAll();
}

function playAll(): void {
  for (const element of videoElements.values()) void element.play().catch(() => undefined);
}

function pauseAll(): void {
  for (const element of videoElements.values()) element.pause();
}

function seekOne(item: ResonanceVideo, event: Event): void {
  const element = videoElements.get(item.id);
  if (!element) return;
  const target = Number((event.currentTarget as HTMLInputElement).value);
  if (!Number.isFinite(target)) return;
  element.currentTime = target;
  resonance.updateProgress(item.id, target, element.duration);
}

function removeVideo(id: string): void {
  videoElements.get(id)?.pause();
  destroySphericalRenderer(id);
  videoElements.delete(id);
  canvasElements.delete(id);
  markPlaying(id, false);
  resonance.remove(id);
}

function clearAll(): void {
  if (!clearPending.value) {
    clearPending.value = true;
    clearTimer = setTimeout(() => { clearPending.value = false; }, 3000);
    return;
  }
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  clearPending.value = false;
  pauseAll();
  for (const id of sphericalRenderers.keys()) destroySphericalRenderer(id);
  videoElements.clear();
  canvasElements.clear();
  playingIds.value = new Set();
  resonance.clear();
}

function ensureSphericalRenderer(item: ResonanceVideo): void {
  if (!item.isVr || sphericalRenderers.has(item.id)) return;
  const element = videoElements.get(item.id);
  const canvas = canvasElements.get(item.id);
  if (!element || !canvas) return;
  try {
    const renderer = new SphericalVideoRenderer(element, canvas, (message) => {
      console.error('[resonance] VR rendering failed', { id: item.id, message });
      window.setTimeout(() => {
        if (sphericalRenderers.get(item.id) !== renderer) return;
        destroySphericalRenderer(item.id, false);
      }, 0);
    });
    renderer.setView(item.vrView ?? { yawDegrees: 0, pitchDegrees: 0, fovDegrees: 75 });
    sphericalRenderers.set(item.id, renderer);
    setVrActive(item.id, true);
  } catch (error) {
    console.error('[resonance] VR player initialization failed', { id: item.id, error });
    setVrActive(item.id, false);
  }
}

function destroySphericalRenderer(id: string, persistView = true): void {
  const renderer = sphericalRenderers.get(id);
  if (renderer && persistView) resonance.updateVrView(id, renderer.getView());
  renderer?.dispose();
  sphericalRenderers.delete(id);
  setVrActive(id, false);
}

function setVrActive(id: string, active: boolean): void {
  const next = new Set(vrActiveIds.value);
  if (active) next.add(id);
  else next.delete(id);
  vrActiveIds.value = next;
}

async function hydrateLegacyVrModes(): Promise<void> {
  const generation = ++vrHydrationGeneration;
  const unknownVideos = resonance.videos.filter((item) => !item.vrModeKnown);
  await Promise.all(unknownVideos.map(async (item) => {
    const result = await window.filmLibrary.films.detail(item.filmId);
    if (generation !== vrHydrationGeneration || !result.ok) return;
    const part = result.data.parts.find((candidate) => candidate.id === item.partId);
    if (part) resonance.updateVrMode(item.id, part.isVr);
  }));
}

function formatTime(value: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function handleOverlayKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') resonance.expanded = false;
  else if (event.code === 'Space' && event.target === stage.value) {
    event.preventDefault();
    toggleAll();
  }
}

onBeforeUnmount(() => {
  stageObserver?.disconnect();
  if (clearTimer) clearTimeout(clearTimer);
  pauseAll();
  for (const id of sphericalRenderers.keys()) destroySphericalRenderer(id);
  videoElements.clear();
  canvasElements.clear();
});
</script>

<template>
  <button
    v-if="!resonance.expanded"
    type="button"
    class="resonance-ball"
    :aria-label="`打开共鸣球，当前有 ${resonance.count} 个视频`"
    @click="resonance.expanded = true"
  >
    <span class="resonance-orbit" />
    <strong>共鸣球</strong>
    <span class="resonance-count">{{ resonance.count }}</span>
  </button>

  <Teleport to="body">
    <section v-if="resonance.expanded" class="resonance-overlay" aria-label="共鸣球多视频播放界面">
      <header class="resonance-toolbar">
        <div class="resonance-heading">
          <span class="resonance-heading-mark" />
          <div><strong>共鸣球</strong><small>{{ resonance.count }} 个视频正在共鸣</small></div>
        </div>
        <div class="resonance-global-actions">
          <el-button
            class="global-play-button"
            type="primary"
            :disabled="!resonance.count"
            @click="toggleAll"
          >
            <component :is="allPlaying ? VideoPause : VideoPlay" />
            {{ allPlaying ? '全部暂停' : '全部播放' }}
          </el-button>
          <el-button :type="clearPending ? 'danger' : 'default'" :disabled="!resonance.count" @click="clearAll"><Delete />{{ clearPending ? '再次点击确认' : '清空' }}</el-button>
          <el-button circle aria-label="关闭共鸣球" @click="resonance.expanded = false"><Close /></el-button>
        </div>
      </header>

      <div
        ref="stage"
        class="resonance-stage"
        tabindex="-1"
        @keydown="handleOverlayKeydown"
      >
        <article
          v-for="item in resonance.videos"
          :key="item.id"
          class="resonance-tile"
          :style="tileStyle(item.id)"
        >
          <video
            :ref="(element) => registerVideo(item, element)"
            :class="{ 'vr-video-source': vrActiveIds.has(item.id) }"
            crossorigin="anonymous"
            :src="mediaUrl('part', item.partId)"
            preload="metadata"
            playsinline
            @loadedmetadata="initializeVideo(item, $event)"
            @timeupdate="trackProgress(item, $event)"
            @play="markPlaying(item.id, true)"
            @pause="markPlaying(item.id, false)"
            @ended="markPlaying(item.id, false)"
          />
          <canvas
            v-if="item.isVr"
            :ref="(element) => registerCanvas(item, element)"
            class="resonance-vr-canvas"
            :class="{ active: vrActiveIds.has(item.id) }"
            :aria-label="`${item.title} 的 360° VR 画面，拖动可转动视角，滚轮缩放`"
          />
          <div class="tile-shade" />
          <div class="tile-caption">
            <strong>{{ item.title }}</strong>
            <span>{{ item.filename }}</span>
          </div>
          <button class="tile-remove" type="button" aria-label="从共鸣球移除" @click="removeVideo(item.id)"><Close /></button>
          <div class="tile-controls">
            <button type="button" :aria-label="playingIds.has(item.id) ? '暂停' : '播放'" @click="toggleOne(item.id)">
              <component :is="playingIds.has(item.id) ? VideoPause : VideoPlay" />
            </button>
            <span>{{ formatTime(item.currentSeconds) }}</span>
            <input
              type="range"
              min="0"
              :max="Math.max(item.durationSeconds, 0.01)"
              step="0.05"
              :value="item.currentSeconds"
              :aria-label="`${item.title} 播放进度`"
              @input="seekOne(item, $event)"
            />
            <span>{{ formatTime(item.durationSeconds) }}</span>
          </div>
        </article>

        <div v-if="!resonance.count" class="resonance-empty">
          <span class="empty-orb" />
          <strong>共鸣球还是空的</strong>
          <p>打开任意影片详情，在播放器上方点击“添加进共鸣球”。</p>
        </div>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.resonance-ball { position: fixed; z-index: 2500; bottom: 24px; left: 24px; display: grid; width: 76px; height: 76px; padding: 0; place-items: center; border: 1px solid rgba(189,255,229,.54); border-radius: 50%; color: #eafff7; background: radial-gradient(circle at 35% 28%, rgba(228,255,246,.94) 0 4%, rgba(111,231,189,.92) 10%, rgba(42,116,107,.88) 38%, rgba(19,31,42,.98) 74%); box-shadow: 0 10px 34px rgba(36,197,153,.32), inset -10px -13px 22px rgba(0,0,0,.35), inset 7px 7px 15px rgba(255,255,255,.2); cursor: pointer; transition: transform .2s ease, box-shadow .2s ease; }
.resonance-ball:hover, .resonance-ball:focus-visible { outline: 0; box-shadow: 0 13px 42px rgba(52,230,177,.5), 0 0 0 4px rgba(152,227,194,.14), inset -10px -13px 22px rgba(0,0,0,.35), inset 7px 7px 15px rgba(255,255,255,.2); transform: translateY(-3px) scale(1.04); }
.resonance-ball strong { position: relative; z-index: 2; font-size: 12px; letter-spacing: .08em; text-shadow: 0 2px 8px rgba(0,0,0,.8); }
.resonance-orbit { position: absolute; width: 88px; height: 31px; border: 1px solid rgba(160,255,220,.38); border-radius: 50%; transform: rotate(-18deg); }
.resonance-count { position: absolute; z-index: 3; top: -5px; right: -4px; display: grid; min-width: 25px; height: 25px; padding: 0 6px; place-items: center; border: 2px solid #10141b; border-radius: 999px; color: #102018; background: #b5f5d9; box-shadow: 0 4px 12px rgba(0,0,0,.35); font-size: 11px; font-weight: 850; }
.resonance-overlay { position: fixed; z-index: 3000; inset: 0; display: grid; grid-template-rows: 66px minmax(0, 1fr); color: #edf5f2; background: #07090d; }
.resonance-toolbar { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 20px; padding: 10px 18px; border-bottom: 1px solid rgba(255,255,255,.1); background: linear-gradient(90deg, rgba(21,35,38,.98), rgba(15,17,23,.98)); box-shadow: 0 8px 26px rgba(0,0,0,.28); }
.resonance-heading { display: flex; min-width: 0; align-items: center; gap: 11px; }.resonance-heading > div { display: grid; gap: 2px; }.resonance-heading strong { font-size: 17px; letter-spacing: .06em; }.resonance-heading small { color: #8fa49e; font-size: 10px; }
.resonance-heading-mark { width: 30px; height: 30px; border: 1px solid rgba(189,255,229,.52); border-radius: 50%; background: radial-gradient(circle at 35% 28%, #dffff3, #60d4aa 22%, #173b3a 70%); box-shadow: 0 0 20px rgba(96,212,170,.28); }
.resonance-global-actions { display: flex; align-items: center; gap: 7px; }.resonance-global-actions :deep(.el-button) { margin: 0; }.resonance-global-actions :deep(svg) { width: 15px; margin-right: 5px; }.resonance-global-actions :deep(.is-circle svg) { margin: 0; }
.resonance-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; outline: 0; background: #05070a; }
.resonance-tile { position: absolute; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid rgba(255,255,255,.07); border-radius: 7px; background: #020305; box-shadow: 0 10px 30px rgba(0,0,0,.22); transition: left .26s ease, top .26s ease, width .26s ease, height .26s ease; }
.resonance-tile video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
.resonance-tile video.vr-video-source { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.resonance-vr-canvas { position: absolute; inset: 0; display: none; width: 100%; height: 100%; background: #000; cursor: grab; }
.resonance-vr-canvas.active { display: block; }
.resonance-vr-canvas.dragging { cursor: grabbing; }
.tile-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,.52), transparent 25%, transparent 58%, rgba(0,0,0,.8)); opacity: .45; pointer-events: none; transition: opacity .18s ease; }
.tile-caption { position: absolute; top: 10px; right: 44px; left: 12px; display: grid; min-width: 0; gap: 2px; color: #fff; text-shadow: 0 2px 6px #000; pointer-events: none; opacity: .72; transition: opacity .18s ease; }.tile-caption strong, .tile-caption span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.tile-caption strong { font-size: 12px; }.tile-caption span { color: rgba(255,255,255,.68); font-size: 9px; }
.tile-remove { position: absolute; top: 8px; right: 8px; display: grid; width: 28px; height: 28px; padding: 0; place-items: center; border: 1px solid rgba(255,255,255,.16); border-radius: 50%; color: #fff; background: rgba(0,0,0,.5); cursor: pointer; opacity: 0; transition: opacity .18s ease, background .18s ease; }.tile-remove svg { width: 14px; }.tile-remove:hover { background: rgba(183,55,66,.82); }
.tile-controls { position: absolute; right: 10px; bottom: 9px; left: 10px; display: grid; grid-template-columns: 30px auto minmax(40px, 1fr) auto; align-items: center; gap: 7px; padding: 7px 9px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; background: rgba(7,9,13,.78); box-shadow: 0 8px 22px rgba(0,0,0,.3); opacity: 0; transform: translateY(7px); transition: opacity .18s ease, transform .18s ease; backdrop-filter: blur(8px); }
.resonance-tile:hover .tile-controls, .resonance-tile:focus-within .tile-controls, .resonance-tile:hover .tile-remove, .resonance-tile:focus-within .tile-remove { opacity: 1; transform: translateY(0); }.resonance-tile:hover .tile-caption, .resonance-tile:focus-within .tile-caption, .resonance-tile:hover .tile-shade, .resonance-tile:focus-within .tile-shade { opacity: 1; }
.tile-controls button { display: grid; width: 30px; height: 30px; padding: 0; place-items: center; border: 0; border-radius: 50%; color: #102018; background: #a7ebce; cursor: pointer; }.tile-controls button svg { width: 15px; }.tile-controls span { color: rgba(255,255,255,.74); font-size: 9px; font-variant-numeric: tabular-nums; }
.tile-controls input { width: 100%; min-width: 0; accent-color: #98e3c2; cursor: pointer; }
.resonance-empty { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; color: #dce9e4; text-align: center; }.resonance-empty strong { margin-top: 20px; font-size: 18px; }.resonance-empty p { margin: 8px 0 0; color: #78857f; font-size: 12px; }.empty-orb { width: 86px; height: 86px; border: 1px solid rgba(152,227,194,.3); border-radius: 50%; background: radial-gradient(circle at 35% 28%, rgba(196,255,234,.65), rgba(57,130,110,.32) 35%, rgba(10,20,24,.4) 72%); box-shadow: 0 0 52px rgba(87,216,170,.12); }
@media (max-width: 760px) { .resonance-ball { bottom: 16px; left: 16px; width: 66px; height: 66px; }.resonance-orbit { width: 75px; }.resonance-overlay { grid-template-rows: auto minmax(0, 1fr); }.resonance-toolbar { align-items: flex-start; padding: 9px 10px; }.resonance-heading small { display: none; }.resonance-global-actions { flex-wrap: wrap; justify-content: flex-end; }.resonance-global-actions :deep(.el-button) { padding-inline: 10px; }.tile-caption { top: 7px; left: 8px; }.tile-controls { right: 6px; bottom: 6px; left: 6px; gap: 4px; padding: 5px; }.tile-controls span { display: none; }.tile-controls { grid-template-columns: 28px minmax(30px, 1fr); } }
</style>
