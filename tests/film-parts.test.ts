import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { ScanCoordinator } from '../src/main/scanner/ScanCoordinator';
import { AppLogger } from '../src/main/system/AppLogger';
import { FilmLibraryManagementService } from '../src/main/services/FilmLibraryManagementService';
import { FilmLibraryReadService } from '../src/main/services/FilmLibraryReadService';
import { groupVideoFiles } from '../src/main/scanner/SourceScanner';

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createContext(root: string) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-parts-db-'));
  roots.push(dataRoot);
  const database = new DatabaseManager(path.join(dataRoot, 'film-library.db'), new AppLogger(path.join(dataRoot, 'logs')));
  databases.push(database);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const source = sources.create({ name: '分段测试来源', rootPath: root });
  const scan = new ScanCoordinator(database, sources, films, settings, new AppLogger(path.join(dataRoot, 'scan-logs')));
  return { database, sources, films, settings, source, scan };
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-parts-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'extrafanart'));
  for (const filename of ['Movie-cd1.mp4', 'Movie-cd2.mp4', 'Movie-cd3.mp4']) fs.writeFileSync(path.join(root, filename), filename);
  fs.writeFileSync(path.join(root, 'Movie.nfo'), '<movie><title>分段电影</title><tag>科幻</tag></movie>');
  fs.writeFileSync(path.join(root, 'Movie-poster.jpg'), 'poster');
  fs.writeFileSync(path.join(root, 'Movie-fanart.jpg'), 'fanart');
  fs.writeFileSync(path.join(root, 'extrafanart', '2.jpg'), 'two');
  fs.writeFileSync(path.join(root, 'extrafanart', '10.jpg'), 'ten');
  return root;
}

async function waitForScan(scan: ScanCoordinator): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (scan.status()?.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('scan timeout');
}

describe('multi-part films and availability', () => {
  it('relinks a missing video without losing its identity, annotations, or playback state across scans', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-relink-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'Original.mp4'), 'video');
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const id = context.films.page({ page: 1, pageSize: 20 }).items[0]!.id;
    const partId = context.films.detail(id)!.parts[0]!.id;
    context.films.update({ id, title: '手动标题', notes: '原有备注', rating: 8 });
    context.films.updateFavorite(id, true);
    context.films.updateCategories(id, [], ['已标注']);
    context.films.updatePartVr(partId, true);
    context.films.updatePlaybackProgress(id, partId, 2, 10);
    const segment = context.films.createSegment({ filmId: id, filmFileId: partId, startSeconds: 1, endSeconds: 3, title: '片段', comment: '标注' });
    const before = context.films.detail(id)!;
    fs.mkdirSync(path.join(root, 'moved'));
    const newPath = path.join(root, 'moved', 'Renamed.mp4');
    fs.renameSync(path.join(root, 'Original.mp4'), newPath);
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.detail(id)!.parts[0]!.missing).toBe(true);
    // Remove the new scan record so the moved file can be bound to the annotated original.
    const duplicate = context.films.findByPath(context.source.id, path.join('moved', 'Renamed.mp4'))!;
    context.films.deleteRecords([duplicate.id]);
    const read = new FilmLibraryReadService(context.films, context.sources, context.settings);
    const management = new FilmLibraryManagementService(context.database, context.films, context.sources, read, context.scan, new AppLogger(path.join(root, 'logs')));
    const updated = await management.updatePartPath(partId, `"${newPath}"`);
    expect(updated.id).toBe(id);
    expect(updated.relativePath).toBe(path.join('moved', 'Renamed.mp4'));
    expect(updated.parts[0]).toMatchObject({ id: partId, filename: 'Renamed.mp4', missing: false, isVr: true });
    expect(updated).toMatchObject({ title: before.title, notes: before.notes, rating: 8, favorite: true });
    expect(updated.customCategories).toEqual(before.customCategories);
    expect(updated.playbackState).toEqual(before.playbackState);
    expect(updated.segments[0]).toMatchObject({ id: segment.id, filmFileId: partId, title: '片段', comment: '标注' });
    expect(context.films.partLocation(partId)?.relativePath).toBe(updated.relativePath);
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.page({ page: 1, pageSize: 20 }).total).toBe(1);
    expect(context.films.detail(id)!.parts[0]!.id).toBe(partId);
    expect(context.films.detail(id)!.segments[0]!.id).toBe(segment.id);
  });

  it('rejects nonexistent, outside, directory, and occupied paths without changing the original', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'Other.mp4'), 'other');
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const detail = context.films.detail(context.films.page({ page: 1, pageSize: 20 }).items.find((film) => film.filename === 'Movie-cd1.mp4')!.id)!;
    const partId = detail.parts[0]!.id;
    const read = new FilmLibraryReadService(context.films, context.sources, context.settings);
    const management = new FilmLibraryManagementService(context.database, context.films, context.sources, read, context.scan, new AppLogger(path.join(root, 'logs')));
    await expect(management.updatePartPath(partId, 'missing.mp4')).rejects.toThrow();
    await expect(management.updatePartPath(partId, 'Other.mp4')).rejects.toThrow('PART_PATH_EXISTS');
    await expect(management.updatePartPath(partId, path.join('..', 'outside.mp4'))).rejects.toThrow('MEDIA_PATH_OUTSIDE_SOURCE');
    await expect(management.updatePartPath(partId, 'extrafanart')).rejects.toThrow('PART_PATH_NOT_FILE');
    await expect(management.updatePartPath(partId, detail.parts[1]!.relativePath.toUpperCase())).rejects.toThrow('PART_PATH_EXISTS');
    expect(context.films.detail(detail.id)!.parts).toEqual(detail.parts);
    fs.mkdirSync(path.join(root, 'relocated'));
    const movedPath = path.join('relocated', detail.parts[1]!.filename);
    fs.renameSync(path.join(root, detail.parts[1]!.relativePath), path.join(root, movedPath));
    const updated = await management.updatePartPath(detail.parts[1]!.id, movedPath);
    expect(updated.relativePath).toBe(detail.relativePath);
    expect(updated.parts[1]).toMatchObject({ id: detail.parts[1]!.id, relativePath: movedPath, missing: false });
  });

  it.each([false, true])('sorts by total video size through query validation (strict=%s)', async (strict) => {
    const root = makeRoot();
    for (const part of [1, 2, 3]) fs.writeFileSync(path.join(root, `Movie-cd${part}.mp4`), Buffer.alloc(40));
    fs.writeFileSync(path.join(root, 'Single.mp4'), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, 'Small.mp4'), Buffer.alloc(10));
    fs.writeFileSync(path.join(root, 'Small-poster.jpg'), Buffer.alloc(1000));
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);

    const query = { page: 1, pageSize: 20, sort: 'size' as const };
    const library = new FilmLibraryReadService(context.films, context.sources, context.settings);
    expect(library.page(query, strict).items.map((film) => film.filename)).toEqual([
      'Movie-cd1.mp4', 'Single.mp4', 'Small.mp4',
    ]);
    expect(library.page({ ...query, page: 2, pageSize: 1 }, strict).items[0]?.filename).toBe('Single.mp4');

    fs.writeFileSync(path.join(root, 'Movie-cd2.mp4'), Buffer.alloc(1));
    context.scan.start({});
    await waitForScan(context.scan);
    expect(library.page(query, strict).items.map((film) => film.filename)).toEqual([
      'Single.mp4', 'Movie-cd1.mp4', 'Small.mp4',
    ]);
  });

  it('groups only exact -cdN files, keeps one film id, and is idempotent', async () => {
    const root = makeRoot();
    const context = createContext(root);
    expect(groupVideoFiles([
      { absolutePath: 'a', relativePath: 'Movie-cd1.mp4', name: 'Movie-cd1.mp4' },
      { absolutePath: 'b', relativePath: 'Movie-cd2.mp4', name: 'Movie-cd2.mp4' },
    ])).toHaveLength(1);
    expect(groupVideoFiles([
      { absolutePath: 'a', relativePath: 'Movie_cd1.mp4', name: 'Movie_cd1.mp4' },
      { absolutePath: 'b', relativePath: 'Movie.disc2.mp4', name: 'Movie.disc2.mp4' },
    ])).toHaveLength(2);
    expect(groupVideoFiles([
      { absolutePath: 'a', relativePath: 'one/Movie-cd1.mp4', name: 'Movie-cd1.mp4' },
      { absolutePath: 'b', relativePath: 'two/Movie-cd2.mp4', name: 'Movie-cd2.mp4' },
      { absolutePath: 'c', relativePath: 'Movie Part 1.mp4', name: 'Movie Part 1.mp4' },
    ])).toHaveLength(3);
    expect(groupVideoFiles([
      { absolutePath: 'a', relativePath: 'Twin-A.mp4', name: 'Twin-A.mp4' },
      { absolutePath: 'b', relativePath: 'Twin_A.mp4', name: 'Twin_A.mp4' },
      { absolutePath: 'c', relativePath: 'Twin-A.mkv', name: 'Twin-A.mkv' },
    ])).toHaveLength(3);
    context.scan.start({});
    await waitForScan(context.scan);
    const first = context.films.page({ page: 1, pageSize: 20 });
    expect(first.total).toBe(1);
    const detail = context.films.detail(first.items[0].id)!;
    expect(detail.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(detail.parts.map((part) => part.partType)).toEqual(['cd', 'cd', 'cd']);
    expect(detail.parts.every((part) => !part.isVr)).toBe(true);
    expect(context.films.updatePartVr(detail.parts[1]!.id, true).isVr).toBe(true);
    expect(detail.title).toBe('分段电影');
    expect(detail.images).toHaveLength(4);
    expect(detail.nfoTags[0]?.name).toBe('科幻');
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.page({ page: 1, pageSize: 20 }).total).toBe(1);
    expect(context.films.detail(first.items[0].id)?.parts).toHaveLength(3);
    expect(context.films.detail(first.items[0].id)?.parts[1]?.isVr).toBe(true);
    expect(context.films.page({ page: 1, pageSize: 20, allData: true, recordIssue: 'invalid-multipart' }).total).toBe(0);
  });

  it('keeps same-stem TS and MP4 files separate and finds a simulated legacy bad merge', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-extension-collision-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, '1 (3).ts'), 'same title ts');
    fs.writeFileSync(path.join(root, '1 (3).mp4'), 'same title mp4');
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);

    const separate = context.films.page({ page: 1, pageSize: 20, sort: 'file' });
    expect(separate.total).toBe(2);
    expect(separate.items.map((film) => film.filename).sort()).toEqual(['1 (3).mp4', '1 (3).ts']);
    expect(context.films.page({ page: 1, pageSize: 20, allData: true, recordIssue: 'invalid-multipart' }).total).toBe(0);

    const [survivor, merged] = separate.items;
    context.database.transaction(() => {
      context.database.db.prepare('UPDATE film_file SET film_id = ? WHERE film_id = ?').run(survivor.id, merged.id);
      context.database.db.prepare('DELETE FROM film WHERE id = ?').run(merged.id);
    });
    const invalid = context.films.page({ page: 1, pageSize: 20, allData: true, recordIssue: 'invalid-multipart' });
    expect(invalid.total).toBe(1);
    expect(invalid.items[0]?.id).toBe(survivor.id);

    context.films.deleteRecords([survivor.id]);
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.page({ page: 1, pageSize: 20 }).total).toBe(2);
  });

  it('keeps partial films visible and hides fully missing films from normal pages', async () => {
    const root = makeRoot();
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const film = context.films.page({ page: 1, pageSize: 20 }).items[0];
    fs.unlinkSync(path.join(root, 'Movie-cd2.mp4'));
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.page({ page: 1, pageSize: 20 }).total).toBe(1);
    expect(context.films.detail(film.id)?.availability).toBe('partial_missing');
    fs.unlinkSync(path.join(root, 'Movie-cd1.mp4'));
    fs.unlinkSync(path.join(root, 'Movie-cd3.mp4'));
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.page({ page: 1, pageSize: 20 }).total).toBe(0);
    const all = context.films.page({ page: 1, pageSize: 20, allData: true });
    expect(all.total).toBe(1);
    expect(all.items[0].availability).toBe('missing');
  });

  it('supports custom categories, source soft delete, and database-only delete', async () => {
    const root = makeRoot();
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const film = context.films.page({ page: 1, pageSize: 20 }).items[0];
    const category = context.films.createCategory('值得重看');
    context.films.updateCategories(film.id, [category.id], ['家庭观看']);
    expect(context.films.detail(film.id)?.customCategories.map((item) => item.name)).toEqual(['值得重看', '家庭观看']);
    context.database.transaction(() => context.sources.remove({ id: context.source.id, mode: 'keep-records' }));
    expect(context.films.page({ page: 1, pageSize: 20 }).total).toBe(0);
    expect(context.films.page({ page: 1, pageSize: 20, allData: true }).items[0].availability).toBe('source_removed');
    expect(context.sources.restore(context.source.id).deletedAt).toBeNull();
    context.films.deleteRecords([film.id]);
    expect(context.films.page({ page: 1, pageSize: 20, allData: true }).total).toBe(0);
    expect(fs.existsSync(path.join(root, 'Movie-cd1.mp4'))).toBe(true);
  });

  it('validates and persists desktop, player and playback-cache settings', () => {
    const root = makeRoot();
    const context = createContext(root);
    expect(() => context.settings.update({ cardSize: 139 })).toThrow('INVALID_CARD_SIZE');
    expect(context.settings.update({ cardSize: 280 }).cardSize).toBe(280);
    expect(context.settings.get().cardSize).toBe(280);
    expect(context.settings.update({ hoverCloseDelayMs: 750 }).hoverCloseDelayMs).toBe(750);
    expect(context.settings.get().hoverCloseDelayMs).toBe(750);
    expect(() => context.settings.update({ hoverCloseDelayMs: -1 })).toThrow('INVALID_HOVER_CLOSE_DELAY');
    expect(() => context.settings.update({ hoverCloseDelayMs: 5001 })).toThrow('INVALID_HOVER_CLOSE_DELAY');
    expect(context.settings.update({ detailPlayerSeekStepSeconds: 10 }).detailPlayerSeekStepSeconds).toBe(10);
    expect(context.settings.get().detailPlayerSeekStepSeconds).toBe(10);
    expect(() => context.settings.update({ detailPlayerSeekStepSeconds: 0 })).toThrow('INVALID_DETAIL_PLAYER_SEEK_STEP');
    expect(() => context.settings.update({ detailPlayerSeekStepSeconds: 1.5 })).toThrow('INVALID_DETAIL_PLAYER_SEEK_STEP');
    expect(context.settings.update({ detailPlayerFineSeekStepSeconds: 0.25 }).detailPlayerFineSeekStepSeconds).toBe(0.25);
    expect(context.settings.get().detailPlayerFineSeekStepSeconds).toBe(0.25);
    expect(() => context.settings.update({ detailPlayerFineSeekStepSeconds: 0 })).toThrow('INVALID_DETAIL_PLAYER_FINE_SEEK_STEP');
    expect(() => context.settings.update({ detailPlayerFineSeekStepSeconds: 5.01 })).toThrow('INVALID_DETAIL_PLAYER_FINE_SEEK_STEP');
    const cacheDirectory = path.join(root, 'Local Film Library Playback Cache');
    expect(context.settings.update({
      playbackCacheDirectory: cacheDirectory,
      playbackCacheLimitGb: 35,
      autoLaunchOnStartup: true,
      launchToTray: true,
      minimizeToTray: true,
    })).toMatchObject({
      playbackCacheDirectory: cacheDirectory,
      playbackCacheLimitGb: 35,
      autoLaunchOnStartup: true,
      launchToTray: true,
      minimizeToTray: true,
    });
    expect(context.settings.get()).toMatchObject({
      autoLaunchOnStartup: true,
      launchToTray: true,
      minimizeToTray: true,
    });
    expect(() => context.settings.update({ playbackCacheLimitGb: 0 })).toThrow('INVALID_PLAYBACK_CACHE_LIMIT');
    expect(() => context.settings.update({ playbackCacheDirectory: 'relative-cache' }))
      .toThrow('INVALID_PLAYBACK_CACHE_DIRECTORY');
    expect(() => context.settings.update({ playbackCacheDirectory: path.join(root, 'unrelated-folder') }))
      .toThrow('INVALID_PLAYBACK_CACHE_DIRECTORY');
  });
});
