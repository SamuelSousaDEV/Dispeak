import { z } from 'zod';
import { runningGameSchema, type RunningWindow } from './native-host';
import {
  ingestCodecSchema,
  voiceIngestSchema,
  type IngestCodec,
  type IngestProfile,
} from './signaling/voice';

/**
 * What the desktop app (Electron) and the web page it shows say to each other. The page is the
 * same one a browser gets; `window.dispeakerDesktop` exists only inside the app.
 */

/** Page → app: the shortcuts that should work while another program has the focus. */
export const DESKTOP_SET_SHORTCUTS = 'desktop:set-shortcuts';
/** App → page: one of those shortcuts was pressed. */
export const DESKTOP_SHORTCUT = 'desktop:shortcut';

/** Page → app: is a downloaded update waiting? */
export const DESKTOP_GET_UPDATE = 'desktop:get-update';
/** App → page: an update finished downloading and installs on the next start. */
export const DESKTOP_UPDATE_READY = 'desktop:update-ready';
/** Page → app: restart now and install it. */
export const DESKTOP_INSTALL_UPDATE = 'desktop:install-update';

/** Page → app: whether the window's close button hides the app in the notification area. */
export const DESKTOP_SET_CLOSE_TO_TRAY = 'desktop:set-close-to-tray';

/** Page → app: whether Windows opens the app at login. */
export const DESKTOP_GET_START_AT_LOGIN = 'desktop:get-start-at-login';
/** Page → app: turn that on or off; answers the state after the change. */
export const DESKTOP_SET_START_AT_LOGIN = 'desktop:set-start-at-login';

/** Page → app: a short notice in the corner of the screen, over other programs. */
export const DESKTOP_SHOW_NOTICE = 'desktop:show-notice';
/** App → page: the user clicked a notice. */
export const DESKTOP_NOTICE_CLICKED = 'desktop:notice-clicked';

/** Page → app: how the user is in a call, for the notification area and the taskbar. */
export const DESKTOP_SET_CALL_STATE = 'desktop:set-call-state';
/** App → page: a button of the notification area or of the taskbar thumbnail was used. */
export const DESKTOP_CALL_ACTION = 'desktop:call-action';

/** Page → app: report the games running (with the user's corrections), or stop. */
export const DESKTOP_WATCH_GAMES = 'desktop:watch-games';
/** App → page: the games running, after a change. */
export const DESKTOP_GAMES = 'desktop:games';
/** Page → app: the next screen share captures this window, without the picker. */
export const DESKTOP_SHARE_WINDOW = 'desktop:share-window';
/** Page → app: programs with a window, for the user to call one a game. */
export const DESKTOP_RUNNING_WINDOWS = 'desktop:running-windows';

/** Page → app: start or stop measuring the graphics card. */
export const DESKTOP_WATCH_GPU_USAGE = 'desktop:watch-gpu-usage';
/** App → page: what the graphics card is busy with, every couple of seconds. */
export const DESKTOP_GPU_USAGE = 'desktop:gpu-usage';

/** Page → app: the codec this machine's native capture would send, if it has one. */
export const DESKTOP_NATIVE_CAPTURE_PROBE = 'desktop:native-capture-probe';
/** Page → app: ask the user what to share and say which capture it is for. */
export const DESKTOP_NATIVE_CAPTURE_CHOOSE = 'desktop:native-capture-choose';
/** Page → app: capture the screen and send it to this ingest, replacing a running capture. */
export const DESKTOP_NATIVE_CAPTURE_START = 'desktop:native-capture-start';
/** Page → app: stop the running capture. */
export const DESKTOP_NATIVE_CAPTURE_STOP = 'desktop:native-capture-stop';
/** App → page: the capture stopped on its own. */
export const DESKTOP_NATIVE_CAPTURE_ENDED = 'desktop:native-capture-ended';
/** App → page: a small picture of what the capture engine is sending, a few times a second. */
export const DESKTOP_NATIVE_CAPTURE_PREVIEW = 'desktop:native-capture-preview';
/** App → page: what the capture engine measured over the last couple of seconds. */
export const DESKTOP_NATIVE_CAPTURE_STATS = 'desktop:native-capture-stats';

/** Page → app: capture the sound of the program being shared, if one can be told apart. */
export const DESKTOP_GAME_AUDIO_START = 'desktop:game-audio-start';
/** Page → app: stop that capture. */
export const DESKTOP_GAME_AUDIO_STOP = 'desktop:game-audio-stop';
/** App → page: a piece of that sound, 48 kHz stereo signed 16-bit PCM. */
export const DESKTOP_GAME_AUDIO_DATA = 'desktop:game-audio-data';

/**
 * The action that starts or stops a screen share. The app treats it apart: pressed with a game
 * in front, the share captures that game without asking what to share.
 */
export const DESKTOP_SHARE_ACTION = 'share';

/** Action name → binding, in the page's own notation (`Ctrl+Shift+M`, `F9`). */
export const desktopShortcutsSchema = z
  .record(z.string().min(1).max(32), z.string().min(1).max(48))
  .refine((bindings) => Object.keys(bindings).length <= 16, 'too many shortcuts');
export type DesktopShortcuts = z.infer<typeof desktopShortcutsSchema>;

/** Actions whose shortcut the system refused (taken by another program, or not a valid key). */
export const desktopShortcutsResultSchema = z.object({ failed: z.array(z.string()) });
export type DesktopShortcutsResult = z.infer<typeof desktopShortcutsResultSchema>;

export const desktopShortcutEventSchema = z.object({ action: z.string().min(1).max(32) });

/** The version waiting to be installed, or `null` when the app is up to date. */
export const desktopUpdateSchema = z.object({ version: z.string().min(1).max(32).nullable() });
export type DesktopUpdate = z.infer<typeof desktopUpdateSchema>;

export const desktopCloseToTraySchema = z.object({ enabled: z.boolean() });

/**
 * A notice in the corner of the screen, like Steam's: who, what happened, and what a click does.
 * The app shows one at a time for a few seconds, without taking the focus from a game.
 */
export const desktopNoticeSchema = z.object({
  /** Handed back to the page when the notice is clicked. */
  id: z.string().min(1).max(200),
  /** The person, as the app shows their name. */
  title: z.string().min(1).max(80),
  text: z.string().min(1).max(160),
  /** Address of the person's picture, on the app's own server; `null` shows the initial. */
  picture: z.string().max(500).nullable(),
  /** What a click does, as a bracketed button (`ENTRAR`); `null` just opens the app. */
  action: z.string().min(1).max(24).nullable(),
});
export type DesktopNotice = z.infer<typeof desktopNoticeSchema>;

export const desktopNoticeClickSchema = z.object({ id: z.string().min(1).max(200) });

export const desktopStartAtLoginSchema = z.object({
  enabled: z.boolean(),
  /** `false` in a copy that is not installed (development), where it cannot be set. */
  available: z.boolean(),
});
export type DesktopStartAtLogin = z.infer<typeof desktopStartAtLoginSchema>;

export const desktopCallStateSchema = z.object({
  /** Name of the voice channel the user is in, or `null` outside a call. */
  channel: z.string().max(100).nullable(),
  /** The user's choice, also outside a call: the next call starts that way. */
  muted: z.boolean(),
  deafened: z.boolean(),
  /** The others hear the user right now: microphone open and a voice going through it. */
  speaking: z.boolean(),
});
export type DesktopCallState = z.infer<typeof desktopCallStateSchema>;

export const DESKTOP_CALL_ACTIONS = [
  'toggle-mute',
  'toggle-deafen',
  'disconnect',
  'voice-settings',
] as const;
export const desktopCallActionSchema = z.object({ action: z.enum(DESKTOP_CALL_ACTIONS) });

export const desktopWatchGpuUsageSchema = z.object({ on: z.boolean() });

export const desktopWatchGamesSchema = z.object({
  on: z.boolean(),
  /** Programs the user added as games. */
  added: z.array(z.string().max(260)).max(200),
});
export const desktopShareWindowSchema = z.object({ windowHandle: z.number().int() });

/** A game running, with its program's icon (PNG data URL) when Windows has one. */
export const desktopGameSchema = runningGameSchema.extend({
  icon: z.string().max(200_000).nullable(),
});
export type DesktopGame = z.infer<typeof desktopGameSchema>;
export const desktopGamesSchema = z.array(desktopGameSchema);

/**
 * Games running on this machine, as Discord tells them: the launchers' games, the user's own
 * additions and full-screen programs. Absent in apps older than 0.12.0.
 */
export interface DesktopGames {
  /** Reports the games while listened to; calling again replaces the added list. */
  watch(added: string[], listener: (games: DesktopGame[]) => void): () => void;
  /** The next screen share captures this window directly. */
  shareWindow(windowHandle: number): Promise<void>;
  /** Programs with a window right now. */
  runningWindows(): Promise<RunningWindow[]>;
}

const percent = z.number().min(0).max(100);
/** Busiest engine of each kind, 0 to 100, as the Task Manager counts it. */
const gpuEnginesSchema = z.object({
  /** Drawing: games, and the app's own page. */
  threeD: percent,
  /** Encoding and decoding video (on AMD a single engine does both). */
  video: percent,
  copy: percent,
});
export const desktopGpuUsageSchema = z.object({
  /** The app and every program it started (the capture engine, ffmpeg). */
  app: gpuEnginesSchema,
  /** Everything running on the machine. */
  all: gpuEnginesSchema,
});
export type DesktopGpuUsage = z.infer<typeof desktopGpuUsageSchema>;
export type DesktopCallAction = (typeof DESKTOP_CALL_ACTIONS)[number];

export const desktopNativeCaptureProbeSchema = z.object({
  codec: ingestCodecSchema.nullable(),
  /** Why the capture engine cannot run here, when it cannot (app 0.11.1 and later). */
  engineProblem: z.string().max(500).nullable().optional(),
});

/**
 * What the user picked for a share: something the app captures itself (`native`: a monitor,
 * or a window that covers one), something only the browser's capture can show (`browser`: any
 * other window; the app hands it over without asking again), or nothing.
 */
export const desktopNativeCaptureChoiceSchema = z.enum(['native', 'browser', 'cancelled']);
export type DesktopNativeCaptureChoice = z.infer<typeof desktopNativeCaptureChoiceSchema>;

export const desktopNativeCaptureStartSchema = z.object({
  ingest: voiceIngestSchema,
  codec: ingestCodecSchema,
  frameRate: z.number().int().min(1).max(120),
  /** Bits per second. */
  bitrate: z.number().int().min(100_000).max(50_000_000),
  /** Largest picture to send; a bigger screen is scaled down to fit. Apps before 0.11 ignore it. */
  width: z.number().int().min(160).max(7680).optional(),
  height: z.number().int().min(90).max(4320).optional(),
});
export type DesktopNativeCaptureStart = z.infer<typeof desktopNativeCaptureStartSchema>;

/** The capture engine's own numbers (app 0.11 and later). */
export const desktopNativeCaptureStatsSchema = z.object({
  captureFps: z.number(),
  sentFps: z.number(),
  encodeMs: z.number(),
  kbps: z.number(),
  width: z.number().int(),
  height: z.number().int(),
  /** What the encoder aims at now: lower than asked when the network is losing packets. */
  bitrate: z.number().int(),
  retransmitted: z.number().int(),
  keyFramesAsked: z.number().int(),
  lossPercent: z.number(),
  encoder: z.string().max(200),
});
export type DesktopNativeCaptureStats = z.infer<typeof desktopNativeCaptureStatsSchema>;

/** One preview picture: BGRA rows, tightly packed. */
export interface DesktopNativeCapturePreview {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * The app capturing and encoding the screen on the graphics card, outside the browser, and
 * sending it to an ingest of the media service. Experimental: a whole monitor, video only.
 */
export interface DesktopNativeCapture {
  /** The codec this machine would send, or `null` when it cannot capture natively. */
  probe(): Promise<IngestCodec | null>;
  /** The H.264 profile its captures send. Absent before 0.12.2, whose captures send High. */
  h264Profile?: IngestProfile;
  /**
   * Shows the app's picker; `start` then captures what was picked. Absent in apps older than
   * 0.9.0, which capture the main monitor without asking.
   */
  choose?(): Promise<DesktopNativeCaptureChoice>;
  start(options: DesktopNativeCaptureStart): Promise<void>;
  stop(): Promise<void>;
  /** Called when the capture stops on its own. Returns the function that stops listening. */
  onEnded(listener: () => void): () => void;
  /** Why the capture engine cannot run here, or `null` when it can. Absent before 0.11.1. */
  engineProblem?(): Promise<string | null>;
  /** Called with each preview picture of the running capture. Absent before 0.11.2. */
  onPreview?(listener: (picture: DesktopNativeCapturePreview) => void): () => void;
  /** Called with the capture engine's numbers, every couple of seconds. Absent before 0.11. */
  onStats?(listener: (stats: DesktopNativeCaptureStats) => void): () => void;
}

/**
 * What is being captured: one program (`name`), or everything that plays except voice chats
 * (`name: null`). `null` when the app cannot capture sound itself.
 */
export const desktopGameAudioSchema = z.object({ name: z.string().max(200).nullable() }).nullable();
export type DesktopGameAudioSource = z.infer<typeof desktopGameAudioSchema>;

/**
 * The sound of a share without voice chats: the program of the window picked for it or, when a
 * whole screen is shared, the program covering one (a game, in practice); failing that,
 * everything that plays except voice chats (Discord, this app).
 */
export interface DesktopGameAudio {
  /** Starts the capture, replacing a running one. `null`: share the system's sound instead. */
  start(): Promise<DesktopGameAudioSource>;
  stop(): Promise<void>;
  /** Pieces of 48 kHz stereo signed 16-bit PCM. Returns the function that stops listening. */
  onData(listener: (pcm: Uint8Array) => void): () => void;
}

/** `window.dispeakerDesktop`, as exposed by the app's preload script. */
export interface DesktopBridge {
  version: string;
  /** Replaces the registered shortcuts; an empty object removes them all. */
  setShortcuts(bindings: DesktopShortcuts): Promise<DesktopShortcutsResult>;
  /** Returns the function that stops listening. */
  onShortcut(listener: (action: string) => void): () => void;
  /** The update that is already downloaded, if any. */
  getUpdate(): Promise<DesktopUpdate>;
  /** Called when an update finishes downloading. Returns the function that stops listening. */
  onUpdateReady(listener: (version: string) => void): () => void;
  /** Closes the app, installs the downloaded update and opens it again. */
  installUpdate(): Promise<void>;
  /**
   * Whether closing the window keeps the app running in the notification area instead of
   * quitting. Absent in apps older than 0.6.0.
   */
  setCloseToTray?(enabled: boolean): Promise<void>;
  /** Notices in the corner of the screen. Absent in apps older than 0.13.0. */
  notices?: {
    show(notice: DesktopNotice): void;
    /** Called with the id of a clicked notice. Returns the function that stops listening. */
    onClick(listener: (id: string) => void): () => void;
  };
  /**
   * Opening with Windows, hidden in the notification area. Absent in apps older than 0.13.0.
   */
  startAtLogin?: {
    get(): Promise<DesktopStartAtLogin>;
    set(enabled: boolean): Promise<DesktopStartAtLogin>;
  };
  /**
   * What the notification area icon and the taskbar thumbnail buttons show. Absent in apps
   * older than 0.12.0.
   */
  setCallState?(state: DesktopCallState): void;
  /** Called when one of those buttons is used. Returns the function that stops listening. */
  onCallAction?(listener: (action: DesktopCallAction) => void): () => void;
  /**
   * Measures the graphics card while listened to. Returns the function that stops listening
   * (and measuring). Absent in apps older than 0.12.0.
   */
  watchGpuUsage?(listener: (usage: DesktopGpuUsage) => void): () => void;
  /** Absent in apps older than 0.12.0. */
  games?: DesktopGames;
  /** Absent in apps older than 0.7.0; its `probe` answers `null` where the experiment is off. */
  nativeCapture?: DesktopNativeCapture;
  /** Absent in apps older than 0.8.0; the mix without voice chats needs 0.10.0. */
  gameAudio?: DesktopGameAudio;
}

/**
 * Whether a binding may be registered system-wide. A global shortcut takes its key away from
 * every other program, so a bare letter would stop being typed anywhere: only chords with Ctrl
 * or Alt and the function keys qualify.
 */
export function isGlobalBinding(binding: string): boolean {
  const parts = binding.split('+');
  const key = parts.at(-1) ?? '';
  return parts.includes('Ctrl') || parts.includes('Alt') || /^F([1-9]|1\d|2[0-4])$/.test(key);
}
