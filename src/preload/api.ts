import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/ipcChannels';
import type {
  ApiResult,
  CreateSourceInput,
  FindDeletedSourceInput,
  FilmRecordDeleteBatchInput,
  FilmRecordDeleteInput,
  FilmPageQuery,
  FilmUpdateInput,
  FilmUpdatePatch,
  FilmNfoImportMode,
  CustomCategoryCreateInput,
  CustomCategoryRenameInput,
  CustomCategoryRemoveInput,
  CustomCategoryReorderInput,
  RemoveSourceInput,
  RestoreSourceInput,
  ScanStartInput,
  SettingsUpdateInput,
  UpdateSourceInput,
} from '../shared/contracts';
import type { FilmLibraryApi } from './types';

export const filmLibraryApi: FilmLibraryApi = {
  sources: {
    list: () => invoke(IPC_CHANNELS.sourcesList),
    chooseDirectory: () => invoke(IPC_CHANNELS.sourcesChooseDirectory),
    create: (input: CreateSourceInput) => invoke(IPC_CHANNELS.sourcesCreate, input),
    update: (input: UpdateSourceInput) => invoke(IPC_CHANNELS.sourcesUpdate, input),
    remove: (input: RemoveSourceInput) => invoke(IPC_CHANNELS.sourcesRemove, input),
    restore: (input: RestoreSourceInput) => invoke(IPC_CHANNELS.sourcesRestore, input),
    findDeleted: (input: FindDeletedSourceInput) => invoke(IPC_CHANNELS.sourcesFindDeleted, input),
  },
  films: {
    page: (query: FilmPageQuery) => invoke(IPC_CHANNELS.filmsPage, query),
    navigationCounts: () => invoke(IPC_CHANNELS.filmsNavigationCounts),
    exportCsv: (query: FilmPageQuery) => invoke(IPC_CHANNELS.filmsExportCsv, query),
    detail: (id: string) => invoke(IPC_CHANNELS.filmsDetail, id),
    update: (input: FilmUpdateInput) => invoke(IPC_CHANNELS.filmsUpdate, input),
    updatePatch: (id: string, patch: FilmUpdatePatch) => invoke(IPC_CHANNELS.filmsUpdatePatch, { id, patch }),
    updateFavorite: (id: string, favorite: boolean) => invoke(IPC_CHANNELS.filmsUpdateFavorite, { id, favorite }),
    updateCategories: (id: string, categoryIds: string[], newCategoryNames: string[] = []) => invoke(IPC_CHANNELS.filmsUpdateCategories, { id, categoryIds, newCategoryNames }),
    open: (id: string) => invoke(IPC_CHANNELS.filmsOpen, id),
    showInFolder: (id: string) => invoke(IPC_CHANNELS.filmsShowInFolder, id),
    importNfo: (id: string, mode: FilmNfoImportMode) => invoke(IPC_CHANNELS.filmsImportNfo, { id, mode }),
    rescan: (id: string) => invoke(IPC_CHANNELS.filmsRescan, { id }),
    partsList: (filmId: string) => invoke(IPC_CHANNELS.filmsPartsList, filmId),
    partsOpen: (partId: string) => invoke(IPC_CHANNELS.filmsPartsOpen, partId),
    partsShowInFolder: (partId: string) => invoke(IPC_CHANNELS.filmsPartsShowInFolder, partId),
    recordsPageAll: (query: FilmPageQuery) => invoke(IPC_CHANNELS.filmsRecordsPageAll, query),
    recordsDelete: (input: FilmRecordDeleteInput) => invoke(IPC_CHANNELS.filmsRecordsDelete, input),
    recordsDeleteBatch: (input: FilmRecordDeleteBatchInput) => invoke(IPC_CHANNELS.filmsRecordsDeleteBatch, input),
  },
  nfoTags: {
    list: () => invoke(IPC_CHANNELS.nfoTagsList),
  },
  actors: {
    list: () => invoke(IPC_CHANNELS.actorsList),
  },
  categories: {
    list: () => invoke(IPC_CHANNELS.categoriesList),
    create: (input: CustomCategoryCreateInput) => invoke(IPC_CHANNELS.categoriesCreate, input),
    rename: (input: CustomCategoryRenameInput) => invoke(IPC_CHANNELS.categoriesRename, input),
    remove: (input: CustomCategoryRemoveInput) => invoke(IPC_CHANNELS.categoriesRemove, input),
    reorder: (input: CustomCategoryReorderInput) => invoke(IPC_CHANNELS.categoriesReorder, input),
  },
  scan: {
    start: (input: ScanStartInput) => invoke(IPC_CHANNELS.scanStart, input),
    cancel: () => invoke(IPC_CHANNELS.scanCancel),
    status: () => invoke(IPC_CHANNELS.scanStatus),
    onProgress: (listener) => {
      const wrapped = (_event: IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress);
      ipcRenderer.on(IPC_CHANNELS.scanProgress, wrapped);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.scanProgress, wrapped);
    },
  },
  app: {
    info: () => invoke(IPC_CHANNELS.appInfo),
    health: () => invoke(IPC_CHANNELS.appHealth),
    openDataFolder: () => invoke(IPC_CHANNELS.appOpenDataFolder),
    openLogsFolder: () => invoke(IPC_CHANNELS.appOpenLogsFolder),
  },
  settings: {
    get: () => invoke(IPC_CHANNELS.settingsGet),
    update: (input: SettingsUpdateInput) => invoke(IPC_CHANNELS.settingsUpdate, input),
    testFfprobe: (path: string) => invoke(IPC_CHANNELS.settingsTestFfprobe, path),
  },
};

function invoke<T>(channel: string, payload?: unknown): Promise<ApiResult<T>> {
  return ipcRenderer.invoke(channel, payload).catch((error: unknown) => {
    console.error(`[film-library] IPC invoke failed: ${channel}`, error);
    return {
      ok: false,
      error: { code: 'IPC_UNAVAILABLE', message: '应用内部通信失败，请查看日志' },
    } satisfies ApiResult<T>;
  });
}

contextBridge.exposeInMainWorld('filmLibrary', filmLibraryApi);
