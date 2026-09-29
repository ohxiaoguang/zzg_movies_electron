import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import { useResonanceStore, type ResonanceVideoInput } from '../src/renderer/stores/resonance';
import type { ResonanceState } from '../src/shared/resonance';

const SCENES_KEY = 'local-film-library:resonance-scenes-v1';
const LEGACY_KEY = 'local-film-library:resonance-v1';
const piniaInstances: Pinia[] = [];
let storage: Map<string, string>;
let databaseState: ResonanceState | null;
const video: ResonanceVideoInput = {
  filmId: 'film-one', partId: 'part-one', title: '影片一', filename: 'one.mp4',
  currentSeconds: 12, durationSeconds: 300, aspectRatio: 16 / 9,
  isVr: true, vrView: { yawDegrees: 25, pitchDegrees: 10, fovDegrees: 65 },
};

beforeEach(() => {
  storage = new Map();
  databaseState = null;
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  }, filmLibrary: { resonance: {
    load: vi.fn(async (legacy: ResonanceState) => {
      databaseState ??= structuredClone(legacy);
      return { ok: true, data: structuredClone(databaseState) };
    }),
    save: vi.fn(async (state: ResonanceState) => {
      databaseState = structuredClone(state);
      return { ok: true, data: null };
    }),
  } } });
});

afterEach(() => {
  for (const pinia of piniaInstances.splice(0)) disposePinia(pinia);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function store() {
  const pinia = createPinia();
  piniaInstances.push(pinia);
  setActivePinia(pinia);
  const current = useResonanceStore(); await current.initialize(); return current;
}

describe('resonance scenes', () => {
  it('waits for an in-flight scene switch before flushing for backup or exit', async () => {
    const current = await store();
    current.add(video);
    await current.saveSceneAs('原场景');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saving = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(window.filmLibrary.resonance, 'save').mockImplementationOnce(async (snapshot) => {
      started();
      await gate;
      databaseState = structuredClone(snapshot);
      return { ok: true, data: null };
    });
    const creating = current.createScene('退出前的新场景');
    await saving;
    const flushing = current.flush();
    release();
    const id = await creating;
    await flushing;
    expect(databaseState?.activeSceneId).toBe(id);
    expect(databaseState?.scenes).toHaveLength(2);
  });

  it('does not overwrite legacy data when loading fails and can retry migration', async () => {
    storage.set(LEGACY_KEY, JSON.stringify([video]));
    vi.spyOn(window.filmLibrary.resonance, 'load').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const pinia = createPinia();
    piniaInstances.push(pinia);
    setActivePinia(pinia);
    const current = useResonanceStore();
    await expect(current.initialize()).rejects.toThrow('SQLITE_BUSY');
    expect(current.ready).toBe(false);
    expect(databaseState).toBeNull();
    expect(window.filmLibrary.resonance.save).not.toHaveBeenCalled();
    await current.initialize();
    expect(current.videos[0]).toMatchObject(video);
    expect(storage.get(LEGACY_KEY)).toBe(JSON.stringify([video]));
  });

  it('creates an empty scene and preserves the previous scene and temporary queue after replacing films and reopening', async () => {
    const current = await store();
    current.add(video);
    const original = await current.saveSceneAs('原场景');
    current.updateProgress(current.videos[0].id, 95);
    const fresh = await current.createScene('新场景');
    expect(current.activeSceneId).toBe(fresh);
    expect(current.count).toBe(0);
    current.add({ ...video, partId: 'new-part', filename: 'new.mp4' });
    await current.flush();
    const reopened = await store();
    expect(reopened.activeSceneId).toBe(fresh);
    expect(reopened.videos.map((item) => item.partId)).toEqual(['new-part']);
    reopened.clear();
    await reopened.switchScene(original);
    expect(reopened.videos).toHaveLength(1);
    expect(reopened.videos[0]).toMatchObject({ partId: 'part-one', currentSeconds: 95, vrView: video.vrView });
    await reopened.switchScene(null);
    expect(reopened.videos[0].currentSeconds).toBe(12);
  });

  it('creates an empty scene from a temporary queue without discarding that queue', async () => {
    const current = await store();
    current.add(video);
    await current.createScene('空白场景');
    expect(current.count).toBe(0);
    await current.switchScene(null);
    expect(current.videos[0]).toMatchObject(video);
  });

  it('retains the legacy queue as the temporary scene and restores the selected named scene', async () => {
    storage.set(LEGACY_KEY, JSON.stringify([video]));
    const first = await store();
    expect(first.videos[0].currentSeconds).toBe(12);
    expect(first.activeSceneId).toBeNull();
    const id = await first.saveSceneAs('今晚待看');
    first.updateProgress(first.videos[0].id, 89, 300);
    await first.flush();
    const reopened = await store();
    expect(reopened.activeSceneId).toBe(id);
    expect(reopened.activeScene?.name).toBe('今晚待看');
    expect(reopened.videos[0].currentSeconds).toBe(89);
    await reopened.switchScene(null);
    expect(reopened.videos[0].currentSeconds).toBe(12);
    expect(storage.get(LEGACY_KEY)).toBe(JSON.stringify([video]));
  });

  it('keeps progress, VR view and membership independent for scenes containing the same file', async () => {
    const current = await store();
    current.add(video);
    const first = await current.saveSceneAs('第一场景');
    const second = await current.saveSceneAs('第二场景');
    current.updateProgress(current.videos[0].id, 60);
    current.updateVrView(current.videos[0].id, { yawDegrees: -40, pitchDegrees: 5, fovDegrees: 80 });
    current.add({ ...video, partId: 'part-two', filename: 'two.mp4' });
    await current.switchScene(first);
    expect(current.videos).toHaveLength(1);
    expect(current.videos[0]).toMatchObject({ currentSeconds: 12, vrView: video.vrView });
    await current.switchScene(second);
    expect(current.videos.map((item) => item.partId)).toEqual(['part-one', 'part-two']);
    expect(current.videos[0]).toMatchObject({ currentSeconds: 60, vrView: { yawDegrees: -40 } });
  });

  it('copies a scene without changing the active scene or sharing mutable data', async () => {
    const current = await store();
    current.add(video);
    const original = await current.saveSceneAs('原场景');
    const copy = await current.duplicateScene(original, '副本');
    expect(current.activeSceneId).toBe(original);
    await current.renameScene(copy, '独立副本');
    await current.switchScene(copy);
    current.videos[0].vrView!.yawDegrees = 100;
    current.remove(current.videos[0].id);
    await current.switchScene(original);
    expect(current.videos[0].vrView?.yawDegrees).toBe(25);
    expect(current.scenes.find((scene) => scene.id === copy)?.name).toBe('独立副本');
  });

  it('deletes only the requested scene and returns to the preserved temporary queue', async () => {
    const current = await store();
    current.add(video);
    const first = await current.saveSceneAs('第一场景');
    const second = await current.saveSceneAs('第二场景');
    current.updateProgress(current.videos[0].id, 80);
    await current.deleteScene(first);
    expect(current.activeSceneId).toBe(second);
    await current.deleteScene(second);
    expect(current.activeSceneId).toBeNull();
    expect(current.scenes).toEqual([]);
    expect(current.videos[0].currentSeconds).toBe(12);
  });

  it('clears only the active scene and can reopen an empty scene', async () => {
    const current = await store();
    current.add(video);
    const first = await current.saveSceneAs('保留');
    const second = await current.saveSceneAs('清空');
    current.clear();
    await current.switchScene(first);
    expect(current.count).toBe(1);
    await current.switchScene(second);
    expect(current.count).toBe(0);
    expect(current.scenes).toHaveLength(2);
  });

  it('rejects empty, overlong and duplicate names without changing saved scenes', async () => {
    const current = await store();
    const id = await current.saveSceneAs('场景 A');
    await expect(current.saveSceneAs('  ')).rejects.toThrow('1 到 60');
    await expect(current.saveSceneAs('长'.repeat(61))).rejects.toThrow('1 到 60');
    await expect(current.saveSceneAs(' 场景 Ａ ')).rejects.toThrow('同名');
    await expect(current.createScene('')).rejects.toThrow('1 到 60');
    await expect(current.createScene('长'.repeat(61))).rejects.toThrow('1 到 60');
    await expect(current.createScene(' 场景 Ａ ')).rejects.toThrow('同名');
    expect(current.activeSceneId).toBe(id);
    await current.renameScene(id, ' 场景 A ');
    expect(current.scenes).toHaveLength(1);
    await expect(current.switchScene('missing')).rejects.toThrow('不存在');
  });

  it('does not report a scene saved or switch scenes when storage writes fail', async () => {
    const current = await store();
    current.add(video);
    const id = await current.saveSceneAs('保留');
    await nextTick();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const write = vi.spyOn(window.filmLibrary.resonance, 'save').mockRejectedValue(new Error('SQLITE_FULL'));
    await expect(current.saveSceneAs('不能保存')).rejects.toThrow('保存失败');
    await expect(current.createScene('不能新建')).rejects.toThrow('保存失败');
    await expect(current.switchScene(null)).rejects.toThrow('保存失败');
    await expect(current.deleteScene(id)).rejects.toThrow('保存失败');
    expect(current.activeSceneId).toBe(id);
    expect(current.scenes).toHaveLength(1);
    expect(current.storageError).toContain('保存失败');
    expect(current.videos[0]).toMatchObject(video);
    write.mockRestore();
    await current.flush();
    expect(current.storageError).toBe('');
  });

  it('ignores malformed scenes and falls back to the temporary scene for an unknown active id', async () => {
    storage.set(SCENES_KEY, JSON.stringify({
      version: 1, activeSceneId: 'missing', draft: [video],
      scenes: [null, { id: 'broken', name: '坏数据', videos: null }, { id: 'valid', name: '有效', videos: [null, video] }],
    }));
    const current = await store();
    expect(current.activeSceneId).toBeNull();
    expect(current.scenes).toHaveLength(1);
    await current.switchScene('valid');
    expect(current.videos).toHaveLength(1);
  });
});
