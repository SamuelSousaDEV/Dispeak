import { z } from 'zod';
import { defineSide } from '../rpc/peer';
import { streamSenderSampleSchema, streamViewerSampleSchema } from '../stream-telemetry';
import { voiceListenerSampleSchema, voiceSpeakerSampleSchema } from '../voice-telemetry';
import { empty, iceServerSchema, nicknameSchema } from './common';

/**
 * Voice channel signaling between a browser and the media service (SFU).
 * The browser connects to `${MEDIA_PREFIX}${VOICE_SIGNALING_PATH}?token=<voice token>`.
 */
export const VOICE_SIGNALING_PATH = '/voice';
export const VOICE_TOKEN_AUDIENCE = 'frequencia:voice';
export const VOICE_TOKEN_ISSUER = 'frequencia:api';

/** Screen shares and cameras are published as simulcast with this many spatial layers. */
export const SIMULCAST_LAYERS = 3;

export const VoiceErrorCode = {
  NotJoined: 'not_joined',
  AlreadyJoined: 'already_joined',
  RoomFull: 'room_full',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  InvalidState: 'invalid_state',
  CannotConsume: 'cannot_consume',
  LimitReached: 'limit_reached',
} as const;

/** WebSocket close codes used by the media service. */
export const VoiceCloseCode = {
  Unauthorized: 4001,
  Replaced: 4002,
  Kicked: 4003,
  JoinTimeout: 4004,
  RoomClosed: 4005,
  /** The user's permissions changed: reconnect with a fresh token to pick them up. */
  PermissionsChanged: 4006,
} as const;

/** Claims of the short-lived token the API issues to let a user into one voice channel. */
export const voiceTokenClaimsSchema = z.object({
  /** User id. */
  sub: z.string().min(1).max(64),
  /** Display name shown to the other participants. */
  name: z.string().min(1).max(64),
  /** Voice channel id; one mediasoup router per channel. */
  room: z.string().min(1).max(64),
  /** May publish microphone audio. */
  speak: z.boolean(),
  /** May publish video: a screen share (with its audio) or the camera. */
  stream: z.boolean(),
});
export type VoiceTokenClaims = z.infer<typeof voiceTokenClaimsSchema>;

// --- mediasoup parameters -------------------------------------------------------------------
// Browser-provided parameters are bounded here and fully validated by mediasoup itself.

const looseObject = z.record(z.string(), z.unknown());

export const rtpCapabilitiesSchema = z.object({
  codecs: z.array(looseObject).max(64).optional(),
  headerExtensions: z.array(looseObject).max(64).optional(),
});

export const rtpParametersSchema = z.object({
  mid: z.string().max(64).optional(),
  codecs: z.array(looseObject).min(1).max(16),
  headerExtensions: z.array(looseObject).max(32).optional(),
  encodings: z.array(looseObject).max(8).optional(),
  rtcp: looseObject.optional(),
});

export const dtlsParametersSchema = z.object({
  role: z.enum(['auto', 'client', 'server']).optional(),
  fingerprints: z
    .array(z.object({ algorithm: z.string().max(32), value: z.string().max(256) }))
    .min(1)
    .max(8),
});

export const iceParametersSchema = z.object({
  usernameFragment: z.string(),
  password: z.string(),
  iceLite: z.boolean().optional(),
});

export const transportDirectionSchema = z.enum(['send', 'recv']);
export type TransportDirection = z.infer<typeof transportDirectionSchema>;

export const transportOptionsSchema = z.object({
  id: z.string(),
  iceParameters: iceParametersSchema,
  iceCandidates: z.array(looseObject),
  dtlsParameters: dtlsParametersSchema,
});

// --- domain ---------------------------------------------------------------------------------

export const mediaKindSchema = z.enum(['audio', 'video']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/** What a producer carries. */
export const producerSourceSchema = z.enum(['mic', 'camera', 'screen', 'screen-audio']);
export type ProducerSource = z.infer<typeof producerSourceSchema>;

export const voiceProducerSchema = z.object({
  id: z.string(),
  kind: mediaKindSchema,
  source: producerSourceSchema,
});
export type VoiceProducer = z.infer<typeof voiceProducerSchema>;

export const voicePeerSchema = z.object({
  /** Session id, unique per connection. */
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  muted: z.boolean(),
  deafened: z.boolean(),
  producers: z.array(voiceProducerSchema),
});
export type VoicePeer = z.infer<typeof voicePeerSchema>;

/** Codecs the desktop app's native capture can send. */
export const ingestCodecSchema = z.enum(['av1', 'h264']);
export type IngestCodec = z.infer<typeof ingestCodecSchema>;
/**
 * The H.264 profile a native capture sends. Main is what every viewer decodes, with or without a
 * graphics card; High needs the card's decoder. Desktop apps before 0.12.2 send High.
 */
export const ingestProfileSchema = z.enum(['main', 'high']);
export type IngestProfile = z.infer<typeof ingestProfileSchema>;

const udpPort = z.number().int().min(1).max(65535);

/**
 * Where a native capture sends its video, outside WebRTC: SRTP over UDP to `address`, RTP and
 * RTCP on separate ports, with exactly this SSRC, payload type and key.
 */
export const voiceIngestSchema = z.object({
  producerId: z.string(),
  address: z.string(),
  rtpPort: udpPort,
  rtcpPort: udpPort,
  ssrc: z.number().int().positive(),
  payloadType: z.number().int().min(0).max(127),
  srtp: z.object({
    cryptoSuite: z.string(),
    /** What the sender encrypts with. */
    keyBase64: z.string(),
    /**
     * What the server encrypts its RTCP with (requests for lost packets and key frames). Absent
     * from servers that predate the app's capture engine.
     */
    serverKeyBase64: z.string().optional(),
  }),
});
export type VoiceIngest = z.infer<typeof voiceIngestSchema>;

const consumerRef = z.object({ consumerId: z.string() });
const producerRef = z.object({ producerId: z.string() });

/** What the media service accepts from a browser. */
export const voiceServerSide = defineSide({
  requests: {
    getRouterCapabilities: {
      request: empty,
      response: z.object({ rtpCapabilities: rtpCapabilitiesSchema }),
    },
    join: {
      request: z.object({
        rtpCapabilities: rtpCapabilitiesSchema,
        muted: z.boolean().default(false),
        deafened: z.boolean().default(false),
      }),
      response: z.object({ self: voicePeerSchema, peers: z.array(voicePeerSchema) }),
    },
    createTransport: {
      request: z.object({ direction: transportDirectionSchema }),
      response: transportOptionsSchema,
    },
    connectTransport: {
      request: z.object({ transportId: z.string(), dtlsParameters: dtlsParametersSchema }),
      response: empty,
    },
    restartIce: {
      request: z.object({ transportId: z.string() }),
      response: z.object({ iceParameters: iceParametersSchema }),
    },
    produce: {
      request: z.object({
        transportId: z.string(),
        kind: mediaKindSchema,
        rtpParameters: rtpParametersSchema,
        source: producerSourceSchema,
      }),
      response: producerRef,
    },
    /**
     * Publishes the screen from a native capture instead of the browser: the server opens a
     * plain transport, announces the producer like any other screen share and answers where
     * to send. `closeProducer` ends it.
     */
    createIngest: {
      request: z.object({ codec: ingestCodecSchema, profile: ingestProfileSchema.optional() }),
      response: voiceIngestSchema,
    },
    closeProducer: { request: producerRef, response: empty },
    consume: {
      request: producerRef,
      response: z.object({
        consumerId: z.string(),
        producerId: z.string(),
        kind: mediaKindSchema,
        rtpParameters: rtpParametersSchema,
      }),
    },
    resumeConsumer: { request: consumerRef, response: empty },
    /**
     * Stops the media of a consumer. `hidden`: the user still watches, the stream is only off
     * screen for now (window minimised, another channel open); the streamer still counts them.
     */
    pauseConsumer: {
      request: consumerRef.extend({ hidden: z.boolean().optional() }),
      response: empty,
    },
    closeConsumer: { request: consumerRef, response: empty },
    /** Picks the simulcast layer a video consumer should receive (0 = lowest resolution). */
    setConsumerLayers: {
      request: z.object({
        consumerId: z.string(),
        spatialLayer: z
          .number()
          .int()
          .min(0)
          .max(SIMULCAST_LAYERS - 1),
      }),
      response: empty,
    },
    setState: {
      request: z.object({ muted: z.boolean(), deafened: z.boolean() }),
      response: empty,
    },
    leave: { request: empty, response: empty },
  },
  events: {
    /**
     * What the browser measures of a screen share, every couple of seconds: its own share
     * (`sender`), or one it watches (`viewer`). Only kept as telemetry.
     */
    'stream-stats': z.discriminatedUnion('role', [
      z.object({
        role: z.literal('sender'),
        producerId: z.string().max(64),
        sample: streamSenderSampleSchema,
      }),
      z.object({
        role: z.literal('viewer'),
        producerId: z.string().max(64),
        sample: streamViewerSampleSchema,
      }),
    ]),
    /**
     * What the browser measures of a voice, every couple of seconds: its own microphone
     * (`speaker`), or a voice it hears (`listener`). Only kept as telemetry.
     */
    'voice-stats': z.discriminatedUnion('role', [
      z.object({
        role: z.literal('speaker'),
        producerId: z.string().max(64),
        sample: voiceSpeakerSampleSchema,
      }),
      z.object({
        role: z.literal('listener'),
        producerId: z.string().max(64),
        sample: voiceListenerSampleSchema,
      }),
    ]),
  },
});

/** What a browser accepts from the media service. */
export const voiceClientSide = defineSide({
  requests: {},
  events: {
    'peer-joined': z.object({ peer: voicePeerSchema }),
    'peer-left': z.object({ peerId: z.string() }),
    'peer-state': z.object({ peerId: z.string(), muted: z.boolean(), deafened: z.boolean() }),
    'producer-added': z.object({ peerId: z.string(), producer: voiceProducerSchema }),
    'producer-removed': z.object({ peerId: z.string(), producerId: z.string() }),
    /** Session ids of the peers currently speaking, loudest first. */
    speaking: z.object({ peerIds: z.array(z.string()) }),
    'consumer-closed': consumerRef,
    /** The simulcast layer actually being forwarded changed (`null` while nothing flows). */
    'consumer-layers': z.object({
      consumerId: z.string(),
      spatialLayer: z.number().int().nullable(),
    }),
    /**
     * Sent to someone sharing their screen: the session ids of the peers watching it right
     * now. Repeated whenever the list changes; empty when the last viewer leaves.
     */
    'stream-viewers': z.object({ peerIds: z.array(z.string()) }),
    /** The server dropped a transport (ICE/DTLS failure); the client must reconnect. */
    'transport-closed': z.object({ transportId: z.string() }),
  },
});

export const voiceTokenResponseSchema = z.object({
  token: z.string(),
  iceServers: z.array(iceServerSchema),
});
export type VoiceTokenResponse = z.infer<typeof voiceTokenResponseSchema>;

/** Lab-only token request: identity is a nickname until accounts exist. */
export const LAB_VOICE_TOKEN_PATH = '/lab/voice-token';
export const labVoiceTokenRequestSchema = z.object({
  nickname: nicknameSchema,
  channel: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/),
  /** Stable per-browser id so a reconnect replaces the previous session. */
  clientId: z.uuid(),
});
export type LabVoiceTokenRequest = z.infer<typeof labVoiceTokenRequestSchema>;
