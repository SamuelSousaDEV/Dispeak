import { APP_NAME, type GatewayEventData } from '@frequencia/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BootScreen } from '../../components/BootScreen';
import { Button } from '../../components/Button';
import { ContextMenuHost } from '../../components/ContextMenu';
import { LinkDialogHost } from '../../components/LinkDialog';
import { ToastHost } from '../../components/Toast';
import { registerNavigation } from '../../lib/app-navigation';
import { cx } from '../../lib/cx';
import { logout, useAuthStore } from '../auth/auth-store';
import { releaseAttachmentUrls } from '../chat/Attachments';
import { applyChatEvent } from '../chat/chat-store';
import { conversationOf, HOME } from '../friends/dm';
import { DmPanel } from '../friends/DmPanel';
import { ConversationBar } from '../friends/ConversationBar';
import { BLOCKS_KEY, useBlockStore } from '../friends/conversations-api';
import { FRIEND_REQUESTS_KEY } from '../friends/friends-api';
import { FriendsView } from '../friends/FriendsView';
import { gateway } from '../gateway/gateway-client';
import { useGatewayStore } from '../gateway/gateway-store';
import { AddGuildDialog } from '../guilds/dialogs/AddGuildDialog';
import { ChannelSettingsDialog } from '../guilds/dialogs/ChannelSettingsDialog';
import { CreateChannelDialog } from '../guilds/dialogs/CreateChannelDialog';
import { GuildSettingsDialog, type GuildSettingsTab } from '../guilds/dialogs/GuildSettingsDialog';
import { InviteDialog } from '../guilds/dialogs/InviteDialog';
import { groupChannels } from '../guilds/permissions';
import { ProfileCard } from '../profile/ProfileCard';
import { receiveAccountSettings, resetAccountSettings } from '../settings/account-settings';
import { SettingsDialog, type SettingsPage } from '../settings/SettingsDialog';
import { startVoiceSounds } from '../sounds/sound-player';
import { notifyMention } from '../unread/notify';
import { applyUnreadEvent, useUnreadTitle } from '../unread/unread-store';
import { useDesktopCallControls } from '../desktop/call-controls';
import { useCornerNotices } from '../desktop/corner-notices';
import { useGameDetection, useShareActivity } from '../desktop/games';
import { useCloseToTray } from '../desktop/desktop';
import { UpdateNotice } from '../desktop/UpdateNotice';
import { IncomingCalls } from '../friends/IncomingCalls';
import { useVoiceShortcuts } from '../voice/use-voice-shortcuts';
import { MobileVoiceBar } from '../voice/components/MobileVoice';
import { OwnStreamMini } from '../voice/components/OwnStreamMini';
import { leaveVoice } from '../voice/voice-actions';
import { useVoiceStore } from '../voice/voice-store';
import { ChannelPanel } from './ChannelPanel';
import { MemberList } from './MemberList';
import { ServerRail } from './ServerRail';
import { SystemBar } from './SystemBar';
import { TextChannelView } from './TextChannelView';
import { UserPanel } from './UserPanel';
import { VoiceChannelView } from './VoiceChannelView';

type DialogState =
  | { kind: 'add-guild' }
  | { kind: 'invite' }
  | { kind: 'guild-settings'; tab?: GuildSettingsTab }
  | { kind: 'create-channel'; parentId: string | null }
  | { kind: 'channel-settings'; channelId: string }
  | { kind: 'settings'; tab?: SettingsPage }
  | null;

type Drawer = 'channels' | 'members' | null;

/**
 * The application shell, laid out like an IDE: server rail, channel panel, main area and
 * member list, separated by 1px rules. On small screens the side panels become drawers.
 */
/**
 * How long the opening screen stays at least: counted from the page load, so the trace is drawn
 * once and stands whole when the screen lets go, and a shorter stay after signing in.
 */
const BOOT_FROM_LOAD_MS = 1500;
const BOOT_MIN_MS = 800;

export function AppPage() {
  const { guildId, channelId } = useParams();
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const status = useGatewayStore((state) => state.status);
  const guilds = useGatewayStore((state) => state.guilds);
  const order = useGatewayStore((state) => state.guildOrder);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  // The opening screen stays until the first data arrives, then takes a moment to switch off.
  const [booted, setBooted] = useState(false);
  const [bootHeld, setBootHeld] = useState(true);
  useEffect(() => {
    const wait = Math.max(BOOT_MIN_MS, BOOT_FROM_LOAD_MS - performance.now());
    const timer = window.setTimeout(() => setBootHeld(false), wait);
    return () => window.clearTimeout(timer);
  }, []);

  useVoiceShortcuts();
  useCloseToTray();
  useDesktopCallControls(() => setDialog({ kind: 'settings', tab: 'voice' }));
  useGameDetection();
  useCornerNotices();
  useShareActivity();
  useUnreadTitle();
  useEffect(() => startVoiceSounds(), []);

  // Event handlers registered once still need the current router.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });
  // Menus and cards outside the router's reach (open a conversation) move the app through this.
  useEffect(() => registerNavigation((path) => navigateRef.current(path)), []);

  const queryClient = useQueryClient();
  useEffect(() => {
    // Chat history lives in the query cache; gateway events keep it current.
    const unsubscribe = gateway.subscribe((t, data) => {
      applyChatEvent(queryClient, t, data);
      if (t === 'READY') {
        const ready = data as GatewayEventData<'READY'>;
        receiveAccountSettings(ready.settings);
        useBlockStore.setState(ready.blockedUserIds, true);
      }
      if (t === 'BLOCKS_UPDATE') {
        useBlockStore.setState((data as GatewayEventData<'BLOCKS_UPDATE'>).userIds, true);
        void queryClient.invalidateQueries({ queryKey: BLOCKS_KEY });
      }
      if (t === 'USER_SETTINGS_UPDATE') {
        receiveAccountSettings(data as GatewayEventData<'USER_SETTINGS_UPDATE'>);
      }
      if (t === 'FRIEND_REQUEST_CREATE' || t === 'FRIEND_REQUEST_DELETE' || t === 'READY') {
        void queryClient.invalidateQueries({ queryKey: FRIEND_REQUESTS_KEY });
      }
      const self = useAuthStore.getState().user;
      if (!self) return;
      const mention = applyUnreadEvent(t, data, self.id);
      if (mention) {
        notifyMention(mention, useGatewayStore.getState().guilds[mention.guildId], () =>
          navigateRef.current(`/app/${mention.guildId}/${mention.channelId}`),
        );
      }
    });
    const releaseAttachments = releaseAttachmentUrls(queryClient);
    gateway.start();
    return () => {
      unsubscribe();
      releaseAttachments();
      leaveVoice();
      gateway.stop();
      resetAccountSettings();
      useBlockStore.setState([], true);
    };
  }, [queryClient]);

  const guild = guildId ? guilds[guildId] : undefined;
  // Home: the friends list, or one of the private conversations.
  const conversation = user ? conversationOf(guild, user.id) : null;
  const atHome = guildId === HOME || conversation !== null;
  const firstServer = order.find((id) => guilds[id]?.kind === 'server');
  const groups = guild ? groupChannels(guild) : [];
  const numbered = groups.flatMap((group) => group.channels);
  // A thread is reached through its channel: it shows that channel's number.
  const current = numbered
    .flatMap((entry) => [
      { channel: entry.channel, number: entry.number, origin: null as string | null },
      ...entry.threads.map((thread) => ({
        channel: thread,
        number: entry.number,
        origin: entry.channel.name as string | null,
      })),
    ])
    .find((entry) => entry.channel.id === channelId);
  const hasLoaded = status === 'ready' || order.length > 0;

  // Whether the guild last on screen was a private conversation.
  const wasConversation = useRef(false);
  // Keep the URL pointing at something that exists (guilds and channels come and go).
  useEffect(() => {
    if (!hasLoaded) return;
    if (guildId === HOME) return;
    if (!guild) {
      // A conversation that ended (the friendship was undone) leaves the user at home. Anything
      // else goes to the first server, or waits at `/app` for one to arrive.
      const target = wasConversation.current
        ? `/app/${HOME}`
        : firstServer
          ? `/app/${firstServer}`
          : '/app';
      wasConversation.current = false;
      if (guildId || firstServer) navigate(target, { replace: true });
      return;
    }
    wasConversation.current = guild.kind === 'dm';
    if (!current) {
      const fallback =
        numbered.find((entry) => entry.channel.type === 'text') ?? numbered[0] ?? null;
      const target = fallback ? `/app/${guild.id}/${fallback.channel.id}` : `/app/${guild.id}`;
      if (channelId || fallback) navigate(target, { replace: true });
    }
  }, [hasLoaded, guild, guildId, current, channelId, numbered, firstServer, navigate]);

  const voiceStatus = useVoiceStore((state) => state.status);
  const voiceChannelId = useVoiceStore((state) => state.channelId);
  const voiceChannelName = useVoiceStore((state) => state.channelName);
  const inCall = voiceStatus === 'connected' || voiceStatus === 'reconnecting';
  const callGuild = Object.values(guilds).find((entry) =>
    entry.channels.some((channel) => channel.id === voiceChannelId),
  );

  // Phones: a sideways swipe opens and closes the drawers, like the edge of a page.
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swipe = {
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0];
      const target = event.target as HTMLElement;
      // Not while dragging a slider or scrolling something sideways.
      const busy = target.closest('input, textarea, video, [data-no-swipe]');
      let scroller: HTMLElement | null = target;
      let sideways = false;
      while (scroller && scroller !== event.currentTarget) {
        if (scroller.scrollWidth > scroller.clientWidth + 4) {
          const overflow = getComputedStyle(scroller).overflowX;
          if (overflow === 'auto' || overflow === 'scroll') sideways = true;
        }
        scroller = scroller.parentElement;
      }
      swipeStart.current =
        touch && event.touches.length === 1 && !busy && !sideways
          ? { x: touch.clientX, y: touch.clientY }
          : null;
    },
    onTouchEnd: (event: TouchEvent) => {
      const start = swipeStart.current;
      const touch = event.changedTouches[0];
      swipeStart.current = null;
      if (!start || !touch || window.innerWidth >= 768) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
      if (dx > 0) setDrawer((open) => (open === 'members' ? null : 'channels'));
      else {
        const hasMembers = Boolean(guild) && !conversation;
        setDrawer((open) => (open === 'channels' ? null : hasMembers ? 'members' : open));
      }
    },
  };

  if (!user) return null;

  const closeDialog = () => setDialog(null);
  const signOut = async () => {
    leaveVoice();
    gateway.stop();
    await logout();
  };
  const settingsChannel =
    dialog?.kind === 'channel-settings'
      ? guild?.channels.find((channel) => channel.id === dialog.channelId)
      : undefined;

  return (
    // Nothing may widen the page: the off-screen drawers would make a phone scroll sideways.
    // `clip` rather than `hidden`, which focusing something inside a closed drawer can scroll.
    <div className="safe-area flex h-dvh flex-col overflow-clip bg-bg" {...swipe}>
      <div className="relative flex min-h-0 flex-1 overflow-clip">
        {drawer && (
          <button
            type="button"
            aria-label="Fechar painel"
            className="absolute inset-0 z-10 bg-black/60 lg:hidden"
            onClick={() => setDrawer(null)}
          />
        )}

        <aside
          className={cx(
            'absolute inset-y-0 left-0 z-20 flex w-[19rem] max-w-[90vw] bg-surface transition-transform md:static md:z-30 md:w-auto md:translate-x-0',
            drawer === 'channels' ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <ServerRail onAdd={() => setDialog({ kind: 'add-guild' })} />
          <div className="flex min-w-0 flex-1 flex-col border-r border-line md:w-64 md:flex-none">
            {atHome ? (
              <DmPanel userId={user.id} onNavigate={() => setDrawer(null)} />
            ) : guild ? (
              <ChannelPanel
                guild={guild}
                userId={user.id}
                onInvite={() => setDialog({ kind: 'invite' })}
                onCreateChannel={(parentId) => setDialog({ kind: 'create-channel', parentId })}
                onGuildSettings={() => setDialog({ kind: 'guild-settings' })}
                onChannelSettings={(channel) =>
                  setDialog({ kind: 'channel-settings', channelId: channel.id })
                }
                onNavigate={() => setDrawer(null)}
                onManageMembers={() => setDialog({ kind: 'guild-settings', tab: 'members' })}
              />
            ) : (
              <div className="flex-1" />
            )}
            <UserPanel user={user} onOpenSettings={(tab) => setDialog({ kind: 'settings', tab })} />
          </div>
        </aside>

        <main className="relative flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
            <button
              type="button"
              className="label -my-3 shrink-0 py-3 text-muted transition-colors hover:text-accent md:hidden"
              onClick={() => setDrawer('channels')}
            >
              [ CANAIS ]
            </button>
            {conversation ? (
              <>
                <h1 className="label-lg flex min-w-0 items-baseline gap-2">
                  <span className="text-muted">@</span>
                  <span className="truncate text-fg" data-testid="channel-title">
                    {conversation.friend.user.displayName}
                  </span>
                </h1>
                <nav aria-label="Conversa ou chamada" className="ml-auto flex shrink-0 gap-2">
                  {conversation.text && (
                    <Button
                      variant={current?.channel.type === 'text' ? 'active' : 'default'}
                      onClick={() =>
                        navigate(`/app/${conversation.guild.id}/${conversation.text?.id}`)
                      }
                    >
                      CONVERSA
                    </Button>
                  )}
                  {conversation.voice && (
                    <Button
                      variant={current?.channel.type === 'voice' ? 'active' : 'default'}
                      onClick={() =>
                        navigate(`/app/${conversation.guild.id}/${conversation.voice?.id}`)
                      }
                    >
                      {conversation.inCall ? 'CHAMADA · AO VIVO' : 'CHAMADA'}
                    </Button>
                  )}
                </nav>
              </>
            ) : atHome ? (
              <h1 className="label-lg flex min-w-0 items-baseline gap-2">
                <span className="text-muted">00.</span>
                <span className="text-fg" data-testid="channel-title">
                  AMIGOS
                </span>
              </h1>
            ) : current ? (
              <h1 className="label-lg flex min-w-0 items-baseline gap-2">
                <span className="text-muted">{current.number}.</span>
                {current.origin && (
                  <span className="hidden truncate text-muted sm:inline">{current.origin} ›</span>
                )}
                <span className="truncate text-fg" data-testid="channel-title">
                  {current.channel.name}
                </span>
                {current.channel.topic && (
                  <span className="label hidden truncate text-muted normal-case sm:inline">
                    {current.channel.topic}
                  </span>
                )}
              </h1>
            ) : (
              <span className="label-lg text-muted">{APP_NAME.toUpperCase()}</span>
            )}
            {guild && !conversation && (
              <button
                type="button"
                className="label ml-auto shrink-0 text-muted transition-colors hover:text-accent lg:hidden"
                onClick={() => setDrawer('members')}
              >
                [ MEMBROS ]
              </button>
            )}
          </header>

          {/* Away from the call while streaming: the stream stays in a corner. */}
          {inCall && voiceChannelId !== channelId && (
            <OwnStreamMini to={callGuild ? `/app/${callGuild.id}/${voiceChannelId}` : null} />
          )}
          {inCall && voiceChannelId !== channelId && (
            <MobileVoiceBar
              to={callGuild ? `/app/${callGuild.id}/${voiceChannelId}` : null}
              channelName={voiceChannelName ?? ''}
            />
          )}

          {conversation && <ConversationBar conversation={conversation} />}

          {/* Keyed by what is on screen, so a change of channel arrives instead of blinking. */}
          <div
            key={`${guildId ?? ''}/${current?.channel.id ?? ''}`}
            className="anim-view min-h-0 flex-1"
          >
            {!hasLoaded ? (
              <div className="grid-bg h-full" />
            ) : guildId === HOME ? (
              <FriendsView userId={user.id} />
            ) : !guild ? (
              <div className="grid-bg flex h-full items-center justify-center p-4">
                <section className="w-full max-w-sm border border-line bg-surface">
                  <header className="border-b border-line px-4 py-4">
                    <p className="label text-muted">00. INÍCIO</p>
                    <h2 className="display mt-1 text-xl text-fg">Nenhum servidor ainda</h2>
                  </header>
                  <div className="flex flex-col gap-3 p-4">
                    <p className="text-sm text-muted">
                      Crie um servidor para você e seus amigos, ou entre em um com um convite.
                    </p>
                    <Button variant="primary" onClick={() => setDialog({ kind: 'add-guild' })}>
                      CRIAR OU ENTRAR
                    </Button>
                  </div>
                </section>
              </div>
            ) : !current ? (
              <div className="grid-bg flex h-full items-center justify-center">
                <p className="label text-muted">NENHUM CANAL VISÍVEL</p>
              </div>
            ) : current.channel.type === 'voice' ? (
              <VoiceChannelView
                key={current.channel.id}
                guild={guild}
                channel={current.channel}
                userId={user.id}
                onManageMembers={() => setDialog({ kind: 'guild-settings', tab: 'members' })}
              />
            ) : (
              <TextChannelView
                key={current.channel.id}
                guild={guild}
                channel={current.channel}
                userId={user.id}
              />
            )}
          </div>
        </main>

        {conversation && (
          <aside className="hidden w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface xl:flex">
            <ProfileCard
              user={conversation.friend.user}
              name={conversation.friend.user.displayName}
              presence={conversation.online ? conversation.friend.user.status : 'offline'}
              activity={conversation.guild.activities[conversation.friend.user.id]}
            />
          </aside>
        )}
        {guild && !conversation && (
          <aside
            className={cx(
              'absolute inset-y-0 right-0 z-20 flex w-60 max-w-[80vw] flex-col border-l border-line bg-surface transition-transform lg:static lg:z-0 lg:translate-x-0',
              drawer === 'members' ? 'translate-x-0' : 'translate-x-full',
            )}
          >
            <MemberList
              guild={guild}
              userId={user.id}
              onManageMembers={() => setDialog({ kind: 'guild-settings', tab: 'members' })}
            />
          </aside>
        )}
      </div>

      {!booted && (
        <BootScreen
          steps={[
            { name: 'SESSÃO', state: 'OK', done: true },
            {
              name: 'GATEWAY',
              state: hasLoaded ? 'OK' : status === 'reconnecting' ? 'RECONECTANDO' : 'CONECTANDO',
              done: hasLoaded,
            },
          ]}
          leaving={hasLoaded && !bootHeld}
          onGone={() => setBooted(true)}
        />
      )}

      <SystemBar />
      <ContextMenuHost />
      <ToastHost />
      <LinkDialogHost />

      {dialog?.kind === 'add-guild' && <AddGuildDialog onClose={closeDialog} />}
      {dialog?.kind === 'settings' && (
        <SettingsDialog
          user={user}
          guild={guild}
          initialPage={dialog.tab}
          onSignOut={() => void signOut()}
          onClose={closeDialog}
        />
      )}
      {guild && dialog?.kind === 'invite' && <InviteDialog guild={guild} onClose={closeDialog} />}
      {guild && dialog?.kind === 'guild-settings' && (
        <GuildSettingsDialog
          guild={guild}
          userId={user.id}
          initialTab={dialog.tab}
          onClose={closeDialog}
        />
      )}
      {guild && dialog?.kind === 'create-channel' && (
        <CreateChannelDialog guild={guild} parentId={dialog.parentId} onClose={closeDialog} />
      )}
      {guild && settingsChannel && (
        <ChannelSettingsDialog
          guild={guild}
          channel={settingsChannel}
          userId={user.id}
          onClose={closeDialog}
        />
      )}
      <UpdateNotice />
      <IncomingCalls selfId={user.id} />
    </div>
  );
}
