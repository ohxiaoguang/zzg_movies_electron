import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSafeMediaPath, isPathWithinRoot } from '../src/main/media/MediaPathResolver';
import { parseRangeHeader } from '../src/main/media/RangeResponse';
import { parseMediaUrl } from '../src/main/media/MediaProtocol';

describe('media path safety', () => {
  it('accepts a normal file inside the source', () => {
    const root = path.join(os.tmpdir(), 'film-library-path-test');
    const target = resolveSafeMediaPath(root, path.join('中文目录', 'Movie (2026).mkv'));
    expect(isPathWithinRoot(root, target)).toBe(true);
  });

  it('rejects traversal and absolute paths', () => {
    const root = path.join(os.tmpdir(), 'film-library-path-test');
    expect(() => resolveSafeMediaPath(root, '..' + path.sep + 'outside.mkv')).toThrow('MEDIA_PATH_OUTSIDE_SOURCE');
    expect(() => resolveSafeMediaPath(root, path.resolve(root, '..', 'outside.mkv'))).toThrow('MEDIA_PATH_INVALID');
  });

  it('handles different drive paths as outside on Windows', () => {
    if (process.platform !== 'win32') return;
    expect(isPathWithinRoot('C:\\Movies', 'D:\\Movies\\Film.mkv')).toBe(false);
  });

  it('can be used with a real temporary path without touching user media', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-safe-'));
    expect(resolveSafeMediaPath(root, 'clip.mp4')).toBe(path.join(root, 'clip.mp4'));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('HTTP Range parsing', () => {
  it('returns a full range without a Range header', () => {
    expect(parseRangeHeader(null, 100)).toEqual({ ok: true, range: { start: 0, end: 99 } });
  });

  it('parses start/end, open-ended and suffix ranges', () => {
    expect(parseRangeHeader('bytes=10-19', 100)).toEqual({ ok: true, range: { start: 10, end: 19 } });
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({ ok: true, range: { start: 90, end: 99 } });
    expect(parseRangeHeader('bytes=-10', 100)).toEqual({ ok: true, range: { start: 90, end: 99 } });
  });

  it('clamps an oversized end and rejects invalid ranges', () => {
    expect(parseRangeHeader('bytes=90-999', 100)).toEqual({ ok: true, range: { start: 90, end: 99 } });
    expect(parseRangeHeader('bytes=100-101', 100)).toEqual({ ok: false, contentRange: 'bytes */100' });
  });
});

describe('film-media URL routing', () => {
  it('parses the host-style protocol route without exposing a path', () => {
    expect(parseMediaUrl('film-media://asset/123e4567-e89b-12d3-a456-426614174000')).toEqual({
      kind: 'asset',
      id: '123e4567-e89b-12d3-a456-426614174000',
    });
    expect(parseMediaUrl('film-media://poster/123e4567-e89b-12d3-a456-426614174000?path=C:/secret')).toBeNull();
    expect(parseMediaUrl('film-media://asset/not-a-uuid')).toBeNull();
  });
});
