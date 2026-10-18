import {
  STREAM_SAMPLE_SECONDS,
  type StreamPath,
  type StreamSample,
  type StreamSenderSample,
  type StreamServerSample,
  type StreamViewerSample,
} from '@frequencia/shared';
import type { types } from 'mediasoup';

/** Samples sent together; the last ones of a stream go when it ends. */
const SAMPLES_PER_REPORT = 12;
/** Half of the 32-bit RTP timestamp space: a timestamp further back than this is newer. */
const HALF_RTP_RANGE = 0x80000000;

export interface StreamReportChunk {
  producerId: string;
  path: StreamPath;
  codec: string | null;
  startedAt: Date;
  endedAt: Date | null;
  samples: StreamSample[];
}

/** Frames arriving on one RTP stream (one simulcast layer) during the current window. */
interface Layer {
  frames: number;
  bytes: number;
  keyFrames: number;
  /** RTP timestamp and arrival time (ms) of the newest frame. */
  lastTimestamp: number | null;
  lastAt: number | null;
  gaps: number[];
}

/** Reports of one machine during the current window, merged. */
export interface Gathered<T> {
  sums: Record<string, number>;
  counts: Record<string, number>;
  last: T;
}

/** Fields of the viewer sample that count events since the previous report. */
const VIEWER_COUNTERS = new Set(['framesDropped', 'freezes', 'freezeMs']);

export function gather<T extends Record<string, unknown>>(
  into: Gathered<T> | undefined,
  sample: T,
): Gathered<T> {
  const gathered = into ?? { sums: {}, counts: {}, last: sample };
  gathered.last = sample;
  for (const [key, value] of Object.entries(sample)) {
    if (typeof value !== 'number') continue;
    gathered.sums[key] = (gathered.sums[key] ?? 0) + value;
    gathered.counts[key] = (gathered.counts[key] ?? 0) + 1;
  }
  return gathered;
}

/**
 * Numbers kept as last reported, like labels: a picture that changed size within the window
 * has the new size, not one between the two (which is not a whole number of pixels). The
 * same for how many streams a machine receives.
 */
const LATEST = new Set(['width', 'height', 'watching']);

/** Counters added up, sizes and labels as last reported, other numbers averaged. */
export function merged<T extends Record<string, unknown>>(gathered: Gathered<T>): T {
  const result: Record<string, unknown> = { ...gathered.last };
  for (const [key, sum] of Object.entries(gathered.sums)) {
    if (LATEST.has(key)) continue;
    const count = gathered.counts[key] ?? 1;
    result[key] = VIEWER_COUNTERS.has(key) ? sum : Math.round((sum / count) * 10) / 10;
  }
  return result as T;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? null;
}

/**
 * Measures one screen share where it arrives and gathers what its streamer and viewers say
 * about it, in windows of `STREAM_SAMPLE_SECONDS`. Frames are counted from the RTP packets
 * themselves (a new timestamp is a new frame), so the numbers are the same whether the picture
 * comes from a browser or from the desktop app's own capture. Belongs to the producer: closing
 * it sends what is left.
 */
export class StreamTelemetry {
  private readonly startedAt = new Date();
  /** When the current window began; the last one of a stream is usually shorter. */
  private windowStart = Date.now();
  private readonly layers = new Map<number, Layer>();
  private sender: Gathered<StreamSenderSample> | undefined;
  private readonly viewers = new Map<string, Gathered<StreamViewerSample>>();
  private pending: StreamSample[] = [];
  /** Totals from the producer's last stats, to turn them into counts per window. */
  private lastTotals = { packetsLost: 0, nacks: 0, plis: 0 };
  private readonly timer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly producer: types.Producer,
    private readonly path: StreamPath,
    private readonly report: (chunk: StreamReportChunk) => void,
  ) {
    this.timer = setInterval(() => void this.sample(), STREAM_SAMPLE_SECONDS * 1000);
    this.timer.unref();
    producer.on('trace', (trace) => {
      if (trace.type === 'rtp' && trace.direction === 'in') this.onPacket(trace);
    });
    void producer.enableTraceEvent(['rtp']).catch(() => undefined);
  }

  private get codec(): string | null {
    return this.producer.rtpParameters.codecs[0]?.mimeType.split('/')[1] ?? null;
  }

  addSender(sample: StreamSenderSample): void {
    this.sender = gather(this.sender, sample);
  }

  addViewer(userId: string, sample: StreamViewerSample): void {
    this.viewers.set(userId, gather(this.viewers.get(userId), sample));
  }

  /** Takes the last window and sends everything not yet sent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    // The producer is gone: no more stats to read.
    this.pending.push(this.build(null));
    this.flush(new Date());
  }

  private onPacket(trace: types.ProducerTraceEventData): void {
    const info = trace.info as {
      isRtx?: boolean;
      rtpPacket?: { ssrc: number; timestamp: number; isKeyFrame: boolean; size: number | bigint };
    };
    const packet = info.rtpPacket;
    if (!packet || info.isRtx) return;
    let layer = this.layers.get(packet.ssrc);
    if (!layer) {
      layer = { frames: 0, bytes: 0, keyFrames: 0, lastTimestamp: null, lastAt: null, gaps: [] };
      this.layers.set(packet.ssrc, layer);
    }
    layer.bytes += Number(packet.size);
    if (layer.lastTimestamp === packet.timestamp) return;
    // A late packet of a frame already counted.
    if (
      layer.lastTimestamp !== null &&
      (packet.timestamp - layer.lastTimestamp + 0x100000000) % 0x100000000 > HALF_RTP_RANGE
    ) {
      return;
    }
    const at = trace.timestamp;
    if (layer.lastAt !== null) layer.gaps.push(at - layer.lastAt);
    layer.lastTimestamp = packet.timestamp;
    layer.lastAt = at;
    layer.frames += 1;
    if (packet.isKeyFrame) layer.keyFrames += 1;
  }

  private async sample(): Promise<void> {
    if (this.closed) return;
    const stats = await this.producer.getStats().catch(() => null);
    if (this.closed) return;
    this.pending.push(this.build(stats));
    if (this.pending.length >= SAMPLES_PER_REPORT) this.flush(null);
  }

  private build(stats: types.ProducerStat[] | null): StreamSample {
    // The highest layer is the one carrying the most bytes.
    let top: Layer | undefined;
    for (const layer of this.layers.values()) {
      if (!top || layer.bytes > top.bytes) top = layer;
    }
    const totalBytes = [...this.layers.values()].reduce((sum, layer) => sum + layer.bytes, 0);
    const gaps = [...(top?.gaps ?? [])].sort((a, b) => a - b);
    const now = Date.now();
    const seconds = Math.max(0.001, (now - this.windowStart) / 1000);
    this.windowStart = now;

    const totals = { packetsLost: 0, nacks: 0, plis: 0 };
    for (const stat of stats ?? []) {
      totals.packetsLost += Math.max(0, stat.packetsLost);
      totals.nacks += stat.nackCount;
      totals.plis += stat.pliCount;
    }
    const delta = (key: keyof typeof totals) =>
      stats ? Math.max(0, totals[key] - this.lastTotals[key]) : 0;
    const server: StreamServerSample = {
      fps: Math.round(((top?.frames ?? 0) / seconds) * 10) / 10,
      gapP50Ms: percentile(gaps, 0.5),
      gapP95Ms: percentile(gaps, 0.95),
      gapMaxMs: gaps.at(-1) ?? null,
      kbps: Math.round((totalBytes * 8) / seconds / 1000),
      keyFrames: top?.keyFrames ?? 0,
      packetsLost: delta('packetsLost'),
      nacks: delta('nacks'),
      plis: delta('plis'),
    };
    if (stats) this.lastTotals = totals;

    const sample: StreamSample = {
      t: Math.round((now - this.startedAt.getTime()) / 100) / 10,
      server,
      sender: this.sender ? merged(this.sender) : null,
      viewers: [...this.viewers].map(([userId, gathered]) => ({ ...merged(gathered), userId })),
    };
    for (const layer of this.layers.values()) {
      Object.assign(layer, { frames: 0, bytes: 0, keyFrames: 0, gaps: [] });
    }
    this.sender = undefined;
    this.viewers.clear();
    return sample;
  }

  private flush(endedAt: Date | null): void {
    const samples = this.pending;
    this.pending = [];
    this.report({
      producerId: this.producer.id,
      path: this.path,
      codec: this.codec,
      startedAt: this.startedAt,
      endedAt,
      samples,
    });
  }
}
