import type React from 'react';
import { useState, useEffect, useRef } from 'react';
import { getProviderMeta } from '@plannotator/ui/components/ProviderIcons';

interface AIProviderModel {
  id: string;
  label: string;
  default?: boolean;
}

interface AIProviderInfo {
  id: string;
  name: string;
  models?: AIProviderModel[];
}

const REASONING_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Max' },
] as const;

interface AIConfigBarProps {
  providers: AIProviderInfo[];
  selectedProviderId: string | null;
  selectedModel: string | null;
  selectedReasoningEffort: string | null;
  onProviderChange: (providerId: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: string | null) => void;
  hasSession: boolean;
}

export const AIConfigBar: React.FC<AIConfigBarProps> = ({
  providers,
  selectedProviderId,
  selectedModel,
  selectedReasoningEffort,
  onProviderChange,
  onModelChange,
  onReasoningEffortChange,
  hasSession,
}) => {
  const [showSessionNote, setShowSessionNote] = useState(false);
  const [openMenu, setOpenMenu] = useState<'provider' | 'model' | 'effort' | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const barRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Flash "New chat session" briefly when config changes while a session exists
  useEffect(() => {
    if (showSessionNote) {
      const t = setTimeout(() => setShowSessionNote(false), 2000);
      return () => clearTimeout(t);
    }
  }, [showSessionNote]);

  // Close menu on click outside
  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        setModelSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openMenu]);

  if (providers.length === 0) {
    return (
      <div className="border-t border-border/50 px-2 py-1.5 text-[11px] text-muted-foreground/50">
        No AI providers available
      </div>
    );
  }

  const effectiveProviderId = selectedProviderId ?? providers[0]?.id;
  const currentProvider = providers.find(p => p.id === effectiveProviderId) ?? providers[0];
  if (!currentProvider) return null;

  const meta = getProviderMeta(currentProvider.name);
  const Icon = meta.icon;
  const models = currentProvider.models ?? [];
  const defaultModel = models.find(m => m.default) ?? models[0];
  const effectiveModel = selectedModel ?? defaultModel?.id;
  const currentModelLabel = models.find(m => m.id === effectiveModel)?.label ?? defaultModel?.label;

  const handleProviderSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onProviderChange(id);
    setOpenMenu(null);
  };

  const handleModelSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onModelChange(id);
    setOpenMenu(null);
    setModelSearch('');
  };

  const handleEffortSelect = (id: string) => {
    if (hasSession) setShowSessionNote(true);
    onReasoningEffortChange(id);
    setOpenMenu(null);
  };

  const chevron = (
    <svg className="w-2.5 h-2.5 text-muted-foreground/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );

  return (
    <div ref={barRef} className="relative border-t border-border/50 px-2 py-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {/* Provider selector */}
      {providers.length > 1 ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenMenu(openMenu === 'provider' ? null : 'provider')}
            className="flex items-center gap-1.5 px-1 py-0.5 -mx-1 rounded hover:bg-muted/50 transition-colors"
          >
            <Icon className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{meta.label}</span>
            {chevron}
          </button>

          {openMenu === 'provider' && (
            <div className="ai-config-menu">
              {providers.map(p => {
                const m = getProviderMeta(p.name);
                const ProvIcon = m.icon;
                const isActive = p.id === effectiveProviderId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleProviderSelect(p.id)}
                    className={`ai-config-menu-item ${isActive ? 'ai-config-menu-item-active' : ''}`}
                  >
                    <ProvIcon className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{m.label}</span>
                    {isActive && (
                      <svg className="w-3 h-3 ml-auto text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <span className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{meta.label}</span>
        </span>
      )}

      {/* Model selector */}
      {models.length > 1 ? (
        <>
          <span className="text-border/60">·</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'model' ? null : 'model')}
              className="flex items-center gap-1 px-1 py-0.5 -mx-1 rounded hover:bg-muted/50 transition-colors"
            >
              <span>{currentModelLabel}</span>
              {chevron}
            </button>

            {openMenu === 'model' && (
              <div className="ai-config-menu">
                {models.length > 8 && (
                  <div className="ai-config-menu-search">
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Filter models…"
                      value={modelSearch}
                      onChange={e => setModelSearch(e.target.value)}
                      autoFocus
                    />
                  </div>
                )}
                <div className={models.length > 8 ? 'ai-config-menu-scroll' : ''}>
                  {models
                    .filter(m => !modelSearch || m.label.toLowerCase().includes(modelSearch.toLowerCase()))
                    .map(m => {
                      const isActive = m.id === effectiveModel;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleModelSelect(m.id)}
                          className={`ai-config-menu-item ${isActive ? 'ai-config-menu-item-active' : ''}`}
                        >
                          <span>{m.label}</span>
                          {isActive && (
                            <svg className="w-3 h-3 ml-auto text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        </>
      ) : currentModelLabel ? (
        <>
          <span className="text-border/60">·</span>
          <span>{currentModelLabel}</span>
        </>
      ) : null}

      {/* Reasoning effort — Codex only */}
      {currentProvider.name === 'codex-sdk' && (
        <>
          <span className="text-border/60">·</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => setOpenMenu(openMenu === 'effort' ? null : 'effort')}
              className="flex items-center gap-1 px-1 py-0.5 -mx-1 rounded hover:bg-muted/50 transition-colors"
              title="Reasoning effort"
            >
              <span>{REASONING_EFFORTS.find(e => e.id === (selectedReasoningEffort ?? 'high'))?.label ?? 'High'}</span>
              {chevron}
            </button>

            {openMenu === 'effort' && (
              <div className="ai-config-menu">
                {REASONING_EFFORTS.map(e => {
                  const isActive = e.id === (selectedReasoningEffort ?? 'high');
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => handleEffortSelect(e.id)}
                      className={`ai-config-menu-item ${isActive ? 'ai-config-menu-item-active' : ''}`}
                    >
                      <span>{e.label}</span>
                      {isActive && (
                        <svg className="w-3 h-3 ml-auto text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Session reset note */}
      {showSessionNote && (
        <span className="text-[10px] text-amber-500 animate-pulse">New chat session</span>
      )}
    </div>
  );
};
