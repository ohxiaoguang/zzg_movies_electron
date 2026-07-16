import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  ApiResult,
  CreateSourceInput,
  FindDeletedSourceInput,
  FilmRecordDeleteBatchInput,
  FilmRecordDeleteInput,
  FilmCategoriesUpdateInput,
  FilmFavoriteUpdateInput,
  FilmPageQuery,
  FilmUpdatePatchInput,
  FilmUpdateInput,
  RemoveSourceInput,
  RestoreSourceInput,
  ScanStartInput,
  SettingsUpdateInput,
  CustomCategoryCreateInput,
  CustomCategoryRenameInput,
  CustomCategoryRemoveInput,
  CustomCategoryReorderInput,
  UpdateSourceInput,
} from '../../shared/contracts';
import { isRecord, isUuid } from '../../shared/validation';
import { parseNfo } from '../metadata/NfoParser';
import { mapNfoMetadata } from '../metadata/NfoMapper';
import type { DatabaseManager } from '../database/DatabaseManager';
import { FilmRepository } from '../database/repositories/FilmRepository';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { SourceRepository } from '../database/repositories/SourceRepository';
import { ScanCoordinator } from '../scanner/ScanCoordinator';
import { resolveExistingSafeMediaPath } from '../media/MediaPathResolver';
import { FileOpenService } from '../system/FileOpenService';
import type { AppLogger } from '../system/AppLogger';
import { IPC_CHANNELS } from '../../shared/ipcChannels';
import { buildFilmCsv } from '../export/FilmCsvExporter';

interface IpcContext {
  window: BrowserWindow;
  database: DatabaseManager;
  sources: SourceRepository;
  films: FilmRepository;
  settings: SettingsRepository;
  scan: ScanCoordinator;
  fileOpen: FileOpenService;
  logger: AppLogger;
}

export function registerIpcHandlers(context: IpcContext): () => void {
  const registered: string[] = [];
  const handle = <T>(channel: string, callback: (event: IpcMainInvokeEvent, payload: unknown) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event.senderFrame?.url ?? '')) return failure('UNTRUSTED_SENDER', '请求来源不受信任');
      try {
        return success(await callback(event, payload));
      } catch (error) {
        const code = error instanceof Error ? error.message : 'IPC_FAILED';
        context.logger.error('IPC handler failed', { channel, error: code });
        return failure(code, publicMessage(code));
      }
    });
    registered.push(channel);
  };

  handle(IPC_CHANNELS.sourcesList, () => context.sources.list());
  handle(IPC_CHANNELS.sourcesChooseDirectory, async () => {
    const result = await dialog.showOpenDialog(context.window, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC_CHANNELS.sourcesCreate, (_event, payload) => {
    const input = validateCreateSource(payload);
    context.logger.info('Source create requested', { name: input.name });
    const source = context.sources.create(input);
    context.logger.info('Source created', { sourceId: source.id, sourceCount: context.sources.list().length });
    return source;
  });
  handle(IPC_CHANNELS.sourcesUpdate, (_event, payload) => {
    const input = validateUpdateSource(payload);
    return context.sources.update(input);
  });
  handle(IPC_CHANNELS.sourcesRemove, (_event, payload) => {
    const input = validateRemoveSource(payload);
    context.database.transaction(() => context.sources.remove(input));
    return null;
  });
  handle(IPC_CHANNELS.sourcesRestore, (_event, payload) => context.sources.restore(validateRestoreSource(payload).id));
  handle(IPC_CHANNELS.sourcesFindDeleted, (_event, payload) => context.sources.findDeletedByRootPath(validateFindDeletedSource(payload).rootPath));

  handle(IPC_CHANNELS.filmsPage, (_event, payload) => context.films.page(validateFilmPageQuery(payload, context.settings.get().pageSize)));
  handle(IPC_CHANNELS.filmsNavigationCounts, () => context.films.navigationCounts());
  handle(IPC_CHANNELS.filmsExportCsv, async (_event, payload) => {
    const query = validateFilmPageQuery(payload, context.settings.get().pageSize);
    const rows = context.films.csvRows(query);
    const date = new Date().toISOString().slice(0, 10);
    const destination = await dialog.showSaveDialog(context.window, {
      title: '导出已整理影片 CSV',
      defaultPath: `已整理影片-${date}.csv`,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
    });
    if (destination.canceled || !destination.filePath) return { saved: false, rowCount: 0 };
    try {
      await fs.promises.writeFile(destination.filePath, buildFilmCsv(rows), 'utf8');
    } catch {
      throw new Error('CSV_EXPORT_FAILED');
    }
    context.logger.info('Organized films exported to CSV', { rowCount: rows.length });
    return { saved: true, rowCount: rows.length, filePath: destination.filePath };
  });
  handle(IPC_CHANNELS.filmsDetail, (_event, payload) => {
    if (!isUuid(payload)) throw new Error('INVALID_FILM_ID');
    const detail = context.films.detail(payload);
    if (!detail) throw new Error('FILM_NOT_FOUND');
    return detail;
  });
  handle(IPC_CHANNELS.filmsUpdate, (_event, payload) => context.films.update(validateFilmUpdate(payload)));
  handle(IPC_CHANNELS.filmsUpdatePatch, (_event, payload) => {
    const input = validateFilmUpdatePatch(payload);
    context.logger.info('film:update-patch', { filmId: input.id, fields: Object.keys(input.patch) });
    return context.films.updatePatch({ id: input.id, ...input.patch });
  });
  handle(IPC_CHANNELS.filmsUpdateFavorite, (_event, payload) => {
    const input = validateFilmFavoriteUpdate(payload);
    return context.films.updateFavorite(input.id, input.favorite);
  });
  handle(IPC_CHANNELS.filmsUpdateCategories, (_event, payload) => {
    const input = validateFilmCategoriesUpdate(payload);
    return context.films.updateCategories(input.id, input.categoryIds, input.newCategoryNames);
  });
  handle(IPC_CHANNELS.filmsOpen, async (_event, payload) => {
    if (!isUuid(payload)) throw new Error('INVALID_FILM_ID');
    await context.fileOpen.openFilm(payload);
    return null;
  });
  handle(IPC_CHANNELS.filmsShowInFolder, async (_event, payload) => {
    if (!isUuid(payload)) throw new Error('INVALID_FILM_ID');
    await context.fileOpen.showFilmInFolder(payload);
    return null;
  });
  handle(IPC_CHANNELS.filmsImportNfo, async (_event, payload) => {
    if (!isRecord(payload) || !isUuid(payload.id) || !['supplement', 'force-merge', 'force-replace'].includes(String(payload.mode))) throw new Error('INVALID_NFO_REQUEST');
    const detail = context.films.detail(payload.id);
    if (!detail || !detail.nfoRelativePath) throw new Error('NFO_NOT_FOUND');
    const source = context.sources.findById(detail.sourceId);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    const nfoPath = await resolveExistingSafeMediaPath(source.rootPath, detail.nfoRelativePath);
    const xml = await fs.promises.readFile(nfoPath, 'utf8');
    const mapped = mapNfoMetadata(parseNfo(xml), detail.title);
    return payload.mode === 'supplement'
      ? context.films.supplementFromMappedNfo(detail.id, mapped, new Date().toISOString())
      : context.films.forceImportNfo(detail.id, mapped, new Date().toISOString(), payload.mode === 'force-merge' ? 'merge' : 'replace');
  });
  handle(IPC_CHANNELS.filmsRescan, (_event, payload) => {
    if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_ID');
    const detail = context.films.detail(payload.id);
    if (!detail) throw new Error('FILM_NOT_FOUND');
    return context.scan.start({ sourceIds: [detail.sourceId] });
  });
  handle(IPC_CHANNELS.filmsPartsList, (_event, payload) => {
    if (!isUuid(payload)) throw new Error('INVALID_FILM_ID');
    return context.films.parts(payload);
  });
  handle(IPC_CHANNELS.filmsPartsOpen, async (_event, payload) => {
    if (!isUuid(payload)) throw new Error('INVALID_PART_ID');
    await context.fileOpen.openPart(payload);
    return null;
  });
  handle(IPC_CHANNELS.filmsPartsShowInFolder, async (_event, payload) => {
    if (!isUuid(payload)) throw new Error('INVALID_PART_ID');
    await context.fileOpen.showPartInFolder(payload);
    return null;
  });
  handle(IPC_CHANNELS.filmsRecordsPageAll, (_event, payload) => context.films.page({ ...validateFilmPageQuery(payload, context.settings.get().pageSize), allData: true }));
  handle(IPC_CHANNELS.filmsRecordsDelete, (_event, payload) => {
    const input = validateFilmRecordDelete(payload);
    context.films.deleteRecords([input.id]);
    return null;
  });
  handle(IPC_CHANNELS.filmsRecordsDeleteBatch, (_event, payload) => {
    const input = validateFilmRecordDeleteBatch(payload);
    context.films.deleteRecords(input.ids);
    return null;
  });
  handle(IPC_CHANNELS.nfoTagsList, () => context.films.listTags());
  handle(IPC_CHANNELS.actorsList, () => context.films.listActors());
  handle(IPC_CHANNELS.categoriesList, () => context.films.listCategories());
  handle(IPC_CHANNELS.categoriesCreate, (_event, payload) => context.films.createCategory(validateCategoryCreate(payload).name));
  handle(IPC_CHANNELS.categoriesRename, (_event, payload) => {
    const input = validateCategoryRename(payload);
    return context.films.renameCategory(input.id, input.name);
  });
  handle(IPC_CHANNELS.categoriesRemove, (_event, payload) => {
    context.films.removeCategory(validateCategoryRemove(payload).id);
    return null;
  });
  handle(IPC_CHANNELS.categoriesReorder, (_event, payload) => context.films.reorderCategories(validateCategoryReorder(payload).ids));

  handle(IPC_CHANNELS.scanStart, (_event, payload) => context.scan.start(validateScanStart(payload)));
  handle(IPC_CHANNELS.scanCancel, () => {
    context.scan.cancel();
    return null;
  });
  handle(IPC_CHANNELS.scanStatus, () => context.scan.status());

  handle(IPC_CHANNELS.appInfo, () => ({
    version: app.getVersion(),
    dataDirectory: app.getPath('userData'),
    databasePath: context.database.databasePath,
    logsDirectory: app.getPath('logs'),
  }));
  handle(IPC_CHANNELS.appHealth, () => {
    const health = {
      ok: true as const,
      appVersion: app.getVersion(),
      databaseReady: context.database.db.open,
      ipcReady: true,
    };
    context.logger.info('Renderer health check passed', health);
    return health;
  });
  handle(IPC_CHANNELS.appOpenDataFolder, async () => {
    const error = await shell.openPath(app.getPath('userData'));
    if (error) throw new Error('FOLDER_OPEN_FAILED');
    return null;
  });
  handle(IPC_CHANNELS.appOpenLogsFolder, async () => {
    const error = await shell.openPath(app.getPath('logs'));
    if (error) throw new Error('FOLDER_OPEN_FAILED');
    return null;
  });

  handle(IPC_CHANNELS.settingsGet, () => context.settings.get());
  handle(IPC_CHANNELS.settingsUpdate, (_event, payload) => {
    const input = validateSettingsUpdate(payload);
    context.logger.info('settings:update start', { keys: Object.keys(input) });
    try {
      const result = context.settings.update(input);
      context.logger.info('settings:update success', { cardSize: result.cardSize });
      return result;
    } catch (error) {
      context.logger.error('settings:update failed', { error: error instanceof Error ? error.message : 'SETTINGS_UPDATE_FAILED' });
      throw error;
    }
  });
  handle(IPC_CHANNELS.settingsTestFfprobe, (_event, payload) => testFfprobe(validateFfprobePath(payload)));

  const removeProgressListener = context.scan.onProgress((progress) => {
    if (!context.window.isDestroyed()) context.window.webContents.send(IPC_CHANNELS.scanProgress, progress);
  });
  const cleanup = (): void => {
    removeProgressListener();
    for (const channel of registered) ipcMain.removeHandler(channel);
  };
  context.window.once('closed', cleanup);
  context.logger.info('IPC handlers registered', { count: registered.length });
  return cleanup;
}

function success<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function failure(code: string, message: string): ApiResult<never> {
  return { ok: false, error: { code, message } };
}

function publicMessage(code: string): string {
  const messages: Record<string, string> = {
    SOURCE_NOT_FOUND: '影片来源不存在',
    FILM_NOT_FOUND: '影片不存在',
    NFO_NOT_FOUND: '没有找到可读取的 NFO',
    SOURCE_OFFLINE: '影片来源当前离线',
    SCAN_ALREADY_RUNNING: '已有扫描任务正在运行',
    INVALID_RATING: '评分必须在 0 到 10 之间',
    TITLE_REQUIRED: '标题不能为空',
    FILE_OPEN_FAILED: '无法打开原始影片',
    FILM_MISSING: '原始影片文件不存在',
    INVALID_CARD_SIZE: '卡片宽度必须在 140 到 320 像素之间',
    SOURCE_PATH_EXISTS: '该目录已经存在活动来源',
    CATEGORY_NOT_FOUND: '分类不存在',
    CATEGORY_EXISTS: '同名分类已经存在',
    INVALID_CATEGORY_NAME: '分类名称不能为空',
    INVALID_CATEGORY_ORDER: '分类排序数据无效',
    CSV_EXPORT_FAILED: 'CSV 导出失败，请检查保存位置后重试',
    INVALID_PART_ID: '影片分段不存在',
    DATABASE_MERGE_FAILED: '数据库合并失败，请查看扫描详情和日志',
    INCOMING_FILM_FILE_DUPLICATES: '扫描候选中发现同一个影片文件被重复关联',
  };
  return messages[code] ?? '操作失败，请查看日志获取更多信息';
}

function isTrustedSender(url: string): boolean {
  return url.startsWith('file://') || /^https?:\/\/localhost(?::\d+)?\//.test(url);
}

function validateCreateSource(payload: unknown): CreateSourceInput {
  if (!isRecord(payload) || typeof payload.name !== 'string' || typeof payload.rootPath !== 'string') throw new Error('INVALID_SOURCE_INPUT');
  const name = payload.name.trim().slice(0, 200);
  const rootPath = payload.rootPath.trim();
  if (!name || !rootPath) throw new Error('INVALID_SOURCE_INPUT');
  return { name, rootPath, enabled: payload.enabled !== false, recursive: payload.recursive !== false };
}

function validateUpdateSource(payload: unknown): UpdateSourceInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_SOURCE_INPUT');
  const result: UpdateSourceInput = { id: payload.id };
  if (payload.name !== undefined) {
    if (typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('INVALID_SOURCE_INPUT');
    result.name = payload.name.trim().slice(0, 200);
  }
  if (payload.rootPath !== undefined) {
    if (typeof payload.rootPath !== 'string' || !payload.rootPath.trim()) throw new Error('INVALID_SOURCE_INPUT');
    result.rootPath = payload.rootPath.trim();
  }
  if (payload.enabled !== undefined) result.enabled = Boolean(payload.enabled);
  if (payload.recursive !== undefined) result.recursive = Boolean(payload.recursive);
  return result;
}

function validateRemoveSource(payload: unknown): RemoveSourceInput {
  if (!isRecord(payload) || !isUuid(payload.id) || (payload.mode !== 'keep-records' && payload.mode !== 'delete-records')) throw new Error('INVALID_REMOVE_SOURCE');
  return { id: payload.id, mode: payload.mode };
}

function validateRestoreSource(payload: unknown): RestoreSourceInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_SOURCE_INPUT');
  return { id: payload.id };
}

function validateFindDeletedSource(payload: unknown): FindDeletedSourceInput {
  if (!isRecord(payload) || typeof payload.rootPath !== 'string' || !payload.rootPath.trim()) throw new Error('INVALID_SOURCE_INPUT');
  return { rootPath: payload.rootPath.trim() };
}

function validateFilmRecordDelete(payload: unknown): FilmRecordDeleteInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_ID');
  return { id: payload.id };
}

function validateFilmRecordDeleteBatch(payload: unknown): FilmRecordDeleteBatchInput {
  if (!isRecord(payload) || !Array.isArray(payload.ids) || payload.ids.length > 500 || payload.ids.some((id) => !isUuid(id))) throw new Error('INVALID_FILM_IDS');
  return { ids: [...new Set(payload.ids)] };
}

function validateCategoryCreate(payload: unknown): CustomCategoryCreateInput {
  if (!isRecord(payload) || typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('INVALID_CATEGORY_NAME');
  return { name: payload.name.slice(0, 500) };
}

function validateCategoryRename(payload: unknown): CustomCategoryRenameInput {
  if (!isRecord(payload) || !isUuid(payload.id) || typeof payload.name !== 'string' || !payload.name.trim()) throw new Error('INVALID_CATEGORY_NAME');
  return { id: payload.id, name: payload.name.slice(0, 500) };
}

function validateCategoryRemove(payload: unknown): CustomCategoryRemoveInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('CATEGORY_NOT_FOUND');
  return { id: payload.id };
}

function validateCategoryReorder(payload: unknown): CustomCategoryReorderInput {
  if (!isRecord(payload) || !Array.isArray(payload.ids) || payload.ids.length > 500 || payload.ids.some((id) => !isUuid(id))) throw new Error('INVALID_CATEGORY_ORDER');
  return { ids: [...new Set(payload.ids)] };
}

function validateFilmPageQuery(payload: unknown, defaultPageSize: number): FilmPageQuery {
  if (!isRecord(payload)) throw new Error('INVALID_PAGE_QUERY');
  const page = numberInRange(payload.page, 1, 100_000, 1);
  const pageSize = numberInRange(payload.pageSize, 1, 200, defaultPageSize);
  const query: FilmPageQuery = { page, pageSize };
  for (const key of ['search', 'sourceId', 'actor'] as const) {
    const value = payload[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 500) throw new Error('INVALID_PAGE_QUERY');
      query[key] = value;
    }
  }
  if (payload.categoryIds !== undefined) {
    if (!Array.isArray(payload.categoryIds) || payload.categoryIds.length > 100 || payload.categoryIds.some((id) => !isUuid(id))) throw new Error('INVALID_PAGE_QUERY');
    query.categoryIds = [...new Set(payload.categoryIds)];
  }
  if (payload.categoryMatch !== undefined) {
    if (payload.categoryMatch !== 'any' && payload.categoryMatch !== 'all') throw new Error('INVALID_PAGE_QUERY');
    query.categoryMatch = payload.categoryMatch;
  }
  if (payload.nfoTagIds !== undefined) {
    if (!Array.isArray(payload.nfoTagIds) || payload.nfoTagIds.length > 100 || payload.nfoTagIds.some((id) => !isUuid(id))) throw new Error('INVALID_PAGE_QUERY');
    query.nfoTagIds = [...new Set(payload.nfoTagIds)];
  }
  if (payload.nfoTagMatch !== undefined) {
    if (payload.nfoTagMatch !== 'any' && payload.nfoTagMatch !== 'all') throw new Error('INVALID_PAGE_QUERY');
    query.nfoTagMatch = payload.nfoTagMatch;
  }
  if (payload.organizationState !== undefined) {
    if (!['all', 'organized', 'unorganized'].includes(String(payload.organizationState))) throw new Error('INVALID_PAGE_QUERY');
    query.organizationState = payload.organizationState as FilmPageQuery['organizationState'];
  }
  if (payload.minRating !== undefined) query.minRating = numberInRange(payload.minRating, 0, 10, 0);
  if (payload.favoriteOnly !== undefined) query.favoriteOnly = Boolean(payload.favoriteOnly);
  if (payload.missingOnly !== undefined) query.missingOnly = Boolean(payload.missingOnly);
  if (payload.allData !== undefined) query.allData = Boolean(payload.allData);
  if (payload.availability !== undefined) {
    if (!['all', 'available', 'partial_missing', 'missing', 'source_offline', 'source_removed', 'archived'].includes(String(payload.availability))) throw new Error('INVALID_PAGE_QUERY');
    query.availability = payload.availability as FilmPageQuery['availability'];
  }
  if (payload.sort !== undefined) {
    if (!['recent', 'title', 'year', 'rating', 'file'].includes(String(payload.sort))) throw new Error('INVALID_PAGE_QUERY');
    query.sort = payload.sort as FilmPageQuery['sort'];
  }
  return query;
}

function validateFilmUpdate(payload: unknown): FilmUpdateInput {
  if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_UPDATE');
  const input: FilmUpdateInput = { id: payload.id };
  if (payload.title !== undefined && typeof payload.title !== 'string') throw new Error('INVALID_FILM_UPDATE');
  if (payload.title !== undefined) input.title = payload.title;
  if (payload.originalTitle !== undefined) {
    if (typeof payload.originalTitle !== 'string') throw new Error('INVALID_FILM_UPDATE');
    input.originalTitle = payload.originalTitle;
  }
  if (payload.rating !== undefined) input.rating = decimalInRange(payload.rating, 0, 10, 0);
  if (payload.notes !== undefined) {
    if (typeof payload.notes !== 'string') throw new Error('INVALID_FILM_UPDATE');
    input.notes = payload.notes;
  }
  return input;
}

function validateFilmFavoriteUpdate(payload: unknown): FilmFavoriteUpdateInput {
  if (!isRecord(payload) || !isUuid(payload.id) || typeof payload.favorite !== 'boolean') throw new Error('INVALID_FILM_UPDATE');
  return { id: payload.id, favorite: payload.favorite };
}

function validateFilmCategoriesUpdate(payload: unknown): FilmCategoriesUpdateInput {
  if (!isRecord(payload) || !isUuid(payload.id) || !Array.isArray(payload.categoryIds) || payload.categoryIds.length > 100 || payload.categoryIds.some((id) => !isUuid(id))) throw new Error('INVALID_FILM_UPDATE');
  if (payload.newCategoryNames !== undefined && (!Array.isArray(payload.newCategoryNames) || payload.newCategoryNames.length > 100 || payload.newCategoryNames.some((name) => typeof name !== 'string'))) throw new Error('INVALID_FILM_UPDATE');
  return {
    id: payload.id,
    categoryIds: [...new Set(payload.categoryIds)],
    newCategoryNames: payload.newCategoryNames?.map((name) => name.trim()).filter(Boolean),
  };
}

function validateFilmUpdatePatch(payload: unknown): FilmUpdatePatchInput {
  if (!isRecord(payload) || !isUuid(payload.id) || !isRecord(payload.patch)) throw new Error('INVALID_FILM_UPDATE');
  const { id, ...patch } = validateFilmUpdate({ id: payload.id, ...payload.patch });
  void id;
  return { id: payload.id, patch };
}

function validateScanStart(payload: unknown): ScanStartInput {
  if (!isRecord(payload)) return {};
  if (payload.sourceIds === undefined) return {};
  if (!Array.isArray(payload.sourceIds) || payload.sourceIds.some((id) => !isUuid(id))) throw new Error('INVALID_SCAN_INPUT');
  return { sourceIds: [...new Set(payload.sourceIds)] };
}

function validateSettingsUpdate(payload: unknown): SettingsUpdateInput {
  if (!isRecord(payload)) throw new Error('INVALID_SETTINGS');
  const input: SettingsUpdateInput = {};
  for (const key of ['cardSize', 'hoverDelayMs', 'slideshowIntervalMs', 'pageSize'] as const) {
    if (payload[key] !== undefined) input[key] = Number(payload[key]);
  }
  for (const key of ['videoExtensions', 'imageExtensions', 'ignoredDirectories'] as const) {
    if (payload[key] !== undefined) {
      if (!Array.isArray(payload[key]) || payload[key].some((item) => typeof item !== 'string')) throw new Error('INVALID_SETTINGS');
      input[key] = payload[key].slice(0, 300) as string[];
    }
  }
  if (payload.autoScanOnStartup !== undefined) input.autoScanOnStartup = Boolean(payload.autoScanOnStartup);
  if (payload.ffprobePath !== undefined) {
    if (typeof payload.ffprobePath !== 'string') throw new Error('INVALID_SETTINGS');
    input.ffprobePath = payload.ffprobePath.slice(0, 1000);
  }
  return input;
}

function validateFfprobePath(payload: unknown): string {
  if (typeof payload !== 'string' || payload.trim().length > 1000) throw new Error('INVALID_FFPROBE_PATH');
  return payload.trim();
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function decimalInRange(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function testFfprobe(ffprobePath: string): Promise<{ ok: boolean; message: string; version: string | null }> {
  const executable = ffprobePath || 'ffprobe';
  return new Promise((resolve) => {
    const child = spawn(executable, ['-version'], { shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8').slice(0, 2000);
    });
    child.on('error', () => resolve({ ok: false, message: 'ffprobe 不可用', version: null }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, message: 'ffprobe 返回错误', version: null });
      const version = output.match(/ffprobe version\s+([^\s]+)/i)?.[1] ?? null;
      resolve({ ok: true, message: 'ffprobe 可用', version });
    });
  });
}
