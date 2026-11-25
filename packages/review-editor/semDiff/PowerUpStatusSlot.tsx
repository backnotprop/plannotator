import React, { useState } from 'react';
import { PowerUpGuy } from '@plannotator/ui/components/agentFace/PowerUpGuy';
import { POWER_UP_PROVIDER_NAMES } from '@plannotator/ui/components/settings/SemanticDiffsTab';
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
  onSettings: () => void;
}> = ({ status, provider, endpoint, onRetry, onSettings }) => {
  const model = providerLabel(provider, endpoint);
  const state = statusKind(status);
  const text = statusText(state, status, model);
  const title = statusTitle(state, status.links, model);
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
