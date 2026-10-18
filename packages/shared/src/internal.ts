import { z } from 'zod';
import { defineSide } from './rpc/peer';
import { empty } from './signaling/common';
import { streamPathSchema, streamSampleSchema } from './stream-telemetry';
import { voiceSampleSchema } from './voice-telemetry';

/**
 * Internal RPC between the API and the media service, over a WebSocket the API opens to
 * `${MEDIA_PREFIX}${INTERNAL_RPC_PATH}` with `Authorization: Bearer <shared secret>`.
 * The media service reports voice membership; the API enforces moderation decisions.
 */
export const INTERNAL_RPC_PATH = '/internal';

export const internalVoiceStateSchema = z.object({
  muted: z.boolean(),
  deafened: z.boolean(),
  streaming: z.boolean(),
});
export type InternalVoiceState = z.infer<typeof internalVoiceStateSchema>;

export const internalVoicePeerSchema = z.object({
  /** Voice channel id. */
  roomId: z.string(),
  userId: z.string(),
  /** Session id; distinguishes a reconnect from the session it replaces. */
  peerId: z.string(),
  state: internalVoiceStateSchema,
});
export type InternalVoicePeer = z.infer<typeof internalVoicePeerSchema>;

export const mediaStatsSchema = z.object({
  rooms: z.number().int(),
  peers: z.number().int(),
  transports: z.number().int(),
  producers: z.number().int(),
  consumers: z.number().int(),
  connections: z.number().int(),
  workers: z.array(
    z.object({
      index: z.number().int(),
      pid: z.number().int(),
      routers: z.number().int(),
      /** CPU time consumed since the worker started, in seconds. */
      cpuUserSeconds: z.number(),
      cpuSystemSeconds: z.number(),
    }),
  ),
});
export type MediaStatsTotals = z.infer<typeof mediaStatsSchema>;

/** What the media service accepts from the API. */
export const mediaInternalSide = defineSide({
  requests: {
    /** Everyone currently in a voice channel, to rebuild state after a reconnect. */
    snapshot: {
      request: empty,
      response: z.object({ nodeId: z.string(), peers: z.array(internalVoicePeerSchema) }),
    },
    /** Drops a user from one voice channel, or from all of them. */
    disconnectUser: {
      request: z.object({
        userId: z.string(),
        roomId: z.string().optional(),
        /** `permissions` lets the client rejoin with a fresh token; `kicked` does not. */
        reason: z.enum(['kicked', 'permissions']).default('kicked'),
      }),
      response: z.object({ disconnected: z.number().int() }),
    },
    /** Closes a voice channel, disconnecting everyone in it. */
    closeRoom: { request: z.object({ roomId: z.string() }), response: empty },
    stats: { request: empty, response: mediaStatsSchema },
  },
  events: {},
});

/** What the API accepts from the media service. */
export const apiInternalSide = defineSide({
  requests: {},
  events: {
    /** A participant joined, changed state, or (with `state: null`) left a voice channel. */
    'voice-state': z.object({
      /** Unique per media node; lets several API instances process each event once. */
      eventId: z.string(),
      roomId: z.string(),
      userId: z.string(),
      peerId: z.string(),
      state: internalVoiceStateSchema.nullable(),
    }),
    /**
     * New samples of a screen share, sent about once a minute and when it ends (`endedAt`).
     * The first chunk of a stream creates its report; later ones are appended to it.
     */
    'stream-report': z.object({
      eventId: z.string(),
      /** The screen producer; identifies the stream. */
      producerId: z.string(),
      roomId: z.string(),
      userId: z.string(),
      path: streamPathSchema,
      codec: z.string().nullable(),
      startedAt: z.iso.datetime(),
      endedAt: z.iso.datetime().nullable(),
      samples: z.array(streamSampleSchema),
    }),
    /** New samples of a voice in a call, like `stream-report`; one report per microphone. */
    'voice-report': z.object({
      eventId: z.string(),
      /** The microphone producer; identifies the voice. */
      producerId: z.string(),
      roomId: z.string(),
      userId: z.string(),
      startedAt: z.iso.datetime(),
      endedAt: z.iso.datetime().nullable(),
      samples: z.array(voiceSampleSchema),
    }),
  },
});
