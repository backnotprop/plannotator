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
