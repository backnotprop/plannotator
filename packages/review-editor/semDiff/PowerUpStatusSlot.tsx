import React, { useState } from 'react';
import { PowerUpGuy } from '@plannotator/ui/components/agentFace/PowerUpGuy';
import { PROVIDER_NAME, type PowerUpStatus } from './powerUp';

export const PowerUpStatusSlot: React.FC<{
  status: PowerUpStatus;
  provider: 'jev' | 'clef' | null;
  onRetry: () => void;
  onSettings: () => void;
}> = ({ status, provider, onRetry, onSettings }) => {
  const model = provider ? PROVIDER_NAME[provider] : 'the model';
  const state = status.unavailable ? 'unavailable' : status.asking > 0 ? 'asking' : status.links > 0 ? 'powered' : 'nothing';
  const text =
    state === 'unavailable'
      ? status.unavailable === 'refusedKey'
        ? 'Power Up: key refused'
        : status.unavailable === 'noCredit'
          ? 'Power Up: no credit left'
          : 'Power Up unavailable'
      : state === 'asking'
        ? `Asking ${model} · ${status.asking}`
        : state === 'powered'
          ? `Powered up · ${status.links} ${status.links === 1 ? 'link' : 'links'}`
          : 'Nothing to add';
  const title =
    state === 'unavailable'
      ? "You're seeing the engine's diff. Nothing is guessed."
      : state === 'powered'
        ? `${model} linked ${status.links} ${status.links === 1 ? 'change' : 'changes'} the engine alone wasn't sure of.`
        : state === 'nothing'
          ? `${model} found nothing the engine missed.`
          : `Asking ${model} about the calls the engine was too strict to make.`;
  const [card, setCard] = useState(false);
  const [poke, setPoke] = useState(0);
  const wake = () => {
    setCard(true);
    setPoke((n) => n + 1);
  };
  return (
    <span
      className="relative flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground"
      data-power-up-status={state}
      onMouseEnter={wake}
      onMouseLeave={() => setCard(false)}
      onFocus={wake}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCard(false);
      }}
    >
      <span data-power-up-slot="" tabIndex={0} className="rounded outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <PowerUpGuy state={state === 'asking' || state === 'unavailable' ? 'grey' : 'alive'} size={16} wakeKey={status.links} poke={poke} />
      </span>
      <span>{text}</span>
      {card && (
        <span
          role="tooltip"
          data-power-up-card=""
          className="absolute right-0 top-full z-50 mt-1 flex w-max flex-col gap-0.5 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
        >
          <span className="font-medium">{state === 'unavailable' ? 'Power Up is unavailable' : 'Your diffs are powered up'}</span>
          <span className="text-muted-foreground">Second opinion from {model}</span>
          <span className="max-w-64 text-muted-foreground">{title}</span>
          <button type="button" className="mt-1 self-start text-primary hover:underline" onClick={onSettings}>
            Power Up settings
          </button>
        </span>
      )}
      {state === 'unavailable' && (
        <>
          <button type="button" className="rounded px-1 hover:bg-muted hover:text-foreground" onClick={onRetry}>Retry</button>
          <button type="button" className="rounded px-1 hover:bg-muted hover:text-foreground" onClick={onSettings}>Settings</button>
        </>
      )}
    </span>
  );
};
