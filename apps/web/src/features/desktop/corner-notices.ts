import type { Guild } from '@frequencia/shared';
import { useEffect } from 'react';
import { pictureUrl } from '../../components/Avatar';
import { navigateTo } from '../../lib/app-navigation';
import { connectToVoiceChannel } from '../app/voice-channel';
import { useAuthStore } from '../auth/auth-store';
import { useGatewayStore } from '../gateway/gateway-store';
import { groupChannels } from '../guilds/permissions';
import { useSettingsStore } from '../settings/settings-store';
import { useVoiceStore } from '../voice/voice-store';
import { desktop } from './desktop';
import { noticeEventsFor, type NoticeEvent } from './notice-events';

/** The same person and the same kind of news are not announced again within this time. */
const QUIET_MS = 15 * 60_000;

function channelLabel(guild: Guild, channelId: string): string | null {
  for (const group of groupChannels(guild)) {
    const entry = group.channels.find((item) => item.channel.id === channelId);
    if (entry) return `${entry.number}. ${entry.channel.name.toUpperCase()}`;
  }
  return null;
}

/**
 * Notices in the corner of the screen, in the desktop app: a friend opening it, entering a
 * call, starting a stream. Calls and streams only while the user is in no call (inside one the
 * sounds say it already), and nothing while "do not disturb".
 */
export function useCornerNotices(): void {
  useEffect(() => {
    const notices = desktop?.notices;
    if (!notices) return;
    const shownAt = new Map<string, number>();
    const clicks = new Map<string, NoticeEvent>();

    const stopGateway = useGatewayStore.subscribe((next, previous) => {
      const self = useAuthStore.getState().user;
      if (!self || self.presence === 'dnd') return;
      const wanted = useSettingsStore.getState().cornerNotices;
      const voice = useVoiceStore.getState();
      const inCall = voice.status !== 'idle' && voice.status !== 'error';
      const now = Date.now();

      for (const event of noticeEventsFor(previous, next, self.id)) {
        if (event.kind === 'online' ? !wanted.online : !wanted.calls || inCall) continue;
        const key = `${event.kind}:${event.userId}`;
        if (now - (shownAt.get(key) ?? -Infinity) < QUIET_MS) continue;

        const guild = next.guilds[event.guildId];
        const member = guild?.members.find((entry) => entry.user.id === event.userId);
        if (!guild || !member) continue;
        const place = event.channelId ? channelLabel(guild, event.channelId) : null;
        if (event.kind !== 'online' && !place) continue;
        shownAt.set(key, now);

        const id = `${key}:${now}`;
        clicks.set(id, event);
        notices.show({
          id,
          title: member.nickname ?? member.user.displayName,
          text:
            event.kind === 'online'
              ? 'ABRIU O DISPEAKER'
              : `${event.kind === 'stream' ? 'TRANSMITINDO EM' : 'ENTROU EM'} ${place ?? ''} · ${guild.name}`,
          picture: member.user.avatar
            ? new URL(pictureUrl(member.user.avatar), window.location.href).href
            : null,
          action: event.kind === 'online' ? null : event.kind === 'stream' ? 'ASSISTIR' : 'ENTRAR',
        });
      }
    });

    const stopClicks = notices.onClick((id) => {
      const event = clicks.get(id);
      if (!event) return;
      if (!event.channelId) {
        navigateTo(`/app/${event.guildId}`);
        return;
      }
      navigateTo(`/app/${event.guildId}/${event.channelId}`);
      const channel = useGatewayStore
        .getState()
        .guilds[event.guildId]?.channels.find((entry) => entry.id === event.channelId);
      const voice = useVoiceStore.getState();
      const inCall = voice.status !== 'idle' && voice.status !== 'error';
      if (channel && !inCall) connectToVoiceChannel(channel);
    });

    return () => {
      stopGateway();
      stopClicks();
    };
  }, []);
}
