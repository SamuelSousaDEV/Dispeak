import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  apiInternalSide,
  mediaInternalSide,
  RpcPeer,
  type EventInput,
  type InternalVoicePeer,
  type InternalVoiceState,
} from '@frequencia/shared';
import { WebSocketServer } from 'ws';

type Link = RpcPeer<typeof mediaInternalSide, typeof apiInternalSide>;

export interface FakeMedia {
  url: string;
  secret: string;
  /** Peers reported by the next `snapshot` request. */
  peers: InternalVoicePeer[];
  /** How long a `snapshot` response takes; its content is fixed when the request arrives. */
  snapshotDelayMs: number;
  /** Number of `snapshot` requests received. */
  snapshots: number;
  /** Requests the API made, in order. */
  calls: Array<{ method: string; data: unknown }>;
  links: () => number;
  /** Pushes a voice-state event to every connected API instance. */
  emit: (
    roomId: string,
    userId: string,
    state: Partial<InternalVoiceState> | null,
    options?: { peerId?: string; eventId?: string },
  ) => void;
  /** Pushes a stream report to every connected API instance. */
  report: (event: EventInput<typeof apiInternalSide, 'stream-report'>) => void;
  /** Pushes a voice report to every connected API instance. */
  reportVoice: (event: EventInput<typeof apiInternalSide, 'voice-report'>) => void;
  /** Drops every API connection, as a media restart would. */
  dropLinks: () => void;
  close: () => Promise<void>;
}

/** Stands in for the media service's internal endpoint. */
export async function startFakeMedia(): Promise<FakeMedia> {
  const secret = 'test-secret-test-secret-test-secret-1234';
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      req.headers.authorization === `Bearer ${secret}`,
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const { port } = wss.address() as AddressInfo;

  const links = new Set<Link>();
  let counter = 0;
  const media: FakeMedia = {
    url: `ws://127.0.0.1:${port}/media/internal`,
    secret,
    peers: [],
    snapshotDelayMs: 0,
    snapshots: 0,
    calls: [],
    links: () => links.size,
    emit: (roomId, userId, state, options = {}) => {
      const event = {
        eventId: options.eventId ?? `fake:${++counter}`,
        roomId,
        userId,
        peerId: options.peerId ?? `peer-${userId}`,
        state: state && { muted: false, deafened: false, streaming: false, ...state },
      };
      for (const link of links) link.notify('voice-state', event);
    },
    report: (event) => {
      for (const link of links) link.notify('stream-report', event);
    },
    reportVoice: (event) => {
      for (const link of links) link.notify('voice-report', event);
    },
    dropLinks: () => {
      for (const client of wss.clients) client.terminate();
    },
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };

  wss.on('connection', (socket) => {
    const link: Link = new RpcPeer({
      local: mediaInternalSide,
      remote: apiInternalSide,
      send: (frame) => socket.send(frame),
    });
    links.add(link);
    socket.on('message', (data) => link.receive(data.toString()));
    socket.on('close', () => {
      links.delete(link);
      link.close();
    });

    link.handle('snapshot', async () => {
      const { peers } = media;
      media.snapshots += 1;
      if (media.snapshotDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, media.snapshotDelayMs));
      }
      return { nodeId: 'fake', peers };
    });
    link.handle('disconnectUser', (data) => {
      media.calls.push({ method: 'disconnectUser', data });
      return { disconnected: 1 };
    });
    link.handle('closeRoom', (data) => {
      media.calls.push({ method: 'closeRoom', data });
      return {};
    });
    link.handle('stats', () => ({
      rooms: 2,
      peers: 5,
      transports: 10,
      producers: 6,
      consumers: 12,
      connections: 0,
      workers: [{ index: 0, pid: 1234, routers: 2, cpuUserSeconds: 1.5, cpuSystemSeconds: 0.5 }],
    }));
  });

  return media;
}
