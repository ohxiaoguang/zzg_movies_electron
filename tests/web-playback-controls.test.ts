/* eslint-disable @typescript-eslint/no-explicit-any -- VM tests exercise the untyped browser script with minimal DOM doubles. */
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync('src/main/server/web/app.js', 'utf8');
function code(name: string): string {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  const rest = source.slice(start);
  const end = rest.slice(1).search(/^(?:async )?function /m);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

class Node {
  children: Node[] = [];
  listeners: Record<string, ((event: any) => any)[]> = {};
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  classList = { toggle: vi.fn(), remove: vi.fn() };
  hidden = false;
  offsetWidth = 30;
  currentTime = 0;
  duration = Infinity;
  paused = false;
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(async () => { this.paused = false; });
  seekable = { length: 1, start: () => 0, end: () => 20 };
  seekToSeconds?: (seconds: number) => void;
  constructor(public tag: string, public className = '', public textContent = '') {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  dispatchEvent(event: Event) { for (const fn of this.listeners[event.type] || []) void fn(event); return true; }
  addEventListener(name: string, fn: (event: any) => any) { (this.listeners[name] ||= []).push(fn); }
  async fire(name: string, event: any = {}) { for (const fn of this.listeners[name] || []) await fn(event); await new Promise(resolve => setImmediate(resolve)); }
  getBoundingClientRect() { return { left: 0, width: 100 }; }
  querySelectorAll(selector: string): Node[] {
    return this.children.flatMap(node => [...(selector === '.' + node.className ? [node] : []), ...node.querySelectorAll(selector)]);
  }
}

function setup(options: { runtimeSeconds?: number | null; metadata?: () => Promise<{ durationSeconds: number | null }> } = {}) {
  const state: any = { playback: null };
  const inputs: any[] = [];
  const video = new Node('video');
  const context: any = {
    state, Date, Number, Math, Event,
    elements: { filmDetail: { open: true } },
    document: { createElement: (tag: string) => tag === 'video' ? video : new Node(tag) },
    createElement: (tag: string, cls = '', text = '') => new Node(tag, cls, text),
    actionButton: (text: string, fn: () => any, cls = '') => {
      const button = new Node('button', cls, text); button.addEventListener('click', fn); return button;
    },
    resetSubtitlePicker: vi.fn(), selectSubtitleTrack: vi.fn(), activeVrRenderer: null,
    configuredSeekStepSeconds: () => 5, configuredFineSeekStepSeconds: () => .1,
    client: { updatePlaybackProgress: vi.fn(async () => {}), playbackMetadata: vi.fn(options.metadata || (async () => ({ durationSeconds: null }))) },
    startAdaptivePlayback: vi.fn(async (_video: Node, _status: Node, input: any) => {
      inputs.push(input);
      video.currentTime = 0;
      const session = { id: String(inputs.length) };
      state.playback = { video, sessionId: session.id, transport: 'hls', sourceOffsetSeconds: input.startSeconds || 0, durationSeconds: 100, lastProgressAt: Date.now() };
      return session;
    }),
  };
  vm.createContext(context);
  vm.runInContext(['handleDetailPlaybackKey', 'createUnifiedPlayback', 'playbackPosition', 'playbackDuration', 'canSeekPlaybackTo', 'seekVideoBy', 'formatPlaybackTime'].map(code).join('\n'), context);
  const film = { id: 'film', runtimeSeconds: options.runtimeSeconds === undefined ? 100 : options.runtimeSeconds, parts: [{ id: 'part', filename: 'film.mkv', partType: 'single' }],
    segments: [{ id: 'segment', filmFileId: 'part', title: '片段', startSeconds: 20, endSeconds: 40, includeInPreview: true }] };
  const player = context.createUnifiedPlayback(film);
  return { context, state, inputs, video, player };
}

describe('web detail playback interactions', () => {
  it('captures Space on focused detail buttons and toggles playback once per press', async () => {
    const { context, state, player, inputs, video } = setup();
    state.detailPlayback = player;
    const event = {
      type: 'keydown', code: 'Space', key: ' ', repeat: false,
      target: { matches: () => false }, // The initially focused close button.
      preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    context.handleDetailPlaybackKey(event);
    await new Promise(resolve => setImmediate(resolve));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(inputs).toHaveLength(1);
    context.handleDetailPlaybackKey(event);
    expect(video.pause).toHaveBeenCalledOnce();
    context.handleDetailPlaybackKey({ ...event, type: 'keyup' });
    context.handleDetailPlaybackKey({ ...event, repeat: true });
    expect(video.play).not.toHaveBeenCalled();
    context.handleDetailPlaybackKey(event);
    expect(video.play).toHaveBeenCalledOnce();
    expect(inputs).toHaveLength(1);
  });

  it('preserves typing in editable fields and ignores Space outside an open detail', () => {
    const { context, state } = setup();
    state.detailPlayback = { togglePlayback: vi.fn() };
    const event = {
      type: 'keydown', code: 'Space', key: ' ', repeat: false,
      target: { matches: () => true }, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(),
    };
    context.handleDetailPlaybackKey(event);
    context.handleDetailPlaybackKey({ ...event, target: { isContentEditable: true } });
    context.elements.filmDetail.open = false;
    context.handleDetailPlaybackKey({ ...event, target: { matches: () => false } });
    expect(state.detailPlayback.togglePlayback).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('reads the complete video duration before playback and preserves the unmarked tail', async () => {
    let resolveMetadata!: (value: { durationSeconds: number | null }) => void;
    const metadata = new Promise<{ durationSeconds: number | null }>(resolve => { resolveMetadata = resolve; });
    const { player, inputs, state, context, video } = setup({ runtimeSeconds: null, metadata: () => metadata });
    const track = player.section.querySelectorAll('.web-segment-timeline')[0];
    const node = track.children[0];
    expect(node.hidden).toBe(true);
    expect(track.attributes['aria-disabled']).toBe('true');
    await track.fire('click', { clientX: 90 });
    expect(inputs).toHaveLength(0);
    resolveMetadata({ durationSeconds: 100 });
    await new Promise(resolve => setImmediate(resolve));
    expect(context.client.playbackMetadata).toHaveBeenCalledWith('part');
    expect(node.hidden).toBe(false);
    expect(node.style.left).toBe('20%');
    expect(node.style.width).toBe('20%');
    expect(track.attributes['aria-valuemax']).toBe('100');
    expect(state.playback).toBeNull();
    expect(video.play).not.toHaveBeenCalled();
    expect(inputs).toHaveLength(0);
  });

  it('places the tooltip near the pointer and clamps it at both edges', async () => {
    const { player } = setup();
    const track = player.section.querySelectorAll('.web-segment-timeline')[0];
    const tooltip = player.section.querySelectorAll('.web-timeline-tooltip')[0];
    await track.fire('pointermove', { clientX: 30, target: track });
    expect(tooltip.style.left).toBe('15px');
    await track.fire('pointermove', { clientX: 60, target: track });
    expect(tooltip.style.left).toBe('45px');
    await track.fire('pointermove', { clientX: 0, target: track });
    expect(tooltip.style.left).toBe('0px');
    await track.fire('pointermove', { clientX: 100, target: track });
    expect(tooltip.style.left).toBe('70px');
  });

  it('keeps annotations on the full-file scale during HLS loading and source replacement', async () => {
    const { player, state, video } = setup();
    const track = player.section.querySelectorAll('.web-segment-timeline')[0];
    const node = track.children[0];
    expect(node.style.left).toBe('20%');
    state.playback = { video, partId: 'part', transport: 'hls', durationSeconds: null, mediaReady: false };
    video.duration = 4;
    await video.fire('durationchange');
    expect(node.style.left).toBe('20%');
    expect(node.style.width).toBe('20%');
    state.playback.durationSeconds = 200;
    video.dispatchEvent(new Event('playback:session'));
    expect(node.style.left).toBe('10%');
    state.playback.durationSeconds = null;
    video.duration = Infinity;
    await video.fire('durationchange');
    expect(node.style.left).toBe('10%');
    video.duration = 2;
    await video.fire('loadedmetadata');
    expect(node.style.left).toBe('10%');
    expect(track.attributes['aria-valuemax']).toBe('200');
  });

  it('shows the hovered time and annotation range, including narrow markers, and hides on leave', async () => {
    const { player } = setup();
    const track = player.section.querySelectorAll('.web-segment-timeline')[0];
    const tooltip = player.section.querySelectorAll('.web-timeline-tooltip')[0];
    expect(tooltip.hidden).toBe(true);
    await track.fire('pointermove', { clientX: 30, target: track.children[0] });
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toBe('0:30\n片段 · 0:20 → 0:40');
    await track.fire('pointermove', { clientX: 60, target: track });
    expect(tooltip.textContent).toBe('1:00');
    await track.fire('pointerleave');
    expect(tooltip.hidden).toBe(true);
    await track.fire('pointermove', { clientX: 19, target: track.children[0] });
    expect(tooltip.textContent).toContain('片段 · 0:20 → 0:40');
  });

  it('seeks at the clicked annotation position and restarts HLS outside generated ranges', async () => {
    const { player, inputs, state, video } = setup();
    const track = player.section.querySelectorAll('.web-segment-timeline')[0];
    expect(track.children[0].tag).toBe('span');
    expect(track.children[0].listeners.click).toBeUndefined();
    await track.fire('click', { clientX: 30 });
    expect(inputs[0]).toEqual({ partId: 'part', startSeconds: 30 });
    await track.fire('click', { clientX: 35 });
    expect(inputs).toHaveLength(1);
    expect(video.currentTime).toBe(5);
    await track.fire('click', { clientX: 80 });
    expect(inputs[1]).toEqual({ partId: 'part', startSeconds: 80 });
    expect(state.playback.sourceOffsetSeconds).toBe(80);
    await track.fire('click', { clientX: 10 });
    expect(inputs[2].startSeconds).toBe(10);
  });

  it('plays from the list start and continues beyond the annotation end', async () => {
    const { player, inputs, video } = setup();
    await player.segmentsPanel.querySelectorAll('.web-segment-row')[0].fire('click');
    expect(inputs[0]).toEqual({ partId: 'part', startSeconds: 20 });
    video.currentTime = 21;
    await video.fire('timeupdate');
    expect(video.pause).not.toHaveBeenCalled();
    expect(inputs).toHaveLength(1);
    expect(player.section.querySelectorAll('.segment-current-label')[0].children).toHaveLength(0);
  });

  it('uses original-file times for keyboard seeking and progress persistence', async () => {
    const { player, context, video, inputs, state } = setup();
    await player.section.querySelectorAll('.web-segment-timeline')[0].fire('click', { clientX: 30 });
    video.currentTime = 19;
    player.seek(5);
    await new Promise(resolve => setImmediate(resolve));
    expect(inputs[1].startSeconds).toBe(54);
    state.playback.lastProgressAt = 0;
    video.currentTime = 3;
    await video.fire('timeupdate');
    expect(context.client.updatePlaybackProgress).toHaveBeenLastCalledWith('2', { positionSeconds: 57, durationSeconds: 100 });
    expect(context.playbackDuration(video)).toBe(100);
  });

  it('updates categories without rebuilding the player or resetting detail tabs', async () => {
    const old = { replaceWith: vi.fn() };
    const replacement = {};
    const context: any = {
      client: { film: vi.fn(async () => ({ id: 'film' })) },
      elements: { filmDetail: { open: true }, detailContent: { dataset: { filmId: 'film' }, querySelector: vi.fn(() => old) } },
      toast: vi.fn(), reloadLibrary: vi.fn(async () => {}), createCategoryEditor: vi.fn(() => replacement),
      renderDetail: vi.fn(), showError: vi.fn(),
    };
    vm.createContext(context);
    vm.runInContext(code('updateDetail'), context);
    await context.updateDetail('film', async () => {}, 'saved', { categoriesOnly: true });
    expect(old.replaceWith).toHaveBeenCalledWith(replacement);
    expect(context.renderDetail).not.toHaveBeenCalled();
    context.elements.detailContent.dataset.filmId = 'other';
    await context.updateDetail('film', async () => {}, 'saved', { categoriesOnly: true });
    expect(old.replaceWith).toHaveBeenCalledTimes(1);
  });
});
