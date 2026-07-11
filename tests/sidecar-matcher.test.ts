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
