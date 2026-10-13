import { describe, expect, test } from "bun:test";
import { effectiveEffort, effectiveFast, effectiveModel, parseReviewProfileByEngine } from "./useAgentSettings";

describe("effective launch model", () => {
  const models = [
    { id: "opus", label: "Opus", reasoningEfforts: [{ id: "high", label: "High" }], defaultReasoningEffort: "high" },
    { id: "sonnet", label: "Sonnet", default: true },
  ];

  test("while the catalog is still loading, the saved pick is used untouched", () => {
    expect(effectiveModel({ models, settled: false }, "claude-opus-4-8", "opus")).toBe("claude-opus-4-8");
    expect(effectiveEffort({ models, settled: false }, "opus", "ultra")).toBe("ultra");
  });

  test("once settled, a stale pick resolves to the surface default and its effort is clamped", () => {
    expect(effectiveModel({ models, settled: true }, "claude-opus-4-8", "opus")).toBe("opus");
    expect(effectiveEffort({ models, settled: true }, "opus", "ultra")).toBe("high");
  });
});

describe("effective Codex fast mode", () => {
  const codex = {
    settled: true,
    models: [
      { id: "gpt-6-sol", label: "GPT-6-Sol", default: true, fastMode: true },
      { id: "gpt-slow", label: "GPT Slow" },
    ],
  };

  test("fast is dropped when a retired pick is replaced by a different model", () => {
    // A retired model saved with fast on must not launch the replacement with
    // -c service_tier=fast: the choice was made for the old model.
    const model = effectiveModel(codex, "gpt-5.3-codex", "");
    expect(model).toBe("gpt-6-sol");
    expect(effectiveFast(codex, "gpt-5.3-codex", model, true)).toBe(false);
  });

  test("fast is kept for the saved model itself and for the tool default", () => {
    expect(effectiveFast(codex, "gpt-6-sol", "gpt-6-sol", true)).toBe(true);
    expect(effectiveFast(codex, "", "gpt-6-sol", true)).toBe(true);
    expect(effectiveFast(codex, "gpt-slow", "gpt-slow", true)).toBe(false);
  });
});

describe("parseReviewProfileByEngine", () => {
  test("empty cookie → every engine defaults to builtin", () => {
    expect(parseReviewProfileByEngine({})).toEqual({
      claude: "builtin:default",
      codex: "builtin:default",
      cursor: "builtin:default",
      opencode: "builtin:default",
      pi: "builtin:default",
      copilot: "builtin:default",
    });
  });

  test("migrates the old flat reviewProfileId by seeding every engine with it", () => {
    expect(parseReviewProfileByEngine({ reviewProfileId: "skill:security" })).toEqual({
      claude: "skill:security",
      codex: "skill:security",
      cursor: "skill:security",
      opencode: "skill:security",
      pi: "skill:security",
      copilot: "skill:security",
    });
  });

  test("keeps per-engine picks; missing engines fall back to legacy flat value", () => {
    expect(
      parseReviewProfileByEngine({
        reviewProfileByEngine: { claude: "skill:a", cursor: "skill:b" },
        reviewProfileId: "skill:legacy",
      }),
    ).toEqual({
      claude: "skill:a",
      codex: "skill:legacy",
      cursor: "skill:b",
      opencode: "skill:legacy",
      pi: "skill:legacy",
      copilot: "skill:legacy",
    });
  });

  test("missing engines fall back to builtin when there is no legacy value", () => {
    expect(
      parseReviewProfileByEngine({ reviewProfileByEngine: { codex: "skill:x" } }),
    ).toEqual({
      claude: "builtin:default",
      codex: "skill:x",
      cursor: "builtin:default",
      opencode: "builtin:default",
      pi: "builtin:default",
      copilot: "builtin:default",
    });
  });
});
