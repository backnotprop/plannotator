import { describe, expect, test } from 'bun:test';
import { buildApprovalRequestBody, shouldEnableNativeClearBeforeApprove } from './approvalBody';

describe('shouldEnableNativeClearBeforeApprove', () => {
  test('enables native clear for explicit Claude Code ExitPlanMode overrides', () => {
    expect(shouldEnableNativeClearBeforeApprove({
      origin: 'claude-code',
      permissionMode: 'acceptEdits',
      toolName: 'ExitPlanMode',
      override: { deferToNativeForClear: true },
    })).toBe(true);
  });

  test('does not enable native clear for saved bypass clear mode', () => {
    expect(shouldEnableNativeClearBeforeApprove({
      origin: 'claude-code',
      permissionMode: 'bypassPermissionsClearReminder',
      toolName: 'ExitPlanMode',
    })).toBe(false);

    expect(shouldEnableNativeClearBeforeApprove({
      origin: 'claude-code',
      permissionMode: 'acceptEdits',
      toolName: 'ExitPlanMode',
      override: { permissionMode: 'bypassPermissionsClearReminder' },
    })).toBe(false);
  });

  test('does not enable native clear outside Claude Code ExitPlanMode', () => {
    expect(shouldEnableNativeClearBeforeApprove({
      origin: 'claude-code',
      permissionMode: 'bypassPermissionsClearReminder',
      toolName: 'OtherTool',
    })).toBe(false);

    expect(shouldEnableNativeClearBeforeApprove({
      origin: 'opencode',
      permissionMode: 'bypassPermissionsClearReminder',
      toolName: 'ExitPlanMode',
      override: { deferToNativeForClear: true },
    })).toBe(false);

    expect(shouldEnableNativeClearBeforeApprove({
      origin: 'gemini-cli',
      permissionMode: 'bypassPermissionsClearReminder',
      toolName: 'ExitPlanMode',
      override: { deferToNativeForClear: true },
    })).toBe(false);
  });
});

describe('buildApprovalRequestBody', () => {
  test('maps saved bypass clear reminder mode to hook approval with clear reminder on Claude Code ExitPlanMode', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'bypassPermissionsClearReminder',
      toolName: 'ExitPlanMode',
      planSaveSettings: { enabled: true },
    })).toEqual({
      permissionMode: 'bypassPermissions',
      clearContextNudge: true,
      planSave: { enabled: true },
    });
  });

  test('maps bypass clear reminder mode to reminder fallback outside ExitPlanMode', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'bypassPermissionsClearReminder',
      toolName: 'OtherTool',
      planSaveSettings: { enabled: true },
    })).toEqual({
      permissionMode: 'bypassPermissions',
      clearContextNudge: true,
      planSave: { enabled: true },
    });
  });

  test('omits agentSwitch for Claude Code approvals', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'acceptEdits',
      effectiveAgent: 'build',
      override: {
        permissionMode: 'bypassPermissions',
        clearContextNudge: true,
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      permissionMode: 'bypassPermissions',
      clearContextNudge: true,
      planSave: { enabled: true },
    });
  });

  test('keeps bypass clear reminder override fallback fields for Claude Code approvals without ExitPlanMode', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'acceptEdits',
      override: {
        permissionMode: 'bypassPermissionsClearReminder',
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      permissionMode: 'bypassPermissions',
      clearContextNudge: true,
      planSave: { enabled: true },
    });
  });

  test('uses reminder fallback for bypass clear reminder override when ExitPlanMode is known', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'acceptEdits',
      toolName: 'ExitPlanMode',
      override: {
        permissionMode: 'bypassPermissionsClearReminder',
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      permissionMode: 'bypassPermissions',
      clearContextNudge: true,
      planSave: { enabled: true },
    });
  });

  test('keeps agentSwitch for OpenCode approvals', () => {
    expect(buildApprovalRequestBody({
      origin: 'opencode',
      permissionMode: 'acceptEdits',
      effectiveAgent: 'build',
      planSaveSettings: { enabled: true },
    })).toEqual({
      agentSwitch: 'build',
      planSave: { enabled: true },
    });
  });

  test('ignores bypass clear reminder mode for OpenCode approvals', () => {
    expect(buildApprovalRequestBody({
      origin: 'opencode',
      permissionMode: 'bypassPermissionsClearReminder',
      effectiveAgent: 'build',
      toolName: 'ExitPlanMode',
      planSaveSettings: { enabled: true },
    })).toEqual({
      agentSwitch: 'build',
      planSave: { enabled: true },
    });
  });

  test('forwards deferToNativeForClear for explicit Claude Code ExitPlanMode bypass approvals', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'acceptEdits',
      toolName: 'ExitPlanMode',
      override: {
        permissionMode: 'bypassPermissions',
        deferToNativeForClear: true,
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      permissionMode: 'bypassPermissions',
      deferToNativeForClear: true,
      planSave: { enabled: true },
    });
  });

  test('does not forward deferToNativeForClear without ExitPlanMode', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'acceptEdits',
      toolName: 'OtherTool',
      override: {
        permissionMode: 'bypassPermissions',
        deferToNativeForClear: true,
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      permissionMode: 'bypassPermissions',
      planSave: { enabled: true },
    });
  });

  test('does not forward deferToNativeForClear or native clear for OpenCode approvals', () => {
    expect(buildApprovalRequestBody({
      origin: 'opencode',
      permissionMode: 'bypassPermissionsClearReminder',
      effectiveAgent: 'build',
      toolName: 'ExitPlanMode',
      override: {
        deferToNativeForClear: true,
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      agentSwitch: 'build',
      planSave: { enabled: true },
    });
  });

  test('does not forward deferToNativeForClear or native clear for Gemini origin', () => {
    expect(buildApprovalRequestBody({
      origin: 'gemini-cli',
      permissionMode: 'bypassPermissionsClearReminder',
      toolName: 'ExitPlanMode',
      override: {
        deferToNativeForClear: true,
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      planSave: { enabled: true },
    });
  });
});
