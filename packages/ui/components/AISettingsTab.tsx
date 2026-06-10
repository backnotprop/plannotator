import type React from 'react';
import { getProviderMeta } from './ProviderIcons';
import {
  getAIProviderSettings,
  resolveAIModelForProvider,
  resolveAIProviderSelection,
  saveAIProviderSelection,
  savePreferredModel,
  type AIProviderOption,
} from '../utils/aiProvider';
import { useState } from 'react';
import type { Origin } from '@plannotator/shared/agents';

interface AIProvider extends AIProviderOption {
  capabilities: Record<string, boolean>;
}

interface AISettingsTabProps {
  providers: AIProvider[];
  selectedProviderId: string | null;
  origin?: Origin | null;
  onProviderChange: (providerId: string | null) => void;
}

export const AISettingsTab: React.FC<AISettingsTabProps> = ({
  providers,
  selectedProviderId,
  origin,
  onProviderChange,
}) => {
  const settings = getAIProviderSettings();
  const originDefault = resolveAIProviderSelection({ providers, origin, settings }).providerId;
  const effectiveSelection = selectedProviderId ?? originDefault ?? providers[0]?.id ?? null;
  const [preferredModels, setPreferredModels] = useState<Record<string, string>>(() =>
    getAIProviderSettings().preferredModels
  );

  const handleSelectProvider = (providerId: string) => {
    onProviderChange(providerId);
    const provider = providers.find(p => p.id === providerId) ?? null;
    const model = resolveAIModelForProvider(provider, getAIProviderSettings().preferredModels);
    saveAIProviderSelection({ providerId, model, origin });
  };

  const handleModelChange = (providerId: string, modelId: string) => {
    savePreferredModel(providerId, modelId);
    setPreferredModels(prev => ({ ...prev, [providerId]: modelId }));
  };

  if (providers.length === 0) {
    return (
      <>
        <div>
          <div className="text-sm font-medium">AI Provider</div>
        </div>
        <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-600 dark:text-amber-400">
          <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span>No AI providers detected. Install the <strong>claude</strong> or <strong>codex</strong> CLI and make sure you're authenticated. <a href="https://plannotator.ai/docs/guides/ai-features/" target="_blank" rel="noopener noreferrer" className="underline hover:text-amber-700 dark:hover:text-amber-300">Setup guide</a></span>
        </div>
      </>
    );
  }

  return (
    <>
      <div>
        <div className="text-sm font-medium">AI Provider</div>
        <div className="text-xs text-muted-foreground">
          Choose which AI provider and model to use for inline chat
        </div>
      </div>

      <div className="space-y-2">
        {providers.map((p) => {
          const meta = getProviderMeta(p.name);
          const Icon = meta.icon;
          const isSelected = effectiveSelection === p.id;
          const models = p.models ?? [];
          const defaultModel = models.find(m => m.default) ?? models[0];
          const selectedModel = preferredModels[p.id] ?? defaultModel?.id ?? null;

          return (
            <div key={p.id}>
              <button
                type="button"
                onClick={() => handleSelectProvider(p.id)}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50'
                } ${models.length > 1 && isSelected ? 'rounded-b-none border-b-0' : ''}`}
              >
                <div className="w-6 h-6 rounded-md bg-muted flex items-center justify-center text-muted-foreground">
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{meta.label}</div>
                </div>
                {isSelected && (
                  <svg className="w-4 h-4 text-primary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>

              {/* Model selector — shown for selected provider when models available */}
              {isSelected && models.length > 1 && (
                <div className="border border-t-0 border-primary bg-primary/5 rounded-b-lg px-3 pb-3 pt-1">
                  <label className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">Model</span>
                    <select
                      value={selectedModel ?? ''}
                      onChange={(e) => handleModelChange(p.id, e.target.value)}
                      className="flex-1 text-xs bg-muted rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                    >
                      {models.map(m => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              {/* Show current model as muted text for unselected providers */}
              {!isSelected && models.length > 0 && (
                <div className="px-3 -mt-0.5">
                  <span className="text-[10px] text-muted-foreground/50">
                    {models.find(m => m.id === (preferredModels[p.id] ?? defaultModel?.id))?.label ?? defaultModel?.label}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="text-[10px] text-muted-foreground/70">
        Providers are detected from installed CLI tools. No API keys are managed by Plannotator — you must be authenticated with each CLI independently.{' '}
        <a href="https://plannotator.ai/docs/guides/ai-features/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Learn more</a>
      </div>
    </>
  );
};
