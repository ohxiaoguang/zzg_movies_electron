import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ActorDto,
  FilmAssetDto,
  CustomCategoryDto,
  FilmDetailDto,
  FilmImageDto,
  FilmPartDto,
  FilmPageDto,
  FilmPageQuery,
  FilmSummaryDto,
  FilmUpdateInput,
  TagDto,
} from '../../../shared/contracts';
import type { FilmCsvRow } from '../../export/FilmCsvExporter';
import type { AssetType } from '../../../shared/enums';
import type { FilmCandidate, FilmFileCandidate } from '../../scanner/ScanCandidate';
import { normalizeRelativePath, physicalFileKey } from '../../scanner/PartNaming';
import { FilmFileOwnershipRepairService } from '../FilmFileOwnershipRepairService';

interface FilmSummaryRow {
  id: string;
  source_id: string;
  source_name: string;
  relative_path: string;
  filename: string;
  title: string;
  original_title: string | null;
  year: number | null;
  favorite: number;
  rating: number;
  missing: number;
  updated_at: string;
  source_root_path: string;
  source_deleted_at: string | null;
  source_allow_original_preview: number;
  total_file_count: number;
  existing_file_count: number;
  missing_file_count: number;
  archived: number;
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

interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  film_count?: number;
  film_id?: string;
}

interface FilmFileRow {
  id: string;
  film_id: string;
  source_id: string;
  relative_path: string;
  filename: string;
  part_type: 'single' | 'cd' | 'disc';
  part_number: number;
  is_primary: number;
  file_size: number;
  file_modified_at: string | null;
  fingerprint: string | null;
  missing: number;
  created_at: string;
  updated_at: string;
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

export interface FilmFileConflictDetails {
  sourceId: string;
  relativePath: string;
  existingFilmId: string | null;
  existingFilmTitle: string | null;
  targetFilmId: string;
  targetFilmTitle: string | null;
  groupKey: string;
  sqlStage: string;
  sqliteErrorCode: string | null;
}

export class FilmFileOwnershipConflictError extends Error {
  public readonly details: FilmFileConflictDetails;

  public constructor(details: FilmFileConflictDetails, cause: unknown) {
    super('DATABASE_MERGE_FAILED', { cause });
    this.name = 'FilmFileOwnershipConflictError';
    this.details = details;
  }
}

export interface MediaLocation {
  rootPath: string;
  relativePath: string;
}

export type NfoForceImportMode = 'merge' | 'replace';

export class FilmRepository {
  public constructor(private readonly db: Database.Database) {}

  public page(query: FilmPageQuery): FilmPageDto {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize)));
    const { where, params } = this.buildWhere(query);
    const orderBy = this.orderBy(query.sort);
    const rows = this.db
      .prepare(
        `SELECT f.id, f.source_id, s.name AS source_name, f.relative_path, f.filename,
                f.title, f.original_title, f.year, f.favorite, f.rating,
                f.missing, f.archived, f.updated_at, s.root_path AS source_root_path,
                s.deleted_at AS source_deleted_at,
                s.allow_original_preview AS source_allow_original_preview,
                COUNT(ff.id) AS total_file_count,
                COALESCE(SUM(CASE WHEN ff.missing = 0 THEN 1 ELSE 0 END), 0) AS existing_file_count,
                COALESCE(SUM(CASE WHEN ff.missing = 1 THEN 1 ELSE 0 END), 0) AS missing_file_count
         FROM film f
         JOIN media_source s ON s.id = f.source_id
         LEFT JOIN film_file ff ON ff.film_id = f.id
         ${where}
         GROUP BY f.id
         ORDER BY ${orderBy}
         `,
      )
      .all(...params) as FilmSummaryRow[];
    const assetMap = this.assetsForFilms(rows.map((row) => row.id));
    const categoryMap = this.categoriesForFilms(rows.map((row) => row.id));
    const summaries = rows
      .map((row) => this.toSummary(row, assetMap.get(row.id) ?? [], categoryMap.get(row.id) ?? []))
      .filter((summary) => this.matchesAvailability(summary, query));
    const total = summaries.length;
    return {
      items: summaries.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  public navigationCounts(): import('../../../shared/contracts').FilmNavigationCountsDto {
    const row = this.db.prepare(
      `SELECT
         SUM(CASE WHEN f.archived = 0 AND s.deleted_at IS NULL AND EXISTS (SELECT 1 FROM film_file ff WHERE ff.film_id = f.id AND ff.missing = 0) THEN 1 ELSE 0 END) AS all_count,
         SUM(CASE WHEN f.archived = 0 AND s.deleted_at IS NULL AND EXISTS (SELECT 1 FROM film_file ff WHERE ff.film_id = f.id AND ff.missing = 0) AND NOT EXISTS (SELECT 1 FROM film_custom_category fcc WHERE fcc.film_id = f.id) THEN 1 ELSE 0 END) AS unorganized_count,
         SUM(CASE WHEN f.archived = 0 AND s.deleted_at IS NULL AND EXISTS (SELECT 1 FROM film_file ff WHERE ff.film_id = f.id AND ff.missing = 0) AND EXISTS (SELECT 1 FROM film_custom_category fcc WHERE fcc.film_id = f.id) THEN 1 ELSE 0 END) AS organized_count,
         SUM(CASE WHEN f.archived = 0 AND s.deleted_at IS NULL AND f.favorite = 1 AND EXISTS (SELECT 1 FROM film_file ff WHERE ff.film_id = f.id AND ff.missing = 0) THEN 1 ELSE 0 END) AS favorite_count,
         COUNT(*) AS all_data_count
       FROM film f JOIN media_source s ON s.id = f.source_id`,
    ).get() as { all_count: number | null; unorganized_count: number | null; organized_count: number | null; favorite_count: number | null; all_data_count: number };
    return { all: Number(row.all_count), unorganized: Number(row.unorganized_count), organized: Number(row.organized_count), favorite: Number(row.favorite_count), allData: Number(row.all_data_count) };
  }

  public listActors(): ActorDto[] {
    const rows = this.db.prepare(
      `SELECT actor.value AS name, COUNT(DISTINCT f.id) AS film_count
       FROM film f
       JOIN media_source s ON s.id = f.source_id
       JOIN json_each(f.actors_json) actor
       WHERE f.archived = 0
         AND s.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM film_file actor_ff WHERE actor_ff.film_id = f.id AND actor_ff.missing = 0)
         AND actor.type = 'text'
         AND TRIM(actor.value) <> ''
       GROUP BY actor.value COLLATE NOCASE
       ORDER BY actor.value COLLATE NOCASE`,
    ).all() as Array<{ name: string; film_count: number }>;
    return rows.map((row) => ({ name: row.name.trim(), filmCount: Number(row.film_count) }));
  }

  public csvRows(query: FilmPageQuery): FilmCsvRow[] {
    const exportQuery: FilmPageQuery = { ...query, organizationState: 'organized', allData: false, missingOnly: false };
    const { where, params } = this.buildWhere(exportQuery);
    const rows = this.db.prepare(
      `SELECT f.id, f.filename, f.title, f.actors_json, f.plot, f.outline
       FROM film f JOIN media_source s ON s.id = f.source_id
       ${where}
       AND EXISTS (SELECT 1 FROM film_file export_ff WHERE export_ff.film_id = f.id AND export_ff.missing = 0)
       ORDER BY ${this.orderBy(exportQuery.sort)}`,
    ).all(...params) as Array<{ id: string; filename: string; title: string; actors_json: string; plot: string | null; outline: string | null }>;
    const categoryMap = this.categoriesForFilms(rows.map((row) => row.id));
    return rows.map((row) => ({
      filename: row.filename,
      nfoTitle: row.title,
      customCategories: (categoryMap.get(row.id) ?? []).map((category) => category.name),
      actors: jsonArray(row.actors_json),
      nfoSummary: row.plot?.trim() || row.outline?.trim() || '',
    }));
  }

  public detail(id: string): FilmDetailDto | null {
    const row = this.db
      .prepare(
        `SELECT f.id, f.source_id, f.relative_path, f.filename, f.title, f.original_title, f.sort_title,
                f.year, f.release_date, f.runtime_seconds, f.plot, f.outline, f.tagline,
                f.content_rating, f.studio, f.country_json, f.director_json, f.actors_json,
                f.favorite, f.rating, f.notes, f.width, f.height, f.video_codec, f.audio_codec,
                f.container_format, f.nfo_relative_path, f.nfo_status, f.nfo_error, f.missing,
                f.archived, f.imported_at, f.updated_at, f.last_seen_at,
                s.name AS source_name, s.root_path AS source_root_path, s.deleted_at AS source_deleted_at,
                s.allow_original_preview AS source_allow_original_preview,
                COUNT(ff.id) AS total_file_count,
                COALESCE(SUM(CASE WHEN ff.missing = 0 THEN 1 ELSE 0 END), 0) AS existing_file_count,
                COALESCE(SUM(CASE WHEN ff.missing = 1 THEN 1 ELSE 0 END), 0) AS missing_file_count
         FROM film f JOIN media_source s ON s.id = f.source_id
         LEFT JOIN film_file ff ON ff.film_id = f.id
         WHERE f.id = ?`,
      )
      .get(id) as (FilmRow & { source_name: string }) | undefined;
    if (!row) return null;
    const assets = (this.db.prepare('SELECT * FROM film_asset WHERE film_id = ? ORDER BY asset_type, sort_order, id').all(id) as AssetRow[]).map(
      (asset) => this.toAsset(asset),
    );
    const tags = this.db
      .prepare(
        `SELECT t.id, t.name, COUNT(all_ft.film_id) AS film_count
         FROM tag t JOIN film_tag ft ON ft.tag_id = t.id
         LEFT JOIN film_tag all_ft ON all_ft.tag_id = t.id
         WHERE ft.film_id = ?
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
      )
      .all(id) as Array<{ id: string; name: string; film_count: number }>;
    const categories = this.categoriesForFilms([id]).get(id) ?? [];
    const summary = this.toSummary(row, assets, categories);
    const parts = this.partsForFilm(id);
    const images = assets
      .filter((asset): asset is FilmImageDto => ['poster', 'fanart', 'thumb', 'extra_fanart'].includes(asset.assetType) && !asset.missing)
      .sort((left, right) => imagePriority(left.assetType) - imagePriority(right.assetType) || left.sortOrder - right.sortOrder)
      .filter((asset, index, all) => all.findIndex((candidate) => candidate.relativePath.toLowerCase() === asset.relativePath.toLowerCase()) === index);
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
      nfoTags: tags.map((tag) => ({ id: tag.id, name: tag.name, filmCount: Number(tag.film_count) })),
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
      parts,
      images,
      availability: summary.availability,
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
      fields.push('title = ?', 'title_user_edited = 1');
      values.push(title.slice(0, 500));
    }
    if (input.originalTitle !== undefined) {
      fields.push('original_title = ?');
      values.push(input.originalTitle.trim().slice(0, 500) || null);
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
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(new Date().toISOString(), input.id);
      this.db.prepare(`UPDATE film SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.detail(input.id)!;
  }

  public updatePatch(input: FilmUpdateInput): FilmDetailDto {
    return this.update(input);
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

  public listCategories(): CustomCategoryDto[] {
    return (this.db.prepare(
      `SELECT c.id, c.name, c.sort_order, COUNT(fcc.film_id) AS film_count
       FROM custom_category c
       LEFT JOIN film_custom_category fcc ON fcc.category_id = c.id
       GROUP BY c.id
       ORDER BY c.sort_order, c.normalized_name, c.id`,
    ).all() as CategoryRow[]).map(toCategoryDto);
  }

  public createCategory(name: string): CustomCategoryDto {
    const normalized = normalizeCategoryName(name);
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const existing = this.categoryByNormalizedName(normalized.normalizedName);
      if (existing) throw new Error('CATEGORY_EXISTS');
      const row = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM custom_category').get() as { next_order: number };
      const id = randomUUID();
      this.db.prepare('INSERT INTO custom_category (id, name, normalized_name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, normalized.name, normalized.normalizedName, Number(row.next_order), now, now);
      return this.categoryById(id)!;
    })();
  }

  public renameCategory(id: string, name: string): CustomCategoryDto {
    const normalized = normalizeCategoryName(name);
    return this.db.transaction(() => {
      if (!this.categoryById(id)) throw new Error('CATEGORY_NOT_FOUND');
      const conflict = this.categoryByNormalizedName(normalized.normalizedName);
      if (conflict && conflict.id !== id) throw new Error('CATEGORY_EXISTS');
      this.db.prepare('UPDATE custom_category SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?')
        .run(normalized.name, normalized.normalizedName, new Date().toISOString(), id);
      return this.categoryById(id)!;
    })();
  }

  public removeCategory(id: string): void {
    this.db.transaction(() => {
      const result = this.db.prepare('DELETE FROM custom_category WHERE id = ?').run(id);
      if (!result.changes) throw new Error('CATEGORY_NOT_FOUND');
    })();
  }

  public reorderCategories(ids: string[]): CustomCategoryDto[] {
    const uniqueIds = [...new Set(ids)];
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM custom_category ORDER BY sort_order, normalized_name, id').all() as Array<{ id: string }>;
      if (uniqueIds.length !== existing.length || uniqueIds.some((id) => !existing.some((row) => row.id === id))) throw new Error('INVALID_CATEGORY_ORDER');
      const update = this.db.prepare('UPDATE custom_category SET sort_order = ?, updated_at = ? WHERE id = ?');
      const now = new Date().toISOString();
      uniqueIds.forEach((id, index) => update.run(index, now, id));
      return this.listCategories();
    })();
  }

  public updateFavorite(id: string, favorite: boolean): FilmDetailDto {
    const result = this.db.prepare('UPDATE film SET favorite = ?, updated_at = ? WHERE id = ?').run(favorite ? 1 : 0, new Date().toISOString(), id);
    if (!result.changes) throw new Error('FILM_NOT_FOUND');
    return this.detail(id)!;
  }

  public updateCategories(id: string, categoryIds: string[], newCategoryNames: string[] = []): FilmDetailDto {
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM film WHERE id = ?').get(id)) throw new Error('FILM_NOT_FOUND');
      const ids = new Set<string>();
      for (const categoryId of categoryIds) {
        if (!this.categoryById(categoryId)) throw new Error('CATEGORY_NOT_FOUND');
        ids.add(categoryId);
      }
      for (const rawName of newCategoryNames) {
        const normalized = normalizeCategoryName(rawName);
        const existing = this.categoryByNormalizedName(normalized.normalizedName);
        if (existing) ids.add(existing.id);
        else ids.add(this.createCategory(normalized.name).id);
      }
      this.db.prepare('DELETE FROM film_custom_category WHERE film_id = ?').run(id);
      const insert = this.db.prepare('INSERT INTO film_custom_category (film_id, category_id, created_at) VALUES (?, ?, ?)');
      const now = new Date().toISOString();
      for (const categoryId of ids) insert.run(id, categoryId, now);
      this.db.prepare('UPDATE film SET updated_at = ? WHERE id = ?').run(now, id);
      return this.detail(id)!;
    })();
  }

  public deleteRecords(ids: string[]): void {
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) return;
    this.db.transaction(() => {
      const placeholders = uniqueIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM film WHERE id IN (${placeholders})`).run(...uniqueIds);
      this.db.prepare('DELETE FROM tag WHERE NOT EXISTS (SELECT 1 FROM film_tag WHERE film_tag.tag_id = tag.id)').run();
    })();
  }

  public findByPath(sourceId: string, relativePath: string): ExistingFilmRow | null {
    const normalized = normalizeRelativePath(relativePath);
    const rows = this.db
      .prepare('SELECT film_id AS id, relative_path, fingerprint FROM film_file WHERE source_id = ? ORDER BY created_at, id')
      .all(sourceId) as ExistingFilmRow[];
    return rows.find((row) => normalizeRelativePath(row.relative_path) === normalized) ?? null;
  }

  public parts(filmId: string): FilmPartDto[] { return this.partsForFilm(filmId); }

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

  public previewLocation(filmId: string): MediaLocation | null {
    const dedicated = this.preferredAssetLocation(filmId, ['preview', 'trailer', 'sample']);
    if (dedicated) return dedicated;
    const row = this.db
      .prepare(
        `SELECT ff.relative_path, s.root_path
         FROM film_file ff
         JOIN film f ON f.id = ff.film_id
         JOIN media_source s ON s.id = ff.source_id
         WHERE ff.film_id = ?
           AND ff.is_primary = 1
           AND ff.missing = 0
           AND f.archived = 0
           AND s.deleted_at IS NULL
           AND s.allow_original_preview = 1`,
      )
      .get(filmId) as { relative_path: string; root_path: string } | undefined;
    return row ? { rootPath: row.root_path, relativePath: row.relative_path } : null;
  }

  public filmLocation(filmId: string): MediaLocation | null {
    const row = this.db
      .prepare(
        `SELECT ff.relative_path, s.root_path
         FROM film_file ff JOIN film f ON f.id = ff.film_id JOIN media_source s ON s.id = ff.source_id
         WHERE ff.film_id = ? AND ff.is_primary = 1 AND ff.missing = 0 AND f.archived = 0`,
      )
      .get(filmId) as { relative_path: string; root_path: string } | undefined;
    return row ? { rootPath: row.root_path, relativePath: row.relative_path } : null;
  }

  public upsertCandidate(candidate: FilmCandidate, now: string): { id: string; created: boolean; moved: boolean; merged: number } {
    const existingIds = this.findCandidateFilmIds(candidate);
    const newFilmId = randomUUID();
    if (!existingIds.length) {
      try {
        return { id: this.insertCandidate(candidate, now, newFilmId), created: true, moved: false, merged: 0 };
      } catch (error) {
        throw this.asOwnershipConflict(error, candidate, newFilmId, 'film_file.insert');
      }
    }

    const existingPrimaryPath = this.findByPath(candidate.sourceId, candidate.relativePath);
    const repair = new FilmFileOwnershipRepairService(this.db);
    const survivor = repair.chooseSurvivor(existingIds);
    let merged = 0;
    try {
      for (const filmId of existingIds) {
        if (filmId === survivor) continue;
        repair.mergeFilms(survivor, filmId, now, candidate.logicalKey);
        merged += 1;
      }
      this.updateFromCandidate(survivor, candidate, now);
    } catch (error) {
      throw this.asOwnershipConflict(error, candidate, survivor, 'film_file.upsert');
    }
    const moved = merged > 0 || !existingPrimaryPath || existingPrimaryPath.id !== survivor;
    return { id: survivor, created: false, moved, merged };
  }

  public partLocation(partId: string): MediaLocation | null {
    const row = this.db
      .prepare(
        `SELECT ff.relative_path, s.root_path
         FROM film_file ff JOIN film f ON f.id = ff.film_id JOIN media_source s ON s.id = ff.source_id
         WHERE ff.id = ? AND ff.missing = 0 AND f.archived = 0`,
      )
      .get(partId) as { relative_path: string; root_path: string } | undefined;
    return row ? { rootPath: row.root_path, relativePath: row.relative_path } : null;
  }

  public insertCandidate(candidate: FilmCandidate, now: string, id = randomUUID()): string {
    const fields = mappedCandidateValues(candidate);
    this.db
      .prepare(
        `INSERT INTO film (
          id, source_id, relative_path, filename, file_size, file_modified_at, fingerprint,
          title, original_title, sort_title, year, release_date, runtime_seconds, plot, outline,
          tagline, content_rating, studio, country_json, director_json, actors_json,
          favorite, rating, notes, width, height, video_codec, audio_codec, container_format,
          nfo_relative_path, nfo_modified_at, nfo_hash, nfo_status, nfo_error, missing, archived,
          imported_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)` ,
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
    this.replaceTags(id, fields.tags);
    this.syncFiles(id, candidate.sourceId, candidate.files, now);
    this.replaceAssets(id, candidate);
    return id;
  }

  public filmLabel(id: string | null): { id: string; title: string } | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT id, title FROM film WHERE id = ?').get(id) as { id: string; title: string } | undefined;
    return row ?? null;
  }

  private asOwnershipConflict(error: unknown, candidate: FilmCandidate, targetFilmId: string, sqlStage: string): FilmFileOwnershipConflictError | Error {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('unique constraint') && !message.toLowerCase().includes('constraint failed')) return error instanceof Error ? error : new Error(message);
    const existing = this.findByPath(candidate.sourceId, candidate.relativePath);
    const sqliteErrorCode = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code ?? '') || null : null;
    return new FilmFileOwnershipConflictError({
      sourceId: candidate.sourceId,
      relativePath: candidate.relativePath,
      existingFilmId: existing?.id ?? null,
      existingFilmTitle: this.filmLabel(existing?.id ?? null)?.title ?? null,
      targetFilmId,
      targetFilmTitle: this.filmLabel(targetFilmId)?.title ?? candidate.title,
      groupKey: candidate.logicalKey,
      sqlStage,
      sqliteErrorCode,
    }, error);
  }

  private findCandidateFilmIds(candidate: FilmCandidate): string[] {
    const pathKeys = new Set(candidate.files.map((file) => physicalFileKey(candidate.sourceId, file.relativePath)));
    const rows = this.db.prepare('SELECT film_id, source_id, relative_path FROM film_file WHERE source_id = ?').all(candidate.sourceId) as Array<{ film_id: string; source_id: string; relative_path: string }>;
    const ids = new Set<string>();
    for (const row of rows) {
      if (pathKeys.has(physicalFileKey(row.source_id, row.relative_path))) ids.add(row.film_id);
    }
    const legacyRows = this.db.prepare('SELECT id, source_id, relative_path FROM film WHERE source_id = ?').all(candidate.sourceId) as Array<{ id: string; source_id: string; relative_path: string }>;
    for (const row of legacyRows) {
      if (pathKeys.has(physicalFileKey(row.source_id, row.relative_path))) ids.add(row.id);
    }
    return [...ids].sort();
  }

  public updateFromCandidate(id: string, candidate: FilmCandidate, now: string): void {
    const fields = mappedCandidateValues(candidate);
    const editFlags = this.userEditFlags(id);
    const scanContentChanged = this.scanContentChanged(id, candidate);
    this.db
      .prepare(
        `UPDATE film SET
          relative_path = ?, filename = ?, file_size = ?, file_modified_at = ?, fingerprint = ?,
          title = CASE WHEN title_user_edited = 0 THEN ? ELSE title END,
          original_title = ?, sort_title = ?, year = ?, release_date = ?, runtime_seconds = ?,
          plot = ?, outline = ?, tagline = ?, content_rating = ?, studio = ?, country_json = ?,
          director_json = ?, actors_json = ?, width = ?, height = ?, video_codec = ?, audio_codec = ?,
          container_format = ?, nfo_relative_path = ?, nfo_modified_at = ?, nfo_hash = ?,
          nfo_status = ?, nfo_error = ?, missing = 0,
          updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END, last_seen_at = ?
         WHERE id = ?`,
      )
      .run(
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
        scanContentChanged ? 1 : 0,
        now,
        now,
        id,
      );
    if (!editFlags.tagsUserEdited) this.replaceTags(id, fields.tags);
    this.replaceAssets(id, candidate);
    this.syncFiles(id, candidate.sourceId, candidate.files, now);
    this.syncLegacyMissing(id);
  }

  public markSourceMissing(sourceId: string, now: string): number {
    const result = this.db.prepare('UPDATE film SET missing = 1 WHERE source_id = ? AND archived = 0 AND missing = 0').run(sourceId);
    this.db.prepare('UPDATE film_file SET missing = 1, updated_at = ? WHERE source_id = ?').run(now, sourceId);
    this.db.prepare('UPDATE film_asset SET missing = 1 WHERE film_id IN (SELECT id FROM film WHERE source_id = ?)').run(sourceId);
    return Number(result.changes);
  }

  public markDirectoryMissing(sourceId: string, relativeDirectory: string, now: string): number {
    const scope = normalizedRelativePath(relativeDirectory);
    const rows = this.db.prepare('SELECT DISTINCT film_id, relative_path FROM film_file WHERE source_id = ?').all(sourceId) as Array<{ film_id: string; relative_path: string }>;
    const filmIds = [...new Set(rows.filter((row) => isRelativePathInDirectory(row.relative_path, scope)).map((row) => row.film_id))];
    let changed = 0;
    const markFilm = this.db.prepare('UPDATE film SET missing = 1 WHERE id = ? AND archived = 0 AND missing = 0');
    const markFiles = this.db.prepare('UPDATE film_file SET missing = 1, updated_at = ? WHERE film_id = ?');
    const markAssets = this.db.prepare('UPDATE film_asset SET missing = 1 WHERE film_id = ?');
    for (const filmId of filmIds) {
      changed += Number(markFilm.run(filmId).changes);
      markFiles.run(now, filmId);
      markAssets.run(filmId);
    }
    return changed;
  }

  public supplementFromMappedNfo(id: string, fields: Partial<ReturnType<typeof mappedCandidateValues>>, now: string): FilmDetailDto {
    const existing = this.detail(id);
    if (!existing) throw new Error('FILM_NOT_FOUND');
    const editFlags = this.userEditFlags(id);
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
      if (fields.tags?.length && existing.nfoTags.length === 0 && !editFlags.tagsUserEdited) this.replaceTags(id, fields.tags);
    })();
    return this.detail(id)!;
  }

  public forceImportNfo(id: string, fields: ReturnType<typeof mappedCandidateValues>, now: string, mode: NfoForceImportMode = 'replace'): FilmDetailDto {
    const existing = this.detail(id);
    if (!existing) throw new Error('FILM_NOT_FOUND');
    const editFlags = this.userEditFlags(id);
    const merged = mode === 'merge';
    const tags = merged
      ? uniqueNames([...existing.nfoTags.map((tag) => tag.name), ...fields.tags])
      : fields.tags;
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE film SET title = ?, original_title = ?, sort_title = ?, year = ?, release_date = ?,
           runtime_seconds = ?, plot = ?, outline = ?, tagline = ?, content_rating = ?, studio = ?,
           country_json = ?, director_json = ?, actors_json = ?, rating = ?, width = ?,
           height = ?, video_codec = ?, audio_codec = ?, container_format = ?, tags_user_edited = ?,
           updated_at = ? WHERE id = ?`,
        )
        .run(
          merged ? firstNonEmpty(existing.title, fields.title) : fields.title,
          merged ? firstNonEmpty(existing.originalTitle, fields.originalTitle) : fields.originalTitle,
          merged ? firstNonEmpty(existing.sortTitle, fields.sortTitle) : fields.sortTitle,
          merged ? existing.year ?? fields.year : fields.year,
          merged ? firstNonEmpty(existing.releaseDate, fields.releaseDate) : fields.releaseDate,
          merged ? existing.runtimeSeconds ?? fields.runtimeSeconds : fields.runtimeSeconds,
          merged ? firstNonEmpty(existing.plot, fields.plot) : fields.plot,
          merged ? firstNonEmpty(existing.outline, fields.outline) : fields.outline,
          merged ? firstNonEmpty(existing.tagline, fields.tagline) : fields.tagline,
          merged ? firstNonEmpty(existing.contentRating, fields.contentRating) : fields.contentRating,
          merged ? firstNonEmpty(existing.studio, fields.studio) : fields.studio,
          JSON.stringify(merged ? uniqueNames([...existing.countries, ...fields.countries]) : fields.countries),
          JSON.stringify(merged ? uniqueNames([...existing.directors, ...fields.directors]) : fields.directors),
          JSON.stringify(merged ? uniqueNames([...existing.actors, ...fields.actors]) : fields.actors),
          merged && fields.rating <= 0 ? existing.rating : fields.rating,
          merged ? existing.width ?? fields.width : fields.width,
          merged ? existing.height ?? fields.height : fields.height,
          merged ? firstNonEmpty(existing.videoCodec, fields.videoCodec) : fields.videoCodec,
          merged ? firstNonEmpty(existing.audioCodec, fields.audioCodec) : fields.audioCodec,
          merged ? firstNonEmpty(existing.containerFormat, fields.containerFormat) : fields.containerFormat,
          merged && editFlags.tagsUserEdited ? 1 : 0,
          now,
          id,
        );
      this.replaceTags(id, tags);
    })();
    return this.detail(id)!;
  }

  private userEditFlags(id: string): { tagsUserEdited: boolean } {
    const row = this.db.prepare('SELECT tags_user_edited FROM film WHERE id = ?').get(id) as { tags_user_edited: number } | undefined;
    return {
      tagsUserEdited: Boolean(row?.tags_user_edited),
    };
  }

  private scanContentChanged(id: string, candidate: FilmCandidate): boolean {
    const row = this.db.prepare(
      `SELECT relative_path, filename, file_size, file_modified_at, fingerprint,
              nfo_relative_path, nfo_modified_at, nfo_hash, nfo_status, nfo_error
       FROM film WHERE id = ?`,
    ).get(id) as {
      relative_path: string;
      filename: string;
      file_size: number;
      file_modified_at: string | null;
      fingerprint: string | null;
      nfo_relative_path: string | null;
      nfo_modified_at: string | null;
      nfo_hash: string | null;
      nfo_status: string;
      nfo_error: string | null;
    } | undefined;
    if (!row) return true;
    return row.relative_path !== candidate.relativePath
      || row.filename !== candidate.filename
      || Number(row.file_size) !== candidate.fileSize
      || row.file_modified_at !== candidate.fileModifiedAt
      || row.fingerprint !== candidate.fingerprint
      || row.nfo_relative_path !== candidate.nfoRelativePath
      || row.nfo_modified_at !== candidate.nfoModifiedAt
      || row.nfo_hash !== candidate.nfoHash
      || row.nfo_status !== candidate.nfoStatus
      || row.nfo_error !== candidate.nfoError;
  }

  private partsForFilm(filmId: string): FilmPartDto[] {
    const rows = this.db
      .prepare('SELECT id, part_type, part_number, filename, relative_path, file_size, file_modified_at, missing FROM film_file WHERE film_id = ? ORDER BY part_number ASC, filename COLLATE NOCASE ASC')
      .all(filmId) as Array<Pick<FilmFileRow, 'id' | 'part_type' | 'part_number' | 'filename' | 'relative_path' | 'file_size' | 'file_modified_at' | 'missing'>>;
    return rows.map((row) => ({
      id: row.id,
      partType: row.part_type,
      partNumber: row.part_number,
      filename: row.filename,
      relativePath: row.relative_path,
      fileSize: row.file_size,
      fileModifiedAt: row.file_modified_at,
      missing: Boolean(row.missing),
    }));
  }

  private syncFiles(filmId: string, sourceId: string, candidates: FilmFileCandidate[], now: string): void {
    const existing = this.db.prepare('SELECT * FROM film_file WHERE film_id = ? ORDER BY created_at, id').all(filmId) as FilmFileRow[];
    const touched = new Set<string>();
    const candidateKeys = new Set(candidates.map((candidate) => physicalFileKey(sourceId, candidate.relativePath)));
    const repair = new FilmFileOwnershipRepairService(this.db);
    const insert = this.db.prepare(
      `INSERT INTO film_file
       (id, film_id, source_id, relative_path, filename, part_type, part_number, is_primary,
        file_size, file_modified_at, fingerprint, missing, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    const update = this.db.prepare(
      `UPDATE film_file SET source_id = ?, relative_path = ?, filename = ?, part_type = ?, part_number = ?,
       is_primary = ?, file_size = ?, file_modified_at = ?, fingerprint = ?, missing = 0, updated_at = ?
       WHERE id = ?`,
    );
    const sourceRows = (): FilmFileRow[] => this.db.prepare('SELECT * FROM film_file WHERE source_id = ? ORDER BY created_at, id').all(sourceId) as FilmFileRow[];
    const findCurrentRow = (file: FilmFileCandidate): FilmFileRow | undefined => {
      const rows = sourceRows();
      const key = physicalFileKey(sourceId, file.relativePath);
      const byPath = rows.find((row) => physicalFileKey(row.source_id, row.relative_path) === key);
      if (byPath) return byPath;
      return undefined;
    };

    for (const candidate of candidates) {
      if (candidate.isPrimary) this.db.prepare('UPDATE film_file SET is_primary = 0 WHERE film_id = ?').run(filmId);
      let row = findCurrentRow(candidate);
      if (row && row.film_id !== filmId) {
        repair.mergeFilms(filmId, row.film_id, now, `scan:${physicalFileKey(sourceId, candidate.relativePath)}`);
        row = findCurrentRow(candidate);
      }
      if (row) {
        update.run(
          sourceId, candidate.relativePath, candidate.filename, candidate.partType, candidate.partNumber,
          candidate.isPrimary ? 1 : 0, candidate.fileSize, candidate.fileModifiedAt, candidate.fingerprint, now, row.id,
        );
        touched.add(row.id);
      } else {
        const id = randomUUID();
        insert.run(
          id, filmId, sourceId, candidate.relativePath, candidate.filename, candidate.partType,
          candidate.partNumber, candidate.isPrimary ? 1 : 0, candidate.fileSize, candidate.fileModifiedAt,
          candidate.fingerprint, now, now,
        );
        touched.add(id);
      }
    }
    const markMissing = this.db.prepare('UPDATE film_file SET missing = 1, updated_at = ? WHERE film_id = ? AND id = ?');
    for (const row of existing) if (!touched.has(row.id) && !candidateKeys.has(physicalFileKey(sourceId, row.relative_path))) markMissing.run(now, filmId, row.id);
    this.syncLegacyMissing(filmId);
  }

  private syncLegacyMissing(filmId: string): void {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN missing = 0 THEN 1 ELSE 0 END), 0) AS existing FROM film_file WHERE film_id = ?')
      .get(filmId) as { total: number; existing: number };
    this.db.prepare('UPDATE film SET missing = ? WHERE id = ?').run(Number(row.existing) === 0 ? 1 : 0, filmId);
  }

  private replaceAssets(filmId: string, candidate: FilmCandidate): void {
    const existing = this.db.prepare('SELECT * FROM film_asset WHERE film_id = ?').all(filmId) as AssetRow[];
    const byKey = new Map(existing.map((asset) => [`${asset.asset_type}:${asset.relative_path.toLowerCase()}`, asset]));
    const touched = new Set<string>();
    const insert = this.db.prepare(
      `INSERT INTO film_asset (id, film_id, asset_type, relative_path, sort_order, file_size, file_modified_at, missing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seen = new Set<string>();
    for (const asset of candidate.assets) {
      const key = `${asset.assetType}:${asset.entry.relativePath.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = byKey.get(key);
      if (previous) {
        this.db.prepare('UPDATE film_asset SET sort_order = ?, file_size = ?, file_modified_at = ?, missing = 0 WHERE id = ?')
          .run(asset.sortOrder, asset.fileSize, asset.fileModifiedAt, previous.id);
        touched.add(previous.id);
      } else {
        insert.run(randomUUID(), filmId, asset.assetType, asset.entry.relativePath, asset.sortOrder, asset.fileSize, asset.fileModifiedAt, asset.missing ? 1 : 0);
      }
    }
    for (const asset of existing) if (!touched.has(asset.id) && !seen.has(`${asset.asset_type}:${asset.relative_path.toLowerCase()}`)) this.db.prepare('UPDATE film_asset SET missing = 1 WHERE id = ?').run(asset.id);
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

  private categoriesForFilms(filmIds: string[]): Map<string, CustomCategoryDto[]> {
    const result = new Map<string, CustomCategoryDto[]>();
    if (!filmIds.length) return result;
    const placeholders = filmIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT fcc.film_id, c.id, c.name, c.sort_order
       FROM film_custom_category fcc
       JOIN custom_category c ON c.id = fcc.category_id
       WHERE fcc.film_id IN (${placeholders})
       ORDER BY c.sort_order, c.normalized_name, c.id`,
    ).all(...filmIds) as CategoryRow[];
    for (const row of rows) {
      const list = result.get(row.film_id!) ?? [];
      list.push(toCategoryDto(row));
      result.set(row.film_id!, list);
    }
    return result;
  }

  private categoryById(id: string): CustomCategoryDto | null {
    const row = this.db.prepare(
      `SELECT c.id, c.name, c.sort_order, COUNT(fcc.film_id) AS film_count
       FROM custom_category c LEFT JOIN film_custom_category fcc ON fcc.category_id = c.id
       WHERE c.id = ? GROUP BY c.id`,
    ).get(id) as CategoryRow | undefined;
    return row ? toCategoryDto(row) : null;
  }

  private categoryByNormalizedName(normalizedName: string): CustomCategoryDto | null {
    const row = this.db.prepare(
      `SELECT c.id, c.name, c.sort_order, COUNT(fcc.film_id) AS film_count
       FROM custom_category c LEFT JOIN film_custom_category fcc ON fcc.category_id = c.id
       WHERE c.normalized_name = ? GROUP BY c.id`,
    ).get(normalizedName) as CategoryRow | undefined;
    return row ? toCategoryDto(row) : null;
  }

  private toSummary(row: FilmSummaryRow, assets: FilmAssetDto[], customCategories: CustomCategoryDto[]): FilmSummaryDto {
    const available = assets.filter((asset) => !asset.missing);
    const poster = available.find((asset) => asset.assetType === 'poster');
    const preview = available.find((asset) => asset.assetType === 'preview')
      ?? available.find((asset) => asset.assetType === 'trailer')
      ?? available.find((asset) => asset.assetType === 'sample');
    const images = available
      .filter((asset) => asset.assetType === 'fanart' || asset.assetType === 'extra_fanart')
      .sort((left, right) => assetImagePriority(left.assetType) - assetImagePriority(right.assetType) || left.sortOrder - right.sortOrder)
      .map((asset) => asset.id);
    const totalFileCount = Number(row.total_file_count) || (row.relative_path ? 1 : 0);
    const existingFileCount = Number(row.existing_file_count);
    const missingFileCount = Math.max(0, totalFileCount - existingFileCount);
    const sourceDeleted = Boolean(row.source_deleted_at);
    const sourceOffline = !sourceDeleted && !isDirectory(row.source_root_path);
    const availability = sourceDeleted
      ? 'source_removed'
      : row.archived
        ? 'archived'
        : sourceOffline
          ? 'source_offline'
          : existingFileCount === 0
            ? 'missing'
            : missingFileCount > 0
              ? 'partial_missing'
              : 'available';
    return {
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      relativePath: row.relative_path,
      filename: row.filename,
      title: row.title,
      originalTitle: row.original_title,
      year: row.year,
      favorite: Boolean(row.favorite),
      organizationState: customCategories.length ? 'organized' : 'unorganized',
      customCategories,
      rating: row.rating,
      missing: availability === 'missing',
      posterAssetId: poster?.id ?? null,
      previewAssetId: preview?.id ?? null,
      allowOriginalPreview: Boolean(row.source_allow_original_preview),
      previewImageAssetIds: images,
      updatedAt: row.updated_at,
      availability,
      totalFileCount,
      existingFileCount,
      missingFileCount,
      sourceDeleted,
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
    const allData = Boolean(query.allData || query.missingOnly);
    const clauses = allData ? ['1 = 1'] : ['f.archived = 0', 's.deleted_at IS NULL'];
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
    if (query.actor?.trim()) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(f.actors_json) actor_filter WHERE actor_filter.type = 'text' AND actor_filter.value = ? COLLATE NOCASE)");
      params.push(query.actor.trim());
    }
    if (query.organizationState === 'organized') clauses.push('EXISTS (SELECT 1 FROM film_custom_category org WHERE org.film_id = f.id)');
    if (query.organizationState === 'unorganized') clauses.push('NOT EXISTS (SELECT 1 FROM film_custom_category org WHERE org.film_id = f.id)');
    if (query.categoryIds?.length) {
      const ids = [...new Set(query.categoryIds)];
      if (query.categoryMatch === 'all') {
        clauses.push(`(SELECT COUNT(DISTINCT fcc_all.category_id) FROM film_custom_category fcc_all WHERE fcc_all.film_id = f.id AND fcc_all.category_id IN (${ids.map(() => '?').join(',')})) = ?`);
        params.push(...ids, ids.length);
      } else {
        clauses.push(`EXISTS (SELECT 1 FROM film_custom_category fcc_any WHERE fcc_any.film_id = f.id AND fcc_any.category_id IN (${ids.map(() => '?').join(',')}))`);
        params.push(...ids);
      }
    }
    if (query.nfoTagIds?.length) {
      const ids = [...new Set(query.nfoTagIds)];
      if (query.nfoTagMatch === 'all') {
        clauses.push(`(SELECT COUNT(DISTINCT ft_all.tag_id) FROM film_tag ft_all WHERE ft_all.film_id = f.id AND ft_all.tag_id IN (${ids.map(() => '?').join(',')})) = ?`);
        params.push(...ids, ids.length);
      } else {
        clauses.push(`EXISTS (SELECT 1 FROM film_tag ft_any WHERE ft_any.film_id = f.id AND ft_any.tag_id IN (${ids.map(() => '?').join(',')}))`);
        params.push(...ids);
      }
    }
    if (query.minRating !== undefined && Number.isFinite(query.minRating)) {
      clauses.push('f.rating >= ?');
      params.push(Math.max(0, Math.min(10, query.minRating)));
    }
    if (query.favoriteOnly) clauses.push('f.favorite = 1');
    if (query.missingOnly) clauses.push('f.missing = 1');
    if (query.recordIssue === 'title-mismatch') {
      clauses.push(`f.nfo_status = 'missing'
        AND f.title_user_edited = 0
        AND (SELECT COUNT(*) FROM film_file mismatch_count WHERE mismatch_count.film_id = f.id) = 1
        AND EXISTS (
          SELECT 1 FROM film_file mismatch_file
          WHERE mismatch_file.film_id = f.id
            AND TRIM(mismatch_file.filename) <> ''
            AND TRIM(f.title) <> TRIM(filename_stem(mismatch_file.filename)) COLLATE NOCASE
        )`);
    }
    if (query.recordIssue === 'invalid-multipart') {
      clauses.push(`(SELECT COUNT(*) FROM film_file multipart_count WHERE multipart_count.film_id = f.id) > 1
        AND (
          EXISTS (
            SELECT 1 FROM film_file multipart_invalid
            WHERE multipart_invalid.film_id = f.id
              AND cd_group_key(multipart_invalid.filename) IS NULL
          )
          OR (SELECT COUNT(DISTINCT cd_group_key(multipart_base.filename))
              FROM film_file multipart_base WHERE multipart_base.film_id = f.id) <> 1
          OR (SELECT COUNT(DISTINCT cd_part_number(multipart_part.filename))
              FROM film_file multipart_part WHERE multipart_part.film_id = f.id)
             <> (SELECT COUNT(*) FROM film_file multipart_total WHERE multipart_total.film_id = f.id)
        )`);
    }
    return { where: `WHERE ${clauses.join(' AND ')}`, params };
  }

  private matchesAvailability(summary: FilmSummaryDto, query: FilmPageQuery): boolean {
    const allData = Boolean(query.allData || query.missingOnly);
    if (!allData && summary.existingFileCount === 0) return false;
    if (query.availability && query.availability !== 'all' && summary.availability !== query.availability) return false;
    if (query.missingOnly && !['missing', 'partial_missing'].includes(summary.availability)) return false;
    return true;
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
        return 'f.updated_at DESC, f.imported_at DESC, f.id ASC';
    }
  }
}

function assetImagePriority(assetType: AssetType): number {
  return assetType === 'fanart' ? 0 : assetType === 'extra_fanart' ? 1 : 2;
}

function imagePriority(assetType: AssetType): number {
  return assetType === 'fanart' ? 0 : assetType === 'extra_fanart' ? 1 : assetType === 'poster' ? 2 : 3;
}

function mappedCandidateValues(candidate: FilmCandidate): Omit<FilmCandidate, 'sourceId' | 'sourceRootPath' | 'absolutePath' | 'relativePath' | 'filename' | 'fileSize' | 'fileModifiedAt' | 'fingerprint' | 'nfoRelativePath' | 'nfoModifiedAt' | 'nfoHash' | 'nfoStatus' | 'nfoError' | 'assets' | 'ambiguousAssets' | 'logicalKey' | 'partBaseName' | 'files'> {
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
    rating: candidate.rating,
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

function firstNonEmpty<T extends string | null>(first: T, second: T): T {
  return first && first.trim() ? first : second;
}

function normalizeCategoryName(rawName: string): { name: string; normalizedName: string } {
  const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!name) throw new Error('INVALID_CATEGORY_NAME');
  return { name, normalizedName: name.toLocaleLowerCase('en-US') };
}

function toCategoryDto(row: CategoryRow): CustomCategoryDto {
  return {
    id: row.id,
    name: row.name,
    sortOrder: Number(row.sort_order),
    ...(row.film_count === undefined ? {} : { filmCount: Number(row.film_count) }),
  };
}

function isDirectory(rootPath: string): boolean {
  try {
    return fs.statSync(rootPath).isDirectory();
  } catch {
    return false;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function normalizedRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
}

function isRelativePathInDirectory(relativePath: string, directory: string): boolean {
  if (directory === '.') return true;
  const normalized = normalizedRelativePath(relativePath);
  return normalized.startsWith(`${directory}/`);
}
