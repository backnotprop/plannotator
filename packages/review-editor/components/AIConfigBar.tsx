import type React from 'react';
import { useState, useEffect } from 'react';
import { OptionPicker } from '@plannotator/ui/components/OptionPicker';
import { getProviderMeta } from '@plannotator/ui/components/ProviderIcons';
import { findSessionBridge, type AIProviderOption } from '@plannotator/ui/utils/aiProvider';
import { ModelSourceHint, modelSourceToolForProvider } from '@plannotator/ui/components/ModelSourceHint';
import { AskSessionSetupHint } from '@plannotator/ui/components/ai/AskSessionSetupHint';

interface AIConfigBarProps {
  providers: AIProviderOption[];
  selectedProviderId: string | null;
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  onProviderChange: (providerId: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  hasSession: boolean;
  /** Optional muted line on how to get "Ask this session" (askSessionSetupHint). */
  setupHint?: string | null;
}

export const AIConfigBar: React.FC<AIConfigBarProps> = ({
  providers: offeredProviders,
  selectedProviderId,
  selectedModel,
  selectedReasoningEffort,
  onProviderChange,
  onModelChange,
  onReasoningEffortChange,
  hasSession,
  setupHint,
}) => {
  // "Ask this session": the session that opened Plannotator is the only thing
  // Ask AI talks to, so the bar shows just its label (one provider, no models).
  const sessionBridge = findSessionBridge(offeredProviders);
  const providers = sessionBridge ? [sessionBridge] : offeredProviders;
  const [showSessionNote, setShowSessionNote] = useState(false);

  // Flash "New chat session" briefly when config changes while a session exists
  useEffect(() => {
    if (showSessionNote) {
      const t = setTimeout(() => setShowSessionNote(false), 2000);
      return () => clearTimeout(t);
    }
  }, [showSessionNote]);

  if (providers.length === 0) {
    return (
      <>
      <div className="border-t border-border/50 px-2 py-1.5 text-[11px] text-muted-foreground/50">
        No AI providers available
      </div>
      <AskSessionSetupHint text={setupHint} />
      </>
    );
  }

  const currentProvider = sessionBridge ?? providers.find(p => p.id === selectedProviderId) ?? providers[0];
  if (!currentProvider) return null;
  const effectiveProviderId = currentProvider.id;

  const meta = getProviderMeta(currentProvider.name, currentProvider.label);
  const Icon = meta.icon;
  const models = currentProvider.models ?? [];
  const defaultModel = models.find(m => m.default) ?? models[0];
  const effectiveModel = selectedModel ?? defaultModel?.id;
  const currentModel = models.find(m => m.id === effectiveModel) ?? defaultModel;
  const currentModelLabel = currentModel?.label;
  const reasoningEfforts = currentModel?.reasoningEfforts ?? [];
  // With nothing picked the bar shows the model's own default effort, or
  // "Auto" when the provider reports none (Pi: its default level is the user's
  // own setting) — never the first listed level, which nothing would send.
  const defaultEffort = currentModel?.defaultReasoningEffort;
  const activeEffort = selectedReasoningEffort ?? defaultEffort ?? '';

  const handleProviderSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onProviderChange(id);
  };

  const handleModelSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onModelChange(id);
  };

  const handleEffortSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onReasoningEffortChange(id === '' ? null : id);
  };

  const providerOptions = providers.map((p) => {
    const m = getProviderMeta(p.name, p.label);
    const ProvIcon = m.icon;
    return { value: p.id, label: m.label, icon: <ProvIcon className="w-3.5 h-3.5 flex-shrink-0" /> };
  });
  const effortOptions = [
    ...(defaultEffort ? [] : [{ value: '', label: 'Auto' }]),
    ...reasoningEfforts.map((e) => ({ value: e.id, label: e.label })),
  ];

  return (
    <>
    <div className="relative border-t border-border/50 px-2 py-1.5 flex items-center gap-1.5 text-xs text-muted-foreground" data-ai-config-bar="">
      {providers.length > 1 ? (
        <OptionPicker trigger="text" side="top" value={effectiveProviderId} options={providerOptions} onChange={handleProviderSelect} title="AI provider" />
      ) : (
        <span className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{meta.label}</span>
        </span>
      )}
      {models.length > 1 ? (
        <>
          <span className="text-border" aria-hidden="true">·</span>
          <OptionPicker trigger="text" side="top" value={effectiveModel ?? ''} options={models.map((m) => ({ value: m.id, label: m.label }))} onChange={handleModelSelect} title="Model" />
        </>
      ) : currentModelLabel ? (
        <>
          <span className="text-border" aria-hidden="true">·</span>
          <span>{currentModelLabel}</span>
        </>
      ) : null}
      {reasoningEfforts.length > 0 && (
        <>
          <span className="text-border" aria-hidden="true">·</span>
          <OptionPicker trigger="text" side="top" value={activeEffort} options={effortOptions} onChange={handleEffortSelect} title="Reasoning effort" />
        </>
      )}
      <div className="flex-1" />
      {showSessionNote && <span className="text-xs text-warning">New chat session</span>}
    </div>
    <ModelSourceHint
      tool={modelSourceToolForProvider(currentProvider.name)}
      info={currentProvider}
      className="-mt-1 px-2 pb-1.5 text-[10px] text-muted-foreground/50"
    />
    <AskSessionSetupHint text={setupHint} />
    </>
  );
};
