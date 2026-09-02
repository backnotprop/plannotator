import React, { useState, useRef, useEffect } from 'react';
import type { Agent } from '../hooks/useAgents';
import {
  getAgentSwitchSettings,
  getEffectiveModelPreference,
  saveAgentSwitchSettings,
  type AgentModelPreference,
  type AgentSwitchSettings,
} from '../utils/agentSwitch';

interface ApproveDropdownProps {
  onApprove: () => void;
  agents: Agent[];
  /** The model this session is currently running (OpenCode only), when known. */
  currentModel?: { providerID: string; modelID: string };
  disabled?: boolean;
  isLoading?: boolean;
}

function getSelectedLabel(setting: AgentSwitchSettings, agents: Agent[]): string | null {
  if (setting.switchTo === 'disabled') return null;
  if (setting.switchTo === 'custom' && setting.customName) {
    return setting.customName;
  }
  const match = agents.find(a => a.id.toLowerCase() === setting.switchTo.toLowerCase());
  return match?.name ?? setting.switchTo;
}

function getMatchedAgent(setting: AgentSwitchSettings, agents: Agent[]): Agent | undefined {
  const name = setting.switchTo === 'custom' ? setting.customName : setting.switchTo;
  if (!name) return undefined;
  return agents.find(a => a.id.toLowerCase() === name.toLowerCase());
}

/** Short model preview shown next to the target agent name in the split button. */
function getModelPreview(
  setting: AgentSwitchSettings,
  agents: Agent[],
  currentModel?: { providerID: string; modelID: string },
): string | null {
  if (setting.switchTo === 'disabled') return null;
  if (getEffectiveModelPreference(setting) === 'current') return currentModel?.modelID ?? 'current model';
  return getMatchedAgent(setting, agents)?.model?.modelID ?? null;
}

function isSelected(agentId: string, setting: AgentSwitchSettings): boolean {
  if (setting.switchTo === 'custom') return false;
  if (setting.switchTo === 'disabled') return false;
  return agentId.toLowerCase() === setting.switchTo.toLowerCase();
}

const Checkmark = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

export const ApproveDropdown: React.FC<ApproveDropdownProps> = ({
  onApprove,
  agents,
  currentModel,
  disabled = false,
  isLoading = false,
}) => {
  const [setting, setSetting] = useState<AgentSwitchSettings>(() => getAgentSwitchSettings('plan'));
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const handleSelect = (newSetting: AgentSwitchSettings) => {
    const merged: AgentSwitchSettings = { ...newSetting, modelPreference: setting.modelPreference };
    setSetting(merged);
    saveAgentSwitchSettings(merged);
    setIsOpen(false);
  };

  const handleModelPreferenceSelect = (modelPreference: AgentModelPreference) => {
    const merged: AgentSwitchSettings = { ...setting, modelPreference };
    setSetting(merged);
    saveAgentSwitchSettings(merged);
    setIsOpen(false);
  };

  const agentLabel = getSelectedLabel(setting, agents);
  const modelPreview = getModelPreview(setting, agents, currentModel);
  const modelPreference = getEffectiveModelPreference(setting);
  const matchedAgent = getMatchedAgent(setting, agents);
  const isNoSwitch = setting.switchTo === 'disabled';
  const isCustom = setting.switchTo === 'custom';
  const notFound = agentLabel && !isNoSwitch && !isCustom
    && !agents.some(a => a.id.toLowerCase() === setting.switchTo.toLowerCase());

  const baseClasses = disabled
    ? 'opacity-50 cursor-not-allowed bg-muted text-muted-foreground'
    : 'bg-success text-success-foreground hover:opacity-90';

  const handleApproveClick = () => {
    setIsOpen(false);
    onApprove();
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Mobile: simple button */}
      <button
        onClick={handleApproveClick}
        disabled={disabled}
        className={`md:hidden px-2 py-1 rounded-md text-xs font-medium transition-all ${baseClasses}`}
      >
        {isLoading ? '...' : 'OK'}
      </button>

      {/* Desktop: split button */}
      <div className="hidden md:flex items-stretch">
        <button
          onClick={handleApproveClick}
          disabled={disabled}
          className={`px-2.5 py-1 rounded-l-md text-xs font-medium transition-all ${baseClasses}`}
        >
          {isLoading ? 'Approving...' : (
            agentLabel ? (
              <span className="flex items-center gap-1">
                Approve
                <span className="opacity-60">&rarr;</span>
                <span className="max-w-[120px] truncate">{agentLabel}</span>
                {notFound && <span className="opacity-60 text-[10px]">(?)</span>}
                {modelPreview && (
                  <span className="opacity-60 text-[10px] truncate max-w-[110px]">&middot; {modelPreview}</span>
                )}
              </span>
            ) : 'Approve'
          )}
        </button>
        <button
          onClick={() => setIsOpen(!isOpen)}
          disabled={disabled}
          className={`px-1.5 py-1 rounded-r-md border-l border-success-foreground/20 text-xs transition-all ${baseClasses}`}
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border border-border bg-popover shadow-xl z-[70] overflow-hidden py-1">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
            Switch to agent
          </div>
          {agents.map((agent) => {
            const selected = isSelected(agent.id, setting);
            return (
              <button
                key={agent.id}
                onClick={() => handleSelect({ switchTo: agent.id })}
                className={`w-full px-3 py-1.5 text-left text-xs transition-colors flex items-center gap-2 ${
                  selected
                    ? 'text-primary bg-primary/10 font-medium'
                    : 'text-popover-foreground hover:bg-muted'
                }`}
              >
                <span className="w-4 flex-shrink-0">{selected && <Checkmark />}</span>
                <span className="truncate">{agent.name}</span>
                {agent.model?.modelID && (
                  <span className="text-[10px] text-muted-foreground ml-auto truncate max-w-[110px]">
                    {agent.model.modelID}
                  </span>
                )}
              </button>
            );
          })}
          {isCustom && setting.customName && (
            <button
              onClick={() => setIsOpen(false)}
              className="w-full px-3 py-1.5 text-left text-xs transition-colors flex items-center gap-2 text-primary bg-primary/10 font-medium"
            >
              <span className="w-4 flex-shrink-0"><Checkmark /></span>
              <span className="truncate">{setting.customName}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">(custom)</span>
            </button>
          )}
          <div className="border-t border-border my-1" />
          <button
            onClick={() => handleSelect({ switchTo: 'disabled' })}
            className={`w-full px-3 py-1.5 text-left text-xs transition-colors flex items-center gap-2 ${
              isNoSwitch
                ? 'text-primary bg-primary/10 font-medium'
                : 'text-popover-foreground hover:bg-muted'
            }`}
          >
            <span className="w-4 flex-shrink-0">{isNoSwitch && <Checkmark />}</span>
            No switch
          </button>
          {!isNoSwitch && (
            <>
              <div className="border-t border-border my-1" />
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 font-medium">
                Model after switch
              </div>
              <button
                onClick={() => handleModelPreferenceSelect('current')}
                className={`w-full px-3 py-1.5 text-left text-xs transition-colors flex items-center gap-2 ${
                  modelPreference === 'current'
                    ? 'text-primary bg-primary/10 font-medium'
                    : 'text-popover-foreground hover:bg-muted'
                }`}
              >
                <span className="w-4 flex-shrink-0">{modelPreference === 'current' && <Checkmark />}</span>
                <span className="truncate">
                  Keep current model
                  {currentModel?.modelID && (
                    <span className="text-muted-foreground"> ({currentModel.modelID})</span>
                  )}
                </span>
              </button>
              <button
                onClick={() => handleModelPreferenceSelect('agent-default')}
                className={`w-full px-3 py-1.5 text-left text-xs transition-colors flex items-center gap-2 ${
                  modelPreference === 'agent-default'
                    ? 'text-primary bg-primary/10 font-medium'
                    : 'text-popover-foreground hover:bg-muted'
                }`}
              >
                <span className="w-4 flex-shrink-0">{modelPreference === 'agent-default' && <Checkmark />}</span>
                <span className="truncate">
                  Use agent&apos;s default
                  {matchedAgent?.model?.modelID && (
                    <span className="text-muted-foreground"> ({matchedAgent.model.modelID})</span>
                  )}
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
