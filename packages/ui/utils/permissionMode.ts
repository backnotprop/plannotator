/**
 * Permission Mode Settings Utility (Claude Code only)
 *
 * Manages the preferred permission mode to restore after plan approval.
 * Claude Code 2.1.7+ supports updatedPermissions in hook responses.
 *
 * Available modes:
 * - bypassPermissions: Auto-approve all tool calls
 * - bypassPermissionsClearReminder: Persisted UI mode that sends bypassPermissions plus a /clear reminder nudge
 * - acceptEdits: Auto-approve file edits only
 * - default: Manually approve each tool call
 */

import { storage } from './storage';

const STORAGE_KEY_MODE = 'plannotator-permission-mode';
const STORAGE_KEY_CONFIGURED = 'plannotator-permission-mode-configured';

export type PermissionMode = 'bypassPermissions' | 'bypassPermissionsClearReminder' | 'acceptEdits' | 'default';

export interface PermissionModeSettings {
  mode: PermissionMode;
  configured: boolean; // Whether user has explicitly set this
}

export const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string; description: string }[] = [
  {
    value: 'acceptEdits',
    label: 'Auto-accept Edits',
    description: 'Auto-approve file edits, ask for other tools',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass Permissions',
    description: 'Auto-approve all tool calls (equivalent to --dangerously-skip-permissions)',
  },
  {
    value: 'bypassPermissionsClearReminder',
    label: 'Bypass + /clear Reminder',
    description: 'Auto-approve all tool calls and emit a system message reminding you to run /clear (hooks cannot clear context directly).',
  },
  {
    value: 'default',
    label: 'Manual Approval',
    description: 'Manually approve each tool call',
  },
];

const DEFAULT_MODE: PermissionMode = 'acceptEdits';

function isPermissionMode(value: string | null): value is PermissionMode {
  return PERMISSION_MODE_OPTIONS.some((option) => option.value === value);
}

/**
 * Get current permission mode settings from storage
 */
export function getPermissionModeSettings(): PermissionModeSettings {
  const mode = storage.getItem(STORAGE_KEY_MODE);
  const configured = storage.getItem(STORAGE_KEY_CONFIGURED) === 'true';

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
  storage.setItem(STORAGE_KEY_CONFIGURED, 'true');
}

/**
 * Check if the user needs to configure their permission mode preference
 */
export function needsPermissionModeSetup(): boolean {
  return storage.getItem(STORAGE_KEY_CONFIGURED) !== 'true';
}
