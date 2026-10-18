import {
  DESKTOP_CALL_ACTION,
  DESKTOP_GAME_AUDIO_DATA,
  DESKTOP_GAMES,
  DESKTOP_RUNNING_WINDOWS,
  DESKTOP_SHARE_WINDOW,
  DESKTOP_WATCH_GAMES,
  DESKTOP_GAME_AUDIO_START,
  DESKTOP_GAME_AUDIO_STOP,
  DESKTOP_GET_UPDATE,
  DESKTOP_GPU_USAGE,
  DESKTOP_INSTALL_UPDATE,
  DESKTOP_NATIVE_CAPTURE_CHOOSE,
  DESKTOP_NATIVE_CAPTURE_ENDED,
  DESKTOP_NATIVE_CAPTURE_PROBE,
  DESKTOP_NATIVE_CAPTURE_START,
  DESKTOP_NATIVE_CAPTURE_PREVIEW,
  DESKTOP_NATIVE_CAPTURE_STATS,
  DESKTOP_NATIVE_CAPTURE_STOP,
  DESKTOP_SET_CALL_STATE,
  DESKTOP_SET_CLOSE_TO_TRAY,
  DESKTOP_NOTICE_CLICKED,
  DESKTOP_SHOW_NOTICE,
  DESKTOP_GET_START_AT_LOGIN,
  DESKTOP_SET_START_AT_LOGIN,
  DESKTOP_SET_SHORTCUTS,
  DESKTOP_SHORTCUT,
  DESKTOP_UPDATE_READY,
  DESKTOP_WATCH_GPU_USAGE,
  desktopCallActionSchema,
  desktopGameAudioSchema,
  desktopGamesSchema,
  hostWindowsSchema,
  desktopGpuUsageSchema,
  desktopNativeCaptureChoiceSchema,
  desktopNativeCaptureProbeSchema,
  desktopNativeCaptureStatsSchema,
  desktopNoticeClickSchema,
  desktopShortcutEventSchema,
  desktopStartAtLoginSchema,
  desktopUpdateSchema,
  type DesktopBridge,
  type DesktopShortcutsResult,
  type DesktopUpdate,
} from '@frequencia/shared';
import { contextBridge, ipcRenderer } from 'electron';

/** The main process passes the app version as an argument: a sandboxed preload cannot ask. */
const VERSION_ARGUMENT = '--dispeaker-version=';
const version =
  process.argv
    .find((argument) => argument.startsWith(VERSION_ARGUMENT))
    ?.slice(VERSION_ARGUMENT.length) ?? '';

const bridge: DesktopBridge = {
  version,
  setShortcuts: (bindings) =>
    ipcRenderer.invoke(DESKTOP_SET_SHORTCUTS, bindings) as Promise<DesktopShortcutsResult>,
  onShortcut: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = desktopShortcutEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data.action);
    };
    ipcRenderer.on(DESKTOP_SHORTCUT, handler);
    return () => ipcRenderer.removeListener(DESKTOP_SHORTCUT, handler);
  },
  getUpdate: () => ipcRenderer.invoke(DESKTOP_GET_UPDATE) as Promise<DesktopUpdate>,
  onUpdateReady: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = desktopUpdateSchema.safeParse(payload);
      if (parsed.success && parsed.data.version) listener(parsed.data.version);
    };
    ipcRenderer.on(DESKTOP_UPDATE_READY, handler);
    return () => ipcRenderer.removeListener(DESKTOP_UPDATE_READY, handler);
  },
  installUpdate: () => ipcRenderer.invoke(DESKTOP_INSTALL_UPDATE) as Promise<void>,
  setCloseToTray: (enabled) =>
    ipcRenderer.invoke(DESKTOP_SET_CLOSE_TO_TRAY, { enabled }) as Promise<void>,
  notices: {
    show: (notice) => ipcRenderer.send(DESKTOP_SHOW_NOTICE, notice),
    onClick: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = desktopNoticeClickSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data.id);
      };
      ipcRenderer.on(DESKTOP_NOTICE_CLICKED, handler);
      return () => ipcRenderer.removeListener(DESKTOP_NOTICE_CLICKED, handler);
    },
  },
  startAtLogin: {
    get: async () =>
      desktopStartAtLoginSchema.parse(await ipcRenderer.invoke(DESKTOP_GET_START_AT_LOGIN)),
    set: async (enabled) =>
      desktopStartAtLoginSchema.parse(
        await ipcRenderer.invoke(DESKTOP_SET_START_AT_LOGIN, { enabled }),
      ),
  },
  setCallState: (state) => ipcRenderer.send(DESKTOP_SET_CALL_STATE, state),
  games: {
    watch: (added, listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = desktopGamesSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(DESKTOP_GAMES, handler);
      void ipcRenderer.invoke(DESKTOP_WATCH_GAMES, { on: true, added });
      return () => {
        ipcRenderer.removeListener(DESKTOP_GAMES, handler);
        void ipcRenderer.invoke(DESKTOP_WATCH_GAMES, { on: false, added: [] });
      };
    },
    shareWindow: (windowHandle) =>
      ipcRenderer.invoke(DESKTOP_SHARE_WINDOW, { windowHandle }) as Promise<void>,
    runningWindows: async () =>
      hostWindowsSchema.parse(await ipcRenderer.invoke(DESKTOP_RUNNING_WINDOWS)),
  },
  watchGpuUsage: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = desktopGpuUsageSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(DESKTOP_GPU_USAGE, handler);
    void ipcRenderer.invoke(DESKTOP_WATCH_GPU_USAGE, { on: true });
    return () => {
      ipcRenderer.removeListener(DESKTOP_GPU_USAGE, handler);
      void ipcRenderer.invoke(DESKTOP_WATCH_GPU_USAGE, { on: false });
    };
  },
  onCallAction: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      const parsed = desktopCallActionSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data.action);
    };
    ipcRenderer.on(DESKTOP_CALL_ACTION, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CALL_ACTION, handler);
  },
  nativeCapture: {
    // The capture engine and ffmpeg both encode Main (native-capture.ts).
    h264Profile: 'main',
    probe: async () =>
      desktopNativeCaptureProbeSchema.parse(await ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_PROBE))
        .codec,
    engineProblem: async () =>
      desktopNativeCaptureProbeSchema.parse(await ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_PROBE))
        .engineProblem ?? null,
    choose: async () =>
      desktopNativeCaptureChoiceSchema.parse(
        await ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_CHOOSE),
      ),
    start: (options) => ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_START, options) as Promise<void>,
    stop: () => ipcRenderer.invoke(DESKTOP_NATIVE_CAPTURE_STOP) as Promise<void>,
    onEnded: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(DESKTOP_NATIVE_CAPTURE_ENDED, handler);
      return () => ipcRenderer.removeListener(DESKTOP_NATIVE_CAPTURE_ENDED, handler);
    },
    onPreview: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        if (typeof payload !== 'object' || payload === null) return;
        const { width, height, data } = payload as Record<string, unknown>;
        if (
          typeof width === 'number' &&
          typeof height === 'number' &&
          data instanceof Uint8Array &&
          data.length === width * height * 4
        ) {
          listener({ width, height, data });
        }
      };
      ipcRenderer.on(DESKTOP_NATIVE_CAPTURE_PREVIEW, handler);
      return () => ipcRenderer.removeListener(DESKTOP_NATIVE_CAPTURE_PREVIEW, handler);
    },
    onStats: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        const parsed = desktopNativeCaptureStatsSchema.safeParse(payload);
        if (parsed.success) listener(parsed.data);
      };
      ipcRenderer.on(DESKTOP_NATIVE_CAPTURE_STATS, handler);
      return () => ipcRenderer.removeListener(DESKTOP_NATIVE_CAPTURE_STATS, handler);
    },
  },
  gameAudio: {
    start: async () =>
      desktopGameAudioSchema.parse(await ipcRenderer.invoke(DESKTOP_GAME_AUDIO_START)),
    stop: () => ipcRenderer.invoke(DESKTOP_GAME_AUDIO_STOP) as Promise<void>,
    onData: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        if (payload instanceof Uint8Array) listener(payload);
      };
      ipcRenderer.on(DESKTOP_GAME_AUDIO_DATA, handler);
      return () => ipcRenderer.removeListener(DESKTOP_GAME_AUDIO_DATA, handler);
    },
  },
};

contextBridge.exposeInMainWorld('dispeakerDesktop', bridge);
