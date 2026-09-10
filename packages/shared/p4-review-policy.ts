import type { DiffType } from "./review-core";
import type { ReviewOpenState } from "./review-open-state";
import type { VcsReviewPolicy } from "./vcs-review-policy";

export const p4ReviewPolicy: VcsReviewPolicy = {
  defaultDiffType: "p4-default",
  ownsDiffType(diffType: string): diffType is DiffType {
    return diffType === "p4-default" || diffType.startsWith("p4-changelist:");
  },
  resolveDefault() {
    return undefined;
  },
  resolveOpenState(input) {
    return fail(
      input.base !== undefined
        ? "--base is not supported in Perforce sessions."
        : "--diff-type is not supported in Perforce sessions.",
    );
  },
  resolveInitialBase(defaultBase) {
    return defaultBase;
  },
};

function fail(error: string): ReviewOpenState {
  return { notices: [], error };
}
