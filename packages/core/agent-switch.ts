/** A choice as the UI holds it. `switchTo` is "disabled", "custom" or an agent name. */
export interface AgentSwitchChoice {
  switchTo: string;
  customName?: string;
}

/** What config.json holds under `agentSwitch`. */
export type AgentSwitchConfigValue = string | { switchTo: "custom"; customName: string };

/** Longest agent name accepted. OpenCode agent names are short identifiers. */
export const AGENT_SWITCH_NAME_MAX = 128;

export function isAgentSwitchName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > AGENT_SWITCH_NAME_MAX) return false;
  if (value.trim() !== value) return false;
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

/** Read a config.json (or POST /api/config) value. */
export function parseAgentSwitchConfig(value: unknown): AgentSwitchChoice | undefined {
  if (isAgentSwitchName(value)) return { switchTo: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.switchTo !== "custom") return undefined;
  if (!isAgentSwitchName(record.customName)) return undefined;
  return { switchTo: "custom", customName: record.customName };
}

export function agentSwitchConfigValue(choice: AgentSwitchChoice): AgentSwitchConfigValue | undefined {
  if (choice.switchTo === "custom" && isAgentSwitchName(choice.customName)) {
    return { switchTo: "custom", customName: choice.customName };
  }
  return isAgentSwitchName(choice.switchTo) ? choice.switchTo : undefined;
}
