import { parseGitButlerDiffType } from "./gitbutler-core";
import type { DiffType } from "./review-core";
import type { ProviderReviewOpenStateInput, ReviewOpenState } from "./review-open-state";
import type { VcsReviewPolicy } from "./vcs-review-policy";

export const gitButlerReviewPolicy: VcsReviewPolicy = {
  defaultDiffType: "gitbutler:workspace",
  ownsDiffType(diffType: string): diffType is DiffType {
    return parseGitButlerDiffType(diffType) !== null;
  },
  resolveDefault() {
    return undefined;
  },
  resolveOpenState(input) {
    return fail(
      input.base !== undefined
        ? "--base is not supported in a GitButler workspace; GitButler derives the merge base from the workspace itself."
        : "--diff-type is not supported in a GitButler workspace; GitButler modes are selected in the UI.",
    );
  },
  resolveInitialBase(defaultBase) {
    return defaultBase;
  },
};

function fail(error: string): ReviewOpenState {
  return { notices: [], error };
}
