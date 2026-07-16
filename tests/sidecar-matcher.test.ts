import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchSidecars } from '../src/main/scanner/SidecarMatcher';
import type { ScanFileEntry } from '../src/main/scanner/ScanCandidate';

function entry(name: string, folder = 'Movies'): ScanFileEntry {
  const absolutePath = path.join('C:\\test-source', folder, name);
  return { absolutePath, relativePath: path.join(folder, name), name };
}

describe('sidecar matcher', () => {
  it('matches exact NFO, poster, fanart, thumb and preview assets case-insensitively', () => {
    const main = entry('MovieA.MKV');
    const result = matchSidecars(main, [main, entry('MovieA.nfo'), entry('MovieA-poster.JPG'), entry('MovieA-fanart.jpg'), entry('MovieA-thumb.webp'), entry('MovieA-preview.MP4')], [], 1);
    expect(result.nfo?.name).toBe('MovieA.nfo');
    expect(result.assets.map((asset) => asset.assetType)).toEqual(['poster', 'fanart', 'thumb', 'preview']);
  });

  it('uses generic movie.nfo and poster only for a single film directory', () => {
    const main = entry('MovieA.mkv');
    const result = matchSidecars(main, [main, entry('movie.nfo'), entry('folder.jpg'), entry('preview.mp4')], [], 1);
    expect(result.nfo?.name).toBe('movie.nfo');
    expect(result.assets.map((asset) => asset.assetType)).toEqual(['poster', 'preview']);
  });

  it('does not assign generic resources when multiple films share a directory', () => {
    const main = entry('MovieA.mkv');
    const result = matchSidecars(main, [main, entry('MovieB.mkv'), entry('movie.nfo'), entry('poster.jpg'), entry('preview.mp4')], [], 2);
    expect(result.nfo).toBeNull();
    expect(result.assets).toHaveLength(0);
    expect(result.ambiguousAssets).toBeGreaterThan(0);
  });

  it('uses each bare same-name JPG as its film poster in a multi-film directory', () => {
    const movieA = entry('MovieA.mkv');
    const movieB = entry('MovieB.mp4');
    const files = [movieA, movieB, entry('MovieA.jpg'), entry('MovieB.JPEG'), entry('poster.jpg')];

    const resultA = matchSidecars(movieA, files, [], 2);
    const resultB = matchSidecars(movieB, files, [], 2);

    expect(resultA.assets.filter((asset) => asset.assetType === 'poster').map((asset) => asset.entry.name)).toEqual(['MovieA.jpg']);
    expect(resultB.assets.filter((asset) => asset.assetType === 'poster').map((asset) => asset.entry.name)).toEqual(['MovieB.JPEG']);
    expect(resultA.assets.some((asset) => asset.entry.name === 'poster.jpg')).toBe(false);
  });

  it('keeps explicit poster and single-film generic poster priorities unchanged', () => {
    const multiFilmMain = entry('MovieA.mkv');
    const multiFilmFiles = [multiFilmMain, entry('MovieB.mkv'), entry('MovieA.jpg'), entry('MovieA-poster.jpg')];
    const multiFilmResult = matchSidecars(multiFilmMain, multiFilmFiles, [], 2);
    expect(multiFilmResult.assets.filter((asset) => asset.assetType === 'poster').map((asset) => asset.entry.name)).toEqual(['MovieA-poster.jpg']);

    const singleFilmMain = entry('MovieC.mkv');
    const singleFilmResult = matchSidecars(singleFilmMain, [singleFilmMain, entry('MovieC.jpg'), entry('folder.jpg')], [], 1);
    expect(singleFilmResult.assets.filter((asset) => asset.assetType === 'poster').map((asset) => asset.entry.name)).toEqual(['folder.jpg']);
  });

  it('matches a bare JPG to a multipart film logical base name', () => {
    const main = entry('MovieA-cd1.mkv');
    const files = [main, entry('MovieA-cd2.mkv'), entry('MovieB.mkv'), entry('MovieA.jpg')];
    const result = matchSidecars(main, files, [], 2, undefined, undefined, 'MovieA');
    expect(result.assets.filter((asset) => asset.assetType === 'poster').map((asset) => asset.entry.name)).toEqual(['MovieA.jpg']);
  });

  it('sorts extrafanart naturally', () => {
    const main = entry('MovieA.mkv');
    const result = matchSidecars(main, [main], [entry('10.jpg', 'Movies/extrafanart'), entry('2.jpg', 'Movies/extrafanart'), entry('1.jpg', 'Movies/extrafanart')], 1);
    expect(result.assets.filter((asset) => asset.assetType === 'extra_fanart').map((asset) => asset.entry.name)).toEqual(['1.jpg', '2.jpg', '10.jpg']);
  });

  it('ignores unsupported sidecar extensions', () => {
    const main = entry('MovieA.mkv');
    const result = matchSidecars(main, [main, entry('MovieA-poster.bmp'), entry('MovieA.llc'), entry('MovieA-proj.llc')], [], 1);
    expect(result.assets).toHaveLength(0);
  });
});
