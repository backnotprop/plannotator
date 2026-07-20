import { describe, expect, test } from "bun:test";
import { CODEX_MODELS, codexReasoningOptions } from "./AgentsTab";

const catalogEntry = (value: string) => CODEX_MODELS.find((m) => m.value === value);

test("uses the canonical GPT-5.6 Sol model ID", () => {
  expect(catalogEntry("gpt-5.6-sol")?.label).toBe("GPT-5.6 Sol");
  expect(CODEX_MODELS.some(({ value }) => value === "gpt-5.6")).toBe(false);
});

describe("CODEX_MODELS catalog", () => {
  test("omits gpt-5.3-codex (saved picks of it are force-migrated away)", () => {
    expect(CODEX_MODELS.some(({ value }) => value === "gpt-5.3-codex")).toBe(false);
  });

  test("keeps the 5.2/5.1 family for API-key Codex users", () => {
    for (const value of ["gpt-5.2-codex", "gpt-5.2", "gpt-5.1-codex-max", "gpt-5.1-codex-mini"]) {
      expect(catalogEntry(value)?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    }
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
