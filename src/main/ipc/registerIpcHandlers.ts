import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  ApiResult,
  CreateSourceInput,
  FilmPageQuery,
  FilmUpdateInput,
  RemoveSourceInput,
  ScanStartInput,
  SettingsUpdateInput,
  UpdateSourceInput,
} from '../../shared/contracts';
import { isFilmStatus, isRecord, isUuid } from '../../shared/validation';
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

  handle(IPC_CHANNELS.filmsPage, (_event, payload) => context.films.page(validateFilmPageQuery(payload, context.settings.get().pageSize)));
  handle(IPC_CHANNELS.filmsDetail, (_event, payload) => {
    if (!isUuid(payload)) throw new Error('INVALID_FILM_ID');
    const detail = context.films.detail(payload);
    if (!detail) throw new Error('FILM_NOT_FOUND');
    return detail;
  });
  handle(IPC_CHANNELS.filmsUpdate, (_event, payload) => context.films.update(validateFilmUpdate(payload)));
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
    if (!isRecord(payload) || !isUuid(payload.id) || (payload.mode !== 'supplement' && payload.mode !== 'force')) throw new Error('INVALID_NFO_REQUEST');
    const detail = context.films.detail(payload.id);
    if (!detail || !detail.nfoRelativePath) throw new Error('NFO_NOT_FOUND');
    const source = context.sources.findById(detail.sourceId);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    const nfoPath = await resolveExistingSafeMediaPath(source.rootPath, detail.nfoRelativePath);
    const xml = await fs.promises.readFile(nfoPath, 'utf8');
    const mapped = mapNfoMetadata(parseNfo(xml), detail.title);
    return payload.mode === 'force'
      ? context.films.forceImportNfo(detail.id, mapped, new Date().toISOString())
      : context.films.supplementFromMappedNfo(detail.id, mapped, new Date().toISOString());
  });
  handle(IPC_CHANNELS.filmsRescan, (_event, payload) => {
    if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_ID');
    const detail = context.films.detail(payload.id);
    if (!detail) throw new Error('FILM_NOT_FOUND');
    return context.scan.start({ sourceIds: [detail.sourceId] });
  });
  handle(IPC_CHANNELS.tagsList, () => context.films.listTags());

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
  handle(IPC_CHANNELS.settingsUpdate, (_event, payload) => context.settings.update(validateSettingsUpdate(payload)));
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
    INVALID_STATUS: '无效的影片状态',
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
  if (!isRecord(payload) || !isUuid(payload.id) || (payload.mode !== 'archive' && payload.mode !== 'delete')) throw new Error('INVALID_REMOVE_SOURCE');
  return { id: payload.id, mode: payload.mode };
}

function validateFilmPageQuery(payload: unknown, defaultPageSize: number): FilmPageQuery {
  if (!isRecord(payload)) throw new Error('INVALID_PAGE_QUERY');
  const page = numberInRange(payload.page, 1, 100_000, 1);
  const pageSize = numberInRange(payload.pageSize, 1, 200, defaultPageSize);
  const query: FilmPageQuery = { page, pageSize };
  for (const key of ['search', 'sourceId', 'tag', 'genre'] as const) {
    const value = payload[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || value.length > 500) throw new Error('INVALID_PAGE_QUERY');
      query[key] = value;
    }
  }
  if (payload.status !== undefined) {
    if (payload.status !== 'all' && !isFilmStatus(payload.status)) throw new Error('INVALID_PAGE_QUERY');
    query.status = payload.status;
  }
  if (payload.minRating !== undefined) query.minRating = numberInRange(payload.minRating, 0, 10, 0);
  if (payload.favoriteOnly !== undefined) query.favoriteOnly = Boolean(payload.favoriteOnly);
  if (payload.missingOnly !== undefined) query.missingOnly = Boolean(payload.missingOnly);
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
  if (payload.status !== undefined) {
    if (!isFilmStatus(payload.status)) throw new Error('INVALID_STATUS');
    input.status = payload.status;
  }
  if (payload.favorite !== undefined) input.favorite = Boolean(payload.favorite);
  if (payload.rating !== undefined) input.rating = numberInRange(payload.rating, 0, 10, 0);
  if (payload.notes !== undefined) {
    if (typeof payload.notes !== 'string') throw new Error('INVALID_FILM_UPDATE');
    input.notes = payload.notes;
  }
  if (payload.tags !== undefined) {
    if (!Array.isArray(payload.tags) || payload.tags.some((tag) => typeof tag !== 'string')) throw new Error('INVALID_FILM_UPDATE');
    input.tags = payload.tags.slice(0, 100).map((tag) => tag.trim()).filter(Boolean);
  }
  return input;
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
