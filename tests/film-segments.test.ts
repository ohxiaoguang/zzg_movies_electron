import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/main/database/DatabaseManager';
import { FilmRepository } from '../src/main/database/repositories/FilmRepository';
import {
  validateFilmSegmentCreate,
  validateFilmSegmentUpdate,
} from '../src/shared/filmSegmentValidation';

const roots: string[] = [];
const sourceId = '11111111-1111-4111-8111-111111111111';
const filmId = '22222222-2222-4222-8222-222222222222';
const partId = '33333333-3333-4333-8333-333333333333';
const secondPartId = '44444444-4444-4444-8444-444444444444';

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('film segments', () => {
  it('creates, updates and deletes part-bound annotations and detects source changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-segments-'));
    roots.push(root);
    const database = new DatabaseManager(path.join(root, 'library.db'));
    const now = new Date().toISOString();
    database.db.prepare(
      `INSERT INTO media_source (
         id, name, root_path, enabled, recursive, archived, created_at, updated_at, allow_original_preview
       ) VALUES (?, 'Test', ?, 1, 1, 0, ?, ?, 1)`,
    ).run(sourceId, root, now, now);
    database.db.prepare(
      `INSERT INTO film (
         id, source_id, relative_path, filename, file_size, title, country_json,
         director_json, actors_json, status, favorite, rating, notes, nfo_status,
         missing, archived, imported_at, updated_at
       ) VALUES (?, ?, 'movie.mp4', 'movie.mp4', 100, 'Movie', '[]', '[]', '[]',
                 'unorganized', 0, 0, '', 'missing', 0, 0, ?, ?)`,
    ).run(filmId, sourceId, now, now);
    database.db.prepare(
      `INSERT INTO film_file (
         id, film_id, source_id, relative_path, filename, part_type, part_number,
         is_primary, file_size, file_modified_at, missing, created_at, updated_at
       ) VALUES (?, ?, ?, 'movie.mp4', 'movie.mp4', 'single', 1, 1, 100, ?, 0, ?, ?)`,
    ).run(partId, filmId, sourceId, now, now, now);
    database.db.prepare(
      `UPDATE film_file
       SET relative_path = 'movie-cd1.mp4', filename = 'movie-cd1.mp4', part_type = 'cd'
       WHERE id = ?`,
    ).run(partId);
    database.db.prepare(
      `INSERT INTO film_file (
         id, film_id, source_id, relative_path, filename, part_type, part_number,
         is_primary, file_size, file_modified_at, missing, created_at, updated_at
       ) VALUES (?, ?, ?, 'movie-cd2.mp4', 'movie-cd2.mp4', 'cd', 2, 0, 200, ?, 0, ?, ?)`,
    ).run(secondPartId, filmId, sourceId, now, now, now);

    const films = new FilmRepository(database.db);
    const created = films.createSegment({
      filmId,
      filmFileId: partId,
      startSeconds: 10,
      endSeconds: 13,
      title: '精彩片段',
      comment: '测试批注',
    });
    expect(created).toMatchObject({
      filmId,
      filmFileId: partId,
      startSeconds: 10,
      endSeconds: 13,
      title: '精彩片段',
      comment: '测试批注',
      includeInPreview: true,
      sourceChanged: false,
    });
    expect(films.detail(filmId)).toMatchObject({
      highlightSegmentCount: 1,
      segments: [expect.objectContaining({ id: created.id })],
    });
    const finale = films.createSegment({
      filmId,
      filmFileId: secondPartId,
      startSeconds: 3720.5,
      endSeconds: 3785,
      title: '最终高潮',
    });
    const category = films.createCategory('已整理');
    films.updateCategories(filmId, [category.id]);
    expect(films.csvRows({ page: 1, pageSize: 20 })[0]?.highlights).toEqual([
      {
        fileName: 'movie-cd1.mp4',
        relativePath: 'movie-cd1.mp4',
        partLabel: 'CD 1',
        title: '精彩片段',
        startSeconds: 10,
        endSeconds: 13,
        timeRange: '00:00:10 → 00:00:13',
      },
      {
        fileName: 'movie-cd2.mp4',
        relativePath: 'movie-cd2.mp4',
        partLabel: 'CD 2',
        title: '最终高潮',
        startSeconds: 3720.5,
        endSeconds: 3785,
        timeRange: '01:02:00.5 → 01:03:05',
      },
    ]);

    const updated = films.updateSegment({
      id: created.id,
      endSeconds: 14.5,
      includeInPreview: false,
    });
    expect(updated).toMatchObject({ endSeconds: 14.5, includeInPreview: false });
    expect(films.detail(filmId)?.highlightSegmentCount).toBe(1);
    expect(films.csvRows({ page: 1, pageSize: 20 })[0]?.highlights.map((item) => item.title)).toEqual(['最终高潮']);

    database.db.prepare('UPDATE film_file SET file_size = 101 WHERE id = ?').run(partId);
    expect(films.segments(filmId)[0]?.sourceChanged).toBe(true);
    films.deleteSegment(created.id);
    films.deleteSegment(finale.id);
    expect(films.segments(filmId)).toEqual([]);
    database.close();
  });

  it('validates IDs, text and ordered finite ranges', () => {
    expect(validateFilmSegmentCreate({
      filmId,
      filmFileId: partId,
      startSeconds: 10.12345,
      endSeconds: 12.5,
      title: '  标题  ',
    })).toMatchObject({ startSeconds: 10.123, title: '标题' });
    expect(() => validateFilmSegmentCreate({
      filmId,
      filmFileId: partId,
      startSeconds: 20,
      endSeconds: 10,
    })).toThrow('INVALID_FILM_SEGMENT_RANGE');
    expect(() => validateFilmSegmentUpdate({ id: 'not-a-uuid', title: 'x' }))
      .toThrow('INVALID_FILM_SEGMENT');
  });
});
