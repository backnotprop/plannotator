/**
 * Agent Switching Settings
 * 
 * Uses cookies (not localStorage) because each hook invocation runs on a
 * random port, and localStorage is scoped by origin including port.
 */

import { storage } from './storage';

const STORAGE_KEY_AGENT = 'plannotator-agent-switch';

export type AgentSwitchOption = 'disabled' | 'build';

export interface AgentSettings {
  switchTo: AgentSwitchOption;
}

export const AGENT_OPTIONS: { value: AgentSwitchOption; label: string; description: string }[] = [
  { value: 'build', label: 'Build', description: 'Switch to build agent after approval' },
  { value: 'disabled', label: 'Disabled', description: 'Stay on current agent after approval' },
];

const DEFAULT_SETTINGS: AgentSettings = {
  switchTo: 'build',
};

export function getAgentSettings(): AgentSettings {
  const stored = storage.getItem(STORAGE_KEY_AGENT);
  if (stored && (stored === 'disabled' || stored === 'build')) {
    return { switchTo: stored };
  }
  return DEFAULT_SETTINGS;
}

export function saveAgentSettings(settings: AgentSettings): void {
  storage.setItem(STORAGE_KEY_AGENT, settings.switchTo);
}

export function isAgentSwitchEnabled(): boolean {
  return getAgentSettings().switchTo !== 'disabled';
}
