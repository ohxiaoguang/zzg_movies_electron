import path from 'node:path';
import { app, BrowserWindow, protocol } from 'electron';
import { DatabaseManager } from './database/DatabaseManager';
import { FilmRepository } from './database/repositories/FilmRepository';
import { SettingsRepository } from './database/repositories/SettingsRepository';
import { SourceRepository } from './database/repositories/SourceRepository';
import { registerIpcHandlers } from './ipc/registerIpcHandlers';
import { MediaProtocol } from './media/MediaProtocol';
import { ScanCoordinator } from './scanner/ScanCoordinator';
import { AppLogger } from './system/AppLogger';
import { FileOpenService } from './system/FileOpenService';
import { createMainWindow, loadMainWindow } from './window/createMainWindow';

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

app.on('child-process-gone', (_event, details) => {
  applicationLogger?.error('Child process gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
  });
});

void app.whenReady().then(() => {
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
  const scan = new ScanCoordinator(database, sources, films, settings, logger);
  const fileOpen = new FileOpenService(films);

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
  );
  mediaProtocol.registerHandler();
  logger.info('Media protocol registered', { scheme: 'film-media' });

  const createWindow = (): BrowserWindow => {
    // Register every IPC handler before the renderer is allowed to load.
    const mainWindow = createMainWindow(logger, { load: false });
    registerIpcHandlers({ window: mainWindow, database: database!, sources, films, settings, scan, fileOpen, logger });
    loadMainWindow(mainWindow, logger);
    logger.info('Main window startup sequence completed');
    return mainWindow;
  };

  const mainWindow = createWindow();
  if (settings.get().autoScanOnStartup) {
    mainWindow.webContents.once('did-finish-load', () => {
      try {
        scan.start({});
      } catch (error) {
        logger.warn('Automatic startup scan was not started', { error: error instanceof Error ? error.message : 'unknown' });
      }
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

app.on('before-quit', () => {
  applicationLogger?.info('Application quitting');
  database?.close();
});
