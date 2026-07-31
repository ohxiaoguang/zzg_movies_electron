import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

const STORAGE_KEY = 'local-film-library:resonance-v1';

export interface ResonanceVideo {
  id: string;
  filmId: string;
  partId: string;
  title: string;
  filename: string;
  currentSeconds: number;
  durationSeconds: number;
  aspectRatio: number;
  addedAt: string;
}

export type ResonanceVideoInput = Omit<ResonanceVideo, 'id' | 'addedAt'>;

export const useResonanceStore = defineStore('resonance', () => {
  const videos = ref<ResonanceVideo[]>(restoreVideos());
  const expanded = ref(false);
  const count = computed(() => videos.value.length);

  function add(input: ResonanceVideoInput): 'added' | 'updated' {
    const id = identity(input.filmId, input.partId);
    const existing = videos.value.find((item) => item.id === id);
    if (existing) {
      Object.assign(existing, sanitizeVideo({ ...existing, ...input, id }));
      return 'updated';
    }
    videos.value.push(sanitizeVideo({
      ...input,
      id,
      addedAt: new Date().toISOString(),
    }));
    return 'added';
  }

  function updateProgress(id: string, currentSeconds: number, durationSeconds?: number): void {
    const item = videos.value.find((video) => video.id === id);
    if (!item) return;
    item.currentSeconds = finiteNonNegative(currentSeconds);
    if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
      item.durationSeconds = durationSeconds;
    }
  }

  function updateAspectRatio(id: string, width: number, height: number): void {
    const item = videos.value.find((video) => video.id === id);
    if (!item || width <= 0 || height <= 0) return;
    item.aspectRatio = clampAspectRatio(width / height);
  }

  function remove(id: string): void {
    videos.value = videos.value.filter((item) => item.id !== id);
    if (!videos.value.length) expanded.value = false;
  }

  function clear(): void {
    videos.value = [];
    expanded.value = false;
  }

  watch(videos, (value) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (error) {
      console.warn('[resonance] could not persist queue', error);
    }
  }, { deep: true });

  return { videos, expanded, count, add, updateProgress, updateAspectRatio, remove, clear };
});

function restoreVideos(): ResonanceVideo[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isStoredVideo)
      .map((item) => sanitizeVideo(item));
  } catch {
    return [];
  }
}

function isStoredVideo(value: unknown): value is ResonanceVideo {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ResonanceVideo>;
  return typeof item.filmId === 'string'
    && typeof item.partId === 'string'
    && typeof item.title === 'string'
    && typeof item.filename === 'string';
}

function sanitizeVideo(value: ResonanceVideo): ResonanceVideo {
  return {
    ...value,
    id: identity(value.filmId, value.partId),
    currentSeconds: finiteNonNegative(value.currentSeconds),
    durationSeconds: finiteNonNegative(value.durationSeconds),
    aspectRatio: clampAspectRatio(value.aspectRatio),
    addedAt: value.addedAt || new Date().toISOString(),
  };
}

function identity(filmId: string, partId: string): string {
  return `${filmId}:${partId}`;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampAspectRatio(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(4, Math.max(0.25, value)) : 16 / 9;
}
