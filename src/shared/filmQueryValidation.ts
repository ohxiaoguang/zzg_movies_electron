import type { FilmPageQuery } from './contracts';
import { isRecord, isUuid } from './validation';

export interface FilmPageQueryValidationOptions {
  strict?: boolean;
}

export function validateFilmPageQuery(
  payload: unknown,
  defaultPageSize: number,
  options: FilmPageQueryValidationOptions = {},
): FilmPageQuery {
  if (!isRecord(payload)) throw new Error('INVALID_PAGE_QUERY');
  const strict = options.strict === true;
  const page = integerInRange(payload.page, 1, 100_000, 1, strict);
  const pageSize = integerInRange(payload.pageSize, 1, 200, defaultPageSize, strict);
  const query: FilmPageQuery = { page, pageSize };

  for (const key of ['search', 'sourceId', 'actor'] as const) {
    const value = payload[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > 500) throw new Error('INVALID_PAGE_QUERY');
    if (strict && key === 'sourceId' && value && !isUuid(value)) throw new Error('INVALID_PAGE_QUERY');
    query[key] = value;
  }

  if (payload.categoryIds !== undefined) {
    query.categoryIds = uuidArray(payload.categoryIds);
  }
  if (payload.categoryMatch !== undefined) {
    if (payload.categoryMatch !== 'any' && payload.categoryMatch !== 'all') throw new Error('INVALID_PAGE_QUERY');
    query.categoryMatch = payload.categoryMatch;
  }
  if (payload.nfoTagIds !== undefined) {
    query.nfoTagIds = uuidArray(payload.nfoTagIds);
  }
  if (payload.nfoTagMatch !== undefined) {
    if (payload.nfoTagMatch !== 'any' && payload.nfoTagMatch !== 'all') throw new Error('INVALID_PAGE_QUERY');
    query.nfoTagMatch = payload.nfoTagMatch;
  }
  if (payload.genreIds !== undefined) {
    query.genreIds = uuidArray(payload.genreIds);
  }
  if (payload.genreMatch !== undefined) {
    if (payload.genreMatch !== 'any' && payload.genreMatch !== 'all') throw new Error('INVALID_PAGE_QUERY');
    query.genreMatch = payload.genreMatch;
  }
  if (payload.organizationState !== undefined) {
    if (!['all', 'organized', 'unorganized'].includes(String(payload.organizationState))) throw new Error('INVALID_PAGE_QUERY');
    query.organizationState = payload.organizationState as FilmPageQuery['organizationState'];
  }
  if (payload.minRating !== undefined) {
    query.minRating = decimalInRange(payload.minRating, 0, 10, 0, strict);
  }
  if (payload.favoriteOnly !== undefined) {
    query.favoriteOnly = booleanValue(payload.favoriteOnly, strict);
  }
  if (payload.missingOnly !== undefined) {
    query.missingOnly = booleanValue(payload.missingOnly, strict);
  }
  if (payload.recordIssue !== undefined) {
    if (!['all', 'title-mismatch', 'invalid-multipart'].includes(String(payload.recordIssue))) throw new Error('INVALID_PAGE_QUERY');
    query.recordIssue = payload.recordIssue as FilmPageQuery['recordIssue'];
  }
  if (payload.playbackCompatibility !== undefined) {
    if (!['all', 'non-native'].includes(String(payload.playbackCompatibility))) throw new Error('INVALID_PAGE_QUERY');
    query.playbackCompatibility = payload.playbackCompatibility as FilmPageQuery['playbackCompatibility'];
  }
  if (payload.allData !== undefined) {
    query.allData = booleanValue(payload.allData, strict);
  }
  if (payload.availability !== undefined) {
    if (!['all', 'available', 'partial_missing', 'missing', 'source_offline', 'source_removed', 'archived'].includes(String(payload.availability))) {
      throw new Error('INVALID_PAGE_QUERY');
    }
    query.availability = payload.availability as FilmPageQuery['availability'];
  }
  if (payload.sort !== undefined) {
    if (!['added', 'organized', 'favorite', 'played', 'recent', 'title', 'year', 'rating', 'file'].includes(String(payload.sort))) throw new Error('INVALID_PAGE_QUERY');
    query.sort = payload.sort as FilmPageQuery['sort'];
  }
  return query;
}

function uuidArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => !isUuid(id))) throw new Error('INVALID_PAGE_QUERY');
  return [...new Set(value)];
}

function integerInRange(value: unknown, min: number, max: number, fallback: number, strict: boolean): number {
  if (value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    if (strict) throw new Error('INVALID_PAGE_QUERY');
    return fallback;
  }
  if (strict && !Number.isInteger(number)) throw new Error('INVALID_PAGE_QUERY');
  if (strict && (number < min || number > max)) throw new Error('INVALID_PAGE_QUERY');
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function decimalInRange(value: unknown, min: number, max: number, fallback: number, strict: boolean): number {
  if (value === undefined || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    if (strict) throw new Error('INVALID_PAGE_QUERY');
    return fallback;
  }
  if (strict && (number < min || number > max)) throw new Error('INVALID_PAGE_QUERY');
  return Math.min(max, Math.max(min, number));
}

function booleanValue(value: unknown, strict: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (!strict) return Boolean(value);
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('INVALID_PAGE_QUERY');
}
