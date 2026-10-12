import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { FilmGifInput, FilmGifProgressDto, FilmGifResultDto } from '../../shared/contracts';
import { validateFilmGif } from '../../shared/filmMediaValidation';
import type { DatabaseManager } from '../database/DatabaseManager';
import type { FilmRepository } from '../database/repositories/FilmRepository';
import type { MediaCapabilityService } from '../media/MediaCapabilityService';
import { resolveExistingSafeMediaPath } from '../media/MediaPathResolver';

export type GifRunner = (executable: string, args: string[], signal: AbortSignal, progress: (seconds: number) => void) => Promise<void>;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export class FilmMediaService {
  private jobs = new Map<string, AbortController>();

  public constructor(
    private readonly database: DatabaseManager,
    private readonly films: FilmRepository,
    private readonly capabilities: MediaCapabilityService,
    private readonly runner: GifRunner = runGifFfmpeg,
  ) {}

  public cancel(requestId: string): void { this.jobs.get(requestId)?.abort(); }
  public cancelAll(): void { for (const job of this.jobs.values()) job.abort(); }

  public async setCover(filmId: string, assetId: string | null) {
    this.database.assertTransfersRecovered();
    const release = this.database.operations.acquire('media');
    try {
      if (assetId) {
        const detail = this.films.detail(filmId);
        if (!detail?.images.some((image) => image.id === assetId)) throw new Error('COVER_NOT_FOUND');
        const location = this.films.assetLocation(assetId);
        if (!location) throw new Error('COVER_NOT_FOUND');
        await resolveExistingSafeMediaPath(location.rootPath, location.relativePath);
      }
      return this.films.setCustomCover(filmId, assetId);
    } finally { release(); }
  }

  // Files selected outside a source are copied beside its primary movie so they travel with it.
  public async importCover(filmId: string, selectedPath: string) {
    this.database.assertTransfersRecovered();
    const release = this.database.operations.acquire('media');
    let output: string | null = null;
    let created = false;
    try {
      const detail = this.films.detail(filmId);
      const part = detail?.parts.find((item) => !item.missing);
      if (!part) throw new Error('PART_NOT_FOUND');
      const location = this.films.partLocation(part.id)!;
      const videoPath = await resolveExistingSafeMediaPath(location.rootPath, location.relativePath);
      const extension = path.extname(selectedPath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('INVALID_COVER_INPUT');
      const stat = await fs.promises.stat(selectedPath);
      if (!stat.isFile() || stat.size === 0 || stat.size > 50 * 1024 * 1024) throw new Error('INVALID_COVER_INPUT');
      output = path.join(path.dirname(videoPath), `${path.parse(videoPath).name}-cover-${randomUUID()}${extension}`);
      await fs.promises.copyFile(selectedPath, output, fs.constants.COPYFILE_EXCL);
      created = true;
      const outputStat = await fs.promises.stat(output);
      return this.database.transaction(() => {
        const id = this.films.registerManualImage(filmId, path.relative(fs.realpathSync(location.rootPath), output!), outputStat);
        return this.films.setCustomCover(filmId, id);
      });
    } catch (error) {
      if (created && output) await fs.promises.unlink(output).catch(() => undefined);
      throw error;
    } finally { release(); }
  }

  public async createGif(payload: FilmGifInput, onProgress: (progress: FilmGifProgressDto) => void): Promise<FilmGifResultDto> {
    const input = validateFilmGif(payload);
    this.database.assertTransfersRecovered();
    const executable = this.capabilities.toolPaths().ffmpeg;
    if (!executable) throw new Error('GIF_TOOLS_UNAVAILABLE');
    const release = this.database.operations.acquire('media');
    const controller = new AbortController();
    this.jobs.set(input.requestId, controller);
    let temporary: string | null = null;
    let output: string | null = null;
    let created = false;
    try {
      if (this.films.filmIdForPart(input.partId) !== input.filmId) throw new Error('PART_NOT_FOUND');
      const location = this.films.partLocation(input.partId)!;
      const videoPath = await resolveExistingSafeMediaPath(location.rootPath, location.relativePath);
      const probe = await this.capabilities.inspect(videoPath);
      if (probe?.durationSeconds && (input.startSeconds >= probe.durationSeconds || input.endSeconds > probe.durationSeconds + 0.1)) {
        throw new Error('INVALID_GIF_INPUT');
      }
      controller.signal.throwIfAborted();
      const filename = `${path.parse(videoPath).name}-gif-${randomUUID()}.gif`;
      output = path.join(path.dirname(videoPath), filename);
      temporary = `${output}.tmp`;
      const handle = await fs.promises.open(temporary, 'wx');
      await handle.close();
      onProgress({ requestId: input.requestId, percent: 0 });
      const duration = input.endSeconds - input.startSeconds;
      await this.runner(executable, buildGifArgs(videoPath, temporary, input), controller.signal, (seconds) => {
        onProgress({ requestId: input.requestId, percent: Math.min(99, Math.max(0, Math.round(seconds / duration * 100))) });
      });
      controller.signal.throwIfAborted();
      const stat = await fs.promises.stat(temporary);
      if (!stat.size) throw new Error('GIF_GENERATION_FAILED');
      await fs.promises.copyFile(temporary, output, fs.constants.COPYFILE_EXCL);
      created = true;
      controller.signal.throwIfAborted();
      const result = this.database.transaction(() => {
        const assetId = this.films.registerManualImage(input.filmId, path.relative(fs.realpathSync(location.rootPath), output!), stat);
        const detail = input.setAsCover ? this.films.setCustomCover(input.filmId, assetId) : this.films.detail(input.filmId)!;
        return { detail, assetId, filename };
      });
      onProgress({ requestId: input.requestId, percent: 100 });
      return result;
    } catch (error) {
      if (created && output) await fs.promises.unlink(output).catch(() => undefined);
      if (controller.signal.aborted) throw new Error('GIF_CANCELLED', { cause: error });
      throw error;
    } finally {
      if (temporary) await fs.promises.unlink(temporary).catch(() => undefined);
      this.jobs.delete(input.requestId);
      release();
    }
  }
}

export function buildGifArgs(videoPath: string, outputPath: string, input: FilmGifInput): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(input.startSeconds),
    '-t', String(input.endSeconds - input.startSeconds), '-i', videoPath,
    '-filter_complex', `[0:v:0]fps=${input.fps},scale=w=min(${input.width}\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,split[a][b];[a]palettegen[p];[b][p]paletteuse[v]`,
    '-map', '[v]', '-an', '-loop', '0', '-progress', 'pipe:1', '-nostats', '-f', 'gif', outputPath];
}

export function runGifFfmpeg(executable: string, args: string[], signal: AbortSignal, progress: (seconds: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('GIF_CANCELLED')); return; }
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let timedOut = false;
    const cancel = () => { child.kill(); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180_000);
    signal.addEventListener('abort', cancel, { once: true });
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (match) progress(Number(match[1]) / 1_000_000);
      }
    });
    child.stderr.resume();
    child.once('error', () => { cleanup(); reject(new Error('GIF_GENERATION_FAILED')); });
    child.once('close', (code) => {
      cleanup();
      if (signal.aborted) reject(new Error('GIF_CANCELLED'));
      else if (timedOut) reject(new Error('GIF_TIMEOUT'));
      else if (code === 0) resolve();
      else reject(new Error('GIF_GENERATION_FAILED'));
    });
  });
}
