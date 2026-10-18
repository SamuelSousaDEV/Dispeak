import {
  ApiErrorCode,
  apiInternalSide,
  mediaInternalSide,
  RpcPeer,
  type EventData,
  type InternalVoicePeer,
  type RequestInput,
  type ResponseData,
} from '@frequencia/shared';
import type { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';
import { AppError } from '../../errors';

type MediaRpc = RpcPeer<typeof apiInternalSide, typeof mediaInternalSide>;
type MediaMethod = keyof (typeof mediaInternalSide)['requests'];
export type VoiceStateEvent = EventData<typeof apiInternalSide, 'voice-state'>;
type StreamReportEvent = EventData<typeof apiInternalSide, 'stream-report'>;
type VoiceReportEvent = EventData<typeof apiInternalSide, 'voice-report'>;

export interface MediaLinkOptions {
  url: string;
  sharedSecret: string;
  log: FastifyBaseLogger;
  /** Called after every (re)connection; `snapshot` fetches everyone currently in voice. */
  onConnected: (snapshot: () => Promise<InternalVoicePeer[]>) => void | Promise<void>;
  onVoiceState: (event: VoiceStateEvent) => void | Promise<void>;
  onStreamReport?: (event: StreamReportEvent) => void | Promise<void>;
  onVoiceReport?: (event: VoiceReportEvent) => void | Promise<void>;
}

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 5000];
const PING_INTERVAL_MS = 15_000;

/**
 * Authenticated WebSocket from the API to the media service, kept open for as long as the
 * API runs. Voice membership flows in; moderation commands (kick, close) flow out.
 */
export class MediaLink {
  private socket: WebSocket | null = null;
  private rpc: MediaRpc | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: MediaLinkOptions) {}

  get connected(): boolean {
    return this.rpc !== null && !this.rpc.closed;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.rpc?.close();
    this.socket?.terminate();
    this.socket = null;
    this.rpc = null;
  }

  /** Calls the media service. Fails with 503 while the link is down. */
  request<M extends MediaMethod>(
    method: M,
    data: RequestInput<typeof mediaInternalSide, M>,
  ): Promise<ResponseData<typeof mediaInternalSide, M>> {
    if (!this.rpc || this.rpc.closed) {
      return Promise.reject(
        new AppError(503, ApiErrorCode.MediaUnavailable, 'media service is unreachable'),
      );
    }
    return this.rpc.request(method, data);
  }

  private connect(): void {
    if (this.stopped) return;
    const { url, sharedSecret, log } = this.options;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${sharedSecret}` } });
    this.socket = socket;

    const rpc: MediaRpc = new RpcPeer({
      local: apiInternalSide,
      remote: mediaInternalSide,
      send: (frame) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(frame);
      },
      onError: (error, context) => log.warn({ err: error, context }, 'media link protocol error'),
    });
    rpc.on('voice-state', (event) => {
      void Promise.resolve(this.options.onVoiceState(event)).catch((error: unknown) =>
        log.error({ err: error }, 'failed to apply voice state'),
      );
    });

    rpc.on('stream-report', (event) => {
      void Promise.resolve(this.options.onStreamReport?.(event)).catch((error: unknown) =>
        log.warn({ err: error }, 'failed to store a stream report'),
      );
    });

    rpc.on('voice-report', (event) => {
      void Promise.resolve(this.options.onVoiceReport?.(event)).catch((error: unknown) =>
        log.warn({ err: error }, 'failed to store a voice report'),
      );
    });

    socket.on('open', () => {
      this.attempt = 0;
      this.rpc = rpc;
      log.info({ url }, 'media link connected');
      this.pingTimer = setInterval(() => socket.ping(), PING_INTERVAL_MS);
      // The media service is the source of truth: rebuild our mirror from its snapshot.
      const snapshot = async () => (await rpc.request('snapshot', {})).peers;
      Promise.resolve()
        .then(() => this.options.onConnected(snapshot))
        .catch((error: unknown) => log.error({ err: error }, 'media snapshot failed'));
    });
    socket.on('message', (data) => rpc.receive(data.toString()));
    socket.on('error', (error) => log.debug({ err: error }, 'media link error'));
    socket.on('close', () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      rpc.close();
      if (this.rpc === rpc) {
        this.rpc = null;
        log.warn('media link lost');
      }
      if (this.stopped) return;
      const delay =
        RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 5000;
      this.attempt += 1;
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }
}
