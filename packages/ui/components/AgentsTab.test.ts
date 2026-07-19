import { expect, test } from "bun:test";
import { CODEX_MODELS } from "./AgentsTab";

test("uses the canonical GPT-5.6 Sol model ID", () => {
  expect(CODEX_MODELS).toContainEqual({
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
  });
  expect(CODEX_MODELS.some(({ value }) => value === "gpt-5.6")).toBe(false);
});
