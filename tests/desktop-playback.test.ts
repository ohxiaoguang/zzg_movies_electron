import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { DesktopPlaybackTracker, resumablePlayback } from '../src/renderer/media/DesktopPlaybackTracker';
import type { DesktopPlaybackProgressInput, DesktopPlaybackStateDto, FilmDetailDto, FilmPartDto, FilmSegmentDto } from '../src/shared/contracts';

const filmId = '11111111-1111-4111-8111-111111111111';
const partId = '22222222-2222-4222-8222-222222222222';
const partTwo = '33333333-3333-4333-8333-333333333333';
const saved: DesktopPlaybackStateDto = { filmId, lastPartId: partTwo, positionSeconds: 42, durationSeconds: 100, lastPlayedAt: '2026-10-13' };
const parts = [partId, partTwo].map((id) => ({ id, missing: false, isVr: false, filename: `${id}.mp4` })) as FilmPartDto[];
interface PlayerBindings {
  video: unknown;
  selectedPartId: string;
  playbackSourceMode: string;
  activeSegment: FilmSegmentDto | null;
  onLoadedMetadata(): void;
  onTimeUpdate(): void;
  onPlaying(): void;
  onPaused(): void;
  onPlaybackError(event: { currentTarget: unknown }): void;
  restartPlayback(): void;
  selectPart(id: string): void;
  playSegment(segment: FilmSegmentDto): Promise<void>;
}
const applications: Array<{ unmount(): void }> = [];
const save = vi.fn(async () => ({ ok: true, data: saved }));
let onFlush: (() => Promise<void>) | null = null;

beforeEach(() => {
  save.mockReset().mockResolvedValue({ ok: true, data: saved });
  onFlush = null;
  vi.stubGlobal('window', { filmLibrary: { films: {
    savePlaybackProgress: save,
    cancelPreview: vi.fn(async () => ({ ok: true })),
    subtitleTracks: vi.fn(async () => ({ ok: true, data: [] })),
    onPlaybackFlush: (listener: () => Promise<void>) => { onFlush = listener; return () => { onFlush = null; }; },
  } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => {
  for (const app of applications.splice(0)) app.unmount();
  await Vue.nextTick();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function player(state: DesktopPlaybackStateDto | null = saved) {
  const filename = path.resolve('src/renderer/components/film/FilmDetailPlayer.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'desktop-playback-test' });
  const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { default?: Vue.Component } = {};
  const require = (name: string): unknown => {
    if (name === 'vue') return Vue;
    if (name === 'element-plus') return { ElMessage: { warning: vi.fn(), info: vi.fn(), error: vi.fn() } };
    if (name.endsWith('/api')) return { mediaUrl: (kind: string, id: string) => `film-media://${kind}/${id}` };
    if (name.endsWith('/stores/resonance')) return { useResonanceStore: () => ({ playerFullscreen: false, expanded: false }) };
    if (name.endsWith('/DesktopPlaybackTracker')) return { DesktopPlaybackTracker, resumablePlayback };
    if (name.endsWith('/SphericalVideoRenderer')) return { SphericalVideoRenderer: class {} };
    throw new Error(`Unexpected component import: ${name}`);
  };
  new Function('require', 'exports', code)(require, exports);
  const component = exports.default!;
  Object.assign(component, { render: () => null });
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert: () => {}, remove: () => {}, setText: () => {}, setElementText: () => {},
    parentNode: () => null, nextSibling: () => null, patchProp: () => {},
  });
  const film = { id: filmId, parts, playbackState: state } as FilmDetailDto;
  const app = renderer.createApp(component, { film, segments: [] });
  app.mount({}); applications.push(app);
  const setup = (app._instance! as unknown as { setupState: PlayerBindings }).setupState;
  const video = {
    currentTime: 0, duration: 100, readyState: 1, videoWidth: 1920, videoHeight: 1080,
    paused: true, muted: false, textTracks: [], currentSrc: `film-media://original-part/${partTwo}`,
    getAttribute: () => `film-media://original-part/${partTwo}`,
    pause: vi.fn(), play: vi.fn(async () => {}), removeAttribute: vi.fn(), load: vi.fn(),
  };
  setup.video = video;
  return { setup, video };
}

async function settle() { await Vue.nextTick(); await Promise.resolve(); await Promise.resolve(); }

describe('desktop resume and progress', () => {
  it('selects the saved part and position without marking a details visit as watched', async () => {
    const { setup, video } = player();
    expect(setup.selectedPartId).toBe(partTwo);
    setup.onLoadedMetadata();
    expect(video.currentTime).toBe(42);
    setup.onTimeUpdate();
    await onFlush!();
    expect(save).not.toHaveBeenCalled();
    video.paused = false;
    setup.onPlaying(); await settle();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ filmId, partId: partTwo, positionSeconds: 42 }));
    video.currentTime = 50;
    setup.onTimeUpdate(); await settle();
    expect(save).toHaveBeenCalledTimes(1);
    await onFlush!();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ positionSeconds: 50 }));
  });

  it('uses explicit segment positions instead of the saved resume point', async () => {
    const { setup, video } = player();
    video.readyState = 0;
    const segment = { filmFileId: partTwo, startSeconds: 10, endSeconds: 20, vrView: null } as FilmSegmentDto;
    // A segment selected before metadata must not be replaced by the resume point.
    setup.activeSegment = segment;
    video.readyState = 1;
    setup.onLoadedMetadata();
    expect(video.currentTime).toBe(0);
    await setup.playSegment(segment);
    expect(video.currentTime).toBe(10);
    expect(save).not.toHaveBeenCalled();
  });

  it('carries the resume point through compatibility fallback and supports starting over', async () => {
    const { setup, video } = player();
    setup.onPlaybackError({ currentTarget: video });
    expect(setup.playbackSourceMode).toBe('compatibility');
    setup.onLoadedMetadata();
    expect(video.currentTime).toBe(42);
    setup.restartPlayback();
    expect(video.currentTime).toBe(0);
    expect(video.play).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the previous file before switching, and pause/exit save the latest played position', async () => {
    const { setup, video } = player();
    setup.onLoadedMetadata(); video.paused = false;
    setup.onPlaying(); await settle();
    video.currentTime = 60;
    setup.selectPart(partId); await settle();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ partId: partTwo, positionSeconds: 60 }));
    video.currentTime = 0;
    setup.onLoadedMetadata();
    expect(save).toHaveBeenCalledTimes(2);
    setup.onPlaying(); await settle();
    video.currentTime = 25; video.paused = true;
    setup.onPaused(); await settle();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ partId, positionSeconds: 25 }));
  });

  it('does not reapply an old opening bookmark when manually returning to that file', async () => {
    const { setup, video } = player();
    setup.onLoadedMetadata();
    setup.selectPart(partId); await settle();
    video.currentTime = 0; setup.onLoadedMetadata();
    setup.selectPart(partTwo); await settle();
    video.currentTime = 0; setup.onLoadedMetadata();
    expect(video.currentTime).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('handles finished or missing files and retries failed writes without losing a newer position', async () => {
    expect(resumablePlayback({ ...saved, positionSeconds: 100 }, parts)).toEqual({ partId: partTwo, seconds: 0 });
    expect(resumablePlayback(saved, [{ ...parts[1], missing: true }])).toBeNull();
    const snapshots: DesktopPlaybackProgressInput[] = [];
    const write = vi.fn(async (input: DesktopPlaybackProgressInput) => { snapshots.push(input); });
    const tracker = new DesktopPlaybackTracker(write);
    write.mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    await expect(tracker.record({ filmId, partId, positionSeconds: 10 }, true)).rejects.toThrow('SQLITE_BUSY');
    await tracker.record({ filmId, partId, positionSeconds: 20 }, true);
    expect(snapshots.at(-1)?.positionSeconds).toBe(20);
  });
});
