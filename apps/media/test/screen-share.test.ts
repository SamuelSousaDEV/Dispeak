import { RpcErrorCode, VoiceErrorCode } from '@frequencia/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  openTransport,
  opusRtpParameters,
  simulcastRtpParameters,
  type Harness,
  type TestPeer,
} from './helpers/harness';

type Joined = Awaited<ReturnType<Harness['joinAs']>>;

describe('screen sharing', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  const peerStats = (peer: Joined) => {
    const stats = h.server.rooms.stats().rooms[0]?.peers.find((entry) => entry.id === peer.selfId);
    if (!stats) throw new Error('peer not found in stats');
    return stats;
  };

  async function share(peer: TestPeer, options: { audio?: boolean } = {}) {
    const transportId = await openTransport(peer, 'send');
    const video = await peer.rpc.request('produce', {
      transportId,
      kind: 'video',
      source: 'screen',
      rtpParameters: simulcastRtpParameters(),
    });
    const audio = options.audio
      ? await peer.rpc.request('produce', {
          transportId,
          kind: 'audio',
          source: 'screen-audio',
          rtpParameters: opusRtpParameters(),
        })
      : undefined;
    return { transportId, video: video.producerId, audio: audio?.producerId };
  }

  it('publishes a screen as VP8 simulcast with three layers', async () => {
    const alice = await h.joinAs();
    const bob = await h.joinAs();
    const { video } = await share(alice);

    expect(peerStats(alice).producers).toEqual([
      { id: video, kind: 'video', source: 'screen', paused: false, type: 'simulcast', layers: 3 },
    ]);
    await expect(bob.next('producer-added')).resolves.toEqual({
      peerId: alice.selfId,
      producer: { id: video, kind: 'video', source: 'screen' },
    });
  });

  it('delivers video only to the viewers who asked for that stream', async () => {
    const alice = await h.joinAs({ name: 'Alice' });
    const bruno = await h.joinAs({ name: 'Bruno' });
    const carla = await h.joinAs({ name: 'Carla' });
    const aliceShare = await share(alice, { audio: true });
    const brunoShare = await share(bruno);

    // Nobody watches yet: two live streams, zero consumers anywhere.
    expect(h.server.rooms.stats().totals).toMatchObject({ producers: 3, consumers: 0 });

    // Carla watches Alice only.
    await openTransport(carla, 'recv');
    const video = await carla.rpc.request('consume', { producerId: aliceShare.video });
    const audio = await carla.rpc.request('consume', { producerId: aliceShare.audio as string });
    await carla.rpc.request('resumeConsumer', { consumerId: video.consumerId });
    await carla.rpc.request('resumeConsumer', { consumerId: audio.consumerId });

    expect(peerStats(carla).consumers.map((c) => [c.producerId, c.source, c.paused])).toEqual([
      [aliceShare.video, 'screen', false],
      [aliceShare.audio, 'screen-audio', false],
    ]);
    // The stream nobody asked for is not forwarded, and the streamers receive nothing.
    const everyConsumer = h.server.rooms.stats().rooms[0]?.peers.flatMap((p) => p.consumers) ?? [];
    expect(everyConsumer.some((consumer) => consumer.producerId === brunoShare.video)).toBe(false);
    expect(peerStats(alice).consumers).toEqual([]);
    expect(peerStats(bruno).consumers).toEqual([]);

    // Stop watching: the consumers are closed on the server.
    await carla.rpc.request('closeConsumer', { consumerId: video.consumerId });
    await carla.rpc.request('closeConsumer', { consumerId: audio.consumerId });
    expect(h.server.rooms.stats().totals.consumers).toBe(0);
  });

  it('keeps the sound of a stream flowing to a deafened viewer, and holds only voices', async () => {
    const alice = await h.joinAs({ name: 'Alice' });
    const carla = await h.joinAs({ name: 'Carla' });
    const aliceShare = await share(alice, { audio: true });
    const voice = await alice.rpc.request('produce', {
      transportId: aliceShare.transportId,
      kind: 'audio',
      source: 'mic',
      rtpParameters: opusRtpParameters(),
    });

    await openTransport(carla, 'recv');
    for (const producerId of [voice.producerId, aliceShare.audio as string]) {
      const { consumerId } = await carla.rpc.request('consume', { producerId });
      await carla.rpc.request('resumeConsumer', { consumerId });
    }
    const paused = () =>
      Object.fromEntries(peerStats(carla).consumers.map((c) => [c.source, c.paused]));

    await carla.rpc.request('setState', { muted: false, deafened: true });
    expect(paused()).toEqual({ mic: true, 'screen-audio': false });

    await carla.rpc.request('setState', { muted: false, deafened: false });
    expect(paused()).toEqual({ mic: false, 'screen-audio': false });
  });

  it('starts the sound of a stream watched while deafened', async () => {
    const alice = await h.joinAs();
    const carla = await h.joinAs({}, { deafened: true });
    const aliceShare = await share(alice, { audio: true });

    await openTransport(carla, 'recv');
    const { consumerId } = await carla.rpc.request('consume', {
      producerId: aliceShare.audio as string,
    });
    await carla.rpc.request('resumeConsumer', { consumerId });
    expect(peerStats(carla).consumers[0]?.paused).toBe(false);
  });

  it('lets each viewer choose its own simulcast layer', async () => {
    const alice = await h.joinAs();
    const small = await h.joinAs();
    const large = await h.joinAs();
    const { video } = await share(alice);

    const watch = async (viewer: Joined, spatialLayer: number) => {
      await openTransport(viewer, 'recv');
      const { consumerId } = await viewer.rpc.request('consume', { producerId: video });
      await viewer.rpc.request('setConsumerLayers', { consumerId, spatialLayer });
      await viewer.rpc.request('resumeConsumer', { consumerId });
      return consumerId;
    };
    const smallConsumer = await watch(small, 0);
    await watch(large, 2);

    expect(peerStats(small).consumers[0]?.preferredSpatialLayer).toBe(0);
    expect(peerStats(large).consumers[0]?.preferredSpatialLayer).toBe(2);

    await expect(
      small.rpc.request('setConsumerLayers', { consumerId: smallConsumer, spatialLayer: 3 }),
    ).rejects.toMatchObject({ code: RpcErrorCode.InvalidPayload });
    await expect(
      small.rpc.request('setConsumerLayers', { consumerId: 'nope', spatialLayer: 1 }),
    ).rejects.toMatchObject({ code: VoiceErrorCode.NotFound });
  });

  it('requires the stream permission', async () => {
    const viewer = await h.joinAs({ stream: false });
    const transportId = await openTransport(viewer, 'send');
    await expect(
      viewer.rpc.request('produce', {
        transportId,
        kind: 'video',
        source: 'screen',
        rtpParameters: simulcastRtpParameters(),
      }),
    ).rejects.toMatchObject({ code: VoiceErrorCode.Forbidden });
    // The microphone is governed by a different permission.
    await expect(
      viewer.rpc.request('produce', {
        transportId,
        kind: 'audio',
        source: 'mic',
        rtpParameters: opusRtpParameters(),
      }),
    ).resolves.toBeDefined();
  });

  it('publishes a camera next to a screen share, under the same permission', async () => {
    const alice = await h.joinAs();
    const bob = await h.joinAs();
    const { transportId, video } = await share(alice);
    await bob.next('producer-added');

    const camera = await alice.rpc.request('produce', {
      transportId,
      kind: 'video',
      source: 'camera',
      rtpParameters: simulcastRtpParameters(),
    });
    await expect(bob.next('producer-added')).resolves.toEqual({
      peerId: alice.selfId,
      producer: { id: camera.producerId, kind: 'video', source: 'camera' },
    });
    expect(peerStats(alice).producers.map((producer) => [producer.id, producer.source])).toEqual([
      [video, 'screen'],
      [camera.producerId, 'camera'],
    ]);
    // One camera per participant.
    await expect(
      alice.rpc.request('produce', {
        transportId,
        kind: 'video',
        source: 'camera',
        rtpParameters: simulcastRtpParameters(),
      }),
    ).rejects.toMatchObject({ code: VoiceErrorCode.LimitReached });

    const viewer = await h.joinAs({ stream: false });
    const viewerTransport = await openTransport(viewer, 'send');
    await expect(
      viewer.rpc.request('produce', {
        transportId: viewerTransport,
        kind: 'video',
        source: 'camera',
        rtpParameters: simulcastRtpParameters(),
      }),
    ).rejects.toMatchObject({ code: VoiceErrorCode.Forbidden });
  });

  it('closes the consumers of every viewer when the stream stops', async () => {
    const alice = await h.joinAs();
    const bob = await h.joinAs();
    const { transportId, video } = await share(alice);
    await bob.next('producer-added');
    await openTransport(bob, 'recv');
    const { consumerId } = await bob.rpc.request('consume', { producerId: video });

    await alice.rpc.request('closeProducer', { producerId: video });
    await expect(bob.next('producer-removed')).resolves.toEqual({
      peerId: alice.selfId,
      producerId: video,
    });
    await expect(bob.next('consumer-closed')).resolves.toEqual({ consumerId });
    expect(h.server.rooms.stats().totals).toMatchObject({ producers: 0, consumers: 0 });

    // The same peer can start a new stream afterwards.
    await expect(
      alice.rpc.request('produce', {
        transportId,
        kind: 'video',
        source: 'screen',
        rtpParameters: simulcastRtpParameters(),
      }),
    ).resolves.toBeDefined();
  });
});
