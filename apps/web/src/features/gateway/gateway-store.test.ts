import { defaultUserSettings, type Channel, type Guild, type Member } from '@frequencia/shared';
import { describe, expect, it } from 'vitest';
import { gatewayReducers, initialGatewayState, type GatewayState } from './gateway-store';

const GUILD = '00000000-0000-4000-8000-000000000001';
const TEXT = '00000000-0000-4000-8000-000000000002';
const VOICE = '00000000-0000-4000-8000-000000000003';
const ALICE = '00000000-0000-4000-8000-00000000000a';
const BRUNO = '00000000-0000-4000-8000-00000000000b';

const member = (id: string, displayName: string): Member => ({
  user: {
    id,
    username: displayName.toLowerCase(),
    displayName,
    avatar: null,
    banner: null,
    bio: null,
    customStatus: null,
    accentColor: null,
    status: 'online' as const,
  },
  nickname: null,
  roleIds: [],
  joinedAt: '2026-01-01T00:00:00.000Z',
  serverMuted: false,
});

const channel = (id: string, type: Channel['type'], position: number): Channel => ({
  id,
  guildId: GUILD,
  type,
  name: type,
  topic: null,
  position,
  parentId: null,
  overwrites: [],
});

const guild = (overrides: Partial<Guild> = {}): Guild => ({
  id: GUILD,
  kind: 'server',
  dm: null,
  name: 'Amigos',
  icon: null,
  ownerId: ALICE,
  channels: [channel(TEXT, 'text', 0), channel(VOICE, 'voice', 1)],
  roles: [],
  members: [member(ALICE, 'Alice'), member(BRUNO, 'Bruno')],
  onlineUserIds: [ALICE],
  activities: {},
  voiceStates: [],
  sounds: {
    join: null,
    leave: null,
    streamStart: null,
    streamStop: null,
    watchStart: null,
    watchStop: null,
    viewerJoin: null,
    viewerLeave: null,
  },
  ...overrides,
});

const stateWith = (value: Guild): GatewayState => ({
  status: 'ready',
  guilds: { [value.id]: value },
  guildOrder: [value.id],
});

const voice = (userId: string, channelId: string | null) => ({
  guildId: GUILD,
  userId,
  channelId,
  muted: false,
  deafened: false,
  streaming: false,
});

describe('gateway reducers', () => {
  it('READY replaces everything and keeps the server order', () => {
    const other = guild({ id: '00000000-0000-4000-8000-000000000009', name: 'Outro' });
    const next = gatewayReducers.READY(initialGatewayState, {
      sessionId: 's',
      user: { ...member(ALICE, 'Alice').user, presence: 'online' },
      settings: defaultUserSettings,
      blockedUserIds: [],
      guilds: [guild(), other],
    });
    expect(next.status).toBe('ready');
    expect(next.guildOrder).toEqual([GUILD, other.id]);
  });

  it('GUILD_CREATE appends, GUILD_SYNC replaces in place, GUILD_DELETE removes', () => {
    const created = gatewayReducers.GUILD_CREATE(initialGatewayState, guild());
    expect(created.guildOrder).toEqual([GUILD]);

    const synced = gatewayReducers.GUILD_SYNC(stateWith(guild()), guild({ channels: [] }));
    expect(synced.guildOrder).toEqual([GUILD]);
    expect(synced.guilds?.[GUILD]?.channels).toEqual([]);

    const deleted = gatewayReducers.GUILD_DELETE(stateWith(guild()), { id: GUILD });
    expect(deleted).toEqual({ guilds: {}, guildOrder: [] });
  });

  it('ignores events for guilds it does not know', () => {
    expect(
      gatewayReducers.GUILD_UPDATE(initialGatewayState, { id: GUILD, name: 'X', icon: null }),
    ).toEqual({});
    expect(gatewayReducers.VOICE_STATE_UPDATE(initialGatewayState, voice(ALICE, VOICE))).toEqual(
      {},
    );
  });

  it('keeps channels sorted and drops the voice states of a deleted channel', () => {
    const start = stateWith(guild({ voiceStates: [{ ...voice(ALICE, VOICE), channelId: VOICE }] }));
    const added = gatewayReducers.CHANNEL_CREATE(start, {
      ...channel('00000000-0000-4000-8000-000000000004', 'text', -1),
    });
    expect(added.guilds?.[GUILD]?.channels[0]?.position).toBe(-1);

    const removed = gatewayReducers.CHANNEL_DELETE(start, { id: VOICE, guildId: GUILD });
    expect(removed.guilds?.[GUILD]?.channels.map((entry) => entry.id)).toEqual([TEXT]);
    expect(removed.guilds?.[GUILD]?.voiceStates).toEqual([]);
  });

  it('detaches the children of a deleted category', () => {
    const category = channel('00000000-0000-4000-8000-000000000005', 'category', 0);
    const child = { ...channel(TEXT, 'text', 0), parentId: category.id };
    const next = gatewayReducers.CHANNEL_DELETE(stateWith(guild({ channels: [category, child] })), {
      id: category.id,
      guildId: GUILD,
    });
    expect(next.guilds?.[GUILD]?.channels).toEqual([{ ...child, parentId: null }]);
  });

  it('removes every trace of a member who leaves', () => {
    const start = stateWith(
      guild({
        onlineUserIds: [ALICE, BRUNO],
        voiceStates: [{ ...voice(BRUNO, VOICE), channelId: VOICE }],
      }),
    );
    const next = gatewayReducers.MEMBER_REMOVE(start, { guildId: GUILD, userId: BRUNO }).guilds?.[
      GUILD
    ];
    expect(next?.members.map((entry) => entry.user.id)).toEqual([ALICE]);
    expect(next?.onlineUserIds).toEqual([ALICE]);
    expect(next?.voiceStates).toEqual([]);
  });

  it('applies presence only to guilds the user belongs to, without duplicates', () => {
    const start = stateWith(guild());
    const online = gatewayReducers.PRESENCE_UPDATE(start, { userId: BRUNO, status: 'online' });
    expect(online.guilds?.[GUILD]?.onlineUserIds).toEqual([ALICE, BRUNO]);

    const again = gatewayReducers.PRESENCE_UPDATE(
      { ...start, ...online },
      { userId: BRUNO, status: 'online' },
    );
    expect(again.guilds?.[GUILD]?.onlineUserIds).toEqual([ALICE, BRUNO]);

    const stranger = gatewayReducers.PRESENCE_UPDATE(start, {
      userId: '00000000-0000-4000-8000-0000000000ff',
      status: 'online',
    });
    expect(stranger.guilds?.[GUILD]?.onlineUserIds).toEqual([ALICE]);

    const offline = gatewayReducers.PRESENCE_UPDATE(start, { userId: ALICE, status: 'offline' });
    expect(offline.guilds?.[GUILD]?.onlineUserIds).toEqual([]);
  });

  it('tracks one voice state per user: join, move, update and leave', () => {
    let state = stateWith(guild());
    const apply = (data: ReturnType<typeof voice> & { muted?: boolean }) => {
      state = { ...state, ...gatewayReducers.VOICE_STATE_UPDATE(state, data) };
      return state.guilds[GUILD]?.voiceStates;
    };

    expect(apply(voice(ALICE, VOICE))).toHaveLength(1);
    expect(apply({ ...voice(ALICE, VOICE), muted: true })).toMatchObject([{ muted: true }]);
    expect(apply(voice(ALICE, TEXT))).toMatchObject([{ channelId: TEXT }]);
    expect(apply(voice(BRUNO, VOICE))).toHaveLength(2);
    expect(apply(voice(ALICE, null))).toMatchObject([{ userId: BRUNO }]);
  });
});

describe('activity', () => {
  it('shows the game a member plays in every guild they are in, and forgets it', () => {
    const state: GatewayState = { ...initialGatewayState, guilds: { [GUILD]: guild() } };
    const activity = { game: 'ELDEN RING', since: '2026-10-15T22:00:00.000Z' };
    const playing = gatewayReducers.ACTIVITY_UPDATE(state, { userId: ALICE, activity });
    expect(playing.guilds?.[GUILD]?.activities).toEqual({ [ALICE]: activity });
    const done = gatewayReducers.ACTIVITY_UPDATE(
      { ...state, ...playing },
      { userId: ALICE, activity: null },
    );
    expect(done.guilds?.[GUILD]?.activities).toEqual({});
  });
});
