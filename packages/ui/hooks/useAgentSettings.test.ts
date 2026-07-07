import { describe, expect, test } from "bun:test";
import { sanitizeCodexPerModel, parseReviewProfileByEngine, DEFAULT_CODEX_REASONING } from "./useAgentSettings";

describe("sanitizeCodexPerModel", () => {
  test("returns empty object for undefined/empty input", () => {
    expect(sanitizeCodexPerModel(undefined)).toEqual({});
    expect(sanitizeCodexPerModel({})).toEqual({});
  });

  test("drops stale reasoning: 'none' entry when fast is false", () => {
    const result = sanitizeCodexPerModel({
      "gpt-5.3-codex": { reasoning: "none", fast: false },
    });
    expect(result).toEqual({});
  });

  test("retains entry with reasoning: 'none' but fast: true, replacing reasoning with default", () => {
    const result = sanitizeCodexPerModel({
      "gpt-5.3-codex": { reasoning: "none", fast: true },
    });
    expect(result).toEqual({
      "gpt-5.3-codex": { reasoning: DEFAULT_CODEX_REASONING, fast: true },
    });
  });

  test("passes through valid entries unchanged", () => {
    const input = {
      "gpt-5.3-codex": { reasoning: "high", fast: false },
      "gpt-5.3-pro": { reasoning: "medium", fast: true },
    };
    expect(sanitizeCodexPerModel(input)).toEqual(input);
  });

  test("skips non-object entries", () => {
    const input = {
      valid: { reasoning: "high", fast: false },
      nullish: null as unknown as { reasoning: string; fast: boolean },
      stringy: "bad" as unknown as { reasoning: string; fast: boolean },
    };
    expect(sanitizeCodexPerModel(input)).toEqual({
      valid: { reasoning: "high", fast: false },
    });
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
