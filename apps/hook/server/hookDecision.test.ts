import { describe, expect, test } from "bun:test";
import { formatClaudePlanHookOutput } from "./hookDecision";

describe("formatClaudePlanHookOutput", () => {
  test("native handoff emits PreToolUse ask only when native clear was enabled", () => {
    expect(formatClaudePlanHookOutput({
      result: { approved: true, permissionMode: "bypassPermissions", deferToNativeForClear: true },
      hookEventName: "PreToolUse",
      toolName: "ExitPlanMode",
      detectedOrigin: "claude-code",
      nativeClearEnabled: true,
    })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    });
  });

  test("PermissionRequest native defer falls back to explicit allow JSON", () => {
    const output = formatClaudePlanHookOutput({
      result: { approved: true, deferToNativeForClear: true },
      hookEventName: "PermissionRequest",
      toolName: "ExitPlanMode",
      detectedOrigin: "claude-code",
      nativeClearEnabled: true,
    }) as any;

    expect(output.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(output.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(output.hookSpecificOutput.decision.updatedPermissions).toEqual([
      { type: "setMode", mode: "bypassPermissions", destination: "session" },
    ]);
    expect(output.systemMessage).toContain("/clear");
  });

  test("normal PermissionRequest approval includes updatedPermissions", () => {
    expect(formatClaudePlanHookOutput({
      result: { approved: true, permissionMode: "bypassPermissions", clearContextNudge: true },
      hookEventName: "PermissionRequest",
      toolName: "ExitPlanMode",
      detectedOrigin: "claude-code",
    })).toEqual({
      systemMessage: expect.stringContaining("/clear"),
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [
            { type: "setMode", mode: "bypassPermissions", destination: "session" },
          ],
        },
      },
    });
  });
});
