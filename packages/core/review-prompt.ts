/**
 * Pure, browser-safe prompt context shared by the review-agent and guide
 * prompt builders: the per-diff-type "what to review / how to inspect it"
 * instruction and the multi-repo workspace context lines. Moved here from
 * packages/server/agent-review-message.ts (which re-exports every name) so
 * @plannotator/core/guide-prompt can build Plannotator's exact guide user
 * message in any runtime. Zero dependencies beyond ./diff-type.
 */

import {
  JJ_TRUNK_REVSET,
  jjLineBaseRevset,
  parseCommitDiffType,
  parseWorktreeDiffType,
  type DiffType,
} from "./diff-type";

export type WorkspaceChildVcsType = "git" | "gitbutler" | "jj";

export interface WorkspacePromptRepoContext {
  label: string;
  cwd: string;
  changed: boolean;
  vcsType?: WorkspaceChildVcsType;
  gitRef?: string;
  error?: string;
}

export interface WorkspaceReviewPromptContext {
  root: string;
  repos: WorkspacePromptRepoContext[];
}

export interface LocalDiffInstruction {
  target: string;
  inspect: string;
}

export function buildWorkspacePromptContextLines(
  workspace: WorkspaceReviewPromptContext,
  options: { includeReportingInstruction?: boolean } = {},
): string[] {
  const repoList = workspace.repos.length > 0
    ? workspace.repos
      .map((repo) => {
        const status = repo.changed ? "changed" : "failed";
        const details = [repo.vcsType, status].filter(Boolean).join(", ");
        return `- ${repo.label}/${details ? ` [${details}]` : ""} -> ${repo.cwd}${repo.gitRef ? ` (${repo.gitRef})` : ""}${repo.error ? ` - ${repo.changed ? "warning" : "error"}: ${repo.error}` : ""}`;
      })
      .join("\n")
    : "- No changed child repositories were detected.";

  const lines = [
    `You are starting in the workspace root: ${workspace.root}`,
    "The workspace root is not itself the VCS repository for these changes.",
    "Each changed path in the diff is prefixed with the child repository folder, such as `api/src/file.ts`.",
    "If any repository is marked failed, treat this as a partial workspace review and say so.",
    "For Git child repos, inspect with `git -C <child-repo-folder> ...` from the workspace root.",
    "For JJ child repos, treat the inline diff and prefixed files as authoritative review context.",
    "For GitButler child repos, treat the inline diff and prefixed files as authoritative; ordinary Git commands can include other applied stacks.",
  ];

  if (options.includeReportingInstruction) {
    lines.push(
      "When reporting findings, the file path must exactly match the path shown in the diff.",
      "Use the child repo prefix, such as `api/src/file.ts` or `web/src/file.ts`.",
      "Do not use bare repo-relative paths like `src/file.ts`, and do not use absolute filesystem paths.",
    );
  }

  return [
    ...lines,
    "",
    "Repositories:",
    repoList,
  ];
}

export function getLocalDiffInstruction(
  diffType: DiffType,
  defaultBranch?: string,
): LocalDiffInstruction | null {
  const effectiveDiffType = normalizeLocalDiffType(diffType);

  // commit:<sha> — a single historical commit, not the working tree.
  const commitRef = parseCommitDiffType(effectiveDiffType);
  if (commitRef) {
    return {
      target: `the changes introduced by commit ${commitRef.sha.slice(0, 7)}`,
      // First-parent diff, NOT `git show`: the on-screen patch is
      // `<sha>^ <sha>`, and for a merge commit `git show`'s combined-diff
      // presentation renders a different (often empty) changeset — the agent
      // must inspect exactly what the reviewer is looking at.
      inspect: `This is a historical commit, not the working tree. Run \`git diff ${commitRef.sha}^ ${commitRef.sha}\` — the commit against its first parent — to inspect exactly the changeset under review (do not use \`git show\`; its merge-commit presentation differs). For a root commit with no parent, use \`git show ${commitRef.sha}\` instead.`,
    };
  }

  switch (effectiveDiffType) {
    case "local-vs-remote":
      return {
        target: "the local branch and working tree compared with its configured remote-tracking branch, including committed, uncommitted, and untracked differences",
        inspect: "Resolve the current upstream with `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`, then run `git diff <upstream>` (no right-hand ref) and inspect untracked files from `git status --porcelain` separately.",
      };
    case "since-base": {
      const base = defaultBranch || "main";
      return {
        target: `all changes since the merge-base with '${base}' — committed, uncommitted, and untracked; the full set a PR would show once it is all committed and pushed`,
        inspect: `First find the common ancestor with \`git merge-base ${base} HEAD\`, then run \`git diff <merge-base>\` (no right-hand ref — it compares against the working tree) to inspect committed + uncommitted changes. That diff does NOT include untracked files, so also list them with \`git status --porcelain\` (or \`git ls-files --others --exclude-standard\`) and read each new file directly — they are part of this review.`,
      };
    }
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
