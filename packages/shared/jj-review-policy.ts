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
  ownsDiffType(diffType: string): diffType is DiffType {
    return JJ_DIFF_TYPES.has(diffType);
  },
  resolveDefault(value) {
    return typeof value === "string" && JJ_DIFF_TYPES.has(value)
      ? value as DiffType
      : undefined;
  },
  resolveOpenState: rejectJjOpenState,
  resolveInitialBase(defaultBase, diffType, requestedBase, ownsRequestedDiffType) {
    return diffType === "jj-line" && ownsRequestedDiffType && requestedBase
      ? requestedBase
      : defaultBase;
  },
};

function rejectJjOpenState(input: ProviderReviewOpenStateInput): ReviewOpenState {
  return fail(
    input.base !== undefined
      ? "--base is not supported in jj sessions yet (only the jj-line mode has a base)."
      : "--diff-type is not supported in jj sessions; jj modes are selected in the UI.",
  );
}

function fail(error: string): ReviewOpenState {
  return { notices: [], error };
}
