import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_GET_START_AT_LOGIN,
  DESKTOP_SET_START_AT_LOGIN,
  desktopStartAtLoginSchema,
  type DesktopStartAtLogin,
} from '@frequencia/shared';
import { app, ipcMain, type BrowserWindow } from 'electron';
import { config } from './config';
import { isAppUrl } from './navigation';

/** Given to the copy Windows starts at login: it stays in the notification area. */
export const HIDDEN_ARGUMENT = '--hidden';

/**
 * Name of the value under `HKCU\...\CurrentVersion\Run`. The uninstaller removes the same one
 * (`build/installer.nsh`).
 */
const RUN_NAME = 'Dispeaker';

/** Written once the app has turned the option on by itself, so a later "off" sticks. */
const DEFAULTED_FILE = 'start-at-login-defaulted';

/** Whether this copy was opened by Windows at login, and should start out of sight. */
export const startedHidden = process.argv.includes(HIDDEN_ARGUMENT);

const loginItem = () => ({ path: process.execPath, args: [HIDDEN_ARGUMENT], name: RUN_NAME });

function read(): DesktopStartAtLogin {
  if (!app.isPackaged) return { enabled: false, available: false };
  const settings = app.getLoginItemSettings(loginItem());
  // Windows can switch the entry off in its own startup list; that counts as off here too.
  return { enabled: settings.executableWillLaunchAtLogin, available: true };
}

function write(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ ...loginItem(), openAtLogin: enabled });
}

/**
 * Opening with Windows, on unless the user turns it off: friends see who is around without
 * anyone remembering to open the app. The first run of a version that knows the option turns it
 * on; from then on the choice is the user's, in the settings or in Windows' own startup list.
 */
export function serveStartAtLogin(window: BrowserWindow): void {
  if (app.isPackaged) {
    const marker = path.join(app.getPath('userData'), DEFAULTED_FILE);
    if (!existsSync(marker)) {
      write(true);
      try {
        writeFileSync(marker, '');
      } catch (error) {
        console.warn('[desktop] could not remember the start-at-login default', error);
      }
    }
  }

  const assertFromApp = (event: Electron.IpcMainInvokeEvent) => {
    const frame = event.senderFrame;
    if (!frame || frame !== window.webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      throw new Error('forbidden');
    }
  };

  ipcMain.handle(DESKTOP_GET_START_AT_LOGIN, (event) => {
    assertFromApp(event);
    return read();
  });
  ipcMain.handle(DESKTOP_SET_START_AT_LOGIN, (event, payload: unknown) => {
    assertFromApp(event);
    write(desktopStartAtLoginSchema.pick({ enabled: true }).parse(payload).enabled);
    return read();
  });
  window.once('closed', () => {
    ipcMain.removeHandler(DESKTOP_GET_START_AT_LOGIN);
    ipcMain.removeHandler(DESKTOP_SET_START_AT_LOGIN);
  });
}
