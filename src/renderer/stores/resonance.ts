import { computed, nextTick, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { VrViewDto } from '../../shared/contracts';
import { emptyResonanceState, type ResonanceState as SceneState, type ResonanceVideo, type ResonanceVideoInput, type ResonanceScene } from '../../shared/resonance';
export type { ResonanceVideo, ResonanceVideoInput, ResonanceScene } from '../../shared/resonance';

const STORAGE_KEY = 'local-film-library:resonance-v1';
const SCENES_STORAGE_KEY = 'local-film-library:resonance-scenes-v1';

export const useResonanceStore = defineStore('resonance', () => {
  const sceneState = ref<SceneState>(emptyResonanceState());
  const ready = ref(false);
  const restoring = ref(false);
  const storageError = ref('');
  let loading: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  let committing: Promise<void> | null = null;
  let replacing = false;

  async function initialize(): Promise<void> {
    if (ready.value) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const result = await window.filmLibrary.resonance.load(restoreSceneState());
        if (!result.ok) throw new Error(result.error.message);
        sceneState.value = result.data;
        await nextTick();
        ready.value = true;
        storageError.value = '';
        // Leave legacy localStorage untouched as a recovery copy. SQLite wins on subsequent loads.
      } catch (error) {
        storageError.value = '共鸣场景读取失败，请重试；原有数据未被覆盖';
        throw error;
      } finally { loading = null; }
    })();
    return loading;
  }

  async function reload(): Promise<void> {
    await writes;
    ready.value = false;
    await initialize();
  }
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
    if (!ready.value || restoring.value) throw new Error('场景尚未读取完成，请稍后重试');
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

  function persist(state: SceneState): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(state)) as SceneState;
    const operation = writes.catch(() => undefined).then(async () => {
      try {
        const result = await window.filmLibrary.resonance.save(snapshot);
        if (!result.ok) throw new Error(result.error.message);
        storageError.value = '';
      } catch (error) {
        storageError.value = '共鸣场景保存失败，请检查数据库后重试';
        throw new Error(storageError.value, { cause: error });
      }
    });
    writes = operation;
    return operation;
  }

  async function commit(state: SceneState): Promise<void> {
    if (!ready.value || restoring.value) throw new Error('场景尚未读取完成，请稍后重试');
    if (committing) throw new Error('场景正在保存，请稍后重试');
    committing = (async () => {
      await nextTick();
      await persist(state);
      replacing = true;
      sceneState.value = state;
      await nextTick();
      replacing = false;
    })();
    try { await committing; } finally { committing = null; }
  }

  function validatedName(value: string, exceptId?: string): string {
    const name = value.trim().normalize('NFKC');
    if (!name || name.length > 60) throw new Error('场景名称需为 1 到 60 个字符');
    if (scenes.value.some((scene) => scene.id !== exceptId && scene.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('已有同名场景，请换一个名称');
    }
    return name;
  }

  function saveSceneAs(name: string): Promise<string> {
    return createScene(name, videos.value);
  }

  async function createScene(name: string, initialVideos: ResonanceVideo[] = []): Promise<string> {
    const scene: ResonanceScene = {
      id: crypto.randomUUID(), name: validatedName(name), videos: cloneVideos(initialVideos), createdAt: new Date().toISOString(),
    };
    await commit({ ...sceneState.value, scenes: [...scenes.value, scene], activeSceneId: scene.id });
    return scene.id;
  }

  async function switchScene(id: string | null): Promise<void> {
    if (id !== null && !scenes.value.some((scene) => scene.id === id)) throw new Error('场景不存在');
    await commit({ ...sceneState.value, activeSceneId: id });
  }

  async function renameScene(id: string, name: string): Promise<void> {
    if (!scenes.value.some((scene) => scene.id === id)) throw new Error('场景不存在');
    const validName = validatedName(name, id);
    await commit({ ...sceneState.value, scenes: scenes.value.map((scene) => scene.id === id ? { ...scene, name: validName } : scene) });
  }

  async function duplicateScene(id: string, name: string): Promise<string> {
    const source = scenes.value.find((scene) => scene.id === id);
    if (!source) throw new Error('场景不存在');
    const scene: ResonanceScene = {
      id: crypto.randomUUID(), name: validatedName(name), videos: cloneVideos(source.videos), createdAt: new Date().toISOString(),
    };
    await commit({ ...sceneState.value, scenes: [...scenes.value, scene] });
    return scene.id;
  }

  async function deleteScene(id: string): Promise<void> {
    // Return to the existing temporary scene without overwriting it.
    const deletingActive = activeSceneId.value === id;
    await commit({
      ...sceneState.value,
      scenes: scenes.value.filter((scene) => scene.id !== id),
      activeSceneId: deletingActive ? null : activeSceneId.value,
    });
  }

  async function flush(): Promise<void> {
    if (restoring.value) { await writes; return; }
    await initialize();
    await committing?.catch(() => undefined);
    await nextTick();
    await persist(sceneState.value);
  }

  watch(sceneState, () => {
    if (ready.value && !replacing && !restoring.value) void persist(sceneState.value).catch(() => undefined);
  }, { deep: true });

  return {
    ready, restoring, initialize, reload,
    videos, expanded, count, add, updateProgress, updateAspectRatio, updateVrMode, updateVrView, remove, clear,
    scenes, activeSceneId, activeScene, storageError, createScene, saveSceneAs, switchScene, renameScene, duplicateScene, deleteScene, flush,
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
