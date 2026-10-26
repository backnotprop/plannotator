/**
 * The one prompt (SPEC 4.3), built by core's `buildGuideBuilderPrompt`: what
 * to review (here: the PR or the local range, where the files are, how to see
 * the diff, and the exact changed paths), the methodology without the
 * exploration limit, the builder paragraph, and the reader's instructions.
 */

import { buildGuideBuilderPrompt } from "./core/adapter";
import type { ReviewSourceRecord } from "./store";

const MAX_LISTED_FILES = 400;

/** What the run is for: a review needs no edits, and the guide is written only through the builder's tools. */
export const READ_ONLY_NOTE =
  "This is a review: you do not need to edit, create or delete any file. Read and search the code as you need, and write the guide only with the guide_* tools.";

/** What to review, one line: core's prompt reads "Write a guided review of <target>." */
export function shortTarget(source: ReviewSourceRecord): string {
  if (source.kind === "pr" && source.pr) return `pull request #${source.pr.number}, "${source.pr.title}" (${source.pr.url})`;
  if (source.baseSha === source.headSha) return `the uncommitted changes in ${source.headRoot}${source.branch ? ` (branch ${source.branch})` : ""}`;
  return `${source.baseLabel}..HEAD and the uncommitted changes in ${source.headRoot}${source.branch ? ` (branch ${source.branch})` : ""}`;
}

/** Where the files are and how to see the diff. */
export function describeTarget(source: ReviewSourceRecord): string {
  if (source.kind === "pr" && source.pr) {
    return [
      `The PR head (${source.headSha.slice(0, 12)}) is checked out in your working directory (${source.headRoot}), in a git worktree.`,
      `To see the change: \`git diff ${source.baseSha.slice(0, 12)} HEAD\` (from the merge base with ${source.baseLabel}), or \`gh pr diff ${source.pr.number}\`.`,
    ].join("\n");
  }
  if (source.baseSha === source.headSha) {
    return [
      "To see the change: `git diff HEAD`, plus the untracked files (`git status`).",
    ].join("\n");
  }
  return [
    `To see the change: \`git diff ${source.baseSha.slice(0, 12)}\` (from the merge base with ${source.baseLabel}; it includes uncommitted work), plus the untracked files (\`git status\`).`,
  ].join("\n");
}

function changedFilesBlock(files: ReadonlyArray<{ path: string; additions: number; deletions: number }>): string {
  const lines = files.slice(0, MAX_LISTED_FILES).map((f) => `- ${f.path} (+${f.additions}/-${f.deletions})`);
  if (files.length > MAX_LISTED_FILES) lines.push(`- … and ${files.length - MAX_LISTED_FILES} more (guide_read lists them all)`);
  return [`Changed files (${files.length}); use these exact paths:`, ...lines].join("\n");
}

export function buildGuidePrompt(input: {
  source: ReviewSourceRecord;
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>;
  instructions?: string;
  resume?: boolean;
}): string {
  const prompt = buildGuideBuilderPrompt({
    target: shortTarget(input.source),
    ...(input.instructions && { instructions: input.instructions }),
    ...(input.resume && { resume: true }),
  });
  // Core's first paragraph names the target; where the files are, how to see the diff and the exact paths follow it.
  const cut = prompt.indexOf("\n\n");
  const context = `${describeTarget(input.source)}\n\n${changedFilesBlock(input.files)}\n\n${READ_ONLY_NOTE}`;
  return cut < 0 ? `${prompt}\n\n${context}` : `${prompt.slice(0, cut)}\n\n${context}${prompt.slice(cut)}`;
}
