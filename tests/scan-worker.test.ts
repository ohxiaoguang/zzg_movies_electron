import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { SettingsRepository } from '../src/main/database/repositories/SettingsRepository';
import { AppLogger } from '../src/main/system/AppLogger';
import { ScanCoordinator } from '../src/main/scanner/ScanCoordinator';
import { ScanWorkerClient } from '../src/main/scanner/ScanWorkerClient';
import { ScanCancellation } from '../src/main/scanner/ScanCancellation';
import { SourceScanner } from '../src/main/scanner/SourceScanner';
import { ScanSourceMerger } from '../src/main/scanner/ScanSourceMerger';
import { LibraryOperationCoordinator } from '../src/main/services/LibraryOperationCoordinator';

let workerRoot: string;
const roots: string[] = [];
const databases: DatabaseManager[] = [];
beforeAll(async () => {
  const parent = path.resolve('.vite'); fs.mkdirSync(parent, { recursive: true });
  workerRoot = fs.mkdtempSync(path.join(parent, 'scan-worker-test-'));
  await build({ configFile: false, logLevel: 'silent', build: { outDir: workerRoot, emptyOutDir: true,
    lib: { entry: path.resolve('src/main/scanner/scan-worker.ts'), formats: ['cjs'], fileName: () => 'scan-worker.cjs' },
    rollupOptions: { external: ['electron', 'better-sqlite3', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)] } } });
}, 30_000);
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  if (!workerRoot.startsWith(path.resolve('.vite') + path.sep)) throw new Error('Unexpected worker test directory');
  fs.rmSync(workerRoot, { recursive: true, force: true });
});
function fixture(count = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-worker-media-')); roots.push(root);
  const media = path.join(root, 'media'); fs.mkdirSync(media);
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(media, `Movie ${i}.mp4`), 'test media');
  const db = new DatabaseManager(path.join(root, 'library.db')); databases.push(db);
  const sources = new SourceRepository(db.db); const films = new FilmRepository(db.db); const settings = new SettingsRepository(db.db);
  const source = sources.create({ rootPath: media, name: 'Worker source' }); const logger = new AppLogger(path.join(root, 'logs'));
  const client = new ScanWorkerClient(path.join(workerRoot, 'scan-worker.cjs'), db.databasePath, db.operations, logger);
  const scan = new ScanCoordinator(db, sources, films, settings, logger, client);
  return { root, media, db, sources, films, settings, source, logger, client, scan };
}
async function finished(scan: ScanCoordinator) {
  for (let i = 0; i < 1500; i++) {
    if (scan.status()?.status !== 'running') return scan.status()!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Worker scan timeout');
}

describe('background scan and reports', () => {
  it('runs actual discovery and atomic database merging in a worker while the main loop stays responsive', async () => {
    const f = fixture(400);
    let ticks = 0; let mergingTicks = 0;
    const timer = setInterval(() => { ticks++; if (f.scan.status()?.phase === 'merging') mergingTicks++; }, 5);
    try {
      f.scan.start({}); const result = await finished(f.scan);
      expect(result).toMatchObject({ status: 'completed', created: 400, discovered: 400, processed: 400 });
      expect(ticks).toBeGreaterThan(5);
      expect(mergingTicks).toBeGreaterThan(0);
      expect(f.films.page({ page: 1, pageSize: 24 }).total).toBe(400);
    } finally { clearInterval(timer); }
  }, 20_000);

  it('persists exact NFO and ambiguous resource details, pagination and restart recovery', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.media, 'Movie 0.nfo'), '<movie><title>broken');
    fs.writeFileSync(path.join(f.media, 'poster.jpg'), 'generic cover');
    f.scan.start({}); const result = await finished(f.scan);
    expect(result).toMatchObject({ status: 'completed', nfoErrors: 1, ambiguousAssets: 2, issueCount: 3 });
    const nfo = f.scan.issues({ jobId: result.jobId, page: 1, pageSize: 20, type: 'nfo' });
    expect(nfo.total).toBe(1);
    expect(nfo.items[0]).toMatchObject({ filmTitle: 'Movie 0', relativePath: 'Movie 0.nfo', type: 'nfo' });
    expect(nfo.items[0].message).toContain('解析失败');
    const asset = f.scan.issues({ jobId: result.jobId, page: 2, pageSize: 1, type: 'asset' });
    expect(asset.total).toBe(2); expect(asset.items[0].relatedPaths).toEqual(['poster.jpg']);
    expect(f.scan.issueLocation(nfo.items[0].id)).toEqual({ rootPath: f.media, relativePath: 'Movie 0.nfo' });
    const reopened = new ScanCoordinator(f.db, f.sources, f.films, f.settings, f.logger);
    expect(reopened.status()?.jobId).toBe(result.jobId);
    expect(reopened.issues({ jobId: result.jobId, page: 1, pageSize: 20, search: 'Movie 0.nfo' }).total).toBe(1);
    expect(() => f.scan.issues({ jobId: '../invalid', page: 1, pageSize: 20 })).toThrow('INVALID_SCAN_ISSUES_QUERY');
  });

  it('cancels a worker before merge without changing existing records', async () => {
    const f = fixture();
    f.scan.start({}); await finished(f.scan);
    const original = f.db.operations.beginScanWrite.bind(f.db.operations);
    vi.spyOn(f.db.operations, 'beginScanWrite').mockImplementation(async () => {
      const release = await original(); f.scan.cancel(); return release;
    });
    fs.unlinkSync(path.join(f.media, 'Movie 0.mp4'));
    f.scan.start({});
    expect((await finished(f.scan)).status).toBe('cancelled');
    expect(f.films.page({ page: 1, pageSize: 20 }).total).toBe(2);
    expect(f.films.page({ page: 1, pageSize: 20 }).items.every((film) => !film.missing)).toBe(true);
  });

  it('rolls back worker merge failures and lists the failing file without losing user organization', async () => {
    const f = fixture(); f.scan.start({}); await finished(f.scan);
    const films = f.films.page({ page: 1, pageSize: 20, sort: 'file' }).items;
    f.films.updateFavorite(films[1].id, true);
    fs.unlinkSync(path.join(f.media, 'Movie 0.mp4'));
    f.db.db.exec(`CREATE TRIGGER fail_scan BEFORE UPDATE OF title ON film BEGIN SELECT RAISE(ABORT, 'constraint failed during scan test'); END`);
    f.scan.start({}); const result = await finished(f.scan);
    expect(result.status).toBe('database_failed');
    const issues = f.scan.issues({ jobId: result.jobId, type: 'database', page: 1, pageSize: 20 });
    expect(issues.total).toBe(1);
    expect(issues.items[0].relativePath).toBe('Movie 1.mp4');
    expect(issues.items[0].message).toContain('已回滚');
    expect(f.films.page({ page: 1, pageSize: 20 }).total).toBe(2);
    expect(f.films.detail(films[1].id)?.favorite).toBe(true);
    await f.db.operations.waitForScanWrite();
  });

  it('retains partial-file missing details even when the whole film remains playable', async () => {
    const f = fixture(0);
    fs.writeFileSync(path.join(f.media, 'Parts-cd1.mp4'), 'first');
    fs.writeFileSync(path.join(f.media, 'Parts-cd2.mp4'), 'second');
    f.scan.start({}); await finished(f.scan);
    fs.unlinkSync(path.join(f.media, 'Parts-cd2.mp4'));
    f.scan.start({}); const result = await finished(f.scan);
    expect(result.status).toBe('completed');
    const issues = f.scan.issues({ jobId: result.jobId, type: 'missing', page: 1, pageSize: 20 });
    expect(issues.items[0].relativePath).toBe('Parts-cd2.mp4');
    expect(issues.items[0].message).toContain('部分分段');
    expect(f.films.page({ page: 1, pageSize: 20 }).items[0].availability).toBe('partial_missing');
  });

  it('uses one path lookup per scan and rolls back every partial write when cancelled mid-merge', async () => {
    const f = fixture(12);
    const cancellation = new ScanCancellation();
    const result = await new SourceScanner(f.source, { settings: f.settings.get(), cancellation }).scan();
    const merger = new ScanSourceMerger(f.db, f.films, f.logger);
    const prepare = vi.spyOn(f.db.db, 'prepare');
    merger.merge(f.source, result.candidates);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('FROM film_file WHERE source_id = ? ORDER BY created_at'))).toHaveLength(0);
    const old = f.films.page({ page: 1, pageSize: 20 }).items.map((film) => film.id);
    const upsert = f.films.upsertCandidate.bind(f.films);
    let writes = 0;
    vi.spyOn(f.films, 'upsertCandidate').mockImplementation((candidate, at) => {
      const value = upsert(candidate, at); if (++writes === 3) cancellation.cancel(); return value;
    });
    expect(() => merger.merge(f.source, result.candidates.slice(0, 6), null, cancellation)).toThrow('SCAN_CANCELLED');
    expect(f.films.page({ page: 1, pageSize: 20 }).items.map((film) => film.id)).toEqual(old);
    expect(f.films.page({ page: 1, pageSize: 20 }).total).toBe(12);
  });

  it('does not let a stale worker release unlock a later scan', async () => {
    const operations = new LibraryOperationCoordinator();
    const older = await operations.beginScanWrite();
    const newer = await operations.beginScanWrite();
    let wrote = false;
    const pending = operations.runDatabaseAction(() => { wrote = true; });
    older(); await Promise.resolve();
    expect(wrote).toBe(false);
    newer(); await pending;
    expect(wrote).toBe(true);
  });

  it('queues database writes asynchronously and waits for earlier asynchronous actions before granting the worker lock', async () => {
    const operations = new LibraryOperationCoordinator();
    let finishAction!: () => void;
    const action = operations.runDatabaseAction(() => new Promise<void>((resolve) => { finishAction = resolve; }));
    let granted = false;
    const lock = operations.beginScanWrite().then((release) => { granted = true; return release; });
    let laterWrite = false;
    const later = operations.runDatabaseAction(() => { laterWrite = true; });
    await Promise.resolve(); expect(granted).toBe(false); expect(laterWrite).toBe(false);
    finishAction(); await action;
    const release = await lock; expect(granted).toBe(true); expect(laterWrite).toBe(false);
    release(); await later; expect(laterWrite).toBe(true);
  });
});
