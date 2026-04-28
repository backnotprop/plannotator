import { describe, expect, test } from "bun:test";
import { sanitizeCodexPerModel, DEFAULT_CODEX_REASONING } from "./useAgentSettings";

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
