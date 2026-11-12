import { useCallback, useEffect, useRef, useState } from 'react';
import type { Origin } from '@plannotator/core/agents';
import {
  getAIProviderSettings,
  resolveAIProviderSelection,
  resolveAIModelForProvider,
  saveAIProviderSelection,
  type AIProviderOption,
} from '../utils/aiProvider';

export interface AIProviderConfig {
  providerId: string | null;
  model: string | null;
  reasoningEffort: string | null;
}

interface UseAIProviderConfigOptions {
  providers: AIProviderOption[];
  defaultProvider: string | null;
  available: boolean;
  origin: Origin | null | undefined;
}

export function useAIProviderConfig({
  providers,
  defaultProvider,
  available,
  origin,
}: UseAIProviderConfigOptions) {
  const [aiConfig, setAiConfig] = useState(() => {
    const saved = getAIProviderSettings();
    const pid = saved.providerId;
    return {
      providerId: pid,
      model: pid ? (saved.preferredModels[pid] ?? null) : null,
      reasoningEffort: null as string | null,
      reasoningEffortByModel: {} as Record<string, string>,
    };
  });

  const sessionPickRef = useRef<string | null>(null);

  useEffect(() => {
    if (!available || providers.length === 0) return;
    const saved = getAIProviderSettings();
    const sessionPick = sessionPickRef.current
      ? providers.find(p => p.id === sessionPickRef.current) ?? null
      : null;
    const selection = sessionPick
      ? { providerId: sessionPick.id, model: resolveAIModelForProvider(sessionPick, saved.preferredModels) }
      : resolveAIProviderSelection({
          providers,
          origin,
          settings: saved,
          serverDefaultProvider: defaultProvider,
        });

    setAiConfig(prev => {
      if (prev.providerId === selection.providerId && prev.model === selection.model) return prev;
      return {
        ...prev,
        providerId: selection.providerId,
        model: selection.model,
        reasoningEffort: selection.model ? (prev.reasoningEffortByModel[selection.model] ?? null) : null,
      };
    });
  }, [available, providers, defaultProvider, origin]);

  const applyConfigChange = useCallback(
    (
      config: { providerId?: string | null; model?: string | null; reasoningEffort?: string | null },
      options?: { persist?: boolean },
    ) => {
      const persist = options?.persist !== false;
      if (!persist && config.providerId) sessionPickRef.current = config.providerId;
      else if (persist && config.providerId !== undefined) sessionPickRef.current = null;
      setAiConfig(prev => {
        const saved = getAIProviderSettings();
        const providerId = config.providerId !== undefined ? config.providerId : prev.providerId;
        const providerChanged = config.providerId !== undefined && config.providerId !== prev.providerId;
        const provider = providers.find(p => p.id === providerId) ?? null;
        const model = providerChanged
          ? (config.model !== undefined ? config.model : resolveAIModelForProvider(provider, saved.preferredModels))
          : (config.model !== undefined ? config.model : prev.model);
        const reasoningEffortByModel = { ...prev.reasoningEffortByModel };
        if (config.reasoningEffort !== undefined && prev.model) {
          if (config.reasoningEffort === null) delete reasoningEffortByModel[prev.model];
          else reasoningEffortByModel[prev.model] = config.reasoningEffort;
        }
        const reasoningEffort = model ? (reasoningEffortByModel[model] ?? null) : null;
        const next = { ...prev, providerId, model, reasoningEffort, reasoningEffortByModel };
        if (persist) {
          saveAIProviderSelection({
            providerId: next.providerId,
            model: config.model !== undefined ? next.model : null,
            origin,
            settings: saved,
          });
        }
        return next;
      });
    },
    [providers, origin],
  );

  return { aiConfig, applyConfigChange };
}
