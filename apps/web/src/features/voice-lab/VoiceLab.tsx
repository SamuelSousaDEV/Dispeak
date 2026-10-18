import { VOICE_LAB_VARIANTS, type VoiceLabVariant } from '@frequencia/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Loading } from '../../components/Loading';
import { describeError } from '../../lib/http';
import { desktop } from '../desktop/desktop';
import { useSettingsStore } from '../settings/settings-store';
import { LevelBar } from '../voice/components/MicMeter';
import { recordMicrophone, type LabRecording } from './record';
import { loadDeepFilter, measureLevels, renderVariant, toWav } from './render';
import { voiceLabApi } from './voice-lab-api';

const SECONDS = 12;
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

/** Said after the vote, never before. */
const NAMES: Record<VoiceLabVariant, string> = {
  current: 'A DE HOJE NO DISPEAKER',
  deepfilter: 'DEEPFILTERNET 3',
  deepfilterLeveled: 'DEEPFILTERNET 3 + NIVELADOR',
  rnnoise: 'RNNOISE',
  raw: 'MICROFONE SEM TRATAMENTO',
};

interface Version {
  variant: VoiceLabVariant;
  url: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'recording'; elapsed: number }
  | { kind: 'processing'; label: string }
  | { kind: 'listening'; versions: Version[]; recording: LabRecording }
  | { kind: 'sent'; versions: Version[]; best: VoiceLabVariant; worst: VoiceLabVariant }
  | { kind: 'error'; message: string };

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/**
 * The blind voice test: the user records a sentence once and hears it through each version
 * of the voice chain, without knowing which is which (and all at the same loudness, so none
 * wins by being louder). The verdict goes to the server; the recording only when allowed.
 */
export function VoiceLab() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [level, setLevel] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const versionsRef = useRef<Version[]>([]);

  // Leaving the settings stops the microphone and frees the recordings.
  useEffect(
    () => () => {
      abort.current?.abort();
      for (const version of versionsRef.current) URL.revokeObjectURL(version.url);
    },
    [],
  );

  const start = async () => {
    const settings = useSettingsStore.getState();
    const controller = new AbortController();
    abort.current = controller;
    for (const version of versionsRef.current) URL.revokeObjectURL(version.url);
    versionsRef.current = [];
    // The big model downloads while the user speaks.
    const filterReady = loadDeepFilter();
    filterReady.catch(() => undefined);
    setPhase({ kind: 'recording', elapsed: 0 });
    const began = performance.now();
    const clock = window.setInterval(
      () => setPhase({ kind: 'recording', elapsed: (performance.now() - began) / 1000 }),
      250,
    );
    try {
      const recording = await recordMicrophone(settings, SECONDS, setLevel, controller.signal);
      window.clearInterval(clock);
      setPhase({ kind: 'processing', label: 'CARREGANDO O DEEPFILTERNET (34 MB NA PRIMEIRA VEZ)' });
      await filterReady;
      const versions: Version[] = [];
      for (const [index, variant] of shuffled(VOICE_LAB_VARIANTS).entries()) {
        setPhase({ kind: 'processing', label: `PREPARANDO AS VERSÕES (${index + 1}/5)` });
        const samples = await renderVariant(variant, recording, settings);
        versions.push({ variant, url: URL.createObjectURL(toWav(samples)) });
      }
      versionsRef.current = versions;
      setPhase({ kind: 'listening', versions, recording });
    } catch (error) {
      window.clearInterval(clock);
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn('[voice-lab] test failed', error);
      setPhase({
        kind: 'error',
        message:
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'O navegador não deixou usar o microfone.'
            : 'Não foi possível preparar o teste neste aparelho.',
      });
    } finally {
      setLevel(0);
    }
  };

  if (phase.kind === 'idle' || phase.kind === 'error') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Grave uma frase uma vez e ouça a mesma gravação de cinco jeitos diferentes, sem saber qual
          é qual. Diga qual soa melhor e qual soa pior: é assim que vamos escolher a voz do
          Dispeaker. Leva um minuto. Use o fone que você usa nas chamadas.
        </p>
        {phase.kind === 'error' && <p className="text-sm text-danger">{phase.message}</p>}
        <Button className="self-start" variant="primary" onClick={() => void start()}>
          GRAVAR {SECONDS} SEGUNDOS
        </Button>
      </div>
    );
  }

  if (phase.kind === 'recording') {
    return (
      <div className="flex flex-col gap-3">
        <p className="label text-accent">
          GRAVANDO · {Math.max(0, Math.ceil(SECONDS - phase.elapsed))} S
        </p>
        <p className="text-sm text-fg">
          Leia em voz alta, no seu tom de sempre: “O sabiá cantou na palmeira enquanto a chuva fina
          molhava a janela da cozinha. Fala, galera, bora jogar mais uma? Já tô entrando!”
        </p>
        <LevelBar level={level} segments={32} className="w-full" />
        <Button className="self-start" onClick={() => abort.current?.abort()}>
          CANCELAR
        </Button>
      </div>
    );
  }

  if (phase.kind === 'processing') return <Loading label={phase.label} />;

  if (phase.kind === 'sent') {
    return (
      <div className="flex flex-col gap-3">
        <p className="label text-accent">VOTO ENVIADO — OBRIGADO</p>
        <ul className="flex flex-col border border-line">
          {phase.versions.map((version, index) => (
            <li
              key={version.variant}
              className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <span className="label text-fg">
                {LETTERS[index]} · {NAMES[version.variant]}
              </span>
              <span className="label text-muted">
                {version.variant === phase.best
                  ? 'SUA MELHOR'
                  : version.variant === phase.worst
                    ? 'SUA PIOR'
                    : ''}
              </span>
            </li>
          ))}
        </ul>
        <Button className="self-start" onClick={() => setPhase({ kind: 'idle' })}>
          FAZER DE NOVO
        </Button>
      </div>
    );
  }

  return (
    <Verdict
      versions={phase.versions}
      recording={phase.recording}
      onSent={(best, worst) => setPhase({ kind: 'sent', versions: phase.versions, best, worst })}
      onRestart={() => setPhase({ kind: 'idle' })}
    />
  );
}

function Verdict({
  versions,
  recording,
  onSent,
  onRestart,
}: {
  versions: Version[];
  recording: LabRecording;
  onSent: (best: VoiceLabVariant, worst: VoiceLabVariant) => void;
  onRestart: () => void;
}) {
  const [playing, setPlaying] = useState<VoiceLabVariant | null>(null);
  const [heard, setHeard] = useState<Set<VoiceLabVariant>>(new Set());
  const [best, setBest] = useState<VoiceLabVariant | null>(null);
  const [worst, setWorst] = useState<VoiceLabVariant | null>(null);
  const [comment, setComment] = useState('');
  const [shareRecording, setShareRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audio.current?.pause(), []);

  const play = (version: Version) => {
    audio.current?.pause();
    if (playing === version.variant) {
      setPlaying(null);
      return;
    }
    const element = new Audio(version.url);
    const { outputDeviceId } = useSettingsStore.getState();
    if (outputDeviceId && typeof element.setSinkId === 'function') {
      void element.setSinkId(outputDeviceId).catch(() => undefined);
    }
    element.addEventListener('ended', () => setPlaying(null));
    audio.current = element;
    setPlaying(version.variant);
    setHeard((previous) => new Set(previous).add(version.variant));
    void element.play().catch(() => setPlaying(null));
  };

  const ready = best !== null && worst !== null && best !== worst && heard.size === versions.length;

  const send = async () => {
    if (!best || !worst) return;
    setBusy(true);
    setError(null);
    try {
      const levels = measureLevels(recording.raw);
      const { id } = await voiceLabApi.send({
        best,
        worst,
        order: versions.map((version) => version.variant),
        inputDevice: recording.device,
        appVersion: desktop?.version ?? null,
        ...levels,
        comment: comment.trim() || null,
      });
      if (shareRecording) await voiceLabApi.attachRecording(id, toWav(recording.raw));
      onSent(best, worst);
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Ouça todas, quantas vezes quiser, e marque a que soa mais natural e limpa (MELHOR) e a que
        soa pior: abafada, “trabalhada”, metálica ou com ruído.
      </p>
      <ul className="flex flex-col border border-line" data-testid="voice-lab-versions">
        {versions.map((version, index) => (
          <li
            key={version.variant}
            className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
          >
            <span className="label w-20 text-fg">VERSÃO {LETTERS[index]}</span>
            <Button
              variant={playing === version.variant ? 'active' : 'default'}
              onClick={() => play(version)}
            >
              {playing === version.variant
                ? 'PARAR'
                : heard.has(version.variant)
                  ? 'OUVIR DE NOVO'
                  : 'OUVIR'}
            </Button>
            <label className="label ml-auto flex cursor-pointer items-center gap-1.5 text-muted">
              <input
                type="radio"
                name="voice-lab-best"
                className="accent-(--accent)"
                checked={best === version.variant}
                onChange={() => setBest(version.variant)}
              />
              MELHOR
            </label>
            <label className="label flex cursor-pointer items-center gap-1.5 text-muted">
              <input
                type="radio"
                name="voice-lab-worst"
                className="accent-(--accent)"
                checked={worst === version.variant}
                onChange={() => setWorst(version.variant)}
              />
              PIOR
            </label>
          </li>
        ))}
      </ul>
      <textarea
        className="field"
        style={{ fontFamily: 'var(--font-body)' }}
        rows={2}
        maxLength={1000}
        placeholder="Se quiser, diga o que ouviu (opcional)"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-(--accent)"
          checked={shareRecording}
          onChange={(event) => setShareRecording(event.target.checked)}
        />
        <span className="text-xs text-muted">
          Enviar também a gravação original (só a sua frase) para análise. Ela é usada só para
          ajustar a voz do Dispeaker e apagada em 30 dias.
        </span>
      </label>
      {heard.size < versions.length && (
        <p className="label text-muted">OUÇA TODAS AS VERSÕES PARA VOTAR</p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!ready || busy} onClick={() => void send()}>
          {busy ? 'ENVIANDO' : 'ENVIAR VOTO'}
        </Button>
        <Button disabled={busy} onClick={onRestart}>
          GRAVAR DE NOVO
        </Button>
      </div>
    </div>
  );
}
