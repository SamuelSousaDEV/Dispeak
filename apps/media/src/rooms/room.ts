import { randomBytes, randomInt } from 'node:crypto';
import {
  RpcError,
  VoiceCloseCode,
  VoiceErrorCode,
  type EventData,
  type EventInput,
  type IngestCodec,
  type IngestProfile,
  type MediaKind,
  type ProducerSource,
  type StreamPath,
  type TransportDirection,
  type voiceClientSide,
  type VoiceIngest,
  type VoicePeer,
  type VoiceProducer,
  type voiceServerSide,
} from '@frequencia/shared';
import type { types } from 'mediasoup';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { PooledWorker } from '../worker-pool';
import { AUDIO_LEVEL_OBSERVER, INGEST, mediaCodecs, TRANSPORT_BITRATE } from './media-codecs';
import type {
  ConsumerAppData,
  IngestAppData,
  Peer,
  ProducerAppData,
  TransportAppData,
} from './peer';
import { StreamTelemetry, type StreamReportChunk } from './stream-telemetry';
import { VoiceTelemetry, type VoiceReportChunk } from './voice-telemetry';

type ClientEvent = keyof (typeof voiceClientSide)['events'];
type StreamStatsEvent = EventData<typeof voiceServerSide, 'stream-stats'>;
type VoiceStatsEvent = EventData<typeof voiceServerSide, 'voice-stats'>;

export interface RoomHooks {
  onPeerJoined?: (room: Room, peer: Peer) => void;
  onPeerLeft?: (room: Room, peer: Peer) => void;
  onPeerState?: (room: Room, peer: Peer) => void;
  onProducerAdded?: (room: Room, peer: Peer, producer: VoiceProducer) => void;
  onProducerRemoved?: (room: Room, peer: Peer, producer: VoiceProducer) => void;
  onClosed?: (room: Room) => void;
  /** New telemetry of a screen share; see `StreamTelemetry`. */
  onStreamReport?: (room: Room, peer: Peer, chunk: StreamReportChunk) => void;
  /** New telemetry of a voice; see `VoiceTelemetry`. */
  onVoiceReport?: (room: Room, peer: Peer, chunk: VoiceReportChunk) => void;
}

export interface RoomStats {
  id: string;
  worker: number;
  peers: Array<{
    id: string;
    userId: string;
    name: string;
    muted: boolean;
    deafened: boolean;
    transports: number;
    producers: Array<{
      id: string;
      kind: MediaKind;
      source: ProducerSource;
      paused: boolean;
      /** `simulcast` for screen shares published with several layers. */
      type: string;
      layers: number;
    }>;
    consumers: Array<{
      id: string;
      producerId: string;
      kind: MediaKind;
      source: ProducerSource;
      paused: boolean;
      /** Simulcast layer requested by the viewer and the one currently forwarded. */
      preferredSpatialLayer: number | null;
      currentSpatialLayer: number | null;
    }>;
  }>;
}

/** Which producer sources a peer may publish at the same time. */
const SOURCE_KIND: Record<ProducerSource, MediaKind> = {
  mic: 'audio',
  camera: 'video',
  screen: 'video',
  'screen-audio': 'audio',
};

/**
 * A voice channel: one mediasoup Router, an AudioLevelObserver and the peers inside it.
 * All protocol rules live here; the signaling layer only maps RPC calls to these methods.
 */
export class Room {
  /** Starts the handshake deadline of a transport; called when the client connects it. */
  private readonly handshakes = new WeakMap<types.WebRtcTransport, () => void>();
  readonly peers = new Map<string, Peer>();
  private speaking: string[] = [];
  /** Who watches each screen share, as last told to its owner: producer id → sorted peer ids. */
  private readonly viewers = new Map<string, string>();
  /** Telemetry of each screen share, by producer id. */
  private readonly streams = new Map<string, StreamTelemetry>();
  /** Telemetry of each microphone, by producer id. */
  private readonly voices = new Map<string, VoiceTelemetry>();
  private closed = false;

  private constructor(
    readonly id: string,
    readonly pooledWorker: PooledWorker,
    readonly router: types.Router,
    private readonly audioLevelObserver: types.AudioLevelObserver,
    private readonly config: Config,
    private readonly log: Logger,
    private readonly hooks: RoomHooks,
  ) {
    audioLevelObserver.on('volumes', (volumes) => {
      this.setSpeaking(volumes.map(({ producer }) => (producer.appData as ProducerAppData).peerId));
    });
    audioLevelObserver.on('silence', () => this.setSpeaking([]));
  }

  static async create(
    id: string,
    pooledWorker: PooledWorker,
    config: Config,
    log: Logger,
    hooks: RoomHooks = {},
  ): Promise<Room> {
    const router = await pooledWorker.worker.createRouter({ mediaCodecs });
    pooledWorker.routers += 1;
    const audioLevelObserver = await router.createAudioLevelObserver(AUDIO_LEVEL_OBSERVER);
    log.info({ room: id, worker: pooledWorker.index }, 'room created');
    return new Room(id, pooledWorker, router, audioLevelObserver, config, log, hooks);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get rtpCapabilities(): types.RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  // --- membership ---------------------------------------------------------------------------

  join(
    peer: Peer,
    options: { rtpCapabilities: types.RtpCapabilities; muted: boolean; deafened: boolean },
  ): { self: VoicePeer; peers: VoicePeer[] } {
    if (peer.joined) throw new RpcError(VoiceErrorCode.AlreadyJoined, 'already joined');
    if (this.closed) throw new RpcError(VoiceErrorCode.InvalidState, 'room is closed');

    // A user holds one session per channel: a newer connection replaces the older one.
    for (const other of [...this.peers.values()]) {
      if (other.userId === peer.userId)
        this.removePeer(other, VoiceCloseCode.Replaced, 'replaced', true);
    }
    if (this.peers.size >= this.config.maxPeersPerRoom) {
      throw new RpcError(VoiceErrorCode.RoomFull, 'the channel is full');
    }

    peer.rtpCapabilities = options.rtpCapabilities;
    peer.deafened = options.deafened;
    peer.muted = options.muted || options.deafened || !peer.claims.speak;
    peer.joined = true;

    const peers = [...this.peers.values()].map((other) => other.toInfo());
    this.broadcast('peer-joined', { peer: peer.toInfo() });
    this.peers.set(peer.id, peer);
    this.hooks.onPeerJoined?.(this, peer);
    this.log.info({ room: this.id, peer: peer.id, user: peer.userId }, 'peer joined');

    return { self: peer.toInfo(), peers };
  }

  /** Removes a peer and releases everything it owned. Closes the room when it gets empty. */
  removePeer(peer: Peer, code = 1000, reason = '', keepRoomOpen = false): void {
    const wasMember = this.peers.delete(peer.id);
    const producers = wasMember ? peer.toInfo().producers : [];
    peer.close(code, reason);
    if (!wasMember) return;

    this.broadcast('peer-left', { peerId: peer.id });
    for (const producer of producers) this.hooks.onProducerRemoved?.(this, peer, producer);
    this.hooks.onPeerLeft?.(this, peer);
    this.log.info({ room: this.id, peer: peer.id, user: peer.userId }, 'peer left');

    if (this.speaking.includes(peer.id)) {
      this.setSpeaking(this.speaking.filter((id) => id !== peer.id));
    }
    if (this.peers.size === 0 && !keepRoomOpen) this.close();
  }

  close(code: number = VoiceCloseCode.RoomClosed, reason = 'room closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const peer of [...this.peers.values()]) {
      this.peers.delete(peer.id);
      peer.close(code, reason);
      this.hooks.onPeerLeft?.(this, peer);
    }
    this.router.close();
    this.pooledWorker.routers -= 1;
    this.hooks.onClosed?.(this);
    this.log.info({ room: this.id }, 'room closed');
  }

  // --- transports ---------------------------------------------------------------------------

  async createTransport(peer: Peer, direction: TransportDirection) {
    this.assertJoined(peer);

    // One transport per direction: asking again replaces the previous one.
    for (const existing of [...peer.transports.values()]) {
      if (existing.appData.direction === direction) this.closeTransport(peer, existing);
    }

    const transport = await this.router.createWebRtcTransport<TransportAppData>({
      webRtcServer: this.pooledWorker.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: TRANSPORT_BITRATE.initialAvailableOutgoing,
      appData: { peerId: peer.id, direction },
    });
    if (peer.closed || this.closed) {
      transport.close();
      throw new RpcError(VoiceErrorCode.InvalidState, 'peer left while creating the transport');
    }
    peer.transports.set(transport.id, transport);

    if (direction === 'send') {
      await transport.setMaxIncomingBitrate(TRANSPORT_BITRATE.maxIncoming).catch(() => undefined);
    }

    // Orphan protection: a transport whose DTLS handshake starts and never finishes, or whose
    // ICE stays disconnected, is closed and the client is told to reconnect.
    const drop = (why: string) => {
      if (transport.closed) return;
      this.log.debug(
        { room: this.id, peer: peer.id, transport: transport.id, why },
        'dropping transport',
      );
      this.closeTransport(peer, transport);
      peer.rpc.notify('transport-closed', { transportId: transport.id });
    };
    const schedule = (ms: number, why: string) => {
      const timer = setTimeout(() => {
        peer.timers.delete(timer);
        drop(why);
      }, ms);
      peer.timers.add(timer);
      return timer;
    };

    // The clock starts with the handshake, not with the transport: a browser only connects a
    // transport when it first sends or receives through it, and someone alone in a channel has
    // nothing to receive. Timing from creation kicked lone participants out every 30 seconds.
    let connectTimer: NodeJS.Timeout | undefined;
    this.handshakes.set(transport, () => {
      if (connectTimer || transport.dtlsState === 'connected') return;
      connectTimer = schedule(this.config.timeouts.transportConnectMs, 'dtls never connected');
    });
    let iceTimer: NodeJS.Timeout | undefined;
    const clear = (timer: NodeJS.Timeout | undefined) => {
      if (!timer) return;
      clearTimeout(timer);
      peer.timers.delete(timer);
    };

    transport.on('dtlsstatechange', (state) => {
      if (state === 'connected') {
        clear(connectTimer);
        connectTimer = undefined;
      } else if (state === 'failed' || state === 'closed') {
        drop(`dtls ${state}`);
      }
    });
    transport.on('icestatechange', (state) => {
      clear(iceTimer);
      iceTimer = undefined;
      if (state === 'disconnected') {
        iceTimer = schedule(this.config.timeouts.iceDisconnectMs, 'ice disconnected');
      }
    });
    transport.observer.on('close', () => {
      clear(connectTimer);
      clear(iceTimer);
    });

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates as unknown as Array<Record<string, unknown>>,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(
    peer: Peer,
    transportId: string,
    dtlsParameters: types.DtlsParameters,
  ): Promise<void> {
    const transport = this.getTransport(peer, transportId);
    await this.guard(() => transport.connect({ dtlsParameters }));
    this.handshakes.get(transport)?.();
  }

  async restartIce(peer: Peer, transportId: string): Promise<types.IceParameters> {
    const transport = this.getTransport(peer, transportId);
    return transport.restartIce();
  }

  // --- producers ----------------------------------------------------------------------------

  async produce(
    peer: Peer,
    options: {
      transportId: string;
      kind: MediaKind;
      rtpParameters: types.RtpParameters;
      source: ProducerSource;
    },
  ): Promise<string> {
    const transport = this.getTransport(peer, options.transportId);
    if (transport.appData.direction !== 'send') {
      throw new RpcError(VoiceErrorCode.InvalidState, 'not a send transport');
    }
    if (SOURCE_KIND[options.source] !== options.kind) {
      throw new RpcError(
        VoiceErrorCode.InvalidState,
        `source "${options.source}" is not ${options.kind}`,
      );
    }
    this.assertMayPublish(peer, options.source);

    const producer = await this.guard(() =>
      transport.produce<ProducerAppData>({
        kind: options.kind,
        rtpParameters: options.rtpParameters,
        paused: options.source === 'mic' && peer.muted,
        appData: { peerId: peer.id, source: options.source },
      }),
    );
    if (transport.closed) throw new RpcError(VoiceErrorCode.InvalidState, 'transport closed');

    const info = this.registerProducer(peer, producer, 'browser');
    if (options.source === 'mic') {
      await this.audioLevelObserver.addProducer({ producerId: producer.id }).catch(() => undefined);
    }
    this.announceProducer(peer, info);
    return producer.id;
  }

  /**
   * Publishes the screen from a native capture: a plain transport of its own receives the
   * video outside WebRTC, and the producer on it is a screen share like any other. Transport
   * and producer live and die together. `profile`: what the app's H.264 is, which viewers
   * need to know to decode it.
   */
  async createIngest(
    peer: Peer,
    codec: IngestCodec,
    profile: IngestProfile = 'high',
  ): Promise<VoiceIngest> {
    this.assertJoined(peer);
    this.assertMayPublish(peer, 'screen');

    const { rtc, numWorkers } = this.config;
    const [announcedAddress] = rtc.announcedAddresses;
    // The WebRtcServers hold the first ports of the range; ingests share what is left.
    const portRange = {
      min: rtc.minPort + numWorkers * rtc.announcedAddresses.length,
      max: rtc.maxPort,
    };
    if (!announcedAddress || portRange.min >= portRange.max) {
      throw new RpcError(VoiceErrorCode.LimitReached, 'no ports left for an ingest');
    }

    let transport: types.PlainTransport<IngestAppData>;
    try {
      transport = await this.router.createPlainTransport<IngestAppData>({
        listenInfo: { protocol: 'udp', ip: rtc.listenIp, announcedAddress, portRange },
        // The sender has one socket for RTP and another for RTCP, and behind a home router
        // its address is only known when the first packet of each arrives.
        rtcpMux: false,
        comedia: true,
        enableSrtp: true,
        srtpCryptoSuite: INGEST.srtpCryptoSuite,
        appData: { peerId: peer.id },
      });
    } catch (error) {
      if (error instanceof Error && /port/i.test(error.message)) {
        throw new RpcError(VoiceErrorCode.LimitReached, 'no ports left for an ingest');
      }
      throw error;
    }
    if (peer.closed || this.closed) {
      transport.close();
      throw new RpcError(VoiceErrorCode.InvalidState, 'peer left while creating the ingest');
    }
    peer.ingests.set(transport.id, transport);
    transport.observer.on('close', () => peer.ingests.delete(transport.id));

    const keyBase64 = randomBytes(INGEST.srtpKeyLength).toString('base64');
    // Kept below 2^31: the sender takes it as a signed number.
    const ssrc = randomInt(1, 0x7fffffff);
    try {
      await transport.connect({
        srtpParameters: { cryptoSuite: INGEST.srtpCryptoSuite, keyBase64 },
      });
      const producer = await transport.produce<ProducerAppData>({
        kind: 'video',
        rtpParameters: {
          codecs: [
            {
              ...(codec === 'h264' && profile === 'main'
                ? INGEST.codecs.h264Main
                : INGEST.codecs[codec]),
              payloadType: INGEST.payloadType,
              rtcpFeedback: INGEST.rtcpFeedback,
            },
          ],
          encodings: [{ ssrc }],
        },
        appData: { peerId: peer.id, source: 'screen' },
      });
      // Two requests at once both pass the first check.
      this.assertMayPublish(peer, 'screen');
      producer.observer.on('close', () => transport.close());
      this.announceProducer(peer, this.registerProducer(peer, producer, 'native'));
      const where = { room: this.id, peer: peer.id, user: peer.userId, codec };
      this.log.info({ ...where, port: transport.tuple.localPort }, 'ingest opened');
      // The sender shows as live either way: whether its packets arrive is only known here.
      setTimeout(() => {
        if (transport.closed) return;
        void transport.getStats().then(
          ([stats]) => {
            const bytes = stats?.bytesReceived ?? 0;
            if (bytes > 0) this.log.info({ ...where, bytes }, 'ingest receiving');
            else this.log.warn(where, 'ingest received nothing in 5 s');
          },
          () => undefined,
        );
      }, 5000).unref();

      return {
        producerId: producer.id,
        address: announcedAddress,
        rtpPort: transport.tuple.localPort,
        // Set whenever RTCP is not multiplexed, as asked above.
        rtcpPort: transport.rtcpTuple?.localPort ?? transport.tuple.localPort + 1,
        ssrc,
        payloadType: INGEST.payloadType,
        srtp: {
          cryptoSuite: INGEST.srtpCryptoSuite,
          keyBase64,
          // mediasoup encrypts what it sends with a key of its own, not the one it was given.
          serverKeyBase64: transport.srtpParameters?.keyBase64,
        },
      };
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  /**
   * Keeps what a browser measured of a screen share: its owner about the share, anyone
   * consuming it about what they see. Anything else is ignored, as are late reports.
   */
  reportStreamStats(peer: Peer, event: StreamStatsEvent): void {
    const telemetry = this.streams.get(event.producerId);
    if (!telemetry || !this.peers.has(peer.id)) return;
    if (event.role === 'sender') {
      if (peer.producers.has(event.producerId)) telemetry.addSender(event.sample);
      return;
    }
    const watching = [...peer.consumers.values()].some(
      (consumer) => consumer.producerId === event.producerId,
    );
    if (watching) telemetry.addViewer(peer.userId, event.sample);
  }

  /**
   * Keeps what a browser measured of a voice: its owner about the microphone, anyone hearing
   * it about what arrives. Anything else is ignored, as are late reports.
   */
  reportVoiceStats(peer: Peer, event: VoiceStatsEvent): void {
    const telemetry = this.voices.get(event.producerId);
    if (!telemetry || !this.peers.has(peer.id)) return;
    if (event.role === 'speaker') {
      if (peer.producers.has(event.producerId)) telemetry.addSpeaker(event.sample);
      return;
    }
    const hearing = [...peer.consumers.values()].some(
      (consumer) => consumer.producerId === event.producerId,
    );
    if (hearing) telemetry.addListener(peer.userId, event.sample);
  }

  closeProducer(peer: Peer, producerId: string): void {
    const producer = peer.producers.get(producerId);
    if (!producer) throw new RpcError(VoiceErrorCode.NotFound, 'unknown producer');
    producer.close();
  }

  // --- consumers ----------------------------------------------------------------------------

  async consume(peer: Peer, producerId: string) {
    this.assertJoined(peer);
    const owner = [...this.peers.values()].find((other) => other.producers.has(producerId));
    const producer = owner?.producers.get(producerId);
    if (!owner || !producer) throw new RpcError(VoiceErrorCode.NotFound, 'unknown producer');
    if (owner.id === peer.id) {
      throw new RpcError(VoiceErrorCode.CannotConsume, 'cannot consume your own producer');
    }
    for (const existing of peer.consumers.values()) {
      if (existing.producerId === producerId) {
        throw new RpcError(VoiceErrorCode.LimitReached, 'already consuming this producer');
      }
    }
    const transport = [...peer.transports.values()].find(
      (candidate) => candidate.appData.direction === 'recv',
    );
    if (!transport) throw new RpcError(VoiceErrorCode.InvalidState, 'no receive transport');
    if (
      !peer.rtpCapabilities ||
      !this.router.canConsume({ producerId, rtpCapabilities: peer.rtpCapabilities })
    ) {
      throw new RpcError(VoiceErrorCode.CannotConsume, 'incompatible capabilities');
    }

    // Consumers start paused and flow only after the client confirms it is ready.
    const consumer = await transport.consume<ConsumerAppData>({
      producerId,
      rtpCapabilities: peer.rtpCapabilities,
      paused: true,
      appData: { peerId: peer.id, source: producer.appData.source, wanted: false },
    });
    peer.consumers.set(consumer.id, consumer);

    consumer.observer.on('close', () => {
      if (!peer.consumers.delete(consumer.id)) return;
      if (!peer.closed) peer.rpc.notify('consumer-closed', { consumerId: consumer.id });
      this.syncViewers(producerId);
    });
    consumer.on('layerschange', (layers) => {
      if (peer.closed) return;
      peer.rpc.notify('consumer-layers', {
        consumerId: consumer.id,
        spatialLayer: layers?.spatialLayer ?? null,
      });
    });

    return {
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters as unknown as {
        codecs: Array<Record<string, unknown>>;
      },
    };
  }

  async resumeConsumer(peer: Peer, consumerId: string): Promise<void> {
    const consumer = this.getConsumer(peer, consumerId);
    consumer.appData.wanted = true;
    // Deafen holds voices paused on the server, saving the bandwidth too. The sound of a
    // stream is not part of the call and keeps flowing.
    if (peer.deafened && consumer.appData.source === 'mic') return;
    await consumer.resume();
    this.syncViewers(consumer.producerId);
  }

  /**
   * `hidden` keeps the consumer wanted: its viewer still watches, only not on screen right
   * now, so they stay in the streamer's list of viewers and nothing is sent meanwhile.
   */
  async pauseConsumer(peer: Peer, consumerId: string, hidden = false): Promise<void> {
    const consumer = this.getConsumer(peer, consumerId);
    consumer.appData.wanted = hidden;
    await consumer.pause();
    this.syncViewers(consumer.producerId);
  }

  closeConsumer(peer: Peer, consumerId: string): void {
    const consumer = this.getConsumer(peer, consumerId);
    peer.consumers.delete(consumer.id);
    consumer.close();
    this.syncViewers(consumer.producerId);
  }

  async setConsumerLayers(peer: Peer, consumerId: string, spatialLayer: number): Promise<void> {
    const consumer = this.getConsumer(peer, consumerId);
    if (consumer.type !== 'simulcast') return;
    await consumer.setPreferredLayers({ spatialLayer });
  }

  // --- state --------------------------------------------------------------------------------

  async setState(peer: Peer, state: { muted: boolean; deafened: boolean }): Promise<void> {
    this.assertJoined(peer);
    const deafened = state.deafened;
    const muted = state.muted || deafened || !peer.claims.speak;
    if (peer.muted === muted && peer.deafened === deafened) return;
    peer.muted = muted;
    peer.deafened = deafened;

    for (const producer of peer.producers.values()) {
      if (producer.appData.source !== 'mic') continue;
      await (muted ? producer.pause() : producer.resume());
    }
    for (const consumer of peer.consumers.values()) {
      if (consumer.appData.source !== 'mic') continue;
      if (deafened) await consumer.pause();
      else if (consumer.appData.wanted) await consumer.resume();
    }

    this.broadcast('peer-state', { peerId: peer.id, muted, deafened });
    this.hooks.onPeerState?.(this, peer);
    if (muted && this.speaking.includes(peer.id)) {
      this.setSpeaking(this.speaking.filter((id) => id !== peer.id));
    }
  }

  // --- introspection ------------------------------------------------------------------------

  stats(): RoomStats {
    return {
      id: this.id,
      worker: this.pooledWorker.index,
      peers: [...this.peers.values()].map((peer) => ({
        id: peer.id,
        userId: peer.userId,
        name: peer.claims.name,
        muted: peer.muted,
        deafened: peer.deafened,
        transports: peer.transports.size + peer.ingests.size,
        producers: [...peer.producers.values()].map((producer) => ({
          id: producer.id,
          kind: producer.kind,
          source: producer.appData.source,
          paused: producer.paused,
          type: producer.type,
          layers: producer.rtpParameters.encodings?.length ?? 1,
        })),
        consumers: [...peer.consumers.values()].map((consumer) => ({
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          source: consumer.appData.source,
          paused: consumer.paused,
          preferredSpatialLayer: consumer.preferredLayers?.spatialLayer ?? null,
          currentSpatialLayer: consumer.currentLayers?.spatialLayer ?? null,
        })),
      })),
    };
  }

  // --- internals ----------------------------------------------------------------------------

  private broadcast<E extends ClientEvent>(
    event: E,
    data: EventInput<typeof voiceClientSide, E>,
    exceptPeerId?: string,
  ): void {
    for (const peer of this.peers.values()) {
      if (peer.id !== exceptPeerId) peer.rpc.notify(event, data);
    }
  }

  private setSpeaking(peerIds: string[]): void {
    const next = [...new Set(peerIds)].filter((id) => this.peers.has(id));
    if (next.length === this.speaking.length && next.every((id) => this.speaking.includes(id))) {
      return;
    }
    this.speaking = next;
    this.broadcast('speaking', { peerIds: next });
  }

  private closeTransport(peer: Peer, transport: types.WebRtcTransport<TransportAppData>): void {
    peer.transports.delete(transport.id);
    transport.close();
  }

  /**
   * Tells whoever shares a screen who is watching it, when that changed. Watching means
   * having asked for the video and not paused it; a consumer that only exists does not count.
   */
  private syncViewers(producerId: string): void {
    const peers = [...this.peers.values()];
    const owner = peers.find((peer) => peer.producers.has(producerId));
    if (!owner || owner.closed || owner.producers.get(producerId)?.appData.source !== 'screen') {
      this.viewers.delete(producerId);
      return;
    }
    const peerIds = peers
      .filter((peer) =>
        [...peer.consumers.values()].some(
          (consumer) =>
            consumer.producerId === producerId && consumer.appData.wanted && !consumer.closed,
        ),
      )
      .map((peer) => peer.id)
      .sort();
    const key = peerIds.join(',');
    if ((this.viewers.get(producerId) ?? '') === key) return;
    this.viewers.set(producerId, key);
    owner.rpc.notify('stream-viewers', { peerIds });
  }

  /**
   * Hands a producer to its peer and reports its end to the room. A screen share is measured
   * from the start; `path` says how its picture is sent.
   */
  private registerProducer(
    peer: Peer,
    producer: types.Producer<ProducerAppData>,
    path: StreamPath,
  ): VoiceProducer {
    peer.producers.set(producer.id, producer);
    if (producer.appData.source === 'screen') {
      const telemetry = new StreamTelemetry(producer, path, (chunk) =>
        this.hooks.onStreamReport?.(this, peer, chunk),
      );
      this.streams.set(producer.id, telemetry);
      producer.observer.on('close', () => {
        this.streams.delete(producer.id);
        telemetry.close();
      });
    }
    if (producer.appData.source === 'mic') {
      const telemetry = new VoiceTelemetry(producer, (chunk) =>
        this.hooks.onVoiceReport?.(this, peer, chunk),
      );
      this.voices.set(producer.id, telemetry);
      producer.observer.on('close', () => {
        this.voices.delete(producer.id);
        telemetry.close();
      });
    }
    const info: VoiceProducer = {
      id: producer.id,
      kind: producer.kind,
      source: producer.appData.source,
    };
    producer.observer.on('close', () => {
      if (!peer.producers.delete(producer.id)) return;
      if (!this.peers.has(peer.id)) return;
      this.broadcast('producer-removed', { peerId: peer.id, producerId: producer.id }, peer.id);
      this.hooks.onProducerRemoved?.(this, peer, info);
    });
    return info;
  }

  private announceProducer(peer: Peer, info: VoiceProducer): void {
    this.broadcast('producer-added', { peerId: peer.id, producer: info }, peer.id);
    this.hooks.onProducerAdded?.(this, peer, info);
  }

  /** The permission for that source, and one producer of each per peer. */
  private assertMayPublish(peer: Peer, source: ProducerSource): void {
    const allowed = source === 'mic' ? peer.claims.speak : peer.claims.stream;
    if (!allowed) throw new RpcError(VoiceErrorCode.Forbidden, 'missing permission');
    for (const existing of peer.producers.values()) {
      if (existing.appData.source === source) {
        throw new RpcError(VoiceErrorCode.LimitReached, `already producing "${source}"`);
      }
    }
  }

  private assertJoined(peer: Peer): void {
    if (!peer.joined || peer.closed || !this.peers.has(peer.id)) {
      throw new RpcError(VoiceErrorCode.NotJoined, 'join the channel first');
    }
  }

  private getTransport(peer: Peer, transportId: string) {
    this.assertJoined(peer);
    const transport = peer.transports.get(transportId);
    if (!transport) throw new RpcError(VoiceErrorCode.NotFound, 'unknown transport');
    return transport;
  }

  private getConsumer(peer: Peer, consumerId: string) {
    this.assertJoined(peer);
    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw new RpcError(VoiceErrorCode.NotFound, 'unknown consumer');
    return consumer;
  }

  /** mediasoup rejects malformed client parameters with TypeError; report those as such. */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TypeError) {
        throw new RpcError('invalid_payload', error.message);
      }
      if (
        error instanceof Error &&
        /already|invalid|unsupported|not supported/i.test(error.message)
      ) {
        throw new RpcError(VoiceErrorCode.InvalidState, error.message);
      }
      throw error;
    }
  }
}
