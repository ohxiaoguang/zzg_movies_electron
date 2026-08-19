import { describe, expect, it } from 'vitest';
import {
  buildPosterThumbnailArgs,
  posterThumbnailCacheKey,
  selectPosterTimestamp,
} from '../src/main/media/PosterThumbnailer';

describe('automatic poster thumbnailer', () => {
  it('uses Jellyfin-style 10% positioning with a ten-second fallback', () => {
    expect(selectPosterTimestamp(7_200)).toBe(720);
    expect(selectPosterTimestamp(30)).toBe(3);
    expect(selectPosterTimestamp(null)).toBe(10);
    expect(selectPosterTimestamp(0)).toBe(10);
  });

  it('extracts one bounded JPEG at the selected timestamp', () => {
    const args = buildPosterThumbnailArgs('movie.mkv', 'poster.jpg', 720);
    expect(args).toContain('0:v:0');
    expect(args).toContain('1');
    expect(args).toContain("scale=w='min(720,iw)':h=-2");
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '720.000']);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args.at(-1)).toBe('poster.jpg');
  });

  it('invalidates a generated poster when the source video changes', () => {
    const first = posterThumbnailCacheKey('C:\\Movies\\movie.mkv', 100, 1_000);
    expect(posterThumbnailCacheKey('C:\\Movies\\movie.mkv', 100, 1_000)).toBe(first);
    expect(posterThumbnailCacheKey('C:\\Movies\\movie.mkv', 101, 1_000)).not.toBe(first);
    expect(posterThumbnailCacheKey('C:\\Movies\\movie.mkv', 100, 2_000)).not.toBe(first);
  });
});
