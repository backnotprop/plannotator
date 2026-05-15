import { describe, expect, test } from "bun:test";
import {
  normalizeEditPermission,
  stripConflictingPlanModeRules,
} from "./plan-mode";

describe("normalizeEditPermission", () => {
  test("returns empty object for undefined", () => {
    expect(normalizeEditPermission(undefined)).toEqual({});
  });

  test("converts 'deny' string to wildcard object", () => {
    // Triggered by `tools: { edit: false }` or `permission: { edit: "deny" }`
    expect(normalizeEditPermission("deny")).toEqual({ "*": "deny" });
  });

  test("converts 'allow' string to wildcard object", () => {
    expect(normalizeEditPermission("allow")).toEqual({ "*": "allow" });
  });

  test("converts 'ask' string to wildcard object", () => {
    expect(normalizeEditPermission("ask")).toEqual({ "*": "ask" });
  });

  test("passes through an existing object unchanged", () => {
    const obj = { "*.ts": "deny", "src/**": "allow" };
    expect(normalizeEditPermission(obj)).toEqual(obj);
  });

  test("merging with '*.md': 'allow' preserves deny-all + md-allow", () => {
    // This is the main scenario fixed by this function:
    // user has tools: { edit: false } which produces permission.edit = "deny",
    // and we need to merge in "*.md": "allow" without string-spreading.
    const base = normalizeEditPermission("deny");
    const merged = { ...base, "*.md": "allow" };
    expect(merged).toEqual({ "*": "deny", "*.md": "allow" });
    // Crucially, no char-index keys like "0", "1", "2", "3"
    expect(Object.keys(merged)).not.toContain("0");
  });
});

describe("stripConflictingPlanModeRules", () => {
  test("removes OpenCode's blanket file-edit prohibition", () => {
    expect(
      stripConflictingPlanModeRules([
        "Read-only mode\nSTRICTLY FORBIDDEN: ANY file edits.\nUse the tools carefully.",
      ]),
    ).toEqual(["Read-only mode\nUse the tools carefully."]);
  });

  test("drops conversation-only plan storage lines and keeps unrelated instructions", () => {
    expect(
      stripConflictingPlanModeRules([
        "The plan lives only in the agent's conversation, not on disk.\nKeep the plan concise.",
      ]),
    ).toEqual(["Keep the plan concise."]);
  });

  test("drops experimental plan path lines", () => {
    expect(
      stripConflictingPlanModeRules([
        "Create your plan at /tmp/.opencode/plans/1234-test.md\nKeep the plan concise.",
      ]),
    ).toEqual(["Keep the plan concise."]);
  });

  test("drops experimental plan_exit instructions", () => {
    expect(
      stripConflictingPlanModeRules([
        "Call plan_exit when the plan is ready.\nKeep the plan concise.",
      ]),
    ).toEqual(["Keep the plan concise."]);
  });
});
