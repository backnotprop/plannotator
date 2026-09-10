import { describe, expect, test } from "bun:test";
import { gitReviewPolicy } from "./git-review-policy";
import { jjReviewPolicy } from "./jj-review-policy";
import { resolveReviewOpenState } from "./review-open-state";
import { resolveProviderReviewDefault } from "./vcs-review-policy";

const asOpenStatePolicy = (policy: typeof gitReviewPolicy | typeof jjReviewPolicy) => ({
  resolve: policy.resolveOpenState,
});

describe("provider-owned review defaults", () => {
  test("Git alone interprets the legacy default and its retired branch alias", () => {
    expect(resolveProviderReviewDefault(gitReviewPolicy, undefined, "branch")).toBe("merge-base");
    expect(resolveProviderReviewDefault(jjReviewPolicy, undefined, "merge-base")).toBe("jj-current");
  });

  test("a provider-scoped value wins over the legacy source", () => {
    expect(resolveProviderReviewDefault(gitReviewPolicy, "unstaged", "merge-base")).toBe("unstaged");
  });
});

describe("provider-owned open-state validation", () => {
  test("argument parsing can pass an opaque mode to the selected provider", () => {
    const result = resolveReviewOpenState({
      parsed: { diffType: "provider-mode" },
      isPRMode: false,
      isWorkspace: false,
      provider: asOpenStatePolicy(gitReviewPolicy),
      resolvedDefaultDiffType: "since-base",
    });

    expect(result.error).toContain("Unknown diff type: provider-mode");
  });

  test("JJ owns its unsupported-open-state message", () => {
    const result = resolveReviewOpenState({
      parsed: { base: "main" },
      isPRMode: false,
      isWorkspace: false,
      provider: asOpenStatePolicy(jjReviewPolicy),
      resolvedDefaultDiffType: "jj-current",
    });

    expect(result.error).toContain("not supported in jj sessions yet");
  });
});
