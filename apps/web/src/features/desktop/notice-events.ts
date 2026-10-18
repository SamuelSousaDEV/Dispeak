import type { GatewayState } from '../gateway/gateway-store';

/**
 * What a notice announces: someone opened the app, entered a call, or started a stream. The
 * last two say where, and a click takes the user there.
 */
export interface NoticeEvent {
  kind: 'online' | 'call' | 'stream';
  userId: string;
  guildId: string;
  /** The voice channel, for `call` and `stream`. */
  channelId: string | null;
}

/** A stream is more worth knowing than a call, and a call more than being online. */
const WEIGHT: Record<NoticeEvent['kind'], number> = { online: 0, call: 1, stream: 2 };

/**
 * The notices a change of the guilds calls for, at most one per person. Only changes between
 * two ready states count: connecting or reconnecting finds everyone where they already were.
 * Private conversations ring on their own, so their calls are left out.
 */
export function noticeEventsFor(
  previous: GatewayState,
  next: GatewayState,
  selfId: string,
): NoticeEvent[] {
  if (previous.status !== 'ready' || next.status !== 'ready') return [];
  const found = new Map<string, NoticeEvent>();
  const add = (event: NoticeEvent) => {
    if (event.userId === selfId) return;
    const known = found.get(event.userId);
    if (!known || WEIGHT[event.kind] > WEIGHT[known.kind]) found.set(event.userId, event);
  };

  for (const guild of Object.values(next.guilds)) {
    const before = previous.guilds[guild.id];
    // A guild the user just joined is news as a whole, not person by person.
    if (!before) continue;
    const wasOnline = new Set(before.onlineUserIds);
    for (const userId of guild.onlineUserIds) {
      if (!wasOnline.has(userId))
        add({ kind: 'online', userId, guildId: guild.id, channelId: null });
    }
    if (guild.kind === 'dm') continue;
    for (const voice of guild.voiceStates) {
      const was = before.voiceStates.find((entry) => entry.userId === voice.userId);
      const sameChannel = was?.channelId === voice.channelId;
      if (voice.streaming && !(sameChannel && was.streaming)) {
        add({
          kind: 'stream',
          userId: voice.userId,
          guildId: guild.id,
          channelId: voice.channelId,
        });
      } else if (!sameChannel) {
        add({ kind: 'call', userId: voice.userId, guildId: guild.id, channelId: voice.channelId });
      }
    }
  }
  return [...found.values()];
}
