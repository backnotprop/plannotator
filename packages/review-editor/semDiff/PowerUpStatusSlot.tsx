import React from 'react';
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
  return (
    <span className="flex items-center gap-1.5 px-1.5 text-xs text-muted-foreground" data-power-up-status={state} title={title}>
      <span data-power-up-slot="" aria-hidden="true" />
      <span>{text}</span>
      {state === 'unavailable' && (
        <>
          <button type="button" className="rounded px-1 hover:bg-muted hover:text-foreground" onClick={onRetry}>Retry</button>
          <button type="button" className="rounded px-1 hover:bg-muted hover:text-foreground" onClick={onSettings}>Settings</button>
        </>
      )}
    </span>
  );
};
