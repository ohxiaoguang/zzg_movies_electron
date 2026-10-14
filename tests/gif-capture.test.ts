import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';

interface CaptureBindings {
  preview: unknown;
  rangeTrack: unknown;
  rangeSeconds: number;
  busy: boolean;
  form: { startSeconds: number; endSeconds: number; width: number; fps: number; setAsCover: boolean };
  loaded(): void;
  timeUpdate(): void;
  ended(): void;
  moveRange(start: number): void;
  handleKeydown(event: ReturnType<typeof key>): void;
  pointerDown(event: unknown): void;
  pointerMove(event: unknown): void;
  pointerEnd(): void;
  generate(): Promise<void>;
}

const apps: Array<{ unmount(): void }> = [];
const createGif = vi.fn(async () => ({ ok: false, error: { code: 'TEST', message: 'test' } }));
beforeEach(() => {
  createGif.mockClear();
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), filmLibrary: { films: {
    onGifProgress: () => vi.fn(), createGif, cancelGif: vi.fn(async () => ({ ok: true })),
  } } });
});
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); vi.unstubAllGlobals(); });

async function capture(duration = 100, current = 42) {
  const filename = path.resolve('src/renderer/components/film/FilmGifCapture.vue');
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'gif-capture-test' });
  const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { default?: Vue.Component } = {};
  const require = (name: string): unknown => {
    if (name === 'vue') return Vue;
    if (name === 'element-plus') return { ElMessage: { info: vi.fn(), success: vi.fn() } };
    if (name.endsWith('/api')) return { mediaUrl: (kind: string, id: string) => `film-media://${kind}/${id}` };
    throw new Error(`Unexpected import: ${name}`);
  };
  new Function('require', 'exports', code)(require, exports);
  const component = exports.default!;
  Object.assign(component, { render: () => null });
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert: () => {}, remove: () => {}, setText: () => {}, setElementText: () => {},
    parentNode: () => null, nextSibling: () => null, patchProp: () => {},
  });
  const props = Vue.reactive({ modelValue: false, film: { id: 'film' }, snapshot: { partId: 'part', filename: 'movie.mp4', currentSeconds: current, durationSeconds: duration } });
  const app = renderer.createApp({ render: () => Vue.h(component, props) });
  app.mount({}); apps.push(app);
  const setup = (app._instance!.subTree.component! as unknown as { setupState: CaptureBindings }).setupState;
  const video = { currentTime: 0, readyState: 1, paused: true,
    play: vi.fn(async () => { video.paused = false; }), pause: vi.fn(() => { video.paused = true; }) };
  setup.preview = video;
  props.modelValue = true;
  await Vue.nextTick();
  setup.loaded();
  return { setup, video, props };
}
function key(code: string, closest = false) {
  return { code, repeat: false, target: { closest: () => closest }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
}

describe('GIF range preview', () => {
  it('opens at current position and loops the selected range, including the file end', async () => {
    const { setup, video } = await capture();
    expect(setup.form).toMatchObject({ startSeconds: 42, endSeconds: 47 });
    expect(video.play).toHaveBeenCalledOnce();
    video.currentTime = 47;
    setup.timeUpdate();
    expect(video.currentTime).toBe(42);
    setup.moveRange(100);
    await Vue.nextTick();
    expect(setup.form).toMatchObject({ startSeconds: 95, endSeconds: 100 });
    setup.ended();
    expect(video.currentTime).toBe(95);
    expect(video.play).toHaveBeenCalledTimes(2);
  });
  it('moves by half a second, clamps both edges and preserves pause while moving', async () => {
    const { setup, video } = await capture();
    setup.handleKeydown(key('Space'));
    expect(video.paused).toBe(true);
    setup.handleKeydown(key('ArrowLeft'));
    await Vue.nextTick();
    expect(setup.form).toMatchObject({ startSeconds: 41.5, endSeconds: 46.5 });
    expect(video.currentTime).toBe(41.5);
    expect(video.paused).toBe(true);
    setup.handleKeydown(key('ArrowRight'));
    expect(setup.form.startSeconds).toBe(42);
    setup.moveRange(-10);
    setup.handleKeydown(key('ArrowLeft'));
    expect(setup.form.startSeconds).toBe(0);
    setup.moveRange(100);
    setup.handleKeydown(key('ArrowRight'));
    expect(setup.form.endSeconds).toBe(100);
    setup.handleKeydown(key('Space'));
    expect(video.paused).toBe(false);
  });
  it('resizes near the end, handles short videos and submits the chosen range and options', async () => {
    const { setup } = await capture(3, 2.9);
    expect(setup.form).toMatchObject({ startSeconds: 0, endSeconds: 3 });
    setup.rangeSeconds = 1;
    await Vue.nextTick();
    setup.moveRange(2.5);
    expect(setup.form).toMatchObject({ startSeconds: 2, endSeconds: 3 });
    setup.form.width = 640;
    setup.form.fps = 15;
    setup.form.setAsCover = false;
    await setup.generate();
    expect(createGif).toHaveBeenCalledWith(expect.objectContaining({ filmId: 'film', partId: 'part', startSeconds: 2, endSeconds: 3, width: 640, fps: 15, setAsCover: false }));
  });
  it('drags the full interval and leaves input fields and busy jobs alone', async () => {
    const { setup } = await capture();
    setup.rangeTrack = { getBoundingClientRect: () => ({ left: 0, width: 100 }), focus: vi.fn(), setPointerCapture: vi.fn() };
    setup.pointerDown({ pointerId: 1, clientX: 45, button: 0, target: { closest: () => true }, preventDefault: vi.fn() });
    setup.pointerMove({ pointerId: 1, clientX: 46 });
    expect(setup.form).toMatchObject({ startSeconds: 43, endSeconds: 48 });
    setup.pointerEnd();
    setup.handleKeydown(key('ArrowRight', true));
    expect(setup.form.startSeconds).toBe(43);
    setup.busy = true;
    setup.handleKeydown(key('ArrowRight'));
    expect(setup.form.startSeconds).toBe(43);
  });
});
