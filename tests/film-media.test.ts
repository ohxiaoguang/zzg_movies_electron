import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { FilmFileOwnershipRepairService } from '../src/main/database/FilmFileOwnershipRepairService';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import { ScanCoordinator } from '../src/main/scanner/ScanCoordinator';
import { AppLogger } from '../src/main/system/AppLogger';
import { MediaCapabilityService, resolveMediaToolPaths } from '../src/main/media/MediaCapabilityService';
import { DEFAULT_COVER_ASSET_TYPES } from '../src/shared/enums';
import { resolveMimeType } from '../src/main/media/MimeTypeResolver';
import { FilmMediaService, runGifFfmpeg, type GifRunner } from '../src/main/services/FilmMediaService';
import { validateFilmGif, validateFilmCover } from '../src/shared/filmMediaValidation';
import type { FilmGifInput } from '../src/shared/contracts';

const roots: string[] = [];
const databases: DatabaseManager[] = [];
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function waitForScan(scan: ScanCoordinator): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const status = scan.status();
    if (status?.status === 'completed') return;
    if (status && status.status !== 'running') throw new Error(`scan failed: ${status.message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('scan timeout');
}
async function fixture(runner?: GifRunner, realTools = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-media-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source');
  fs.mkdirSync(path.join(sourceRoot, 'films'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'films', 'Movie.mp4'), 'original video');
  fs.writeFileSync(path.join(sourceRoot, 'films', 'Movie-poster.jpg'), 'original poster');
  const database = new DatabaseManager(path.join(root, 'library.db'));
  databases.push(database);
  const films = new FilmRepository(database.db);
  const sources = new SourceRepository(database.db);
  const source = sources.create({ name: 'Test', rootPath: sourceRoot });
  const scan = new ScanCoordinator(database, sources, films, new SettingsRepository(database.db), new AppLogger(path.join(root, 'logs')));
  scan.start({ sourceIds: [source.id] });
  await waitForScan(scan);
  const detail = films.page({ page: 1, pageSize: 20 }).items[0]!;
  const partId = films.detail(detail.id)!.parts[0]!.id;
  const capabilities = new MediaCapabilityService(() => '');
  if (!realTools) {
    vi.spyOn(capabilities, 'toolPaths').mockReturnValue({ ffmpeg: 'fake-ffmpeg', ffprobe: null });
    vi.spyOn(capabilities, 'inspect').mockResolvedValue(null);
  }
  const fakeRunner: GifRunner = async (_tool, args, signal, progress) => {
    signal.throwIfAborted();
    fs.writeFileSync(args.at(-1)!, gif);
    progress(1);
  };
  const service = new FilmMediaService(database, films, capabilities, runner ?? fakeRunner);
  const input: FilmGifInput = { requestId: randomUUID(), filmId: detail.id, partId,
    startSeconds: 1, endSeconds: 2, width: 320, fps: 10, setAsCover: true };
  return { root, sourceRoot, database, films, sources, source, scan, capabilities, service, input };
}

describe('GIF capture and custom covers', () => {
  it('saves beside the selected video, keeps IDs through scans and restarts, and restores the original cover', async () => {
    const context = await fixture();
    const originalPoster = context.films.detail(context.input.filmId)!.posterAssetId;
    const progress: number[] = [];
    const result = await context.service.createGif(context.input, (event) => progress.push(event.percent));
    const output = path.join(context.sourceRoot, 'films', result.filename);
    expect(fs.readFileSync(output)).toEqual(gif);
    expect(fs.readFileSync(path.join(context.sourceRoot, 'films', 'Movie.mp4'), 'utf8')).toBe('original video');
    expect(result.detail.posterAssetId).toBe(result.assetId);
    expect(context.films.preferredAssetLocation(context.input.filmId, ['poster', 'thumb'])?.relativePath).toBe(path.join('films', result.filename));
    expect(resolveMimeType(output)).toBe('image/gif');
    expect(progress.at(-1)).toBe(100);
    expect(result.detail.segments).toHaveLength(1);
    expect(result.detail.segments[0]).toMatchObject({ filmFileId: context.input.partId, startSeconds: 1, endSeconds: 2, title: 'gif片段', includeInPreview: true });
    context.scan.start({ sourceIds: [context.source.id] });
    await waitForScan(context.scan);
    expect(context.films.detail(context.input.filmId)!.posterAssetId).toBe(result.assetId);
    const second = await context.service.createGif({ ...context.input, requestId: randomUUID(), setAsCover: false }, () => {});
    expect(second.filename).not.toBe(result.filename);
    expect(second.detail.segments).toHaveLength(2);
    expect(second.detail.posterAssetId).toBe(result.assetId);
    expect(second.detail.images.some((image) => image.id === second.assetId)).toBe(true);
    context.database.close();
    const reopened = new DatabaseManager(context.database.databasePath);
    databases.push(reopened);
    const films = new FilmRepository(reopened.db);
    expect(films.detail(context.input.filmId)!.posterAssetId).toBe(result.assetId);
    expect(films.detail(context.input.filmId)!.segments).toHaveLength(2);
    expect(films.setCustomCover(context.input.filmId, null).posterAssetId).toBe(originalPoster);
    expect(fs.existsSync(output)).toBe(true);
  });

  it('uses consistent realpath resolution when Windows exposes different synchronous directory aliases', async () => {
    const context = await fixture();
    const realpathSync = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation((...args) => {
      if (String(args[0]) === context.sourceRoot) return path.join(context.root, 'alternate-source-alias');
      return realpathSync(...args);
    });
    const generated = await context.service.createGif(context.input, () => {});
    expect(context.films.assetLocation(generated.assetId)!.relativePath).toBe(path.join('films', generated.filename));
    const chosen = path.join(context.root, 'chosen.gif');
    fs.writeFileSync(chosen, gif);
    const imported = await context.service.importCover(context.input.filmId, chosen);
    const location = context.films.assetLocation(imported.posterAssetId!)!;
    expect(path.dirname(location.relativePath)).toBe('films');
    expect(fs.readFileSync(path.join(location.rootPath, location.relativePath))).toEqual(gif);
  });

  it('prefers fanart then thumb then poster, with custom GIFs taking priority', async () => {
    const context = await fixture();
    const movieRoot = path.join(context.sourceRoot, 'films');
    fs.writeFileSync(path.join(movieRoot, 'Movie-fanart.jpg'), 'fanart');
    fs.writeFileSync(path.join(movieRoot, 'Movie-thumb.jpg'), 'thumb');
    context.scan.start({ sourceIds: [context.source.id] });
    await waitForScan(context.scan);
    const film = context.films.detail(context.input.filmId)!;
    const fanart = film.images.find((image) => image.assetType === 'fanart')!;
    const thumb = film.images.find((image) => image.assetType === 'thumb')!;
    const poster = film.images.find((image) => image.assetType === 'poster')!;
    expect(film.posterAssetId).toBe(fanart.id);
    expect(context.films.page({ page: 1, pageSize: 20 }).items[0]!.posterAssetId).toBe(fanart.id);
    expect(context.films.preferredAssetLocation(film.id, DEFAULT_COVER_ASSET_TYPES)?.relativePath).toBe(fanart.relativePath);
    const generated = await context.service.createGif(context.input, () => {});
    expect(generated.detail.posterAssetId).toBe(generated.assetId);
    expect((await context.service.setCover(film.id, null)).posterAssetId).toBe(fanart.id);
    fs.unlinkSync(path.join(movieRoot, 'Movie-fanart.jpg'));
    context.scan.start({ sourceIds: [context.source.id] });
    await waitForScan(context.scan);
    expect(context.films.detail(film.id)!.posterAssetId).toBe(thumb.id);
    expect(context.films.preferredAssetLocation(film.id, DEFAULT_COVER_ASSET_TYPES)?.relativePath).toBe(thumb.relativePath);
    fs.unlinkSync(path.join(movieRoot, 'Movie-thumb.jpg'));
    context.scan.start({ sourceIds: [context.source.id] });
    await waitForScan(context.scan);
    expect(context.films.detail(film.id)!.posterAssetId).toBe(poster.id);
  });

  it('imports images without altering the original and preserves manual images on rescan', async () => {
    const context = await fixture();
    const chosen = path.join(context.root, 'chosen.gif');
    fs.writeFileSync(chosen, gif);
    const result = await context.service.importCover(context.input.filmId, chosen);
    const location = context.films.assetLocation(result.posterAssetId!)!;
    expect(location.relativePath).toMatch(/Movie-cover-.*\.gif$/);
    expect(fs.readFileSync(chosen)).toEqual(gif);
    context.scan.start({ sourceIds: [context.source.id] });
    await waitForScan(context.scan);
    expect(context.films.detail(context.input.filmId)!.posterAssetId).toBe(result.posterAssetId);
    fs.unlinkSync(path.join(location.rootPath, location.relativePath));
    context.scan.start({ sourceIds: [context.source.id] });
    await waitForScan(context.scan);
    expect(context.films.detail(context.input.filmId)!.posterAssetId).not.toBe(result.posterAssetId);
  });

  it('cancels processing, rejects simultaneous scans, cleans partial files and releases the operation lock', async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const runner: GifRunner = async (_tool, args, signal) => {
      fs.writeFileSync(args.at(-1)!, 'partial');
      entered();
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const context = await fixture(runner);
    const job = context.service.createGif(context.input, () => {});
    await ready;
    expect(() => context.scan.start({ sourceIds: [context.source.id] })).toThrow('FILM_MEDIA_BUSY');
    context.service.cancel(context.input.requestId);
    await expect(job).rejects.toThrow('GIF_CANCELLED');
    expect(fs.readdirSync(path.join(context.sourceRoot, 'films')).filter((name) => name.includes('-gif-'))).toEqual([]);
    expect(context.films.detail(context.input.filmId)!.images).toHaveLength(1);
    expect(context.films.detail(context.input.filmId)!.segments).toHaveLength(0);
    context.scan.start({ sourceIds: [context.source.id] });
    await waitForScan(context.scan);
  });

  it('leaves the original cover and cleans partial files when encoding fails', async () => {
    const context = await fixture(async (_tool, args) => { fs.writeFileSync(args.at(-1)!, 'partial'); throw new Error('GIF_GENERATION_FAILED'); });
    const poster = context.films.detail(context.input.filmId)!.posterAssetId;
    await expect(context.service.createGif(context.input, () => {})).rejects.toThrow('GIF_GENERATION_FAILED');
    expect(context.films.detail(context.input.filmId)!.posterAssetId).toBe(poster);
    expect(context.films.detail(context.input.filmId)!.segments).toHaveLength(0);
    expect(fs.readdirSync(path.join(context.sourceRoot, 'films')).filter((name) => name.includes('-gif-'))).toEqual([]);
  });

  it('rolls back the GIF asset and removes its file when adding the highlight segment fails', async () => {
    const context = await fixture();
    const before = context.films.detail(context.input.filmId)!;
    context.database.db.exec("CREATE TRIGGER reject_gif_segment BEFORE INSERT ON film_segment BEGIN SELECT RAISE(ABORT, 'segment save failed'); END");
    await expect(context.service.createGif(context.input, () => {})).rejects.toThrow('segment save failed');
    const after = context.films.detail(context.input.filmId)!;
    expect(after.posterAssetId).toBe(before.posterAssetId);
    expect(after.images).toHaveLength(before.images.length);
    expect(after.segments).toHaveLength(0);
    expect(fs.readdirSync(path.join(context.sourceRoot, 'films')).filter((name) => name.includes('-gif-'))).toEqual([]);
  });

  it('rejects invalid ranges, unavailable tools and assets or parts belonging to another film', async () => {
    const context = await fixture();
    for (const patch of [{ startSeconds: NaN }, { startSeconds: -1 }, { endSeconds: 1 }, { endSeconds: 32 }, { width: 5000 }, { fps: 100 }]) {
      expect(() => validateFilmGif({ ...context.input, ...patch })).toThrow('INVALID_GIF_INPUT');
    }
    expect(() => validateFilmCover({ filmId: context.input.filmId, assetId: '../image' })).toThrow('INVALID_COVER_INPUT');
    await expect(context.service.createGif({ ...context.input, filmId: randomUUID() }, () => {})).rejects.toThrow('PART_NOT_FOUND');
    await expect(context.service.setCover(context.input.filmId, randomUUID())).rejects.toThrow('COVER_NOT_FOUND');
    vi.spyOn(context.capabilities, 'toolPaths').mockReturnValue({ ffmpeg: null, ffprobe: null });
    await expect(context.service.createGif(context.input, () => {})).rejects.toThrow('GIF_TOOLS_UNAVAILABLE');
  });

  it('preserves the surviving custom cover when films with chosen covers are merged', async () => {
    const context = await fixture();
    const first = await context.service.createGif(context.input, () => {});
    fs.writeFileSync(path.join(context.sourceRoot, 'Other.mp4'), 'other film');
    context.scan.start({ sourceIds: [context.source.id] });
    await waitForScan(context.scan);
    const other = context.films.page({ page: 1, pageSize: 20 }).items.find((film) => film.id !== context.input.filmId)!;
    const part = context.films.detail(other.id)!.parts[0]!;
    const second = await context.service.createGif({ ...context.input, requestId: randomUUID(), filmId: other.id, partId: part.id }, () => {});
    new FilmFileOwnershipRepairService(context.database.db).mergeFilms(first.detail.id, other.id);
    const merged = context.films.detail(first.detail.id)!;
    expect(merged.posterAssetId).toBe(first.assetId);
    expect(merged.images.some((image) => image.id === second.assetId)).toBe(true);
  });

  const tools = resolveMediaToolPaths('');
  it.skipIf(!tools.ffmpeg || !tools.ffprobe)('encodes a real timed video segment into a looping GIF at the requested dimensions', async () => {
    const context = await fixture(runGifFfmpeg, true);
    const videoPath = path.join(context.sourceRoot, 'films', 'Movie.mp4');
    execFileSync(tools.ffmpeg!, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      'testsrc2=size=640x360:rate=24', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], { windowsHide: true });
    const result = await context.service.createGif(context.input, () => {});
    const output = path.join(context.sourceRoot, 'films', result.filename);
    const probe = JSON.parse(execFileSync(tools.ffprobe!, ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_name,width,height,nb_frames', '-of', 'json', output], { encoding: 'utf8', windowsHide: true }));
    expect(probe.streams[0]).toMatchObject({ codec_name: 'gif', width: 320, height: 180, nb_frames: '10' });
    expect(Number(probe.format.duration)).toBeCloseTo(1, 1);
    expect(fs.readFileSync(output).includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
    expect(fs.readdirSync(path.dirname(output)).some((name) => name.endsWith('.tmp'))).toBe(false);
  }, 20_000);
});
