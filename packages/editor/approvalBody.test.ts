import { describe, expect, test } from "bun:test";
import {
  buildApprovalRequestBody,
  shouldEnableNativeClearBeforeApprove,
} from "./approvalBody";

describe("shouldEnableNativeClearBeforeApprove", () => {
  test("enables native clear only for explicit Claude Code ExitPlanMode overrides", () => {
    expect(
      shouldEnableNativeClearBeforeApprove({
        origin: "claude-code",
        toolName: "ExitPlanMode",
        override: { deferToNativeForClear: true },
      }),
    ).toBe(true);

    expect(
      shouldEnableNativeClearBeforeApprove({
        origin: "claude-code",
        toolName: "ExitPlanMode",
        override: { permissionMode: "acceptEdits" },
      }),
    ).toBe(false);

    expect(
      shouldEnableNativeClearBeforeApprove({
        origin: "claude-code",
        toolName: "OtherTool",
        override: { deferToNativeForClear: true },
      }),
    ).toBe(false);
  });
});

describe("buildApprovalRequestBody", () => {
  test("omits agentSwitch for Claude Code approvals", () => {
    expect(
      buildApprovalRequestBody({
        origin: "claude-code",
        permissionMode: "acceptEdits",
        effectiveAgent: "build",
        override: {
          permissionMode: "bypassPermissions",
          clearContextNudge: true,
        },
        planSaveSettings: { enabled: true },
      }),
    ).toEqual({
      permissionMode: "bypassPermissions",
      clearContextNudge: true,
      planSave: { enabled: true },
    });
  });

  test("keeps agentSwitch for OpenCode approvals", () => {
    expect(
      buildApprovalRequestBody({
        origin: "opencode",
        permissionMode: "acceptEdits",
        effectiveAgent: "build",
        planSaveSettings: { enabled: true },
      }),
    ).toEqual({
      agentSwitch: "build",
      planSave: { enabled: true },
    });
  });

  test("forwards deferToNativeForClear only for explicit Claude Code ExitPlanMode bypass approvals", () => {
    expect(
      buildApprovalRequestBody({
        origin: "claude-code",
        permissionMode: "acceptEdits",
        toolName: "ExitPlanMode",
        override: {
          permissionMode: "bypassPermissions",
          deferToNativeForClear: true,
        },
        planSaveSettings: { enabled: true },
      }),
    ).toEqual({
      permissionMode: "bypassPermissions",
      deferToNativeForClear: true,
      planSave: { enabled: true },
    });
  });

  test("does not forward deferToNativeForClear without ExitPlanMode", () => {
    expect(
      buildApprovalRequestBody({
        origin: "claude-code",
        permissionMode: "acceptEdits",
        toolName: "OtherTool",
        override: {
          permissionMode: "bypassPermissions",
          deferToNativeForClear: true,
        },
        planSaveSettings: { enabled: true },
      }),
    ).toEqual({
      permissionMode: "bypassPermissions",
      planSave: { enabled: true },
    });
  });

  test("does not forward deferToNativeForClear for OpenCode approvals", () => {
    expect(
      buildApprovalRequestBody({
        origin: "opencode",
        permissionMode: "acceptEdits",
        effectiveAgent: "build",
        override: {
          deferToNativeForClear: true,
        },
        planSaveSettings: { enabled: true },
      }),
    ).toEqual({
      agentSwitch: "build",
      planSave: { enabled: true },
    });
  });

  test("does not forward deferToNativeForClear for Gemini origin", () => {
    expect(
      buildApprovalRequestBody({
        origin: "gemini-cli",
        permissionMode: "acceptEdits",
        override: {
          deferToNativeForClear: true,
        },
        planSaveSettings: { enabled: true },
      }),
    ).toEqual({
      planSave: { enabled: true },
    });
  });
});
