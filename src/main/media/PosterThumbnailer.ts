import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AppLogger } from '../system/AppLogger';
import type { MediaCapabilityService } from './MediaCapabilityService';

const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT_GENERATIONS = 2;
const POSTER_CACHE_VERSION = 'screen-grabber-v2-10-percent';
const UNKNOWN_DURATION_OFFSET_SECONDS = 10;

export class PosterThumbnailer {
  private readonly generations = new Map<string, Promise<string | null>>();
  private readonly queue: Array<() => void> = [];
  private activeGenerations = 0;

  public constructor(
    private readonly logger: AppLogger,
    private readonly capabilities: MediaCapabilityService,
    private readonly cacheDirectory: string,
  ) {}

  public async prepare(videoPath: string, signal: AbortSignal): Promise<string | null> {
    const ffmpegPath = this.capabilities.toolPaths().ffmpeg;
    if (!ffmpegPath) {
      this.logger.warn('Automatic poster unavailable', {
        inputPath: videoPath,
        reason: 'FFMPEG_NOT_FOUND',
      });
      return null;
    }

    const sourceStat = await fs.promises.stat(videoPath);
    const key = posterThumbnailCacheKey(videoPath, sourceStat.size, sourceStat.mtimeMs);
    const cachedPath = path.join(this.cacheDirectory, `${key}.jpg`);
    if (await isUsableThumbnail(cachedPath)) {
      void touchCacheFile(cachedPath);
      return cachedPath;
    }

    await fs.promises.mkdir(this.cacheDirectory, { recursive: true });
    let generation = this.generations.get(key);
    if (!generation) {
      generation = this.schedule(async () => {
        const probe = await this.capabilities.inspect(videoPath);
        const offsetSeconds = selectPosterTimestamp(probe?.durationSeconds ?? null);
        return this.generate(videoPath, cachedPath, ffmpegPath, offsetSeconds);
      })
        .finally(() => this.generations.delete(key));
      this.generations.set(key, generation);
    }
    return waitForGeneration(generation, signal);
  }

  private schedule(task: () => Promise<string | null>): Promise<string | null> {
    return new Promise((resolve) => {
      const run = (): void => {
        this.activeGenerations += 1;
        void task().then(resolve, () => resolve(null)).finally(() => {
          this.activeGenerations -= 1;
          this.queue.shift()?.();
        });
      };
      if (this.activeGenerations < MAX_CONCURRENT_GENERATIONS) run();
      else this.queue.push(run);
    });
  }

  private async generate(
    videoPath: string,
    cachedPath: string,
    ffmpegPath: string,
    offsetSeconds: number,
  ): Promise<string | null> {
    const partialPath = `${cachedPath}.${randomUUID()}.jpg`;
    this.logger.info('Automatic poster generation started', { inputPath: videoPath, offsetSeconds });
    try {
      await runFfmpeg(ffmpegPath, buildPosterThumbnailArgs(videoPath, partialPath, offsetSeconds));
      const stat = await fs.promises.stat(partialPath);
      if (!stat.isFile() || stat.size < 128) throw new Error('FFMPEG_OUTPUT_EMPTY');
      if (await isUsableThumbnail(cachedPath)) await fs.promises.rm(partialPath, { force: true });
      else await fs.promises.rename(partialPath, cachedPath);
      this.logger.info('Automatic poster cache ready', {
        inputPath: videoPath,
        cachePath: cachedPath,
        cacheBytes: stat.size,
      });
      void prunePosterCache(this.cacheDirectory, cachedPath, this.logger);
      return cachedPath;
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
      this.logger.warn('Automatic poster generation failed', {
        inputPath: videoPath,
        error: error instanceof Error ? error.message : 'FFMPEG_THUMBNAIL_FAILED',
      });
      return null;
    }
  }
}

export function posterThumbnailCacheKey(videoPath: string, fileSize: number, modifiedAtMs: number): string {
  return createHash('sha256')
    .update(POSTER_CACHE_VERSION)
    .update('\0')
    .update(path.resolve(videoPath).toLowerCase())
    .update('\0')
    .update(String(fileSize))
    .update('\0')
    .update(String(Math.trunc(modifiedAtMs)))
    .digest('hex');
}

export function selectPosterTimestamp(durationSeconds: number | null): number {
  return durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds / 10
    : UNKNOWN_DURATION_OFFSET_SECONDS;
}

export function buildPosterThumbnailArgs(videoPath: string, outputPath: string, offsetSeconds: number): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', formatTimestamp(offsetSeconds),
    '-i', videoPath,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', "scale=w='min(720,iw)':h=-2",
    '-q:v', '3',
    '-an',
    '-sn',
    '-dn',
    '-map_metadata', '-1',
    outputPath,
  ];
}

function formatTimestamp(seconds: number): string {
  return Math.max(0, seconds).toFixed(3);
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('FFMPEG_THUMBNAIL_TIMEOUT'));
    }, 60_000);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 3000) stderr += chunk.toString('utf8').slice(0, 3000 - stderr.length);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `FFMPEG_EXIT_${code ?? 'UNKNOWN'}`));
    });
  });
}

async function isUsableThumbnail(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size >= 128;
  } catch {
    return false;
  }
}

function waitForGeneration(generation: Promise<string | null>, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = (): void => finish(null);
    signal.addEventListener('abort', abort, { once: true });
    void generation.then(finish, () => finish(null));
  });
}

async function touchCacheFile(filePath: string): Promise<void> {
  const now = new Date();
  await fs.promises.utimes(filePath, now, now).catch(() => undefined);
}

async function prunePosterCache(cacheDirectory: string, keepPath: string, logger: AppLogger): Promise<void> {
  try {
    const names = await fs.promises.readdir(cacheDirectory);
    const entries = (await Promise.all(names
      .filter((name) => name.endsWith('.jpg'))
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
    logger.warn('Automatic poster cache cleanup failed', {
      cachePath: cacheDirectory,
      error: error instanceof Error ? error.message : 'CACHE_CLEANUP_FAILED',
    });
  }
}
