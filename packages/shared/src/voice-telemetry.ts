import { z } from 'zod';

/**
 * Telemetry of voices in calls, measured where a voice passes: the speaker's machine, the media
 * service and each listener's machine. A voice that sounds choppy or robotic to someone says
 * where it broke: packets lost on the speaker's way up (everyone hears it), or on one
 * listener's way down (only that listener does).
 */

/** Seconds the media service gathers before it writes one sample of a voice. */
export const VOICE_SAMPLE_SECONDS = 10;

const count = z.number().int().min(0).max(1_000_000_000);
const rate = z.number().min(0).max(100_000);
const ms = z.number().min(0).max(3_600_000);
const percent = z.number().min(0).max(100);

/** What cleans a microphone (see `NoiseEngine` on the web). */
export const voiceNoiseEngineSchema = z.enum(['gtcrn', 'rnnoise', 'browser', 'off']);

/** What the speaker's machine says about its own microphone. */
export const voiceSpeakerSampleSchema = z.object({
  noiseSuppression: voiceNoiseEngineSchema.nullable(),
  echoCancellation: z.boolean().nullable(),
  autoGainControl: z.boolean().nullable(),
  /** Round trip from this machine to the media service. */
  rttMs: ms.nullable(),
});
export type VoiceSpeakerSample = z.infer<typeof voiceSpeakerSampleSchema>;

/** What one listener's machine measures of one voice, for the last couple of seconds. */
export const voiceListenerSampleSchema = z.object({
  /** Packets that never arrived, of those expected. */
  lossPercent: percent.nullable(),
  /**
   * Share of the voice played that the browser made up to cover missing packets, not counting
   * the silence it fills in: what sounds robotic, cut or muffled.
   */
  concealedPercent: percent.nullable(),
  /** Variation in the arrival of packets. */
  jitterMs: ms.nullable(),
  /** Time the voice waits in the jitter buffer before it plays. */
  jitterBufferMs: ms.nullable(),
  /** Round trip from this machine to the media service. */
  rttMs: ms.nullable(),
});
export type VoiceListenerSample = z.infer<typeof voiceListenerSampleSchema>;

/** What the media service measures of the voice arriving from the speaker. */
export const voiceServerSampleSchema = z.object({
  kbps: rate,
  /** Packets that arrived, and those the server noticed missing: the speaker's way up. */
  packets: count,
  packetsLost: count,
});
export type VoiceServerSample = z.infer<typeof voiceServerSampleSchema>;

/** One window of `VOICE_SAMPLE_SECONDS` of a voice, seen from everywhere. */
export const voiceSampleSchema = z.object({
  /** Seconds since the voice joined the call, at the end of the window. */
  t: z.number().min(0),
  server: voiceServerSampleSchema,
  speaker: voiceSpeakerSampleSchema.nullable(),
  listeners: z.array(voiceListenerSampleSchema.extend({ userId: z.string().max(64) })).max(64),
});
export type VoiceSample = z.infer<typeof voiceSampleSchema>;

/** A stored voice: one person's microphone during one stay in a call. */
export const voiceReportSummarySchema = z.object({
  id: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  guildName: z.string(),
  userId: z.string(),
  userName: z.string(),
  startedAt: z.string(),
  /** `null` while the person is still in the call, or when the end never arrived. */
  endedAt: z.string().nullable(),
  sampleCount: z.number().int(),
});
export type VoiceReportSummary = z.infer<typeof voiceReportSummarySchema>;

/** A stored voice with its samples, in order. */
export const voiceReportSchema = voiceReportSummarySchema.extend({
  samples: z.array(voiceSampleSchema),
  /** Display names of the listeners that appear in the samples, by user id. */
  listenerNames: z.record(z.string(), z.string()),
});
export type VoiceReport = z.infer<typeof voiceReportSchema>;

export const voiceReportListSchema = z.object({ reports: z.array(voiceReportSummarySchema) });
