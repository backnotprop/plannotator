/**
 * Agent Switch Settings Utility
 *
 * Manages settings for automatic agent switching after plan approval.
 * Supports built-in agents (build), disabled, or custom agent names.
 *
 * Uses cookies (not localStorage) because each hook invocation runs on a
 * random port, and localStorage is scoped by origin including port.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-agent-switch';
const CUSTOM_NAME_KEY = 'plannotator-agent-custom';

// AgentSwitchOption is now a string to support dynamic agent names from OpenCode
export type AgentSwitchOption = string;

export interface AgentSwitchSettings {
  switchTo: AgentSwitchOption;
  customName?: string;
}

// Fallback options when API is unavailable or for non-OpenCode origins
export const AGENT_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: 'build', label: 'Build', description: 'Switch to build agent after approval' },
  { value: 'custom', label: 'Custom', description: 'Switch to a custom agent after approval' },
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
  const customName = storage.getItem(CUSTOM_NAME_KEY) || undefined;

  // Accept any non-empty string (supports dynamic agent names from OpenCode)
  if (stored) {
    return { switchTo: stored, customName };
  }
  return DEFAULT_SETTINGS;
}

/**
 * Save agent switch settings to storage
 */
export function saveAgentSwitchSettings(settings: AgentSwitchSettings): void {
  storage.setItem(STORAGE_KEY, settings.switchTo);
  if (settings.customName) {
    storage.setItem(CUSTOM_NAME_KEY, settings.customName);
  }
}

/**
 * Get the effective agent name for switching
 * Returns undefined if disabled, otherwise returns the agent name
 */
export function getEffectiveAgentName(settings: AgentSwitchSettings): string | undefined {
  if (settings.switchTo === 'disabled') {
    return undefined;
  }
  if (settings.switchTo === 'custom' && settings.customName) {
    return settings.customName;
  }
  return settings.switchTo; // 'build' or fallback
}
