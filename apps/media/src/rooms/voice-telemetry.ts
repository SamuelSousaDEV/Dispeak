import {
  VOICE_SAMPLE_SECONDS,
  type VoiceListenerSample,
  type VoiceSample,
  type VoiceServerSample,
  type VoiceSpeakerSample,
} from '@frequencia/shared';
import type { types } from 'mediasoup';
import { gather, merged, type Gathered } from './stream-telemetry';

/** Samples sent together; the last ones of a voice go when it ends. */
const SAMPLES_PER_REPORT = 6;

export interface VoiceReportChunk {
  producerId: string;
  startedAt: Date;
  endedAt: Date | null;
  samples: VoiceSample[];
}

/**
 * Measures one microphone where it arrives and gathers what its speaker and listeners say
 * about it, in windows of `VOICE_SAMPLE_SECONDS`. Belongs to the producer: closing it sends
 * what is left.
 */
export class VoiceTelemetry {
  private readonly startedAt = new Date();
  private speaker: Gathered<VoiceSpeakerSample> | undefined;
  private readonly listeners = new Map<string, Gathered<VoiceListenerSample>>();
  private pending: VoiceSample[] = [];
  /** Totals from the producer's last stats, to turn them into counts per window. */
  private lastTotals = { packets: 0, packetsLost: 0, bytes: 0 };
  private lastAt = Date.now();
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private reported = false;

  constructor(
    private readonly producer: types.Producer,
    private readonly report: (chunk: VoiceReportChunk) => void,
  ) {
    this.timer = setInterval(() => void this.sample(), VOICE_SAMPLE_SECONDS * 1000);
    this.timer.unref();
  }

  addSpeaker(sample: VoiceSpeakerSample): void {
    this.speaker = gather(this.speaker, sample);
  }

  addListener(userId: string, sample: VoiceListenerSample): void {
    this.listeners.set(userId, gather(this.listeners.get(userId), sample));
  }

  /** Takes the last window and sends everything not yet sent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    // The producer is gone: no more stats to read. A window with nobody's word is left out.
    const last = this.build(null);
    if (last.speaker || last.listeners.length > 0) this.pending.push(last);
    this.flush(new Date());
  }

  private async sample(): Promise<void> {
    if (this.closed) return;
    const stats = await this.producer.getStats().catch(() => null);
    if (this.closed) return;
    this.pending.push(this.build(stats));
    if (this.pending.length >= SAMPLES_PER_REPORT) this.flush(null);
  }

  private build(stats: types.ProducerStat[] | null): VoiceSample {
    const now = Date.now();
    const seconds = Math.max(0.001, (now - this.lastAt) / 1000);
    this.lastAt = now;
    const totals = { packets: 0, packetsLost: 0, bytes: 0 };
    for (const stat of stats ?? []) {
      totals.packets += stat.packetCount;
      totals.packetsLost += Math.max(0, stat.packetsLost);
      totals.bytes += stat.byteCount;
    }
    const delta = (key: keyof typeof totals) =>
      stats ? Math.max(0, totals[key] - this.lastTotals[key]) : 0;
    const server: VoiceServerSample = {
      kbps: Math.round((delta('bytes') * 8) / seconds / 1000),
      packets: delta('packets'),
      packetsLost: delta('packetsLost'),
    };
    if (stats) this.lastTotals = totals;

    const sample: VoiceSample = {
      t: Math.round((now - this.startedAt.getTime()) / 100) / 10,
      server,
      speaker: this.speaker ? merged(this.speaker) : null,
      listeners: [...this.listeners].map(([userId, gathered]) => ({
        ...merged(gathered),
        userId,
      })),
    };
    this.speaker = undefined;
    this.listeners.clear();
    return sample;
  }

  private flush(endedAt: Date | null): void {
    const samples = this.pending;
    this.pending = [];
    // A stay too short for one sample leaves no report.
    if (samples.length === 0 && !this.reported) return;
    this.reported = true;
    this.report({ producerId: this.producer.id, startedAt: this.startedAt, endedAt, samples });
  }
}
