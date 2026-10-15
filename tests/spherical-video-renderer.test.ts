import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SphericalVideoRenderer,
  clampSphericalFov,
  clampSphericalPitch,
} from '../src/renderer/media/SphericalVideoRenderer';

describe('spherical video view constraints', () => {
  it('keeps vertical rotation away from the panorama poles', () => {
    const maximum = (85 * Math.PI) / 180;
    expect(clampSphericalPitch(0.5)).toBe(0.5);
    expect(clampSphericalPitch(Math.PI)).toBeCloseTo(maximum);
    expect(clampSphericalPitch(-Math.PI)).toBeCloseTo(-maximum);
  });

  it('keeps wheel zoom within a usable field of view', () => {
    expect(clampSphericalFov(75)).toBe(75);
    expect(clampSphericalFov(5)).toBe(30);
    expect(clampSphericalFov(150)).toBe(100);
  });
});


function renderFixture(videoFrames = true) {
  const animationFrames = new Map<number, FrameRequestCallback>();
  const decodedFrames = new Map<number, () => void>();
  let nextId = 1;
  const documentTarget = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++; animationFrames.set(id, callback); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => animationFrames.delete(id));
  const disconnect = vi.fn();
  let resize!: () => void;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const gl = new Proxy<Record<string, ReturnType<typeof vi.fn>>>({}, {
    get(target, key: string) { return target[key] ??= vi.fn(() => 1); },
  });
  const canvas = Object.assign(new EventTarget(), {
    width: 0, height: 0, style: {},
    getContext: () => gl,
    getBoundingClientRect: vi.fn(() => ({ width: 640, height: 360 })),
  });
  const video = Object.assign(new EventTarget(), {
    readyState: 2, currentTime: 0, paused: true, ended: false,
    ...(videoFrames ? {
      requestVideoFrameCallback: (callback: () => void) => {
        const id = nextId++; decodedFrames.set(id, callback); return id;
      },
      cancelVideoFrameCallback: (id: number) => decodedFrames.delete(id),
    } : {}),
  });
  const renderer = new SphericalVideoRenderer(video as unknown as HTMLVideoElement, canvas as unknown as HTMLCanvasElement);
  const paint = () => {
    const pending = [...animationFrames.values()]; animationFrames.clear();
    for (const callback of pending) callback(0);
  };
  const decode = () => {
    const pending = [...decodedFrames.values()]; decodedFrames.clear();
    for (const callback of pending) callback();
  };
  return { renderer, gl, video, canvas, animationFrames, decodedFrames, documentTarget, disconnect, paint, decode, resize: () => resize() };
}

afterEach(() => vi.unstubAllGlobals());

describe('spherical renderer frame scheduling', () => {
  it('stays idle when paused and redraws viewpoint changes without reuploading video', () => {
    const f = renderFixture();
    f.paint();
    expect(f.animationFrames.size).toBe(0);
    f.gl.texImage2D.mockClear();
    f.gl.drawArrays.mockClear();
    f.canvas.getBoundingClientRect.mockClear();
    f.renderer.setView({ yawDegrees: 20, pitchDegrees: 10, fovDegrees: 60 });
    f.renderer.resetView();
    expect(f.animationFrames.size).toBe(1);
    f.paint();
    expect(f.gl.drawArrays).toHaveBeenCalledTimes(1);
    expect(f.gl.texImage2D).not.toHaveBeenCalled();
    expect(f.canvas.getBoundingClientRect).not.toHaveBeenCalled();
    expect(f.animationFrames.size).toBe(0);
    f.resize(); f.paint();
    expect(f.canvas.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(f.gl.texImage2D).not.toHaveBeenCalled();
    f.renderer.dispose();
  });

  it('uploads decoded frames and paused seeks, and releases callbacks on hide/dispose', () => {
    const f = renderFixture(); f.paint(); f.gl.texImage2D.mockClear();
    f.decode(); f.paint();
    expect(f.gl.texImage2D).toHaveBeenCalledTimes(1);
    expect(f.animationFrames.size).toBe(0);
    f.video.currentTime = 10;
    f.video.dispatchEvent(new Event('seeked')); f.paint();
    expect(f.gl.texImage2D).toHaveBeenCalledTimes(2);
    f.documentTarget.hidden = true;
    f.documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(f.decodedFrames.size).toBe(0);
    expect(f.animationFrames.size).toBe(0);
    f.documentTarget.hidden = false;
    f.documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(f.decodedFrames.size).toBe(1);
    expect(f.animationFrames.size).toBe(1);
    f.renderer.dispose();
    expect(f.disconnect).toHaveBeenCalledTimes(1);
    expect(f.decodedFrames.size).toBe(0);
    expect(f.animationFrames.size).toBe(0);
    f.video.dispatchEvent(new Event('playing'));
    expect(f.animationFrames.size).toBe(0);
  });

  it('falls back to RAF only during playback when video frame callbacks are unavailable', () => {
    const f = renderFixture(false); f.paint();
    expect(f.animationFrames.size).toBe(0);
    f.video.paused = false;
    f.video.dispatchEvent(new Event('playing')); f.paint();
    expect(f.animationFrames.size).toBe(1);
    f.gl.texImage2D.mockClear(); f.paint();
    expect(f.gl.texImage2D).not.toHaveBeenCalled();
    f.video.currentTime = 1; f.paint();
    expect(f.gl.texImage2D).toHaveBeenCalledTimes(1);
    f.video.paused = true;
    f.video.dispatchEvent(new Event('pause')); f.paint();
    expect(f.animationFrames.size).toBe(0);
    f.renderer.dispose();
  });
});
