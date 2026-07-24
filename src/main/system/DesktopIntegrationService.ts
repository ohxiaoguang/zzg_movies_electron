import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import type { SettingsDto } from '../../shared/contracts';
import type { AppLogger } from './AppLogger';

type DesktopSettings = Pick<
  SettingsDto,
  'autoLaunchOnStartup' | 'launchToTray' | 'minimizeToTray'
>;

// Windows tray icons are most reliable when backed by raster data. SVG data URLs
// can produce an empty NativeImage in packaged builds even though Tray is created.
const TRAY_ICON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAO4SURBVFhHtVddSFNhGN6ld3nRhV3EhAoMEkqIDKLswoiSECEzoRRJSo2pqa0fqamllj+5mPtRTKtlFGJCZrtonm0ViV3Yz0UXostNSCSoi4yi7HSes+/V4/q2nc31wgM757x/3/u97/N908QqFv/zDCV6vUIC+/R/xOrz7LfNem5Y/R6vBDEEPknoNfs8eXFLCIElTCgDmaacon6oewVa3zxWJiKaPwrz1hn3KeYmepFWkCgFFshh0/jgn/yrenHbvkxx7boNXGxO3yUeqiwRL470LSXS6R2dtHmFFOZWnXTNClslY7nUbW+HF+GUFzAcduZkiw0vHshJmKZHF1BJ5j68sOBfYGhw3lvcmLaDG0AN1m9KFcvtHUvVQG+wMHwxeYUkSVFeedXDTjFJm8J1HC0KWmrZdrh+mf1COgv3r0hlegVFrDxewQllt1oCSUw5v2OhLOSy2HyebChgz1dT9lDAgjAtiNE8PmhnYZeFRu1A2QmuA8JqkkvdkyEnIFXg94oq0OpRep6hErmXzkBP3J51kPs9Eqgp6z33rSy8tHqJvfASznlGSkAHugD2NXlLGlcvFDCesG18OTDHwssJgELlEvGMlFAmAIAV8U5t00IPNrIttsHiFZLxACrlGQQjOAGC1Fji7rzDXJtg0ERU9Zsq5VMND+hQnnIwQiVAgB9QMs+WQLxQYTfe1lhm3IV4OGlp5CoHI1ICBAQBE/J85Oh1so5+qMulwYmFh3gnAHR8cHD7CqOO72cf2V4HjlvpAdQbrMiD2gTCjSpOVeiUdF9zaHBUkgFPORiREsCqI5EZqg3dwjaDBed+gsXn/oEXamY6XALh9l0JTAz0jxiqjsk8YPG7n+JFZnEB10AJXgJqOp9AdIwLjlarDVzbqBFBkzwjJZQJRDP7BBpB3d32aTk4BIxknnH9xIdIbIgEomU/AraYWDBLV1zJwgdE2gYDPuA+F84xOjta/icUGevk4NUD5q8s7LKgGTunhc9QgCLPwWqA/oJv7upJQMu4NkEplotoKOAEpNIXGevHWDi+UEMCIAyew2iAlVPw0p7rc0udH046J53VlAQmI5ZbEPiA9hyQun5+jVabyEJEFtySaDsAsJea+wKSxYSAEckWZVe18mDBXaFpbEAmKQLuDZhlBAHl7j2eL//GdtEfEcKFkb6F3LqaWuYudkEilwW7o+3d8DdlAB6w8vJ+42zOOV0zM4+v4PCq6Dc1n77T/uz8k56JWkff+7LeVlfxzQbH0Ss1pdGVWqP5C91DQSamExVSAAAAAElFTkSuQmCC';

export class DesktopIntegrationService {
  private tray: Tray | null = null;
  private settings: DesktopSettings = {
    autoLaunchOnStartup: false,
    launchToTray: false,
    minimizeToTray: false,
  };

  public constructor(
    private readonly logger: AppLogger,
    private readonly showOrCreateWindow: () => BrowserWindow,
    private readonly quitApplication: () => void,
  ) {}

  public configure(settings: DesktopSettings): void {
    this.settings = { ...settings };
    this.syncLoginItem();
    this.syncTray();
  }

  public attachWindow(window: BrowserWindow): void {
    window.on('minimize', () => {
      if (!this.settings.minimizeToTray || window.isDestroyed()) return;
      window.setSkipTaskbar(true);
      window.hide();
      this.ensureTray();
      this.logger.info('BrowserWindow minimized to tray');
    });
  }

  public shouldStartHidden(argumentsList = process.argv): boolean {
    return this.settings.autoLaunchOnStartup
      && this.settings.launchToTray
      && argumentsList.includes('--hidden');
  }

  public showMainWindow(): BrowserWindow {
    const window = this.showOrCreateWindow();
    window.setSkipTaskbar(false);
    window.setEnabled(true);
    window.setIgnoreMouseEvents(false);
    window.setFocusable(true);
    window.restore();
    window.show();
    window.moveTop();
    window.focus();
    window.webContents.focus();
    this.logger.info('BrowserWindow restored from tray', {
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      focused: window.isFocused(),
    });
    return window;
  }

  public destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private syncLoginItem(): void {
    if (
      !app.isPackaged
      || process.platform !== 'win32'
      || process.argv.includes('--disable-startup-integration')
    ) {
      return;
    }
    try {
      app.setLoginItemSettings({
        openAtLogin: this.settings.autoLaunchOnStartup,
        path: process.execPath,
        args: this.settings.autoLaunchOnStartup && this.settings.launchToTray ? ['--hidden'] : [],
      });
      this.logger.info('Windows login startup updated', {
        enabled: this.settings.autoLaunchOnStartup,
        startHidden: this.settings.autoLaunchOnStartup && this.settings.launchToTray,
      });
    } catch (error) {
      this.logger.warn('Windows login startup update failed', {
        errorCode: error instanceof Error ? error.message : 'LOGIN_ITEM_UPDATE_FAILED',
      });
    }
  }

  private syncTray(): void {
    if (this.settings.minimizeToTray || (this.settings.autoLaunchOnStartup && this.settings.launchToTray)) {
      this.ensureTray();
    } else {
      this.destroy();
    }
  }

  private ensureTray(): void {
    if (this.tray && !this.tray.isDestroyed()) return;
    const sourceIcon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'));
    const icon = sourceIcon.resize({ width: 16, height: 16, quality: 'best' });
    if (sourceIcon.isEmpty() || icon.isEmpty()) throw new Error('TRAY_ICON_UNAVAILABLE');
    this.tray = new Tray(icon);
    this.tray.setToolTip('Local Film Library');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开本地影库', click: () => this.showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => this.quitApplication() },
    ]));
    this.tray.on('click', () => this.showMainWindow());
    this.tray.on('double-click', () => this.showMainWindow());
    this.logger.info('System tray ready', { iconSize: icon.getSize() });
  }
}
