import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { logicalFilmKey, normalizeRelativePath } from '../scanner/PartNaming';

export interface FilmRepairReport {
  mergedFilmGroups: number;
  mergedFilms: number;
  movedFilmFiles: number;
  deletedEmptyFilms: number;
  duplicateFilmFilesRemoved: number;
  duplicateAssetsRemoved: number;
  conflictCount: number;
}

export interface FilmMergeReport extends FilmRepairReport {
  survivorFilmId: string;
  mergedFilmId: string;
  sourceId: string | null;
  groupKey: string;
  notesConflict: boolean;
}

interface FilmRow {
  id: string;
  source_id: string;
  title: string;
  original_title: string | null;
  sort_title: string | null;
  year: number | null;
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
  favorite: number;
  rating: number;
  notes: string;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  container_format: string | null;
  nfo_relative_path: string | null;
  nfo_modified_at: string | null;
  nfo_hash: string | null;
  nfo_status: string;
  nfo_error: string | null;
  imported_at: string;
  title_user_edited?: number;
  tags_user_edited?: number;
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
}

interface FilmAssetRow {
  id: string;
  film_id: string;
  asset_type: string;
  relative_path: string;
  sort_order: number;
  file_size: number | null;
  file_modified_at: string | null;
  missing: number;
}

interface SurvivorScore {
  id: string;
  importedAt: string;
  hasPartOne: number;
  manualScore: number;
}

export class FilmFileOwnershipRepairService {
  private readonly hasTitleUserEditColumn: boolean;
  private readonly hasTagUserEditColumn: boolean;

  public constructor(private readonly db: Database.Database) {
    this.hasTitleUserEditColumn = this.hasColumn('title_user_edited');
    this.hasTagUserEditColumn = this.hasColumn('tags_user_edited');
  }

  public repairExisting(now = new Date().toISOString()): FilmRepairReport {
    this.ensureAuditTables();
    const report = emptyReport();
    for (const [physicalKey, rows] of this.physicalDuplicateGroups()) {
      if (rows.length < 2) continue;
      const filmIds = [...new Set(rows.map((row) => row.film_id))];
      if (filmIds.length > 1) {
        report.mergedFilmGroups += 1;
        const survivor = this.chooseSurvivor(filmIds);
        for (const filmId of filmIds.filter((id) => id !== survivor)) addReport(report, this.mergeFilms(survivor, filmId, now, `path:${physicalKey}`));
      } else {
        for (const row of rows.slice(1)) {
          this.db.prepare('DELETE FROM film_file WHERE id = ?').run(row.id);
          report.duplicateFilmFilesRemoved += 1;
        }
      }
    }
    const groups = this.groupedFilmIds();
    for (const [groupKey, filmIds] of groups) {
      if (filmIds.length < 2) continue;
      report.mergedFilmGroups += 1;
      const survivor = this.chooseSurvivor(filmIds);
      for (const filmId of filmIds.filter((id) => id !== survivor)) {
        const merged = this.mergeFilms(survivor, filmId, now, groupKey);
        addReport(report, merged);
      }
    }
    this.db.prepare(
      `INSERT INTO film_repair_run
       (id, started_at, finished_at, merged_film_groups, merged_films, moved_film_files,
        deleted_empty_films, duplicate_film_files_removed, duplicate_assets_removed, conflict_count, report_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), now, new Date().toISOString(), report.mergedFilmGroups, report.mergedFilms,
      report.movedFilmFiles, report.deletedEmptyFilms, report.duplicateFilmFilesRemoved,
      report.duplicateAssetsRemoved, report.conflictCount, JSON.stringify(report),
    );
    return report;
  }

  public chooseSurvivor(filmIds: string[]): string {
    const uniqueIds = [...new Set(filmIds)];
    if (!uniqueIds.length) throw new Error('FILM_SURVIVOR_NOT_FOUND');
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT id, imported_at, title, favorite, rating, notes FROM film WHERE id IN (${placeholders})`).all(...uniqueIds) as Array<Pick<FilmRow, 'id' | 'imported_at' | 'title' | 'favorite' | 'rating' | 'notes'>>;
    const tagCounts = new Map<string, number>((this.db.prepare(`SELECT film_id, COUNT(*) AS count FROM film_tag WHERE film_id IN (${placeholders}) GROUP BY film_id`).all(...uniqueIds) as Array<{ film_id: string; count: number }>).map((row) => [row.film_id, Number(row.count)]));
    const scores: SurvivorScore[] = rows.map((row) => ({
      id: row.id,
      importedAt: row.imported_at,
      hasPartOne: this.db.prepare("SELECT 1 AS present FROM film_file WHERE film_id = ? AND part_type IN ('cd', 'disc') AND part_number = 1 LIMIT 1").get(row.id) ? 1 : 0,
      manualScore: (row.title?.trim() ? 1 : 0)
        + (row.favorite ? 3 : 0)
        + (row.rating > 0 ? 2 : 0)
        + (row.notes?.trim() ? 2 : 0)
        + (tagCounts.get(row.id) ?? 0),
    }));
    scores.sort((left, right) => right.hasPartOne - left.hasPartOne
      || right.manualScore - left.manualScore
      || left.importedAt.localeCompare(right.importedAt)
      || left.id.localeCompare(right.id));
    return scores[0]?.id ?? uniqueIds.sort()[0]!;
  }

  public mergeFilms(survivorFilmId: string, mergedFilmId: string, now = new Date().toISOString(), groupKey = 'manual'): FilmMergeReport {
    if (survivorFilmId === mergedFilmId) return emptyMergeReport(survivorFilmId, mergedFilmId, null, groupKey);
    const survivor = this.db.prepare('SELECT * FROM film WHERE id = ?').get(survivorFilmId) as FilmRow | undefined;
    const merged = this.db.prepare('SELECT * FROM film WHERE id = ?').get(mergedFilmId) as FilmRow | undefined;
    if (!survivor || !merged) throw new Error('FILM_MERGE_RECORD_NOT_FOUND');

    const sourceId = survivor.source_id;
    const mergedFields = mergeFilmFields(survivor, merged);
    this.db.prepare(
      `UPDATE film SET title = ?, original_title = ?, sort_title = ?, year = ?, release_date = ?,
       runtime_seconds = ?, plot = ?, outline = ?, tagline = ?, content_rating = ?, studio = ?,
       country_json = ?, director_json = ?, actors_json = ?, favorite = ?, rating = ?,
       notes = ?, width = ?, height = ?, video_codec = ?, audio_codec = ?, container_format = ?,
       nfo_relative_path = ?, nfo_modified_at = ?, nfo_hash = ?, nfo_status = ?, nfo_error = ?,
       updated_at = ? WHERE id = ?`,
    ).run(
      mergedFields.title, mergedFields.original_title, mergedFields.sort_title, mergedFields.year,
      mergedFields.release_date, mergedFields.runtime_seconds, mergedFields.plot, mergedFields.outline,
      mergedFields.tagline, mergedFields.content_rating, mergedFields.studio, mergedFields.country_json,
      mergedFields.director_json, mergedFields.actors_json, mergedFields.favorite,
      mergedFields.rating, mergedFields.notes, mergedFields.width, mergedFields.height, mergedFields.video_codec,
      mergedFields.audio_codec, mergedFields.container_format, mergedFields.nfo_relative_path,
      mergedFields.nfo_modified_at, mergedFields.nfo_hash, mergedFields.nfo_status, mergedFields.nfo_error,
      now, survivorFilmId,
    );
    if (this.hasTagUserEditColumn) {
      this.db.prepare('UPDATE film SET tags_user_edited = ? WHERE id = ?').run(
        mergedFields.tags_user_edited ?? 0,
        survivorFilmId,
      );
    }
    if (this.hasTitleUserEditColumn) {
      this.db.prepare('UPDATE film SET title_user_edited = ? WHERE id = ?').run(
        mergedFields.title_user_edited ?? 0,
        survivorFilmId,
      );
    }

    const report = emptyMergeReport(survivorFilmId, mergedFilmId, sourceId, groupKey);
    report.notesConflict = mergedFields.notesConflict;
    report.conflictCount = mergedFields.notesConflict ? 1 : 0;
    report.movedFilmFiles = this.mergeFilmFiles(survivorFilmId, mergedFilmId, now, report);
    this.mergeAssets(survivorFilmId, mergedFilmId, report);
    this.mergeRelations('film_tag', 'tag_id', survivorFilmId, mergedFilmId, relationMergeMode(survivor.tags_user_edited, merged.tags_user_edited));
    this.mergeCustomCategories(survivorFilmId, mergedFilmId);

    this.db.prepare('DELETE FROM film WHERE id = ?').run(mergedFilmId);
    report.mergedFilms = 1;
    report.deletedEmptyFilms = 1;
    this.db.prepare(
      `INSERT INTO film_merge_audit
       (id, source_id, group_key, survivor_film_id, merged_film_id, notes_conflict, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), sourceId, groupKey, survivorFilmId, mergedFilmId, report.notesConflict ? 1 : 0,
      JSON.stringify({ survivorNotes: survivor.notes, mergedNotes: merged.notes, mergedTitle: merged.title }), now,
    );
    this.recomputeFilmLegacyFields(survivorFilmId, now);
    return report;
  }

  private groupedFilmIds(): Map<string, string[]> {
    const rows = this.db.prepare('SELECT film_id, source_id, relative_path, filename FROM film_file ORDER BY source_id, relative_path, film_id').all() as Array<{ film_id: string; source_id: string; relative_path: string; filename: string }>;
    const grouped = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = logicalFilmKey(path.dirname(row.relative_path), row.filename);
      if (!key.startsWith('parts:')) continue;
      const groupKey = `${row.source_id}:${key}`;
      const filmIds = grouped.get(groupKey) ?? new Set<string>();
      filmIds.add(row.film_id);
      grouped.set(groupKey, filmIds);
    }
    return new Map([...grouped.entries()].map(([key, ids]) => [key, [...ids].sort()]));
  }

  private physicalDuplicateGroups(): Map<string, FilmFileRow[]> {
    const rows = this.db.prepare('SELECT id, film_id, source_id, relative_path, filename, missing FROM film_file ORDER BY source_id, relative_path, id').all() as Array<Pick<FilmFileRow, 'id' | 'film_id' | 'source_id' | 'relative_path' | 'filename' | 'missing'>>;
    const groups = new Map<string, FilmFileRow[]>();
    for (const row of rows) {
      const key = `${row.source_id}:${safeNormalize(row.relative_path)}`;
      const group = groups.get(key) ?? [];
      group.push(row as FilmFileRow);
      group.sort((left, right) => left.missing - right.missing || left.id.localeCompare(right.id));
      groups.set(key, group);
    }
    return groups;
  }

  private mergeFilmFiles(survivorFilmId: string, mergedFilmId: string, now: string, report: FilmRepairReport): number {
    const survivorRows = this.db.prepare('SELECT * FROM film_file WHERE film_id = ?').all(survivorFilmId) as FilmFileRow[];
    const mergedRows = this.db.prepare('SELECT * FROM film_file WHERE film_id = ?').all(mergedFilmId) as FilmFileRow[];
    let moved = 0;
    for (const row of mergedRows) {
      const normalized = safeNormalize(row.relative_path);
      const duplicate = survivorRows.find((candidate) => candidate.source_id === row.source_id && safeNormalize(candidate.relative_path) === normalized);
      if (duplicate) {
        if (duplicate.missing && !row.missing) {
          this.db.prepare(
            `UPDATE film_file SET filename = ?, part_type = ?, part_number = ?, is_primary = ?, file_size = ?,
             file_modified_at = ?, fingerprint = ?, missing = 0, updated_at = ? WHERE id = ?`,
          ).run(row.filename, row.part_type, row.part_number, row.is_primary, row.file_size, row.file_modified_at, row.fingerprint, now, duplicate.id);
        }
        this.db.prepare('DELETE FROM film_file WHERE id = ?').run(row.id);
        report.duplicateFilmFilesRemoved += 1;
        continue;
      }
      this.db.prepare('UPDATE film_file SET film_id = ?, updated_at = ? WHERE id = ?').run(survivorFilmId, now, row.id);
      survivorRows.push({ ...row, film_id: survivorFilmId });
      moved += 1;
    }
    const primary = this.db.prepare('SELECT id FROM film_file WHERE film_id = ? ORDER BY missing ASC, part_number ASC, filename COLLATE NOCASE ASC, id ASC LIMIT 1').get(survivorFilmId) as { id: string } | undefined;
    if (primary) this.db.prepare('UPDATE film_file SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE film_id = ?').run(primary.id, survivorFilmId);
    return moved;
  }

  private mergeAssets(survivorFilmId: string, mergedFilmId: string, report: FilmRepairReport): void {
    const survivorRows = this.db.prepare('SELECT * FROM film_asset WHERE film_id = ?').all(survivorFilmId) as FilmAssetRow[];
    const mergedRows = this.db.prepare('SELECT * FROM film_asset WHERE film_id = ?').all(mergedFilmId) as FilmAssetRow[];
    for (const row of mergedRows) {
      const duplicate = survivorRows.find((candidate) => candidate.asset_type === row.asset_type && safeNormalize(candidate.relative_path) === safeNormalize(row.relative_path));
      if (duplicate) {
        if (duplicate.missing && !row.missing) {
          this.db.prepare('UPDATE film_asset SET sort_order = ?, file_size = ?, file_modified_at = ?, missing = 0 WHERE id = ?').run(row.sort_order, row.file_size, row.file_modified_at, duplicate.id);
        }
        this.db.prepare('DELETE FROM film_asset WHERE id = ?').run(row.id);
        report.duplicateAssetsRemoved += 1;
      } else {
        this.db.prepare('UPDATE film_asset SET film_id = ? WHERE id = ?').run(survivorFilmId, row.id);
        survivorRows.push({ ...row, film_id: survivorFilmId });
      }
    }
  }

  private mergeRelations(
    table: 'film_tag',
    relationColumn: 'tag_id',
    survivorFilmId: string,
    mergedFilmId: string,
    mode: RelationMergeMode,
  ): void {
    const rows = this.db.prepare(`SELECT ${relationColumn} AS relation_id FROM ${table} WHERE film_id = ?`).all(mergedFilmId) as Array<{ relation_id: string }>;
    if (mode === 'survivor') {
      this.db.prepare(`DELETE FROM ${table} WHERE film_id = ?`).run(mergedFilmId);
      return;
    }
    if (mode === 'merged') this.db.prepare(`DELETE FROM ${table} WHERE film_id = ?`).run(survivorFilmId);
    for (const row of rows) {
      const existing = this.db.prepare(`SELECT 1 AS present FROM ${table} WHERE film_id = ? AND ${relationColumn} = ?`).get(survivorFilmId, row.relation_id);
      if (!existing) this.db.prepare(`INSERT INTO ${table} (film_id, ${relationColumn}) VALUES (?, ?)`).run(survivorFilmId, row.relation_id);
    }
    this.db.prepare(`DELETE FROM ${table} WHERE film_id = ?`).run(mergedFilmId);
  }

  private mergeCustomCategories(survivorFilmId: string, mergedFilmId: string): void {
    if (!this.hasTable('film_custom_category')) return;
    this.db.prepare(
      `INSERT OR IGNORE INTO film_custom_category (film_id, category_id, created_at)
       SELECT ?, category_id, created_at FROM film_custom_category WHERE film_id = ?`,
    ).run(survivorFilmId, mergedFilmId);
    this.db.prepare('DELETE FROM film_custom_category WHERE film_id = ?').run(mergedFilmId);
  }

  private recomputeFilmLegacyFields(filmId: string, now: string): void {
    const primary = this.db.prepare('SELECT relative_path, filename, file_size, file_modified_at, fingerprint FROM film_file WHERE film_id = ? AND is_primary = 1 ORDER BY part_number, filename LIMIT 1').get(filmId) as Pick<FilmFileRow, 'relative_path' | 'filename' | 'file_size' | 'file_modified_at' | 'fingerprint'> | undefined;
    const fallback = primary ?? this.db.prepare('SELECT relative_path, filename, file_size, file_modified_at, fingerprint FROM film_file WHERE film_id = ? ORDER BY part_number, filename LIMIT 1').get(filmId) as Pick<FilmFileRow, 'relative_path' | 'filename' | 'file_size' | 'file_modified_at' | 'fingerprint'> | undefined;
    if (!fallback) return;
    this.db.prepare('UPDATE film SET relative_path = ?, filename = ?, file_size = ?, file_modified_at = ?, fingerprint = ?, missing = CASE WHEN EXISTS (SELECT 1 FROM film_file WHERE film_id = ? AND missing = 0) THEN 0 ELSE 1 END, updated_at = ? WHERE id = ?').run(fallback.relative_path, fallback.filename, fallback.file_size, fallback.file_modified_at, fallback.fingerprint, filmId, now, filmId);
  }

  private ensureAuditTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS film_merge_audit (
        id TEXT PRIMARY KEY,
        source_id TEXT,
        group_key TEXT NOT NULL,
        survivor_film_id TEXT NOT NULL,
        merged_film_id TEXT NOT NULL,
        notes_conflict INTEGER NOT NULL DEFAULT 0,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS film_repair_run (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        merged_film_groups INTEGER NOT NULL,
        merged_films INTEGER NOT NULL,
        moved_film_files INTEGER NOT NULL,
        deleted_empty_films INTEGER NOT NULL,
        duplicate_film_files_removed INTEGER NOT NULL,
        duplicate_assets_removed INTEGER NOT NULL,
        conflict_count INTEGER NOT NULL,
        report_json TEXT NOT NULL
      );
    `);
  }

  private hasColumn(column: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS present FROM pragma_table_info(?) WHERE name = ?').get('film', column));
  }

  private hasTable(table: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }
}

function emptyReport(): FilmRepairReport {
  return {
    mergedFilmGroups: 0,
    mergedFilms: 0,
    movedFilmFiles: 0,
    deletedEmptyFilms: 0,
    duplicateFilmFilesRemoved: 0,
    duplicateAssetsRemoved: 0,
    conflictCount: 0,
  };
}

function emptyMergeReport(survivorFilmId: string, mergedFilmId: string, sourceId: string | null, groupKey: string): FilmMergeReport {
  return { ...emptyReport(), survivorFilmId, mergedFilmId, sourceId, groupKey, notesConflict: false };
}

function addReport(target: FilmRepairReport, source: FilmRepairReport): void {
  target.mergedFilms += source.mergedFilms;
  target.movedFilmFiles += source.movedFilmFiles;
  target.deletedEmptyFilms += source.deletedEmptyFilms;
  target.duplicateFilmFilesRemoved += source.duplicateFilmFilesRemoved;
  target.duplicateAssetsRemoved += source.duplicateAssetsRemoved;
  target.conflictCount += source.conflictCount;
}

function mergeFilmFields(survivor: FilmRow, merged: FilmRow): FilmRow & { notesConflict: boolean } {
  const notesConflict = Boolean(survivor.notes?.trim() && merged.notes?.trim() && survivor.notes.trim() !== merged.notes.trim());
  return {
    ...survivor,
    title: firstNonEmpty(survivor.title, merged.title) ?? survivor.title,
    original_title: firstNonEmpty(survivor.original_title, merged.original_title),
    sort_title: firstNonEmpty(survivor.sort_title, merged.sort_title),
    year: survivor.year ?? merged.year,
    release_date: firstNonEmpty(survivor.release_date, merged.release_date),
    runtime_seconds: survivor.runtime_seconds ?? merged.runtime_seconds,
    plot: firstNonEmpty(survivor.plot, merged.plot),
    outline: firstNonEmpty(survivor.outline, merged.outline),
    tagline: firstNonEmpty(survivor.tagline, merged.tagline),
    content_rating: firstNonEmpty(survivor.content_rating, merged.content_rating),
    studio: firstNonEmpty(survivor.studio, merged.studio),
    country_json: JSON.stringify(unionJsonArrays(survivor.country_json, merged.country_json)),
    director_json: JSON.stringify(unionJsonArrays(survivor.director_json, merged.director_json)),
    actors_json: JSON.stringify(unionJsonArrays(survivor.actors_json, merged.actors_json)),
    favorite: survivor.favorite || merged.favorite ? 1 : 0,
    rating: survivor.rating > 0 ? survivor.rating : merged.rating,
    notes: firstNonEmpty(survivor.notes, merged.notes) ?? '',
    width: survivor.width ?? merged.width,
    height: survivor.height ?? merged.height,
    video_codec: firstNonEmpty(survivor.video_codec, merged.video_codec),
    audio_codec: firstNonEmpty(survivor.audio_codec, merged.audio_codec),
    container_format: firstNonEmpty(survivor.container_format, merged.container_format),
    nfo_relative_path: firstNonEmpty(survivor.nfo_relative_path, merged.nfo_relative_path),
    nfo_modified_at: firstNonEmpty(survivor.nfo_modified_at, merged.nfo_modified_at),
    nfo_hash: firstNonEmpty(survivor.nfo_hash, merged.nfo_hash),
    nfo_status: survivor.nfo_status !== 'missing' ? survivor.nfo_status : merged.nfo_status,
    nfo_error: firstNonEmpty(survivor.nfo_error, merged.nfo_error),
    title_user_edited: survivor.title_user_edited || merged.title_user_edited ? 1 : 0,
    tags_user_edited: survivor.tags_user_edited || merged.tags_user_edited ? 1 : 0,
    notesConflict,
  };
}

type RelationMergeMode = 'union' | 'survivor' | 'merged';

function relationMergeMode(survivorEdited: number | undefined, mergedEdited: number | undefined): RelationMergeMode {
  if (survivorEdited) return 'survivor';
  if (mergedEdited) return 'merged';
  return 'union';
}

function firstNonEmpty<T extends string | null>(first: T, second: T): T {
  return first && first.trim() ? first : second;
}

function unionJsonArrays(first: string, second: string): string[] {
  const values = [...jsonArray(first), ...jsonArray(second)];
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
  } catch {
    return [];
  }
}

function safeNormalize(value: string): string {
  try {
    return normalizeRelativePath(value);
  } catch {
    return value.replaceAll('\\', '/').replace(/\/+/g, '/').toLocaleLowerCase();
  }
}
