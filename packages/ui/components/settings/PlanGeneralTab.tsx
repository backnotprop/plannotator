import React, { useState } from 'react';
import type { Origin } from '@plannotator/shared/agents';
import {
  getPermissionModeSettings,
  savePermissionModeSettings,
  PERMISSION_MODE_OPTIONS,
  type PermissionMode,
} from '../../utils/permissionMode';
import {
  getAgentSwitchSettings,
  saveAgentSwitchSettings,
  AGENT_OPTIONS,
} from '../../utils/agentSwitch';
import { useAgents } from '../../hooks/useAgents';

interface PlanGeneralTabProps {
  origin?: Origin | string | null;
}

export const PlanGeneralTab: React.FC<PlanGeneralTabProps> = ({ origin }) => {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => getPermissionModeSettings().mode,
  );
  const [agent, setAgent] = useState(() => getAgentSwitchSettings());
  const [agentWarning, setAgentWarning] = useState<string | null>(null);
  const { agents: availableAgents } = useAgents((origin as Origin) ?? null);

  const handlePermissionModeChange = (mode: PermissionMode) => {
    setPermissionMode(mode);
    savePermissionModeSettings(mode);
  };

  const handleAgentChange = (switchTo: string, customName?: string) => {
    const next = { switchTo, customName: customName ?? agent.customName };
    setAgent(next);
    saveAgentSwitchSettings(next);
  };

  const validateAgent = (name: string) =>
    availableAgents.some((a) => a.id.toLowerCase() === name.toLowerCase());

  const showPermission = origin === 'claude-code';
  const showAgent = origin === 'opencode';

  if (!showPermission && !showAgent) {
    return (
      <div className="text-sm text-muted-foreground">
        No plan-specific settings available for this agent.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {showPermission && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Permission Mode</div>
          <div className="text-xs text-muted-foreground">
            Automation level after plan approval
          </div>
          <select
            value={permissionMode}
            onChange={(e) => handlePermissionModeChange(e.target.value as PermissionMode)}
            className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
          >
            {PERMISSION_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="text-[10px] text-muted-foreground">
            {PERMISSION_MODE_OPTIONS.find((o) => o.value === permissionMode)?.description}
          </div>
        </div>
      )}

      {showAgent && (
        <div className="space-y-2">
          <div className="text-sm font-medium">Agent Switching</div>
          <div className="text-xs text-muted-foreground">
            Which agent to switch to after plan approval
          </div>
          {agentWarning && (
            <div className="flex items-start gap-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-600 dark:text-amber-400">
              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{agentWarning}</span>
            </div>
          )}
          <select
            value={agent.switchTo}
            onChange={(e) => {
              handleAgentChange(e.target.value);
              setAgentWarning(null);
            }}
            className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
          >
            {availableAgents.length > 0 ? (
              <>
                {agent.switchTo !== 'custom' &&
                 agent.switchTo !== 'disabled' &&
                 !availableAgents.some((a) => a.id.toLowerCase() === agent.switchTo.toLowerCase()) && (
                  <option value={agent.switchTo} disabled>
                    {agent.switchTo} (not found)
                  </option>
                )}
                {availableAgents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
                <option value="custom">Custom</option>
                <option value="disabled">Disabled</option>
              </>
            ) : (
              AGENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))
            )}
          </select>
          {agent.switchTo === 'custom' && (
            <input
              type="text"
              value={agent.customName || ''}
              onChange={(e) => {
                const customName = e.target.value;
                handleAgentChange('custom', customName);
                if (customName && availableAgents.length > 0) {
                  setAgentWarning(
                    validateAgent(customName) ? null : `Agent "${customName}" not found in OpenCode.`,
                  );
                } else {
                  setAgentWarning(null);
                }
              }}
              placeholder="Enter agent name…"
              className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
          )}
          <div className="text-[10px] text-muted-foreground">
            {agent.switchTo === 'custom' && agent.customName
              ? `Switch to "${agent.customName}" agent after approval`
              : agent.switchTo === 'disabled'
                ? 'Stay on current agent after approval'
                : `Switch to ${agent.switchTo} agent after approval`}
          </div>
        </div>
      )}
    </div>
  );
};
