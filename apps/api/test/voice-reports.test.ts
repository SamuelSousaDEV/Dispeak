import { randomUUID } from 'node:crypto';
import type { VoiceReport, VoiceReportSummary, VoiceSample } from '@frequencia/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { startFakeMedia, type FakeMedia } from './helpers/fake-media';

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const sample = (t: number, listenerId: string): VoiceSample => ({
  t,
  server: { kbps: 128, packets: 500, packetsLost: 2 },
  speaker: { noiseSuppression: 'gtcrn', echoCancellation: true, autoGainControl: true, rttMs: 40 },
  listeners: [
    {
      userId: listenerId,
      lossPercent: 3,
      concealedPercent: 4.5,
      jitterMs: 6,
      jitterBufferMs: 60,
      rttMs: 80,
    },
  ],
});

describe('voice reports', () => {
  let media: FakeMedia;
  let t: TestApp;

  beforeAll(async () => {
    media = await startFakeMedia();
    t = await createTestApp({ MEDIA_INTERNAL_URL: media.url, MEDIA_SHARED_SECRET: media.secret });
    await eventually(() => expect(media.links()).toBe(1));
  });

  afterAll(async () => {
    await t.close();
    await media.close();
  });

  const list = async (account: Account) =>
    (await t.request('GET', '/voice-reports', { token: account.token })).json<{
      reports: VoiceReportSummary[];
    }>().reports;

  it('joins the chunks of a voice and shows it to the speaker and the owner only', async () => {
    const [owner, speaker, listener] = await Promise.all([
      t.account('Dona'),
      t.account('Fala'),
      t.account('Ouve'),
    ]);
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, speaker);
    await t.join(guild, owner, listener);
    const voice = guild.channels.find((channel) => channel.type === 'voice');
    if (!voice) throw new Error('default voice channel missing');

    const producerId = randomUUID();
    const base = {
      producerId,
      roomId: voice.id,
      userId: speaker.user.id,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const at = (seconds: number) => sample(seconds, listener.user.id);
    media.reportVoice({ ...base, eventId: 'v:1', endedAt: null, samples: [at(10), at(20)] });
    // The same event again, as a second API instance would also receive: stored once.
    media.reportVoice({ ...base, eventId: 'v:1', endedAt: null, samples: [at(10), at(20)] });
    const endedAt = new Date().toISOString();
    media.reportVoice({ ...base, eventId: 'v:2', endedAt, samples: [at(30)] });

    await eventually(async () => {
      expect(await list(speaker)).toEqual([
        {
          id: producerId,
          channelId: voice.id,
          channelName: voice.name,
          guildName: guild.name,
          userId: speaker.user.id,
          userName: speaker.user.displayName,
          startedAt: base.startedAt,
          endedAt,
          sampleCount: 3,
        },
      ]);
    });
    expect((await list(owner)).map((report) => report.id)).toEqual([producerId]);
    // Hearing a voice does not make it yours to read.
    expect(await list(listener)).toEqual([]);

    const detail = await t.request('GET', `/voice-reports/${producerId}`, { token: owner.token });
    expect(detail.statusCode).toBe(200);
    const report = detail.json<VoiceReport>();
    expect(report.samples.map((entry) => entry.t)).toEqual([10, 20, 30]);
    expect(report.listenerNames).toEqual({ [listener.user.id]: listener.user.displayName });
    const hidden = await t.request('GET', `/voice-reports/${producerId}`, {
      token: listener.token,
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('ignores voices of rooms that are not channels', async () => {
    const speaker = await t.account('Laboratorio');
    media.reportVoice({
      eventId: 'lab:1',
      producerId: randomUUID(),
      roomId: 'lab-room',
      userId: speaker.user.id,
      startedAt: new Date().toISOString(),
      endedAt: null,
      samples: [sample(10, 'lab-peer')],
    });
    // Give the event time to arrive: nothing should come of it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await list(speaker)).toEqual([]);
  });
});
