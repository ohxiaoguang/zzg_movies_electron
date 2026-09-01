import { createHash, randomUUID } from 'node:crypto';
import type {
  CloudBackupMatchIssueDto,
  CloudBackupRestorePreviewDto,
  CloudBackupRestoreResultDto,
  LibraryDataBackupCategory,
  LibraryDataBackupDocument,
  LibraryDataBackupFilm,
  LibraryDataBackupSegment,
  VrViewDto,
} from '../../shared/contracts';
import type { DatabaseManager } from '../database/DatabaseManager';

interface ExportFilmRow {
  id: string;
  filename: string;
  file_size: number;
  runtime_seconds: number | null;
  favorite: number;
}

type CurrentFilmRow = ExportFilmRow;

interface PartRow {
  id: string;
  film_id: string;
  filename: string;
  file_size: number;
  file_modified_at: string | null;
  is_primary: number;
  part_number: number;
}

interface CategoryLinkRow {
  film_id: string;
  name: string;
}

interface SegmentRow {
  film_id: string;
  filename: string;
  file_size: number;
  start_seconds: number;
  end_seconds: number;
  title: string;
  comment: string;
  include_in_preview: number;
  vr_yaw_degrees: number | null;
  vr_pitch_degrees: number | null;
  vr_fov_degrees: number | null;
  sort_order: number;
}

interface MatchResult {
  matches: Map<number, CurrentFilmRow>;
  issues: CloudBackupMatchIssueDto[];
}

const MAX_BACKUP_FILMS = 200_000;
const MAX_BACKUP_SEGMENTS = 1_000_000;

export class LibraryDataBackupService {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly appVersion: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public exportDocument(): LibraryDataBackupDocument {
    return this.database.transaction(() => {
      const filmRows = this.database.db.prepare(
        `SELECT id, filename, file_size, runtime_seconds, favorite
         FROM film
         ORDER BY filename COLLATE NOCASE, file_size, id`,
      ).all() as ExportFilmRow[];
      const categoryRows = this.database.db.prepare(
        'SELECT name, sort_order FROM custom_category ORDER BY sort_order, normalized_name, id',
      ).all() as Array<{ name: string; sort_order: number }>;
      const categoryLinks = this.database.db.prepare(
        `SELECT fcc.film_id, c.name
         FROM film_custom_category fcc
         JOIN custom_category c ON c.id = fcc.category_id
         ORDER BY fcc.film_id, c.sort_order, c.normalized_name, c.id`,
      ).all() as CategoryLinkRow[];
      const segments = this.database.db.prepare(
        `SELECT segment.film_id, file.filename, file.file_size,
                segment.start_seconds, segment.end_seconds, segment.title, segment.comment,
                segment.include_in_preview, segment.vr_yaw_degrees, segment.vr_pitch_degrees,
                segment.vr_fov_degrees, segment.sort_order
         FROM film_segment segment
         JOIN film_file file ON file.id = segment.film_file_id
         ORDER BY segment.film_id, segment.sort_order, segment.start_seconds, segment.id`,
      ).all() as SegmentRow[];

      const categoryMap = groupValues(categoryLinks, (row) => row.film_id, (row) => row.name);
      const segmentMap = groupValues(segments, (row) => row.film_id, toBackupSegment);
      const categories: LibraryDataBackupCategory[] = categoryRows.map((row) => ({
        name: row.name,
        sortOrder: Number(row.sort_order),
      }));
      const films: LibraryDataBackupFilm[] = filmRows.map((row) => ({
        filename: row.filename,
        fileSize: Number(row.file_size) || 0,
        durationSeconds: finiteNullable(row.runtime_seconds),
        favorite: Boolean(row.favorite),
        categories: categoryMap.get(row.id) ?? [],
        segments: segmentMap.get(row.id) ?? [],
      }));
      const dataHash = hashBackupData(categories, films);
      return {
        format: 'local-film-library-user-data',
        formatVersion: 1,
        appVersion: this.appVersion,
        exportedAt: this.clock().toISOString(),
        dataHash,
        counts: backupCounts(categories, films),
        categories,
        films,
      };
    });
  }

  public parseDocument(value: unknown): LibraryDataBackupDocument {
    if (!isRecord(value)
      || value.format !== 'local-film-library-user-data'
      || value.formatVersion !== 1
      || typeof value.appVersion !== 'string'
      || typeof value.exportedAt !== 'string'
      || typeof value.dataHash !== 'string'
      || !Array.isArray(value.categories)
      || !Array.isArray(value.films)
      || value.films.length > MAX_BACKUP_FILMS) {
      throw new Error('CLOUD_BACKUP_FILE_INVALID');
    }
    const categories = value.categories.map(parseCategory);
    const films = value.films.map(parseFilm);
    const segmentCount = films.reduce((total, film) => total + film.segments.length, 0);
    if (segmentCount > MAX_BACKUP_SEGMENTS) throw new Error('CLOUD_BACKUP_FILE_INVALID');
    const expectedHash = hashBackupData(categories, films);
    if (value.dataHash !== expectedHash) throw new Error('CLOUD_BACKUP_CHECKSUM_MISMATCH');
    return {
      format: 'local-film-library-user-data',
      formatVersion: 1,
      appVersion: value.appVersion.slice(0, 100),
      exportedAt: value.exportedAt,
      dataHash: expectedHash,
      counts: backupCounts(categories, films),
      categories,
      films,
    };
  }

  public preview(document: LibraryDataBackupDocument, commitSha: string): CloudBackupRestorePreviewDto {
    const result = this.matchFilms(document);
    let restorableFavorites = 0;
    let restorableCategoryLinks = 0;
    let restorableSegments = 0;
    for (const [index, current] of result.matches) {
      const backup = document.films[index];
      if (!backup) continue;
      if (backup.favorite) restorableFavorites += 1;
      restorableCategoryLinks += backup.categories.length;
      restorableSegments += this.matchSegments(backup, current.id).size;
    }
    return {
      commitSha,
      exportedAt: document.exportedAt,
      appVersion: document.appVersion,
      counts: document.counts,
      matchedFilms: result.matches.size,
      missingFilms: result.issues.filter((issue) => issue.status === 'missing').length,
      ambiguousFilms: result.issues.filter((issue) => issue.status === 'ambiguous').length,
      restorableFavorites,
      restorableCategoryLinks,
      restorableSegments,
      issues: result.issues.slice(0, 500),
    };
  }

  public restore(document: LibraryDataBackupDocument): CloudBackupRestoreResultDto {
    const matchResult = this.matchFilms(document);
    let favoritesRestored = 0;
    let categoryLinksRestored = 0;
    let segmentsRestored = 0;
    let segmentsSkipped = 0;
    this.database.transaction(() => {
      const categoryIds = this.ensureCategories(document.categories);
      const updateFavorite = this.database.db.prepare(
        `UPDATE film
         SET favorite = ?, favorited_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ?
         WHERE id = ?`,
      );
      const clearCategories = this.database.db.prepare('DELETE FROM film_custom_category WHERE film_id = ?');
      const linkCategory = this.database.db.prepare(
        'INSERT INTO film_custom_category (film_id, category_id, created_at) VALUES (?, ?, ?)',
      );
      const clearSegments = this.database.db.prepare('DELETE FROM film_segment WHERE film_id = ?');
      const insertSegment = this.database.db.prepare(
        `INSERT INTO film_segment (
           id, film_id, film_file_id, start_seconds, end_seconds, title, comment,
           include_in_preview, vr_yaw_degrees, vr_pitch_degrees, vr_fov_degrees,
           sort_order, source_file_size, source_file_modified_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = this.clock().toISOString();

      for (const [index, current] of matchResult.matches) {
        const backup = document.films[index];
        if (!backup) continue;
        updateFavorite.run(backup.favorite ? 1 : 0, backup.favorite ? 1 : 0, now, now, current.id);
        if (backup.favorite) favoritesRestored += 1;

        clearCategories.run(current.id);
        for (const name of backup.categories) {
          const categoryId = categoryIds.get(normalizeName(name));
          if (!categoryId) continue;
          linkCategory.run(current.id, categoryId, now);
          categoryLinksRestored += 1;
        }

        clearSegments.run(current.id);
        const segmentMatches = this.matchSegments(backup, current.id);
        backup.segments.forEach((segment, segmentIndex) => {
          const part = segmentMatches.get(segmentIndex);
          if (!part) {
            segmentsSkipped += 1;
            return;
          }
          insertSegment.run(
            randomUUID(),
            current.id,
            part.id,
            segment.startSeconds,
            segment.endSeconds,
            segment.title,
            segment.comment,
            segment.includeInPreview ? 1 : 0,
            segment.vrView?.yawDegrees ?? null,
            segment.vrView?.pitchDegrees ?? null,
            segment.vrView?.fovDegrees ?? null,
            segment.sortOrder,
            part.file_size,
            part.file_modified_at,
            now,
            now,
          );
          segmentsRestored += 1;
        });
      }
    });
    return {
      matchedFilms: matchResult.matches.size,
      missingFilms: matchResult.issues.filter((issue) => issue.status === 'missing').length,
      ambiguousFilms: matchResult.issues.filter((issue) => issue.status === 'ambiguous').length,
      favoritesRestored,
      categoryLinksRestored,
      segmentsRestored,
      segmentsSkipped,
    };
  }

  private matchFilms(document: LibraryDataBackupDocument): MatchResult {
    const current = this.database.db.prepare(
      `SELECT id, filename, file_size, runtime_seconds, favorite
       FROM film
       ORDER BY filename COLLATE NOCASE, file_size, id`,
    ).all() as CurrentFilmRow[];
    const byName = groupRows(current, (row) => normalizeName(row.filename));
    const matches = new Map<number, CurrentFilmRow>();
    const issues: CloudBackupMatchIssueDto[] = [];
    document.films.forEach((backup, index) => {
      const candidates = byName.get(normalizeName(backup.filename)) ?? [];
      const match = chooseFilmCandidate(backup, candidates);
      if (match) matches.set(index, match);
      else issues.push({
        backupIndex: index,
        filename: backup.filename,
        fileSize: backup.fileSize,
        durationSeconds: backup.durationSeconds,
        status: candidates.length ? 'ambiguous' : 'missing',
        candidateCount: candidates.length,
      });
    });
    const matchedByCurrent = new Map<string, number[]>();
    for (const [index, match] of matches) {
      const indexes = matchedByCurrent.get(match.id) ?? [];
      indexes.push(index);
      matchedByCurrent.set(match.id, indexes);
    }
    for (const indexes of matchedByCurrent.values()) {
      if (indexes.length < 2) continue;
      for (const index of indexes) {
        const backup = document.films[index]!;
        matches.delete(index);
        issues.push({
          backupIndex: index,
          filename: backup.filename,
          fileSize: backup.fileSize,
          durationSeconds: backup.durationSeconds,
          status: 'ambiguous',
          candidateCount: byName.get(normalizeName(backup.filename))?.length ?? 0,
        });
      }
    }
    issues.sort((left, right) => left.backupIndex - right.backupIndex);
    return { matches, issues };
  }

  private matchSegments(backup: LibraryDataBackupFilm, currentFilmId: string): Map<number, PartRow> {
    const parts = this.database.db.prepare(
      `SELECT id, film_id, filename, file_size, file_modified_at, is_primary, part_number
       FROM film_file WHERE film_id = ? ORDER BY part_number, filename, id`,
    ).all(currentFilmId) as PartRow[];
    const byName = groupRows(parts, (row) => normalizeName(row.filename));
    const result = new Map<number, PartRow>();
    backup.segments.forEach((segment, index) => {
      const candidates = byName.get(normalizeName(segment.fileName)) ?? [];
      if (candidates.length === 1) result.set(index, candidates[0]!);
      else if (candidates.length > 1 && segment.fileSize > 0) {
        const sized = candidates.filter((candidate) => candidate.file_size === segment.fileSize);
        if (sized.length === 1) result.set(index, sized[0]!);
      }
    });
    return result;
  }

  private ensureCategories(categories: LibraryDataBackupCategory[]): Map<string, string> {
    const rows = this.database.db.prepare('SELECT id, normalized_name FROM custom_category').all() as Array<{
      id: string;
      normalized_name: string;
    }>;
    const result = new Map(rows.map((row) => [normalizeName(row.normalized_name), row.id]));
    const insert = this.database.db.prepare(
      `INSERT INTO custom_category (id, name, normalized_name, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const updateOrder = this.database.db.prepare('UPDATE custom_category SET sort_order = ?, updated_at = ? WHERE id = ?');
    const now = this.clock().toISOString();
    for (const category of categories) {
      const key = normalizeName(category.name);
      let id = result.get(key);
      if (!id) {
        id = randomUUID();
        insert.run(id, normalizedDisplayName(category.name), key, category.sortOrder, now, now);
        result.set(key, id);
      } else updateOrder.run(category.sortOrder, now, id);
    }
    return result;
  }
}

function chooseFilmCandidate(backup: LibraryDataBackupFilm, candidates: CurrentFilmRow[]): CurrentFilmRow | null {
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length) return null;
  let narrowed = candidates;
  if (backup.fileSize > 0) {
    const sized = narrowed.filter((candidate) => Number(candidate.file_size) === backup.fileSize);
    if (sized.length === 1) return sized[0]!;
    if (sized.length) narrowed = sized;
  }
  if (backup.durationSeconds !== null) {
    const timed = narrowed.filter((candidate) => (
      candidate.runtime_seconds !== null
      && Math.abs(Number(candidate.runtime_seconds) - backup.durationSeconds!) <= 2
    ));
    if (timed.length === 1) return timed[0]!;
  }
  return null;
}

function toBackupSegment(row: SegmentRow): LibraryDataBackupSegment {
  return {
    fileName: row.filename,
    fileSize: Number(row.file_size) || 0,
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    title: row.title,
    comment: row.comment,
    includeInPreview: Boolean(row.include_in_preview),
    sortOrder: Number(row.sort_order),
    vrView: row.vr_yaw_degrees === null || row.vr_pitch_degrees === null || row.vr_fov_degrees === null
      ? null
      : {
          yawDegrees: Number(row.vr_yaw_degrees),
          pitchDegrees: Number(row.vr_pitch_degrees),
          fovDegrees: Number(row.vr_fov_degrees),
        },
  };
}

function backupCounts(categories: LibraryDataBackupCategory[], films: LibraryDataBackupFilm[]): LibraryDataBackupDocument['counts'] {
  return {
    films: films.length,
    favorites: films.filter((film) => film.favorite).length,
    categories: categories.length,
    categoryLinks: films.reduce((total, film) => total + film.categories.length, 0),
    segments: films.reduce((total, film) => total + film.segments.length, 0),
  };
}

function hashBackupData(categories: LibraryDataBackupCategory[], films: LibraryDataBackupFilm[]): string {
  return createHash('sha256').update(JSON.stringify({ categories, films })).digest('hex');
}

function parseCategory(value: unknown): LibraryDataBackupCategory {
  if (!isRecord(value) || typeof value.name !== 'string' || !Number.isInteger(value.sortOrder)) {
    throw new Error('CLOUD_BACKUP_FILE_INVALID');
  }
  return { name: validatedBackupText(value.name, 200), sortOrder: Number(value.sortOrder) };
}

function parseFilm(value: unknown): LibraryDataBackupFilm {
  if (!isRecord(value)
    || typeof value.filename !== 'string'
    || typeof value.fileSize !== 'number'
    || !Number.isFinite(value.fileSize)
    || value.fileSize < 0
    || (value.durationSeconds !== null && (
      typeof value.durationSeconds !== 'number'
      || !Number.isFinite(value.durationSeconds)
      || value.durationSeconds < 0
    ))
    || typeof value.favorite !== 'boolean'
    || !Array.isArray(value.categories)
    || value.categories.some((name) => typeof name !== 'string')
    || !Array.isArray(value.segments)) {
    throw new Error('CLOUD_BACKUP_FILE_INVALID');
  }
  const categories = value.categories.map((name) => validatedBackupText(name as string, 200));
  if (new Set(categories.map(normalizeName)).size !== categories.length) {
    throw new Error('CLOUD_BACKUP_FILE_INVALID');
  }
  return {
    filename: validatedBackupText(value.filename, 1000),
    fileSize: value.fileSize,
    durationSeconds: value.durationSeconds,
    favorite: value.favorite,
    categories,
    segments: value.segments.map(parseSegment),
  };
}

function parseSegment(value: unknown): LibraryDataBackupSegment {
  if (!isRecord(value)
    || typeof value.fileName !== 'string'
    || typeof value.fileSize !== 'number'
    || !Number.isFinite(value.fileSize)
    || value.fileSize < 0
    || typeof value.startSeconds !== 'number'
    || typeof value.endSeconds !== 'number'
    || !Number.isFinite(value.startSeconds)
    || !Number.isFinite(value.endSeconds)
    || value.startSeconds < 0
    || value.endSeconds <= value.startSeconds
    || typeof value.title !== 'string'
    || typeof value.comment !== 'string'
    || value.title.length > 200
    || value.comment.length > 5000
    || typeof value.includeInPreview !== 'boolean'
    || !Number.isInteger(value.sortOrder)) {
    throw new Error('CLOUD_BACKUP_FILE_INVALID');
  }
  return {
    fileName: validatedBackupText(value.fileName, 1000),
    fileSize: value.fileSize,
    startSeconds: value.startSeconds,
    endSeconds: value.endSeconds,
    title: value.title,
    comment: value.comment,
    includeInPreview: value.includeInPreview,
    sortOrder: Number(value.sortOrder),
    ...('vrView' in value ? { vrView: parseBackupVrView(value.vrView) } : {}),
  };
}

function parseBackupVrView(value: unknown): VrViewDto | null {
  if (value === null) return null;
  if (!isRecord(value)
    || !validViewNumber(value.yawDegrees, -180, 180, false)
    || !validViewNumber(value.pitchDegrees, -85, 85, true)
    || !validViewNumber(value.fovDegrees, 30, 100, true)) {
    throw new Error('CLOUD_BACKUP_FILE_INVALID');
  }
  return {
    yawDegrees: value.yawDegrees as number,
    pitchDegrees: value.pitchDegrees as number,
    fovDegrees: value.fovDegrees as number,
  };
}

function validViewNumber(value: unknown, minimum: number, maximum: number, inclusiveMaximum: boolean): boolean {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && (inclusiveMaximum ? value <= maximum : value < maximum);
}

function validatedBackupText(value: string, maxLength: number): string {
  if (value.length > maxLength || !value.normalize('NFKC').trim()) {
    throw new Error('CLOUD_BACKUP_FILE_INVALID');
  }
  return value;
}

function normalizedDisplayName(value: string): string {
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!name) throw new Error('CLOUD_BACKUP_FILE_INVALID');
  return name;
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function finiteNullable(value: number | null): number | null {
  return value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function groupValues<T, V>(rows: T[], key: (row: T) => string, value: (row: T) => V): Map<string, V[]> {
  const result = new Map<string, V[]>();
  for (const row of rows) {
    const rowKey = key(row);
    const list = result.get(rowKey) ?? [];
    list.push(value(row));
    result.set(rowKey, list);
  }
  return result;
}

function groupRows<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  return groupValues(rows, key, (row) => row);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
