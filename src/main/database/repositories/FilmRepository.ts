import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  FilmAssetDto,
  FilmDetailDto,
  FilmPageDto,
  FilmPageQuery,
  FilmSummaryDto,
  FilmUpdateInput,
  TagDto,
} from '../../../shared/contracts';
import type { AssetType, FilmStatus } from '../../../shared/enums';
import { isFilmStatus } from '../../../shared/validation';
import type { FilmCandidate } from '../../scanner/ScanCandidate';

interface FilmSummaryRow {
  id: string;
  source_id: string;
  source_name: string;
  relative_path: string;
  filename: string;
  title: string;
  original_title: string | null;
  year: number | null;
  status: FilmStatus;
  favorite: number;
  rating: number;
  missing: number;
  updated_at: string;
}

interface FilmRow extends FilmSummaryRow {
  sort_title: string | null;
  release_date: string | null;
  runtime_seconds: number | null;
  plot: string | null;
  outline: string | null;
  tagline: string | null;
  content_rating: string | null;
  studio: string | null;
  country_json: string;
  director_json: string;
  actors_json: string;
  notes: string;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  container_format: string | null;
  nfo_relative_path: string | null;
  nfo_status: string | null;
  nfo_error: string | null;
  archived: number;
  imported_at: string;
  last_seen_at: string | null;
}

interface AssetRow {
  id: string;
  film_id: string;
  asset_type: AssetType;
  relative_path: string;
  sort_order: number;
  file_size: number | null;
  file_modified_at: string | null;
  missing: number;
}

export interface ExistingFilmRow {
  id: string;
  relative_path: string;
  fingerprint: string | null;
}

export interface MediaLocation {
  rootPath: string;
  relativePath: string;
}

export class FilmRepository {
  public constructor(private readonly db: Database.Database) {}

  public page(query: FilmPageQuery): FilmPageDto {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize)));
    const { where, params } = this.buildWhere(query);
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM film f ${where}`).get(...params) as { count: number };
    const total = Number(totalRow.count);
    const orderBy = this.orderBy(query.sort);
    const rows = this.db
      .prepare(
        `SELECT f.id, f.source_id, s.name AS source_name, f.relative_path, f.filename,
                f.title, f.original_title, f.year, f.status, f.favorite, f.rating,
                f.missing, f.updated_at
         FROM film f
         JOIN media_source s ON s.id = f.source_id
         ${where}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, pageSize, (page - 1) * pageSize) as FilmSummaryRow[];
    const assetMap = this.assetsForFilms(rows.map((row) => row.id));
    return {
      items: rows.map((row) => this.toSummary(row, assetMap.get(row.id) ?? [])),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  public detail(id: string): FilmDetailDto | null {
    const row = this.db
      .prepare(
        `SELECT f.*, s.name AS source_name
         FROM film f JOIN media_source s ON s.id = f.source_id
         WHERE f.id = ?`,
      )
      .get(id) as (FilmRow & { source_name: string }) | undefined;
    if (!row) return null;
    const assets = (this.db.prepare('SELECT * FROM film_asset WHERE film_id = ? ORDER BY asset_type, sort_order, id').all(id) as AssetRow[]).map(
      (asset) => this.toAsset(asset),
    );
    const tags = this.db
      .prepare('SELECT t.name FROM tag t JOIN film_tag ft ON ft.tag_id = t.id WHERE ft.film_id = ? ORDER BY t.name COLLATE NOCASE')
      .all(id) as Array<{ name: string }>;
    const genres = this.db
      .prepare('SELECT g.name FROM genre g JOIN film_genre fg ON fg.genre_id = g.id WHERE fg.film_id = ? ORDER BY g.name COLLATE NOCASE')
      .all(id) as Array<{ name: string }>;
    const summary = this.toSummary(row, assets);
    return {
      ...summary,
      sortTitle: row.sort_title,
      releaseDate: row.release_date,
      runtimeSeconds: row.runtime_seconds,
      plot: row.plot,
      outline: row.outline,
      tagline: row.tagline,
      contentRating: row.content_rating,
      studio: row.studio,
      countries: jsonArray(row.country_json),
      directors: jsonArray(row.director_json),
      actors: jsonArray(row.actors_json),
      tags: tags.map((tag) => tag.name),
      genres: genres.map((genre) => genre.name),
      notes: row.notes,
      width: row.width,
      height: row.height,
      videoCodec: row.video_codec,
      audioCodec: row.audio_codec,
      containerFormat: row.container_format,
      nfoRelativePath: row.nfo_relative_path,
      nfoStatus: row.nfo_status,
      nfoError: row.nfo_error,
      archived: Boolean(row.archived),
      importedAt: row.imported_at,
      lastSeenAt: row.last_seen_at,
      assets,
    };
  }

  public update(input: FilmUpdateInput): FilmDetailDto {
    const existing = this.detail(input.id);
    if (!existing) throw new Error('FILM_NOT_FOUND');
    const fields: string[] = [];
    const values: unknown[] = [];
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new Error('TITLE_REQUIRED');
      fields.push('title = ?');
      values.push(title.slice(0, 500));
    }
    if (input.status !== undefined) {
      if (!isFilmStatus(input.status)) throw new Error('INVALID_STATUS');
      fields.push('status = ?');
      values.push(input.status);
    }
    if (input.favorite !== undefined) {
      fields.push('favorite = ?');
      values.push(input.favorite ? 1 : 0);
    }
    if (input.rating !== undefined) {
      if (!Number.isFinite(input.rating) || input.rating < 0 || input.rating > 10) throw new Error('INVALID_RATING');
      fields.push('rating = ?');
      values.push(input.rating);
    }
    if (input.notes !== undefined) {
      fields.push('notes = ?');
      values.push(input.notes.slice(0, 10_000));
    }
    this.db.transaction(() => {
      if (fields.length > 0) {
        fields.push('updated_at = ?');
        values.push(new Date().toISOString(), input.id);
        this.db.prepare(`UPDATE film SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }
      if (input.tags !== undefined) this.replaceTags(input.id, input.tags);
    })();
    return this.detail(input.id)!;
  }

  public listTags(): TagDto[] {
    return this.db
      .prepare(
        `SELECT t.id, t.name, COUNT(ft.film_id) AS film_count
         FROM tag t LEFT JOIN film_tag ft ON ft.tag_id = t.id
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
      )
      .all()
      .map((row) => {
        const typed = row as { id: string; name: string; film_count: number };
        return { id: typed.id, name: typed.name, filmCount: Number(typed.film_count) };
      });
  }

  public findByPath(sourceId: string, relativePath: string): ExistingFilmRow | null {
    return (this.db
      .prepare('SELECT id, relative_path, fingerprint FROM film WHERE source_id = ? AND relative_path = ?')
      .get(sourceId, relativePath) as ExistingFilmRow | undefined) ?? null;
  }

  public findByFingerprint(sourceId: string, fingerprint: string): ExistingFilmRow[] {
    return this.db
      .prepare('SELECT id, relative_path, fingerprint FROM film WHERE source_id = ? AND fingerprint = ?')
      .all(sourceId, fingerprint) as ExistingFilmRow[];
  }

  public assetLocation(assetId: string): MediaLocation | null {
    const row = this.db
      .prepare(
        `SELECT a.relative_path, s.root_path
         FROM film_asset a JOIN film f ON f.id = a.film_id JOIN media_source s ON s.id = f.source_id
         WHERE a.id = ? AND a.missing = 0 AND f.archived = 0`,
      )
      .get(assetId) as { relative_path: string; root_path: string } | undefined;
    return row ? { rootPath: row.root_path, relativePath: row.relative_path } : null;
  }

  public preferredAssetLocation(filmId: string, assetTypes: AssetType[]): MediaLocation | null {
    const placeholders = assetTypes.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT a.relative_path, s.root_path
         FROM film_asset a JOIN film f ON f.id = a.film_id JOIN media_source s ON s.id = f.source_id
         WHERE a.film_id = ? AND a.missing = 0 AND f.archived = 0 AND a.asset_type IN (${placeholders})
         ORDER BY CASE a.asset_type ${assetTypes.map((_, index) => `WHEN ? THEN ${index}`).join(' ')} ELSE 99 END,
                  a.sort_order ASC, a.id ASC LIMIT 1`,
      )
      .get(filmId, ...assetTypes, ...assetTypes) as { relative_path: string; root_path: string } | undefined;
    return row ? { rootPath: row.root_path, relativePath: row.relative_path } : null;
  }

  public filmLocation(filmId: string): MediaLocation | null {
    const row = this.db
      .prepare(
        `SELECT f.relative_path, s.root_path
         FROM film f JOIN media_source s ON s.id = f.source_id
         WHERE f.id = ? AND f.archived = 0`,
      )
      .get(filmId) as { relative_path: string; root_path: string } | undefined;
    return row ? { rootPath: row.root_path, relativePath: row.relative_path } : null;
  }

  public insertCandidate(candidate: FilmCandidate, now: string): string {
    const id = randomUUID();
    const fields = mappedCandidateValues(candidate);
    this.db
      .prepare(
        `INSERT INTO film (
          id, source_id, relative_path, filename, file_size, file_modified_at, fingerprint,
          title, original_title, sort_title, year, release_date, runtime_seconds, plot, outline,
          tagline, content_rating, studio, country_json, director_json, actors_json, status,
          favorite, rating, notes, width, height, video_codec, audio_codec, container_format,
          nfo_relative_path, nfo_modified_at, nfo_hash, nfo_status, nfo_error, missing, archived,
          imported_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)` ,
      )
      .run(
        id,
        candidate.sourceId,
        candidate.relativePath,
        candidate.filename,
        candidate.fileSize,
        candidate.fileModifiedAt,
        candidate.fingerprint,
        fields.title,
        fields.originalTitle,
        fields.sortTitle,
        fields.year,
        fields.releaseDate,
        fields.runtimeSeconds,
        fields.plot,
        fields.outline,
        fields.tagline,
        fields.contentRating,
        fields.studio,
        JSON.stringify(fields.countries),
        JSON.stringify(fields.directors),
        JSON.stringify(fields.actors),
        fields.status,
        fields.rating,
        fields.width,
        fields.height,
        fields.videoCodec,
        fields.audioCodec,
        fields.containerFormat,
        candidate.nfoRelativePath,
        candidate.nfoModifiedAt,
        candidate.nfoHash,
        candidate.nfoStatus,
        candidate.nfoError,
        now,
        now,
        now,
      );
    this.replaceGenres(id, fields.genres);
    this.replaceTags(id, fields.tags);
    this.replaceAssets(id, candidate);
    return id;
  }

  public updateFromCandidate(id: string, candidate: FilmCandidate, now: string): void {
    const fields = mappedCandidateValues(candidate);
    this.db
      .prepare(
        `UPDATE film SET
          relative_path = ?, filename = ?, file_size = ?, file_modified_at = ?, fingerprint = ?,
          original_title = ?, sort_title = ?, year = ?, release_date = ?, runtime_seconds = ?,
          plot = ?, outline = ?, tagline = ?, content_rating = ?, studio = ?, country_json = ?,
          director_json = ?, actors_json = ?, width = ?, height = ?, video_codec = ?, audio_codec = ?,
          container_format = ?, nfo_relative_path = ?, nfo_modified_at = ?, nfo_hash = ?,
          nfo_status = ?, nfo_error = ?, missing = 0, updated_at = ?, last_seen_at = ?
         WHERE id = ?`,
      )
      .run(
        candidate.relativePath,
        candidate.filename,
        candidate.fileSize,
        candidate.fileModifiedAt,
        candidate.fingerprint,
        fields.originalTitle,
        fields.sortTitle,
        fields.year,
        fields.releaseDate,
        fields.runtimeSeconds,
        fields.plot,
        fields.outline,
        fields.tagline,
        fields.contentRating,
        fields.studio,
        JSON.stringify(fields.countries),
        JSON.stringify(fields.directors),
        JSON.stringify(fields.actors),
        fields.width,
        fields.height,
        fields.videoCodec,
        fields.audioCodec,
        fields.containerFormat,
        candidate.nfoRelativePath,
        candidate.nfoModifiedAt,
        candidate.nfoHash,
        candidate.nfoStatus,
        candidate.nfoError,
        now,
        now,
        id,
      );
    this.replaceAssets(id, candidate);
  }

  public markSourceMissing(sourceId: string, now: string): number {
    const result = this.db.prepare('UPDATE film SET missing = 1, updated_at = ? WHERE source_id = ? AND archived = 0 AND missing = 0').run(now, sourceId);
    this.db
      .prepare('UPDATE film_asset SET missing = 1 WHERE film_id IN (SELECT id FROM film WHERE source_id = ? AND missing = 1)')
      .run(sourceId);
    return Number(result.changes);
  }

  public supplementFromMappedNfo(id: string, fields: Partial<ReturnType<typeof mappedCandidateValues>>, now: string): FilmDetailDto {
    const existing = this.detail(id);
    if (!existing) throw new Error('FILM_NOT_FOUND');
    const fillable: Array<[string, unknown]> = [
      ['original_title', existing.originalTitle ?? fields.originalTitle ?? null],
      ['sort_title', existing.sortTitle ?? fields.sortTitle ?? null],
      ['year', existing.year ?? fields.year ?? null],
      ['release_date', existing.releaseDate ?? fields.releaseDate ?? null],
      ['runtime_seconds', existing.runtimeSeconds ?? fields.runtimeSeconds ?? null],
      ['plot', existing.plot ?? fields.plot ?? null],
      ['outline', existing.outline ?? fields.outline ?? null],
      ['tagline', existing.tagline ?? fields.tagline ?? null],
      ['content_rating', existing.contentRating ?? fields.contentRating ?? null],
      ['studio', existing.studio ?? fields.studio ?? null],
      ['country_json', existing.countries.length ? JSON.stringify(existing.countries) : JSON.stringify(fields.countries ?? [])],
      ['director_json', existing.directors.length ? JSON.stringify(existing.directors) : JSON.stringify(fields.directors ?? [])],
      ['actors_json', existing.actors.length ? JSON.stringify(existing.actors) : JSON.stringify(fields.actors ?? [])],
      ['width', existing.width ?? fields.width ?? null],
      ['height', existing.height ?? fields.height ?? null],
      ['video_codec', existing.videoCodec ?? fields.videoCodec ?? null],
      ['audio_codec', existing.audioCodec ?? fields.audioCodec ?? null],
      ['container_format', existing.containerFormat ?? fields.containerFormat ?? null],
    ];
    const updates = fillable.filter(([, value]) => value !== null && value !== undefined);
    this.db.transaction(() => {
      if (updates.length) {
        this.db.prepare(`UPDATE film SET ${updates.map(([field]) => `${field} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
          ...updates.map(([, value]) => value),
          now,
          id,
        );
      }
      if (fields.tags?.length && existing.tags.length === 0) this.replaceTags(id, fields.tags);
      if (fields.genres?.length && existing.genres.length === 0) this.replaceGenres(id, fields.genres);
    })();
    return this.detail(id)!;
  }

  public forceImportNfo(id: string, fields: ReturnType<typeof mappedCandidateValues>, now: string): FilmDetailDto {
    const existing = this.detail(id);
    if (!existing) throw new Error('FILM_NOT_FOUND');
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE film SET title = ?, original_title = ?, sort_title = ?, year = ?, release_date = ?,
           runtime_seconds = ?, plot = ?, outline = ?, tagline = ?, content_rating = ?, studio = ?,
           country_json = ?, director_json = ?, actors_json = ?, status = ?, rating = ?, width = ?,
           height = ?, video_codec = ?, audio_codec = ?, container_format = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          fields.title,
          fields.originalTitle,
          fields.sortTitle,
          fields.year,
          fields.releaseDate,
          fields.runtimeSeconds,
          fields.plot,
          fields.outline,
          fields.tagline,
          fields.contentRating,
          fields.studio,
          JSON.stringify(fields.countries),
          JSON.stringify(fields.directors),
          JSON.stringify(fields.actors),
          fields.status,
          fields.rating,
          fields.width,
          fields.height,
          fields.videoCodec,
          fields.audioCodec,
          fields.containerFormat,
          now,
          id,
        );
      this.replaceTags(id, fields.tags);
      this.replaceGenres(id, fields.genres);
    })();
    return this.detail(id)!;
  }

  private replaceAssets(filmId: string, candidate: FilmCandidate): void {
    this.db.prepare('DELETE FROM film_asset WHERE film_id = ?').run(filmId);
    const insert = this.db.prepare(
      `INSERT INTO film_asset (id, film_id, asset_type, relative_path, sort_order, file_size, file_modified_at, missing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const asset of candidate.assets) {
      insert.run(
        randomUUID(),
        filmId,
        asset.assetType,
        asset.entry.relativePath,
        asset.sortOrder,
        asset.fileSize,
        asset.fileModifiedAt,
        asset.missing ? 1 : 0,
      );
    }
  }

  private replaceTags(filmId: string, names: string[]): void {
    this.db.prepare('DELETE FROM film_tag WHERE film_id = ?').run(filmId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO tag (id, name) VALUES (?, ?)');
    const link = this.db.prepare('INSERT OR IGNORE INTO film_tag (film_id, tag_id) VALUES (?, ?)');
    for (const name of uniqueNames(names)) {
      const existing = this.db.prepare('SELECT id FROM tag WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
      const tagId = existing?.id ?? randomUUID();
      if (!existing) insert.run(tagId, name);
      link.run(filmId, tagId);
    }
  }

  private replaceGenres(filmId: string, names: string[]): void {
    this.db.prepare('DELETE FROM film_genre WHERE film_id = ?').run(filmId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO genre (id, name) VALUES (?, ?)');
    const link = this.db.prepare('INSERT OR IGNORE INTO film_genre (film_id, genre_id) VALUES (?, ?)');
    for (const name of uniqueNames(names)) {
      const existing = this.db.prepare('SELECT id FROM genre WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
      const genreId = existing?.id ?? randomUUID();
      if (!existing) insert.run(genreId, name);
      link.run(filmId, genreId);
    }
  }

  private assetsForFilms(filmIds: string[]): Map<string, FilmAssetDto[]> {
    const result = new Map<string, FilmAssetDto[]>();
    if (!filmIds.length) return result;
    const placeholders = filmIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM film_asset WHERE film_id IN (${placeholders}) ORDER BY film_id, asset_type, sort_order, id`)
      .all(...filmIds) as AssetRow[];
    for (const row of rows) {
      const list = result.get(row.film_id) ?? [];
      list.push(this.toAsset(row));
      result.set(row.film_id, list);
    }
    return result;
  }

  private toSummary(row: FilmSummaryRow, assets: FilmAssetDto[]): FilmSummaryDto {
    const available = assets.filter((asset) => !asset.missing);
    const poster = available.find((asset) => asset.assetType === 'poster');
    const preview = available.find((asset) => asset.assetType === 'preview')
      ?? available.find((asset) => asset.assetType === 'trailer')
      ?? available.find((asset) => asset.assetType === 'sample');
    const images = available
      .filter((asset) => asset.assetType === 'fanart' || asset.assetType === 'extra_fanart' || asset.assetType === 'thumb')
      .sort((left, right) => assetImagePriority(left.assetType) - assetImagePriority(right.assetType) || left.sortOrder - right.sortOrder)
      .map((asset) => asset.id);
    return {
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      relativePath: row.relative_path,
      filename: row.filename,
      title: row.title,
      originalTitle: row.original_title,
      year: row.year,
      status: row.status,
      favorite: Boolean(row.favorite),
      rating: row.rating,
      missing: Boolean(row.missing),
      posterAssetId: poster?.id ?? null,
      previewAssetId: preview?.id ?? null,
      previewImageAssetIds: images,
      updatedAt: row.updated_at,
    };
  }

  private toAsset(row: AssetRow): FilmAssetDto {
    return {
      id: row.id,
      assetType: row.asset_type,
      relativePath: row.relative_path,
      sortOrder: row.sort_order,
      fileSize: row.file_size,
      fileModifiedAt: row.file_modified_at,
      missing: Boolean(row.missing),
    };
  }

  private buildWhere(query: FilmPageQuery): { where: string; params: unknown[] } {
    const clauses = ['f.archived = 0'];
    const params: unknown[] = [];
    if (query.search?.trim()) {
      const search = `%${escapeLike(query.search.trim())}%`;
      clauses.push("(f.title LIKE ? ESCAPE '\\' OR f.original_title LIKE ? ESCAPE '\\' OR f.filename LIKE ? ESCAPE '\\')");
      params.push(search, search, search);
    }
    if (query.sourceId) {
      clauses.push('f.source_id = ?');
      params.push(query.sourceId);
    }
    if (query.status && query.status !== 'all') {
      clauses.push('f.status = ?');
      params.push(query.status);
    }
    if (query.tag?.trim()) {
      clauses.push('EXISTS (SELECT 1 FROM film_tag qft JOIN tag qt ON qt.id = qft.tag_id WHERE qft.film_id = f.id AND qt.name = ? COLLATE NOCASE)');
      params.push(query.tag.trim());
    }
    if (query.genre?.trim()) {
      clauses.push('EXISTS (SELECT 1 FROM film_genre qfg JOIN genre qg ON qg.id = qfg.genre_id WHERE qfg.film_id = f.id AND qg.name = ? COLLATE NOCASE)');
      params.push(query.genre.trim());
    }
    if (query.minRating !== undefined && Number.isFinite(query.minRating)) {
      clauses.push('f.rating >= ?');
      params.push(Math.max(0, Math.min(10, query.minRating)));
    }
    if (query.favoriteOnly) clauses.push('f.favorite = 1');
    if (query.missingOnly) clauses.push('f.missing = 1');
    return { where: `WHERE ${clauses.join(' AND ')}`, params };
  }

  private orderBy(sort: FilmPageQuery['sort']): string {
    switch (sort) {
      case 'title':
        return 'COALESCE(f.sort_title, f.title) COLLATE NOCASE ASC, f.id ASC';
      case 'year':
        return 'f.year DESC NULLS LAST, COALESCE(f.sort_title, f.title) COLLATE NOCASE ASC';
      case 'rating':
        return 'f.rating DESC, COALESCE(f.sort_title, f.title) COLLATE NOCASE ASC';
      case 'file':
        return 'f.filename COLLATE NOCASE ASC, f.id ASC';
      default:
        return 'f.updated_at DESC, f.id ASC';
    }
  }
}

function assetImagePriority(assetType: AssetType): number {
  return assetType === 'fanart' ? 0 : assetType === 'extra_fanart' ? 1 : 2;
}

function mappedCandidateValues(candidate: FilmCandidate): Omit<FilmCandidate, 'sourceId' | 'sourceRootPath' | 'absolutePath' | 'relativePath' | 'filename' | 'fileSize' | 'fileModifiedAt' | 'fingerprint' | 'nfoRelativePath' | 'nfoModifiedAt' | 'nfoHash' | 'nfoStatus' | 'nfoError' | 'assets' | 'ambiguousAssets'> {
  return {
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    sortTitle: candidate.sortTitle,
    year: candidate.year,
    releaseDate: candidate.releaseDate,
    runtimeSeconds: candidate.runtimeSeconds,
    plot: candidate.plot,
    outline: candidate.outline,
    tagline: candidate.tagline,
    contentRating: candidate.contentRating,
    studio: candidate.studio,
    countries: candidate.countries,
    directors: candidate.directors,
    actors: candidate.actors,
    tags: candidate.tags,
    genres: candidate.genres,
    rating: candidate.rating,
    status: candidate.status,
    width: candidate.width,
    height: candidate.height,
    videoCodec: candidate.videoCodec,
    audioCodec: candidate.audioCodec,
    containerFormat: candidate.containerFormat,
  };
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function uniqueNames(names: string[]): string[] {
  const values = new Map<string, string>();
  for (const name of names) {
    const normalized = name.trim();
    if (normalized) values.set(normalized.toLocaleLowerCase(), normalized.slice(0, 200));
  }
  return [...values.values()];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
