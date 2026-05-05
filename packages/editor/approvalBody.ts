import type { Origin } from '@plannotator/shared/agents';
import type { PermissionMode } from '@plannotator/ui/utils/permissionMode';

export type ApprovalOverride = {
  permissionMode?: PermissionMode;
  clearContextNudge?: boolean;
};

export interface ApprovalRequestBody {
  obsidian?: object;
  bear?: object;
  octarine?: object;
  feedback?: string;
  agentSwitch?: string;
  planSave?: { enabled: boolean; customPath?: string };
  permissionMode?: string;
  clearContextNudge?: boolean;
}

export function buildApprovalRequestBody(options: {
  origin: Origin | null;
  permissionMode: PermissionMode;
  override?: ApprovalOverride;
  effectiveAgent?: string;
  planSaveSettings: { enabled: boolean; customPath?: string | null };
}): ApprovalRequestBody {
  const { origin, permissionMode, override = {}, effectiveAgent, planSaveSettings } = options;
  const body: ApprovalRequestBody = {};

  if (origin === 'claude-code') {
    const effectivePermissionMode = override.permissionMode ?? permissionMode;
    body.permissionMode = effectivePermissionMode === 'bypassPermissionsClearReminder'
      ? 'bypassPermissions'
      : effectivePermissionMode;
    if (override.clearContextNudge || effectivePermissionMode === 'bypassPermissionsClearReminder') {
      body.clearContextNudge = true;
    }
  }

  if (origin === 'opencode' && effectiveAgent) {
    body.agentSwitch = effectiveAgent;
  }

  body.planSave = {
    enabled: planSaveSettings.enabled,
    ...(planSaveSettings.customPath && { customPath: planSaveSettings.customPath }),
  };

  return body;
}
