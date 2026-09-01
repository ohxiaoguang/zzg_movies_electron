import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../src/main/system/AppLogger';
import { MediaCapabilityService } from '../src/main/media/MediaCapabilityService';
import {
  buildPreviewTranscodeArgs,
  previewCacheKey,
  PreviewTranscoder,
  resolvePreviewToolPaths,
} from '../src/main/media/PreviewTranscoder';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function toolDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-preview-tools-'));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, 'ffmpeg.exe'), 'fixture');
  fs.writeFileSync(path.join(root, 'ffprobe.exe'), 'fixture');
  return root;
}

class TranscodeCapabilityStub extends MediaCapabilityService {
  public constructor() {
    super(() => '');
  }

  public override toolPaths(): { ffmpeg: string; ffprobe: null } {
    return { ffmpeg: 'ffmpeg', ffprobe: null };
  }

  public override async playbackPlan(_filePath: string) {
    return {
      probe: null,
      plan: {
        mode: 'transcode' as const,
        reason: 'PROBE_UNAVAILABLE_TRANSCODE_FALLBACK' as const,
        videoMode: 'transcode' as const,
        audioMode: 'transcode' as const,
      },
    };
  }
}

describe('compatibility preview transcoder', () => {
  it('finds ffmpeg next to configured ffprobe and on PATH', () => {
    const root = toolDirectory();
    expect(resolvePreviewToolPaths(path.join(root, 'ffprobe.exe'), '', 'win32')).toEqual({
      ffmpeg: path.join(root, 'ffmpeg.exe'),
      ffprobe: path.join(root, 'ffprobe.exe'),
    });
    expect(resolvePreviewToolPaths('', root, 'win32')).toEqual({
      ffmpeg: path.join(root, 'ffmpeg.exe'),
      ffprobe: path.join(root, 'ffprobe.exe'),
    });
  });

  it('remuxes browser-compatible H.264/AAC without re-encoding', () => {
    const args = buildPreviewTranscodeArgs('clip.mkv', { video: 'h264', audio: 'aac' }, 'cached.mp4.partial');
    expect(args).toContain('copy');
    expect(args).not.toContain('libx264');
    expect(args.slice(-5)).toEqual(['-movflags', '+faststart', '-f', 'mp4', 'cached.mp4.partial']);
    expect(args).not.toContain('pipe:1');
  });

  it('transcodes HEVC video and incompatible audio to H.264/AAC', () => {
    const args = buildPreviewTranscodeArgs('clip.mkv', { video: 'hevc', audio: 'dts' }, 'cached.mp4.partial');
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args).toContain('aac');
    expect(args).toContain("scale=w='min(1280,iw)':h=-2");
  });

  it('handles legacy containers through the compatibility cache', () => {
    const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'film-preview-logs-'));
    tempRoots.push(logs);
    const transcoder = new PreviewTranscoder(new AppLogger(logs), () => '', path.join(logs, 'cache'));
    for (const extension of ['MKV', 'mpg', 'mpeg', 'avi', 'ts', 'flv', 'wmv']) {
      expect(transcoder.shouldTranscode(`movie.${extension}`)).toBe(true);
    }
    expect(transcoder.shouldTranscode('movie.mp4')).toBe(false);
    expect(transcoder.shouldTranscode('movie.webm')).toBe(false);
  });

  it('invalidates cached previews when source size or modification time changes', () => {
    const first = previewCacheKey('C:\\Movies\\clip.mkv', 100, 1_000);
    expect(previewCacheKey('C:\\Movies\\clip.mkv', 100, 1_000)).toBe(first);
    expect(previewCacheKey('C:\\Movies\\clip.mkv', 101, 1_000)).not.toBe(first);
    expect(previewCacheKey('C:\\Movies\\clip.mkv', 100, 2_000)).not.toBe(first);
  });

  it('stops a shared ffmpeg conversion after its last media request is cancelled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-preview-cancel-'));
    tempRoots.push(root);
    const sourcePath = path.join(root, 'movie.mkv');
    fs.writeFileSync(sourcePath, Buffer.alloc(2048));
    let started!: () => void;
    const runnerStarted = new Promise<void>((resolve) => { started = resolve; });
    const runnerSignals: AbortSignal[] = [];
    const transcoder = new PreviewTranscoder(
      new AppLogger(root),
      () => '',
      path.join(root, 'cache'),
      new TranscodeCapabilityStub(),
      async (_ffmpegPath, _args, signal) => {
        runnerSignals.push(signal);
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = transcoder.prepareCachedFile(sourcePath, firstController.signal);
    const second = transcoder.prepareCachedFile(sourcePath, secondController.signal);

    await runnerStarted;
    const internals = transcoder as unknown as { conversions: Map<string, { consumers: number }> };
    await vi.waitFor(() => {
      expect([...internals.conversions.values()][0]?.consumers).toBe(2);
    });
    expect(runnerSignals).toHaveLength(1);
    firstController.abort();
    expect(await first).toBeNull();
    expect(runnerSignals[0]!.aborted).toBe(false);

    secondController.abort();
    expect(await second).toBeNull();
    expect(runnerSignals[0]!.aborted).toBe(true);
  });

  it('explicitly cancels an active conversion when the detail player closes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-preview-explicit-cancel-'));
    tempRoots.push(root);
    const sourcePath = path.join(root, 'movie.mkv');
    fs.writeFileSync(sourcePath, Buffer.alloc(2048));
    let started!: () => void;
    const runnerStarted = new Promise<void>((resolve) => { started = resolve; });
    let runnerSignal: AbortSignal | null = null;
    const transcoder = new PreviewTranscoder(
      new AppLogger(root),
      () => '',
      path.join(root, 'cache'),
      new TranscodeCapabilityStub(),
      async (_ffmpegPath, _args, signal) => {
        runnerSignal = signal;
        started();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    );
    const pending = transcoder.prepareCachedFile(sourcePath, new AbortController().signal);

    await runnerStarted;
    expect(transcoder.cancel(sourcePath)).toBe(true);
    expect(await pending).toBeNull();
    expect(runnerSignal).not.toBeNull();
    expect((runnerSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it('honors explicit cancellation while media probing is still pending', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-preview-probe-cancel-'));
    tempRoots.push(root);
    const sourcePath = path.join(root, 'movie.mkv');
    fs.writeFileSync(sourcePath, Buffer.alloc(2048));
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const capabilities = new TranscodeCapabilityStub();
    const originalPlaybackPlan = capabilities.playbackPlan.bind(capabilities);
    capabilities.playbackPlan = async (filePath: string) => {
      await probeGate;
      return originalPlaybackPlan(filePath);
    };
    let runnerCalls = 0;
    const transcoder = new PreviewTranscoder(
      new AppLogger(root),
      () => '',
      path.join(root, 'cache'),
      capabilities,
      async () => { runnerCalls += 1; },
    );
    const pending = transcoder.prepareCachedFile(sourcePath, new AbortController().signal);

    expect(transcoder.cancel(sourcePath)).toBe(false);
    releaseProbe();
    expect(await pending).toBeNull();
    expect(runnerCalls).toBe(0);
  });
});
