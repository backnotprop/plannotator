/**
 * Tests for the PFM reminder constant and improve-context composer.
 *
 * Run: bun test packages/shared/pfm-reminder.test.ts
 */

import { describe, expect, test } from "bun:test";
import { PFM_REMINDER, composeImproveContext } from "./pfm-reminder";
import { parseQuestionBlock } from "./question-block";

describe("PFM_REMINDER", () => {
  test("identifies itself with a recognizable header", () => {
    expect(PFM_REMINDER).toContain("[Plannotator Flavored Markdown]");
  });

  test("covers the headline PFM features the renderer actually supports", () => {
    // If any of these features moves out of the renderer, update both the
    // reminder and this test together.
    expect(PFM_REMINDER).toContain("Code-file links");
    expect(PFM_REMINDER).toContain("> [!NOTE]");
    expect(PFM_REMINDER).toContain("> [!TIP]");
    expect(PFM_REMINDER).toContain("> [!WARNING]");
    expect(PFM_REMINDER).toContain(":::tip");
    expect(PFM_REMINDER).toContain("Tables");
    expect(PFM_REMINDER).toContain("Task lists");
    expect(PFM_REMINDER).toContain("Diagrams");
    expect(PFM_REMINDER).toContain("mermaid");
    expect(PFM_REMINDER).toContain("Wiki-links");
    expect(PFM_REMINDER).toContain("Hex color swatches");
  });

  test("its question block example parses as the renderer parses it", () => {
    // What regresses: the question grammar changes and the reminder keeps
    // teaching agents a block the renderer shows as a plain callout.
    const lines = PFM_REMINDER.split("\n");
    const start = lines.indexOf("  :::question");
    expect(start).toBeGreaterThan(-1);
    const end = lines.indexOf("  :::", start + 1);
    expect(end).toBeGreaterThan(start);
    const body = lines.slice(start + 1, end).map((l) => l.replace(/^ {2}/, "")).join("\n");
    const parsed = parseQuestionBlock("question", body);
    expect(parsed?.kind).toBe("single");
    expect(parsed?.choices.length).toBe(2);
    expect(parsed?.choices.filter((c) => c.recommended).map((c) => c.label)).toEqual(["Redis"]);
    expect(PFM_REMINDER).toContain("- [x]");
  });

  test("is static, so a prompt cache prefix never varies between requests", () => {
    // The reminder is injected on every EnterPlanMode / system transform;
    // any per-request text (a date, a path, a counter) would break caching.
    const a = composeImproveContext({ pfmEnabled: true, improvementHookContent: null });
    const b = composeImproveContext({ pfmEnabled: true, improvementHookContent: null });
    expect(a).toBe(b);
    expect(PFM_REMINDER).not.toMatch(/\{\{|\$\{/);
  });

  test("stays small enough to inject on every EnterPlanMode call", () => {
    // Soft cap so the reminder doesn't drift into a tutorial. Bump if intentional.
    expect(PFM_REMINDER.length).toBeLessThan(3000);
  });
});

describe("composeImproveContext", () => {
  test("returns null when nothing is enabled", () => {
    expect(
      composeImproveContext({ pfmEnabled: false, improvementHookContent: null }),
    ).toBeNull();
  });

  test("treats empty improvement-hook content the same as null", () => {
    expect(
      composeImproveContext({ pfmEnabled: false, improvementHookContent: "" }),
    ).toBeNull();
  });

  test("returns just the PFM reminder when only PFM is enabled", () => {
    const ctx = composeImproveContext({
      pfmEnabled: true,
      improvementHookContent: null,
    });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("[Plannotator Flavored Markdown]");
    expect(ctx).not.toContain("[Plannotator Improvement Hook]");
  });

  test("returns just the improvement-hook block when only it is set (legacy behavior)", () => {
    const ctx = composeImproveContext({
      pfmEnabled: false,
      improvementHookContent: "1. Always include a test plan section.",
    });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("[Plannotator Improvement Hook]");
    expect(ctx).toContain("The following corrective instructions were generated");
    expect(ctx).toContain("1. Always include a test plan section.");
    expect(ctx).not.toContain("[Plannotator Flavored Markdown]");
  });

  test("composes both with PFM reminder first, separated by a divider", () => {
    const ctx = composeImproveContext({
      pfmEnabled: true,
      improvementHookContent: "1. Always include a test plan section.",
    })!;

    const pfmIdx = ctx.indexOf("[Plannotator Flavored Markdown]");
    const improveIdx = ctx.indexOf("[Plannotator Improvement Hook]");
    expect(pfmIdx).toBeGreaterThanOrEqual(0);
    expect(improveIdx).toBeGreaterThan(pfmIdx);

    // A horizontal rule separates the two sections so the agent reads them
    // as distinct payloads.
    const between = ctx.slice(pfmIdx, improveIdx);
    expect(between).toContain("\n---\n");
  });
});
