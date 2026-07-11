import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import type { FilmPageDto, FilmPageQuery, SettingsDto } from '../../shared/contracts';
import { DEFAULT_SETTINGS } from '../../shared/enums';

export const useLibraryStore = defineStore('library', () => {
  const pageData = ref<FilmPageDto>({ items: [], page: 1, pageSize: DEFAULT_SETTINGS.pageSize, total: 0, totalPages: 1 });
  const loading = ref(false);
  const error = ref<string | null>(null);
  const settings = ref<SettingsDto>({
    cardSize: DEFAULT_SETTINGS.cardSize,
    hoverDelayMs: DEFAULT_SETTINGS.hoverDelayMs,
    slideshowIntervalMs: DEFAULT_SETTINGS.slideshowIntervalMs,
    pageSize: DEFAULT_SETTINGS.pageSize,
    videoExtensions: [...DEFAULT_SETTINGS.videoExtensions],
    imageExtensions: [...DEFAULT_SETTINGS.imageExtensions],
    ignoredDirectories: [...DEFAULT_SETTINGS.ignoredDirectories],
    autoScanOnStartup: DEFAULT_SETTINGS.autoScanOnStartup,
    ffprobePath: '',
  });
  const filters = reactive<FilmPageQuery>({ page: 1, pageSize: DEFAULT_SETTINGS.pageSize, sort: 'recent', status: 'all' });
  const viewMode = ref<'grid' | 'table'>('grid');

  const items = computed(() => pageData.value.items);

  async function loadSettings(): Promise<void> {
    const result = await window.filmLibrary.settings.get();
    if (result.ok) {
      settings.value = result.data;
      filters.pageSize = result.data.pageSize;
    }
  }

  async function fetchPage(): Promise<void> {
    loading.value = true;
    error.value = null;
    const result = await window.filmLibrary.films.page({ ...filters });
    if (result.ok) pageData.value = result.data;
    else error.value = result.error.message;
    loading.value = false;
  }

  function setFilter<K extends keyof FilmPageQuery>(key: K, value: FilmPageQuery[K]): void {
    filters[key] = value as never;
    filters.page = 1;
  }

  function resetFilters(): void {
    Object.assign(filters, { page: 1, pageSize: settings.value.pageSize, search: '', sourceId: '', status: 'all', tag: '', genre: '', minRating: undefined, favoriteOnly: false, missingOnly: false, sort: 'recent' });
  }

  return { pageData, items, loading, error, settings, filters, viewMode, loadSettings, fetchPage, setFilter, resetFilters };
});
