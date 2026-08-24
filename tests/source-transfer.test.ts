import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { ScanCoordinator } from '../src/main/scanner/ScanCoordinator';
import { SourceTransferService } from '../src/main/services/SourceTransferService';
import { AppLogger } from '../src/main/system/AppLogger';

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('source transfer', () => {
  it('moves scanned media and sidecars, preserves organization and segments, and keeps the source folder', async () => {
    const fixture = createFixture();
    const source = fixture.sources.create({ name: '来源A', rootPath: fixture.sourceRoot });
    const target = fixture.sources.create({ name: '来源B', rootPath: fixture.targetRoot });
    fixture.scan.start({ sourceIds: [source.id] });
    await waitForScan(fixture.scan);

    const film = fixture.films.page({ page: 1, pageSize: 20 }).items[0]!;
    const detail = fixture.films.detail(film.id)!;
    const category = fixture.films.createCategory('已分类');
    fixture.films.updateCategories(film.id, [category.id]);
    const segment = fixture.films.createSegment({
      filmId: film.id,
      filmFileId: detail.parts[0]!.id,
      startSeconds: 12,
      endSeconds: 18,
      title: '精彩片段',
    });

    const transfer = new SourceTransferService(
      fixture.database,
      fixture.sources,
      fixture.logger,
      () => new Date(2026, 7, 24, 15, 16, 17),
    );
    const result = await transfer.transfer({ sourceId: source.id, targetSourceId: target.id });
    const destination = path.join(fixture.targetRoot, '来源A_20260824151617', '影片目录');

    expect(result).toMatchObject({
      destinationFolderName: '来源A_20260824151617',
      movedFilmCount: 1,
      movedFileCount: 1,
      movedAssetCount: 3,
    });
    expect(fs.existsSync(path.join(destination, 'Movie A.mkv'))).toBe(true);
    expect(fs.existsSync(path.join(destination, 'Movie A.nfo'))).toBe(true);
    expect(fs.existsSync(path.join(destination, 'Movie A-poster.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(destination, 'Movie A.zh-Hans.srt'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.sourceRoot, '影片目录', 'Movie A.mkv'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.sourceRoot, '不要移动.txt'))).toBe(true);
    expect(fs.statSync(fixture.sourceRoot).isDirectory()).toBe(true);

    expect(fixture.sources.list().map((item) => item.id)).toEqual([target.id]);
    expect(fixture.sources.findById(source.id)?.deletedAt).not.toBeNull();
    const transferred = fixture.films.detail(film.id)!;
    expect(transferred.sourceId).toBe(target.id);
    expect(transferred.relativePath).toBe(path.join('来源A_20260824151617', '影片目录', 'Movie A.mkv'));
    expect(transferred.parts[0]?.id).toBe(detail.parts[0]!.id);
    expect(transferred.customCategories.map((item) => item.name)).toEqual(['已分类']);
    expect(transferred.segments).toEqual([expect.objectContaining({ id: segment.id, title: '精彩片段' })]);
  });

  it('stops before changing files or records when a scanned video is unexpectedly missing', async () => {
    const fixture = createFixture();
    const source = fixture.sources.create({ name: '来源A', rootPath: fixture.sourceRoot });
    const target = fixture.sources.create({ name: '来源B', rootPath: fixture.targetRoot });
    fixture.scan.start({ sourceIds: [source.id] });
    await waitForScan(fixture.scan);
    fs.unlinkSync(path.join(fixture.sourceRoot, '影片目录', 'Movie A.mkv'));

    const transfer = new SourceTransferService(fixture.database, fixture.sources, fixture.logger);
    await expect(transfer.transfer({ sourceId: source.id, targetSourceId: target.id })).rejects.toThrow('SOURCE_TRANSFER_FILE_MISSING');

    expect(fixture.sources.findById(source.id)?.deletedAt).toBeNull();
    expect(fs.readdirSync(fixture.targetRoot)).toEqual([]);
    expect(fixture.films.page({ page: 1, pageSize: 20, allData: true }).items[0]?.sourceId).toBe(source.id);
  });

  it('corrects only the transferred batch when the target was selected incorrectly', async () => {
    const fixture = createFixture();
    const correctTargetRoot = path.join(path.dirname(fixture.targetRoot), 'source-c');
    fs.mkdirSync(correctTargetRoot);
    fs.writeFileSync(path.join(fixture.targetRoot, 'Target Own Movie.mp4'), 'target-video');
    const source = fixture.sources.create({ name: '来源A', rootPath: fixture.sourceRoot });
    const wrongTarget = fixture.sources.create({ name: '来源B', rootPath: fixture.targetRoot });
    const correctTarget = fixture.sources.create({ name: '来源C', rootPath: correctTargetRoot });
    fixture.scan.start({ sourceIds: [source.id, wrongTarget.id] });
    await waitForScan(fixture.scan);

    const page = fixture.films.page({ page: 1, pageSize: 20, sort: 'file' });
    const transferredFilm = page.items.find((item) => item.filename === 'Movie A.mkv')!;
    const targetOwnFilm = page.items.find((item) => item.filename === 'Target Own Movie.mp4')!;
    const partId = fixture.films.detail(transferredFilm.id)!.parts[0]!.id;
    const segment = fixture.films.createSegment({
      filmId: transferredFilm.id,
      filmFileId: partId,
      startSeconds: 3,
      endSeconds: 7,
      title: '保留的片段',
    });
    const clock = () => new Date(2026, 7, 24, 16, 20, 30);
    const transfer = new SourceTransferService(fixture.database, fixture.sources, fixture.logger, clock);
    const first = await transfer.transfer({ sourceId: source.id, targetSourceId: wrongTarget.id });

    expect(transfer.listRecentTransfers()).toEqual([
      expect.objectContaining({
        sourceId: source.id,
        targetSourceId: wrongTarget.id,
        destinationFolderName: first.destinationFolderName,
        filmCount: 1,
      }),
    ]);
    const corrected = await transfer.correctTransfer({
      sourceId: source.id,
      currentTargetSourceId: wrongTarget.id,
      newTargetSourceId: correctTarget.id,
      destinationFolderName: first.destinationFolderName,
    });

    expect(fs.existsSync(path.join(fixture.targetRoot, 'Target Own Movie.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(corrected.destinationPath, '影片目录', 'Movie A.mkv'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.targetRoot, first.destinationFolderName))).toBe(false);
    expect(fixture.films.detail(targetOwnFilm.id)?.sourceId).toBe(wrongTarget.id);
    expect(fixture.films.detail(transferredFilm.id)).toMatchObject({
      sourceId: correctTarget.id,
      segments: [expect.objectContaining({ id: segment.id, title: '保留的片段' })],
    });
    expect(transfer.listRecentTransfers()).toEqual([
      expect.objectContaining({ sourceId: source.id, targetSourceId: correctTarget.id, filmCount: 1 }),
    ]);
  });
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-source-transfer-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'source-a');
  const targetRoot = path.join(root, 'source-b');
  const mediaDirectory = path.join(sourceRoot, '影片目录');
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(path.join(mediaDirectory, 'Movie A.mkv'), 'video');
  fs.writeFileSync(path.join(mediaDirectory, 'Movie A.nfo'), '<movie><title>影片 A</title></movie>');
  fs.writeFileSync(path.join(mediaDirectory, 'Movie A-poster.jpg'), 'poster');
  fs.writeFileSync(path.join(mediaDirectory, 'Movie A.zh-Hans.srt'), 'subtitle');
  fs.writeFileSync(path.join(sourceRoot, '不要移动.txt'), 'keep');

  const logger = new AppLogger(path.join(root, 'logs'));
  const database = new DatabaseManager(path.join(root, 'library.db'), logger);
  databases.push(database);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const scan = new ScanCoordinator(database, sources, films, settings, logger);
  return { database, films, logger, scan, sourceRoot, sources, targetRoot };
}

async function waitForScan(scan: ScanCoordinator): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = scan.status();
    if (status && status.status !== 'running') {
      expect(status.status).toBe('completed');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('scan timeout');
}
