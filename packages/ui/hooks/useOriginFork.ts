import { useMemo, useState } from 'react';
import { getAgentName, type Origin } from '@plannotator/core/agents';
import type { AIProviderOption } from '../utils/aiProvider';

/**
 * Origin-fork availability, as reported by `/api/ai/capabilities`
 * (`originFork`). `agent` is the harness that owns the invoking session;
 * `providerIds` are the registry ids of providers that can actually fork it
 * — computed server-side (see `packages/ai/endpoints.ts`), never re-derived
 * on the client.
 */
export interface OriginForkCapability {
  agent: Origin;
  providerIds: string[];
}

/** Shared prop shape for the "Fork the <agent> session" checkbox row. */
export interface OriginForkToggleProps {
  /** Whether the effective provider can fork the origin session right now. */
  available: boolean;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  /** Display name of the origin harness, e.g. "Claude Code". */
  agentName: string;
}

/**
 * Gates and owns the opt-in "fork the invoking agent session" toggle
 * (issue #1519).
 *
 * The toggle is shown only when the server reports an origin session AND the
 * *effective* AI provider — the resolved selection if it's a real, currently
 * known provider, else the server's own default, never array order — is one
 * that can actually fork it (`originFork.providerIds`).
 *
 * Switching to a non-forking provider must not leave a stale `true` armed
 * silently answering questions fresh, so the emitted `forkOrigin` is
 * *derived* from the availability gate rather than held as independent
 * state: flipping the provider away from a forking one clears it for free,
 * no extra effect required.
 */
export function useOriginFork(options: {
  originFork: OriginForkCapability | null;
  providers: AIProviderOption[];
  providerId: string | null;
  defaultProviderId: string | null;
}): { forkOrigin: boolean; toggleProps: OriginForkToggleProps } {
  const [wantsFork, setWantsFork] = useState(false);
  const { originFork, providers, providerId, defaultProviderId } = options;

  const effectiveProviderId =
    providerId && providers.some((p) => p.id === providerId) ? providerId : (defaultProviderId ?? null);

  const available =
    !!originFork && !!effectiveProviderId && originFork.providerIds.includes(effectiveProviderId);

  // This hook does not reset the AI session on toggle — same cycle as
  // useAIProviderConfig: the session (useAIChat) depends on `forkOrigin`
  // from this hook, so the reset has to be composed by the caller after both
  // exist, not owned here. Callers wrap `toggleProps.onToggle` with a call
  // to resetSession, the same way apps already compose provider-switch
  // resets — `setWantsFork` (a stable dispatch function) is handed straight
  // through rather than behind a needless wrapper.
  //
  // `toggleProps` is memoized so its identity is stable across renders that
  // don't change `available`/`wantsFork`/`originFork` — a caller's own
  // `useCallback` wrapping `toggleProps.onToggle` (or a memoized consumer
  // downstream) would otherwise recompute on every render regardless.
  const toggleProps = useMemo<OriginForkToggleProps>(() => ({
    available,
    enabled: wantsFork,
    onToggle: setWantsFork,
    agentName: originFork ? getAgentName(originFork.agent) : '',
  }), [available, wantsFork, originFork]);

  return {
    forkOrigin: wantsFork && available,
    toggleProps,
  };
}
