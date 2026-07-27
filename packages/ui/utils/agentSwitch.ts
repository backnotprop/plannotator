/**
 * Agent Switch Settings Utility
 *
 * Manages settings for automatic agent switching after plan approval and after
 * sending code review feedback. Supports discovered agents, disabled, or custom
 * agent names.
 *
 * The stored value is shared across surfaces, but the default when nothing is
 * stored is surface-specific: plan approval keeps its historical hand-off to the
 * build agent, while review feedback stays on the current agent.
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

/** UI surface asking for the setting — only affects the unset default. */
export type AgentSwitchSurface = 'plan' | 'review';

const PLAN_DEFAULT_SETTINGS: AgentSwitchSettings = {
  switchTo: 'build',
};

const REVIEW_DEFAULT_SETTINGS: AgentSwitchSettings = {
  switchTo: 'disabled',
};

/**
 * Default used when the user has never picked an agent switch setting.
 * Plan approval hands off to the build agent (historical behavior); review
 * feedback stays on the current agent.
 */
export function getAgentSwitchDefaults(surface: AgentSwitchSurface = 'plan'): AgentSwitchSettings {
  return surface === 'review' ? REVIEW_DEFAULT_SETTINGS : PLAN_DEFAULT_SETTINGS;
}

/**
 * Get current agent switch settings from storage.
 * An explicit user choice applies to every surface; only the unset default
 * varies by surface.
 */
export function getAgentSwitchSettings(surface: AgentSwitchSurface = 'plan'): AgentSwitchSettings {
  const stored = storage.getItem(STORAGE_KEY);
  const customName = storage.getItem(CUSTOM_NAME_KEY) || undefined;

  // Accept any non-empty string (supports dynamic agent names from OpenCode)
  if (stored) {
    return { switchTo: stored, customName };
  }
  return getAgentSwitchDefaults(surface);
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
  if (settings.switchTo === 'custom') {
    return undefined;
  }
  return settings.switchTo;
}
