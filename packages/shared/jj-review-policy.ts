import type { DiffType } from "./review-core";
import type { ProviderReviewOpenStateInput, ReviewOpenState } from "./review-open-state";
import type { VcsReviewPolicy } from "./vcs-review-policy";

export const JJ_DIFF_TYPES = new Set([
  "jj-current",
  "jj-last",
  "jj-line",
  "jj-evolog",
  "jj-all",
]);

export const jjReviewPolicy: VcsReviewPolicy = {
  defaultDiffType: "jj-current",
  settings: {
    id: "jj",
    label: "Jujutsu",
    defaultDiffType: "jj-current",
    diffOptions: [
      { id: "jj-current", label: "Current change", description: "Only the changes in the working-copy change" },
      { id: "jj-line", label: "Line of work", description: "The complete mutable line of work leading to the working copy" },
      { id: "jj-last", label: "Last change", description: "The change immediately before the working copy" },
      { id: "jj-evolog", label: "Evolution diff", description: "How the current change differs from its previous state" },
      { id: "jj-all", label: "All files", description: "Every file at the working-copy revision, shown as additions" },
    ],
    capabilities: { statusSections: false, staging: false, compareTarget: true },
  },
  ownsDiffType(diffType: string): diffType is DiffType {
    return JJ_DIFF_TYPES.has(diffType);
  },
  resolveDefault(value) {
    return typeof value === "string" && JJ_DIFF_TYPES.has(value)
      ? value as DiffType
      : undefined;
  },
  resolveOpenState: resolveJjOpenState,
  resolveInitialBase(defaultBase, diffType, requestedBase, ownsRequestedDiffType) {
    return diffType === "jj-line" && ownsRequestedDiffType && requestedBase
      ? requestedBase
      : defaultBase;
  },
};

function resolveJjOpenState(input: ProviderReviewOpenStateInput): ReviewOpenState {
  const { base, diffType } = input;
  if (diffType !== undefined && !JJ_DIFF_TYPES.has(diffType)) {
    return fail(`Unknown diff type: ${diffType}. Expected one of: ${[...JJ_DIFF_TYPES].join(", ")}`);
  }
  if (base !== undefined && diffType !== undefined && diffType !== "jj-line") {
    return fail(`--base has no effect with --diff-type ${diffType}.\nBase-relative Jujutsu diff type: jj-line.`);
  }
  return {
    ...(base !== undefined && { requestedBase: base }),
    ...(diffType !== undefined
      ? { requestedDiffType: diffType as DiffType }
      : base !== undefined
        ? { requestedDiffType: "jj-line" }
        : {}),
    notices: [],
  };
}

function fail(error: string): ReviewOpenState {
  return { notices: [], error };
}
