import { z } from 'zod';

/**
 * Telemetry of screen shares, measured at the three places a frame passes: the streamer's
 * machine, the media service and each viewer's machine. With all three side by side, a stream
 * that stutters says where: frames never captured or encoded, frames lost on the way, or frames
 * that arrived and were not shown.
 */

/** Seconds the media service gathers before it writes one sample of a stream. */
export const STREAM_SAMPLE_SECONDS = 5;

const count = z.number().int().min(0).max(1_000_000_000);
const rate = z.number().min(0).max(100_000);
const ms = z.number().min(0).max(3_600_000);
const label = z.string().max(64);
const percent = z.number().min(0).max(100);

/**
 * How loaded the machine is while it sends or watches, from the desktop app (0.12 and later;
 * absent from browsers and older apps). Graphics card: the busiest engine of each kind, as the
 * Task Manager counts it, for the app alone and for the whole machine.
 */
const machineLoad = {
  gpuApp3d: percent.nullable().optional(),
  gpuAppVideo: percent.nullable().optional(),
  gpu3d: percent.nullable().optional(),
  gpuVideo: percent.nullable().optional(),
  /** Streams this machine was receiving at the time. */
  watching: count.nullable().optional(),
};

/** How the picture leaves the streamer's machine. */
export const streamPathSchema = z.enum(['browser', 'native']);
export type StreamPath = z.infer<typeof streamPathSchema>;

/** What the streamer's machine measures, for the last couple of seconds. */
export const streamSenderSampleSchema = z.object({
  /** Frames the capture handed over, before the encoder drops any. */
  captureFps: rate.nullable(),
  /** Frames that left, at the highest layer. */
  sentFps: rate.nullable(),
  /** Time the encoder takes per frame, all layers together. */
  encodeMs: ms.nullable(),
  width: count.nullable(),
  height: count.nullable(),
  kbps: rate.nullable(),
  /** Why the encoder is holding back (`cpu`, `bandwidth`), if it is. */
  limitation: label.nullable(),
  encoder: label.nullable(),
  /** Screen preset in use (`1080p60`). */
  preset: label.nullable(),
  /**
   * Where the stream's sound comes from: `program` (the shared program alone), `mix` (the PC
   * without voice chats), `system` (everything, voice chats included), or `null` for none.
   * Absent from apps before 0.13.0.
   */
  audio: z.enum(['program', 'mix', 'system']).nullable().default(null),
  ...machineLoad,
});
export type StreamSenderSample = z.infer<typeof streamSenderSampleSchema>;

/** What one viewer's machine measures, for the last couple of seconds. */
export const streamViewerSampleSchema = z.object({
  /** Frames shown per second. */
  fps: rate.nullable(),
  /** Frames that arrived and were thrown away before being shown, since the last sample. */
  framesDropped: count,
  /** Times the picture stood still, and for how long altogether, since the last sample. */
  freezes: count,
  freezeMs: ms,
  /** Time to decode one frame. */
  decodeMs: ms.nullable(),
  /** Time a frame waits in the jitter buffer before decoding. */
  jitterBufferMs: ms.nullable(),
  lossPercent: rate.nullable(),
  width: count.nullable(),
  height: count.nullable(),
  kbps: rate.nullable(),
  decoder: label.nullable(),
  ...machineLoad,
});
export type StreamViewerSample = z.infer<typeof streamViewerSampleSchema>;

/** What the media service measures of the frames arriving from the streamer. */
export const streamServerSampleSchema = z.object({
  /** Whole frames that arrived per second, at the highest layer. */
  fps: rate,
  /** Time between two frames arriving: median, 95th percentile and longest. */
  gapP50Ms: ms.nullable(),
  gapP95Ms: ms.nullable(),
  gapMaxMs: ms.nullable(),
  kbps: rate,
  keyFrames: count,
  /** Packets the server noticed missing, and asked for again. */
  packetsLost: count,
  nacks: count,
  /** Key frames the server asked the streamer for. */
  plis: count,
});
export type StreamServerSample = z.infer<typeof streamServerSampleSchema>;

/** One window of `STREAM_SAMPLE_SECONDS` of a stream, seen from everywhere. */
export const streamSampleSchema = z.object({
  /** Seconds since the stream started, at the end of the window. */
  t: z.number().min(0),
  server: streamServerSampleSchema,
  sender: streamSenderSampleSchema.nullable(),
  viewers: z.array(streamViewerSampleSchema.extend({ userId: z.string().max(64) })).max(64),
});
export type StreamSample = z.infer<typeof streamSampleSchema>;

/** A stored stream: who sent it, where and how. */
export const streamReportSummarySchema = z.object({
  id: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  guildName: z.string(),
  userId: z.string(),
  userName: z.string(),
  path: streamPathSchema,
  codec: z.string().nullable(),
  startedAt: z.string(),
  /** `null` while the stream is still on, or when its end never arrived. */
  endedAt: z.string().nullable(),
  sampleCount: z.number().int(),
});
export type StreamReportSummary = z.infer<typeof streamReportSummarySchema>;

/** A stored stream with its samples, in order. */
export const streamReportSchema = streamReportSummarySchema.extend({
  samples: z.array(streamSampleSchema),
  /** Display names of the viewers that appear in the samples, by user id. */
  viewerNames: z.record(z.string(), z.string()),
});
export type StreamReport = z.infer<typeof streamReportSchema>;

export const streamReportListSchema = z.object({ reports: z.array(streamReportSummarySchema) });
