import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppLogger } from '../src/main/system/AppLogger';
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
});
