import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import { SourceRepository } from '../src/main/database/repositories/SourceRepository';
import { DesktopPlaybackService } from '../src/main/services/DesktopPlaybackService';
import type { FilmPageQuery } from '../src/shared/contracts';

const roots: string[] = [];
const databases: DatabaseManager[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(count = 40) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-optimization-'));
  roots.push(root);
  const db = new DatabaseManager(path.join(root, 'library.db'));
  databases.push(db);
  const films = new FilmRepository(db.db);
  const sources = new SourceRepository(db.db);
  const source = sources.create({ rootPath: root, name: 'Online' });
  const offline = sources.create({ rootPath: path.join(root, 'offline'), name: 'Offline' });
  const removed = sources.create({ rootPath: path.join(root, 'removed'), name: 'Removed' });
  const category = films.createCategory('Shared');
  const secondCategory = films.createCategory('Second');
  const filmInsert = db.db.prepare(`INSERT INTO film (id, source_id, relative_path, filename, title, imported_at, updated_at,
    favorite, archived, missing, video_codec, audio_codec, actors_json, year, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fileInsert = db.db.prepare(`INSERT INTO film_file (id, film_id, source_id, relative_path, filename, is_primary, missing, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`);
  const categoryInsert = db.db.prepare('INSERT INTO film_custom_category (film_id, category_id, created_at) VALUES (?, ?, ?)');
  const assetInsert = db.db.prepare(`INSERT INTO film_asset (id, film_id, asset_type, relative_path) VALUES (?, ?, 'comment', ?)`);
  const ids: string[] = [];
  const parts: string[] = [];
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = randomUUID(); const partId = randomUUID();
      ids.push(id); parts.push(partId);
      const sourceId = i % 7 === 0 ? offline.id : i % 7 === 1 ? removed.id : source.id;
      const name = `Movie ${String(i).padStart(5, '0')}.${i % 2 ? 'mp4' : 'mkv'}`;
      const at = `2026-10-13T00:00:${String(i % 60).padStart(2, '0')}.000Z`;
      filmInsert.run(id, sourceId, name, name, name, at, at, i % 2, Number(i % 7 === 2), Number(i % 7 === 3), 'h264', 'aac', '["Shared Actor"]', 2000 + i % 4, i % 10);
      fileInsert.run(partId, id, sourceId, name, name, Number(i % 7 === 3), at, at);
      if (i % 7 === 4) fileInsert.run(randomUUID(), id, sourceId, `${name}.part`, `${name}.part`, 1, at, at);
      if (i % 2) categoryInsert.run(id, category.id, at);
      if (i % 3) categoryInsert.run(id, secondCategory.id, at);
      if (i % 2) assetInsert.run(randomUUID(), id, `${name}.jpg`);
    }
    db.db.prepare('UPDATE media_source SET deleted_at = ? WHERE id = ?').run('2026-10-13', removed.id);
  });
  return { root, db, films, source, offline, removed, category, secondCategory, ids, parts };
}

describe('SQL library pagination and source snapshots', () => {
  it('keeps filtering, totals and ordering identical across page boundaries', () => {
    const f = fixture();
    const queries: Partial<FilmPageQuery>[] = [
      {}, { allData: true }, { favoriteOnly: true }, { organizationState: 'organized' }, { organizationState: 'unorganized' },
      { categoryIds: [f.category.id, f.secondCategory.id], categoryMatch: 'all' },
      { sourceIds: [f.source.id, f.offline.id], actor: 'Shared Actor' },
      { playbackCompatibility: 'non-native' }, { commentImages: 'with' }, { commentImages: 'without' },
      { missingOnly: true }, { allData: true, availability: 'partial_missing' }, { availability: 'source_offline' },
      { allData: true, availability: 'source_removed' }, { allData: true, availability: 'archived' },
      { search: 'Movie 0001', minRating: 3 },
    ];
    for (const query of queries) {
      const full = f.films.page({ page: 1, pageSize: 200, sort: 'file', ...query });
      const ids: string[] = [];
      for (let page = 1; page <= Math.ceil(full.total / 3) + 1; page++) {
        const result = f.films.page({ page, pageSize: 3, sort: 'file', ...query });
        expect(result.total).toBe(full.total);
        expect(result.totalPages).toBe(Math.max(1, Math.ceil(full.total / 3)));
        ids.push(...result.items.map((film) => film.id));
      }
      expect(ids).toEqual(full.items.map((film) => film.id));
    }
    expect(f.films.page({ page: 1, pageSize: 2, playbackCompatibility: 'non-native' }).items.every((film) => film.filename.endsWith('.mkv'))).toBe(true);
  });

  it('orders and partitions every supported sort consistently', () => {
    const f = fixture();
    const sorts: FilmPageQuery['sort'][] = ['organized', 'favorite', 'played', 'recent', 'title', 'year', 'rating', 'file', 'size', 'added'];
    for (const sort of sorts) {
      const full = f.films.page({ page: 1, pageSize: 200, allData: true, sort });
      const ids: string[] = [];
      for (let page = 1; page <= Math.ceil(full.total / 7); page++) {
        ids.push(...f.films.page({ page, pageSize: 7, allData: true, sort }).items.map((film) => film.id));
      }
      expect(ids).toEqual(full.items.map((film) => film.id));
    }
  });

  it('paginates a 40,000-film library without building full-library resource queries', () => {
    const f = fixture(40_000);
    const assetSpy = vi.spyOn(f.films as unknown as { assetsForFilms(ids: string[]): unknown }, 'assetsForFilms');
    const result = f.films.page({ page: 100, pageSize: 24, allData: true, sort: 'added' });
    expect(result.total).toBe(40_000);
    expect(result.items).toHaveLength(24);
    expect(result.totalPages).toBe(1667);
    expect(assetSpy.mock.calls[0][0]).toHaveLength(24);
  });

  it('loads only page assets and checks each source once, with no stale status on the next request', () => {
    const f = fixture();
    // Keep all records under one source to measure I/O independently of filtering.
    f.db.db.prepare('UPDATE film SET source_id = ?').run(f.source.id);
    new FilmRepository(f.db.db); // Multiple repositories on one connection share the SQL snapshot.
    const assetSpy = vi.spyOn(f.films as unknown as { assetsForFilms(ids: string[]): unknown }, 'assetsForFilms');
    const statSpy = vi.spyOn(fs, 'statSync');
    const result = f.films.page({ page: 1, pageSize: 3, allData: true, availability: 'available' });
    expect(result.total).toBeGreaterThan(3);
    expect(assetSpy.mock.calls[0][0]).toHaveLength(3);
    expect(statSpy.mock.calls.filter(([name]) => name === f.root)).toHaveLength(1);
    statSpy.mockClear();
    f.db.db.prepare('UPDATE media_source SET root_path = ? WHERE id = ?').run(path.join(f.root, 'unplugged'), f.source.id);
    const offline = f.films.page({ page: 1, pageSize: 3, allData: true, availability: 'source_offline' });
    expect(offline.total).toBeGreaterThan(3);
    expect(offline.items.every((film) => film.availability === 'source_offline')).toBe(true);
    expect(statSpy.mock.calls.filter(([name]) => name === path.join(f.root, 'unplugged'))).toHaveLength(1);
    f.db.db.prepare('UPDATE media_source SET root_path = ? WHERE id = ?').run(f.root, f.source.id);
    expect(f.films.page({ page: 1, pageSize: 3, allData: true, availability: 'available' }).total).toBe(result.total);
  });

  it('saves desktop progress only for a valid owned file and exposes it after reopening', () => {
    const f = fixture();
    const service = new DesktopPlaybackService(f.films);
    const id = f.ids[5]; const partId = f.parts[5];
    expect(f.films.detail(id)?.playbackState).toBeNull();
    service.saveProgress({ filmId: id, partId, positionSeconds: 42.125, durationSeconds: 200 });
    expect(f.films.detail(id)?.playbackState).toMatchObject({ lastPartId: partId, positionSeconds: 42.125 });
    expect(() => service.saveProgress({ filmId: f.ids[6], partId, positionSeconds: 50 })).toThrow('INVALID_PART_ID');
    for (const value of [NaN, Infinity, -1, '12']) {
      expect(() => service.saveProgress({ filmId: id, partId, positionSeconds: value })).toThrow('INVALID_PLAYBACK_PROGRESS');
    }
    const databasePath = f.db.databasePath;
    f.db.close();
    const reopened = new DatabaseManager(databasePath); databases.push(reopened);
    expect(new FilmRepository(reopened.db).detail(id)?.playbackState).toMatchObject({ lastPartId: partId, positionSeconds: 42.125 });
  });
});
