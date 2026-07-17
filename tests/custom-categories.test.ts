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

const roots: string[] = [];
const databases: DatabaseManager[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function createContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-categories-media-'));
  roots.push(root);
  for (const name of ['Alpha', 'Beta', 'Gamma']) fs.writeFileSync(path.join(root, `${name}.mkv`), name);
  fs.writeFileSync(path.join(root, 'Alpha.nfo'), '<movie><title>Alpha</title><tag>NFO Tag</tag><genre>Ignored Genre</genre><actor>Actor One</actor><actor>Actor Shared</actor><plot>Alpha summary</plot></movie>');
  fs.writeFileSync(path.join(root, 'Beta.nfo'), '<movie><title>Beta</title><actor>Actor Two</actor><actor>Actor Shared</actor><outline>Beta outline</outline></movie>');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-categories-db-'));
  roots.push(dataRoot);
  const database = new DatabaseManager(path.join(dataRoot, 'film-library.db'), new AppLogger(path.join(dataRoot, 'logs')));
  databases.push(database);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const source = sources.create({ name: 'Categories source', rootPath: root });
  const scan = new ScanCoordinator(database, sources, films, settings, new AppLogger(path.join(dataRoot, 'scan-logs')));
  return { root, database, films, scan, source };
}
async function waitForScan(scan: ScanCoordinator): Promise<void> { for (let attempt = 0; attempt < 200; attempt += 1) { if (scan.status()?.status !== 'running') return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('scan timeout'); }
async function scannedContext() { const context = createContext(); context.scan.start({}); await waitForScan(context.scan); return context; }
function filmByTitle(context: Awaited<ReturnType<typeof scannedContext>>, title: string) { return context.films.page({ page: 1, pageSize: 20, search: title }).items[0]!; }

describe('custom categories', () => {
  it('normalizes names, rejects empty/case duplicates, and persists ordering', async () => {
    const context = await scannedContext();
    expect(context.database.schemaVersion).toBe(7);
    expect(context.database.hasTable('genre')).toBe(true);
    expect(context.database.hasTable('film_genre')).toBe(true);
    expect((context.database.db.prepare("SELECT 1 AS present FROM pragma_table_info('film') WHERE name = 'status'").get() as { present: number }).present).toBe(1);
    const classic = context.films.createCategory('  Classic   Films  ');
    const mystery = context.films.createCategory('悬疑');
    expect(classic.name).toBe('Classic Films');
    expect(() => context.films.createCategory(' classic films ')).toThrow('CATEGORY_EXISTS');
    expect(() => context.films.createCategory('   ')).toThrow('INVALID_CATEGORY_NAME');
    expect(context.films.reorderCategories([mystery.id, classic.id]).map((item) => item.id)).toEqual([mystery.id, classic.id]);
    expect(context.films.listCategories().some((item) => item.name === 'NFO Tag')).toBe(false);
    const databasePath = context.database.databasePath;
    context.database.close();
    databases.splice(databases.indexOf(context.database), 1);
    const reopened = new DatabaseManager(databasePath);
    databases.push(reopened);
    expect(reopened.schemaVersion).toBe(7);
    expect(new FilmRepository(reopened.db).listCategories().map((item) => item.name)).toEqual(['悬疑', 'Classic Films']);
  });

  it('associates multiple categories, computes organization state, and reports counts', async () => {
    const context = await scannedContext();
    const alpha = filmByTitle(context, 'Alpha');
    const classic = context.films.createCategory('经典');
    const rewatch = context.films.createCategory('值得重看');
    expect(alpha.organizationState).toBe('unorganized');
    const organized = context.films.updateCategories(alpha.id, [classic.id, rewatch.id]);
    expect(organized.organizationState).toBe('organized');
    expect(organized.customCategories.map((item) => item.name)).toEqual(['经典', '值得重看']);
    expect(context.films.listCategories().map((item) => item.filmCount)).toEqual([1, 1]);
    context.films.updateCategories(alpha.id, []);
    expect(context.films.detail(alpha.id)?.organizationState).toBe('unorganized');
  });

  it('deleting a category removes only relations and leaves films, favorites, and NFO tags intact', async () => {
    const context = await scannedContext();
    const alpha = filmByTitle(context, 'Alpha');
    const category = context.films.createCategory('家庭观看');
    context.films.updateCategories(alpha.id, [category.id]);
    context.films.updateFavorite(alpha.id, true);
    const tagBefore = context.database.db.prepare('SELECT film_id, tag_id FROM film_tag WHERE film_id = ?').all(alpha.id);
    const nfoBefore = fs.readFileSync(path.join(context.root, 'Alpha.nfo'), 'utf8');
    context.films.removeCategory(category.id);
    const detail = context.films.detail(alpha.id)!;
    expect(detail.organizationState).toBe('unorganized');
    expect(detail.favorite).toBe(true);
    expect(detail.nfoTags.map((tag) => tag.name)).toEqual(['NFO Tag']);
    expect(context.database.db.prepare('SELECT film_id, tag_id FROM film_tag WHERE film_id = ?').all(alpha.id)).toEqual(tagBefore);
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film').get()).toEqual({ count: 3 });
    expect(fs.readFileSync(path.join(context.root, 'Alpha.nfo'), 'utf8')).toBe(nfoBefore);
  });

  it('rolls back category creation and film relations when a transactional save fails', async () => {
    const context = await scannedContext();
    const alpha = filmByTitle(context, 'Alpha');
    context.database.db.exec("CREATE TRIGGER fail_category_link BEFORE INSERT ON film_custom_category BEGIN SELECT RAISE(ABORT, 'forced category failure'); END;");
    expect(() => context.films.updateCategories(alpha.id, [], ['Rollback Category'])).toThrow('forced category failure');
    expect(context.films.listCategories()).toEqual([]);
    expect(context.films.detail(alpha.id)?.organizationState).toBe('unorganized');
  });

  it('supports organized/unorganized, favorite, category any/all, and all-data queries without legacy filters', async () => {
    const context = await scannedContext();
    const alpha = filmByTitle(context, 'Alpha');
    const beta = filmByTitle(context, 'Beta');
    const first = context.films.createCategory('First');
    const second = context.films.createCategory('Second');
    context.films.updateCategories(alpha.id, [first.id, second.id]);
    context.films.updateCategories(beta.id, [first.id]);
    context.films.updateFavorite(beta.id, true);
    expect(context.films.page({ page: 1, pageSize: 20, organizationState: 'unorganized' }).items.map((item) => item.title)).toEqual(['Gamma']);
    expect(context.films.page({ page: 1, pageSize: 20, organizationState: 'organized' }).total).toBe(2);
    expect(context.films.page({ page: 1, pageSize: 20, favoriteOnly: true }).items.map((item) => item.title)).toEqual(['Beta']);
    expect(context.films.page({ page: 1, pageSize: 20, categoryIds: [first.id, second.id], categoryMatch: 'any' }).total).toBe(2);
    expect(context.films.page({ page: 1, pageSize: 20, categoryIds: [first.id, second.id], categoryMatch: 'all' }).items.map((item) => item.title)).toEqual(['Alpha']);
    expect(context.films.page({ page: 1, pageSize: 20, status: 'watched', genre: 'Ignored Genre' } as never).total).toBe(3);
    fs.unlinkSync(path.join(context.root, 'Gamma.mkv'));
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.films.page({ page: 1, pageSize: 20 }).total).toBe(2);
    expect(context.films.page({ page: 1, pageSize: 20, allData: true }).total).toBe(3);
  });

  it('lists NFO actors, filters films by actor, and prepares only organized CSV rows', async () => {
    const context = await scannedContext();
    const alpha = filmByTitle(context, 'Alpha');
    const beta = filmByTitle(context, 'Beta');
    const category = context.films.createCategory('CSV Category');
    context.films.updateCategories(alpha.id, [category.id]);

    expect(context.films.listActors()).toEqual([
      { name: 'Actor One', filmCount: 1 },
      { name: 'Actor Shared', filmCount: 2 },
      { name: 'Actor Two', filmCount: 1 },
    ]);
    expect(context.films.page({ page: 1, pageSize: 20, actor: 'actor shared' }).items.map((item) => item.title)).toEqual(['Alpha', 'Beta']);
    expect(context.films.page({ page: 1, pageSize: 20, actor: 'Actor One' }).items.map((item) => item.title)).toEqual(['Alpha']);

    expect(context.films.csvRows({ page: 1, pageSize: 1, actor: 'Actor Shared' })).toEqual([
      {
        filename: 'Alpha.mkv',
        nfoTitle: 'Alpha',
        customCategories: ['CSV Category'],
        actors: ['Actor One', 'Actor Shared'],
        nfoSummary: 'Alpha summary',
      },
    ]);
    expect(context.films.detail(beta.id)?.organizationState).toBe('unorganized');
  });
});
