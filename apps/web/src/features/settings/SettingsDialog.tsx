import {
  PERSON_DEFAULTS,
  type DesktopStartAtLogin,
  type Guild,
  type Self,
} from '@frequencia/shared';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/Button';
import { attempt } from '../../components/Toast';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '../../components/Dialog';
import { Loading } from '../../components/Loading';
import {
  normalizeSearch,
  SettingsSection,
  SettingsShell,
  type ShellPage,
  type ShellSearchResult,
} from '../../components/SettingsShell';
import { cx } from '../../lib/cx';
import {
  canCloseToTray,
  desktop,
  useNativeCaptureCodec,
  useRefusedShortcuts,
} from '../desktop/desktop';
import { BLOCKS_KEY, conversationsApi } from '../friends/conversations-api';
import { useGatewayStore } from '../gateway/gateway-store';
import { SOUND_EVENTS } from '../sounds/sound-events';
import type { NoiseEngine } from '../voice/microphone';
import { SCREEN_PRESET_LIST } from '../voice/screen-presets';
import { useVoiceStore } from '../voice/voice-store';
import { changeAccountSettings, useAccountSettings } from './account-settings';
import { DeviceSelect, supportsOutputSelection, useAudioDevices } from './audio-devices';
import { KeybindRow, OptionGroup, Slider, SoundRow, Toggle } from './controls';
import { bindingFromEvent, KEYBIND_ACTIONS, KEYBIND_LABELS, type KeybindAction } from './keybinds';
import { AddedGames, HiddenGames, PlayingNow } from './GamesSettings';
import { VoiceLab } from '../voice-lab/VoiceLab';
import { HearMyself } from './HearMyself';
import { MicTest } from './MicTest';
import { PasswordForm, ProfileTab } from './ProfileTab';
import {
  resetKeybinds,
  setKeybind,
  updateSettings,
  useSettingsStore,
  type InputMode,
} from './settings-store';

export type SettingsPage =
  | 'account'
  | 'profile'
  | 'privacy'
  | 'voice'
  | 'video'
  | 'streams'
  | 'chat'
  | 'notifications'
  | 'keys'
  | 'app'
  | 'games';

const INPUT_OPTIONS: Array<{ value: InputMode; label: string; hint: string }> = [
  {
    value: 'voice',
    label: 'MICROFONE ABERTO',
    hint: 'Transmite sempre que você não estiver mutado.',
  },
  {
    value: 'pushToTalk',
    label: 'APERTAR PARA FALAR',
    hint: 'O microfone só abre enquanto você segura uma tecla.',
  },
];

const NOISE_NAMES: Record<NoiseEngine, string> = {
  gtcrn: 'GTCRN',
  rnnoise: 'RNNOISE',
  browser: 'NAVEGADOR',
  off: 'DESLIGADA',
};

/** Phones and tablets: there is no keyboard to bind shortcuts to. */
const touchOnly =
  typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

/** The shortcut being recorded, shared by the pages that show shortcuts. */
const CaptureContext = createContext<{
  capturing: KeybindAction | null;
  setCapturing: (action: KeybindAction | null) => void;
}>({ capturing: null, setCapturing: () => undefined });

function Shortcut({ action }: { action: KeybindAction }) {
  const { capturing, setCapturing } = useContext(CaptureContext);
  return <KeybindRow action={action} capturing={capturing === action} onCapture={setCapturing} />;
}

// --- sections -------------------------------------------------------------------------------

function useDevices() {
  const voiceStatus = useVoiceStore((state) => state.status);
  const micAvailable = useVoiceStore((state) => state.micAvailable);
  const cameraStatus = useVoiceStore((state) => state.camera.status);
  return useAudioDevices(`${voiceStatus}:${micAvailable}:${cameraStatus}`);
}

function VoiceInput() {
  const settings = useSettingsStore();
  const devices = useDevices();
  const namesHidden = devices.inputs.length > 0 && devices.inputs.every((device) => !device.label);
  return (
    <>
      <DeviceSelect
        label="MICROFONE"
        hint={
          namesHidden
            ? 'Entre em um canal de voz e permita o microfone para ver os nomes dos dispositivos.'
            : undefined
        }
        value={settings.inputDeviceId}
        devices={devices.inputs}
        onChange={(inputDeviceId) => updateSettings({ inputDeviceId })}
      />
      {!touchOnly && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="label mb-1.5 text-muted">MODO DE ENTRADA</legend>
          <OptionGroup
            label="Modo de entrada"
            name="input-mode"
            value={settings.inputMode}
            options={INPUT_OPTIONS}
            onChange={(inputMode) => updateSettings({ inputMode })}
          />
          {settings.inputMode === 'pushToTalk' && (
            <>
              <ul>
                <Shortcut action="pushToTalk" />
              </ul>
              <p
                className={cx(
                  'text-xs',
                  settings.keybinds.pushToTalk ? 'text-muted' : 'text-danger',
                )}
              >
                {settings.keybinds.pushToTalk
                  ? 'Funciona com o Dispeaker em foco. Uma tecla que também escreve (uma letra, o espaço) não abre o microfone enquanto você digita no chat.'
                  : 'Escolha a tecla: sem ela, ninguém ouve você neste modo.'}
              </p>
            </>
          )}
        </fieldset>
      )}
      <Slider
        label="VOLUME DO SEU MICROFONE"
        hint="É o volume com que os outros ouvem você. Aumente se disserem que você está baixo."
        value={settings.micGain}
        min={0.5}
        max={2}
        onChange={(micGain) => updateSettings({ micGain })}
      />
      <MicTest />
      <HearMyself />
    </>
  );
}

function VoiceProcessing() {
  const settings = useSettingsStore();
  const activeNoise = useVoiceStore((state) => state.noiseSuppression);
  // Anything but the first-choice model means that one could not run here.
  const fellBack = settings.noiseSuppression && activeNoise !== null && activeNoise !== 'gtcrn';
  return (
    <>
      <Toggle
        label="SUPRESSÃO DE RUÍDO"
        hint="Uma rede neural isola a sua voz e corta teclado, cliques, ventilador e vento. Também liga e desliga pelo botão ao lado de desligar, durante a chamada."
        checked={settings.noiseSuppression}
        onChange={(noiseSuppression) => updateSettings({ noiseSuppression })}
      />
      {activeNoise && (
        <p
          className={cx('label', fellBack ? 'text-danger' : 'text-muted')}
          data-testid="noise-active"
        >
          {fellBack
            ? `INDISPONÍVEL AQUI — EM USO: ${NOISE_NAMES[activeNoise]}`
            : `EM USO AGORA: ${NOISE_NAMES[activeNoise]}`}
        </p>
      )}
      <Toggle
        label="NIVELAR E REFORÇAR A VOZ"
        hint="Deixa a voz em um volume firme e mais alto para quem ouve, sem estourar quando você fala alto."
        checked={settings.voiceLeveler}
        onChange={(voiceLeveler) => updateSettings({ voiceLeveler })}
      />
      <Toggle
        label="CANCELAMENTO DE ECO"
        hint="Impede que o som das suas caixas volte pelo microfone."
        checked={settings.echoCancellation}
        onChange={(echoCancellation) => updateSettings({ echoCancellation })}
      />
      <Toggle
        label="GANHO AUTOMÁTICO"
        hint="Nivela o volume da sua voz."
        checked={settings.autoGainControl}
        onChange={(autoGainControl) => updateSettings({ autoGainControl })}
      />
    </>
  );
}

function VoiceOutput() {
  const settings = useSettingsStore();
  const devices = useDevices();
  return (
    <>
      {supportsOutputSelection ? (
        <DeviceSelect
          label="FONE / CAIXAS"
          value={settings.outputDeviceId}
          devices={devices.outputs}
          onChange={(outputDeviceId) => updateSettings({ outputDeviceId })}
        />
      ) : (
        <p className="text-sm text-muted">
          Este navegador não permite escolher a saída: o som sai pelo dispositivo padrão do sistema.
        </p>
      )}
      <Slider
        label="VOLUME GERAL"
        hint="Tudo o que você ouve numa chamada: vozes e o som das transmissões."
        value={settings.outputVolume}
        onChange={(outputVolume) => updateSettings({ outputVolume })}
      />
    </>
  );
}

/** Display name of a user, from any server or conversation they share with this user. */
function useNameOf(): (userId: string) => string {
  const guilds = useGatewayStore((state) => state.guilds);
  return (userId) => {
    for (const guild of Object.values(guilds)) {
      const member = guild.members.find((entry) => entry.user.id === userId);
      if (member) return member.nickname ?? member.user.displayName;
    }
    return 'Alguém fora dos seus servidores';
  };
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Everyone this user turned down or muted, with a way back to normal. */
function People() {
  const people = useAccountSettings((settings) => settings.people);
  const nameOf = useNameOf();
  const entries = Object.entries(people)
    .map(([userId, stored]) => ({ userId, name: nameOf(userId), ...PERSON_DEFAULTS, ...stored }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return (
    <>
      <p className="text-xs text-muted">
        Clique com o botão direito em alguém (ou na transmissão da pessoa) para mudar o volume ou
        mutar só para você. Fica valendo em todos os servidores e em todos os seus aparelhos.
      </p>
      {entries.length === 0 ? (
        <p className="label text-muted">NINGUÉM AJUSTADO</p>
      ) : (
        <ul className="flex flex-col border border-line" data-testid="people-preferences">
          {entries.map((entry) => {
            const voice = entry.voiceMuted ? 'VOZ MUTADA' : `VOZ ${percent(entry.voiceVolume)}`;
            const stream = entry.streamMuted
              ? 'TRANSMISSÃO MUTADA'
              : `TRANSMISSÃO ${percent(entry.streamVolume)}`;
            return (
              <li
                key={entry.userId}
                className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-fg">{entry.name}</span>
                  <span className="label block truncate text-muted">
                    {voice} · {stream}
                  </span>
                </span>
                <Button
                  aria-label={`Redefinir ${entry.name}`}
                  onClick={() => changeAccountSettings({ people: { [entry.userId]: null } })}
                >
                  REDEFINIR
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Camera() {
  const settings = useSettingsStore();
  const devices = useDevices();
  return (
    <DeviceSelect
      label="CÂMERA"
      hint="Os nomes aparecem depois que você liga a câmera uma vez e permite o acesso."
      value={settings.cameraDeviceId}
      devices={devices.cameras}
      onChange={(cameraDeviceId) => updateSettings({ cameraDeviceId })}
    />
  );
}

function StreamQuality() {
  const preset = useSettingsStore((state) => state.sharePreset);
  return (
    <>
      <OptionGroup
        label="Qualidade padrão"
        name="share-preset"
        value={preset}
        options={SCREEN_PRESET_LIST.map((entry) => ({
          value: entry.id,
          label: entry.label,
          hint: entry.hint,
        }))}
        onChange={(sharePreset) => updateSettings({ sharePreset })}
      />
      <p className="text-xs text-muted">
        É a que o atalho de transmitir usa. Ao clicar em TRANSMITIR você ainda escolhe outra.
      </p>
    </>
  );
}

/** The desktop app captures the screen itself instead of the browser; on unless turned off. */
function NativeCapture() {
  const enabled = useSettingsStore((state) => state.nativeCapture);
  const codec = useNativeCaptureCodec();
  return (
    <>
      <Toggle
        label="CAPTURA NATIVA"
        hint="O app captura e comprime a tela direto na placa de vídeo, sem passar pelo navegador: com jogo pesado, mantém os quadros que a captura comum perde. Vale para um monitor ou um jogo em tela cheia; outras janelas seguem pela captura comum."
        checked={enabled}
        onChange={(nativeCapture) => updateSettings({ nativeCapture })}
      />
      {codec !== undefined && (
        <p className="label text-muted" data-testid="native-capture-status">
          {codec
            ? `DISPONÍVEL NESTE PC: ${codec.toUpperCase()}`
            : 'INDISPONÍVEL NESTE PC: PRECISA DE PLACA AMD OU NVIDIA'}
        </p>
      )}
    </>
  );
}

function StreamReports() {
  return (
    <>
      <p className="text-sm text-muted">
        Cada transmissão é medida em quem transmite, no servidor e em quem assiste, para mostrar
        onde os quadros se perdem e quanto da placa de vídeo ela usa. Você vê as suas e as dos
        servidores que são seus.
      </p>
      <Link
        to="/transmissoes"
        className="label self-start text-fg transition-colors hover:text-accent"
      >
        [ VER TRANSMISSÕES MEDIDAS ]
      </Link>
    </>
  );
}

function ChatMessages() {
  const showEmbeds = useAccountSettings((account) => account.showEmbeds);
  return (
    <Toggle
      label="MOSTRAR PRÉVIAS E IMAGENS DE LINKS"
      hint="GIFs e imagens de links aparecem na conversa. Elas vêm direto do site de origem, que fica sabendo o seu endereço IP."
      checked={showEmbeds}
      onChange={(value) => changeAccountSettings({ showEmbeds: value })}
    />
  );
}

function SystemNotifications() {
  const enabled = useSettingsStore((state) => state.desktopNotifications);
  if (typeof Notification === 'undefined') {
    return (
      <p className="text-sm text-muted">
        Este navegador não mostra notificações do sistema. As menções continuam aparecendo na lista
        de canais e no título da janela.
      </p>
    );
  }
  const blocked = Notification.permission === 'denied';
  const toggle = async (next: boolean) => {
    if (next && Notification.permission === 'default') {
      // The browser asks once; a refusal leaves the option off.
      if ((await Notification.requestPermission()) !== 'granted') return;
    }
    updateSettings({ desktopNotifications: next });
  };
  return (
    <>
      <Toggle
        label="NOTIFICAR MENÇÕES"
        hint="Aviso do sistema quando alguém menciona ou responde você e o Dispeaker não está em primeiro plano."
        checked={enabled && !blocked}
        onChange={(next) => void toggle(next)}
      />
      {blocked && (
        <p className="label text-danger">AS NOTIFICAÇÕES ESTÃO BLOQUEADAS PARA ESTE SITE</p>
      )}
    </>
  );
}

function Sounds() {
  const settings = useSettingsStore();
  return (
    <>
      <Toggle
        label="TOCAR SONS"
        hint="Avisos sonoros do canal de voz em que você está. Não tocam enquanto o áudio está desligado."
        checked={settings.soundsEnabled}
        onChange={(soundsEnabled) => updateSettings({ soundsEnabled })}
      />
      <Slider
        label="VOLUME DOS SONS"
        value={settings.soundVolume}
        onChange={(soundVolume) => updateSettings({ soundVolume })}
      />
      <ul className="flex flex-col gap-3">
        {SOUND_EVENTS.map((event) => (
          <SoundRow key={event} event={event} />
        ))}
      </ul>
      <p className="text-xs text-muted">
        Os arquivos escolhidos aqui ficam só neste aparelho. Quando o dono de um servidor define um
        som, é o dele que toca para todos naquele servidor.
      </p>
    </>
  );
}

function Shortcuts() {
  const { setCapturing } = useContext(CaptureContext);
  const refused = useRefusedShortcuts();
  if (touchOnly) {
    return (
      <p className="text-sm text-muted">
        Atalhos precisam de um teclado. Neste aparelho, use os botões de microfone e fone.
      </p>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-2">
        {KEYBIND_ACTIONS.map((action) => (
          <Shortcut key={action} action={action} />
        ))}
      </ul>
      <p className="text-xs text-muted">
        Nenhum atalho vem definido: clique em um e pressione a tecla (Esc cancela). Atalhos de uma
        tecla só não valem enquanto você digita; combine com Ctrl ou Alt para valerem sempre.
        “Apertar para falar” só vale com esse modo ligado em VOZ.
      </p>
      <p className="text-xs text-muted">
        {desktop
          ? 'No app, atalhos com Ctrl ou Alt e as teclas F1 a F24 funcionam também com um jogo em foco, para mutar, ensurdecer, transmitir, câmera e desligar. Os demais valem com a janela do Dispeaker em foco.'
          : 'No navegador, funcionam com esta aba em foco. No app de desktop, atalhos com Ctrl ou Alt funcionam também com um jogo em foco.'}
      </p>
      {refused.length > 0 && (
        <p className="text-xs text-danger" data-testid="refused-shortcuts">
          Outro programa já usa:{' '}
          {refused.map((action) => KEYBIND_LABELS[action as KeybindAction] ?? action).join(', ')}.
          Escolha outra combinação.
        </p>
      )}
      <Button
        className="self-start"
        onClick={() => {
          setCapturing(null);
          resetKeybinds();
        }}
      >
        REMOVER TODOS
      </Button>
    </>
  );
}

function AppWindow() {
  const closeToTray = useSettingsStore((state) => state.closeToTray);
  return (
    <>
      <StartAtLogin />
      <Toggle
        label="O BOTÃO X MINIMIZA PARA A BANDEJA"
        hint="Fechar a janela esconde o Dispeaker nos ícones ao lado do relógio em vez de sair: a chamada continua e os atalhos seguem valendo. O ícone acende enquanto ouvem você; clique nele para voltar, ou com o botão direito para mutar, ensurdecer ou sair."
        checked={closeToTray}
        onChange={(value) => updateSettings({ closeToTray: value })}
      />
    </>
  );
}

/** Kept by Windows, not by the page: asked when shown, so a change made there shows here. */
function StartAtLogin() {
  const bridge = desktop?.startAtLogin;
  const [state, setState] = useState<DesktopStartAtLogin | null>(null);
  useEffect(() => {
    let current = true;
    bridge?.get().then(
      (answer) => current && setState(answer),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [bridge]);
  if (!bridge || !state?.available) return null;
  return (
    <Toggle
      label="ABRIR O DISPEAKER AO LIGAR O COMPUTADOR"
      hint="Ele abre escondido nos ícones ao lado do relógio, e seus amigos veem que você está por aqui."
      checked={state.enabled}
      onChange={(value) => attempt(() => bridge.set(value).then(setState))}
    />
  );
}

function CornerNotices() {
  const notices = useSettingsStore((state) => state.cornerNotices);
  const change = (part: Partial<typeof notices>) =>
    updateSettings({ cornerNotices: { ...notices, ...part } });
  return (
    <>
      <p className="text-xs text-muted">
        Um aviso pequeno no canto de baixo da tela, por cima do jogo, some sozinho em alguns
        segundos. Clique nele para ir até a pessoa. Em “não perturbe”, nenhum aparece.
      </p>
      <Toggle
        label="QUANDO ALGUÉM ABRE O DISPEAKER"
        checked={notices.online}
        onChange={(value) => change({ online: value })}
      />
      <Toggle
        label="QUANDO ALGUÉM ENTRA NUMA CHAMADA OU TRANSMITE"
        hint="Só enquanto você não está em nenhuma chamada. O aviso tem o botão para entrar."
        checked={notices.calls}
        onChange={(value) => change({ calls: value })}
      />
    </>
  );
}

function AppAbout() {
  return (
    <p className="label text-muted" data-testid="desktop-version">
      VERSÃO DO APP: {desktop?.version ?? '—'}
    </p>
  );
}

function DirectMessages() {
  const privateProfile = useAccountSettings((account) => account.privateProfile);
  return (
    <Toggle
      label="PERFIL PRIVADO"
      hint="Só seus amigos podem começar uma conversa com você. Desligado, quem divide um servidor com você também pode: a primeira mensagem chega como pedido, que você aceita ou recusa."
      checked={privateProfile}
      onChange={(value) => changeAccountSettings({ privateProfile: value })}
    />
  );
}

function ActivitySharing() {
  const shareActivity = useAccountSettings((account) => account.shareActivity);
  return (
    <Toggle
      label="MOSTRAR O QUE ESTOU JOGANDO"
      hint="Quem divide um servidor ou uma conversa com você vê o jogo aberto (JOGANDO ELDEN RING) no seu nome e no seu perfil. Só no app de desktop, que é quem reconhece os jogos."
      checked={shareActivity}
      onChange={(value) => changeAccountSettings({ shareActivity: value })}
    />
  );
}

function BlockedPeople() {
  const { data: blocked, isPending } = useQuery({
    queryKey: BLOCKS_KEY,
    queryFn: conversationsApi.blocks,
  });
  if (isPending) return <Loading label="CARREGANDO" />;
  return (
    <>
      <p className="text-xs text-muted">
        Quem você bloqueia não manda mensagem nem liga para você, e você também não. As mensagens
        dessas pessoas nos servidores ficam escondidas. Para bloquear alguém, clique com o botão
        direito no nome da pessoa.
      </p>
      {!blocked || blocked.length === 0 ? (
        <p className="label text-muted">NINGUÉM BLOQUEADO</p>
      ) : (
        <ul className="flex flex-col border border-line" data-testid="blocked-people">
          {blocked.map((person) => (
            <li
              key={person.id}
              className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-fg">{person.displayName}</span>
                <span className="label block truncate text-muted normal-case">
                  @{person.username}
                </span>
              </span>
              <Button
                aria-label={`Desbloquear ${person.displayName}`}
                onClick={() => attempt(() => conversationsApi.unblock(person.id))}
              >
                DESBLOQUEAR
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AccountIdentity({ user, onEditProfile }: { user: Self; onEditProfile: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="label-lg truncate text-fg">{user.displayName}</p>
        <p className="label truncate text-muted">@{user.username}</p>
      </div>
      <Button onClick={onEditProfile}>EDITAR PERFIL</Button>
    </div>
  );
}

// --- the index ------------------------------------------------------------------------------

interface SectionEntry {
  id: string;
  title: string;
  scope?: 'account' | 'device';
  /** Words people may look for, besides the title. */
  keywords: string;
  render: () => ReactNode;
}

interface PageEntry extends ShellPage<SettingsPage> {
  sections: SectionEntry[];
  /** A page laid out on its own (the profile, beside its preview); `sections` still feed the search. */
  body?: () => ReactNode;
}

interface PageContext {
  user: Self;
  guild?: Guild;
  onSignOut: () => void;
  goTo: (page: SettingsPage) => void;
}

function buildPages({ user, guild, onSignOut, goTo }: PageContext): PageEntry[] {
  const pages: Array<PageEntry | false> = [
    {
      id: 'account',
      label: 'MINHA CONTA',
      group: 'CONTA',
      sections: [
        {
          id: 'identity',
          title: 'IDENTIDADE',
          keywords: 'nome usuário username',
          render: () => <AccountIdentity user={user} onEditProfile={() => goTo('profile')} />,
        },
        {
          id: 'password',
          title: 'SENHA',
          keywords: 'trocar senha segurança',
          render: () => <PasswordForm onChanged={onSignOut} />,
        },
        {
          id: 'session',
          title: 'SESSÃO',
          keywords: 'sair desconectar logout',
          render: () => (
            <Button variant="danger" className="self-start" onClick={onSignOut}>
              SAIR DA CONTA
            </Button>
          ),
        },
      ],
    },
    {
      id: 'profile',
      label: 'PERFIL',
      group: 'CONTA',
      body: () => <ProfileTab key={user.id} user={user} guild={guild} />,
      sections: [
        {
          id: 'images',
          title: 'IMAGENS',
          keywords: 'foto avatar banner capa cor',
          render: () => null,
        },
        {
          id: 'notices',
          title: 'AVISOS NO CANTO DA TELA',
          scope: 'device',
          keywords: 'notificação aviso steam online entrou chamada transmissão',
          render: () => <CornerNotices />,
        },
        {
          id: 'about',
          title: 'SOBRE VOCÊ',
          keywords: 'nome de exibição apelido status sobre mim',
          render: () => null,
        },
        {
          id: 'preview',
          title: 'PRÉVIA',
          keywords: 'cartão como os outros veem',
          render: () => null,
        },
      ],
    },
    {
      id: 'privacy',
      label: 'PRIVACIDADE',
      group: 'CONTA',
      sections: [
        {
          id: 'direct-messages',
          title: 'MENSAGENS DIRETAS',
          scope: 'account',
          keywords: 'perfil privado conversa pedido de mensagem quem pode',
          render: () => <DirectMessages />,
        },
        {
          id: 'activity',
          title: 'ATIVIDADE',
          scope: 'account',
          keywords: 'jogando jogo status mostrar',
          render: () => <ActivitySharing />,
        },
        {
          id: 'blocked',
          title: 'PESSOAS BLOQUEADAS',
          scope: 'account',
          keywords: 'bloquear desbloquear',
          render: () => <BlockedPeople />,
        },
      ],
    },
    {
      id: 'voice',
      label: 'VOZ',
      group: 'APP',
      sections: [
        {
          id: 'input',
          title: 'ENTRADA',
          scope: 'device',
          keywords:
            'microfone dispositivo apertar para falar push to talk teste volume ouvir minha voz como me ouvem',
          render: () => <VoiceInput />,
        },
        {
          id: 'processing',
          title: 'PROCESSAMENTO DA VOZ',
          scope: 'device',
          keywords: 'supressão ruído eco ganho nivelar reforçar',
          render: () => <VoiceProcessing />,
        },
        {
          id: 'voice-lab',
          title: 'TESTE ÀS CEGAS DA VOZ',
          scope: 'device',
          keywords: 'teste voz qualidade abafada comparar gravar deepfilternet',
          render: () => <VoiceLab />,
        },
        {
          id: 'output',
          title: 'SAÍDA',
          scope: 'device',
          keywords: 'fone caixas alto-falante volume geral',
          render: () => <VoiceOutput />,
        },
        {
          id: 'people',
          title: 'PESSOAS',
          scope: 'account',
          keywords: 'volume de cada pessoa mutar silenciar redefinir transmissão',
          render: () => <People />,
        },
      ],
    },
    {
      id: 'video',
      label: 'VÍDEO',
      group: 'APP',
      sections: [
        {
          id: 'camera',
          title: 'CÂMERA',
          scope: 'device',
          keywords: 'webcam',
          render: () => <Camera />,
        },
      ],
    },
    {
      id: 'streams',
      label: 'TRANSMISSÕES',
      group: 'APP',
      sections: [
        {
          id: 'quality',
          title: 'QUALIDADE PADRÃO',
          scope: 'device',
          keywords: 'resolução fps 720p 1080p 1440p preset',
          render: () => <StreamQuality />,
        },
        ...(desktop?.nativeCapture
          ? [
              {
                id: 'capture',
                title: 'CAPTURA',
                scope: 'device' as const,
                keywords: 'nativa placa de vídeo jogo',
                render: () => <NativeCapture />,
              },
            ]
          : []),
        {
          id: 'reports',
          title: 'MEDIÇÕES',
          keywords: 'telemetria quadros gpu desempenho',
          render: () => <StreamReports />,
        },
      ],
    },
    {
      id: 'chat',
      label: 'CHAT',
      group: 'APP',
      sections: [
        {
          id: 'messages',
          title: 'MENSAGENS',
          scope: 'account',
          keywords: 'prévias links imagens gifs embeds',
          render: () => <ChatMessages />,
        },
      ],
    },
    {
      id: 'notifications',
      label: 'NOTIFICAÇÕES',
      group: 'APP',
      sections: [
        {
          id: 'system',
          title: 'AVISOS DO SISTEMA',
          scope: 'device',
          keywords: 'menções notificar',
          render: () => <SystemNotifications />,
        },
        {
          id: 'sounds',
          title: 'SONS',
          scope: 'device',
          keywords: 'entrada saída transmissão arquivo volume',
          render: () => <Sounds />,
        },
      ],
    },
    {
      id: 'keys',
      label: 'ATALHOS',
      group: 'APP',
      sections: [
        {
          id: 'shortcuts',
          title: 'ATALHOS DE TECLADO',
          scope: 'device',
          keywords: 'teclas mutar ensurdecer transmitir tela cheia',
          render: () => <Shortcuts />,
        },
      ],
    },
    // Only in the desktop app, which can see the programs running.
    Boolean(desktop?.games) && {
      id: 'games',
      label: 'JOGOS',
      group: 'ATIVIDADE',
      sections: [
        {
          id: 'playing',
          title: 'JOGANDO AGORA',
          keywords: 'jogo detectado reconhecido steam epic xbox',
          render: () => <PlayingNow />,
        },
        {
          id: 'added',
          title: 'JOGOS ADICIONADOS',
          scope: 'account',
          keywords: 'adicionar programa jogo não reconhecido',
          render: () => <AddedGames />,
        },
        {
          id: 'hidden',
          title: 'NÃO SÃO JOGOS',
          scope: 'account',
          keywords: 'esconder ignorar',
          render: () => <HiddenGames />,
        },
      ],
    },
    // Only inside the desktop app: a browser tab has nothing of the kind to offer.
    canCloseToTray && {
      id: 'app',
      label: 'WINDOWS',
      group: 'APP',
      sections: [
        {
          id: 'window',
          title: 'JANELA',
          scope: 'device',
          keywords: 'bandeja fechar minimizar ícone iniciar ligar computador windows',
          render: () => <AppWindow />,
        },
        {
          id: 'about',
          title: 'SOBRE',
          keywords: 'versão atualização',
          render: () => <AppAbout />,
        },
      ],
    },
  ];
  return pages.filter((entry): entry is PageEntry => entry !== false);
}

/** The user's own settings: a large box over the app, closed by clicking outside or on X. */
export function SettingsDialog({
  user,
  guild,
  initialPage = 'voice',
  onSignOut,
  onClose,
}: {
  user: Self;
  /** The server on screen, for the nickname the user has in it. */
  guild?: Guild;
  initialPage?: SettingsPage;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [capturing, setCapturing] = useState<KeybindAction | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    // Capture phase, so the key neither closes the dialog nor triggers the shortcut it replaces.
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      setKeybind(capturing, binding);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing]);

  // A search result opens its page and scrolls to the section once it is on screen.
  useEffect(() => {
    if (!target) return;
    const element = document.getElementById(`settings-${target}`);
    element?.scrollIntoView({ block: 'start' });
    element?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true });
    setTarget(null);
  }, [target, page]);

  const goTo = (next: SettingsPage) => {
    setCapturing(null);
    setPage(next);
  };
  const pages = buildPages({ user, guild, onSignOut, goTo });
  const current = pages.find((entry) => entry.id === page) ?? pages[0];

  const search = (query: string): Array<ShellSearchResult<SettingsPage>> => {
    const words = normalizeSearch(query).split(/\s+/).filter(Boolean);
    return pages.flatMap((entry) =>
      entry.sections
        .filter((section) => {
          const haystack = normalizeSearch(`${entry.label} ${section.title} ${section.keywords}`);
          return words.every((word) => haystack.includes(word));
        })
        .map((section) => ({
          page: entry.id,
          section: section.id,
          label: `${entry.label} · ${section.title}`,
        })),
    );
  };

  return (
    <Dialog settings title="Configurações" onClose={onClose}>
      <CaptureContext.Provider value={{ capturing, setCapturing }}>
        <SettingsShell
          title="CONFIGURAÇÕES"
          pages={pages}
          page={current?.id ?? page}
          onPage={goTo}
          search={search}
          onSearchResult={(result) => {
            goTo(result.page);
            setTarget(result.section);
          }}
          indexFooter={
            <div className="flex items-center justify-between gap-2">
              <span className="label truncate text-muted">
                {desktop ? `APP ${desktop.version}` : 'NAVEGADOR'}
              </span>
              <Button variant="danger" onClick={onSignOut}>
                SAIR
              </Button>
            </div>
          }
        >
          {current?.body?.() ??
            current?.sections.map((section, index) => (
              <SettingsSection
                key={section.id}
                id={`settings-${section.id}`}
                number={String(index + 1).padStart(2, '0')}
                title={section.title}
                scope={section.scope}
              >
                {section.render()}
              </SettingsSection>
            ))}
        </SettingsShell>
      </CaptureContext.Provider>
    </Dialog>
  );
}
