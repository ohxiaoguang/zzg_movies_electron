import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import type { SettingsDto } from '../../shared/contracts';
import type { AppLogger } from './AppLogger';

type DesktopSettings = Pick<
  SettingsDto,
  'autoLaunchOnStartup' | 'launchToTray' | 'minimizeToTray'
>;

const TRAY_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect x="1" y="1" width="30" height="30" rx="8" fill="#141923" stroke="#98e3c2" stroke-width="2"/>
  <path d="M12 9.5 24 16 12 22.5Z" fill="#98e3c2"/>
</svg>`;

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
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
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
    const iconUrl = `data:image/svg+xml;base64,${Buffer.from(TRAY_ICON_SVG).toString('base64')}`;
    const icon = nativeImage.createFromDataURL(iconUrl).resize({ width: 16, height: 16 });
    this.tray = new Tray(icon);
    this.tray.setToolTip('Local Film Library');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开本地影库', click: () => this.showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => this.quitApplication() },
    ]));
    this.tray.on('click', () => this.showMainWindow());
    this.tray.on('double-click', () => this.showMainWindow());
    this.logger.info('System tray ready');
  }
}
