import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AppLogger } from '../system/AppLogger';
import {
  MediaCapabilityService,
  resolveMediaToolPaths,
  type MediaProbeResult,
  type MediaToolPaths,
} from './MediaCapabilityService';

const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const COMPATIBILITY_PREVIEW_EXTENSIONS = new Set(['.mkv', '.mpg', '.mpeg', '.avi', '.ts', '.flv', '.wmv']);

export interface PreviewCodecs {
  video: string | null;
  audio: string | null;
}

export type PreviewToolPaths = MediaToolPaths;

type PreviewFfmpegRunner = (ffmpegPath: string, args: string[], signal: AbortSignal) => Promise<void>;

interface PreviewConversion {
  controller: AbortController;
  promise: Promise<string | null>;
  consumers: number;
  settled: boolean;
  sourceKey: string;
}

export class PreviewTranscoder {
  private readonly conversions = new Map<string, PreviewConversion>();
  private readonly sourceCancellationVersions = new Map<string, number>();
  private readonly capabilities: MediaCapabilityService;

  public constructor(
    private readonly logger: AppLogger,
    configuredFfprobePath: () => string,
    private readonly cacheDirectory: string,
    capabilities?: MediaCapabilityService,
    private readonly ffmpegRunner: PreviewFfmpegRunner = runFfmpeg,
  ) {
    this.capabilities = capabilities ?? new MediaCapabilityService(configuredFfprobePath);
  }

  public shouldTranscode(filePath: string): boolean {
    return COMPATIBILITY_PREVIEW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  public async preparePlayableFile(filePath: string, signal: AbortSignal): Promise<string> {
    const prepared = await this.prepareCachedFile(filePath, signal);
    return prepared ?? filePath;
  }

  public async prepareCachedFile(filePath: string, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return null;
    const sourceKey = normalizedSourceKey(filePath);
    const cancellationVersion = this.sourceCancellationVersions.get(sourceKey) ?? 0;
    const { probe, plan } = await this.capabilities.playbackPlan(filePath);
    if (signal.aborted || this.wasCancelled(sourceKey, cancellationVersion)) return null;
    if (plan.mode === 'direct') return filePath;
    const tools = this.capabilities.toolPaths();
    if (!tools.ffmpeg) {
      this.logger.warn('Compatibility preview unavailable', {
        inputPath: filePath,
        reason: 'FFMPEG_NOT_FOUND',
      });
      return null;
    }

    const sourceStat = await fs.promises.stat(filePath);
    if (signal.aborted || this.wasCancelled(sourceKey, cancellationVersion)) return null;
    const key = previewCacheKey(filePath, sourceStat.size, sourceStat.mtimeMs);
    const cachedPath = path.join(this.cacheDirectory, `${key}.mp4`);
    const cacheUsable = await isUsableCacheFile(cachedPath);
    if (signal.aborted || this.wasCancelled(sourceKey, cancellationVersion)) return null;
    if (cacheUsable) {
      void touchCacheFile(cachedPath);
      return cachedPath;
    }

    await fs.promises.mkdir(this.cacheDirectory, { recursive: true });
    if (signal.aborted || this.wasCancelled(sourceKey, cancellationVersion)) return null;
    let conversion = this.conversions.get(key);
    if (!conversion) {
      const controller = new AbortController();
      conversion = {
        controller,
        promise: Promise.resolve(null),
        consumers: 0,
        settled: false,
        sourceKey,
      };
      const current = conversion;
      current.promise = this.convertToCache(filePath, cachedPath, tools, probe, controller.signal)
        .finally(() => {
          current.settled = true;
          if (this.conversions.get(key) === current) this.conversions.delete(key);
        });
      this.conversions.set(key, current);
    }
    const current = conversion;
    return waitForConversion(current, signal, () => {
      if (this.conversions.get(key) === current) this.conversions.delete(key);
      current.controller.abort();
    });
  }

  public cancel(filePath: string): boolean {
    const sourceKey = normalizedSourceKey(filePath);
    this.sourceCancellationVersions.set(
      sourceKey,
      (this.sourceCancellationVersions.get(sourceKey) ?? 0) + 1,
    );
    let cancelled = false;
    for (const [key, conversion] of this.conversions) {
      if (conversion.sourceKey !== sourceKey || conversion.settled) continue;
      if (this.conversions.get(key) === conversion) this.conversions.delete(key);
      conversion.controller.abort();
      cancelled = true;
    }
    return cancelled;
  }

  private wasCancelled(sourceKey: string, version: number): boolean {
    return (this.sourceCancellationVersions.get(sourceKey) ?? 0) !== version;
  }

  private async convertToCache(
    filePath: string,
    cachedPath: string,
    tools: PreviewToolPaths,
    probe: MediaProbeResult | null,
    signal: AbortSignal,
  ): Promise<string | null> {
    const partialPath = `${cachedPath}.${randomUUID()}.partial`;
    const codecs = probe ? { video: probe.video?.codec ?? null, audio: probe.audio?.codec ?? null } : null;
    const args = buildPreviewTranscodeArgs(filePath, codecs, partialPath);
    this.logger.info('Compatibility preview cache generation started', {
      inputPath: filePath,
      videoCodec: codecs?.video ?? 'unknown',
      audioCodec: codecs?.audio ?? 'unknown',
      videoMode: shouldCopyVideo(codecs) ? 'remux' : 'transcode',
      audioMode: shouldCopyAudio(codecs) ? 'remux' : 'transcode',
    });

    try {
      await this.ffmpegRunner(tools.ffmpeg!, args, signal);
      const stat = await fs.promises.stat(partialPath);
      if (!stat.isFile() || stat.size < 1024) throw new Error('FFMPEG_OUTPUT_EMPTY');
      if (await isUsableCacheFile(cachedPath)) await fs.promises.rm(partialPath, { force: true });
      else await fs.promises.rename(partialPath, cachedPath);
      this.logger.info('Compatibility preview cache ready', {
        inputPath: filePath,
        cachePath: cachedPath,
        cacheBytes: stat.size,
      });
      void prunePreviewCache(this.cacheDirectory, cachedPath, this.logger);
      return cachedPath;
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
      if (signal.aborted) {
        this.logger.info('Compatibility preview cache generation cancelled', { inputPath: filePath });
        return null;
      }
      this.logger.warn('Compatibility preview cache generation failed', {
        inputPath: filePath,
        error: error instanceof Error ? error.message : 'FFMPEG_TRANSCODE_FAILED',
      });
      return null;
    }
  }
}

export function resolvePreviewToolPaths(
  configuredFfprobePath: string,
  environmentPath = process.env.PATH ?? '',
  platform = process.platform,
): PreviewToolPaths {
  return resolveMediaToolPaths(configuredFfprobePath, environmentPath, platform);
}

export function previewCacheKey(filePath: string, fileSize: number, modifiedAtMs: number): string {
  return createHash('sha256')
    .update(path.resolve(filePath).toLowerCase())
    .update('\0')
    .update(String(fileSize))
    .update('\0')
    .update(String(Math.trunc(modifiedAtMs)))
    .digest('hex');
}

export function buildPreviewTranscodeArgs(filePath: string, codecs: PreviewCodecs | null, outputPath: string): string[] {
  const videoArgs = shouldCopyVideo(codecs)
    ? ['-c:v', 'copy']
    : [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '27',
        '-pix_fmt', 'yuv420p',
        '-vf', "scale=w='min(1280,iw)':h=-2",
      ];
  const audioArgs = shouldCopyAudio(codecs)
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '128k'];
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-fflags', '+genpts',
    '-i', filePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    '-avoid_negative_ts', 'make_zero',
    ...videoArgs,
    ...audioArgs,
    '-movflags', '+faststart',
    '-f', 'mp4',
    outputPath,
  ];
}

function runFfmpeg(ffmpegPath: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('FFMPEG_TRANSCODE_ABORTED'));
      return;
    }
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let aborted = false;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('FFMPEG_TRANSCODE_TIMEOUT'));
    }, 30 * 60 * 1000);
    const abort = (): void => {
      aborted = true;
      child.kill();
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 3000) stderr += chunk.toString('utf8').slice(0, 3000 - stderr.length);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (aborted) reject(new Error('FFMPEG_TRANSCODE_ABORTED'));
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `FFMPEG_EXIT_${code ?? 'UNKNOWN'}`));
    });
    if (signal.aborted) abort();
  });
}

function normalizedSourceKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

function shouldCopyVideo(codecs: PreviewCodecs | null): boolean {
  return codecs?.video === 'h264';
}

function shouldCopyAudio(codecs: PreviewCodecs | null): boolean {
  return codecs?.audio === 'aac';
}

async function isUsableCacheFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size >= 1024;
  } catch {
    return false;
  }
}

function waitForConversion(
  conversion: PreviewConversion,
  signal: AbortSignal,
  onUnused: () => void,
): Promise<string | null> {
  if (signal.aborted) {
    if (!conversion.consumers && !conversion.settled) onUnused();
    return Promise.resolve(null);
  }
  conversion.consumers += 1;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      conversion.consumers -= 1;
      resolve(value);
      if (!conversion.consumers && !conversion.settled) onUnused();
    };
    const abort = (): void => finish(null);
    signal.addEventListener('abort', abort, { once: true });
    void conversion.promise.then(finish, () => finish(null));
  });
}

async function touchCacheFile(filePath: string): Promise<void> {
  const now = new Date();
  await fs.promises.utimes(filePath, now, now).catch(() => undefined);
}

async function prunePreviewCache(cacheDirectory: string, keepPath: string, logger: AppLogger): Promise<void> {
  try {
    const names = await fs.promises.readdir(cacheDirectory);
    const entries = (await Promise.all(names
      .filter((name) => name.endsWith('.mp4'))
      .map(async (name) => {
        const filePath = path.join(cacheDirectory, name);
        const stat = await fs.promises.stat(filePath);
        return { filePath, size: stat.size, modifiedAt: stat.mtimeMs };
      })))
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const cutoff = Date.now() - MAX_CACHE_AGE_MS;
    for (const entry of entries.reverse()) {
      if (entry.filePath === keepPath) continue;
      if (entry.modifiedAt >= cutoff && total <= MAX_CACHE_BYTES) continue;
      await fs.promises.rm(entry.filePath, { force: true });
      total -= entry.size;
    }
  } catch (error) {
    logger.warn('Compatibility preview cache cleanup failed', {
      cachePath: cacheDirectory,
      error: error instanceof Error ? error.message : 'CACHE_CLEANUP_FAILED',
    });
  }
}
