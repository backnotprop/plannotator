import { describe, expect, test } from "bun:test";
import { mergePromptConfig } from "./config";
import { DEFAULT_REVIEW_APPROVED_PROMPT, getConfiguredPrompt, getReviewApprovedPrompt } from "./prompts";

describe("prompts", () => {
  test("falls back to built-in default when no config is present", () => {
    expect(getReviewApprovedPrompt("opencode", {})).toBe(DEFAULT_REVIEW_APPROVED_PROMPT);
  });

  test("uses generic configured review approval prompt", () => {
    expect(
      getReviewApprovedPrompt("opencode", {
        prompts: { review: { approved: "Commit these changes now." } },
      }),
    ).toBe("Commit these changes now.");
  });

  test("runtime-specific review approval prompt wins over generic prompt", () => {
    expect(
      getReviewApprovedPrompt("opencode", {
        prompts: {
          review: {
            approved: "Generic approval.",
            runtimes: {
              opencode: { approved: "OpenCode-specific approval." },
            },
          },
        },
      }),
    ).toBe("OpenCode-specific approval.");
  });

  test("blank prompt values fall back to the next available default", () => {
    expect(
      getReviewApprovedPrompt("opencode", {
        prompts: {
          review: {
            approved: "   ",
            runtimes: {
              opencode: { approved: "" },
            },
          },
        },
      }),
    ).toBe(DEFAULT_REVIEW_APPROVED_PROMPT);
  });

  test("generic loader resolves prompt paths with fallback", () => {
    expect(
      getConfiguredPrompt({
        section: "review",
        key: "approved",
        runtime: "pi",
        fallback: "Fallback",
        config: {
          prompts: {
            review: {
              runtimes: {
                pi: { approved: "Pi prompt" },
              },
            },
          },
        },
      }),
    ).toBe("Pi prompt");
  });

  test("mergePromptConfig keeps generic and sibling runtime prompts", () => {
    const merged = mergePromptConfig(
      {
        review: {
          approved: "Generic approval.",
          runtimes: {
            opencode: { approved: "OpenCode approval." },
          },
        },
      },
      {
        review: {
          runtimes: {
            "claude-code": { approved: "Claude approval." },
          },
        },
      },
    );

    expect(merged?.review?.approved).toBe("Generic approval.");
    expect(merged?.review?.runtimes?.opencode?.approved).toBe("OpenCode approval.");
    expect(merged?.review?.runtimes?.["claude-code"]?.approved).toBe("Claude approval.");
  });
});
