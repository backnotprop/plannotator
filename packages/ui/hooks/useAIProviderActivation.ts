import { useCallback, useRef } from 'react';
import type { AIProviderOption } from '../utils/aiProvider';

/**
 * Explicit AI provider activation for lazily-initialized providers.
 *
 * Codex model discovery is deferred until a session starts (it spawns a
 * `codex app-server` process — see #1144), so /api/ai/capabilities advertises
 * static fallback metadata until then. This hook lets the apps run that same
 * deferred initializer on an explicit user gesture — opening the Ask AI
 * surface, or switching the provider picker — via
 * `GET /api/ai/capabilities?activate=<providerId>`, then merge the refreshed
 * provider metadata (real model list + reasoning efforts) back into app state.
 *
 * Single-flight per provider id: repeated gestures don't re-fetch (activation
 * is idempotent server-side anyway), but a failed fetch un-latches so a later
 * gesture can retry. Providers without deferred initialization are a server-side
 * no-op, so callers don't need to know which providers are lazy.
 */
export interface ActivatedAIProvider extends AIProviderOption {
  capabilities: Record<string, boolean>;
}

export function useAIProviderActivation(options: {
  onCapabilities: (providers: ActivatedAIProvider[], defaultProvider: string | null) => void;
  /**
   * The Ask AI providers the server currently lists. When given, an id not in
   * it is never activated: at page load the selection can still hold a saved
   * provider id (e.g. `codex-sdk`) for one render before the resolver moves it
   * to what the server offers, and activating that id would start its model
   * discovery even though Ask AI does not offer it (a session-bridge server
   * lists only the bridge). Omitted keeps the old behavior.
   */
  providers?: ReadonlyArray<Pick<AIProviderOption, 'id'>>;
}) {
  const activatedRef = useRef<Set<string>>(new Set());
  const onCapabilitiesRef = useRef(options.onCapabilities);
  onCapabilitiesRef.current = options.onCapabilities;
  const providersRef = useRef(options.providers);
  providersRef.current = options.providers;

  return useCallback((providerId: string | null | undefined) => {
    if (!providerId || activatedRef.current.has(providerId)) return;
    const listed = providersRef.current;
    if (listed && !listed.some(provider => provider.id === providerId)) return;
    activatedRef.current.add(providerId);
    fetch(`/api/ai/capabilities?activate=${encodeURIComponent(providerId)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (!data?.available) {
          activatedRef.current.delete(providerId);
          return;
        }
        onCapabilitiesRef.current(data.providers ?? [], data.defaultProvider ?? null);
      })
      .catch(() => {
        activatedRef.current.delete(providerId);
      });
  }, []);
}
