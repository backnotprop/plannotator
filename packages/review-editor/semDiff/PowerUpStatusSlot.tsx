import React, { useEffect, useRef, useState } from 'react';
import { PowerUpGuy } from '@plannotator/ui/components/agentFace/PowerUpGuy';
import { POWER_UP_PROVIDER_NAMES } from '@plannotator/ui/components/settings/PowerUpSettings';
import type { PowerUpConfig, PowerUpStatus } from './powerUp';

type SlotState = 'unavailable' | 'asking' | 'powered' | 'nothing';

const UNAVAILABLE_TEXT: Record<string, string> = {
  refusedKey: 'Power Up: key refused',
  noCredit: 'Power Up: no credit left',
};

function providerLabel(provider: PowerUpConfig['provider'], endpoint?: string): string {
  // Only Jev and Custom go to an endpoint the person chose; OpenAI and Clef keep their names.
  if ((provider === 'jev' || provider === 'custom') && endpoint) return endpoint;
  return provider ? POWER_UP_PROVIDER_NAMES[provider] : 'the model';
}

function statusKind(status: PowerUpStatus): SlotState {
  if (status.unavailable) return 'unavailable';
  if (status.asking > 0) return 'asking';
  if (status.links > 0) return 'powered';
  return 'nothing';
}

function statusText(state: SlotState, status: PowerUpStatus, model: string): string {
  if (status.unavailable) {
    return UNAVAILABLE_TEXT[status.unavailable] ?? 'Power Up unavailable';
  }
  if (state === 'asking') return `Asking ${model} · ${status.asking}`;
  if (state === 'powered') {
    const noun = status.links === 1 ? 'link' : 'links';
    return `Powered up · ${status.links} ${noun}`;
  }
  return 'Nothing to add';
}

function statusTitle(state: SlotState, links: number, model: string): string {
  if (state === 'unavailable') return "You're seeing the engine's diff. Nothing is guessed.";
  if (state === 'powered') {
    const noun = links === 1 ? 'change' : 'changes';
    return `${model} linked ${links} ${noun} the engine alone wasn't sure of.`;
  }
  if (state === 'nothing') return `${model} found nothing the engine missed.`;
  return `Asking ${model} about the calls the engine was too strict to make.`;
}

export const PowerUpStatusSlot: React.FC<{
  status: PowerUpStatus;
  provider: PowerUpConfig['provider'];
  endpoint?: string;
  onRetry: () => void;
  /** Opens the host's Power Up settings. Absent (a host with no provider form): the card says where the key is set. */
  onSettings?: () => void;
  /** A phone's bar: the face alone, a button whose press opens the same words (and Retry) in the card. */
  compact?: boolean;
  /** The key comes from PLANNOTATOR_OPINION_API_KEY (no settings page changes it); said where `onSettings` is absent. */
  keyFromEnv?: boolean;
}> = ({ status, provider, endpoint, onRetry, onSettings, compact = false, keyFromEnv = false }) => {
  const model = providerLabel(provider, endpoint);
  const state = statusKind(status);
  const text = statusText(state, status, model);
  const title = statusTitle(state, status.links, model);
  const [card, setCard] = useState(false);
  const [poke, setPoke] = useState(0);
  // A phone's card opens toward the room: from the face's left edge when the face is in the left half of the window.
  const [fromLeft, setFromLeft] = useState(false);
  // A phone's card closes on a press anywhere else: a tap on iOS focuses nothing, so no blur would close it.
  const slotRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!compact || !card) return;
    const outside = (event: PointerEvent) => {
      if (!slotRef.current?.contains(event.target as Node | null)) setCard(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [compact, card]);
  const wake = () => {
    setCard(true);
    setPoke((n) => n + 1);
  };
  const face = <PowerUpGuy state={state === 'asking' || state === 'unavailable' ? 'grey' : 'alive'} size={16} wakeKey={status.links} poke={poke} />;
  const retryButton = <button type="button" className="rounded px-1 hover:bg-muted hover:text-foreground" onClick={onRetry}>Retry</button>;
  return (
    <span
      ref={slotRef}
      className={`relative flex items-center gap-1.5 text-xs text-muted-foreground${compact ? '' : ' px-1.5'}`}
      data-power-up-status={state}
      {...(compact
        ? {}
        : {
            onMouseEnter: wake,
            onMouseLeave: () => setCard(false),
            onFocus: wake,
          })}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCard(false);
      }}
    >
      {compact ? (
        <button
          type="button"
          data-power-up-slot=""
          aria-label={text}
          aria-expanded={card}
          className="relative flex h-7 min-w-7 items-center justify-center rounded outline-none after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] focus-visible:ring-1 focus-visible:ring-ring"
          onClick={(event) => {
            if (card) return setCard(false);
            const box = event.currentTarget.getBoundingClientRect();
            setFromLeft(box.left + box.width / 2 < window.innerWidth / 2);
            wake();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && card) {
              event.stopPropagation();
              setCard(false);
            }
          }}
        >
          {face}
        </button>
      ) : (
        <span data-power-up-slot="" tabIndex={0} className="rounded outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {face}
        </span>
      )}
      {!compact && <span>{text}</span>}
      {card && (
        <span
          role={compact ? 'dialog' : 'tooltip'}
          data-power-up-card=""
          className={`absolute ${compact && fromLeft ? 'left-0' : 'right-0'} top-full z-50 mt-1 flex w-max flex-col gap-0.5 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md`}
        >
          {/* One title: a phone's card says the bar's words, which its face alone does not show. */}
          <span className="font-medium">{compact ? text : state === 'unavailable' ? 'Power Up is unavailable' : 'Your diffs are powered up'}</span>
          <span className="text-muted-foreground">Second opinion from {model}</span>
          <span className="max-w-64 text-muted-foreground">{title}</span>
          {onSettings ? (
            <button type="button" className="mt-1 self-start text-primary hover:underline" onClick={onSettings}>
              Power Up settings
            </button>
          ) : (
            <span className="mt-1 max-w-64 text-muted-foreground">{keyFromEnv ? 'Provided by PLANNOTATOR_OPINION_API_KEY' : "Model and key: code review's Settings › Semantic diffs"}</span>
          )}
          {compact && state === 'unavailable' && <span className="mt-1 self-start">{retryButton}</span>}
        </span>
      )}
      {!compact && state === 'unavailable' && (
        <>
          {retryButton}
          {onSettings && <button type="button" className="rounded px-1 hover:bg-muted hover:text-foreground" onClick={onSettings}>Settings</button>}
        </>
      )}
    </span>
  );
};
