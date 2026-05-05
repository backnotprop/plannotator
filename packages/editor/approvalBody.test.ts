import { describe, expect, test } from 'bun:test';
import { buildApprovalRequestBody } from './approvalBody';

describe('buildApprovalRequestBody', () => {
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
});
