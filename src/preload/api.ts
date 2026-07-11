import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/ipcChannels';
import type {
  ApiResult,
  CreateSourceInput,
  FilmPageQuery,
  FilmUpdateInput,
  RemoveSourceInput,
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
  },
  films: {
    page: (query: FilmPageQuery) => invoke(IPC_CHANNELS.filmsPage, query),
    detail: (id: string) => invoke(IPC_CHANNELS.filmsDetail, id),
    update: (input: FilmUpdateInput) => invoke(IPC_CHANNELS.filmsUpdate, input),
    open: (id: string) => invoke(IPC_CHANNELS.filmsOpen, id),
    showInFolder: (id: string) => invoke(IPC_CHANNELS.filmsShowInFolder, id),
    importNfo: (id: string, mode: 'supplement' | 'force') => invoke(IPC_CHANNELS.filmsImportNfo, { id, mode }),
    rescan: (id: string) => invoke(IPC_CHANNELS.filmsRescan, { id }),
  },
  tags: {
    list: () => invoke(IPC_CHANNELS.tagsList),
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
