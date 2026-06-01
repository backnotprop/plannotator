import {
  JJ_TRUNK_REVSET,
  jjLineBaseRevset,
  parseWorktreeDiffType,
  type DiffType,
} from "./vcs";
import type { PRMetadata } from "./pr";

export interface AgentReviewUserMessageOptions {
  defaultBranch?: string;
  hasLocalAccess?: boolean;
  prDiffScope?: string;
}

export interface LocalDiffInstruction {
  target: string;
  inspect: string;
}

/** Build the dynamic user message shared by local Claude and Codex review jobs. */
export function buildAgentReviewUserMessage(
  patch: string,
  diffType: DiffType,
  options?: AgentReviewUserMessageOptions,
  prMetadata?: PRMetadata,
): string {
  if (prMetadata) {
    if (options?.prDiffScope === "full-stack") {
      return [
        `Full-stack review of ${prMetadata.url}`,
        "",
        "This is a stacked PR. The diff below shows ALL accumulated changes from the repository default branch through this PR's head (not just this PR's own layer).",
        "Review the complete diff for issues that span the stack.",
        "",
        "```diff",
        patch,
        "```",
      ].join("\n");
    }
    if (options?.hasLocalAccess) {
      return [
        prMetadata.url,
        "",
        "You are in a local worktree checked out at the PR head. The code is available locally.",
        `To see the PR changes, diff against the remote base branch: git diff origin/${prMetadata.baseBranch}...HEAD`,
        "Do NOT diff against the local `main` branch; it may be stale. Always use origin/.",
      ].join("\n");
    }
    return prMetadata.url;
  }

  const instruction = getLocalDiffInstruction(diffType, options?.defaultBranch);
  if (instruction) {
    return `Review ${instruction.target}. ${instruction.inspect} Provide prioritized, actionable findings.`;
  }

  return [
    "Review the following code changes and provide prioritized findings.",
    "",
    "```diff",
    patch,
    "```",
  ].join("\n");
}

export function getLocalDiffInstruction(
  diffType: DiffType,
  defaultBranch?: string,
): LocalDiffInstruction | null {
  const effectiveDiffType = normalizeLocalDiffType(diffType);

  switch (effectiveDiffType) {
    case "uncommitted":
      return {
        target: "the current code changes (staged, unstaged, and untracked files)",
        inspect: "Inspect the working tree changes locally.",
      };
    case "staged":
      return {
        target: "the currently staged code changes",
        inspect: "Run `git diff --staged` to inspect the changes.",
      };
    case "unstaged":
      return {
        target: "the unstaged code changes (tracked modifications and untracked files)",
        inspect: "Inspect the unstaged working tree changes locally.",
      };
    case "last-commit":
      return {
        target: "the code changes introduced in the last commit",
        inspect: "Run `git diff HEAD~1..HEAD` to inspect the changes.",
      };
    case "branch": {
      const base = defaultBranch || "main";
      return {
        target: `the code changes against the base branch '${base}'`,
        inspect: `Run \`git diff ${base}..HEAD\` to inspect the changes.`,
      };
    }
    case "merge-base": {
      const base = defaultBranch || "main";
      return {
        target: `the PR-style diff against base '${base}'`,
        inspect: `First find the common ancestor with \`git merge-base ${base} HEAD\`, then run \`git diff <merge-base>..HEAD\` using that commit to inspect only the changes introduced on this branch (matches GitHub's PR view).`,
      };
    }
    case "all":
      return {
        target: "every file in the repository",
        inspect: "All files are shown as additions, diffed against an empty tree.",
      };
    case "jj-current":
      return {
        target: "the current JJ change",
        inspect: "Run `jj diff --git -r @` to inspect the changes.",
      };
    case "jj-last":
      return {
        target: "the previous JJ change",
        inspect: "Run `jj diff --git -r @-` to inspect the changes.",
      };
    case "jj-line": {
      const base = defaultBranch || JJ_TRUNK_REVSET;
      const baseRevset = jjLineBaseRevset(base);
      return {
        target: `the JJ line of work against \`${base}\``,
        inspect: `Run \`jj diff --git --from ${shellQuote(baseRevset)} --to @\` to inspect the changes.`,
      };
    }
    case "jj-evolog": {
      const fromRev = defaultBranch || "<previous-evolog-commit>";
      return {
        target: "what changed between two evolutions of the current JJ change",
        inspect: `Run \`jj diff --git --from ${shellQuote(fromRev)} --to @\` to inspect the changes (shows what was amended since the selected prior evolution).`,
      };
    }
    case "jj-all":
      return {
        target: "all files in the JJ workspace",
        inspect: "Run `jj diff --git --from 'root()' --to @` to inspect the changes.",
      };
    default:
      return null;
  }
}

function normalizeLocalDiffType(diffType: DiffType): string {
  const worktree = parseWorktreeDiffType(diffType);
  return worktree?.subType ?? diffType;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
