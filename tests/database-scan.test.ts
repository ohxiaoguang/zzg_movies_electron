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

const tempRoots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'extrafanart'));
  fs.writeFileSync(path.join(root, 'Movie A.mkv'), 'small fake media file for tests');
  fs.writeFileSync(path.join(root, 'Movie A.nfo'), '<movie><title>测试电影</title><year>2026</year><genre>科幻</genre><actor>演员</actor></movie>');
  fs.writeFileSync(path.join(root, 'Movie A-poster.jpg'), 'poster');
  fs.writeFileSync(path.join(root, 'Movie A-fanart.jpg'), 'fanart');
  fs.writeFileSync(path.join(root, 'Movie A-preview.mp4'), 'preview');
  fs.writeFileSync(path.join(root, 'extrafanart', '2.jpg'), 'two');
  fs.writeFileSync(path.join(root, 'extrafanart', '10.jpg'), 'ten');
  fs.writeFileSync(path.join(root, 'ignored.llc'), 'ignore');
  return root;
}

async function waitForScan(scan: ScanCoordinator): Promise<NonNullable<ReturnType<ScanCoordinator['status']>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = scan.status();
    if (status && status.status !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('scan timeout');
}

function createContext(root: string) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-db-'));
  tempRoots.push(temp);
  const logger = new AppLogger(path.join(temp, 'logs'));
  const database = new DatabaseManager(path.join(temp, 'film-library.db'), logger);
  databases.push(database);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const source = sources.create({ name: '测试来源', rootPath: root });
  const scan = new ScanCoordinator(database, sources, films, settings, logger);
  return { database, sources, films, settings, source, scan };
}

describe('SQLite migrations and scanning', () => {
  it('creates migrated tables, scans NFO/assets, and supports paging', async () => {
    const root = fixtureRoot();
    const context = createContext(root);
    expect(context.database.db.pragma('user_version', { simple: true })).toBe(6);
    expect(context.database.db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'film_file\'').get()).toBeTruthy();
    const start = context.scan.start({});
    expect(start.jobId).toMatch(/[0-9a-f-]{36}/);
    const status = await waitForScan(context.scan);
    expect(status.status).toBe('completed');
    const page = context.films.page({ page: 1, pageSize: 60, search: '测试电影' });
    expect(page.total).toBe(1);
    expect(page.items[0].previewAssetId).not.toBeNull();
    expect(page.items[0].previewImageAssetIds).toHaveLength(3);
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film_genre').get()).toEqual({ count: 0 });
  });

  it('is idempotent, preserves user fields, and detects a moved film by fingerprint', async () => {
    const root = fixtureRoot();
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const first = context.films.page({ page: 1, pageSize: 60 });
    const film = first.items[0];
    context.films.update({ id: film.id, title: '用户标题', rating: 8.5, notes: '用户备注' });
    context.films.updateFavorite(film.id, true);
    context.scan.start({});
    const secondStatus = await waitForScan(context.scan);
    expect(secondStatus.status).toBe('completed');
    expect(context.films.page({ page: 1, pageSize: 60 }).total).toBe(1);
    expect(context.films.detail(film.id)?.title).toBe('用户标题');
    expect(context.films.detail(film.id)?.favorite).toBe(true);
    fs.renameSync(path.join(root, 'Movie A.mkv'), path.join(root, 'Renamed Movie.mkv'));
    context.scan.start({});
    const movedStatus = await waitForScan(context.scan);
    expect(movedStatus.moved).toBe(1);
    expect(context.films.page({ page: 1, pageSize: 60 }).items[0].filename).toBe('Renamed Movie.mkv');
  });

  it('does not mark films missing when the source is offline', async () => {
    const root = fixtureRoot();
    const context = createContext(root);
    context.scan.start({});
    await waitForScan(context.scan);
    const offlineRoot = root + '-offline';
    fs.renameSync(root, offlineRoot);
    context.scan.start({});
    const status = await waitForScan(context.scan);
    expect(status.status).toBe('completed');
    expect(status.message).toContain('离线');
    expect(context.films.page({ page: 1, pageSize: 60 }).items[0].missing).toBe(false);
    fs.renameSync(offlineRoot, root);
  });

  it('archives a source without touching external files', () => {
    const root = fixtureRoot();
    const context = createContext(root);
    const before = fs.readFileSync(path.join(root, 'Movie A.mkv'), 'utf8');
    context.database.transaction(() => context.sources.remove({ id: context.source.id, mode: 'keep-records' }));
    expect(fs.readFileSync(path.join(root, 'Movie A.mkv'), 'utf8')).toBe(before);
    expect(context.sources.findById(context.source.id)?.deletedAt).not.toBeNull();
    expect(context.sources.list()).toHaveLength(0);
  });
});
