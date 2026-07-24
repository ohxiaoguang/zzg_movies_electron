import type {
  CustomCategoryCreateInput,
  CustomCategoryRemoveInput,
  CustomCategoryRenameInput,
  FilmBatchUpdateInput,
  FilmCategoriesUpdateInput,
  FilmFavoriteUpdateInput,
  FilmNfoImportInput,
  FilmRecordDeleteBatchInput,
  FilmRecordDeleteConfirmedInput,
  FilmRecordDeleteInput,
  FilmTaxonomyUpdateInput,
  FilmUpdateInput,
  FilmUpdatePatchInput,
  ScanStartInput,
} from './contracts';
import { isRecord, isUuid } from './validation';

const MAX_BATCH_SIZE = 500;
const MAX_TAXONOMY_VALUES = 100;

export function validateFilmUpdate(payload: unknown): FilmUpdateInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_UPDATE');
  const input: FilmUpdateInput = { id: payload.id };
  if (payload.title !== undefined) {
    if (typeof payload.title !== 'string') throw new Error('INVALID_FILM_UPDATE');
    input.title = payload.title;
  }
  if (payload.originalTitle !== undefined) {
    if (typeof payload.originalTitle !== 'string') throw new Error('INVALID_FILM_UPDATE');
    input.originalTitle = payload.originalTitle;
  }
  if (payload.rating !== undefined) {
    const rating = Number(payload.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) throw new Error('INVALID_RATING');
    input.rating = rating;
  }
  if (payload.notes !== undefined) {
    if (typeof payload.notes !== 'string') throw new Error('INVALID_FILM_UPDATE');
    input.notes = payload.notes;
  }
  return input;
}

export function validateFilmUpdatePatch(payload: unknown): FilmUpdatePatchInput {
  if (!isRecord(payload) || !isUuid(payload.id) || !isRecord(payload.patch)) throw new Error('INVALID_FILM_UPDATE');
  const { id, ...patch } = validateFilmUpdate({ id: payload.id, ...payload.patch });
  void id;
  if (!Object.keys(patch).length) throw new Error('INVALID_FILM_UPDATE');
  return { id: payload.id, patch };
}

export function validateFilmFavoriteUpdate(payload: unknown): FilmFavoriteUpdateInput {
  if (!isRecord(payload) || !isUuid(payload.id) || typeof payload.favorite !== 'boolean') throw new Error('INVALID_FILM_UPDATE');
  return { id: payload.id, favorite: payload.favorite };
}

export function validateFilmCategoriesUpdate(payload: unknown): FilmCategoriesUpdateInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_UPDATE');
  return {
    id: payload.id,
    categoryIds: uuidList(payload.categoryIds, 'INVALID_FILM_UPDATE', MAX_TAXONOMY_VALUES),
    newCategoryNames: payload.newCategoryNames === undefined
      ? undefined
      : nameList(payload.newCategoryNames, 'INVALID_FILM_UPDATE'),
  };
}

export function validateFilmTaxonomyUpdate(payload: unknown): FilmTaxonomyUpdateInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_UPDATE');
  const input: FilmTaxonomyUpdateInput = { id: payload.id };
  if (payload.tagNames !== undefined) input.tagNames = nameList(payload.tagNames, 'INVALID_FILM_UPDATE');
  if (payload.genreNames !== undefined) input.genreNames = nameList(payload.genreNames, 'INVALID_FILM_UPDATE');
  if (payload.categoryIds !== undefined) input.categoryIds = uuidList(payload.categoryIds, 'INVALID_FILM_UPDATE', MAX_TAXONOMY_VALUES);
  if (payload.newCategoryNames !== undefined) input.newCategoryNames = nameList(payload.newCategoryNames, 'INVALID_FILM_UPDATE');
  if (Object.keys(input).length === 1) throw new Error('INVALID_FILM_UPDATE');
  return input;
}

export function validateFilmBatchUpdate(payload: unknown): FilmBatchUpdateInput {
  if (!isRecord(payload)) throw new Error('INVALID_FILM_UPDATE');
  const input: FilmBatchUpdateInput = {
    ids: uuidList(payload.ids, 'INVALID_FILM_IDS', MAX_BATCH_SIZE, true),
  };
  if (payload.favorite !== undefined) {
    if (typeof payload.favorite !== 'boolean') throw new Error('INVALID_FILM_UPDATE');
    input.favorite = payload.favorite;
  }
  if (payload.tagNames !== undefined) input.tagNames = nameList(payload.tagNames, 'INVALID_FILM_UPDATE');
  if (payload.genreNames !== undefined) input.genreNames = nameList(payload.genreNames, 'INVALID_FILM_UPDATE');
  if (payload.categoryIds !== undefined) input.categoryIds = uuidList(payload.categoryIds, 'INVALID_FILM_UPDATE', MAX_TAXONOMY_VALUES);
  if (payload.newCategoryNames !== undefined) input.newCategoryNames = nameList(payload.newCategoryNames, 'INVALID_FILM_UPDATE');
  if (Object.keys(input).length === 1) throw new Error('INVALID_FILM_UPDATE');
  return input;
}

export function validateConfirmedRecordDelete(payload: unknown): FilmRecordDeleteConfirmedInput {
  if (!isRecord(payload) || payload.confirmation !== 'DELETE_RECORDS') throw new Error('CONFIRMATION_REQUIRED');
  return {
    ids: uuidList(payload.ids, 'INVALID_FILM_IDS', MAX_BATCH_SIZE, true),
    confirmation: 'DELETE_RECORDS',
  };
}

export function validateFilmNfoImport(payload: unknown): FilmNfoImportInput {
  if (!isRecord(payload) || !isUuid(payload.id)
    || !['supplement', 'force-merge', 'force-replace'].includes(String(payload.mode))) {
    throw new Error('INVALID_NFO_REQUEST');
  }
  if (payload.mode === 'force-replace' && payload.confirmation !== 'IMPORT_NFO_REPLACE') {
    throw new Error('CONFIRMATION_REQUIRED');
  }
  return {
    id: payload.id,
    mode: payload.mode as FilmNfoImportInput['mode'],
    ...(payload.confirmation === 'IMPORT_NFO_REPLACE' ? { confirmation: payload.confirmation } : {}),
  };
}

export function validateScanStart(payload: unknown): ScanStartInput {
  if (payload === undefined || payload === null) return {};
  if (!isRecord(payload)) throw new Error('INVALID_SCAN_INPUT');
  if (payload.sourceIds === undefined) return {};
  return { sourceIds: uuidList(payload.sourceIds, 'INVALID_SCAN_INPUT', MAX_BATCH_SIZE) };
}

export function validateFilmRecordDelete(payload: unknown): FilmRecordDeleteInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_ID');
  return { id: payload.id };
}

export function validateFilmRecordDeleteBatch(payload: unknown): FilmRecordDeleteBatchInput {
  if (!isRecord(payload)) throw new Error('INVALID_FILM_IDS');
  return { ids: uuidList(payload.ids, 'INVALID_FILM_IDS', MAX_BATCH_SIZE) };
}

export function validateCategoryCreate(payload: unknown): CustomCategoryCreateInput {
  if (!isRecord(payload) || typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('INVALID_CATEGORY_NAME');
  return { name: payload.name.slice(0, 500) };
}

export function validateCategoryRename(payload: unknown): CustomCategoryRenameInput {
  if (!isRecord(payload) || !isUuid(payload.id) || typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('INVALID_CATEGORY_NAME');
  return { id: payload.id, name: payload.name.slice(0, 500) };
}

export function validateCategoryRemove(payload: unknown): CustomCategoryRemoveInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('CATEGORY_NOT_FOUND');
  return { id: payload.id };
}

function uuidList(value: unknown, errorCode: string, maximum: number, requireItems = false): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => !isUuid(item))) throw new Error(errorCode);
  const values = [...new Set(value)];
  if (requireItems && !values.length) throw new Error(errorCode);
  return values;
}

function nameList(value: unknown, errorCode: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAXONOMY_VALUES || value.some((item) => typeof item !== 'string')) {
    throw new Error(errorCode);
  }
  const names = new Map<string, string>();
  for (const rawName of value) {
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (name) names.set(name.toLocaleLowerCase(), name);
  }
  return [...names.values()];
}
