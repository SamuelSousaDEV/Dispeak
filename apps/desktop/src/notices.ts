import path from 'node:path';
import {
  DESKTOP_NOTICE_CLICKED,
  DESKTOP_SHOW_NOTICE,
  desktopNoticeSchema,
  type DesktopNotice,
} from '@frequencia/shared';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { config } from './config';
import { isAppUrl } from './navigation';
import { NOTICE_CLICK, NOTICE_DONE, NOTICE_SHOW } from './notice/protocol';

const here = import.meta.dirname;

const WIDTH = 320;
const HEIGHT = 84;
/** Away from the screen's edge, above the taskbar. */
const MARGIN = 12;
/** More than this waiting means the page is busy announcing; the oldest are not news anymore. */
const MAX_WAITING = 4;

/**
 * Notices in the corner of the screen, like Steam's: a small window of its own above every
 * other program (a game in borderless full screen included), shown without taking the focus,
 * one at a time. A click brings the app forward and tells the page which notice it was.
 */
export function serveNotices(main: BrowserWindow, reveal: () => void): void {
  let window: BrowserWindow | null = null;
  let loaded: Promise<void> | null = null;
  let showing: DesktopNotice | null = null;
  const waiting: DesktopNotice[] = [];

  const open = (): BrowserWindow => {
    if (window && !window.isDestroyed()) return window;
    const created = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Clicks still arrive; the game in front keeps the keyboard.
      focusable: false,
      alwaysOnTop: true,
      backgroundColor: '#0a0a0a',
      title: 'Dispeaker',
      webPreferences: {
        preload: path.join(here, 'notice-preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    // Above full-screen windows too, which plain "always on top" sits under.
    created.setAlwaysOnTop(true, 'screen-saver');
    created.webContents.ipc.on(NOTICE_CLICK, () => {
      if (!showing) return;
      reveal();
      if (!main.isDestroyed()) {
        main.webContents.send(DESKTOP_NOTICE_CLICKED, { id: showing.id });
      }
    });
    created.webContents.ipc.on(NOTICE_DONE, () => {
      showing = null;
      created.hide();
      next();
    });
    created.once('closed', () => {
      window = null;
      loaded = null;
      showing = null;
    });
    loaded = created.loadFile(path.join(here, '..', 'static', 'notice.html'));
    window = created;
    return created;
  };

  const next = () => {
    const notice = waiting.shift();
    if (!notice) return;
    showing = notice;
    const target = open();
    void loaded?.then(() => {
      if (target.isDestroyed()) return;
      // The monitor the user looks at most: the main one, where the taskbar usually is.
      const area = screen.getPrimaryDisplay().workArea;
      target.setBounds({
        x: area.x + area.width - WIDTH - MARGIN,
        y: area.y + area.height - HEIGHT - MARGIN,
        width: WIDTH,
        height: HEIGHT,
      });
      target.webContents.send(NOTICE_SHOW, notice);
      target.showInactive();
    });
  };

  ipcMain.on(DESKTOP_SHOW_NOTICE, (event, payload: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame !== main.webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      return;
    }
    const parsed = desktopNoticeSchema.safeParse(payload);
    if (!parsed.success) return;
    const notice = parsed.data;
    // Only pictures of the app's own server are fetched.
    if (notice.picture && !isAppUrl(notice.picture, config.appUrl)) notice.picture = null;
    waiting.push(notice);
    if (waiting.length > MAX_WAITING) waiting.shift();
    if (!showing) next();
  });

  main.once('closed', () => {
    ipcMain.removeAllListeners(DESKTOP_SHOW_NOTICE);
    if (window && !window.isDestroyed()) window.destroy();
  });
}
