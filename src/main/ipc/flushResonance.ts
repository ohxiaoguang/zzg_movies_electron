import { randomUUID } from 'node:crypto';
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipcChannels';

export function flushResonance(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      ipcMain.removeListener(IPC_CHANNELS.resonanceFlushed, receive);
      if (error) reject(error); else resolve();
    };
    const receive = (event: IpcMainEvent, payload: { requestId?: string; ok?: boolean } | null) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || payload?.requestId !== requestId) return;
      finish(payload.ok === true ? undefined : new Error('RESONANCE_SAVE_FAILED'));
    };
    const timer = setTimeout(() => finish(new Error('RESONANCE_SAVE_TIMEOUT')), 5000);
    ipcMain.on(IPC_CHANNELS.resonanceFlushed, receive);
    window.webContents.send(IPC_CHANNELS.resonanceFlush, requestId);
  });
}
