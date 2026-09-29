import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { useLibraryStore } from '../src/renderer/stores/library';
import { LIBRARY_FILTERS_KEY, parseLibraryFilterPreferences } from '../src/shared/libraryFilterPreferences';
import { validateFilmPageQuery } from '../src/shared/filmQueryValidation';

const { page } = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('../src/renderer/api', () => ({ filmLibraryClient: { page } }));
const sourceA = '11111111-1111-4111-8111-111111111111';
const sourceB = '22222222-2222-4222-8222-222222222222';
const category = '33333333-3333-4333-8333-333333333333';
let storage: Map<string, string>;
const piniaInstances: Pinia[] = [];
const response = (total: number) => ({ ok: true, data: { items: [], page: 1, pageSize: 24, total, totalPages: 1 } });
function store() {
  const pinia = createPinia();
  piniaInstances.push(pinia);
  setActivePinia(pinia);
  return useLibraryStore();
}
beforeEach(() => {
  storage = new Map();
  page.mockReset().mockResolvedValue(response(0));
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  }, filmLibrary: { films: { recordsPageAll: page } } });
});
afterEach(() => {
  for (const pinia of piniaInstances.splice(0)) disposePinia(pinia);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('global library filters', () => {
  it('retains sources and categories across page resets and a fresh application store', async () => {
    const library = store();
    page.mockImplementation((query) => { structuredClone(query); return Promise.resolve(response(0)); });
    library.filters.sourceIds = [sourceA, sourceB];
    library.filters.categoryIds = [category];
    for (const mode of ['all', 'organized', 'unorganized', 'favorite', 'all-data']) {
      library.filters.search = 'local search';
      library.filters.actor = 'local actor';
      library.filters.nfoTagIds = [category];
      library.filters.page = 4;
      library.resetPageFilters();
      library.filters.favoriteOnly = mode === 'favorite';
      library.filters.allData = mode === 'all-data';
      if (mode === 'organized' || mode === 'unorganized') library.filters.organizationState = mode;
      await library.fetchPage();
      expect(page.mock.lastCall?.[0]).toMatchObject({ sourceIds: [sourceA, sourceB], categoryIds: [category], categoryMatch: 'all', page: 1, search: '', actor: '', nfoTagIds: [] });
    }
    const reopened = store();
    expect(reopened.filters.sourceIds).toEqual([sourceA, sourceB]);
    expect(reopened.filters.categoryIds).toEqual([category]);
    reopened.filters.sourceIds = [];
    reopened.filters.categoryIds = [];
    expect(store().filters).toMatchObject({ sourceIds: [], categoryIds: [] });
  });
  it('ignores stale responses from the previous page and snapshots source arrays', async () => {
    const library = store();
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    page.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    library.filters.sourceIds = [sourceA];
    const older = library.fetchPage();
    library.filters.sourceIds.push(sourceB);
    expect(page.mock.calls[0][0].sourceIds).toEqual([sourceA]);
    page.mockResolvedValueOnce(response(2));
    await library.fetchPage();
    resolveOld(response(99));
    await older;
    expect(library.pageData.total).toBe(2);
    expect(library.loading).toBe(false);
  });
  it('recovers malformed preferences and reports failed persistence without losing the active selection', () => {
    expect(parseLibraryFilterPreferences('{broken')).toEqual({ sourceIds: [], categoryIds: [] });
    expect(parseLibraryFilterPreferences(JSON.stringify({ sourceIds: [sourceA, sourceA, '../bad', null] }))).toEqual({ sourceIds: [sourceA], categoryIds: [] });
    const library = store();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    library.filters.sourceIds = [sourceA];
    expect(library.filters.sourceIds).toEqual([sourceA]);
    expect(library.globalFilterStorageError).toContain('保存失败');
    expect(storage.has(LIBRARY_FILTERS_KEY)).toBe(false);
  });
  it('validates and deduplicates multi-source IDs and keeps the legacy single-source query', () => {
    expect(validateFilmPageQuery({ sourceIds: [sourceA, sourceB, sourceA] }, 24, { strict: true }).sourceIds).toEqual([sourceA, sourceB]);
    expect(validateFilmPageQuery({ sourceId: sourceA }, 24, { strict: true }).sourceId).toBe(sourceA);
    for (const value of [sourceA, ['invalid'], Array(101).fill(sourceA)]) {
      expect(() => validateFilmPageQuery({ sourceIds: value }, 24)).toThrow('INVALID_PAGE_QUERY');
    }
  });
});
