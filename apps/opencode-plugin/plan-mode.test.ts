import { describe, expect, test } from "bun:test";
import {
  composeSystemPrompt,
  normalizeEditPermission,
  stripConflictingPlanModeRules,
} from "./plan-mode";

describe("normalizeEditPermission", () => {
  test("returns empty object for undefined", () => {
    expect(normalizeEditPermission(undefined)).toEqual({});
  });

  test("converts 'deny' string to wildcard object", () => {
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
    const base = normalizeEditPermission("deny");
    const merged = { ...base, "*.md": "allow" };
    expect(merged).toEqual({ "*": "deny", "*.md": "allow" });
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

describe("stripConflictingPlanModeRules for OpenCode 2 (#2101)", () => {
  const lines = [
    "You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:",
    "/home/dev/.opencode/plan",
    "C:\\Users\\dev\\.opencode\\plan\\",
    "Do not create or update plan files.",
    "Keep the plan concise.",
    "Notes live in .opencode/planning-notes.md.",
  ].join("\n");

  test("with openCode2 the new wording and the singular plan directory are stripped", () => {
    expect(stripConflictingPlanModeRules([lines], { openCode2: true })).toEqual([
      "Keep the plan concise.\nNotes live in .opencode/planning-notes.md.",
    ]);
  });

  test("without it (OpenCode 1) the same lines are kept, exactly as before", () => {
    expect(stripConflictingPlanModeRules([lines])).toEqual([lines]);
    expect(stripConflictingPlanModeRules([lines], {})).toEqual([lines]);
  });
});

describe("composeSystemPrompt", () => {
  test.each([
    ["always one element", ["a"], ["b"], ["a\n\nb"]],
    ["empty strip case", [], ["prompt"], ["prompt"]],
    ["multi-element order", ["base", "extra"], ["add1", "add2"], ["base\n\nextra\n\nadd1\n\nadd2"]],
    ["content order (plan path)", ["strip1"], ["plan", "improve"], ["strip1\n\nplan\n\nimprove"]],
    ["trailing newlines trimmed", ["base\n"], ["add\n\n"], ["base\n\nadd"]],
    ["empty string entry collapses", ["", "a"], ["b"], ["a\n\nb"]],
    ["empty inputs", [], [], [""]],
  ])("%s", (_name, system, additions, expected) => {
    expect(composeSystemPrompt(system, additions)).toEqual(expected);
  });
});
