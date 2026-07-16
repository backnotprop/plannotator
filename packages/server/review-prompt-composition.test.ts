import { describe, expect, test } from "bun:test";
import { composeClaudeReviewPrompt, CLAUDE_REVIEW_PROMPT } from "./claude-review";
import { composeCodexReviewPrompt, CODEX_REVIEW_SYSTEM_PROMPT } from "./codex-review";
import { buildAgentReviewUserMessage } from "./agent-review-message";
import {
  BUILTIN_DEFAULT_PROFILE,
  BUILTIN_DEFAULT_ID,
  type ResolvedReviewProfile,
} from "@plannotator/shared/review-profiles";

// Stand-in for buildAgentReviewUserMessage(...) output. The composer treats it
// as opaque text, so a literal is enough to pin placement and byte-equality.
const userMessage = "Review of the current code changes.\n\n```diff\n+const x = 1;\n```";

const security: ResolvedReviewProfile = {
  id: "user:security",
  label: "Security",
  instructions: "Focus only on security-impacting issues.",
  source: "user",
};

// The exact prompt today, before this phase, for the default path.
const claudeDefault = CLAUDE_REVIEW_PROMPT + "\n\n---\n\n" + userMessage;
const codexDefault = CODEX_REVIEW_SYSTEM_PROMPT + "\n\n---\n\n" + userMessage;

describe("review prompt composition — default is byte-identical", () => {
  test("Claude: absent profile matches today's prompt exactly", () => {
    expect(composeClaudeReviewPrompt(userMessage)).toBe(claudeDefault);
  });

  test("Claude: builtin:default matches today's prompt exactly", () => {
    expect(composeClaudeReviewPrompt(userMessage, BUILTIN_DEFAULT_PROFILE)).toBe(claudeDefault);
  });

  test("Codex: absent profile matches today's prompt exactly", () => {
    expect(composeCodexReviewPrompt(userMessage)).toBe(codexDefault);
  });

  test("Codex: builtin:default matches today's prompt exactly", () => {
    expect(composeCodexReviewPrompt(userMessage, BUILTIN_DEFAULT_PROFILE)).toBe(codexDefault);
  });

  test("a custom profile with empty instructions still yields the default prompt", () => {
    const blank: ResolvedReviewProfile = { ...security, instructions: "   " };
    expect(composeClaudeReviewPrompt(userMessage, blank)).toBe(claudeDefault);
    expect(composeCodexReviewPrompt(userMessage, blank)).toBe(codexDefault);
  });

  test("the reserved default id wins even if a profile claims source=user", () => {
    // A malformed profile that should never exist. The id guard must take
    // precedence so the reserved default can never be replaced.
    const reserved: ResolvedReviewProfile = {
      id: BUILTIN_DEFAULT_ID,
      label: "Reserved",
      instructions: "Custom instructions that must not be used.",
      source: "user",
    };
    expect(composeClaudeReviewPrompt(userMessage, reserved)).toBe(claudeDefault);
    expect(composeCodexReviewPrompt(userMessage, reserved)).toBe(codexDefault);
  });
});

describe("custom review end to end — skill replaces, message is context-only", () => {
  test("custom skill prompt is the skill body plus the stripped context message", () => {
    const skill: ResolvedReviewProfile = {
      id: "skill:security",
      label: "Security",
      instructions: "Audit only authn and authz boundaries.",
      source: "user",
    };
    // review.ts wires isCustomReview === true to both the context-only message
    // and the replacing composer. This locks that combined contract.
    const contextMessage = buildAgentReviewUserMessage(
      "diff --git a/x b/x\n+x\n",
      "last-commit",
      { defaultBranch: "origin/main" },
      undefined,
      true,
    );
    const prompt = composeClaudeReviewPrompt(contextMessage, skill);

    expect(prompt).toContain("Audit only authn and authz boundaries.");
    expect(prompt).toContain("## Returning your findings");
    expect(prompt).toContain("git diff HEAD~1..HEAD");
    expect(prompt).not.toContain(CLAUDE_REVIEW_PROMPT);
    expect(prompt).not.toContain("Review the code changes introduced");
    expect(prompt).not.toContain("Provide prioritized, actionable findings.");
  });
});

describe("review prompt composition — custom skill replaces the provider prompt", () => {
  test("Claude: skill body, then the reporting reminder, then the user message", () => {
    const prompt = composeClaudeReviewPrompt(userMessage, security);

    expect(prompt).toStartWith("Focus only on security-impacting issues.");
    expect(prompt).toEndWith(userMessage);
    // Output-contract reminder is appended for custom skills.
    expect(prompt).toContain("## Returning your findings");
    // The default methodology is gone — no provider prompt, no section wrapper.
    expect(prompt).not.toContain(CLAUDE_REVIEW_PROMPT);
    expect(prompt).not.toContain("## Custom Review Profile");
    // Order: skill body → reporting reminder → user message.
    expect(prompt.indexOf("## Returning your findings")).toBeGreaterThan(prompt.indexOf("Focus only"));
    expect(prompt.indexOf(userMessage)).toBeGreaterThan(prompt.indexOf("## Returning your findings"));
  });

  test("Codex: skill body, then the reporting reminder, then the user message", () => {
    const prompt = composeCodexReviewPrompt(userMessage, security);

    expect(prompt).toStartWith("Focus only on security-impacting issues.");
    expect(prompt).toEndWith(userMessage);
    expect(prompt).toContain("## Returning your findings");
    expect(prompt).not.toContain(CODEX_REVIEW_SYSTEM_PROMPT);
    expect(prompt).not.toContain("## Custom Review Profile");
  });

  test("the skill body is used verbatim, trimmed, with no label or source added", () => {
    const profile: ResolvedReviewProfile = {
      id: "skill:perf",
      label: "Performance",
      instructions: "  Flag N+1 queries.  ",
      source: "user",
    };
    const prompt = composeClaudeReviewPrompt(userMessage, profile);
    expect(prompt).toStartWith("Flag N+1 queries.\n\n## Returning your findings");
    expect(prompt).toEndWith(userMessage);
    expect(prompt).not.toContain("Profile:");
    expect(prompt).not.toContain("Source:");
  });
});
