import path from 'node:path';
import { DESKTOP_SHARE_ACTION } from '@frequencia/shared';
import { app, BrowserWindow, desktopCapturer, screen, session, shell } from 'electron';
import { serveCallState } from './call-state';
import { config } from './config';
import { showDiagnostics } from './diagnostics';
import { serveGameAudio } from './game-audio';
import { serveGames, takeShareWindow } from './games';
import { serveGpuUsage } from './gpu-usage';
import { serveNativeCapture } from './native-capture';
import { isAppUrl, isExternalLink } from './navigation';
import { serveNotices } from './notices';
import { applyBackgroundSwitches, keepProcessesResponsive } from './performance';
import { pickSource } from './picker/picker';
import { noteShareShortcut, takeShortcutShare } from './share-target';
import { serveShortcuts } from './shortcuts';
import { serveStartAtLogin, startedHidden } from './startup';
import { serveThumbar } from './thumbar';
import { serveTray } from './tray';
import { serveUpdates } from './updater';

/** What the web app may ask the operating system for. Everything else is refused. */
const PERMISSIONS = new Set([
  'media',
  'display-capture',
  'notifications',
  'fullscreen',
  'clipboard-sanitized-write',
  'speaker-selection',
]);

let mainWindow: BrowserWindow | null = null;
/** Puts the main window in front, also when it is hidden in the notification area. */
let revealWindow: (() => void) | null = null;
/** The app's own screen capture for a share (the experimental native path). */
let nativeCapture: ReturnType<typeof serveNativeCapture> | null = null;

/** Handle of the window last picked for a share; `null` when it was a whole screen. */
let pickedWindow: string | null = null;

/** The main monitor as a capture source: what the native capture sends. */
async function primaryScreen() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const primary = String(screen.getPrimaryDisplay().id);
  return sources.find((source) => source.display_id === primary) ?? sources[0] ?? null;
}

/**
 * What to share: the game in front when the shortcut asked, our picker otherwise. `null` when
 * the user gives up.
 */
async function chooseSource(window: BrowserWindow) {
  // A game picked in the page (TRANSMITIR next to its name), then the shortcut, then the picker.
  const asked = await takeShareWindow();
  const shortcut = asked ? null : await takeShortcutShare();
  const source =
    asked ?? shortcut?.source ?? (await pickSource(window, { detached: shortcut !== null }));
  // On Windows a window source is named `window:<handle>:<n>`.
  if (source)
    pickedWindow = source.id.startsWith('window:') ? (source.id.split(':')[1] ?? null) : null;
  return source;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 480,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Dispeaker',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      additionalArguments: [`--dispeaker-version=${app.getVersion()}`],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The call goes on while a game covers the window.
      backgroundThrottling: false,
    },
  });
  window.removeMenu();
  // Opened by Windows at login: the app waits in the notification area, online for friends.
  if (!startedHidden) window.once('ready-to-show', () => window.show());

  const { webContents } = window;
  // The window shows the app and nothing else; other links go to the default browser.
  webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, config.appUrl)) return;
    event.preventDefault();
    if (isExternalLink(url)) void shell.openExternal(url);
  });
  // Without a menu there are no accelerators: reload and the developer tools by hand.
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const reload = input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r');
    if (reload) {
      event.preventDefault();
      if (input.shift || input.control) webContents.reloadIgnoringCache();
      else webContents.reload();
    } else if (input.key === 'F12') {
      event.preventDefault();
      webContents.toggleDevTools();
    } else if (input.control && input.shift && input.key.toLowerCase() === 'd') {
      event.preventDefault();
      void showDiagnostics(window);
    }
  });

  serveShortcuts(window, (action) => {
    if (action === DESKTOP_SHARE_ACTION) noteShareShortcut();
  });
  serveUpdates(window);
  const call = serveCallState(window);
  const reveal = serveTray(window, call);
  revealWindow = reveal;
  serveStartAtLogin(window);
  serveNotices(window, reveal);
  serveThumbar(window, call);
  serveGpuUsage(window);
  serveGames(window);
  nativeCapture = serveNativeCapture(window, () => chooseSource(window));
  serveGameAudio(window, () => pickedWindow);
  if (config.devtools) webContents.openDevTools({ mode: 'detach' });
  void window.loadURL(config.appUrl.href);
  return window;
}

function configureSession(): void {
  const { defaultSession } = session;
  const fromApp = (url: string | undefined) => url !== undefined && isAppUrl(url, config.appUrl);

  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(fromApp(webContents.getURL()) && PERMISSIONS.has(permission));
  });
  defaultSession.setPermissionCheckHandler(
    (_webContents, permission, origin) => fromApp(origin) && PERMISSIONS.has(permission),
  );

  // `getDisplayMedia` in the page ends up here: what the user picks (or already picked, when
  // the native capture left a window to the browser), then the system's audio with it.
  defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const window = mainWindow;
    if (!window || !fromApp(request.securityOrigin)) {
      callback({});
      return;
    }
    const choose = async () => {
      // The picture already goes out through the native capture. This request is the page
      // asking for the system's audio, which only comes along with a capture: any monitor
      // does, no picker.
      if (nativeCapture?.capturing()) return primaryScreen();
      return nativeCapture?.takeHandover() ?? chooseSource(window);
    };
    void choose().then(
      (source) => {
        if (!source) callback({});
        else callback({ video: source, ...(request.audioRequested ? { audio: 'loopback' } : {}) });
      },
      (error: unknown) => {
        console.error('[desktop] screen picker failed', error);
        callback({});
      },
    );
  });
}

applyBackgroundSwitches();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Opening the app again while it sits in the notification area brings it back.
    revealWindow?.();
  });

  app.on('window-all-closed', () => app.quit());

  void app.whenReady().then(() => {
    configureSession();
    mainWindow = createWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
      revealWindow = null;
      nativeCapture = null;
    });
    keepProcessesResponsive();
  });
}
