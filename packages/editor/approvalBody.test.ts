import { describe, expect, test } from 'bun:test';
import { buildApprovalRequestBody } from './approvalBody';

describe('buildApprovalRequestBody', () => {
  test('maps bypass clear reminder mode to native Claude Code clear on ExitPlanMode', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'bypassPermissionsClearReminder',
      toolName: 'ExitPlanMode',
      planSaveSettings: { enabled: true },
    })).toEqual({
      permissionMode: 'bypassPermissions',
      deferToNativeForClear: true,
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

  test('uses native clear for bypass clear reminder override when ExitPlanMode is known', () => {
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
      deferToNativeForClear: true,
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
      planSaveSettings: { enabled: true },
    })).toEqual({
      agentSwitch: 'build',
      planSave: { enabled: true },
    });
  });

  test('forwards deferToNativeForClear for Claude Code bypass approvals', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'acceptEdits',
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

  test('does not forward deferToNativeForClear for OpenCode approvals', () => {
    expect(buildApprovalRequestBody({
      origin: 'opencode',
      permissionMode: 'acceptEdits',
      effectiveAgent: 'build',
      override: {
        deferToNativeForClear: true,
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      agentSwitch: 'build',
      planSave: { enabled: true },
    });
  });

  test('does not forward deferToNativeForClear for Gemini origin', () => {
    expect(buildApprovalRequestBody({
      origin: 'gemini-cli',
      permissionMode: 'acceptEdits',
      override: {
        deferToNativeForClear: true,
      },
      planSaveSettings: { enabled: true },
    })).toEqual({
      planSave: { enabled: true },
    });
  });
});
