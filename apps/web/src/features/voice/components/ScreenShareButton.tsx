import { ghostDown } from '../../../lib/exit-ghost';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { cx } from '../../../lib/cx';
import { desktop } from '../../desktop/desktop';
import { SCREEN_PRESET_LIST, SCREEN_PRESETS } from '../screen-presets';
import { startScreenShare, stopScreenShare } from '../voice-actions';
import { useVoiceStore } from '../voice-store';

const TILE =
  'pressable flex h-8 w-full items-center justify-center gap-2 border disabled:opacity-40 disabled:hover:border-line-strong';

/**
 * Starts a screen share after picking a quality preset, or stops the running one. As a `tile`
 * it is an icon that fills its cell, for the call panel; the warnings of a live share are then
 * shown by the panel itself.
 */
export function ScreenShareButton({
  allowed = true,
  tile = false,
}: {
  allowed?: boolean;
  tile?: boolean;
}) {
  const screen = useVoiceStore((state) => state.screen);
  const connected = useVoiceStore((state) => state.status === 'connected');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const supported = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const disabled = !supported || !allowed || !connected || screen.status === 'starting';
  const reason = !supported
    ? 'Este navegador não permite capturar a tela'
    : !allowed
      ? 'Você não tem permissão para transmitir neste canal'
      : undefined;

  if (screen.status === 'live' && tile) {
    return (
      <button
        type="button"
        aria-label="PARAR TRANSMISSÃO"
        title="Parar transmissão"
        aria-pressed
        className={cx(TILE, 'border-accent text-accent')}
        onClick={stopScreenShare}
      >
        <Icon name="screen" />
        <span className="label" data-testid="screen-preset">
          {screen.preset ? SCREEN_PRESETS[screen.preset].label : ''}
        </span>
      </button>
    );
  }

  if (screen.status === 'live') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="active" onClick={stopScreenShare}>
          PARAR TRANSMISSÃO
        </Button>
        <span className="label text-muted" data-testid="screen-preset">
          {screen.preset ? SCREEN_PRESETS[screen.preset].label : ''}
        </span>
        {!screen.hasAudio && (
          <span role="status" className="label text-danger" data-testid="screen-no-audio">
            SEM ÁUDIO DO SISTEMA
          </span>
        )}
        {screen.echoRisk && (
          <span role="status" className="label text-danger" data-testid="screen-echo-risk">
            QUEM ASSISTE PODE OUVIR A PRÓPRIA VOZ — TRANSMITA UMA ABA EM VEZ DA TELA INTEIRA
          </span>
        )}
        {screen.voiceChatRisk && !screen.echoRisk && (
          <span role="status" className="label text-danger" data-testid="screen-voice-chat-risk">
            {desktop
              ? 'O SOM DO PC INTEIRO VAI JUNTO, COM AS VOZES DO DISCORD'
              : 'O SOM DO PC INTEIRO VAI JUNTO, COM AS VOZES DO DISCORD — PELO APP, SÓ O JOGO VAI'}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cx('relative', !tile && 'flex flex-wrap items-center gap-2')}
    >
      {tile ? (
        <button
          type="button"
          aria-label="TRANSMITIR"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          title={reason ?? 'Transmitir a tela'}
          className={cx(
            TILE,
            open
              ? 'border-accent text-accent'
              : 'border-line-strong text-fg hover:border-accent hover:text-accent',
          )}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="screen" />
        </button>
      ) : (
        <Button
          variant="primary"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          title={reason}
          onClick={() => setOpen((value) => !value)}
        >
          TRANSMITIR
        </Button>
      )}
      {open && (
        <ul
          ref={ghostDown}
          role="menu"
          aria-label="Qualidade da transmissão"
          className={cx(
            'anim-pop absolute bottom-full z-10 mb-2 border border-line-strong bg-surface-2',
            // As a tile it is the right one of two equal cells: the menu spans both.
            tile ? 'right-0 w-[calc(200%+0.375rem)]' : 'left-0 w-72',
          )}
        >
          {SCREEN_PRESET_LIST.map((preset) => (
            <li key={preset.id} role="none" className="border-b border-line last:border-b-0">
              <button
                type="button"
                role="menuitem"
                className="group flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-surface"
                onClick={() => {
                  setOpen(false);
                  startScreenShare(preset.id);
                }}
              >
                <span className="label-lg text-fg transition-colors group-hover:text-accent">
                  {preset.label}
                </span>
                <span className="text-xs text-muted">{preset.hint}</span>
              </button>
            </li>
          ))}
          {!desktop && (
            <li role="none" className="px-3 py-2">
              <Link
                to="/download"
                role="menuitem"
                className="text-xs text-muted underline underline-offset-4 transition-colors hover:text-accent"
              >
                Vai transmitir um jogo? O app para Windows mantém mais quadros por segundo.
              </Link>
            </li>
          )}
        </ul>
      )}
      {screen.error && !tile && (
        <span role="alert" className="label text-danger">
          {screen.error}
        </span>
      )}
    </div>
  );
}
