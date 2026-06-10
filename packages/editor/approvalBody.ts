import type { Origin } from "@plannotator/shared/agents";
import type { PermissionMode } from "@plannotator/ui/utils/permissionMode";

export type ApprovalOverride = {
  permissionMode?: PermissionMode;
  clearContextNudge?: boolean;
  deferToNativeForClear?: boolean;
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
  deferToNativeForClear?: boolean;
}

export function shouldEnableNativeClearBeforeApprove(options: {
  origin: Origin | null;
  toolName?: string;
  override?: ApprovalOverride;
}): boolean {
  return (
    options.origin === "claude-code" &&
    options.toolName === "ExitPlanMode" &&
    options.override?.deferToNativeForClear === true
  );
}

export function buildApprovalRequestBody(options: {
  origin: Origin | null;
  permissionMode: PermissionMode;
  override?: ApprovalOverride;
  effectiveAgent?: string;
  planSaveSettings: { enabled: boolean; customPath?: string | null };
  toolName?: string;
}): ApprovalRequestBody {
  const {
    origin,
    permissionMode,
    override = {},
    effectiveAgent,
    planSaveSettings,
    toolName,
  } = options;
  const body: ApprovalRequestBody = {};

  if (origin === "claude-code") {
    const effectivePermissionMode = override.permissionMode ?? permissionMode;
    const useNativeClear = shouldEnableNativeClearBeforeApprove({
      origin,
      toolName,
      override,
    });

    body.permissionMode = effectivePermissionMode;

    if (useNativeClear) {
      body.deferToNativeForClear = true;
    } else if (override.clearContextNudge) {
      body.clearContextNudge = true;
    }
  }

  if (origin === "opencode" && effectiveAgent) {
    body.agentSwitch = effectiveAgent;
  }

  body.planSave = {
    enabled: planSaveSettings.enabled,
    ...(planSaveSettings.customPath && {
      customPath: planSaveSettings.customPath,
    }),
  };

  return body;
}
