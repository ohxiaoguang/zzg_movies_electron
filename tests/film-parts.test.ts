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
    expect(detail.title).toBe('分段电影');
    expect(detail.images).toHaveLength(4);
    expect(detail.nfoTags[0]?.name).toBe('科幻');
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.page({ page: 1, pageSize: 20 }).total).toBe(1);
    expect(context.films.detail(first.items[0].id)?.parts).toHaveLength(3);
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

  it('validates and persists the card width setting', () => {
    const root = makeRoot();
    const context = createContext(root);
    expect(() => context.settings.update({ cardSize: 139 })).toThrow('INVALID_CARD_SIZE');
    expect(context.settings.update({ cardSize: 280 }).cardSize).toBe(280);
    expect(context.settings.get().cardSize).toBe(280);
  });
});
