import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import type { AppLogger } from '../system/AppLogger';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

interface CreateMainWindowOptions {
  load?: boolean;
  failureReason?: string;
}

export function createMainWindow(logger: AppLogger, options: CreateMainWindowOptions = {}): BrowserWindow {
  const preloadPath = path.join(__dirname, 'preload.js');
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath,
    },
  });

  let failureShown = false;
  const showFailurePage = (reason: string, errorCode?: number): void => {
    if (failureShown || window.isDestroyed()) return;
    failureShown = true;
    logger.error('Renderer failure page requested', { reason, errorCode });

    const failurePage = resolveFailurePage();
    if (failurePage) {
      void window.loadFile(failurePage, {
        query: {
          reason: reason.slice(0, 240),
          code: errorCode === undefined ? '' : String(errorCode),
        },
      }).then(() => {
        if (!window.isDestroyed() && !window.isVisible()) window.show();
      }).catch((error: unknown) => {
        logger.error('Renderer failure page could not be loaded', { error });
        void loadInlineFailurePage(window, reason, logger);
      });
      return;
    }

    void loadInlineFailurePage(window, reason, logger);
  };

  window.once('ready-to-show', () => {
    logger.info('BrowserWindow ready to show');
    if (!window.isDestroyed()) window.show();
  });
  window.on('closed', () => logger.info('BrowserWindow closed'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const devServerUrl = getDevServerUrl();
    const isDevUrl = Boolean(devServerUrl) && url.startsWith(devServerUrl!);
    const isFileUrl = url.startsWith('file://');
    if (!isDevUrl && !isFileUrl) {
      logger.warn('Renderer navigation blocked', { url });
      event.preventDefault();
    }
  });
  window.webContents.on('did-start-loading', () => logger.info('Renderer did-start-loading'));
  window.webContents.on('did-finish-load', () => {
    logger.info('Renderer did-finish-load', { url: describeUrl(window.webContents.getURL()) });
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logger.error('Renderer did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame });
    if (isMainFrame && errorCode !== -3) showFailurePage(errorDescription, errorCode);
  });
  window.webContents.on('preload-error', (_event, failedPreloadPath, error) => {
    logger.error('Renderer preload-error', { preloadPath: failedPreloadPath, error });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Renderer render-process-gone', { reason: details.reason, exitCode: details.exitCode });
    showFailurePage(`render-process-gone:${details.reason}`, details.exitCode);
  });
  window.webContents.on('unresponsive', () => logger.error('Renderer unresponsive'));
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const write = level >= 3 ? logger.error.bind(logger) : level >= 2 ? logger.warn.bind(logger) : logger.info.bind(logger);
    write('Renderer console-message', { level, message, line, sourceId });
  });

  logger.info('BrowserWindow created', {
    preloadPath,
    preloadExists: fs.existsSync(preloadPath),
    contextIsolation: true,
    sandbox: true,
  });

  if (options.failureReason) showFailurePage(options.failureReason);
  else if (options.load !== false) loadMainWindow(window, logger, showFailurePage);
  return window;
}

function loadMainWindowWithFailureHandler(
  window: BrowserWindow,
  logger: AppLogger,
  onFailure: (reason: string, errorCode?: number) => void,
): void {
  const devServerUrl = getDevServerUrl();
  const rendererName = getRendererName();
  const productionEntry = path.join(__dirname, `../renderer/${rendererName}/index.html`);
  if (!devServerUrl && !isPackaged()) {
    logger.error('Renderer development server URL missing', { rendererName });
    onFailure('DEV_SERVER_URL_MISSING');
    return;
  }
  const target = devServerUrl ?? productionEntry;
  logger.info('Renderer load requested', {
    mode: devServerUrl ? 'development' : 'production',
    rendererName,
    rendererEntry: devServerUrl ? devServerUrl : productionEntry,
    entryExists: Boolean(devServerUrl) || fs.existsSync(productionEntry),
  });

  const loadPromise = devServerUrl ? window.loadURL(devServerUrl) : window.loadFile(productionEntry);
  void loadPromise.catch((error: unknown) => {
    logger.error('Renderer load promise rejected', { target, error });
    onFailure(error instanceof Error ? error.message : 'renderer-load-rejected');
  });
}

export function loadMainWindow(window: BrowserWindow, logger: AppLogger, onFailure?: (reason: string, errorCode?: number) => void): void {
  loadMainWindowWithFailureHandler(window, logger, onFailure ?? (() => undefined));
}

function getDevServerUrl(): string | undefined {
  return typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' && MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? MAIN_WINDOW_VITE_DEV_SERVER_URL
    : undefined;
}

function isPackaged(): boolean {
  // Keep this helper separate so the dev/prod decision is explicit in logs.
  return process.defaultApp !== true;
}

function getRendererName(): string {
  return typeof MAIN_WINDOW_VITE_NAME === 'string' && MAIN_WINDOW_VITE_NAME ? MAIN_WINDOW_VITE_NAME : 'main_window';
}

function resolveFailurePage(): string | null {
  const packagedPath = path.join(__dirname, `../renderer/${getRendererName()}/failure.html`);
  if (fs.existsSync(packagedPath)) return packagedPath;
  const developmentPath = path.resolve(__dirname, '../../src/renderer/public/failure.html');
  return fs.existsSync(developmentPath) ? developmentPath : null;
}

async function loadInlineFailurePage(window: BrowserWindow, reason: string, logger: AppLogger): Promise<void> {
  if (window.isDestroyed()) return;
  const safeReason = escapeHtml(reason.slice(0, 240));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local Film Library</title><style>body{margin:0;background:#0f1117;color:#edf1f7;font:16px system-ui;padding:56px}main{max-width:720px;margin:auto;padding:32px;border:1px solid #343b4b;border-radius:16px;background:#171b25}h1{font-size:24px}p{color:#aeb8ca;line-height:1.6}button{padding:10px 16px;border:0;border-radius:8px;background:#98e3c2;color:#102018;font-weight:700;cursor:pointer}</style></head><body><main><h1>应用界面启动失败</h1><p>请打开应用日志目录查看诊断信息，然后重新启动应用。</p><p>诊断原因：${safeReason}</p><button onclick="location.reload()">重新加载</button></main></body></html>`;
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  } catch (error) {
    logger.error('Inline renderer failure page could not be loaded', { error });
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

function describeUrl(url: string): string {
  return url.startsWith('file://') ? 'file://<local-app>' : url;
}
