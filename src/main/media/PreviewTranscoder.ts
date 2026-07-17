import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppLogger } from '../system/AppLogger';

const execFileAsync = promisify(execFile);
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface PreviewCodecs {
  video: string | null;
  audio: string | null;
}

interface ProbeOutput {
  streams?: Array<{ codec_type?: string; codec_name?: string }>;
}

export interface PreviewToolPaths {
  ffmpeg: string | null;
  ffprobe: string | null;
}

export class PreviewTranscoder {
  private readonly conversions = new Map<string, Promise<string | null>>();

  public constructor(
    private readonly logger: AppLogger,
    private readonly configuredFfprobePath: () => string,
    private readonly cacheDirectory: string,
  ) {}

  public shouldTranscode(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.mkv';
  }

  public async prepareCachedFile(filePath: string, signal: AbortSignal): Promise<string | null> {
    const tools = resolvePreviewToolPaths(this.configuredFfprobePath());
    if (!tools.ffmpeg) {
      this.logger.warn('MKV compatibility preview unavailable', {
        inputPath: filePath,
        reason: 'FFMPEG_NOT_FOUND',
      });
      return null;
    }

    const sourceStat = await fs.promises.stat(filePath);
    const key = previewCacheKey(filePath, sourceStat.size, sourceStat.mtimeMs);
    const cachedPath = path.join(this.cacheDirectory, `${key}.mp4`);
    if (await isUsableCacheFile(cachedPath)) {
      void touchCacheFile(cachedPath);
      return cachedPath;
    }

    await fs.promises.mkdir(this.cacheDirectory, { recursive: true });
    let conversion = this.conversions.get(key);
    if (!conversion) {
      conversion = this.convertToCache(filePath, cachedPath, tools)
        .finally(() => this.conversions.delete(key));
      this.conversions.set(key, conversion);
    }
    return waitForConversion(conversion, signal);
  }

  private async convertToCache(filePath: string, cachedPath: string, tools: PreviewToolPaths): Promise<string | null> {
    const partialPath = `${cachedPath}.${randomUUID()}.partial`;
    const codecs = tools.ffprobe ? await probeCodecs(tools.ffprobe, filePath) : null;
    const args = buildPreviewTranscodeArgs(filePath, codecs, partialPath);
    this.logger.info('MKV compatibility cache generation started', {
      inputPath: filePath,
      videoCodec: codecs?.video ?? 'unknown',
      audioCodec: codecs?.audio ?? 'unknown',
      videoMode: shouldCopyVideo(codecs) ? 'remux' : 'transcode',
      audioMode: shouldCopyAudio(codecs) ? 'remux' : 'transcode',
    });

    try {
      await runFfmpeg(tools.ffmpeg!, args);
      const stat = await fs.promises.stat(partialPath);
      if (!stat.isFile() || stat.size < 1024) throw new Error('FFMPEG_OUTPUT_EMPTY');
      if (await isUsableCacheFile(cachedPath)) await fs.promises.rm(partialPath, { force: true });
      else await fs.promises.rename(partialPath, cachedPath);
      this.logger.info('MKV compatibility cache ready', {
        inputPath: filePath,
        cachePath: cachedPath,
        cacheBytes: stat.size,
      });
      void prunePreviewCache(this.cacheDirectory, cachedPath, this.logger);
      return cachedPath;
    } catch (error) {
      await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
      this.logger.warn('MKV compatibility cache generation failed', {
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
  const executableSuffix = platform === 'win32' ? '.exe' : '';
  const configured = configuredFfprobePath.trim();
  const configuredProbe = configured && fs.existsSync(configured) ? path.resolve(configured) : null;
  const configuredFfmpeg = configuredProbe
    ? path.join(path.dirname(configuredProbe), `ffmpeg${executableSuffix}`)
    : null;
  return {
    ffmpeg: configuredFfmpeg && fs.existsSync(configuredFfmpeg)
      ? configuredFfmpeg
      : findOnPath(`ffmpeg${executableSuffix}`, environmentPath),
    ffprobe: configuredProbe ?? findOnPath(`ffprobe${executableSuffix}`, environmentPath),
  };
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

async function probeCodecs(ffprobePath: string, filePath: string): Promise<PreviewCodecs | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', filePath],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as ProbeOutput;
    return {
      video: parsed.streams?.find((stream) => stream.codec_type === 'video')?.codec_name?.toLowerCase() ?? null,
      audio: parsed.streams?.find((stream) => stream.codec_type === 'audio')?.codec_name?.toLowerCase() ?? null,
    };
  } catch {
    return null;
  }
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
      reject(new Error('FFMPEG_TRANSCODE_TIMEOUT'));
    }, 30 * 60 * 1000);
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

function shouldCopyVideo(codecs: PreviewCodecs | null): boolean {
  return codecs?.video === 'h264';
}

function shouldCopyAudio(codecs: PreviewCodecs | null): boolean {
  return codecs?.audio === 'aac';
}

function findOnPath(executable: string, environmentPath: string): string | null {
  for (const directory of environmentPath.split(path.delimiter).map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function isUsableCacheFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size >= 1024;
  } catch {
    return false;
  }
}

function waitForConversion(conversion: Promise<string | null>, signal: AbortSignal): Promise<string | null> {
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
    void conversion.then(finish, () => finish(null));
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
    logger.warn('MKV compatibility cache cleanup failed', {
      cachePath: cacheDirectory,
      error: error instanceof Error ? error.message : 'CACHE_CLEANUP_FAILED',
    });
  }
}
