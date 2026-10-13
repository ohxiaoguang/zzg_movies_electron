import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MediaSourceDto, SettingsDto, ScanIssueDto } from '../../shared/contracts';
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
  issues?: ScanIssueDto[];
}

export interface SourceScannerProgress {
  phase: 'discovering' | 'parsing';
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

const fileCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class SourceScanner {
  private videoExtensionCache: Set<string> | null = null;
  private imageExtensionCache: Set<string> | null = null;
  public constructor(private readonly source: MediaSourceDto, private readonly options: ScannerOptions) {}

  public async scan(): Promise<SourceScanResult> {
    const stats: SourceScanStats = {
      discovered: 0,
      processed: 0,
      nfoErrors: 0,
      ambiguousAssets: 0,
      otherErrors: 0,
    };
    const issues: ScanIssueDto[] = [];
    const issue = (type: ScanIssueDto['type'], relativePath: string, filmTitle: string, message: string, relatedPaths: string[] = []) => {
      issues.push({ id: crypto.randomUUID(), type, sourceId: this.source.id, sourceName: this.source.name, relativePath, filmTitle, message: message.slice(0, 2000), relatedPaths });
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
      issue('source_offline', this.options.relativeDirectory ?? '.', '', '来源或扫描目录不可访问，已保留原有记录');
      return { complete: false, cancelled: false, offline: true, candidates: [], stats, issues };
    }

    const directories = new Map<string, ScanFileEntry[]>();
    const extraFanartByDirectory = new Map<string, ScanFileEntry[]>();
    const commentsByDirectory = new Map<string, ScanFileEntry[]>();
    let complete = true;

    const visit = async (directory: string): Promise<void> => {
      if (this.options.cancellation.cancelled) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch (error) {
        issue('filesystem', path.relative(rootPath, directory) || '.', '', `目录读取失败：${error instanceof Error ? error.message : '未知错误'}`);
        complete = false;
        stats.otherErrors += 1;
        return;
      }
      entries.sort((left, right) => fileCollator.compare(left.name, right.name));
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
        if (this.imageExtensions.has(extension) && path.basename(directory).toLowerCase() === 'comment') {
          const ownerDirectory = path.dirname(directory);
          const collection = commentsByDirectory.get(ownerDirectory) ?? [];
          collection.push(scanEntry);
          commentsByDirectory.set(ownerDirectory, collection);
        }
      }
      this.options.onProgress?.({
        currentDirectory: path.relative(rootPath, directory) || '.',
        currentFilm: null,
        phase: 'discovering',
        discovered: stats.discovered,
        processed: stats.processed,
      });
    };

    await visit(scanRootPath);
    if (this.options.cancellation.cancelled) {
      return { complete: false, cancelled: true, offline: false, candidates: [], stats, issues };
    }

    // Both counters use original video files, excluding preview sidecars.
    const directoryGroups = new Map([...directories].map(([directory, files]) => {
      const videos = files.filter((file) => this.videoExtensions.has(extensionOf(file.name)));
      return [directory, groupVideoFiles(videos.filter((file) => !isPreviewSidecar(file, videos)))];
    }));
    stats.discovered = [...directoryGroups.values()].reduce((total, groups) => (
      total + groups.reduce((count, group) => count + group.files.length, 0)
    ), 0);
    const candidates: FilmCandidate[] = [];
    for (const [directory, files] of directories) {
      if (this.options.cancellation.cancelled) {
        return { complete: false, cancelled: true, offline: false, candidates: [], stats, issues };
      }
      const groups = directoryGroups.get(directory)!;
      for (const group of groups) {
        if (this.options.cancellation.cancelled) {
          return { complete: false, cancelled: true, offline: false, candidates: [], stats, issues };
        }
        this.options.onProgress?.({
          currentDirectory: path.relative(rootPath, directory) || '.',
          currentFilm: group.files[0]?.name ?? null,
          phase: 'parsing',
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
            commentsByDirectory.get(directory) ?? [],
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
              issue('nfo', match.nfo.relativePath, group.baseName, `NFO 解析失败：${nfoError}`, [primary.relativePath]);
            }
          } else if (match.nfo) {
            nfoStatus = 'error';
            nfoError = 'NFO_UNREADABLE';
            stats.nfoErrors += 1;
            issue('nfo', match.nfo.relativePath, group.baseName, 'NFO 无法读取，请检查文件权限或磁盘连接', [primary.relativePath]);
          }
          const fallbackTitle = group.baseName;
          const mapped = mapNfoMetadata(nfoMetadata, fallbackTitle);
          const assetStats = new Map<string, fs.Stats>();
          for (let offset = 0; offset < match.assets.length; offset += 16) await Promise.all(
            match.assets.slice(offset, offset + 16).map(async (asset) => {
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
          for (const ambiguity of match.ambiguities) issue('asset', primary.relativePath, mapped.title, `同目录有多部影片，通用 ${ambiguity.assetType} 资源无法确定归属；可改为与影片同名的资源文件`, ambiguity.paths);
        } catch (error) {
          issue('filesystem', group.files[0]!.relativePath, group.baseName, `影片处理失败：${error instanceof Error ? error.message : '未知错误'}`);
          complete = false;
          stats.otherErrors += 1;
        }
        stats.processed += group.files.length;
        this.options.onProgress?.({
          currentDirectory: path.relative(rootPath, directory) || '.',
          currentFilm: group.files[0]?.name ?? null,
          phase: 'parsing',
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
      issues,
    };
  }

  private get videoExtensions(): Set<string> {
    return this.videoExtensionCache ??= new Set((this.options.settings.videoExtensions.length ? this.options.settings.videoExtensions : DEFAULT_VIDEO_EXTENSIONS).map(normalizeExtension));
  }

  private get imageExtensions(): Set<string> {
    return this.imageExtensionCache ??= new Set((this.options.settings.imageExtensions.length ? this.options.settings.imageExtensions : DEFAULT_IMAGE_EXTENSIONS).map(normalizeExtension));
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
        || fileCollator.compare(left.name, right.name);
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
