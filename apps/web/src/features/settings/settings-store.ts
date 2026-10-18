import { z } from 'zod';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEVICE_LEGACY_KEY } from './account-settings';
import { SOUND_EVENTS, type SoundEvent } from '../sounds/sound-events';
import { SCREEN_PRESET_IDS } from '../voice/screen-presets';
import {
  assignKeybind,
  DEFAULT_KEYBINDS,
  KEYBIND_ACTIONS,
  LEGACY_DEFAULT_KEYBINDS,
  type KeybindAction,
  type Keybinds,
} from './keybinds';

/** `voice` keeps the microphone open; `pushToTalk` opens it only while a key is held. */
export const INPUT_MODES = ['voice', 'pushToTalk'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

const perSound = <T extends z.ZodType>(schema: T) =>
  Object.fromEntries(SOUND_EVENTS.map((event) => [event, schema])) as Record<SoundEvent, T>;

const settingsSchema = z.object({
  /** `null` follows the system default device. */
  inputDeviceId: z.string().nullable(),
  outputDeviceId: z.string().nullable(),
  cameraDeviceId: z.string().nullable(),
  /** On or off, nothing in between: what "on" runs is decided in `voice/microphone.ts`. */
  noiseSuppression: z.boolean(),
  echoCancellation: z.boolean(),
  autoGainControl: z.boolean(),
  /** Evens out the voice and raises it, so nobody has to turn the speakers all the way up. */
  voiceLeveler: z.boolean(),
  /** Volume of the user's own microphone, as the others hear it (1 = as captured). */
  micGain: z.number().min(0.5).max(2),
  /** Volume of everything heard in a call: voices and stream audio (1 = as sent). */
  outputVolume: z.number().min(0).max(1),
  inputMode: z.enum(INPUT_MODES),
  /** The user's own microphone was off when last left; the next call starts that way. */
  selfMuted: z.boolean(),
  /** Same for not hearing the call. */
  selfDeafened: z.boolean(),
  /** System notification when someone mentions the user while the tab is in the background. */
  desktopNotifications: z.boolean(),
  /** Desktop app: the close button hides the window in the notification area. */
  closeToTray: z.boolean(),
  /** Desktop app: notices in the corner of the screen (`desktop/corner-notices`). */
  cornerNotices: z.object({
    /** Someone opens the app. */
    online: z.boolean(),
    /** Someone enters a call or starts a stream, while the user is in none. */
    calls: z.boolean(),
  }),
  /** Desktop app: screen shares captured by the app itself, not the browser, where it can. */
  nativeCapture: z.boolean(),
  /** Last quality picked for a screen share; the share shortcut starts with it. */
  sharePreset: z.enum(SCREEN_PRESET_IDS),
  /** Notification sounds: joining, leaving, a stream starting or ending. */
  soundsEnabled: z.boolean(),
  soundVolume: z.number().min(0).max(1),
  soundEvents: z.object(perSound(z.boolean())),
  /** Name of the user's own file for an event; the file itself lives in IndexedDB. */
  customSounds: z.object(perSound(z.string().nullable())),
  keybinds: z.object(
    Object.fromEntries(KEYBIND_ACTIONS.map((action) => [action, z.string().nullable()])) as Record<
      KeybindAction,
      z.ZodNullable<z.ZodString>
    >,
  ),
});

export type Settings = z.infer<typeof settingsSchema>;

// Stored data may predate a shortcut or a sound that exists now: those groups are read
// key by key and completed with the defaults.
const storedSchema = settingsSchema
  .extend({
    keybinds: settingsSchema.shape.keybinds.partial(),
    soundEvents: settingsSchema.shape.soundEvents.partial(),
    customSounds: settingsSchema.shape.customSounds.partial(),
  })
  .partial();

export const defaultSettings: Settings = {
  inputDeviceId: null,
  outputDeviceId: null,
  cameraDeviceId: null,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  voiceLeveler: true,
  micGain: 1,
  outputVolume: 1,
  inputMode: 'voice',
  selfMuted: false,
  selfDeafened: false,
  desktopNotifications: false,
  closeToTray: true,
  cornerNotices: { online: true, calls: true },
  nativeCapture: true,
  sharePreset: '1080p60',
  soundsEnabled: true,
  soundVolume: 0.5,
  soundEvents: {
    join: true,
    leave: true,
    streamStart: true,
    streamStop: true,
    watchStart: true,
    watchStop: true,
    viewerJoin: true,
    viewerLeave: true,
  },
  customSounds: {
    join: null,
    leave: null,
    streamStart: null,
    streamStop: null,
    watchStart: null,
    watchStop: null,
    viewerJoin: null,
    viewerLeave: null,
  },
  keybinds: DEFAULT_KEYBINDS,
};

/**
 * Preferences of this device, kept in localStorage. What belongs to the account (how each
 * person sounds, the chat previews) is in `account-settings` and follows the user around.
 */
export const useSettingsStore = create<Settings>()(
  persist(() => defaultSettings, {
    name: 'frequencia.settings',
    version: 8,
    migrate: (persisted, version) => {
      let stored = persisted as {
        noiseSuppression?: unknown;
        keybinds?: unknown;
        sharePreset?: unknown;
        nativeCapture?: unknown;
        closeToTray?: unknown;
      } | null;
      if (!stored) return persisted;
      // Up to version 2 the suppression was a choice among four modes; now it is on or off.
      if (version < 3 && typeof stored.noiseSuppression === 'string') {
        stored = { ...stored, noiseSuppression: stored.noiseSuppression !== 'off' };
      }
      // Up to version 3 everyone had M, D and F without asking. Those go; chosen ones stay.
      if (version < 4 && stored.keybinds && typeof stored.keybinds === 'object') {
        const keybinds: Record<string, unknown> = { ...stored.keybinds };
        for (const [action, binding] of Object.entries(LEGACY_DEFAULT_KEYBINDS)) {
          if (keybinds[action] === binding) keybinds[action] = null;
        }
        stored = { ...stored, keybinds };
      }
      // Up to version 4 there were six stream presets; the three that went fall back to 1080p60.
      if (
        version < 5 &&
        typeof stored.sharePreset === 'string' &&
        !(SCREEN_PRESET_IDS as readonly string[]).includes(stored.sharePreset)
      ) {
        stored = { ...stored, sharePreset: '1080p60' };
      }
      // Up to version 5 the app's own capture was off until asked for; now it is the usual one.
      if (version < 6) stored = { ...stored, nativeCapture: true };
      // Up to version 6 the volume of each person and the chat previews were kept here; the
      // account takes them over on its next session.
      if (version < 7) {
        const { userVolumes, showEmbeds, ...rest } = stored as Record<string, unknown>;
        try {
          localStorage.setItem(DEVICE_LEGACY_KEY, JSON.stringify({ userVolumes, showEmbeds }));
        } catch {
          // Without storage there was nothing stored to take over either.
        }
        stored = rest;
      }
      // Up to version 7 the X quit the app. Now it stays in the notification area, like
      // Discord, so whoever opens the app stays reachable; the option turns it back.
      if (version < 8) stored = { ...stored, closeToTray: true };
      return stored;
    },
    // Stored data may be stale or hand-edited: keep only what still validates. Shortcuts are
    // merged one by one, so an action added later starts with its default.
    merge: (persisted, current) => {
      const parsed = storedSchema.safeParse(persisted);
      if (!parsed.success) return current;
      return {
        ...current,
        ...parsed.data,
        keybinds: { ...current.keybinds, ...parsed.data.keybinds },
        soundEvents: { ...current.soundEvents, ...parsed.data.soundEvents },
        customSounds: { ...current.customSounds, ...parsed.data.customSounds },
      };
    },
  }),
);

export function updateSettings(patch: Partial<Omit<Settings, 'keybinds'>>): void {
  useSettingsStore.setState(patch);
}

export function setKeybind(action: KeybindAction, binding: string | null): void {
  useSettingsStore.setState((state) => ({
    keybinds: assignKeybind(state.keybinds, action, binding),
  }));
}

export function resetKeybinds(): void {
  useSettingsStore.setState({ keybinds: DEFAULT_KEYBINDS });
}

export const useKeybind = (action: KeybindAction): Keybinds[KeybindAction] =>
  useSettingsStore((state) => state.keybinds[action]);
