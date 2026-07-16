import fs from 'node:fs';
import path from 'node:path';
import type { AssetType } from '../../shared/enums';
import { DEFAULT_IMAGE_EXTENSIONS, DEFAULT_VIDEO_EXTENSIONS } from '../../shared/enums';
import type { ScanFileEntry, MatchedAsset } from './ScanCandidate';

export interface SidecarMatch {
  nfo: ScanFileEntry | null;
  assets: Array<{ assetType: AssetType; entry: ScanFileEntry; sortOrder: number }>;
  ambiguousAssets: number;
}

const assetSuffixes: Record<AssetType, string[]> = {
  poster: ['poster'],
  fanart: ['fanart'],
  thumb: ['thumb'],
  extra_fanart: [],
  preview: ['preview'],
  trailer: ['trailer'],
  sample: ['sample'],
};

const genericNames: Record<Exclude<AssetType, 'extra_fanart'>, string[]> = {
  poster: ['poster', 'folder', 'cover'],
  fanart: ['fanart', 'backdrop'],
  thumb: ['thumb'],
  preview: ['preview'],
  trailer: ['trailer'],
  sample: ['sample'],
};

export function matchSidecars(
  mainFile: ScanFileEntry,
  filesInDirectory: ScanFileEntry[],
  extraFanartFiles: ScanFileEntry[],
  mainFilmCount: number,
  imageExtensions: readonly string[] = DEFAULT_IMAGE_EXTENSIONS,
  videoExtensions: readonly string[] = DEFAULT_VIDEO_EXTENSIONS,
  logicalBaseName?: string,
): SidecarMatch {
  const baseNames = [...new Set([logicalBaseName, path.parse(mainFile.name).name].filter(Boolean).map((value) => value!.toLowerCase()))];
  const normalizedImages = new Set(imageExtensions.map((extension) => extension.toLowerCase().replace(/^\./, '')));
  const normalizedVideos = new Set(videoExtensions.map((extension) => extension.toLowerCase().replace(/^\./, '')));
  const sidecarFiles = filesInDirectory.filter((entry) => entry.absolutePath !== mainFile.absolutePath);
  const exactNfo = sidecarFiles.find((entry) => baseNames.some((base) => entry.name.toLowerCase() === `${base}.nfo`));
  const genericNfo = mainFilmCount === 1 ? sidecarFiles.find((entry) => isGenericNfo(entry.name)) ?? null : null;
  const nfo = exactNfo ?? genericNfo;
  const assets: Array<{ assetType: AssetType; entry: ScanFileEntry; sortOrder: number }> = [];
  let ambiguousAssets = 0;

  for (const [assetType, suffixes] of Object.entries(assetSuffixes) as Array<[AssetType, string[]]>) {
    if (assetType === 'extra_fanart') continue;
    const exactMatches = sidecarFiles.filter((entry) => {
      const extension = extensionOf(entry.name);
      if (!normalizedImages.has(extension) && !normalizedVideos.has(extension)) return false;
      const stem = path.parse(entry.name).name.toLowerCase();
      return baseNames.some((base) => suffixes.some((suffix) => stem === `${base}-${suffix}`))
        && isCompatibleAsset(assetType, extension, normalizedImages, normalizedVideos);
    });
    const matches = exactMatches.length > 0
      ? exactMatches
      : mainFilmCount === 1
        ? sidecarFiles.filter((entry) => {
            const extension = extensionOf(entry.name);
            const stem = path.parse(entry.name).name.toLowerCase();
            return genericNames[assetType as Exclude<AssetType, 'extra_fanart'>].includes(stem)
              && isCompatibleAsset(assetType, extension, normalizedImages, normalizedVideos);
          })
        : [];

    if (exactMatches.length === 0 && mainFilmCount > 1) {
      const hasGeneric = sidecarFiles.some((entry) => genericNames[assetType as Exclude<AssetType, 'extra_fanart'>].includes(path.parse(entry.name).name.toLowerCase()));
      if (hasGeneric) ambiguousAssets += 1;
    }
    matches.sort((left, right) => naturalCompare(left.name, right.name));
    matches.forEach((entry, index) => assets.push({ assetType, entry, sortOrder: index }));
  }

  if (mainFilmCount === 1) {
    const images = extraFanartFiles
      .filter((entry) => normalizedImages.has(extensionOf(entry.name)))
      .sort((left, right) => naturalCompare(left.name, right.name));
    images.forEach((entry, index) => assets.push({ assetType: 'extra_fanart', entry, sortOrder: index }));
  } else if (extraFanartFiles.length > 0) {
    ambiguousAssets += 1;
  }

  return { nfo, assets, ambiguousAssets };
}

export function enrichMatchedAssets(assets: SidecarMatch['assets'], stats: Map<string, fs.Stats>): MatchedAsset[] {
  return assets.map((asset) => {
    const stat = stats.get(asset.entry.absolutePath);
    return {
      assetType: asset.assetType,
      entry: asset.entry,
      sortOrder: asset.sortOrder,
      fileSize: stat?.size ?? null,
      fileModifiedAt: stat?.mtime.toISOString() ?? null,
      missing: !stat,
    };
  });
}

function isGenericNfo(name: string): boolean {
  const stem = path.parse(name).name.toLowerCase();
  return stem === 'movie' || stem === 'folder';
}

function isCompatibleAsset(
  assetType: AssetType,
  extension: string,
  images: Set<string>,
  videos: Set<string>,
): boolean {
  if (assetType === 'preview' || assetType === 'trailer' || assetType === 'sample') return videos.has(extension);
  return images.has(extension);
}

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}
