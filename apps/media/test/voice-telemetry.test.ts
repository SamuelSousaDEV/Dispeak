import type { VoiceListenerSample, VoiceSpeakerSample } from '@frequencia/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceReportChunk } from '../src/rooms/voice-telemetry';
import {
  createHarness,
  eventually,
  openTransport,
  opusRtpParameters,
  type Harness,
} from './helpers/harness';

describe('voice telemetry, as reported through the media service', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  const speakerSample: VoiceSpeakerSample = {
    noiseSuppression: 'gtcrn',
    echoCancellation: true,
    autoGainControl: true,
    rttMs: 30,
  };
  const listenerSample: VoiceListenerSample = {
    lossPercent: 1,
    concealedPercent: 2,
    jitterMs: 4,
    jitterBufferMs: 40,
    rttMs: 50,
  };

  it('keeps what the speaker and its listeners say, and nothing from anyone else', async () => {
    const chunks: VoiceReportChunk[] = [];
    const users: string[] = [];
    h.server.rooms.hooks.onVoiceReport = (_room, peer, chunk) => {
      users.push(peer.userId);
      chunks.push(chunk);
    };
    const alice = await h.joinAs({ sub: 'alice' });
    const bruno = await h.joinAs({ sub: 'bruno' });
    const carla = await h.joinAs({ sub: 'carla' });

    const { producerId } = await alice.rpc.request('produce', {
      transportId: await openTransport(alice, 'send'),
      kind: 'audio',
      source: 'mic',
      rtpParameters: opusRtpParameters(),
    });
    await openTransport(bruno, 'recv');
    await bruno.rpc.request('consume', { producerId });

    alice.rpc.notify('voice-stats', { role: 'speaker', producerId, sample: speakerSample });
    // Two reports of one listener in a window are averaged.
    bruno.rpc.notify('voice-stats', { role: 'listener', producerId, sample: listenerSample });
    bruno.rpc.notify('voice-stats', {
      role: 'listener',
      producerId,
      sample: { ...listenerSample, concealedPercent: 6, rttMs: null },
    });
    // Not hearing it, and not the owner: ignored.
    carla.rpc.notify('voice-stats', { role: 'listener', producerId, sample: listenerSample });
    bruno.rpc.notify('voice-stats', { role: 'speaker', producerId, sample: speakerSample });
    // Let the notifications reach the server before the voice ends.
    for (const peer of [alice, bruno, carla]) await peer.rpc.request('getRouterCapabilities', {});

    await alice.rpc.request('closeProducer', { producerId });
    await eventually(() => expect(chunks).toHaveLength(1));

    expect(users).toEqual(['alice']);
    expect(chunks[0]).toMatchObject({ producerId });
    expect(chunks[0]?.endedAt).toBeInstanceOf(Date);
    const [sample] = chunks[0]?.samples ?? [];
    expect(sample?.speaker).toEqual(speakerSample);
    expect(sample?.listeners).toEqual([
      { ...listenerSample, userId: 'bruno', concealedPercent: 4 },
    ]);
    expect(sample?.server).toEqual({ kbps: 0, packets: 0, packetsLost: 0 });
  });

  it('leaves no report of a voice nobody measured before it left', async () => {
    const chunks: VoiceReportChunk[] = [];
    h.server.rooms.hooks.onVoiceReport = (_room, _peer, chunk) => chunks.push(chunk);
    const alice = await h.joinAs({ sub: 'alice' });
    const { producerId } = await alice.rpc.request('produce', {
      transportId: await openTransport(alice, 'send'),
      kind: 'audio',
      source: 'mic',
      rtpParameters: opusRtpParameters(),
    });
    await alice.rpc.request('closeProducer', { producerId });
    await alice.rpc.request('getRouterCapabilities', {});
    expect(chunks).toEqual([]);
  });
});
