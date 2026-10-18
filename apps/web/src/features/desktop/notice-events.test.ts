import type { Guild, VoiceState } from '@frequencia/shared';
import { describe, expect, it } from 'vitest';
import type { GatewayState } from '../gateway/gateway-store';
import { noticeEventsFor } from './notice-events';

const GUILD = '00000000-0000-4000-8000-000000000001';
const VOICE = '00000000-0000-4000-8000-000000000003';
const SELF = '00000000-0000-4000-8000-00000000000a';
const BRUNO = '00000000-0000-4000-8000-00000000000b';

const guild = (overrides: Partial<Guild> = {}): Guild =>
  ({
    id: GUILD,
    kind: 'server',
    dm: null,
    name: 'Amigos',
    icon: null,
    ownerId: SELF,
    channels: [],
    roles: [],
    members: [],
    onlineUserIds: [SELF],
    activities: {},
    voiceStates: [],
    ...overrides,
  }) as Guild;

const voice = (userId: string, streaming = false): VoiceState => ({
  guildId: GUILD,
  userId,
  channelId: VOICE,
  muted: false,
  deafened: false,
  streaming,
});

const state = (value: Guild, status: GatewayState['status'] = 'ready'): GatewayState => ({
  status,
  guilds: { [value.id]: value },
  guildOrder: [value.id],
});

describe('noticeEventsFor', () => {
  it('announces someone opening the app', () => {
    expect(
      noticeEventsFor(state(guild()), state(guild({ onlineUserIds: [SELF, BRUNO] })), SELF),
    ).toEqual([{ kind: 'online', userId: BRUNO, guildId: GUILD, channelId: null }]);
  });

  it('announces a call and a stream, one notice per person, the stream first', () => {
    const online = guild({ onlineUserIds: [SELF, BRUNO] });
    const inCall = guild({ onlineUserIds: [SELF, BRUNO], voiceStates: [voice(BRUNO)] });
    const streaming = guild({ onlineUserIds: [SELF, BRUNO], voiceStates: [voice(BRUNO, true)] });
    expect(noticeEventsFor(state(online), state(inCall), SELF)).toEqual([
      { kind: 'call', userId: BRUNO, guildId: GUILD, channelId: VOICE },
    ]);
    expect(noticeEventsFor(state(inCall), state(streaming), SELF)).toMatchObject([
      { kind: 'stream' },
    ]);
    // Opening the app straight into a stream is one notice.
    expect(noticeEventsFor(state(guild()), state(streaming), SELF)).toMatchObject([
      { kind: 'stream', userId: BRUNO },
    ]);
    // Muting or leaving says nothing.
    expect(noticeEventsFor(state(streaming), state(online), SELF)).toEqual([]);
  });

  it('says nothing about the user, on connecting, or about private calls', () => {
    expect(
      noticeEventsFor(
        state(guild({ onlineUserIds: [] })),
        state(guild({ voiceStates: [voice(SELF)] })),
        SELF,
      ),
    ).toEqual([]);
    expect(
      noticeEventsFor(
        state(guild(), 'connecting'),
        state(guild({ onlineUserIds: [SELF, BRUNO] })),
        SELF,
      ),
    ).toEqual([]);
    const dm = (voiceStates: VoiceState[]) =>
      guild({ kind: 'dm', onlineUserIds: [SELF, BRUNO], voiceStates });
    expect(noticeEventsFor(state(dm([])), state(dm([voice(BRUNO)])), SELF)).toEqual([]);
  });
});
