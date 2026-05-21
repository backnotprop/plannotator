import React from 'react';
import { createPortal } from 'react-dom';
import type { Origin } from '@plannotator/shared/agents';
import { AGENT_CONFIG, getAgentAIProviderTypes, getAgentName } from '@plannotator/shared/agents';
import { SparklesIcon } from './SparklesIcon';
import { getProviderMeta } from './ProviderIcons';

interface PlanAIAnnouncementDialogProps {
  isOpen: boolean;
  origin?: Origin | null;
  providerName?: string | null;
  onOpenAI: () => void;
  onDismiss: () => void;
}

const SUPPORTED_AI_PROVIDER_TYPES = Array.from(
  new Set(
    (Object.keys(AGENT_CONFIG) as Origin[])
      .flatMap(agentOrigin => getAgentAIProviderTypes(agentOrigin))
  )
);

const UNSUPPORTED_AI_ORIGINS = (Object.keys(AGENT_CONFIG) as Origin[])
  .filter(agentOrigin => getAgentAIProviderTypes(agentOrigin).length === 0);

export const PlanAIAnnouncementDialog: React.FC<PlanAIAnnouncementDialogProps> = ({
  isOpen,
  origin,
  providerName,
  onOpenAI,
  onDismiss,
}) => {
  if (!isOpen) return null;

  const agentLabel = getAgentName(origin ?? undefined);
  const providerLabel = providerName ? getProviderMeta(providerName).label : null;
  const unsupportedLabels = UNSUPPORTED_AI_ORIGINS.map(getAgentName).join(', ');

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-xl shadow-2xl">
        {/* Header */}
        <div className="p-5 border-b border-border">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1.5 rounded-lg bg-primary/15">
              <SparklesIcon className="w-5 h-5 text-primary" />
            </div>
            <h3 className="font-semibold text-base">New: Ask AI for annotated documents</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Chat with plans and annotated documents directly inside Plannotator.
          </p>
          {providerLabel && (
            <p className="text-xs text-muted-foreground/70 mt-1">
              Plannotator selected {providerLabel} for {agentLabel}.
            </p>
          )}
        </div>

        {/* Details */}
        <div className="p-4 space-y-4">
          {SUPPORTED_AI_PROVIDER_TYPES.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-2">Supported providers</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {SUPPORTED_AI_PROVIDER_TYPES.map(providerType => {
                  const meta = getProviderMeta(providerType);
                  const Icon = meta.icon;
                  const isSelected = providerType === providerName;
                  return (
                    <div
                      key={providerType}
                      className={`flex min-h-16 items-center gap-2 rounded-lg border p-2.5 ${
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-muted/35'
                      }`}
                    >
                      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-background/70 text-muted-foreground">
                        <Icon className="h-[18px] w-[18px]" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{meta.label}</div>
                        {isSelected && (
                          <div className="text-[10px] uppercase tracking-wide text-primary">selected</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex items-start gap-3 p-3 rounded-lg border border-transparent bg-muted/50">
              <SparklesIcon className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
              <div className="flex-1">
                <div className="text-sm font-medium">Ask from comments</div>
                <div className="text-xs text-muted-foreground">
                  Use Ask AI from a comment popover to chat about selected text.
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg border border-transparent bg-muted/50">
              <SparklesIcon className="w-4 h-4 mt-0.5 text-primary flex-shrink-0" />
              <div className="flex-1">
                <div className="text-sm font-medium">Open the side chat</div>
                <div className="text-xs text-muted-foreground">
                  Use the AI button in the header for broader document questions.
                </div>
              </div>
            </div>
          </div>

          {unsupportedLabels && (
            <p className="text-[11px] leading-relaxed text-muted-foreground/70">
              Not supported for Ask AI yet: {unsupportedLabels}.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex justify-between items-center gap-3">
          <p className="text-xs text-muted-foreground">
            This notice only appears once.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onDismiss}
              className="px-4 py-2 border border-border rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              Dismiss
            </button>
            <button
              onClick={onOpenAI}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Open AI Chat
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
