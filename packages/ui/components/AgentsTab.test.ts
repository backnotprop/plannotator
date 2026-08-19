import { describe, expect, test } from "bun:test";
import { CLAUDE_MODELS, CODEX_MODELS, TOUR_CLAUDE_MODELS, codexReasoningOptions } from "./AgentsTab";

const catalogEntry = (value: string) => CODEX_MODELS.find((m) => m.value === value);

describe("CLAUDE_MODELS catalog", () => {
  test("offers the current 5-series flagships", () => {
    for (const value of ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]) {
      expect(CLAUDE_MODELS.some((m) => m.value === value)).toBe(true);
    }
    expect(CLAUDE_MODELS.find((m) => m.value === "claude-opus-5")?.label).toBe("Opus 5");
  });

  // The 5-series models are 1M-context by default, so they carry no `[1m]`
  // variant — that suffix exists only to opt the older 4.x models into the
  // larger window. Pinned so a future entry doesn't invent `claude-opus-5[1m]`.
  test("5-series entries have no [1m] context variant", () => {
    for (const { value } of CLAUDE_MODELS) {
      if (/-5(\[|$)/.test(value)) expect(value).not.toContain("[1m]");
    }
  });

  test("tour/guide catalog inherits every review model plus the latest aliases", () => {
    for (const { value } of CLAUDE_MODELS) {
      expect(TOUR_CLAUDE_MODELS.some((m) => m.value === value)).toBe(true);
    }
    for (const alias of ["sonnet", "opus", "fable"]) {
      expect(TOUR_CLAUDE_MODELS.some((m) => m.value === alias)).toBe(true);
    }
  });
});

test("uses the canonical GPT-5.6 Sol model ID", () => {
  expect(catalogEntry("gpt-5.6-sol")?.label).toBe("GPT-5.6 Sol");
  expect(CODEX_MODELS.some(({ value }) => value === "gpt-5.6")).toBe(false);
});

describe("CODEX_MODELS catalog", () => {
  test("omits models rejected or API-shut-down for every auth mode", () => {
    // gpt-5.3-codex: ChatGPT-account Codex rejects it outright. The other
    // three: API-level shutdown 2026-07-23 per OpenAI's deprecations page.
    for (const value of ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini"]) {
      expect(CODEX_MODELS.some((m) => m.value === value)).toBe(false);
    }
  });

  test("keeps gpt-5.2 (still API-valid) with the historical effort set", () => {
    expect(catalogEntry("gpt-5.2")?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("GPT-5.6 family carries the CLI catalog's efforts and defaults", () => {
    expect(catalogEntry("gpt-5.6-sol")).toEqual({
      value: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "low",
    });
    expect(catalogEntry("gpt-5.6-terra")).toEqual({
      value: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "medium",
    });
    expect(catalogEntry("gpt-5.6-luna")).toEqual({
      value: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
    });
  });

  test("spark defaults to high; 5.5/5.4 default to medium", () => {
    expect(catalogEntry("gpt-5.3-codex-spark")?.defaultEffort).toBe("high");
    expect(catalogEntry("gpt-5.5")?.defaultEffort).toBe("medium");
    expect(catalogEntry("gpt-5.4")?.defaultEffort).toBe("medium");
    expect(catalogEntry("gpt-5.4-mini")?.defaultEffort).toBe("medium");
  });

  test("no model offers minimal, and every default effort is supported", () => {
    for (const model of CODEX_MODELS) {
      expect(model.efforts).not.toContain("minimal");
      expect(model.efforts).toContain(model.defaultEffort);
    }
  });
});

describe("codexReasoningOptions", () => {
  test("offers only the selected model's efforts, with Max/Ultra labels", () => {
    expect(codexReasoningOptions("gpt-5.6-sol")).toEqual([
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "XHigh" },
      { value: "max", label: "Max" },
      { value: "ultra", label: "Ultra" },
    ]);
    expect(codexReasoningOptions("gpt-5.5").map(({ value }) => value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("falls back to the low..xhigh set for unknown models", () => {
    expect(codexReasoningOptions("future-codex-model").map(({ value }) => value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});
