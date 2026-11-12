import { useCallback, useRef } from 'react';
import type { AIProviderOption } from '../utils/aiProvider';

export interface ActivatedAIProvider extends AIProviderOption {
  capabilities: Record<string, boolean>;
}

export function useAIProviderActivation(options: {
  onCapabilities: (providers: ActivatedAIProvider[], defaultProvider: string | null) => void;
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
