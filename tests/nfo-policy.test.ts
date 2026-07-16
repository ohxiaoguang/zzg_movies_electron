import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { mapNfoMetadata } from '../src/main/metadata/NfoMapper';
import { parseNfo } from '../src/main/metadata/NfoParser';
import { ScanCoordinator } from '../src/main/scanner/ScanCoordinator';
import { AppLogger } from '../src/main/system/AppLogger';

const roots: string[] = [];
const databases: DatabaseManager[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function createContext(nfo: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-nfo-policy-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'Policy Movie.mkv'), 'media');
  fs.writeFileSync(path.join(root, 'Policy Movie.nfo'), nfo);
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-nfo-policy-db-'));
  roots.push(dataRoot);
  const database = new DatabaseManager(path.join(dataRoot, 'film-library.db'), new AppLogger(path.join(dataRoot, 'logs')));
  databases.push(database);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const source = sources.create({ name: 'NFO policy source', rootPath: root });
  const scan = new ScanCoordinator(database, sources, films, settings, new AppLogger(path.join(dataRoot, 'scan-logs')));
  return { root, database, films, scan, source };
}

async function waitForScan(scan: ScanCoordinator): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (scan.status()?.status !== 'running') return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('scan timeout');
}
function firstFilm(context: ReturnType<typeof createContext>) { const page = context.films.page({ page: 1, pageSize: 20 }); expect(page.total).toBe(1); return context.films.detail(page.items[0]!.id)!; }

describe('NFO read-only taxonomy policy', () => {
  it('imports NFO tags while genre remains parser-only and absent from business storage', async () => {
    const context = createContext('<movie><title>Policy Movie</title><tag>NFO Tag A</tag><genre>NFO Genre A</genre></movie>');
    context.scan.start({});
    await waitForScan(context.scan);
    const film = firstFilm(context);
    expect(film.nfoTags.map((tag) => tag.name)).toEqual(['NFO Tag A']);
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film_genre').get()).toEqual({ count: 0 });
    expect(context.database.db.prepare("SELECT status FROM film WHERE id = ?").get(film.id)).toEqual({ status: 'unorganized' });
  });

  it('updates NFO tags on normal rescans without changing custom categories', async () => {
    const context = createContext('<movie><title>Policy Movie</title><tag>NFO Tag A</tag></movie>');
    context.scan.start({});
    await waitForScan(context.scan);
    const film = firstFilm(context);
    const category = context.films.createCategory('经典');
    context.films.updateCategories(film.id, [category.id]);
    fs.writeFileSync(path.join(context.root, 'Policy Movie.nfo'), '<movie><title>Policy Movie</title><tag>NFO Tag B</tag></movie>');
    context.scan.start({});
    await waitForScan(context.scan);
    const updated = context.films.detail(film.id)!;
    expect(updated.nfoTags.map((tag) => tag.name)).toEqual(['NFO Tag B']);
    expect(updated.customCategories.map((item) => item.name)).toEqual(['经典']);
  });

  it('supplements empty tags and force-imports tags without touching user categories, favorite, or NFO files', async () => {
    const context = createContext('<movie><title>Policy Movie</title><plot>Original plot</plot></movie>');
    context.scan.start({});
    await waitForScan(context.scan);
    const film = firstFilm(context);
    const category = context.films.createCategory('悬疑');
    context.films.updateCategories(film.id, [category.id]);
    context.films.updateFavorite(film.id, true);
    const originalNfo = fs.readFileSync(path.join(context.root, 'Policy Movie.nfo'), 'utf8');
    const mapped = mapNfoMetadata(parseNfo('<movie><title>Forced title</title><tag>Imported Tag</tag><genre>Ignored Genre</genre><plot>Imported plot</plot></movie>'), film.title);
    const supplemented = context.films.supplementFromMappedNfo(film.id, mapped, new Date().toISOString());
    expect(supplemented.nfoTags.map((tag) => tag.name)).toEqual(['Imported Tag']);
    expect(supplemented.plot).toBe('Original plot');
    const merged = context.films.forceImportNfo(film.id, { ...mapped, tags: ['Force Tag'] }, new Date().toISOString(), 'merge');
    expect(merged.nfoTags.map((tag) => tag.name)).toEqual(['Force Tag', 'Imported Tag']);
    const replaced = context.films.forceImportNfo(film.id, { ...mapped, tags: ['Replacement Tag'] }, new Date().toISOString(), 'replace');
    expect(replaced.nfoTags.map((tag) => tag.name)).toEqual(['Replacement Tag']);
    expect(replaced.customCategories.map((item) => item.name)).toEqual(['悬疑']);
    expect(replaced.favorite).toBe(true);
    expect(fs.readFileSync(path.join(context.root, 'Policy Movie.nfo'), 'utf8')).toBe(originalNfo);
  });
});
