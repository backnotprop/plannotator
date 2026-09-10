import type { DiffType } from "./review-core";
import {
  buildBaseNotFoundError,
  type ProviderReviewOpenStateInput,
  type ReviewOpenState,
} from "./review-open-state";
import type { VcsReviewPolicy } from "./vcs-review-policy";

export const GIT_DIFF_TYPES = new Set([
  "since-base",
  "local-vs-remote",
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
  "merge-base",
  "all",
]);

const BASE_RELATIVE_DIFF_TYPES = ["since-base", "branch", "merge-base"] as const;
const BASE_RELATIVE = new Set<string>(BASE_RELATIVE_DIFF_TYPES);

export const gitReviewPolicy: VcsReviewPolicy = {
  defaultDiffType: "since-base",
  settings: {
    id: "git",
    label: "Git",
    defaultDiffType: "since-base",
    diffOptions: [
      { id: "since-base", label: "All Changes (Recommended)", description: "Everything since your branch split from main — committed, uncommitted, and untracked" },
      { id: "local-vs-remote", label: "Local vs Remote Branch", description: "Your local branch and working tree compared with its last-fetched remote-tracking branch" },
      { id: "uncommitted", label: "Uncommitted", description: "Everything you've changed since your last commit" },
      { id: "unstaged", label: "Unstaged", description: "Only changes you haven't staged yet" },
      { id: "staged", label: "Staged", description: "Only changes you've staged for commit" },
      { id: "merge-base", label: "Committed changes (PR view)", description: "Everything you've committed on this branch" },
      { id: "all", label: "All Files (HEAD)", description: "Every tracked file at HEAD, shown as additions" },
    ],
    capabilities: { statusSections: true, staging: true, compareTarget: true },
    legacyDefaultSetting: "defaultDiffType",
  },
  ownsDiffType(diffType: string): diffType is DiffType {
    return GIT_DIFF_TYPES.has(diffType)
      || diffType.startsWith("worktree:")
      || diffType.startsWith("commit:");
  },
  legacyDefault: {
    resolve: resolveGitDefault,
  },
  resolveDefault: resolveGitDefault,
  resolveOpenState: resolveGitOpenState,
  resolveInitialBase(defaultBase, _diffType, requestedBase) {
    return requestedBase ?? defaultBase;
  },
};

function resolveGitDefault(value: unknown): DiffType | undefined {
  if (value === "branch") return "merge-base";
  return typeof value === "string" && GIT_DIFF_TYPES.has(value)
    ? value as DiffType
    : undefined;
}

function resolveGitOpenState(input: ProviderReviewOpenStateInput): ReviewOpenState {
  const { base, diffType } = input;
  if (diffType !== undefined && !GIT_DIFF_TYPES.has(diffType)) {
    return fail(`Unknown diff type: ${diffType}. Expected one of: ${[...GIT_DIFF_TYPES].join(", ")}`);
  }
  if (base !== undefined) {
    if (diffType !== undefined && !BASE_RELATIVE.has(diffType)) {
      return fail(
        `--base has no effect with --diff-type ${diffType}.\n` +
          `Base-relative diff types: ${BASE_RELATIVE_DIFF_TYPES.join(", ")}.`,
      );
    }
    if (input.baseResolves === false) {
      return fail(buildBaseNotFoundError(base, input.availableBranches));
    }
  }

  const notices: string[] = [];
  let requestedDiffType = diffType as DiffType | undefined;
  if (base !== undefined && diffType === undefined) {
    if (BASE_RELATIVE.has(input.resolvedDefaultDiffType)) {
      requestedDiffType = input.resolvedDefaultDiffType;
    } else {
      requestedDiffType = "since-base";
      notices.push(
        `[plannotator] --base ${base} needs a base-relative diff; opening on "since-base" ` +
          `for this session (your default stays ${input.resolvedDefaultDiffType}).`,
      );
    }
  }

  return {
    ...(base !== undefined && { requestedBase: base }),
    ...(requestedDiffType !== undefined && { requestedDiffType }),
    notices,
  };
}

function fail(error: string): ReviewOpenState {
  return { notices: [], error };
}
