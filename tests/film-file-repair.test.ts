import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmFileOwnershipRepairService } from '../src/main/database/FilmFileOwnershipRepairService';
import { FilmFileOwnershipConflictError, FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { ScanCoordinator } from '../src/main/scanner/ScanCoordinator';
import { AppLogger } from '../src/main/system/AppLogger';
import { assertUniqueIncomingPhysicalFiles, dedupeFilmCandidates, type FilmCandidate } from '../src/main/scanner/ScanCandidate';
import { normalizeRelativePath } from '../src/main/scanner/PartNaming';

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-repair-'));
  roots.push(root);
  for (const filename of ['Movie-cd1.mp4', 'Movie-cd2.mp4', 'Movie-cd3.mp4']) fs.writeFileSync(path.join(root, filename), filename);
  fs.writeFileSync(path.join(root, 'Movie.nfo'), '<movie><title>Repair Movie</title><genre>Genre A</genre></movie>');
  return root;
}

function createContext(root: string) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'film-library-repair-db-'));
  roots.push(dataRoot);
  const logger = new AppLogger(path.join(dataRoot, 'logs'));
  const database = new DatabaseManager(path.join(dataRoot, 'film-library.db'), logger);
  databases.push(database);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const source = sources.create({ name: 'Repair source', rootPath: root });
  const scan = new ScanCoordinator(database, sources, films, settings, logger);
  return { database, films, sources, source, scan };
}

async function waitForScan(scan: ScanCoordinator): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (scan.status()?.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('scan timeout');
}

function cloneFilmForFile(context: ReturnType<typeof createContext>, baseFilmId: string, fileId: string, title: string, notes: string, favorite: number): string {
  const columns = (context.database.db.prepare('PRAGMA table_info(film)').all() as Array<{ name: string }>).map((column) => column.name);
  const base = context.database.db.prepare('SELECT * FROM film WHERE id = ?').get(baseFilmId) as Record<string, unknown>;
  const file = context.database.db.prepare('SELECT * FROM film_file WHERE id = ?').get(fileId) as Record<string, unknown>;
  const id = randomUUID();
  const values = columns.map((column) => {
    if (column === 'id') return id;
    if (column === 'relative_path') return file.relative_path;
    if (column === 'filename') return file.filename;
    if (column === 'file_size') return file.file_size;
    if (column === 'file_modified_at') return file.file_modified_at;
    if (column === 'fingerprint') return file.fingerprint;
    if (column === 'title') return title;
    if (column === 'notes') return notes;
    if (column === 'favorite') return favorite;
    if (column === 'imported_at') return '2000-01-01T00:00:00.000Z';
    return base[column];
  });
  context.database.db.prepare(`INSERT INTO film (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
  context.database.db.prepare('UPDATE film_file SET film_id = ? WHERE id = ?').run(id, fileId);
  return id;
}

function candidate(logicalKey: string, files: Array<{ relativePath: string; filename: string; partType: 'single' | 'cd'; partNumber: number; isPrimary: boolean }>): FilmCandidate {
  return {
    sourceId: 'source-1', sourceRootPath: 'C:/library', absolutePath: `C:/library/${files[0]!.relativePath}`,
    relativePath: files[0]!.relativePath, filename: files[0]!.filename, fileSize: 1, fileModifiedAt: 'now', fingerprint: files[0]!.relativePath,
    nfoRelativePath: null, nfoModifiedAt: null, nfoHash: null, nfoStatus: 'missing', nfoError: null, assets: [], ambiguousAssets: 0,
    logicalKey, partBaseName: 'Movie', title: 'Movie', originalTitle: null, sortTitle: null, year: null, releaseDate: null,
    runtimeSeconds: null, plot: null, outline: null, tagline: null, contentRating: null, studio: null, countries: [], directors: [], actors: [],
    tags: [], rating: 0, width: null, height: null, videoCodec: null, audioCodec: null, containerFormat: null,
    files: files.map((file) => ({ absolutePath: `C:/library/${file.relativePath}`, ...file, fileSize: 1, fileModifiedAt: 'now', fingerprint: file.relativePath })),
  };
}

describe('film-file ownership repair', () => {
  it('deduplicates physical paths and prefers a CD group', () => {
    const single = candidate('single:.:movie', [{ relativePath: 'Movie-cd1.mp4', filename: 'Movie-cd1.mp4', partType: 'single', partNumber: 1, isPrimary: true }]);
    const grouped = candidate('parts:.:movie', [
      { relativePath: 'Movie-cd1.mp4', filename: 'Movie-cd1.mp4', partType: 'cd', partNumber: 1, isPrimary: true },
      { relativePath: 'Movie-cd2.mp4', filename: 'Movie-cd2.mp4', partType: 'cd', partNumber: 2, isPrimary: false },
    ]);
    const result = dedupeFilmCandidates('source-1', [single, grouped]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.logicalKey).toBe('parts:.:movie');
    expect(result.candidates[0]?.files).toHaveLength(2);
    expect(result.conflicts[0]?.reason).toBe('grouped-part-preferred');
    expect(() => assertUniqueIncomingPhysicalFiles('source-1', [single, single])).toThrow('INCOMING_FILM_FILE_DUPLICATES');
    expect(normalizeRelativePath('./A\\B\\..\\Movie.mp4')).toBe('a/movie.mp4');
    expect(() => normalizeRelativePath('../outside.mp4')).toThrow('INVALID_RELATIVE_PATH');
  });

  it('merges old CD1/CD2/CD3 film records, preserves unions and is idempotent', async () => {
    const context = createContext(makeRoot());
    context.scan.start({});
    await waitForScan(context.scan);
    const film = context.films.page({ page: 1, pageSize: 20 }).items[0]!;
    const files = context.database.db.prepare('SELECT id, filename FROM film_file WHERE film_id = ? ORDER BY part_number').all(film.id) as Array<{ id: string; filename: string }>;
    const tagId = randomUUID();
    context.database.db.prepare('INSERT INTO tag (id, name) VALUES (?, ?)').run(tagId, 'Repair Tag');
    context.database.db.prepare('INSERT INTO film_tag (film_id, tag_id) VALUES (?, ?)').run(film.id, tagId);
    context.films.update({ id: film.id, notes: 'survivor notes' });
    const secondId = cloneFilmForFile(context, film.id, files[1]!.id, 'CD2 user title', 'second notes', 1);
    cloneFilmForFile(context, film.id, files[2]!.id, 'CD3 user title', 'third notes', 0);
    const extraTagId = randomUUID();
    context.database.db.prepare('INSERT INTO tag (id, name) VALUES (?, ?)').run(extraTagId, 'Merged Tag');
    context.database.db.prepare('INSERT INTO film_tag (film_id, tag_id) VALUES (?, ?)').run(secondId, extraTagId);

    const service = new FilmFileOwnershipRepairService(context.database.db);
    const report = context.database.transaction(() => service.repairExisting());
    expect(report.mergedFilmGroups).toBe(1);
    expect(report.mergedFilms).toBe(2);
    expect(report.movedFilmFiles).toBe(2);
    expect(report.deletedEmptyFilms).toBe(2);
    expect(report.conflictCount).toBe(2);
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film').get()).toEqual({ count: 1 });
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film_file WHERE film_id = ?').get(film.id)).toEqual({ count: 3 });
    const repaired = context.films.detail(film.id)!;
    expect(repaired.favorite).toBe(true);
    expect(repaired.notes).toBe('survivor notes');
    expect(repaired.nfoTags.map((item) => item.name)).toEqual(['Merged Tag', 'Repair Tag']);
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film_merge_audit WHERE notes_conflict = 1').get()).toEqual({ count: 2 });
    const second = context.database.transaction(() => service.repairExisting());
    expect(second.mergedFilms).toBe(0);
    expect(context.database.db.prepare('SELECT COUNT(*) AS count FROM film').get()).toEqual({ count: 1 });
  });

  it('rolls back missing flags and reports a concrete database merge failure', async () => {
    const context = createContext(makeRoot());
    context.scan.start({});
    await waitForScan(context.scan);
    const failure = new FilmFileOwnershipConflictError({
      sourceId: context.source.id,
      relativePath: 'Movie-cd1.mp4',
      existingFilmId: 'existing-film',
      existingFilmTitle: 'Existing film',
      targetFilmId: 'target-film',
      targetFilmTitle: 'Target film',
      groupKey: 'parts::movie',
      sqlStage: 'film_file.insert',
      sqliteErrorCode: 'SQLITE_CONSTRAINT_UNIQUE',
    }, new Error('UNIQUE constraint failed: film_file.source_id, film_file.relative_path'));
    vi.spyOn(context.films, 'upsertCandidate').mockImplementation(() => { throw failure; });
    context.scan.start({});
    await waitForScan(context.scan);
    expect(context.scan.status()?.status).toBe('database_failed');
    expect(context.films.page({ page: 1, pageSize: 20, allData: true }).items.every((item) => !item.missing)).toBe(true);
    expect(context.database.db.prepare("SELECT error_type FROM scan_error ORDER BY created_at DESC LIMIT 1").get()).toEqual({ error_type: 'DATABASE_MERGE_FAILED' });
    expect(context.sources.findById(context.source.id)?.lastScanStatus).toBe('database_failed');
  });
});
