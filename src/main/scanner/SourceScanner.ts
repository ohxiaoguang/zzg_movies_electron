import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaSourceDto, SettingsDto } from '../../shared/contracts';
import { DEFAULT_IGNORED_DIRECTORIES, DEFAULT_IMAGE_EXTENSIONS, DEFAULT_VIDEO_EXTENSIONS } from '../../shared/enums';
import { mapNfoMetadata } from '../metadata/NfoMapper';
import { parseNfo } from '../metadata/NfoParser';
import { resolveSafeMediaPath } from '../media/MediaPathResolver';
import { ScanCancellation } from './ScanCancellation';
import type { FilmCandidate, FilmFileCandidate, ScanFileEntry } from './ScanCandidate';
import { logicalFilmKey, parseFilmPartName } from './PartNaming';
import { enrichMatchedAssets, matchSidecars } from './SidecarMatcher';

export interface SourceScanStats {
  discovered: number;
  processed: number;
  nfoErrors: number;
  ambiguousAssets: number;
  otherErrors: number;
}

export interface SourceScanResult {
  complete: boolean;
  cancelled: boolean;
  offline: boolean;
  candidates: FilmCandidate[];
  stats: SourceScanStats;
}

export interface SourceScannerProgress {
  currentDirectory: string;
  currentFilm: string | null;
  discovered: number;
  processed: number;
}

interface ScannerOptions {
  settings: SettingsDto;
  cancellation: ScanCancellation;
  relativeDirectory?: string;
  onProgress?: (progress: SourceScannerProgress) => void;
}

export class SourceScanner {
  public constructor(private readonly source: MediaSourceDto, private readonly options: ScannerOptions) {}

  public async scan(): Promise<SourceScanResult> {
    const stats: SourceScanStats = {
      discovered: 0,
      processed: 0,
      nfoErrors: 0,
      ambiguousAssets: 0,
      otherErrors: 0,
    };
    const rootPath = path.resolve(this.source.rootPath);
    const scanRootPath = this.options.relativeDirectory
      ? resolveSafeMediaPath(rootPath, this.options.relativeDirectory)
      : rootPath;
    let rootStat: fs.Stats;
    try {
      rootStat = await fs.promises.stat(scanRootPath);
      if (!rootStat.isDirectory()) throw new Error('SOURCE_NOT_DIRECTORY');
    } catch {
      return { complete: false, cancelled: false, offline: true, candidates: [], stats };
    }

    const directories = new Map<string, ScanFileEntry[]>();
    const extraFanartByDirectory = new Map<string, ScanFileEntry[]>();
    let complete = true;

    const visit = async (directory: string): Promise<void> => {
      if (this.options.cancellation.cancelled) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        complete = false;
        stats.otherErrors += 1;
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
      const localFiles: ScanFileEntry[] = [];
      directories.set(directory, localFiles);
      for (const entry of entries) {
        if (this.options.cancellation.cancelled) return;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!this.source.recursive || this.shouldIgnoreDirectory(entry.name)) continue;
          await visit(absolutePath);
          continue;
        }
        if (!entry.isFile() || shouldIgnoreFile(entry.name)) continue;
        const scanEntry: ScanFileEntry = {
          absolutePath,
          relativePath: path.relative(rootPath, absolutePath),
          name: entry.name,
        };
        localFiles.push(scanEntry);
        const extension = extensionOf(entry.name);
        if (this.videoExtensions.has(extension)) stats.discovered += 1;
        if (this.imageExtensions.has(extension) && path.basename(directory).toLowerCase() === 'extrafanart') {
          const ownerDirectory = path.dirname(directory);
          const collection = extraFanartByDirectory.get(ownerDirectory) ?? [];
          collection.push(scanEntry);
          extraFanartByDirectory.set(ownerDirectory, collection);
        }
      }
      this.options.onProgress?.({
        currentDirectory: path.relative(rootPath, directory) || '.',
        currentFilm: null,
        discovered: stats.discovered,
        processed: stats.processed,
      });
    };

    await visit(scanRootPath);
    if (this.options.cancellation.cancelled) {
      return { complete: false, cancelled: true, offline: false, candidates: [], stats };
    }

    const candidates: FilmCandidate[] = [];
    for (const [directory, files] of directories) {
      if (this.options.cancellation.cancelled) {
        return { complete: false, cancelled: true, offline: false, candidates: [], stats };
      }
      const videoFiles = files.filter((file) => this.videoExtensions.has(extensionOf(file.name)));
      const groups = groupVideoFiles(videoFiles.filter((file) => !isPreviewSidecar(file, videoFiles)));
      for (const group of groups) {
        if (this.options.cancellation.cancelled) {
          return { complete: false, cancelled: true, offline: false, candidates: [], stats };
        }
        this.options.onProgress?.({
          currentDirectory: path.relative(rootPath, directory) || '.',
          currentFilm: group.files[0]?.name ?? null,
          discovered: stats.discovered,
          processed: stats.processed,
        });
        try {
          const match = matchSidecars(
            group.files[0]!,
            files,
            extraFanartByDirectory.get(directory) ?? [],
            groups.length,
            [...this.imageExtensions],
            [...this.videoExtensions],
            group.baseName,
          );
          const primary = group.files[0]!;
          const fileEntries: FilmFileCandidate[] = [];
          for (const file of group.files) {
            const fileStat = await fs.promises.stat(file.absolutePath);
            fileEntries.push({
              absolutePath: file.absolutePath,
              relativePath: file.relativePath,
              filename: file.name,
              partType: parseFilmPartName(file.name)?.partType ?? 'single',
              partNumber: parseFilmPartName(file.name)?.partNumber ?? 1,
              isPrimary: file.absolutePath === primary.absolutePath,
              fileSize: fileStat.size,
              fileModifiedAt: fileStat.mtime.toISOString(),
              fingerprint: null,
            });
          }
          const primaryFile = fileEntries.find((file) => file.isPrimary)!;
          const nfoStat = match.nfo ? await statOrNull(match.nfo.absolutePath) : null;
          let nfoMetadata = null;
          let nfoStatus: FilmCandidate['nfoStatus'] = match.nfo ? 'ok' : 'missing';
          let nfoError: string | null = null;
          let nfoHash: string | null = null;
          if (match.nfo && nfoStat) {
            try {
              const nfoContent = await fs.promises.readFile(match.nfo.absolutePath, 'utf8');
              nfoMetadata = parseNfo(nfoContent);
              nfoHash = crypto.createHash('sha256').update(nfoContent).digest('hex');
            } catch (error) {
              nfoStatus = 'error';
              nfoError = error instanceof Error ? error.message : 'NFO_PARSE_FAILED';
              stats.nfoErrors += 1;
            }
          } else if (match.nfo) {
            nfoStatus = 'error';
            nfoError = 'NFO_UNREADABLE';
            stats.nfoErrors += 1;
          }
          const fallbackTitle = group.baseName;
          const mapped = mapNfoMetadata(nfoMetadata, fallbackTitle);
          const assetStats = new Map<string, fs.Stats>();
          await Promise.all(
            match.assets.map(async (asset) => {
              const assetStat = await statOrNull(asset.entry.absolutePath);
              if (assetStat) assetStats.set(asset.entry.absolutePath, assetStat);
            }),
          );
          const assets = enrichMatchedAssets(match.assets, assetStats);
          candidates.push({
            ...mapped,
            sourceId: this.source.id,
            sourceRootPath: rootPath,
            absolutePath: primary.absolutePath,
            relativePath: primary.relativePath,
            filename: primary.name,
            fileSize: primaryFile.fileSize,
            fileModifiedAt: primaryFile.fileModifiedAt,
            fingerprint: primaryFile.fingerprint,
            nfoRelativePath: match.nfo?.relativePath ?? null,
            nfoModifiedAt: nfoStat?.mtime.toISOString() ?? null,
            nfoHash,
            nfoStatus,
            nfoError,
            assets,
            ambiguousAssets: match.ambiguousAssets,
            logicalKey: group.key,
            partBaseName: group.baseName,
            files: fileEntries,
          });
          stats.ambiguousAssets += match.ambiguousAssets;
        } catch {
          complete = false;
          stats.otherErrors += 1;
        }
        stats.processed += 1;
        this.options.onProgress?.({
          currentDirectory: path.relative(rootPath, directory) || '.',
          currentFilm: group.files[0]?.name ?? null,
          discovered: stats.discovered,
          processed: stats.processed,
        });
      }
    }

    return {
      complete,
      cancelled: false,
      offline: false,
      candidates,
      stats,
    };
  }

  private get videoExtensions(): Set<string> {
    return new Set((this.options.settings.videoExtensions.length ? this.options.settings.videoExtensions : DEFAULT_VIDEO_EXTENSIONS).map(normalizeExtension));
  }

  private get imageExtensions(): Set<string> {
    return new Set((this.options.settings.imageExtensions.length ? this.options.settings.imageExtensions : DEFAULT_IMAGE_EXTENSIONS).map(normalizeExtension));
  }

  private shouldIgnoreDirectory(name: string): boolean {
    const ignored = this.options.settings.ignoredDirectories.length
      ? this.options.settings.ignoredDirectories
      : DEFAULT_IGNORED_DIRECTORIES;
    return ignored.some((item) => item.toLowerCase() === name.toLowerCase());
  }
}

function normalizeExtension(extension: string): string {
  return extension.toLowerCase().replace(/^\./, '');
}

function extensionOf(name: string): string {
  return normalizeExtension(path.extname(name));
}

function shouldIgnoreFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.llc') || lower.endsWith('-proj.llc');
}

function isPreviewSidecar(file: ScanFileEntry, videoFiles: ScanFileEntry[]): boolean {
  const stem = path.parse(file.name).name.toLowerCase();
  const generic = new Set(['preview', 'trailer', 'sample']);
  const hasSibling = videoFiles.some((candidate) => candidate.absolutePath !== file.absolutePath);
  if (!hasSibling) return false;
  if (generic.has(stem)) return true;
  return /-(preview|trailer|sample)$/i.test(stem);
}

export interface VideoFileGroup {
  key: string;
  baseName: string;
  files: ScanFileEntry[];
}

export function groupVideoFiles(videoFiles: ScanFileEntry[]): VideoFileGroup[] {
  const groups = new Map<string, VideoFileGroup>();
  for (const file of videoFiles) {
    const parsed = parseFilmPartName(file.name);
    const relativeDirectory = path.dirname(file.relativePath);
    const key = logicalFilmKey(relativeDirectory, file.name);
    const group = groups.get(key) ?? {
      key,
      baseName: parsed?.baseName ?? path.parse(file.name).name,
      files: [],
    };
    group.files.push(file);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    files: [...group.files].sort((left, right) => {
      const leftPart = parseFilmPartName(left.name);
      const rightPart = parseFilmPartName(right.name);
      return (leftPart?.partNumber ?? 1) - (rightPart?.partNumber ?? 1)
        || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    }),
  }));
}

async function statOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}
