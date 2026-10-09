import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { FilmPageDto, FilmPageQuery, SettingsDto } from '../../shared/contracts';
import { DEFAULT_SETTINGS } from '../../shared/enums';
import { filmLibraryClient } from '../api';
import { LIBRARY_FILTERS_KEY, parseLibraryFilterPreferences } from '../../shared/libraryFilterPreferences';

export const useLibraryStore = defineStore('library', () => {
  const pageData = ref<FilmPageDto>({ items: [], page: 1, pageSize: DEFAULT_SETTINGS.pageSize, total: 0, totalPages: 1 });
  const loading = ref(false);
  const error = ref<string | null>(null);
  const settings = ref<SettingsDto>({
    slackingMode: DEFAULT_SETTINGS.slackingMode,
    slackingScalePercent: DEFAULT_SETTINGS.slackingScalePercent,
    subtitleFontSizePx: DEFAULT_SETTINGS.subtitleFontSizePx,
    cardSize: DEFAULT_SETTINGS.cardSize,
    hoverDelayMs: DEFAULT_SETTINGS.hoverDelayMs,
    hoverCloseDelayMs: DEFAULT_SETTINGS.hoverCloseDelayMs,
    slideshowIntervalMs: DEFAULT_SETTINGS.slideshowIntervalMs,
    detailPlayerSeekStepSeconds: DEFAULT_SETTINGS.detailPlayerSeekStepSeconds,
    detailPlayerFineSeekStepSeconds: DEFAULT_SETTINGS.detailPlayerFineSeekStepSeconds,
    pageSize: DEFAULT_SETTINGS.pageSize,
    videoExtensions: [...DEFAULT_SETTINGS.videoExtensions],
    imageExtensions: [...DEFAULT_SETTINGS.imageExtensions],
    ignoredDirectories: [...DEFAULT_SETTINGS.ignoredDirectories],
    autoScanOnStartup: DEFAULT_SETTINGS.autoScanOnStartup,
    autoLaunchOnStartup: DEFAULT_SETTINGS.autoLaunchOnStartup,
    launchToTray: DEFAULT_SETTINGS.launchToTray,
    minimizeToTray: DEFAULT_SETTINGS.minimizeToTray,
    ffprobePath: '',
    playbackCacheDirectory: DEFAULT_SETTINGS.playbackCacheDirectory,
    playbackCacheLimitGb: DEFAULT_SETTINGS.playbackCacheLimitGb,
    lanServerEnabled: DEFAULT_SETTINGS.lanServerEnabled,
    lanServerPort: DEFAULT_SETTINGS.lanServerPort,
    lanServerBindMode: DEFAULT_SETTINGS.lanServerBindMode,
    lanServerHost: DEFAULT_SETTINGS.lanServerHost,
    lanRequireAuthentication: DEFAULT_SETTINGS.lanRequireAuthentication,
  });
  const filters = reactive<FilmPageQuery>({ page: 1, pageSize: DEFAULT_SETTINGS.pageSize, sort: 'added', organizationState: 'all', sourceIds: [], categoryIds: [], categoryMatch: 'all', nfoTagIds: [], nfoTagMatch: 'any', commentImages: 'all', allData: false, duplicateFilenameOnly: false, availability: 'all' });
  const viewMode = ref<'grid' | 'table'>('grid');
  const globalFilterStorageError = ref('');
  try { Object.assign(filters, parseLibraryFilterPreferences(window.localStorage.getItem(LIBRARY_FILTERS_KEY))); }
  catch { globalFilterStorageError.value = '无法读取已保存的筛选'; }
  watch(() => [filters.sourceIds, filters.categoryIds], () => {
    try {
      window.localStorage.setItem(LIBRARY_FILTERS_KEY, JSON.stringify({ sourceIds: filters.sourceIds ?? [], categoryIds: filters.categoryIds ?? [] }));
      globalFilterStorageError.value = '';
    } catch { globalFilterStorageError.value = '筛选保存失败，重启后可能无法保留'; }
  }, { deep: true, flush: 'sync' });
  let latestRequest = 0;

  const items = computed(() => pageData.value.items);

  async function loadSettings(): Promise<void> {
    const result = await window.filmLibrary.settings.get();
    if (result.ok) {
      settings.value = result.data;
      filters.pageSize = result.data.pageSize;
    }
  }

  async function fetchPage(): Promise<void> {
    const request = ++latestRequest;
    loading.value = true;
    error.value = null;
    try {
      const query = {
        ...filters,
        sourceIds: filters.sourceIds ? [...filters.sourceIds] : [],
        categoryIds: filters.categoryIds ? [...filters.categoryIds] : [],
        nfoTagIds: filters.nfoTagIds ? [...filters.nfoTagIds] : [],
        genreIds: filters.genreIds ? [...filters.genreIds] : [],
      };
      const result = query.allData
        ? await window.filmLibrary.films.recordsPageAll(query)
        : await filmLibraryClient.page(query);
      if (request !== latestRequest) return;
      if (result.ok) pageData.value = result.data;
      else error.value = result.error.message;
    } catch (reason) {
      console.error('[library] page failed', reason);
      if (request === latestRequest) error.value = '无法加载影片，请查看日志';
    } finally {
      if (request === latestRequest) loading.value = false;
    }
  }

  function setFilter<K extends keyof FilmPageQuery>(key: K, value: FilmPageQuery[K]): void {
    filters[key] = value as never;
    filters.page = 1;
  }

  function resetPageFilters(): void {
    // Sources and custom categories are shared across library pages and survive navigation.
    Object.assign(filters, { page: 1, pageSize: settings.value.pageSize, search: '', sourceId: '', actor: '', organizationState: 'all', categoryMatch: 'all', nfoTagIds: [], nfoTagMatch: 'any', genreIds: [], genreMatch: 'any', minRating: undefined, favoriteOnly: false, commentImages: 'all', missingOnly: false, recordIssue: undefined, playbackCompatibility: undefined, allData: false, duplicateFilenameOnly: false, availability: 'all', sort: 'added' });
  }

  return { pageData, items, loading, error, settings, filters, globalFilterStorageError, viewMode, loadSettings, fetchPage, setFilter, resetPageFilters };
});
