import { storage } from './storage';

const STORAGE_KEY_MODE = 'plannotator-permission-mode';
const STORAGE_KEY_CONFIGURED = 'plannotator-permission-mode-configured';

export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'auto' | 'default';

export interface PermissionModeSettings {
  mode: PermissionMode;
  configured: boolean;
}

export const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string; description: string }[] = [
  {
    value: 'acceptEdits',
    label: 'Auto-accept Edits',
    description: 'Auto-approve file edits, ask for other tools',
  },
  {
    value: 'auto',
    label: 'Auto Mode',
    description: 'Autonomous execution with a safety classifier (requires Claude Code 2026-03+ and Sonnet 4.6+)',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass Permissions',
    description: 'Auto-approve all tool calls (equivalent to --dangerously-skip-permissions)',
  },
  {
    value: 'default',
    label: 'Manual Approval',
    description: 'Manually approve each tool call',
  },
];

const DEFAULT_MODE: PermissionMode = 'acceptEdits';

export function getPermissionModeSettings(): PermissionModeSettings {
  const mode = storage.getItem(STORAGE_KEY_MODE) as PermissionMode | null;
  const configured = storage.getItem(STORAGE_KEY_CONFIGURED) === 'true';

  return {
    mode: mode || DEFAULT_MODE,
    configured,
  };
}

export function savePermissionModeSettings(mode: PermissionMode): void {
  storage.setItem(STORAGE_KEY_MODE, mode);
  storage.setItem(STORAGE_KEY_CONFIGURED, 'true');
}

export function needsPermissionModeSetup(): boolean {
  return storage.getItem(STORAGE_KEY_CONFIGURED) !== 'true';
}
