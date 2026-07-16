/**
 * Review Profiles — shared contract types + prompt-composition spine.
 *
 * Runtime-agnostic: no node:fs, no node:http, no Bun APIs. The loader that
 * reads custom reviews from disk lives in packages/server/review-skill-loader.ts
 * and maps each curated Agent Skill into a ResolvedReviewProfile that this
 * module's composer renders. Vendored to Pi.
 *
 * A review profile is a named bundle of review intent. A custom review skill
 * fully replaces the provider's system prompt — picking a review runs that
 * review. The built-in default carries no instructions, so the composer falls
 * back to the provider prompt and the default review stays byte-for-byte today's.
 *
 * See docs/custom-reviews.md.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a resolved profile came from. */
export type ReviewProfileSource = "builtin" | "user";

export interface ReviewProfile {
  id: string;
  label: string;
  /** The injected review instructions. */
  instructions: string;
  description?: string;
}

export interface ResolvedReviewProfile extends ReviewProfile {
  source: ReviewProfileSource;
  sourcePath?: string;
  /** True for builtin:default — surfaced to the picker as the pre-selected option. */
  default?: boolean;
}

/** Response shape for `GET /api/agents/review-profiles`. */
export interface ReviewProfilesResponse {
  profiles: Array<{
    id: string;
    label: string;
    description?: string;
    source: ReviewProfileSource;
    sourcePath?: string;
    default?: boolean;
  }>;
}

/** Reserved id for the built-in default review. */
export const BUILTIN_DEFAULT_ID = "builtin:default";

// ---------------------------------------------------------------------------
// Built-in profiles
// ---------------------------------------------------------------------------

/**
 * The built-in default review — today's review, preserved. It carries no
 * custom instructions, so the composer falls back to the provider prompt and
 * the default prompt stays byte-for-byte today's.
 */
export const BUILTIN_DEFAULT_PROFILE: ResolvedReviewProfile = {
  id: BUILTIN_DEFAULT_ID,
  label: "Default",
  instructions: "",
  source: "builtin",
  default: true,
};

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

/**
 * A profile replaces the provider prompt only when it carries instructions and
 * isn't the reserved built-in default. The default (or any instruction-less
 * profile) falls back to the provider prompt, keeping it byte-for-byte today's.
 */
export function profileHasCustomSection(profile: ResolvedReviewProfile | undefined): boolean {
  return (
    !!profile &&
    profile.id !== BUILTIN_DEFAULT_ID &&
    profile.instructions.trim().length > 0
  );
}

/**
 * Output-contract reminder appended to a custom review skill's prompt. A skill
 * carries its own review methodology but does not know how Plannotator wants
 * results returned — without this, a verdict-style skill collapses good,
 * line-locatable findings into one block. This covers only HOW to report, never
 * WHAT to look for, so it never competes with the skill's own methodology.
 */
export const REPORTING_INSTRUCTIONS = `## Returning your findings

Hand back what you found as separate findings, not as one combined report.

- One finding per issue. Don't merge unrelated points into a single entry.
- Anchor each finding where it belongs:
  - About specific code? Give the file and the line(s), so it attaches to that spot in the diff.
  - About a whole file? Give the file and leave the line out.
  - A review-wide point? Leave out both the file and the line.
- Always produce the code-specific findings first.
- If your instructions also ask for a final verdict, summary, or overall judgment, add it as its own review-wide finding with no file and no line. The verdict is in addition to the specific findings, never a replacement for them.

If the instructions above told you to produce a particular report layout or document, that was for your own reasoning. For the final result, return findings in the structure described here: the specific code findings, plus any verdict as a separate review-wide finding.`;

/**
 * Compose the full review prompt deterministically.
 *
 * Custom review skill:
 *   <skill instructions>
 *   ## Returning your findings …      (output contract, see REPORTING_INSTRUCTIONS)
 *   ---
 *   <user message>
 *
 * The skill body fully replaces the provider's system prompt — picking a review
 * runs that review. The reporting reminder is appended so the skill's findings
 * come back in Plannotator's shape (line/file/general) instead of one block.
 *
 * Built-in default (or any instruction-less profile):
 *   <provider immutable instructions>
 *   ---
 *   <user message>
 *
 * The default already states its own output contract, so it gets no reminder and
 * stays byte-identical to today's `systemPrompt + "\n\n---\n\n" + userMessage`.
 */
export function composeReviewPrompt(
  systemPrompt: string,
  profile: ResolvedReviewProfile | undefined,
  userMessage: string,
): string {
  if (profileHasCustomSection(profile)) {
    return (
      (profile as ResolvedReviewProfile).instructions.trim() +
      "\n\n" + REPORTING_INSTRUCTIONS +
      "\n\n---\n\n" + userMessage
    );
  }
  return systemPrompt + "\n\n---\n\n" + userMessage;
}
