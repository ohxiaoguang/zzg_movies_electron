import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, protocol } from 'electron';
import { DatabaseManager } from './database/DatabaseManager';
import { FilmRepository } from './database/repositories/FilmRepository';
import { SettingsRepository } from './database/repositories/SettingsRepository';
import { SourceRepository } from './database/repositories/SourceRepository';
import { LanDeviceRepository } from './database/repositories/LanDeviceRepository';
import { registerIpcHandlers } from './ipc/registerIpcHandlers';
import { MediaProtocol } from './media/MediaProtocol';
import { MediaCapabilityService } from './media/MediaCapabilityService';
import { PreviewTranscoder } from './media/PreviewTranscoder';
import { ScanCoordinator } from './scanner/ScanCoordinator';
import { AppLogger } from './system/AppLogger';
import { DesktopIntegrationService } from './system/DesktopIntegrationService';
import { FileOpenService } from './system/FileOpenService';
import { createMainWindow, loadMainWindow } from './window/createMainWindow';
import { FilmLibraryReadService } from './services/FilmLibraryReadService';
import { MediaAssetService } from './services/MediaAssetService';
import { LanAuthService } from './services/LanAuthService';
import { AccountCredentialService } from './services/AccountCredentialService';
import { FilmLibraryManagementService } from './services/FilmLibraryManagementService';
import { PlaybackSessionService } from './services/PlaybackSessionService';
import { lanServerConfigurationFromSettings, LanServer } from './server/LanServer';

if (!app.isPackaged) {
  const developmentSessionDataPath = path.join(app.getPath('userData'), 'development-session-data');
  fs.mkdirSync(developmentSessionDataPath, { recursive: true });
  app.setPath('sessionData', developmentSessionDataPath);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'film-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

let database: DatabaseManager | null = null;
let applicationLogger: AppLogger | null = null;
let lanServer: LanServer | null = null;
let desktopIntegration: DesktopIntegrationService | null = null;
let showMainWindow: (() => BrowserWindow) | null = null;
let shutdownStarted = false;
let shutdownComplete = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', () => {
  showMainWindow?.();
});

app.on('child-process-gone', (_event, details) => {
  applicationLogger?.error('Child process gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
  });
});

if (hasSingleInstanceLock) void app.whenReady().then(() => {
  const logger = new AppLogger(app.getPath('logs'), { redactPaths: app.isPackaged });
  applicationLogger = logger;
  logger.info('Application started', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  });
  logger.info('Application paths resolved', {
    userDataPath: app.getPath('userData'),
    logsPath: app.getPath('logs'),
  });

  database = new DatabaseManager(path.join(app.getPath('userData'), 'film-library.db'), logger);
  const sources = new SourceRepository(database.db);
  const films = new FilmRepository(database.db);
  const settings = new SettingsRepository(database.db);
  const lanDevices = new LanDeviceRepository(database.db);
  const scan = new ScanCoordinator(database, sources, films, settings, logger);
  const fileOpen = new FileOpenService(films);
  const libraryRead = new FilmLibraryReadService(films, sources, settings);
  const mediaCapabilities = new MediaCapabilityService(() => settings.get().ffprobePath);
  const previewTranscoder = new PreviewTranscoder(
    logger,
    () => settings.get().ffprobePath,
    path.join(app.getPath('userData'), 'preview-cache'),
    mediaCapabilities,
  );
  const mediaAssets = new MediaAssetService(films, previewTranscoder);
  const playback = new PlaybackSessionService(
    mediaAssets,
    films,
    mediaCapabilities,
    logger,
    () => {
      const playbackSettings = settings.get();
      return {
        directory: playbackSettings.playbackCacheDirectory || path.join(app.getPath('userData'), 'playback-cache'),
        maxBytes: playbackSettings.playbackCacheLimitGb * 1024 * 1024 * 1024,
      };
    },
  );
  const accountCredentials = new AccountCredentialService(path.join(app.getPath('userData'), 'account-credentials.json'));
  const lanAuth = new LanAuthService(lanDevices, logger, accountCredentials);
  const management = new FilmLibraryManagementService(database, films, sources, libraryRead, scan, logger);
  const lanSettings = settings.get();
  lanServer = new LanServer(libraryRead, mediaAssets, logger, {
    version: app.getVersion(),
    databaseReady: () => Boolean(database?.db.open),
    detailPlayerSeekStepSeconds: () => settings.get().detailPlayerSeekStepSeconds,
    detailPlayerFineSeekStepSeconds: () => settings.get().detailPlayerFineSeekStepSeconds,
    configuration: lanServerConfigurationFromSettings(lanSettings),
    auth: lanAuth,
    management,
    playback,
  });
  if (lanSettings.lanServerEnabled) {
    void lanServer.start().catch((error: unknown) => {
      logger.warn('Desktop startup continuing without local web access', {
        errorCode: error instanceof Error ? error.message : 'HTTP_SERVER_ERROR',
      });
    });
  }

  logger.info('Database ready', {
    schemaVersion: database.schemaVersion,
    mediaSourceTableExists: database.hasTable('media_source'),
    sourceCount: sources.list().length,
  });

  const mediaProtocol = new MediaProtocol(
    films,
    logger,
    () => settings.get().ffprobePath,
    path.join(app.getPath('userData'), 'preview-cache'),
    previewTranscoder,
  );
  mediaProtocol.registerHandler();
  logger.info('Media protocol registered', { scheme: 'film-media' });

  let mainWindow: BrowserWindow | null = null;
  let firstWindow = true;
  let createWindow: () => BrowserWindow;
  desktopIntegration = new DesktopIntegrationService(
    logger,
    () => {
      if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
      return createWindow();
    },
    () => app.quit(),
  );
  desktopIntegration.configure(settings.get());
  const startHidden = desktopIntegration.shouldStartHidden();

  createWindow = (): BrowserWindow => {
    // Register every IPC handler before the renderer is allowed to load.
    const window = createMainWindow(logger, {
      load: false,
      showOnReady: !(firstWindow && startHidden),
    });
    firstWindow = false;
    mainWindow = window;
    desktopIntegration!.attachWindow(window);
    registerIpcHandlers({
      window,
      database: database!,
      sources,
      films,
      settings,
      libraryRead,
      management,
      lanServer: lanServer!,
      accountCredentials,
      playback,
      scan,
      fileOpen,
      logger,
      desktopIntegration: desktopIntegration!,
    });
    window.once('closed', () => {
      if (mainWindow === window) mainWindow = null;
    });
    loadMainWindow(window, logger);
    logger.info('Main window startup sequence completed');
    return window;
  };

  showMainWindow = () => desktopIntegration!.showMainWindow();
  const initialWindow = createWindow();
  if (settings.get().autoScanOnStartup) {
    initialWindow.webContents.once('did-finish-load', () => {
      try {
        scan.start({});
      } catch (error) {
        logger.warn('Automatic startup scan was not started', { error: error instanceof Error ? error.message : 'unknown' });
      }
    });
  }

  app.on('activate', () => {
    desktopIntegration?.showMainWindow();
  });
}).catch((error: unknown) => {
  applicationLogger?.error('Application startup failed', {
    error,
    stack: error instanceof Error ? error.stack : undefined,
  });
  if (applicationLogger && app.isReady() && BrowserWindow.getAllWindows().length === 0) {
    createMainWindow(applicationLogger, { load: false, failureReason: 'APPLICATION_STARTUP_FAILED' });
  }
  // Electron will surface the failure; keep the console message concise.
  console.error('Failed to start Local Film Library', error instanceof Error ? error.message : error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  applicationLogger?.info('Application quitting');
  void (async () => {
    try {
      await lanServer?.stop();
    } catch (error) {
      applicationLogger?.warn('Local web server shutdown failed', {
        errorCode: error instanceof Error ? error.message : 'HTTP_SERVER_ERROR',
      });
    } finally {
      desktopIntegration?.destroy();
      desktopIntegration = null;
      showMainWindow = null;
      database?.close();
      shutdownComplete = true;
      app.quit();
    }
  })();
});
