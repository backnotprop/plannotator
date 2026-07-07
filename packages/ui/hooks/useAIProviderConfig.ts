import { useCallback, useEffect, useState } from 'react';
import type { Origin } from '@plannotator/shared/agents';
import {
  getAIProviderSettings,
  resolveAIProviderSelection,
  resolveAIModelForProvider,
  saveAIProviderSelection,
  type AIProviderOption,
} from '../utils/aiProvider';

/**
 * Shared AI provider/model/reasoning-effort selection state for the plan and
 * code-review apps. Previously each App.tsx kept its own copy of this logic,
 * which drifted (e.g. a per-model effort fix landed in one app but not the
 * other). This owns the config logic in one place:
 *
 * - initial selection from saved settings,
 * - auto-resolving provider/model once capabilities load,
 * - per-model reasoning effort (a level set on one model never leaks to another),
 * - persistence of the provider/model choice.
 *
 * It deliberately does NOT reset the AI session: `useAIChat` needs `aiConfig`,
 * and its `resetSession` in turn would depend on this hook — a cycle. So the
 * caller composes the reset (`applyConfigChange(c); resetSession()`), keeping
 * session lifecycle with the app and config logic here.
 */
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
      // Reasoning effort is tracked per model so switching models can't carry a
      // stale (possibly unsupported) level across to a different model.
      reasoningEffortByModel: {} as Record<string, string>,
    };
  });

  // Auto-resolve provider/model once capabilities are known.
  useEffect(() => {
    if (!available || providers.length === 0) return;
    setAiConfig(prev => {
      const saved = getAIProviderSettings();
      const selection = resolveAIProviderSelection({
        providers,
        origin,
        settings: saved,
        serverDefaultProvider: defaultProvider,
      });
      if (prev.providerId === selection.providerId && prev.model === selection.model) return prev;
      return {
        ...prev,
        providerId: selection.providerId,
        model: selection.model,
        reasoningEffort: selection.model ? (prev.reasoningEffortByModel[selection.model] ?? null) : null,
      };
    });
  }, [available, providers, defaultProvider, origin]);

  // Update the selection (provider/model/effort). Does NOT reset the session —
  // the caller composes that (see the cycle note above).
  const applyConfigChange = useCallback(
    (config: { providerId?: string | null; model?: string | null; reasoningEffort?: string | null }) => {
      setAiConfig(prev => {
        const saved = getAIProviderSettings();
        const providerId = config.providerId !== undefined ? config.providerId : prev.providerId;
        const providerChanged = config.providerId !== undefined && config.providerId !== prev.providerId;
        const provider = providers.find(p => p.id === providerId) ?? null;
        const model = providerChanged
          ? (config.model !== undefined ? config.model : resolveAIModelForProvider(provider, saved.preferredModels))
          : (config.model !== undefined ? config.model : prev.model);
        // Per-model reasoning effort: record an explicit change against the
        // current model, then derive the effective level from the (possibly new)
        // model — so a provider/model switch never carries a stale level across.
        const reasoningEffortByModel = { ...prev.reasoningEffortByModel };
        if (config.reasoningEffort !== undefined && prev.model) {
          if (config.reasoningEffort === null) delete reasoningEffortByModel[prev.model];
          else reasoningEffortByModel[prev.model] = config.reasoningEffort;
        }
        const reasoningEffort = model ? (reasoningEffortByModel[model] ?? null) : null;
        const next = { ...prev, providerId, model, reasoningEffort, reasoningEffortByModel };
        saveAIProviderSelection({
          providerId: next.providerId,
          model: next.model,
          origin,
          settings: saved,
        });
        return next;
      });
    },
    [providers, origin],
  );

  return { aiConfig, applyConfigChange };
}
