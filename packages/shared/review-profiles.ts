/** Review profile contract types and prompt composition. Runtime-agnostic; vendored to Pi. */

export type ReviewProfileSource = "builtin" | "user";

export interface ReviewProfile {
  id: string;
  label: string;
  instructions: string;
  description?: string;
}

export interface ResolvedReviewProfile extends ReviewProfile {
  source: ReviewProfileSource;
  sourcePath?: string;
  default?: boolean;
}

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

export const BUILTIN_DEFAULT_ID = "builtin:default";

export const BUILTIN_DEFAULT_PROFILE: ResolvedReviewProfile = {
  id: BUILTIN_DEFAULT_ID,
  label: "Default",
  instructions: "",
  source: "builtin",
  default: true,
};

/** A profile replaces the provider prompt only when it carries instructions and is not the reserved built-in default. */
export function profileHasCustomSection(profile: ResolvedReviewProfile | undefined): boolean {
  return (
    !!profile &&
    profile.id !== BUILTIN_DEFAULT_ID &&
    profile.instructions.trim().length > 0
  );
}

/** Output-contract reminder for custom skill prompts: covers only HOW to report, never WHAT to look for. Without it a verdict-style skill collapses line-locatable findings into one block. */
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

/** Custom skill: instructions, reporting reminder, `---`, user message. Built-in default: provider instructions, `---`, user message, with no reminder so it stays byte-identical to the original prompt. */
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
