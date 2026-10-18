import type http from 'node:http';
import type { Duplex } from 'node:stream';
import {
  MEDIA_PREFIX,
  RpcPeer,
  VOICE_SIGNALING_PATH,
  VoiceCloseCode,
  voiceClientSide,
  voiceServerSide,
  type VoiceTokenClaims,
} from '@frequencia/shared';
import type { types } from 'mediasoup';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyVoiceToken } from '../auth/voice-token';
import type { Config } from '../config';
import type { Logger } from '../logger';
import { Peer } from '../rooms/peer';
import type { RoomManager } from '../rooms/room-manager';

const MAX_PAYLOAD_BYTES = 256 * 1024;
export const VOICE_PATH = `${MEDIA_PREFIX}${VOICE_SIGNALING_PATH}`;

/**
 * Browser-facing signaling endpoint. Authenticates the upgrade with a voice token and maps
 * each RPC call to the room the token grants access to.
 */
export class VoiceServer {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  constructor(
    private readonly rooms: RoomManager,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  get connections(): number {
    return this.wss.clients.size;
  }

  /** Handles an HTTP upgrade for the voice path. */
  async handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const claims = await verifyVoiceToken(
      url.searchParams.get('token') ?? '',
      this.config.sharedSecret,
    );

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      if (!claims) {
        // Accept and close with an application code so the browser can tell why.
        ws.close(VoiceCloseCode.Unauthorized, 'invalid or expired token');
        return;
      }
      this.accept(ws, claims);
    });
  }

  close(): void {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }

  private accept(socket: WebSocket, claims: VoiceTokenClaims): void {
    const { timeouts } = this.config;
    const log = this.log.child({ room: claims.room, user: claims.sub });

    const rpc = new RpcPeer({
      local: voiceServerSide,
      remote: voiceClientSide,
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      },
      onError: (error, context) => log.debug({ err: error, context }, 'rpc protocol error'),
    });
    const peer = new Peer(claims, rpc, (code, reason) => {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close(code, reason);
      }
    });

    const leave = (code = 1000, reason = '') => {
      const room = this.rooms.get(claims.room);
      if (room?.peers.has(peer.id)) room.removePeer(peer, code, reason);
      else peer.close(code, reason);
      this.rooms.releaseIfEmpty(claims.room);
    };

    // Sockets that connect but never join would otherwise linger forever.
    const joinTimer = setTimeout(() => {
      if (!peer.joined) leave(VoiceCloseCode.JoinTimeout, 'join timeout');
    }, timeouts.joinMs);

    let missedPongs = 0;
    const heartbeat = setInterval(() => {
      if (missedPongs >= 2) {
        socket.terminate();
        return;
      }
      missedPongs += 1;
      socket.ping();
    }, timeouts.heartbeatMs);
    socket.on('pong', () => {
      missedPongs = 0;
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'binary frames are not supported');
        return;
      }
      rpc.receive(data.toString());
    });
    socket.on('error', (error) => log.debug({ err: error }, 'socket error'));
    socket.on('close', () => {
      clearTimeout(joinTimer);
      clearInterval(heartbeat);
      leave();
      rpc.close();
    });

    const room = () => this.rooms.getOrCreate(claims.room);

    rpc.handle('getRouterCapabilities', async () => ({
      rtpCapabilities: (await room()).rtpCapabilities,
    }));

    rpc.handle('join', async ({ rtpCapabilities, muted, deafened }) => {
      const result = (await room()).join(peer, {
        rtpCapabilities: rtpCapabilities as types.RtpCapabilities,
        muted,
        deafened,
      });
      clearTimeout(joinTimer);
      return result;
    });

    rpc.handle('createTransport', async ({ direction }) =>
      (await room()).createTransport(peer, direction),
    );

    rpc.handle('connectTransport', async ({ transportId, dtlsParameters }) => {
      await (
        await room()
      ).connectTransport(peer, transportId, dtlsParameters as types.DtlsParameters);
      return {};
    });

    rpc.handle('restartIce', async ({ transportId }) => ({
      iceParameters: await (await room()).restartIce(peer, transportId),
    }));

    rpc.handle('produce', async ({ transportId, kind, rtpParameters, source }) => ({
      producerId: await (
        await room()
      ).produce(peer, {
        transportId,
        kind,
        source,
        rtpParameters: rtpParameters as unknown as types.RtpParameters,
      }),
    }));

    rpc.handle('createIngest', async ({ codec, profile }) =>
      (await room()).createIngest(peer, codec, profile ?? 'high'),
    );

    rpc.handle('closeProducer', async ({ producerId }) => {
      (await room()).closeProducer(peer, producerId);
      return {};
    });

    rpc.handle('consume', async ({ producerId }) => (await room()).consume(peer, producerId));

    rpc.handle('resumeConsumer', async ({ consumerId }) => {
      await (await room()).resumeConsumer(peer, consumerId);
      return {};
    });

    rpc.handle('pauseConsumer', async ({ consumerId, hidden }) => {
      await (await room()).pauseConsumer(peer, consumerId, hidden ?? false);
      return {};
    });

    rpc.handle('closeConsumer', async ({ consumerId }) => {
      (await room()).closeConsumer(peer, consumerId);
      return {};
    });

    rpc.handle('setConsumerLayers', async ({ consumerId, spatialLayer }) => {
      await (await room()).setConsumerLayers(peer, consumerId, spatialLayer);
      return {};
    });

    rpc.handle('setState', async (state) => {
      await (await room()).setState(peer, state);
      return {};
    });

    rpc.on('stream-stats', (event) => {
      // Telemetry never creates a room.
      this.rooms.get(claims.room)?.reportStreamStats(peer, event);
    });

    rpc.on('voice-stats', (event) => {
      this.rooms.get(claims.room)?.reportVoiceStats(peer, event);
    });

    rpc.handle('leave', () => {
      // Answer first, then close: the response must reach the client before the socket ends.
      setImmediate(() => leave(1000, 'left'));
      return {};
    });
  }
}
