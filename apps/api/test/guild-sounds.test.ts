import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  GUILD_SOUND_MAX_BYTES,
  Permissions as P,
  type Guild,
  type GuildSound,
} from '@frequencia/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sniffAudio } from '../src/lib/audio';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { connectGateway, type GatewayClient } from './helpers/gateway';

/** An empty but well-formed WAV file. */
const WAV = Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=', 'base64');
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);

describe('sniffAudio', () => {
  it('recognises audio containers by their bytes', () => {
    expect(sniffAudio(WAV)).toBe('audio/wav');
    expect(sniffAudio(MP3)).toBe('audio/mpeg');
    expect(
      sniffAudio(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(12)])),
    ).toBe('audio/mpeg');
    expect(sniffAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(12)]))).toBe('audio/ogg');
    expect(
      sniffAudio(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(4)])),
    ).toBe('audio/mp4');
  });

  it('rejects everything else', () => {
    expect(sniffAudio(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffAudio(Buffer.from('MZ this is a program, not a sound'))).toBeNull();
    expect(sniffAudio(Buffer.alloc(64, 0xff))).toBeNull();
  });
});

describe('guild notification sounds', () => {
  let t: TestApp;
  let owner: Account;
  let member: Account;
  let outsider: Account;
  const clients: GatewayClient[] = [];

  const put = (
    account: Account | null,
    guildId: string,
    event: string,
    data: Buffer,
    name = 'entrada.wav',
  ) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/guilds/${guildId}/sounds/${event}?filename=${encodeURIComponent(name)}`,
      headers: {
        'content-type': 'application/octet-stream',
        ...(account ? { authorization: `Bearer ${account.token}` } : {}),
      },
      payload: data,
    });
  const get = (account: Account, guildId: string, event: string) =>
    t.request('GET', `/guilds/${guildId}/sounds/${event}`, { token: account.token });
  const guildOf = async (account: Account, guildId: string) =>
    (await t.request('GET', `/guilds/${guildId}`, { token: account.token })).json<Guild>();
  const storedFiles = () =>
    readdir(path.join(t.app.ctx.config.UPLOADS_DIR, 'sounds')).catch(() => [] as string[]);

  async function scenario() {
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, member);
    return guild;
  }

  beforeAll(async () => {
    t = await createTestApp();
    [owner, member, outsider] = await Promise.all([
      t.account('Dona'),
      t.account('Membro'),
      t.account('Estranho'),
    ]);
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  afterAll(async () => {
    await t.close();
  });

  it('starts with no custom sounds', async () => {
    const guild = await scenario();
    expect(guild.sounds).toEqual({
      join: null,
      leave: null,
      streamStart: null,
      streamStop: null,
      watchStart: null,
      watchStop: null,
      viewerJoin: null,
      viewerLeave: null,
    });
    expect((await get(owner, guild.id, 'join')).statusCode).toBe(404);
  });

  it('lets the owner set a sound that every member receives and can download', async () => {
    const guild = await scenario();
    const socket = await connectGateway(t.wsUrl);
    clients.push(socket);
    await socket.identify(member.token);

    const response = await put(owner, guild.id, 'join', WAV, 'C:\\sons\\entrada épica.wav');
    expect(response.statusCode).toBe(200);
    const sound = response.json<GuildSound>();
    expect(sound.filename).toBe('entrada épica.wav');

    // Members are told right away, without asking.
    const synced = await socket.next('GUILD_SYNC');
    expect(synced.sounds).toEqual({
      join: sound,
      leave: null,
      streamStart: null,
      streamStop: null,
      watchStart: null,
      watchStop: null,
      viewerJoin: null,
      viewerLeave: null,
    });
    expect((await guildOf(member, guild.id)).sounds.join).toEqual(sound);

    const file = await get(member, guild.id, 'join');
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(WAV)).toBe(true);
    expect(file.headers['content-type']).toBe('audio/wav');
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    expect((await get(outsider, guild.id, 'join')).statusCode).toBe(404);
    expect((await t.request('GET', `/guilds/${guild.id}/sounds/join`)).statusCode).toBe(401);
  });

  it('only lets the owner change the sounds, whatever roles a member has', async () => {
    const guild = await scenario();
    const admin = await t.createRole(owner, guild.id, 'Admin', P.Administrator);
    await t.setRoles(owner, guild.id, member, [admin.id]);

    expect((await put(member, guild.id, 'join', WAV)).statusCode).toBe(403);
    expect((await put(outsider, guild.id, 'join', WAV)).statusCode).toBe(404);
    expect((await put(null, guild.id, 'join', WAV)).statusCode).toBe(401);

    await put(owner, guild.id, 'join', WAV);
    const remove = (account: Account) =>
      t.request('DELETE', `/guilds/${guild.id}/sounds/join`, { token: account.token });
    expect((await remove(member)).statusCode).toBe(403);
    expect((await guildOf(member, guild.id)).sounds.join).not.toBeNull();
  });

  it('validates the event, the size and the bytes', async () => {
    const guild = await scenario();
    expect((await put(owner, guild.id, 'explosion', WAV)).statusCode).toBe(400);
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    expect((await put(owner, guild.id, 'join', html)).statusCode).toBe(400);
    const huge = Buffer.concat([WAV, Buffer.alloc(GUILD_SOUND_MAX_BYTES)]);
    expect((await put(owner, guild.id, 'join', huge)).statusCode).toBe(413);
    expect((await guildOf(owner, guild.id)).sounds.join).toBeNull();
  });

  it('replaces and removes sounds without leaving files behind', async () => {
    const guild = await scenario();
    const first = (await put(owner, guild.id, 'leave', WAV)).json<GuildSound>();
    const second = (await put(owner, guild.id, 'leave', MP3, 'tchau.mp3')).json<GuildSound>();
    expect(second.id).not.toBe(first.id);
    expect(await storedFiles()).toContain(second.id);
    expect(await storedFiles()).not.toContain(first.id);
    expect((await get(member, guild.id, 'leave')).headers['content-type']).toBe('audio/mpeg');

    const removed = await t.request('DELETE', `/guilds/${guild.id}/sounds/leave`, {
      token: owner.token,
    });
    expect(removed.statusCode).toBe(204);
    expect((await guildOf(member, guild.id)).sounds.leave).toBeNull();
    expect((await get(member, guild.id, 'leave')).statusCode).toBe(404);
    expect(await storedFiles()).not.toContain(second.id);

    // Deleting the guild takes its sounds along.
    const kept = (await put(owner, guild.id, 'join', WAV)).json<GuildSound>();
    await t.request('DELETE', `/guilds/${guild.id}`, { token: owner.token });
    expect(await storedFiles()).not.toContain(kept.id);
  });

  it('keeps guild sounds out of reach of the attachment sweep', async () => {
    const guild = await scenario();
    const sound = (await put(owner, guild.id, 'join', WAV)).json<GuildSound>();
    // Only the file half of the sweep: the other half deletes rows in the database every test
    // file shares, and would take the fresh uploads of the attachment tests with it.
    await t.app.ctx.messages.sweepOrphanFiles(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect(await storedFiles()).toContain(sound.id);
    expect((await get(member, guild.id, 'join')).statusCode).toBe(200);
  });
});
