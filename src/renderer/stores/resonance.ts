import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { VrViewDto } from '../../shared/contracts';

const STORAGE_KEY = 'local-film-library:resonance-v1';
const SCENES_STORAGE_KEY = 'local-film-library:resonance-scenes-v1';

export interface ResonanceVideo {
  id: string;
  filmId: string;
  partId: string;
  title: string;
  filename: string;
  currentSeconds: number;
  durationSeconds: number;
  aspectRatio: number;
  isVr: boolean;
  vrView: VrViewDto | null;
  vrModeKnown: boolean;
  addedAt: string;
}

export type ResonanceVideoInput = Omit<ResonanceVideo, 'id' | 'addedAt' | 'vrModeKnown'>;

export interface ResonanceScene {
  id: string;
  name: string;
  videos: ResonanceVideo[];
  createdAt: string;
}

interface SceneState {
  version: 1;
  activeSceneId: string | null;
  draft: ResonanceVideo[];
  scenes: ResonanceScene[];
}

export const useResonanceStore = defineStore('resonance', () => {
  const sceneState = ref<SceneState>(restoreSceneState());
  const storageError = ref('');
  const scenes = computed(() => sceneState.value.scenes);
  const activeSceneId = computed(() => sceneState.value.activeSceneId);
  const activeScene = computed(() => scenes.value.find((scene) => scene.id === activeSceneId.value) ?? null);
  const videos = computed<ResonanceVideo[]>({
    get: () => activeScene.value?.videos ?? sceneState.value.draft,
    set: (value) => {
      if (activeScene.value) activeScene.value.videos = value;
      else sceneState.value.draft = value;
    },
  });
  const expanded = ref(false);
  const count = computed(() => videos.value.length);

  function add(input: ResonanceVideoInput): 'added' | 'updated' {
    const id = identity(input.filmId, input.partId);
    const existing = videos.value.find((item) => item.id === id);
    if (existing) {
      Object.assign(existing, sanitizeVideo({ ...existing, ...input, id, vrModeKnown: true }));
      return 'updated';
    }
    videos.value.push(sanitizeVideo({
      ...input,
      id,
      vrModeKnown: true,
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

  function updateVrMode(id: string, isVr: boolean): void {
    const item = videos.value.find((video) => video.id === id);
    if (!item) return;
    item.isVr = isVr;
    item.vrModeKnown = true;
    if (!isVr) item.vrView = null;
    else item.aspectRatio = 16 / 9;
  }

  function updateVrView(id: string, view: VrViewDto): void {
    const item = videos.value.find((video) => video.id === id);
    if (!item || !item.isVr) return;
    item.vrView = sanitizeVrView(view);
  }

  function remove(id: string): void {
    videos.value = videos.value.filter((item) => item.id !== id);
    if (!videos.value.length) expanded.value = false;
  }

  function clear(): void {
    videos.value = [];
    expanded.value = false;
  }

  function persist(state: SceneState): void {
    try {
      window.localStorage.setItem(SCENES_STORAGE_KEY, JSON.stringify(state));
      storageError.value = '';
    } catch (error) {
      storageError.value = '共鸣场景保存失败，请检查本机存储空间后重试';
      console.warn('[resonance] could not persist scenes', error);
      throw new Error(storageError.value, { cause: error });
    }
  }

  function commit(state: SceneState): void {
    persist(state);
    sceneState.value = state;
  }

  function validatedName(value: string, exceptId?: string): string {
    const name = value.trim().normalize('NFKC');
    if (!name || name.length > 60) throw new Error('场景名称需为 1 到 60 个字符');
    if (scenes.value.some((scene) => scene.id !== exceptId && scene.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('已有同名场景，请换一个名称');
    }
    return name;
  }

  function saveSceneAs(name: string): string {
    const scene: ResonanceScene = {
      id: crypto.randomUUID(), name: validatedName(name), videos: cloneVideos(videos.value), createdAt: new Date().toISOString(),
    };
    commit({ ...sceneState.value, scenes: [...scenes.value, scene], activeSceneId: scene.id });
    return scene.id;
  }

  function switchScene(id: string | null): void {
    if (id !== null && !scenes.value.some((scene) => scene.id === id)) throw new Error('场景不存在');
    commit({ ...sceneState.value, activeSceneId: id });
  }

  function renameScene(id: string, name: string): void {
    if (!scenes.value.some((scene) => scene.id === id)) throw new Error('场景不存在');
    const validName = validatedName(name, id);
    commit({ ...sceneState.value, scenes: scenes.value.map((scene) => scene.id === id ? { ...scene, name: validName } : scene) });
  }

  function duplicateScene(id: string, name: string): string {
    const source = scenes.value.find((scene) => scene.id === id);
    if (!source) throw new Error('场景不存在');
    const scene: ResonanceScene = {
      id: crypto.randomUUID(), name: validatedName(name), videos: cloneVideos(source.videos), createdAt: new Date().toISOString(),
    };
    commit({ ...sceneState.value, scenes: [...scenes.value, scene] });
    return scene.id;
  }

  function deleteScene(id: string): void {
    // Return to the existing temporary scene without overwriting it.
    const deletingActive = activeSceneId.value === id;
    commit({
      ...sceneState.value,
      scenes: scenes.value.filter((scene) => scene.id !== id),
      activeSceneId: deletingActive ? null : activeSceneId.value,
    });
  }

  function flush(): void { persist(sceneState.value); }

  watch(sceneState, () => {
    try { flush(); } catch { /* The persistent error is displayed in the scene controls. */ }
  }, { deep: true });

  return {
    videos, expanded, count, add, updateProgress, updateAspectRatio, updateVrMode, updateVrView, remove, clear,
    scenes, activeSceneId, activeScene, storageError, saveSceneAs, switchScene, renameScene, duplicateScene, deleteScene, flush,
  };
});

function cloneVideos(videos: ResonanceVideo[]): ResonanceVideo[] {
  return videos.map((video) => ({ ...video, vrView: video.vrView ? { ...video.vrView } : null }));
}

function restoreSceneState(): SceneState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SCENES_STORAGE_KEY) ?? 'null') as SceneState | null;
    if (parsed?.version === 1 && Array.isArray(parsed.scenes) && Array.isArray(parsed.draft)) {
      const ids = new Set<string>();
      const scenes = parsed.scenes.filter((scene) => {
        if (!scene || typeof scene.id !== 'string' || !scene.id || ids.has(scene.id)
          || typeof scene.name !== 'string' || !scene.name.trim() || !Array.isArray(scene.videos)) return false;
        ids.add(scene.id);
        return true;
      }).map((scene) => ({
        id: scene.id,
        name: scene.name.trim().slice(0, 60),
        createdAt: typeof scene.createdAt === 'string' ? scene.createdAt : new Date().toISOString(),
        videos: scene.videos.filter(isStoredVideo).map(sanitizeVideo),
      }));
      return {
        version: 1, scenes,
        activeSceneId: scenes.some((scene) => scene.id === parsed.activeSceneId) ? parsed.activeSceneId : null,
        draft: parsed.draft.filter(isStoredVideo).map(sanitizeVideo),
      };
    }
  } catch { /* Keep compatibility with the original queue if no valid scene document exists. */ }
  return { version: 1, activeSceneId: null, draft: restoreVideos(), scenes: [] };
}

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
    isVr: value.isVr === true,
    vrView: value.isVr === true ? sanitizeVrView(value.vrView) : null,
    vrModeKnown: value.vrModeKnown === true,
    addedAt: value.addedAt || new Date().toISOString(),
  };
}

function sanitizeVrView(value: VrViewDto | null | undefined): VrViewDto | null {
  if (!value
    || !Number.isFinite(value.yawDegrees)
    || !Number.isFinite(value.pitchDegrees)
    || !Number.isFinite(value.fovDegrees)) return null;
  return {
    yawDegrees: Math.max(-180, Math.min(179.999, Number(value.yawDegrees))),
    pitchDegrees: Math.max(-85, Math.min(85, Number(value.pitchDegrees))),
    fovDegrees: Math.max(30, Math.min(100, Number(value.fovDegrees))),
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
