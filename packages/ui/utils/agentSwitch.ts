/**
 * Agent Switch Settings Utility
 *
 * Manages settings for automatic agent switching after plan approval.
 * Used by OpenCode users who want to disable auto-switch (e.g., oh-my-opencode).
 *
 * Uses cookies (not localStorage) because each hook invocation runs on a
 * random port, and localStorage is scoped by origin including port.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-agent-switch';

export type AgentSwitchOption = 'build' | 'disabled';

export interface AgentSwitchSettings {
  switchTo: AgentSwitchOption;
}

export const AGENT_OPTIONS: { value: AgentSwitchOption; label: string; description: string }[] = [
  { value: 'build', label: 'Build', description: 'Switch to build agent after approval' },
  { value: 'disabled', label: 'Disabled', description: 'Stay on current agent after approval' },
];

const DEFAULT_SETTINGS: AgentSwitchSettings = {
  switchTo: 'build',
};

/**
 * Get current agent switch settings from storage
 */
export function getAgentSwitchSettings(): AgentSwitchSettings {
  const stored = storage.getItem(STORAGE_KEY);
  if (stored === 'disabled' || stored === 'build') {
    return { switchTo: stored };
  }
  return DEFAULT_SETTINGS;
}

/**
 * Save agent switch settings to storage
 */
export function saveAgentSwitchSettings(settings: AgentSwitchSettings): void {
  storage.setItem(STORAGE_KEY, settings.switchTo);
}

/**
 * Check if agent switching is enabled
 */
export function isAgentSwitchEnabled(): boolean {
  return getAgentSwitchSettings().switchTo !== 'disabled';
}
