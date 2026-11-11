import React from 'react';
import { Check } from 'lucide-react';
import type { Agent } from '../hooks/useAgents';
import { useConfigValue } from '../config/useConfig';
import {
  getAgentSwitchDefaults,
  saveAgentSwitchSettings,
  type AgentSwitchSettings,
} from '../utils/agentSwitch';
import { ActionMenuDivider } from './ActionMenu';
import { cn } from '../lib/utils';

/** NOT host-supported surface (like DecisionControl): Plannotator's own plan review chrome. */

function isSelected(agentId: string, setting: AgentSwitchSettings): boolean {
  if (setting.switchTo === 'custom' || setting.switchTo === 'disabled') return false;
  return agentId.toLowerCase() === setting.switchTo.toLowerCase();
}

const RadioRow: React.FC<{
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  note?: string;
}> = ({ checked, onSelect, children, note }) => (
  <button
    type="button"
    role="menuitemradio"
    aria-checked={checked}
    onClick={onSelect}
    data-agent-switch-option="true"
    className={cn(
      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors outline-none focus-visible:bg-muted',
      checked ? 'bg-primary/10 font-medium text-primary' : 'text-popover-foreground hover:bg-muted',
    )}
  >
    <span className="w-3.5 flex-shrink-0">{checked && <Check className="size-3.5" aria-hidden="true" />}</span>
    <span className="truncate">{children}</span>
    {note && <span className="ml-auto text-[10px] text-muted-foreground">{note}</span>}
  </button>
);

/** Reads and writes the same `agentSwitch` setting Settings does. */
export const AgentSwitchMenuSection: React.FC<{ agents: Agent[] }> = ({ agents }) => {
  const stored = useConfigValue('agentSwitch');
  const setting: AgentSwitchSettings = stored ?? getAgentSwitchDefaults('plan');
  const isCustom = setting.switchTo === 'custom' && !!setting.customName;
  const title = 'After approval, switch to';

  return (
    <>
      <ActionMenuDivider />
      <div
        aria-hidden="true"
        className="px-3 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70"
      >
        {title}
      </div>
      <div role="group" aria-label={title} data-agent-switch-section="true">
        {agents.map((agent) => (
          <RadioRow
            key={agent.id}
            checked={isSelected(agent.id, setting)}
            onSelect={() => saveAgentSwitchSettings({ switchTo: agent.id })}
          >
            {agent.name}
          </RadioRow>
        ))}
        {isCustom && (
          <RadioRow checked onSelect={() => {}} note="(custom)">
            {setting.customName}
          </RadioRow>
        )}
        <RadioRow
          checked={setting.switchTo === 'disabled'}
          onSelect={() => saveAgentSwitchSettings({ switchTo: 'disabled' })}
        >
          No switch
        </RadioRow>
      </div>
    </>
  );
};

/** Claude Code: the permission mode Approve already sends, made visible. */
export const PermissionModeMenuLine: React.FC<{
  agentName: string;
  modeLabel: string;
  onChange: () => void;
}> = ({ agentName, modeLabel, onChange }) => (
  <>
    <ActionMenuDivider />
    <div
      data-permission-mode-line="true"
      className="flex items-center justify-between gap-2 px-3 py-1.5 text-[10px] text-muted-foreground"
    >
      <span>
        After approval, {agentName} runs in{' '}
        <span className="font-medium text-foreground">{modeLabel}</span>
      </span>
      <button
        type="button"
        role="menuitem"
        onClick={onChange}
        data-permission-mode-change="true"
        aria-label={`Change the permission mode (${modeLabel}) in Settings`}
        className="rounded px-1 py-0.5 text-[10px] text-primary outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring/60"
      >
        Change
      </button>
    </div>
  </>
);
