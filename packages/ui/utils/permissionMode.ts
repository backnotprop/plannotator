/**
 * Permission Mode Settings Utility (Claude Code only)
 *
 * Manages the preferred permission mode to restore after plan approval.
 * Claude Code 2.1.7+ supports updatedPermissions in hook responses.
 *
 * Available modes:
 * - acceptEdits: Auto-approve file edits only
 * - auto: Autonomous execution gated by a model-based safety classifier (Claude Code 2026-03+, Sonnet 4.6+)
 * - bypassPermissions: Auto-approve all tool calls
 * - default: Manually approve each tool call
 */

import { storage } from "./storage";

const STORAGE_KEY_MODE = "plannotator-permission-mode";
const STORAGE_KEY_CONFIGURED = "plannotator-permission-mode-configured";

export type PermissionMode =
  | "bypassPermissions"
  | "acceptEdits"
  | "auto"
  | "default"
  | "deferNative";

export interface PermissionModeSettings {
  mode: PermissionMode;
  configured: boolean; // Whether user has explicitly set this
}

export const PERMISSION_MODE_OPTIONS: {
  value: PermissionMode;
  label: string;
  description: string;
}[] = [
  {
    value: "acceptEdits",
    label: "Auto-accept Edits",
    description: "Auto-approve file edits, ask for other tools",
  },
  {
    value: "auto",
    label: "Auto Mode",
    description:
      "Autonomous execution with a safety classifier (requires Claude Code 2026-03+ and Sonnet 4.6+)",
  },
  {
    value: "bypassPermissions",
    label: "Bypass Permissions",
    description:
      "Auto-approve all tool calls (equivalent to --dangerously-skip-permissions)",
  },
  {
    value: "default",
    label: "Manual Approval",
    description: "Manually approve each tool call",
  },
  {
    value: "deferNative",
    label: "Clear context + bypass (native)",
    description:
      "Hand approval to Claude Code's own menu, which offers clear-context + bypass (needs showClearContextOnPlanAccept).",
  },
];

const DEFAULT_MODE: PermissionMode = "acceptEdits";

function isPermissionMode(value: string | null): value is PermissionMode {
  return PERMISSION_MODE_OPTIONS.some((option) => option.value === value);
}

/**
 * Get current permission mode settings from storage
 */
export function getPermissionModeSettings(): PermissionModeSettings {
  const mode = storage.getItem(STORAGE_KEY_MODE);
  const configured = storage.getItem(STORAGE_KEY_CONFIGURED) === "true";

  return {
    mode: isPermissionMode(mode) ? mode : DEFAULT_MODE,
    configured,
  };
}

/**
 * Save permission mode settings to storage
 */
export function savePermissionModeSettings(mode: PermissionMode): void {
  storage.setItem(STORAGE_KEY_MODE, mode);
  storage.setItem(STORAGE_KEY_CONFIGURED, "true");
}

/**
 * Check if the user needs to configure their permission mode preference
 */
export function needsPermissionModeSetup(): boolean {
  return storage.getItem(STORAGE_KEY_CONFIGURED) !== "true";
}
