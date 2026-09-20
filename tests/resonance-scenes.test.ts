import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick } from 'vue';
import { useResonanceStore, type ResonanceVideoInput } from '../src/renderer/stores/resonance';

const SCENES_KEY = 'local-film-library:resonance-scenes-v1';
const LEGACY_KEY = 'local-film-library:resonance-v1';
const piniaInstances: Pinia[] = [];
let storage: Map<string, string>;
const video: ResonanceVideoInput = {
  filmId: 'film-one', partId: 'part-one', title: '影片一', filename: 'one.mp4',
  currentSeconds: 12, durationSeconds: 300, aspectRatio: 16 / 9,
  isVr: true, vrView: { yawDegrees: 25, pitchDegrees: 10, fovDegrees: 65 },
};

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
});

afterEach(() => {
  for (const pinia of piniaInstances.splice(0)) disposePinia(pinia);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function store() {
  const pinia = createPinia();
  piniaInstances.push(pinia);
  setActivePinia(pinia);
  return useResonanceStore();
}

describe('resonance scenes', () => {
  it('retains the legacy queue as the temporary scene and restores the selected named scene', async () => {
    storage.set(LEGACY_KEY, JSON.stringify([video]));
    const first = store();
    expect(first.videos[0].currentSeconds).toBe(12);
    expect(first.activeSceneId).toBeNull();
    const id = first.saveSceneAs('今晚待看');
    first.updateProgress(first.videos[0].id, 89, 300);
    await nextTick();
    const reopened = store();
    expect(reopened.activeSceneId).toBe(id);
    expect(reopened.activeScene?.name).toBe('今晚待看');
    expect(reopened.videos[0].currentSeconds).toBe(89);
    reopened.switchScene(null);
    expect(reopened.videos[0].currentSeconds).toBe(12);
    expect(storage.get(LEGACY_KEY)).toBe(JSON.stringify([video]));
  });

  it('keeps progress, VR view and membership independent for scenes containing the same file', () => {
    const current = store();
    current.add(video);
    const first = current.saveSceneAs('第一场景');
    const second = current.saveSceneAs('第二场景');
    current.updateProgress(current.videos[0].id, 60);
    current.updateVrView(current.videos[0].id, { yawDegrees: -40, pitchDegrees: 5, fovDegrees: 80 });
    current.add({ ...video, partId: 'part-two', filename: 'two.mp4' });
    current.switchScene(first);
    expect(current.videos).toHaveLength(1);
    expect(current.videos[0]).toMatchObject({ currentSeconds: 12, vrView: video.vrView });
    current.switchScene(second);
    expect(current.videos.map((item) => item.partId)).toEqual(['part-one', 'part-two']);
    expect(current.videos[0]).toMatchObject({ currentSeconds: 60, vrView: { yawDegrees: -40 } });
  });

  it('copies a scene without changing the active scene or sharing mutable data', () => {
    const current = store();
    current.add(video);
    const original = current.saveSceneAs('原场景');
    const copy = current.duplicateScene(original, '副本');
    expect(current.activeSceneId).toBe(original);
    current.renameScene(copy, '独立副本');
    current.switchScene(copy);
    current.videos[0].vrView!.yawDegrees = 100;
    current.remove(current.videos[0].id);
    current.switchScene(original);
    expect(current.videos[0].vrView?.yawDegrees).toBe(25);
    expect(current.scenes.find((scene) => scene.id === copy)?.name).toBe('独立副本');
  });

  it('deletes only the requested scene and returns to the preserved temporary queue', () => {
    const current = store();
    current.add(video);
    const first = current.saveSceneAs('第一场景');
    const second = current.saveSceneAs('第二场景');
    current.updateProgress(current.videos[0].id, 80);
    current.deleteScene(first);
    expect(current.activeSceneId).toBe(second);
    current.deleteScene(second);
    expect(current.activeSceneId).toBeNull();
    expect(current.scenes).toEqual([]);
    expect(current.videos[0].currentSeconds).toBe(12);
  });

  it('clears only the active scene and can reopen an empty scene', () => {
    const current = store();
    current.add(video);
    const first = current.saveSceneAs('保留');
    const second = current.saveSceneAs('清空');
    current.clear();
    current.switchScene(first);
    expect(current.count).toBe(1);
    current.switchScene(second);
    expect(current.count).toBe(0);
    expect(current.scenes).toHaveLength(2);
  });

  it('rejects empty, overlong and duplicate names without changing saved scenes', () => {
    const current = store();
    const id = current.saveSceneAs('场景 A');
    expect(() => current.saveSceneAs('  ')).toThrow('1 到 60');
    expect(() => current.saveSceneAs('长'.repeat(61))).toThrow('1 到 60');
    expect(() => current.saveSceneAs(' 场景 Ａ ')).toThrow('同名');
    current.renameScene(id, ' 场景 A ');
    expect(current.scenes).toHaveLength(1);
    expect(() => current.switchScene('missing')).toThrow('不存在');
  });

  it('does not report a scene saved or switch scenes when storage writes fail', async () => {
    const current = store();
    current.add(video);
    const id = current.saveSceneAs('保留');
    await nextTick();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(() => current.saveSceneAs('不能保存')).toThrow('保存失败');
    expect(() => current.switchScene(null)).toThrow('保存失败');
    expect(() => current.deleteScene(id)).toThrow('保存失败');
    expect(current.activeSceneId).toBe(id);
    expect(current.scenes).toHaveLength(1);
    expect(current.storageError).toContain('保存失败');
    write.mockRestore();
    current.flush();
    expect(current.storageError).toBe('');
  });

  it('ignores malformed scenes and falls back to the temporary scene for an unknown active id', () => {
    storage.set(SCENES_KEY, JSON.stringify({
      version: 1, activeSceneId: 'missing', draft: [video],
      scenes: [null, { id: 'broken', name: '坏数据', videos: null }, { id: 'valid', name: '有效', videos: [null, video] }],
    }));
    const current = store();
    expect(current.activeSceneId).toBeNull();
    expect(current.scenes).toHaveLength(1);
    current.switchScene('valid');
    expect(current.videos).toHaveLength(1);
  });
});
