import type { StreamViewerSample, VoiceListenerSample } from '@frequencia/shared';
import type { StreamLayerStats, StreamStats, VoiceConnectionStats } from './voice-store';

export interface StatsSample {
  at: number;
  bytesSent: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
}

type StatsEntry = Record<string, unknown> & { type: string; id: string };

const number = (value: unknown): number => (typeof value === 'number' ? value : 0);
const optional = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function entries(report: RTCStatsReport): StatsEntry[] {
  const list: StatsEntry[] = [];
  report.forEach((entry) => list.push(entry as StatsEntry));
  return list;
}

/** Short codec name ("opus", "VP8") for an RTP stream entry. */
export function codecOf(report: RTCStatsReport, entry: StatsEntry | undefined): string | null {
  const codecId = entry?.codecId;
  if (typeof codecId !== 'string') return null;
  const codec = report.get(codecId) as { mimeType?: string } | undefined;
  return codec?.mimeType?.split('/')[1] ?? null;
}

export function kbps(bytes: number, previousBytes: number, seconds: number): number {
  if (seconds <= 0) return 0;
  return Math.max(0, Math.round(((bytes - previousBytes) * 8) / seconds / 1000));
}

/**
 * Reduces the send and receive transport reports to the handful of numbers shown in the
 * system bar. Rates are computed against the previous sample.
 */
export function collectConnectionStats(
  sent: RTCStatsReport,
  received: RTCStatsReport,
  previous: StatsSample | null,
  now = performance.now(),
): { stats: VoiceConnectionStats; sample: StatsSample } {
  const sendEntries = entries(sent);
  const receiveEntries = entries(received);

  let rttMs: number | null = null;
  for (const entry of [...sendEntries, ...receiveEntries]) {
    if (
      entry.type === 'candidate-pair' &&
      entry.nominated === true &&
      typeof entry.currentRoundTripTime === 'number'
    ) {
      const value = Math.round(entry.currentRoundTripTime * 1000);
      rttMs = rttMs === null ? value : Math.min(rttMs, value);
    }
  }

  const sum = (list: StatsEntry[], type: string, field: string) =>
    list
      .filter((entry) => entry.type === type)
      .reduce((total, entry) => total + number(entry[field]), 0);

  const sample: StatsSample = {
    at: now,
    bytesSent: sum(sendEntries, 'outbound-rtp', 'bytesSent'),
    bytesReceived: sum(receiveEntries, 'inbound-rtp', 'bytesReceived'),
    packetsReceived: sum(receiveEntries, 'inbound-rtp', 'packetsReceived'),
    packetsLost: sum(receiveEntries, 'inbound-rtp', 'packetsLost'),
  };

  const audioOut = sendEntries.find(
    (entry) => entry.type === 'outbound-rtp' && entry.kind === 'audio',
  );
  const audioIn = receiveEntries.find(
    (entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio',
  );
  const audioCodec = codecOf(sent, audioOut) ?? codecOf(received, audioIn);

  if (!previous) {
    return {
      sample,
      stats: { rttMs, sendKbps: null, receiveKbps: null, lossPercent: null, audioCodec },
    };
  }

  const seconds = (now - previous.at) / 1000;
  const lost = Math.max(0, sample.packetsLost - previous.packetsLost);
  const arrived = Math.max(0, sample.packetsReceived - previous.packetsReceived);
  const expected = lost + arrived;

  return {
    sample,
    stats: {
      rttMs,
      sendKbps: kbps(sample.bytesSent, previous.bytesSent, seconds),
      receiveKbps: kbps(sample.bytesReceived, previous.bytesReceived, seconds),
      lossPercent: expected > 0 ? Math.round((lost / expected) * 1000) / 10 : 0,
      audioCodec,
    },
  };
}

/** Counters remembered between two polls of one stream. */
export interface StreamSample {
  at: number;
  /** Bytes per RTP stream, keyed by rid (or `default` for a single stream). */
  bytes: Record<string, number>;
  packetsReceived: number;
  packetsLost: number;
  /** Outgoing streams only: seconds spent encoding and frames encoded, all layers added up. */
  encodeSeconds?: number;
  framesEncoded?: number;
  /** Incoming streams only: counters behind the viewer's telemetry. */
  viewer?: {
    framesDropped: number;
    freezes: number;
    freezeSeconds: number;
    decodeSeconds: number;
    framesDecoded: number;
    jitterBufferSeconds: number;
    jitterBufferEmitted: number;
  };
}

/**
 * Stats of a stream being watched, from its video consumer, and the same numbers as the
 * telemetry the media service keeps (`viewer`).
 */
export function collectInboundStreamStats(
  report: RTCStatsReport,
  previous: StreamSample | null,
  now = performance.now(),
): { stats: StreamStats; sample: StreamSample; viewer: StreamViewerSample } {
  const inbound = entries(report).find(
    (entry) => entry.type === 'inbound-rtp' && entry.kind === 'video',
  );
  const sample: StreamSample = {
    at: now,
    bytes: { default: number(inbound?.bytesReceived) },
    packetsReceived: number(inbound?.packetsReceived),
    packetsLost: number(inbound?.packetsLost),
    viewer: {
      framesDropped: number(inbound?.framesDropped),
      freezes: number(inbound?.freezeCount),
      freezeSeconds: number(inbound?.totalFreezesDuration),
      decodeSeconds: number(inbound?.totalDecodeTime),
      framesDecoded: number(inbound?.framesDecoded),
      jitterBufferSeconds: number(inbound?.jitterBufferDelay),
      jitterBufferEmitted: number(inbound?.jitterBufferEmittedCount),
    },
  };
  const seconds = previous ? (now - previous.at) / 1000 : 0;
  const lost = previous ? Math.max(0, sample.packetsLost - previous.packetsLost) : 0;
  const arrived = previous ? Math.max(0, sample.packetsReceived - previous.packetsReceived) : 0;

  const stats: StreamStats = {
    width: optional(inbound?.frameWidth),
    height: optional(inbound?.frameHeight),
    fps:
      inbound?.framesPerSecond === undefined ? null : Math.round(number(inbound.framesPerSecond)),
    kbps: previous ? kbps(sample.bytes.default ?? 0, previous.bytes.default ?? 0, seconds) : null,
    lossPercent:
      previous && lost + arrived > 0 ? Math.round((lost / (lost + arrived)) * 1000) / 10 : 0,
    codec: codecOf(report, inbound),
  };

  const current = sample.viewer;
  const before = previous?.viewer;
  // Counters since the previous sample; a counter that went back means a new consumer.
  const since = (key: keyof NonNullable<StreamSample['viewer']>) =>
    current && before ? Math.max(0, current[key] - before[key]) : 0;
  const per = (total: number, count: number) =>
    count > 0 ? Math.round((total / count) * 10_000) / 10 : null;
  const decoder = inbound?.decoderImplementation;
  const viewer: StreamViewerSample = {
    fps: stats.fps,
    framesDropped: since('framesDropped'),
    freezes: since('freezes'),
    freezeMs: Math.round(since('freezeSeconds') * 1000),
    decodeMs: per(since('decodeSeconds'), since('framesDecoded')),
    jitterBufferMs: per(since('jitterBufferSeconds'), since('jitterBufferEmitted')),
    lossPercent: stats.lossPercent,
    width: stats.width,
    height: stats.height,
    kbps: stats.kbps,
    decoder: typeof decoder === 'string' ? decoder.slice(0, 64) : null,
  };
  return { sample, stats, viewer };
}

/** Stats of the local screen share, from its producer: one row per simulcast layer. */
export function collectOutboundStreamStats(
  report: RTCStatsReport,
  previous: StreamSample | null,
  now = performance.now(),
): { stats: StreamStats; sample: StreamSample } {
  const outbound = entries(report)
    .filter((entry) => entry.type === 'outbound-rtp' && entry.kind === 'video')
    .sort((a, b) => String(a.rid ?? '').localeCompare(String(b.rid ?? '')));
  const seconds = previous ? (now - previous.at) / 1000 : 0;

  const sample: StreamSample = {
    at: now,
    bytes: {},
    packetsReceived: 0,
    packetsLost: 0,
    encodeSeconds: outbound.reduce((sum, entry) => sum + number(entry.totalEncodeTime), 0),
    // Every layer encodes the same frames; the busiest one counts them.
    framesEncoded: Math.max(0, ...outbound.map((entry) => number(entry.framesEncoded))),
  };
  const layers: StreamLayerStats[] = outbound.map((entry, index) => {
    const rid = typeof entry.rid === 'string' ? entry.rid : `r${index}`;
    const bytes = number(entry.bytesSent);
    sample.bytes[rid] = bytes;
    const before = previous?.bytes[rid];
    return {
      rid,
      width: optional(entry.frameWidth),
      height: optional(entry.frameHeight),
      fps: entry.framesPerSecond === undefined ? null : Math.round(number(entry.framesPerSecond)),
      kbps: before === undefined ? null : kbps(bytes, before, seconds),
    };
  });

  // The headline numbers describe the best layer currently being encoded.
  const top = [...layers].reverse().find((layer) => (layer.fps ?? 0) > 0) ?? layers.at(-1);
  const total = layers.some((layer) => layer.kbps !== null)
    ? layers.reduce((sum, layer) => sum + (layer.kbps ?? 0), 0)
    : null;
  const limitation = outbound
    .map((entry) => entry.qualityLimitationReason)
    .find((reason) => typeof reason === 'string' && reason !== 'none');
  const frames = (sample.framesEncoded ?? 0) - (previous?.framesEncoded ?? 0);
  const encodeMs =
    previous && frames > 0
      ? Math.round((((sample.encodeSeconds ?? 0) - (previous.encodeSeconds ?? 0)) / frames) * 1000)
      : null;
  const implementation = outbound.at(-1)?.encoderImplementation;
  const source = entries(report).find(
    (entry) => entry.type === 'media-source' && entry.kind === 'video',
  );

  return {
    sample,
    stats: {
      width: top?.width ?? null,
      height: top?.height ?? null,
      fps: top?.fps ?? null,
      kbps: total,
      lossPercent: null,
      codec: codecOf(report, outbound[0]),
      layers,
      limitation: typeof limitation === 'string' ? limitation : null,
      encodeMs,
      encoder: typeof implementation === 'string' ? implementation : null,
      captureFps:
        typeof source?.framesPerSecond === 'number' ? Math.round(source.framesPerSecond) : null,
    },
  };
}

/** Counters of one voice being heard, remembered between two polls. */
export interface VoiceCounters {
  packetsReceived: number;
  packetsLost: number;
  /** Samples played, those made up to cover missing packets, and those of them silent. */
  played: number;
  concealed: number;
  silentConcealed: number;
  jitterBufferSeconds: number;
  jitterBufferEmitted: number;
}

/**
 * What a listener measures of one voice, from its audio consumer, since the previous poll.
 * `listener` is `null` on the first poll and while no packet arrives (the speaker is muted):
 * a silence is not a voice going wrong.
 */
export function collectInboundVoiceStats(
  report: RTCStatsReport,
  previous: VoiceCounters | null,
  rttMs: number | null,
): { counters: VoiceCounters; listener: VoiceListenerSample | null } {
  const inbound = entries(report).find(
    (entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio',
  );
  const counters: VoiceCounters = {
    packetsReceived: number(inbound?.packetsReceived),
    packetsLost: number(inbound?.packetsLost),
    played: number(inbound?.totalSamplesReceived),
    concealed: number(inbound?.concealedSamples),
    silentConcealed: number(inbound?.silentConcealedSamples),
    jitterBufferSeconds: number(inbound?.jitterBufferDelay),
    jitterBufferEmitted: number(inbound?.jitterBufferEmittedCount),
  };
  // A counter that went back means a new consumer: start over.
  const since = (key: keyof VoiceCounters) =>
    previous ? Math.max(0, counters[key] - previous[key]) : 0;
  const arrived = since('packetsReceived');
  if (!previous || arrived === 0) return { counters, listener: null };
  const lost = since('packetsLost');
  const played = since('played');
  const audible = Math.max(0, since('concealed') - since('silentConcealed'));
  const tenth = (value: number) => Math.round(value * 10) / 10;
  const emitted = since('jitterBufferEmitted');
  const jitter = optional(inbound?.jitter);
  return {
    counters,
    listener: {
      lossPercent: tenth((lost / (lost + arrived)) * 100),
      concealedPercent: played > 0 ? Math.min(100, tenth((audible / played) * 100)) : null,
      jitterMs: jitter === null ? null : tenth(jitter * 1000),
      jitterBufferMs: emitted > 0 ? tenth((since('jitterBufferSeconds') / emitted) * 1000) : null,
      rttMs,
    },
  };
}
