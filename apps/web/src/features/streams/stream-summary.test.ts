import type { StreamReport, StreamSample } from '@frequencia/shared';
import { describe, expect, it } from 'vitest';
import { low, median, presetFrameRate, summarize } from './stream-summary';

const server = (fps: number, gapP95Ms = 20): StreamSample['server'] => ({
  fps,
  gapP50Ms: 16,
  gapP95Ms,
  gapMaxMs: 40,
  kbps: 7000,
  keyFrames: 0,
  packetsLost: 0,
  nacks: 0,
  plis: 0,
});

const sender = (captureFps: number, sentFps: number): NonNullable<StreamSample['sender']> => ({
  captureFps,
  sentFps,
  encodeMs: 9,
  width: 1920,
  height: 1080,
  kbps: 7000,
  limitation: 'cpu',
  encoder: 'MediaFoundationVideoEncodeAccelerator',
  preset: '1080p60',
  audio: 'program',
});

const viewer = (fps: number, freezes = 0): StreamSample['viewers'][number] => ({
  userId: 'u-bia',
  fps,
  framesDropped: 0,
  freezes,
  freezeMs: freezes * 200,
  decodeMs: 4,
  jitterBufferMs: 30,
  lossPercent: 0,
  width: 1920,
  height: 1080,
  kbps: 7000,
  decoder: 'D3D11VideoDecoder',
});

function report(samples: StreamSample[], path: 'browser' | 'native' = 'browser'): StreamReport {
  return {
    id: 'r',
    channelId: 'c',
    channelName: 'GERAL',
    guildName: 'Servidor',
    userId: 'u-ana',
    userName: 'Ana',
    path,
    codec: 'H264',
    startedAt: '2026-10-14T12:00:00.000Z',
    endedAt: null,
    sampleCount: samples.length,
    samples,
    viewerNames: { 'u-bia': 'Bia' },
  };
}

describe('median and low', () => {
  it('ignore missing values', () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([null])).toBeNull();
    expect(
      low([60, 59, 58, 20, 61, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60]),
    ).toBe(20);
  });

  it('reads the frame rate of a preset', () => {
    expect(presetFrameRate('1080p60')).toBe(60);
    expect(presetFrameRate(null)).toBeNull();
  });
});

describe('summarize', () => {
  it('leaves out the last, cut-short window of a stream that ended', () => {
    const samples = [5, 10, 15, 17].map((t) => ({
      t,
      server: server(t === 17 ? 10 : 60),
      sender: sender(60, 60),
      viewers: [viewer(t === 17 ? 5 : 60)],
    }));
    const summary = summarize({ ...report(samples), endedAt: '2026-10-14T12:00:17.000Z' });
    expect(summary.server.fps).toBe(60);
    expect(summary.findings).toEqual([]);
  });

  it('finds nothing wrong in a stream that keeps its rate everywhere', () => {
    const samples = [5, 10, 15].map((t) => ({
      t,
      server: server(59.6),
      sender: sender(60, 60),
      viewers: [viewer(59)],
    }));
    const summary = summarize(report(samples));
    expect(summary.target).toBe(60);
    expect(summary.findings).toEqual([]);
    expect(summary.viewers).toMatchObject([{ name: 'Bia', fps: 59 }]);
  });

  it('blames the capture when it is the first stage that falls short', () => {
    const samples = [5, 10].map((t) => ({
      t,
      server: server(30),
      sender: sender(31, 30),
      viewers: [viewer(30)],
    }));
    const [first, ...rest] = summarize(report(samples)).findings;
    expect(first).toMatch(/^A captura entrega 31 de 60/);
    // Each later stage keeps up with the one before it.
    expect(rest).toEqual([]);
  });

  it('says where frames go missing further down, and who saw the picture stop', () => {
    const samples = [5, 10].map((t) => ({
      t,
      server: server(40, 120),
      sender: sender(60, 59),
      viewers: [viewer(25, 1)],
    }));
    const findings = summarize(report(samples)).findings;
    expect(findings).toEqual([
      expect.stringMatching(/^Chegam ao servidor 40 dos 59 quadros enviados/),
      expect.stringMatching(/^Os quadros chegam irregulares/),
      expect.stringMatching(/^Bia vê 25 dos 40 quadros/),
      'Bia viu a imagem parar 2 vezes, 0.4 s no total.',
    ]);
  });

  it('compares a native capture with the rate it aimed at', () => {
    const samples = [5, 10].map((t) => ({
      t,
      server: server(20),
      sender: {
        ...sender(0, 0),
        captureFps: null,
        sentFps: null,
        encodeMs: null,
        limitation: null,
      },
      viewers: [],
    }));
    expect(summarize(report(samples, 'native')).findings).toEqual([
      expect.stringMatching(/^Chegam ao servidor 20 de 60 quadros por segundo: a captura do app/),
    ]);
  });
});
