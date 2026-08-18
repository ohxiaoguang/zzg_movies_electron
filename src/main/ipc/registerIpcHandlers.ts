import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  ApiResult,
  AccountCredentialsInput,
  CreateSourceInput,
  FindDeletedSourceInput,
  RemoveSourceInput,
  RestoreSourceInput,
  SettingsUpdateInput,
  CustomCategoryReorderInput,
  UpdateSourceInput,
} from '../../shared/contracts';
import { isRecord, isUuid } from '../../shared/validation';
import {
  validateFilmSegmentCreate,
  validateFilmSegmentDelete,
  validateFilmSegmentUpdate,
} from '../../shared/filmSegmentValidation';
import {
  validateCategoryCreate,
  validateCategoryRemove,
  validateCategoryRename,
  validateFilmCategoriesUpdate,
  validateFilmFavoriteUpdate,
  validateFilmNfoImport,
  validateFilmRecordDelete,
  validateFilmRecordDeleteBatch,
  validateFilmUpdate,
  validateFilmUpdatePatch,
  validateScanStart,
} from '../../shared/filmManagementValidation';
import type { DatabaseManager } from '../database/DatabaseManager';
import { FilmRepository } from '../database/repositories/FilmRepository';
import { SettingsRepository } from '../database/repositories/SettingsRepository';
import { SourceRepository } from '../database/repositories/SourceRepository';
import { ScanCoordinator } from '../scanner/ScanCoordinator';
import { FileOpenService } from '../system/FileOpenService';
import type { AppLogger } from '../system/AppLogger';
import type { DesktopIntegrationService } from '../system/DesktopIntegrationService';
import { IPC_CHANNELS } from '../../shared/ipcChannels';
import type { FilmLibraryReadService } from '../services/FilmLibraryReadService';
import type { FilmLibraryManagementService } from '../services/FilmLibraryManagementService';
import type { AccountCredentialService } from '../services/AccountCredentialService';
import type { PlaybackSessionService } from '../services/PlaybackSessionService';
import { lanServerConfigurationFromSettings, type LanServer } from '../server/LanServer';

interface IpcContext {
  window: BrowserWindow;
  database: DatabaseManager;
  sources: SourceRepository;
  films: FilmRepository;
  settings: SettingsRepository;
  libraryRead: FilmLibraryReadService;
  management: FilmLibraryManagementService;
  lanServer: LanServer;
  accountCredentials: AccountCredentialService;
  playback: PlaybackSessionService;
  scan: ScanCoordinator;
  fileOpen: FileOpenService;
  logger: AppLogger;
  desktopIntegration: DesktopIntegrationService;
}

export function registerIpcHandlers(context: IpcContext): () => void {
  const registered: string[] = [];
  const handle = <T>(channel: string, callback: (event: IpcMainInvokeEvent, payload: unknown) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event.senderFrame?.url ?? '')) return failure('UNTRUSTED_SENDER', '请求来源不受信任');
      try {
        if (!ACCOUNT_IPC_CHANNELS.has(channel) && !context.accountCredentials.isDesktopAuthenticated(event.sender.id)) {
          const configured = context.accountCredentials.status(event.sender.id).configured;
          throw new Error(configured ? 'DESKTOP_AUTH_REQUIRED' : 'ACCOUNT_SETUP_REQUIRED');
        }
        return success(await callback(event, payload));
      } catch (error) {
        const code = error instanceof Error ? error.message : 'IPC_FAILED';
        context.logger.error('IPC handler failed', { channel, error: code });
        return failure(code, publicMessage(code));
      }
    });
    registered.push(channel);
  };

  handle(IPC_CHANNELS.accountStatus, (event) => context.accountCredentials.status(event.sender.id));
  handle(IPC_CHANNELS.accountSetup, (event, payload) => (
    context.accountCredentials.setup(validateAccountCredentials(payload), event.sender.id)
  ));
  handle(IPC_CHANNELS.accountLogin, (event, payload) => (
    context.accountCredentials.login(validateAccountCredentials(payload), event.sender.id)
  ));
  handle(IPC_CHANNELS.accountLogout, (event) => context.accountCredentials.logout(event.sender.id));

  handle(IPC_CHANNELS.sourcesList, () => context.libraryRead.listSources());
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

  handle(IPC_CHANNELS.filmsPage, (_event, payload) => context.libraryRead.page(payload));
  handle(IPC_CHANNELS.filmsNavigationCounts, () => context.libraryRead.navigationCounts());
  handle(IPC_CHANNELS.filmsExportCsv, async (_event, payload) => {
    const query = context.libraryRead.pageQuery(payload);
    const exportingFavorites = query.favoriteOnly && query.organizationState !== 'organized';
    const exported = context.management.exportCsv(query);
    const destination = await dialog.showSaveDialog(context.window, {
      title: exportingFavorites ? '导出收藏影片 CSV' : '导出已整理影片 CSV',
      defaultPath: exported.filename,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
    });
    if (destination.canceled || !destination.filePath) return { saved: false, rowCount: 0 };
    try {
      await fs.promises.writeFile(destination.filePath, exported.content, 'utf8');
    } catch {
      throw new Error('CSV_EXPORT_FAILED');
    }
    context.logger.info('Films exported to CSV', {
      scope: exportingFavorites ? 'favorite' : 'organized',
      rowCount: exported.rowCount,
    });
    return { saved: true, rowCount: exported.rowCount, filePath: destination.filePath };
  });
  handle(IPC_CHANNELS.filmsDetail, (_event, payload) => context.libraryRead.detail(payload));
  handle(IPC_CHANNELS.filmsUpdate, (_event, payload) => context.management.updateFilm(validateFilmUpdate(payload)));
  handle(IPC_CHANNELS.filmsUpdatePatch, (_event, payload) => {
    const input = validateFilmUpdatePatch(payload);
    context.logger.info('film:update-patch', { filmId: input.id, fields: Object.keys(input.patch) });
    return context.management.updateFilm({ id: input.id, ...input.patch });
  });
  handle(IPC_CHANNELS.filmsUpdateFavorite, (_event, payload) => {
    const input = validateFilmFavoriteUpdate(payload);
    return context.management.updateFavorite(input);
  });
  handle(IPC_CHANNELS.filmsUpdateCategories, (_event, payload) => {
    const input = validateFilmCategoriesUpdate(payload);
    return context.management.updateCategories(input);
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
    const candidate = isRecord(payload) && payload.mode === 'force-replace'
      ? { ...payload, confirmation: 'IMPORT_NFO_REPLACE' }
      : payload;
    return context.management.importNfo(validateFilmNfoImport(candidate));
  });
  handle(IPC_CHANNELS.filmsRescan, (_event, payload) => {
    if (!isRecord(payload) || !isUuid(payload.id)) throw new Error('INVALID_FILM_ID');
    return context.management.rescanFilm(payload.id);
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
  handle(IPC_CHANNELS.playbackSubtitleTracks, (_event, payload) => {
    if (!isUuid(payload)) throw new Error('INVALID_PART_ID');
    return context.playback.desktopSubtitleTracks(payload);
  });
  handle(IPC_CHANNELS.playbackSubtitleContent, (_event, payload) => {
    if (
      !isRecord(payload)
      || !isUuid(payload.partId)
      || !Number.isInteger(payload.index)
      || (payload.index as number) < 0
    ) {
      throw new Error('INVALID_SUBTITLE_TRACK');
    }
    return context.playback.desktopSubtitleContent(payload.partId, payload.index as number);
  });
  handle(IPC_CHANNELS.filmSegmentsCreate, (_event, payload) => (
    context.management.createSegment(validateFilmSegmentCreate(payload))
  ));
  handle(IPC_CHANNELS.filmSegmentsUpdate, (_event, payload) => (
    context.management.updateSegment(validateFilmSegmentUpdate(payload))
  ));
  handle(IPC_CHANNELS.filmSegmentsDelete, (_event, payload) => {
    context.management.deleteSegment(validateFilmSegmentDelete(payload));
    return null;
  });
  handle(IPC_CHANNELS.filmsRecordsPageAll, (_event, payload) => context.films.page({ ...context.libraryRead.pageQuery(payload), allData: true }));
  handle(IPC_CHANNELS.filmsRecordsDelete, (_event, payload) => {
    const input = validateFilmRecordDelete(payload);
    context.management.deleteRecords({ ids: [input.id], confirmation: 'DELETE_RECORDS' });
    return null;
  });
  handle(IPC_CHANNELS.filmsRecordsDeleteBatch, (_event, payload) => {
    const input = validateFilmRecordDeleteBatch(payload);
    context.management.deleteRecords({ ids: input.ids, confirmation: 'DELETE_RECORDS' });
    return null;
  });
  handle(IPC_CHANNELS.nfoTagsList, () => context.libraryRead.listTags());
  handle(IPC_CHANNELS.actorsList, () => context.libraryRead.listActors());
  handle(IPC_CHANNELS.categoriesList, () => context.libraryRead.listCategories());
  handle(IPC_CHANNELS.categoriesCreate, (_event, payload) => context.management.createCategory(validateCategoryCreate(payload)));
  handle(IPC_CHANNELS.categoriesRename, (_event, payload) => {
    const input = validateCategoryRename(payload);
    return context.management.renameCategory(input);
  });
  handle(IPC_CHANNELS.categoriesRemove, (_event, payload) => {
    context.management.removeCategory(validateCategoryRemove(payload));
    return null;
  });
  handle(IPC_CHANNELS.categoriesReorder, (_event, payload) => context.films.reorderCategories(validateCategoryReorder(payload).ids));

  handle(IPC_CHANNELS.scanStart, (_event, payload) => context.management.startScan(validateScanStart(payload)));
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
  handle(IPC_CHANNELS.lanServerStatus, () => context.lanServer.status());
  handle(IPC_CHANNELS.lanServerStart, async () => {
    const settings = context.settings.update({ lanServerEnabled: true });
    return context.lanServer.reconfigure(lanServerConfigurationFromSettings(settings));
  });
  handle(IPC_CHANNELS.lanServerStop, async () => {
    const settings = context.settings.update({ lanServerEnabled: false });
    return context.lanServer.reconfigure(lanServerConfigurationFromSettings(settings));
  });
  handle(IPC_CHANNELS.settingsGet, () => context.settings.get());
  handle(IPC_CHANNELS.settingsUpdate, async (_event, payload) => {
    const input = validateSettingsUpdate(payload);
    context.logger.info('settings:update start', { keys: Object.keys(input) });
    try {
      const result = context.settings.update(input);
      if (
        input.playbackCacheDirectory !== undefined
        || input.playbackCacheLimitGb !== undefined
      ) {
        await context.playback.applyCachePolicy();
      }
      if (
        input.autoLaunchOnStartup !== undefined
        || input.launchToTray !== undefined
        || input.minimizeToTray !== undefined
      ) {
        context.desktopIntegration.configure(result);
      }
      if (Object.keys(input).some((key) => key.startsWith('lan'))) {
        await context.lanServer.reconfigure(lanServerConfigurationFromSettings(result));
      }
      context.logger.info('settings:update success', { cardSize: result.cardSize });
      return result;
    } catch (error) {
      context.logger.error('settings:update failed', { error: error instanceof Error ? error.message : 'SETTINGS_UPDATE_FAILED' });
      throw error;
    }
  });
  handle(IPC_CHANNELS.settingsTestFfprobe, (_event, payload) => testFfprobe(validateFfprobePath(payload)));
  handle(IPC_CHANNELS.playbackCacheInfo, () => context.playback.cacheInfo());
  handle(IPC_CHANNELS.playbackCacheChooseDirectory, async () => {
    const result = await dialog.showOpenDialog(context.window, {
      title: '选择播放缓存的上级目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const selected = result.filePaths[0];
    return path.basename(selected).toLowerCase() === 'local film library playback cache'
      ? selected
      : path.join(selected, 'Local Film Library Playback Cache');
  });
  handle(IPC_CHANNELS.playbackCacheOpenDirectory, async () => {
    const cache = await context.playback.cacheInfo();
    const error = await shell.openPath(cache.directory);
    if (error) throw new Error('FOLDER_OPEN_FAILED');
    return null;
  });
  handle(IPC_CHANNELS.playbackCacheClear, () => context.playback.clearCache());

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
    INVALID_DETAIL_PLAYER_SEEK_STEP: '详情页播放器快进/快退步进必须是 1 到 60 秒之间的整数',
    INVALID_DETAIL_PLAYER_FINE_SEEK_STEP: '详情页播放器 Shift 微调步进必须在 0.01 到 5 秒之间',
    SOURCE_PATH_EXISTS: '该目录已经存在活动来源',
    CATEGORY_NOT_FOUND: '分类不存在',
    CATEGORY_EXISTS: '同名分类已经存在',
    INVALID_CATEGORY_NAME: '分类名称不能为空',
    INVALID_CATEGORY_ORDER: '分类排序数据无效',
    CSV_EXPORT_FAILED: 'CSV 导出失败，请检查保存位置后重试',
    INVALID_PART_ID: '影片分段不存在',
    INVALID_SUBTITLE_TRACK: '字幕轨道无效',
    SUBTITLE_UNSUPPORTED: '当前字幕格式暂不支持',
    INVALID_LAN_SERVER_PORT: '端口必须是 1024 到 65535 之间的整数',
    INVALID_LAN_BIND_MODE: '局域网监听模式无效',
    INVALID_LAN_SERVER_HOST: '只能指定私有 IPv4 网卡地址',
    INVALID_PLAYBACK_CACHE_LIMIT: '播放缓存上限必须是 1 到 500 GB 之间的整数',
    INVALID_PLAYBACK_CACHE_DIRECTORY: '播放缓存目录无效，请通过目录选择按钮设置应用专属缓存目录',
    PLAYBACK_CACHE_BUSY: '当前有网页播放或转码任务，停止播放后再清理缓存',
    LAN_SERVER_DISABLED: '本机网页服务尚未启用',
    EADDRINUSE: '端口已被其他程序占用',
    DATABASE_MERGE_FAILED: '数据库合并失败，请查看扫描详情和日志',
    INCOMING_FILM_FILE_DUPLICATES: '扫描候选中发现同一个影片文件被重复关联',
    ACCOUNT_SETUP_REQUIRED: '首次使用请先设置账号和密码',
    ACCOUNT_ALREADY_CONFIGURED: '账号已经设置，请直接登录',
    DESKTOP_AUTH_REQUIRED: '请先登录客户端',
    INVALID_ACCOUNT_CREDENTIALS: '账号或密码错误',
    INVALID_ACCOUNT_USERNAME: '账号不能为空，且不能超过 64 个字符',
    INVALID_ACCOUNT_PASSWORD: '密码不能为空',
    ACCOUNT_CREDENTIAL_FILE_INVALID: '账号凭据文件无效；请手动删除该文件后重新设置',
    ACCOUNT_CREDENTIAL_READ_FAILED: '无法读取账号凭据文件',
    ACCOUNT_CREDENTIAL_WRITE_FAILED: '无法写入账号凭据文件',
  };
  return messages[code] ?? '操作失败，请查看日志获取更多信息';
}

const ACCOUNT_IPC_CHANNELS = new Set<string>([
  IPC_CHANNELS.accountStatus,
  IPC_CHANNELS.accountSetup,
  IPC_CHANNELS.accountLogin,
  IPC_CHANNELS.accountLogout,
  IPC_CHANNELS.appHealth,
]);

function validateAccountCredentials(payload: unknown): AccountCredentialsInput {
  if (!isRecord(payload) || typeof payload.username !== 'string' || typeof payload.password !== 'string') {
    throw new Error('INVALID_ACCOUNT_INPUT');
  }
  return { username: payload.username, password: payload.password };
}

function isTrustedSender(url: string): boolean {
  return url.startsWith('file://') || /^https?:\/\/localhost(?::\d+)?\//.test(url);
}

function validateCreateSource(payload: unknown): CreateSourceInput {
  if (!isRecord(payload) || typeof payload.name !== 'string' || typeof payload.rootPath !== 'string') throw new Error('INVALID_SOURCE_INPUT');
  const name = payload.name.trim().slice(0, 200);
  const rootPath = payload.rootPath.trim();
  if (!name || !rootPath) throw new Error('INVALID_SOURCE_INPUT');
  return {
    name,
    rootPath,
    enabled: payload.enabled !== false,
    recursive: payload.recursive !== false,
    allowOriginalPreview: payload.allowOriginalPreview === true,
  };
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
  if (payload.allowOriginalPreview !== undefined) result.allowOriginalPreview = Boolean(payload.allowOriginalPreview);
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

function validateCategoryReorder(payload: unknown): CustomCategoryReorderInput {
  if (!isRecord(payload) || !Array.isArray(payload.ids) || payload.ids.length > 500 || payload.ids.some((id) => !isUuid(id))) throw new Error('INVALID_CATEGORY_ORDER');
  return { ids: [...new Set(payload.ids)] };
}

function validateSettingsUpdate(payload: unknown): SettingsUpdateInput {
  if (!isRecord(payload)) throw new Error('INVALID_SETTINGS');
  const input: SettingsUpdateInput = {};
  for (const key of ['cardSize', 'hoverDelayMs', 'hoverCloseDelayMs', 'slideshowIntervalMs', 'detailPlayerSeekStepSeconds', 'detailPlayerFineSeekStepSeconds', 'pageSize'] as const) {
    if (payload[key] !== undefined) input[key] = Number(payload[key]);
  }
  for (const key of ['videoExtensions', 'imageExtensions', 'ignoredDirectories'] as const) {
    if (payload[key] !== undefined) {
      if (!Array.isArray(payload[key]) || payload[key].some((item) => typeof item !== 'string')) throw new Error('INVALID_SETTINGS');
      input[key] = payload[key].slice(0, 300) as string[];
    }
  }
  if (payload.autoScanOnStartup !== undefined) input.autoScanOnStartup = Boolean(payload.autoScanOnStartup);
  if (payload.autoLaunchOnStartup !== undefined) input.autoLaunchOnStartup = Boolean(payload.autoLaunchOnStartup);
  if (payload.launchToTray !== undefined) input.launchToTray = Boolean(payload.launchToTray);
  if (payload.minimizeToTray !== undefined) input.minimizeToTray = Boolean(payload.minimizeToTray);
  if (payload.ffprobePath !== undefined) {
    if (typeof payload.ffprobePath !== 'string') throw new Error('INVALID_SETTINGS');
    input.ffprobePath = payload.ffprobePath.slice(0, 1000);
  }
  if (payload.playbackCacheDirectory !== undefined) {
    if (
      typeof payload.playbackCacheDirectory !== 'string'
      || payload.playbackCacheDirectory.length > 1000
      || (
        payload.playbackCacheDirectory.trim() !== ''
        && (
          !path.isAbsolute(payload.playbackCacheDirectory.trim())
          || path.resolve(payload.playbackCacheDirectory.trim())
            === path.parse(path.resolve(payload.playbackCacheDirectory.trim())).root
          || path.basename(path.resolve(payload.playbackCacheDirectory.trim())).toLowerCase()
            !== 'local film library playback cache'
        )
      )
    ) {
      throw new Error('INVALID_PLAYBACK_CACHE_DIRECTORY');
    }
    input.playbackCacheDirectory = payload.playbackCacheDirectory.trim();
  }
  if (payload.playbackCacheLimitGb !== undefined) {
    const limit = Number(payload.playbackCacheLimitGb);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('INVALID_PLAYBACK_CACHE_LIMIT');
    input.playbackCacheLimitGb = limit;
  }
  if (payload.lanServerEnabled !== undefined) input.lanServerEnabled = Boolean(payload.lanServerEnabled);
  if (payload.lanServerPort !== undefined) input.lanServerPort = Number(payload.lanServerPort);
  if (payload.lanServerBindMode !== undefined) {
    if (payload.lanServerBindMode !== 'localhost' && payload.lanServerBindMode !== 'lan') throw new Error('INVALID_LAN_BIND_MODE');
    input.lanServerBindMode = payload.lanServerBindMode;
  }
  if (payload.lanServerHost !== undefined) {
    if (typeof payload.lanServerHost !== 'string') throw new Error('INVALID_LAN_SERVER_HOST');
    input.lanServerHost = payload.lanServerHost.slice(0, 100);
  }
  if (payload.lanRequireAuthentication !== undefined) input.lanRequireAuthentication = Boolean(payload.lanRequireAuthentication);
  return input;
}

function validateFfprobePath(payload: unknown): string {
  if (typeof payload !== 'string' || payload.trim().length > 1000) throw new Error('INVALID_FFPROBE_PATH');
  return payload.trim();
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
