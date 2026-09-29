import { isUuid } from './validation';

export const LIBRARY_FILTERS_KEY = 'local-film-library:global-filters-v1';
export interface LibraryFilterPreferences { sourceIds: string[]; categoryIds: string[] }

export function parseLibraryFilterPreferences(raw: string | null): LibraryFilterPreferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    const ids = (input: unknown): string[] => Array.isArray(input)
      ? [...new Set(input.filter((id): id is string => isUuid(id)))].slice(0, 100) : [];
    return { sourceIds: ids(value?.sourceIds), categoryIds: ids(value?.categoryIds) };
  } catch { return { sourceIds: [], categoryIds: [] }; }
}
