import type { DiffType } from "./vcs";
import type { PRMetadata } from "./pr";
import type { WorkspaceReviewPromptContext } from "@plannotator/shared/review-workspace";
import {
  buildWorkspacePromptContextLines,
  getLocalDiffInstruction,
} from "@plannotator/shared/review-prompt";

export type { WorkspaceReviewPromptContext } from "@plannotator/shared/review-workspace";

// Moved to @plannotator/core/review-prompt (browser-safe); re-exported so
// every existing importer of this module keeps working unchanged.
export { buildWorkspacePromptContextLines, getLocalDiffInstruction };
export type { LocalDiffInstruction } from "@plannotator/shared/review-prompt";

export interface AgentReviewUserMessageOptions {
  defaultBranch?: string;
  hasLocalAccess?: boolean;
  prDiffScope?: string;
}

export type AgentReviewTarget =
  | {
      kind: "local";
      patch: string;
      diffType: DiffType;
      options?: AgentReviewUserMessageOptions;
    }
  | {
      kind: "pr";
      patch: string;
      diffType: DiffType;
      options?: AgentReviewUserMessageOptions;
      prMetadata: PRMetadata;
    }
  | {
      kind: "workspace";
      patch: string;
      workspace: WorkspaceReviewPromptContext;
    };

export function buildAgentReviewUserMessageForTarget(
  target: AgentReviewTarget,
  contextOnly = false,
): string {
  if (target.kind === "workspace") {
    return buildWorkspaceReviewUserMessage(target.patch, target.workspace, contextOnly);
  }
  return buildAgentReviewUserMessage(
    target.patch,
    target.diffType,
    target.options,
    target.kind === "pr" ? target.prMetadata : undefined,
    contextOnly,
  );
}

/**
 * Build the dynamic user message shared by local Claude and Codex review jobs.
 *
 * `contextOnly` strips the "Review… / provide findings" framing prose and keeps
 * only the git/PR context the agent needs to locate the changes. Used by custom
 * review skills, which carry their own instructions and must not inherit the
 * default review's framing. With `contextOnly` off the output is byte-identical
 * to today's prompt.
 */
export function buildAgentReviewUserMessage(
  patch: string,
  diffType: DiffType,
  options?: AgentReviewUserMessageOptions,
  prMetadata?: PRMetadata,
  contextOnly = false,
): string {
  if (prMetadata) {
    if (options?.prDiffScope === "full-stack") {
      return [
        contextOnly ? prMetadata.url : `Full-stack review of ${prMetadata.url}`,
        "",
        "This is a stacked PR. The diff below shows ALL accumulated changes from the repository default branch through this PR's head (not just this PR's own layer).",
        ...(contextOnly ? [] : ["Review the complete diff for issues that span the stack."]),
        "",
        "```diff",
        patch,
        "```",
      ].join("\n");
    }
    if (options?.hasLocalAccess) {
      // Pure context already (where the checkout is, how to diff against the
      // base) — no "Review… / provide findings" framing to strip, so this is
      // identical for default and custom reviews regardless of contextOnly.
      return [
        prMetadata.url,
        "",
        "You are in a local worktree checked out at the PR head. The code is available locally.",
        `To see the PR changes, diff against the remote base branch: git diff origin/${prMetadata.baseBranch}...HEAD`,
        "Do NOT diff against the local `main` branch; it may be stale. Always use origin/.",
      ].join("\n");
    }
    // No confirmed local checkout yet. A worktree at the PR head is being
    // prepared and pulls the PR files on demand — tell the agent to verify the
    // files exist before relying on them, give it the same diff command, and
    // fall back to the PR URL if the checkout isn't ready.
    return [
      prMetadata.url,
      "",
      "You are reviewing this PR. A local worktree checked out at the PR head is being prepared; it may still be warming up, so verify the PR files exist before relying on them.",
      `Once they do, see the PR changes by diffing against the remote base branch: git diff origin/${prMetadata.baseBranch}...HEAD`,
      "Do NOT diff against the local `main` branch; it may be stale. Always use origin/. If the files are not yet available, use the PR URL above for context.",
    ].join("\n");
  }

  const instruction = getLocalDiffInstruction(diffType, options?.defaultBranch);
  if (instruction) {
    if (contextOnly) {
      return `Changeset: ${instruction.target}.\n${instruction.inspect}`;
    }
    return `Review ${instruction.target}. ${instruction.inspect} Provide prioritized, actionable findings.`;
  }

  const gitButlerContext = diffType.startsWith("gitbutler:")
    ? `${contextOnly ? "GitButler changes" : "Review these GitButler changes and provide prioritized findings"}: the inline diff is authoritative. The checked-out workspace may include other stacks or later branch layers, so do not replace this patch with an ordinary \`git diff\`.`
    : null;
  return [
    gitButlerContext ?? (contextOnly ? "Code changes:" : "Review the following code changes and provide prioritized findings."),
    "",
    "```diff",
    patch,
    "```",
  ].join("\n");
}

function buildWorkspaceReviewUserMessage(
  patch: string,
  workspace: WorkspaceReviewPromptContext,
  contextOnly = false,
): string {
  return [
    ...(contextOnly
      ? []
      : ["Review the local workspace changes across multiple nested VCS repositories.", ""]),
    ...buildWorkspacePromptContextLines(workspace, { includeReportingInstruction: true }),
    "",
    "```diff",
    patch,
    "```",
  ].join("\n");
}
