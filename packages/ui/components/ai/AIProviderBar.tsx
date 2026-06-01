import React from 'react';
import { getProviderMeta } from '../ProviderIcons';
import { AI_REASONING_EFFORTS, type AIProviderOption } from '../../utils/aiProvider';

interface AIProviderBarProps {
  providers: AIProviderOption[];
  selectedProviderId: string | null;
  selectedModel: string | null;
  selectedReasoningEffort?: string | null;
  onProviderChange: (providerId: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange?: (effort: string | null) => void;
}

export const AIProviderBar: React.FC<AIProviderBarProps> = ({
  providers,
  selectedProviderId,
  selectedModel,
  selectedReasoningEffort,
  onProviderChange,
  onModelChange,
  onReasoningEffortChange,
}) => {
  if (providers.length === 0) {
    return (
      <div className="border-t border-border/50 px-2 py-1.5 text-[11px] text-muted-foreground/50">
        No AI providers available
      </div>
    );
  }

  const currentProvider = providers.find(p => p.id === selectedProviderId) ?? providers[0];
  const effectiveProviderId = currentProvider?.id ?? '';
  const models = currentProvider?.models ?? [];
  const defaultModel = models.find(m => m.default) ?? models[0];
  const effectiveModel = selectedModel ?? defaultModel?.id ?? '';
  const meta = getProviderMeta(currentProvider?.name ?? 'AI');
  const Icon = meta.icon;
  const showReasoningEffort = currentProvider?.name === 'codex-sdk' && !!onReasoningEffortChange;

  return (
    <div className="border-t border-border/50 px-2 py-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <select
        value={effectiveProviderId ?? ''}
        onChange={(event) => onProviderChange(event.target.value)}
        className="min-w-0 max-w-[8rem] bg-transparent text-[11px] text-foreground focus:outline-none"
        aria-label="AI provider"
      >
        {providers.map(provider => {
          const providerMeta = getProviderMeta(provider.name);
          return (
            <option key={provider.id} value={provider.id}>
              {providerMeta.label}
            </option>
          );
        })}
      </select>

      {models.length > 0 && (
        <select
          value={effectiveModel}
          onChange={(event) => onModelChange(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground focus:outline-none"
          aria-label="AI model"
        >
          {models.map(model => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      )}

      {showReasoningEffort && (
        <select
          value={selectedReasoningEffort ?? ''}
          onChange={(event) => onReasoningEffortChange?.(event.target.value || null)}
          className="w-16 bg-transparent text-[11px] text-foreground focus:outline-none"
          aria-label="Reasoning effort"
        >
          <option value="">Auto</option>
          {AI_REASONING_EFFORTS.map(effort => (
            <option key={effort.id} value={effort.id}>
              {effort.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
};
