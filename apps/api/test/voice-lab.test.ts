import { VOICE_LAB_VARIANTS, type VoiceLabResult } from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { createTestApp, type Account, type TestApp } from './helpers/app';

const verdict: VoiceLabResult = {
  best: 'deepfilter',
  worst: 'current',
  order: [...VOICE_LAB_VARIANTS],
  inputDevice: 'Microfone (HyperX Cloud)',
  appVersion: '0.13.0',
  speechDb: -24.5,
  noiseDb: -61,
  comment: 'a atual parece rádio',
};

/** The smallest WAV header followed by a few silent samples. */
function wav(): Buffer {
  const data = Buffer.alloc(44 + 96);
  data.write('RIFF', 0, 'ascii');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVE', 8, 'ascii');
  return data;
}

describe('voice lab', () => {
  let t: TestApp;
  let me: Account;
  let other: Account;

  const send = (account: Account, body: unknown) =>
    t.request('POST', '/voice-lab/results', { token: account.token, body });
  const attach = (account: Account, id: string, data: Buffer) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/voice-lab/results/${id}/recording`,
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${account.token}`,
      },
      payload: data,
    });
  const stored = async (id: string) => {
    const [row] = await t.app.ctx.db
      .select()
      .from(schema.voiceLabResults)
      .where(eq(schema.voiceLabResults.id, id));
    return row;
  };

  beforeAll(async () => {
    t = await createTestApp();
    [me, other] = await Promise.all([t.account('Eu'), t.account('Outro')]);
  });

  afterAll(async () => {
    await t.close();
  });

  it('keeps a verdict and, when sent, the recording of its own author', async () => {
    const created = await send(me, verdict);
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    expect(await stored(id)).toMatchObject({
      best: 'deepfilter',
      worst: 'current',
      recording: null,
      details: { comment: 'a atual parece rádio', inputDevice: 'Microfone (HyperX Cloud)' },
    });

    // Somebody else's verdict cannot be given a recording, and a recording is sent once.
    expect((await attach(other, id, wav())).statusCode).toBe(404);
    expect((await attach(me, id, wav())).statusCode).toBe(204);
    expect((await attach(me, id, wav())).statusCode).toBe(404);
    expect((await stored(id))?.recording?.length).toBe(140);
  });

  it('refuses what is not a verdict or not a WAV file', async () => {
    expect((await send(me, { ...verdict, best: 'current' })).statusCode).toBe(400);
    expect((await send(me, { ...verdict, order: ['raw'] })).statusCode).toBe(400);
    const { id } = (await send(me, verdict)).json<{ id: string }>();
    expect((await attach(me, id, Buffer.from('not a wav file at all'))).statusCode).toBe(400);
    expect((await t.request('POST', '/voice-lab/results', { body: verdict })).statusCode).toBe(401);
  });
});
