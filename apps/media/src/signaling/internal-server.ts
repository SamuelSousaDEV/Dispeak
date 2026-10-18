import { randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';
import {
  apiInternalSide,
  INTERNAL_RPC_PATH,
  MEDIA_PREFIX,
  mediaInternalSide,
  RpcPeer,
  VoiceCloseCode,
  type InternalVoicePeer,
  type InternalVoiceState,
} from '@frequencia/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { Peer } from '../rooms/peer';
import type { Room } from '../rooms/room';
import type { RoomManager } from '../rooms/room-manager';
import type { StreamReportChunk } from '../rooms/stream-telemetry';
import type { VoiceReportChunk } from '../rooms/voice-telemetry';

export const INTERNAL_PATH = `${MEDIA_PREFIX}${INTERNAL_RPC_PATH}`;

type ApiLink = RpcPeer<typeof mediaInternalSide, typeof apiInternalSide>;

function stateOf(peer: Peer): InternalVoiceState {
  return {
    muted: peer.muted,
    deafened: peer.deafened,
    streaming: [...peer.producers.values()].some(
      (producer) => producer.appData.source === 'screen',
    ),
  };
}

/**
 * Private endpoint for the API. Each API instance keeps one authenticated WebSocket open:
 * voice membership changes are pushed through it, and the API uses it to remove people from
 * voice channels. It is never exposed by the reverse proxy.
 */
export class InternalServer {
  /** Identifies this process; event ids are unique within it. */
  readonly nodeId = randomUUID();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly links = new Set<ApiLink>();
  private eventCounter = 0;

  constructor(
    private readonly rooms: RoomManager,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly getConnectionCount: () => number,
  ) {
    const changed = (room: Room, peer: Peer) => this.emit(room, peer, stateOf(peer));
    Object.assign(rooms.hooks, {
      onPeerJoined: changed,
      onPeerState: changed,
      onProducerAdded: changed,
      // Producers are also torn down while a peer leaves; that case is reported as "left".
      onProducerRemoved: (room: Room, peer: Peer) => {
        if (room.peers.has(peer.id)) changed(room, peer);
      },
      onPeerLeft: (room: Room, peer: Peer) => this.emit(room, peer, null),
      onStreamReport: (room: Room, peer: Peer, chunk: StreamReportChunk) => {
        const event = {
          eventId: `${this.nodeId}:${++this.eventCounter}`,
          roomId: room.id,
          userId: peer.userId,
          ...chunk,
          startedAt: chunk.startedAt.toISOString(),
          endedAt: chunk.endedAt?.toISOString() ?? null,
        };
        for (const link of this.links) link.notify('stream-report', event);
      },
      onVoiceReport: (room: Room, peer: Peer, chunk: VoiceReportChunk) => {
        const event = {
          eventId: `${this.nodeId}:${++this.eventCounter}`,
          roomId: room.id,
          userId: peer.userId,
          ...chunk,
          startedAt: chunk.startedAt.toISOString(),
          endedAt: chunk.endedAt?.toISOString() ?? null,
        };
        for (const link of this.links) link.notify('voice-report', event);
      },
    });
  }

  get linkCount(): number {
    return this.links.size;
  }

  handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.isAuthorized(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }

  private isAuthorized(request: http.IncomingMessage): boolean {
    const header = request.headers.authorization ?? '';
    const provided = Buffer.from(header.replace(/^Bearer /, ''));
    const expected = Buffer.from(this.config.sharedSecret);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private accept(socket: WebSocket): void {
    const link: ApiLink = new RpcPeer({
      local: mediaInternalSide,
      remote: apiInternalSide,
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      },
      onError: (error, context) => this.log.warn({ err: error, context }, 'internal rpc error'),
    });
    this.links.add(link);
    this.log.info({ links: this.links.size }, 'api link connected');

    socket.on('message', (data) => link.receive(data.toString()));
    socket.on('error', (error) => this.log.debug({ err: error }, 'internal socket error'));
    socket.on('close', () => {
      this.links.delete(link);
      link.close();
      this.log.info({ links: this.links.size }, 'api link closed');
    });

    link.handle('snapshot', () => ({ nodeId: this.nodeId, peers: this.snapshot() }));

    link.handle('disconnectUser', ({ userId, roomId, reason }) => {
      const code =
        reason === 'permissions' ? VoiceCloseCode.PermissionsChanged : VoiceCloseCode.Kicked;
      let disconnected = 0;
      for (const room of [...this.rooms.all]) {
        if (roomId && room.id !== roomId) continue;
        for (const peer of [...room.peers.values()]) {
          if (peer.userId !== userId) continue;
          room.removePeer(peer, code, reason);
          disconnected += 1;
        }
      }
      return { disconnected };
    });

    link.handle('closeRoom', ({ roomId }) => {
      this.rooms.get(roomId)?.close(VoiceCloseCode.RoomClosed, 'channel deleted');
      return {};
    });

    link.handle('stats', async () => ({
      ...this.rooms.stats().totals,
      connections: this.getConnectionCount(),
      workers: await this.rooms.workerUsage(),
    }));
  }

  private snapshot(): InternalVoicePeer[] {
    return [...this.rooms.all].flatMap((room) =>
      [...room.peers.values()].map((peer) => ({
        roomId: room.id,
        userId: peer.userId,
        peerId: peer.id,
        state: stateOf(peer),
      })),
    );
  }

  private emit(room: Room, peer: Peer, state: InternalVoiceState | null): void {
    const event = {
      eventId: `${this.nodeId}:${++this.eventCounter}`,
      roomId: room.id,
      userId: peer.userId,
      peerId: peer.id,
      state,
    };
    for (const link of this.links) link.notify('voice-state', event);
  }
}
