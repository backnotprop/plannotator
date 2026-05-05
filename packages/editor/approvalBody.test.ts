import { describe, expect, test } from 'bun:test';
import { buildApprovalRequestBody } from './approvalBody';

describe('buildApprovalRequestBody', () => {
  test('maps bypass clear reminder mode to Claude Code wire fields', () => {
    expect(buildApprovalRequestBody({
      origin: 'claude-code',
      permissionMode: 'bypassPermissionsClearReminder',
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

  test('keeps bypass clear reminder override wire fields for Claude Code approvals', () => {
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
});
