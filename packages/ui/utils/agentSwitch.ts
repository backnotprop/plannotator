import { configStore } from '../config/configStore';

interface AgentSwitchStore {
  get(key: 'agentSwitch'): { switchTo: string; customName?: string } | null;
  set(key: 'agentSwitch', value: { switchTo: string; customName?: string } | null): void;
}

export type AgentSwitchOption = string;

export interface AgentSwitchSettings {
  switchTo: AgentSwitchOption;
  customName?: string;
}

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

/** Default used when the user has never picked an agent switch setting. */
export function getAgentSwitchDefaults(surface: AgentSwitchSurface = 'plan'): AgentSwitchSettings {
  return surface === 'review' ? REVIEW_DEFAULT_SETTINGS : PLAN_DEFAULT_SETTINGS;
}

export function getAgentSwitchSettings(
  surface: AgentSwitchSurface = 'plan',
  store: AgentSwitchStore = configStore,
): AgentSwitchSettings {
  const stored = store.get('agentSwitch');
  return stored ? { ...stored } : getAgentSwitchDefaults(surface);
}

/**
 * Save agent switch settings: cookie at once, config.json through the registry's debounced POST
 * /api/config.
 */
export function saveAgentSwitchSettings(
  settings: AgentSwitchSettings,
  store: AgentSwitchStore = configStore,
): void {
  store.set('agentSwitch', {
    switchTo: settings.switchTo,
    ...(settings.customName && { customName: settings.customName }),
  });
}

/**
 * Get the effective agent name for switching Returns undefined if disabled, otherwise returns
 * the agent name
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

export function agentSwitchTargetLabel(
  setting: AgentSwitchSettings,
  agents: ReadonlyArray<{ id: string; name: string }>,
): string | null {
  if (setting.switchTo === 'disabled') return null;
  if (setting.switchTo === 'custom') return setting.customName || null;
  const match = agents.find((a) => a.id.toLowerCase() === setting.switchTo.toLowerCase());
  return match?.name ?? setting.switchTo;
}
