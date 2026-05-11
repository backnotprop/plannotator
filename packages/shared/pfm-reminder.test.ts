/**
 * Tests for the PFM reminder constant and improve-context composer.
 *
 * Run: bun test packages/shared/pfm-reminder.test.ts
 */

import { describe, expect, test } from "bun:test";
import { ASCII_FLOW_REMINDER, PFM_REMINDER, composeImproveContext } from "./pfm-reminder";

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

  test("stays small enough to inject on every EnterPlanMode call", () => {
    // Soft cap so the reminder doesn't drift into a tutorial. Bump if intentional.
    expect(PFM_REMINDER.length).toBeLessThan(3000);
  });
});

describe("ASCII_FLOW_REMINDER", () => {
  test("identifies itself with a recognizable header", () => {
    expect(ASCII_FLOW_REMINDER).toContain("[ASCII Plan Flow]");
  });

  test("describes the required plan flow contract", () => {
    expect(ASCII_FLOW_REMINDER).toContain("## Plan Flow");
    expect(ASCII_FLOW_REMINDER).toContain("```text");
    expect(ASCII_FLOW_REMINDER).toContain("pure ASCII");
    expect(ASCII_FLOW_REMINDER).toContain("Mermaid");
    expect(ASCII_FLOW_REMINDER).toContain("Graphviz");
    expect(ASCII_FLOW_REMINDER).toContain("5-12 nodes");
  });

  test("stays small enough to inject on every EnterPlanMode call", () => {
    expect(ASCII_FLOW_REMINDER.length).toBeLessThan(1500);
  });
});

describe("composeImproveContext", () => {
  test("returns null when nothing is enabled", () => {
    expect(
      composeImproveContext({ pfmEnabled: false, asciiFlowEnabled: false, improvementHookContent: null }),
    ).toBeNull();
  });

  test("treats empty improvement-hook content the same as null", () => {
    expect(
      composeImproveContext({ pfmEnabled: false, asciiFlowEnabled: false, improvementHookContent: "" }),
    ).toBeNull();
  });

  test("returns just the PFM reminder when only PFM is enabled", () => {
    const ctx = composeImproveContext({
      pfmEnabled: true,
      asciiFlowEnabled: false,
      improvementHookContent: null,
    });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("[Plannotator Flavored Markdown]");
    expect(ctx).not.toContain("[ASCII Plan Flow]");
    expect(ctx).not.toContain("[Plannotator Improvement Hook]");
  });

  test("returns just the ASCII flow reminder when only ASCII flow is enabled", () => {
    const ctx = composeImproveContext({
      pfmEnabled: false,
      asciiFlowEnabled: true,
      improvementHookContent: null,
    });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("[ASCII Plan Flow]");
    expect(ctx).toContain("## Plan Flow");
    expect(ctx).not.toContain("[Plannotator Flavored Markdown]");
    expect(ctx).not.toContain("[Plannotator Improvement Hook]");
  });

  test("returns just the improvement-hook block when only it is set (legacy behavior)", () => {
    const ctx = composeImproveContext({
      pfmEnabled: false,
      asciiFlowEnabled: false,
      improvementHookContent: "1. Always include a test plan section.",
    });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("[Plannotator Improvement Hook]");
    expect(ctx).toContain("The following corrective instructions were generated");
    expect(ctx).toContain("1. Always include a test plan section.");
    expect(ctx).not.toContain("[Plannotator Flavored Markdown]");
    expect(ctx).not.toContain("[ASCII Plan Flow]");
  });

  test("composes reminders and improvement hook in stable order", () => {
    const ctx = composeImproveContext({
      pfmEnabled: true,
      asciiFlowEnabled: true,
      improvementHookContent: "1. Always include a test plan section.",
    })!;

    const pfmIdx = ctx.indexOf("[Plannotator Flavored Markdown]");
    const asciiIdx = ctx.indexOf("[ASCII Plan Flow]");
    const improveIdx = ctx.indexOf("[Plannotator Improvement Hook]");
    expect(pfmIdx).toBeGreaterThanOrEqual(0);
    expect(asciiIdx).toBeGreaterThan(pfmIdx);
    expect(improveIdx).toBeGreaterThan(asciiIdx);

    // A horizontal rule separates the two sections so the agent reads them
    // as distinct payloads.
    const pfmToAscii = ctx.slice(pfmIdx, asciiIdx);
    const asciiToImprove = ctx.slice(asciiIdx, improveIdx);
    expect(pfmToAscii).toContain("\n---\n");
    expect(asciiToImprove).toContain("\n---\n");
  });
});
