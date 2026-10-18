import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Loading } from '../../components/Loading';
import { toWav } from '../voice-lab/render';
import { LevelBar } from '../voice/components/MicMeter';
import { recordAsHeard } from '../voice/hear-myself';
import type { NoiseEngine } from '../voice/microphone';
import { useSettingsStore } from './settings-store';

const SECONDS = 10;

const ENGINES: Record<NoiseEngine, string> = {
  gtcrn: 'supressão GTCRN',
  rnnoise: 'supressão RNNoise',
  browser: 'filtro do navegador',
  off: 'nenhuma',
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'recording'; elapsed: number }
  | { kind: 'ready'; url: string; engine: NoiseEngine }
  | { kind: 'error' };

/**
 * Records a few seconds of the user's voice and plays it back as the others hear it in a call:
 * same filters, same chain, same Opus settings. Nobody else hears it.
 */
export function HearMyself() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [level, setLevel] = useState(0);
  const [playing, setPlaying] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = phase.kind === 'ready' ? phase.url : null;

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(
    () => () => {
      audio.current?.pause();
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const record = async () => {
    audio.current?.pause();
    setPlaying(false);
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: 'preparing' });
    let clock: number | undefined;
    try {
      const began = { at: 0 };
      const recording = await recordAsHeard(
        useSettingsStore.getState(),
        SECONDS,
        (peak) => {
          if (!began.at) {
            began.at = performance.now();
            clock = window.setInterval(
              () => setPhase({ kind: 'recording', elapsed: (performance.now() - began.at) / 1000 }),
              250,
            );
          }
          setLevel(peak);
        },
        controller.signal,
      );
      setPhase({
        kind: 'ready',
        url: URL.createObjectURL(toWav(recording.samples)),
        engine: recording.noiseSuppression,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setPhase({ kind: 'idle' });
        return;
      }
      console.warn('[settings] hear myself failed', error);
      setPhase({ kind: 'error' });
    } finally {
      window.clearInterval(clock);
      setLevel(0);
    }
  };

  const play = () => {
    if (!url) return;
    if (playing) {
      audio.current?.pause();
      setPlaying(false);
      return;
    }
    const element = new Audio(url);
    const { outputDeviceId } = useSettingsStore.getState();
    if (outputDeviceId && typeof element.setSinkId === 'function') {
      void element.setSinkId(outputDeviceId).catch(() => undefined);
    }
    element.addEventListener('ended', () => setPlaying(false));
    audio.current = element;
    setPlaying(true);
    void element.play().catch(() => setPlaying(false));
  };

  return (
    <div className="flex flex-col gap-2 border border-line p-3" data-testid="hear-myself">
      <div className="flex flex-wrap items-center gap-3">
        <span className="label text-muted">OUVIR COMO OS OUTROS ME OUVEM</span>
        {phase.kind === 'recording' && (
          <>
            <span className="label text-accent">
              GRAVANDO · {Math.max(0, Math.ceil(SECONDS - phase.elapsed))} S
            </span>
            <LevelBar level={level} className="h-3" />
          </>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {phase.kind === 'ready' && (
            <Button variant={playing ? 'active' : 'primary'} onClick={play}>
              {playing ? 'PARAR' : 'OUVIR'}
            </Button>
          )}
          {phase.kind === 'recording' || phase.kind === 'preparing' ? (
            <Button onClick={() => abort.current?.abort()}>CANCELAR</Button>
          ) : (
            <Button onClick={() => void record()}>
              {phase.kind === 'ready' ? 'GRAVAR DE NOVO' : `GRAVAR ${SECONDS} S`}
            </Button>
          )}
        </div>
      </div>
      {phase.kind === 'preparing' && <Loading label="ABRINDO O MICROFONE" />}
      <p className="text-xs text-muted">
        {phase.kind === 'recording'
          ? 'Fale no seu tom de sempre, como numa conversa.'
          : phase.kind === 'ready'
            ? `É o que chega aos outros numa chamada: os filtros acima e a voz codificada como na chamada (só a sua internet não entra). Limpeza usada: ${ENGINES[phase.engine]}. Ouça de fone.`
            : 'Grave alguns segundos e ouça a sua voz com os filtros acima e codificada como numa chamada, sem precisar entrar em uma. Ninguém ouve a gravação.'}
      </p>
      {phase.kind === 'error' && (
        <p role="alert" className="label text-danger">
          NÃO FOI POSSÍVEL GRAVAR
        </p>
      )}
    </div>
  );
}
