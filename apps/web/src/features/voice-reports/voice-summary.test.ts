import type { VoiceListenerSample, VoiceReport, VoiceSample } from '@frequencia/shared';
import { describe, expect, it } from 'vitest';
import { summarizeVoice } from './voice-summary';

const heard = (userId: string, values: Partial<VoiceListenerSample>) => ({
  userId,
  lossPercent: 0,
  concealedPercent: 0,
  jitterMs: 3,
  jitterBufferMs: 40,
  rttMs: 30,
  ...values,
});

const sample = (
  t: number,
  server: VoiceSample['server'],
  listeners: VoiceSample['listeners'],
): VoiceSample => ({
  t,
  server,
  speaker: { noiseSuppression: 'gtcrn', echoCancellation: true, autoGainControl: true, rttMs: 20 },
  listeners,
});

const report = (samples: VoiceSample[]): VoiceReport => ({
  id: 'voice',
  channelId: 'channel',
  channelName: 'Geral',
  guildName: 'Bar',
  userId: 'george',
  userName: 'George',
  startedAt: '2026-10-18T20:00:00.000Z',
  endedAt: '2026-10-18T20:01:00.000Z',
  sampleCount: samples.length,
  samples,
  listenerNames: { sam: 'Sam', gilvan: 'Gilvan' },
});

describe('summarizeVoice', () => {
  it('says nothing went wrong when the voice arrived whole', () => {
    const summary = summarizeVoice(
      report([sample(10, { kbps: 128, packets: 500, packetsLost: 0 }, [heard('sam', {})])]),
    );
    expect(summary.findings).toEqual([]);
    expect(summary.server).toEqual({ kbps: 128, lossPercent: 0, worstLossPercent: 0 });
  });

  it("blames the speaker's way up when the server already missed the packets", () => {
    const summary = summarizeVoice(
      report([
        sample(10, { kbps: 120, packets: 480, packetsLost: 20 }, [
          heard('sam', { lossPercent: 4, concealedPercent: 3.5 }),
          heard('gilvan', { lossPercent: 4, concealedPercent: 3 }),
        ]),
        // Muted: nothing went out, and the window does not count.
        sample(20, { kbps: 0, packets: 0, packetsLost: 0 }, []),
      ]),
    );
    expect(summary.server.lossPercent).toBe(4);
    expect(summary.findings).toEqual([
      'A internet de George perdeu 4% da voz no caminho até o servidor: todos ouviram as falhas.',
      'Para Sam, 3.5% da voz foi preenchida pelo navegador (soa robótica ou picotada).',
      'Para Gilvan, 3% da voz foi preenchida pelo navegador (soa robótica ou picotada).',
    ]);
  });

  it("blames one listener's way down when only that listener lost the voice", () => {
    const summary = summarizeVoice(
      report([
        sample(10, { kbps: 128, packets: 500, packetsLost: 0 }, [
          heard('sam', {}),
          heard('gilvan', { lossPercent: 6, concealedPercent: 5 }),
        ]),
        sample(20, { kbps: 128, packets: 500, packetsLost: 0 }, [
          heard('sam', { concealedPercent: 6 }),
          heard('gilvan', { lossPercent: 2, concealedPercent: 1 }),
        ]),
        // One bad moment for Sam among good ones: worth saying, not an average problem.
        ...[30, 40, 50, 60, 70].map((t) =>
          sample(t, { kbps: 128, packets: 500, packetsLost: 0 }, [
            heard('sam', {}),
            heard('gilvan', { lossPercent: 4, concealedPercent: 3 }),
          ]),
        ),
      ]),
    );
    expect(summary.findings).toEqual([
      'Para Gilvan, 3% da voz foi preenchida pelo navegador (soa robótica ou picotada). A perda foi no caminho até Gilvan: só Gilvan ouviu assim.',
      'Para Sam, num momento 6% da voz foi preenchida pelo navegador.',
    ]);
    expect(summary.listeners.find((listener) => listener.userId === 'gilvan')).toMatchObject({
      lossPercent: 4,
      worstConcealedPercent: 5,
    });
  });
});
