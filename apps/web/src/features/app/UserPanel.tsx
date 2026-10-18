import { ghostDown } from '../../lib/exit-ghost';
import { hasPermission, Permissions, type PresenceMode, type Self } from '@frequencia/shared';
import { useCallback, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { openContextMenu } from '../../components/ContextMenu';
import { attempt } from '../../components/Toast';
import { desktop } from '../desktop/desktop';
import { profileApi } from '../auth/profile-api';
import { StatusMark } from '../profile/ProfileCard';
import type { SettingsPage } from '../settings/SettingsDialog';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { cx } from '../../lib/cx';
import { useDismiss } from '../../lib/use-dismiss';
import { conversationOf } from '../friends/dm';
import { GameStreamHint } from '../desktop/GameStreamHint';
import { useGatewayStore } from '../gateway/gateway-store';
import { channelPermissions } from '../guilds/permissions';
import { updateSettings, useKeybind, useSettingsStore } from '../settings/settings-store';
import { ScreenShareButton } from '../voice/components/ScreenShareButton';
import { leaveVoice, toggleCamera, toggleDeafen, toggleMute } from '../voice/voice-actions';
import { useVoiceStore } from '../voice/voice-store';
import { QuickAudio, type QuickAudioKind } from './QuickAudio';

const withKey = (text: string, binding: string | null) => (binding ? `${text} (${binding})` : text);

/**
 * Bottom of the channel column, the control panel of the app: the active voice connection
 * (status, channel, noise suppression, hang up, then camera and screen share side by side) and,
 * below it, the user with the microphone, headphones and settings buttons; the arrows next to
 * the first two open their quick settings; in the desktop app, its version closes the panel.
 * It stays put while the user browses other channels.
 */
const MODES: Array<{ mode: PresenceMode; label: string }> = [
  { mode: 'online', label: 'Disponível' },
  { mode: 'idle', label: 'Ausente' },
  { mode: 'dnd', label: 'Não perturbe' },
  { mode: 'invisible', label: 'Invisível' },
];

/** The narrow half of a split button: opens the quick settings of the toggle beside it. */
function QuickAudioArrow({
  label,
  open,
  onClick,
}: {
  label: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      className={cx(
        'pressable -ml-px inline-flex h-8 w-4 items-center justify-center border',
        open
          ? 'z-10 border-accent text-accent'
          : 'border-line-strong text-muted hover:z-10 hover:border-accent hover:text-accent',
      )}
      onClick={onClick}
    >
      <Icon name={open ? 'chevron-down' : 'chevron-up'} size={12} />
    </button>
  );
}

export function UserPanel({
  user,
  onOpenSettings,
}: {
  user: Self;
  onOpenSettings: (tab?: SettingsPage) => void;
}) {
  const status = useVoiceStore((state) => state.status);
  const channelId = useVoiceStore((state) => state.channelId);
  const channelName = useVoiceStore((state) => state.channelName);
  const muted = useVoiceStore((state) => state.muted);
  const deafened = useVoiceStore((state) => state.deafened);
  const micAvailable = useVoiceStore((state) => state.micAvailable);
  const camera = useVoiceStore((state) => state.camera);
  const screen = useVoiceStore((state) => state.screen);
  const [quick, setQuick] = useState<QuickAudioKind | null>(null);
  const userRow = useRef<HTMLDivElement>(null);
  useDismiss(
    userRow,
    quick !== null,
    useCallback(() => setQuick(null), []),
  );
  const rttMs = useVoiceStore((state) => state.stats.rttMs);
  const muteKey = useKeybind('mute');
  const deafenKey = useKeybind('deafen');
  const leaveKey = useKeybind('leave');
  const cameraKey = useKeybind('camera');
  const talkKey = useKeybind('pushToTalk');
  const pushToTalk = useSettingsStore((state) => state.inputMode === 'pushToTalk');
  const noiseSuppression = useSettingsStore((state) => state.noiseSuppression);
  const pttHeld = useVoiceStore((state) => state.pttHeld);
  // The voice channel may belong to a server other than the one on screen.
  const guild = useGatewayStore((state) =>
    Object.values(state.guilds).find((entry) =>
      entry.channels.some((channel) => channel.id === channelId),
    ),
  );
  const channel = guild?.channels.find((entry) => entry.id === channelId);
  const conversation = conversationOf(guild, user.id);

  const serverMuted =
    guild?.members.find((member) => member.user.id === user.id)?.serverMuted ?? false;

  const inVoice = status === 'connected' || status === 'reconnecting' || status === 'connecting';
  const live = status === 'connected' || status === 'reconnecting';
  const canStream =
    guild && channel
      ? hasPermission(channelPermissions(guild, channel, user.id), Permissions.Stream)
      : false;

  return (
    <div className="shrink-0 border-t border-line bg-surface">
      {inVoice && (
        <div ref={ghostDown} className="anim-pop border-b border-line" data-testid="voice-panel">
          <div className="flex items-center gap-2 px-3 pt-2">
            <div className="min-w-0 flex-1">
              <p
                className={cx(
                  'label truncate',
                  status === 'connected' ? 'text-accent' : 'text-danger',
                )}
                // The delay is in the system bar too; here it would not fit beside the buttons.
                title={
                  status === 'connected' && rttMs !== null ? `Atraso de ${rttMs} ms` : undefined
                }
              >
                {status === 'connected'
                  ? 'VOZ CONECTADA'
                  : status === 'reconnecting'
                    ? 'RECONECTANDO'
                    : 'CONECTANDO VOZ'}
              </p>
              {guild && channel ? (
                <NavLink
                  to={`/app/${guild.id}/${channel.id}`}
                  title="Voltar para o canal de voz"
                  className="label block truncate text-muted transition-colors hover:text-accent"
                >
                  {conversation
                    ? `CHAMADA COM ${conversation.friend.user.displayName}`
                    : `${channel.name} / ${guild.name}`}
                </NavLink>
              ) : (
                <p className="label truncate text-muted">{channelName}</p>
              )}
            </div>
            {live && (
              <IconButton
                icon={noiseSuppression ? 'noise' : 'noise-off'}
                tone={noiseSuppression ? 'active' : 'default'}
                label={
                  noiseSuppression ? 'Desligar supressão de ruído' : 'Ligar supressão de ruído'
                }
                aria-pressed={noiseSuppression}
                data-testid="noise-toggle"
                onClick={() => updateSettings({ noiseSuppression: !noiseSuppression })}
              />
            )}
            <IconButton
              icon="hang-up"
              tone="danger"
              label="Desligar voz"
              title={withKey('Desligar voz', leaveKey)}
              onClick={leaveVoice}
            />
          </div>
          <div className="px-3 py-2">
            {live && (
              // Two cells of the same width, whatever is live.
              <div className="grid grid-cols-2 gap-1.5">
                <IconButton
                  icon={camera.status === 'live' ? 'camera' : 'camera-off'}
                  tone={camera.status === 'live' ? 'active' : 'default'}
                  label={camera.status === 'live' ? 'Desligar câmera' : 'Ligar câmera'}
                  title={
                    canStream
                      ? withKey(
                          camera.status === 'live' ? 'Desligar câmera' : 'Ligar câmera',
                          cameraKey,
                        )
                      : 'Você não tem permissão para ligar a câmera neste canal'
                  }
                  aria-pressed={camera.status === 'live'}
                  disabled={!canStream || status !== 'connected' || camera.status === 'starting'}
                  className="w-full"
                  onClick={toggleCamera}
                />
                <ScreenShareButton allowed={canStream} tile />
              </div>
            )}
            {live && canStream && screen.status === 'off' && <GameStreamHint />}
            {screen.status === 'live' && !screen.hasAudio && (
              <p role="status" className="label mt-1.5 text-danger" data-testid="screen-no-audio">
                TRANSMISSÃO SEM ÁUDIO DO SISTEMA
              </p>
            )}
            {screen.status === 'live' && screen.audioSource !== null && (
              <p
                role="status"
                className="label mt-1.5 truncate text-muted"
                data-testid="screen-audio-source"
                title="O que vai como som da transmissão"
              >
                SOM: {screen.audioSource}
              </p>
            )}
            {screen.status === 'live' && screen.echoRisk && (
              <p role="status" className="label mt-1.5 text-danger" data-testid="screen-echo-risk">
                QUEM ASSISTE PODE OUVIR A PRÓPRIA VOZ — TRANSMITA UMA ABA EM VEZ DA TELA INTEIRA
              </p>
            )}
            {screen.voiceChatRisk && !screen.echoRisk && (
              <p
                role="status"
                className="label mt-1.5 text-danger"
                data-testid="screen-voice-chat-risk"
              >
                {desktop
                  ? 'O SOM DO PC INTEIRO VAI JUNTO, COM AS VOZES DO DISCORD'
                  : 'O SOM DO PC INTEIRO VAI JUNTO, COM AS VOZES DO DISCORD — PELO APP, SÓ O JOGO VAI'}
              </p>
            )}
            {(camera.error ?? screen.error) && (
              <p role="alert" className="label mt-1.5 text-danger">
                {camera.error ?? screen.error}
              </p>
            )}
            {live && pushToTalk && micAvailable && !muted && (
              <p
                role="status"
                data-testid="ptt-status"
                className={`label mt-1.5 ${pttHeld ? 'text-accent' : talkKey ? 'text-muted' : 'text-danger'}`}
              >
                {pttHeld
                  ? 'TRANSMITINDO'
                  : talkKey
                    ? `SEGURE ${talkKey} PARA FALAR`
                    : 'APERTAR PARA FALAR SEM TECLA — DEFINA EM CONFIGURAÇÕES'}
              </p>
            )}
            {!micAvailable && (
              <p role="status" className="label mt-1.5 text-danger" data-testid="mic-status">
                {serverMuted ? 'MUTADO NO SERVIDOR — ' : 'SEM MICROFONE — '}SOMENTE ESCUTA
              </p>
            )}
          </div>
        </div>
      )}
      <div ref={userRow} className="relative flex items-center gap-1 px-3 py-2">
        <button
          type="button"
          data-testid="self-status"
          title="Mudar seu status ou editar o perfil"
          aria-label={`${user.displayName}: mudar status ou editar perfil`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            openContextMenu({ x: box.left, y: box.top - 250 }, 'SEU STATUS', [
              ...MODES.map(({ mode, label }) => ({
                label,
                hint: user.presence === mode ? 'ATUAL' : undefined,
                onSelect: () => attempt(() => profileApi.update({ presence: mode })),
              })),
              { type: 'separator' as const },
              { label: 'Editar perfil', onSelect: () => onOpenSettings('profile') },
            ]);
          }}
        >
          <span className="relative shrink-0">
            <Avatar name={user.displayName} picture={user.avatar} size={32} />
            <StatusMark
              presence={user.presence === 'invisible' ? 'offline' : user.presence}
              className="absolute -right-0.5 -bottom-0.5"
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="label-lg block truncate text-fg">{user.displayName}</span>
            <span className="label block truncate text-muted normal-case">
              {user.customStatus ?? `@${user.username}`}
            </span>
          </span>
        </button>
        {/* Each toggle shares a border with the arrow that opens its quick settings. */}
        <span className="flex shrink-0">
          <IconButton
            icon={muted ? 'mic-off' : 'mic'}
            tone={muted ? 'danger' : 'default'}
            label={muted ? 'Ativar microfone' : 'Mutar microfone'}
            title={
              inVoice
                ? withKey(muted ? 'Ativar microfone' : 'Mutar microfone', muteKey)
                : 'Entre em um canal de voz para usar o microfone'
            }
            aria-pressed={muted}
            disabled={!inVoice}
            onClick={toggleMute}
          />
          <QuickAudioArrow
            label="Opções de entrada"
            open={quick === 'input'}
            onClick={() => setQuick(quick === 'input' ? null : 'input')}
          />
        </span>
        <span className="flex shrink-0">
          <IconButton
            icon={deafened ? 'headphones-off' : 'headphones'}
            tone={deafened ? 'danger' : 'default'}
            label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
            title={
              inVoice
                ? withKey(deafened ? 'Ativar áudio' : 'Ensurdecer', deafenKey)
                : 'Entre em um canal de voz para usar o áudio'
            }
            aria-pressed={deafened}
            disabled={!inVoice}
            onClick={toggleDeafen}
          />
          <QuickAudioArrow
            label="Opções de saída"
            open={quick === 'output'}
            onClick={() => setQuick(quick === 'output' ? null : 'output')}
          />
        </span>
        <IconButton icon="settings" label="Configurações" onClick={() => onOpenSettings()} />
        {quick && (
          <QuickAudio
            kind={quick}
            onOpenSettings={() => {
              setQuick(null);
              onOpenSettings('voice');
            }}
          />
        )}
      </div>
      {desktop && (
        // Which build is running, where the rest of the system data sits.
        <p className="label border-t border-line px-3 py-1 text-muted" data-testid="app-version">
          DISPEAKER V{desktop.version}
        </p>
      )}
    </div>
  );
}
