import type { DesktopGpuUsage, VoicePeer } from '@frequencia/shared';
import { create } from 'zustand';
import type { NoiseEngine } from './microphone';
import type { ScreenPresetId } from './screen-presets';

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface VoiceConnectionStats {
  rttMs: number | null;
  sendKbps: number | null;
  receiveKbps: number | null;
  /** Inbound packet loss over the last interval, in percent. */
  lossPercent: number | null;
  audioCodec: string | null;
}

export interface ScreenShareState {
  status: 'off' | 'starting' | 'live';
  preset: ScreenPresetId | null;
  /** Whether the browser handed over system/tab audio along with the video. */
  hasAudio: boolean;
  /** The captured sound includes the call itself: viewers may hear their own voices back. */
  echoRisk: boolean;
  /**
   * The sound is everything the PC plays, other voice chats (Discord) included: a whole screen
   * shared from a browser, or an app that could not tell programs apart.
   */
  voiceChatRisk: boolean;
  /** What goes out as sound, for the panel; `null` when it is everything the PC plays. */
  audioSource: string | null;
  /** Local capture, shown as the streamer's own preview. */
  stream: MediaStream | null;
  error: string | null;
}

export interface CameraState {
  status: 'off' | 'starting' | 'live';
  /** Local capture, shown in the user's own tile. */
  stream: MediaStream | null;
  error: string | null;
}

export interface WatchedStream {
  /** `null` until the first video consumer is ready. */
  stream: MediaStream | null;
  /** Simulcast layer the server is currently forwarding (0 = lowest). */
  spatialLayer: number | null;
  /** Why the picture will not come, when it will not: shown instead of waiting forever. */
  error?: string;
}

export interface StreamLayerStats {
  rid: string;
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
}

/** Real numbers for one stream, read from `getStats()` of its producer or consumer. */
export interface StreamStats {
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
  lossPercent: number | null;
  codec: string | null;
  /** Outgoing streams only: one entry per simulcast layer. */
  layers?: StreamLayerStats[];
  /** Outgoing streams only: why the encoder is holding back (`cpu`, `bandwidth`), if it is. */
  limitation?: string | null;
  /** Outgoing streams only: frames the browser captures, before the encoder drops any. */
  captureFps?: number | null;
  /** Outgoing streams only: time the encoder takes per frame, all layers together. */
  encodeMs?: number | null;
  /** Outgoing streams only: the encoder in use, as the browser names it. */
  encoder?: string | null;
}

/** Key used in `streamStats` for the local user's own screen share. */
export const SELF_STREAM = 'self';

export interface VoiceState {
  status: VoiceStatus;
  error: string | null;
  /** Human readable name of the joined channel. */
  channelName: string | null;
  /** Opaque id of the joined channel, as known by the caller of `joinVoice`. */
  channelId: string | null;
  selfId: string | null;
  muted: boolean;
  deafened: boolean;
  /** Push-to-talk: the key is being held, so the microphone is open. */
  pttHeld: boolean;
  /** False when no microphone could be opened; the user is then listen-only. */
  micAvailable: boolean;
  /** What is cleaning the microphone right now; `null` while there is no microphone. */
  noiseSuppression: NoiseEngine | null;
  /** Remote participants keyed by session id. */
  peers: Record<string, VoicePeer>;
  /** Session ids currently speaking (may include `selfId`). */
  speaking: string[];
  stats: VoiceConnectionStats;
  screen: ScreenShareState;
  camera: CameraState;
  /** Cameras of the other participants, keyed by session id. Always received. */
  cameras: Record<string, MediaStream>;
  /** Streams this client chose to watch, keyed by the streamer's session id. */
  watching: Record<string, WatchedStream>;
  /** Session ids of the people watching the local share, as the media server reports them. */
  screenViewers: string[];
  /** Keyed by streamer session id, or `SELF_STREAM` for the local share. */
  streamStats: Record<string, StreamStats>;
  /** How loud the microphone is right now, 0 to 1, measured on what is sent to the others. */
  micLevel: number;
  /**
   * User ids whose stream this user chose to watch, for the rest of the call. A stream that
   * ends stays wanted: it is received again as soon as that person shares again.
   */
  wantedStreams: string[];
  /**
   * How busy the graphics card is, measured by the desktop app while a stream goes out or
   * comes in; `null` otherwise, and in a browser.
   */
  gpu: DesktopGpuUsage | null;
}

export const emptyVoiceStats: VoiceConnectionStats = {
  rttMs: null,
  sendKbps: null,
  receiveKbps: null,
  lossPercent: null,
  audioCodec: null,
};

export const screenOff: ScreenShareState = {
  status: 'off',
  preset: null,
  hasAudio: false,
  echoRisk: false,
  voiceChatRisk: false,
  audioSource: null,
  stream: null,
  error: null,
};

export const cameraOff: CameraState = { status: 'off', stream: null, error: null };

export const initialVoiceState: VoiceState = {
  status: 'idle',
  error: null,
  channelName: null,
  channelId: null,
  selfId: null,
  muted: false,
  deafened: false,
  pttHeld: false,
  micAvailable: true,
  noiseSuppression: null,
  peers: {},
  speaking: [],
  stats: emptyVoiceStats,
  screen: screenOff,
  camera: cameraOff,
  cameras: {},
  watching: {},
  screenViewers: [],
  streamStats: {},
  micLevel: 0,
  wantedStreams: [],
  gpu: null,
};

export const useVoiceStore = create<VoiceState>(() => initialVoiceState);

/** True when the peer is publishing a screen share. */
export function isLive(peer: VoicePeer): boolean {
  return peer.producers.some((producer) => producer.source === 'screen');
}
