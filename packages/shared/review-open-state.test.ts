import { describe, expect, test } from "bun:test";
import {
  BASE_RELATIVE_DIFF_TYPES,
  buildBaseNotFoundError,
  resolveReviewOpenState,
  suggestBaseRefs,
} from "./review-open-state";
import type { ReviewOpenStateInput } from "./review-open-state";
import type { DiffType } from "./review-core";

function input(overrides: Partial<ReviewOpenStateInput> = {}): ReviewOpenStateInput {
  return {
    parsed: {},
    isPRMode: false,
    isWorkspace: false,
    providerId: "git",
    resolvedDefaultDiffType: "since-base",
    ...overrides,
  };
}

describe("resolveReviewOpenState", () => {
  test("no flags means no seed, no notices, no error", () => {
    expect(resolveReviewOpenState(input())).toEqual({ notices: [] });
  });

  test("git + --base seeds base and requests the base-relative default explicitly", () => {
    // Requesting the default EXPLICITLY (not leaving it to configuredDiffType)
    // is what makes `--base trunk` work on a repo where getGitContext omitted
    // since-base — resolveRequestedDiffType honors owned requests regardless
    // of diffOptions. Dropping this reverts §4.6.
    const state = resolveReviewOpenState(
      input({ parsed: { base: "feature/part-1" }, baseResolves: true }),
    );
    expect(state.error).toBeUndefined();
    expect(state.requestedBase).toBe("feature/part-1");
    expect(state.requestedDiffType).toBe("since-base");
    expect(state.notices).toEqual([]);
  });

  test.each(["gitbutler", "p4"] as const)(
    "%s + --base errors instead of accept-and-ignore",
    (providerId) => {
      // These providers derive their own base (or have none): accepting the
      // flag would quietly review
      // against the wrong base — the silent lie this matrix exists to prevent.
      const state = resolveReviewOpenState(
        input({ providerId, parsed: { base: "feature/part-1" }, baseResolves: true }),
      );
      expect(state.error).toContain("--base is not supported");
      expect(state.requestedBase).toBeUndefined();
    },
  );

  test.each(["gitbutler", "p4"] as const)(
    "%s + --diff-type since-base errors instead of accept-and-ignore",
    (providerId) => {
      // ownsDiffType rejects git diff ids on these providers, so the request
      // would be silently dropped by resolveRequestedDiffType.
      const state = resolveReviewOpenState(
        input({ providerId, parsed: { diffType: "since-base" } }),
      );
      expect(state.error).toContain("--diff-type is not supported");
    },
  );

  test("JJ flags seed native modes and only allow a base for line-of-work", () => {
    expect(resolveReviewOpenState(input({
      providerId: "jj",
      parsed: { diffType: "jj-last" },
      resolvedDefaultDiffType: "jj-current",
    }))).toEqual({ requestedDiffType: "jj-last", notices: [] });

    expect(resolveReviewOpenState(input({
      providerId: "jj",
      parsed: { base: "develop@origin" },
      resolvedDefaultDiffType: "jj-current",
    }))).toEqual({ requestedBase: "develop@origin", requestedDiffType: "jj-line", notices: [] });

    expect(resolveReviewOpenState(input({
      providerId: "jj",
      parsed: { base: "develop@origin", diffType: "jj-current" },
    })).error).toContain("--base has no effect");
  });

  test("workspace + either flag errors (a base parameter with nowhere to go)", () => {
    const base = resolveReviewOpenState(
      input({ isWorkspace: true, providerId: undefined, parsed: { base: "main" } }),
    );
    expect(base.error).toContain("multi-repo workspace review");
    const diffType = resolveReviewOpenState(
      input({ isWorkspace: true, providerId: undefined, parsed: { diffType: "uncommitted" } }),
    );
    expect(diffType.error).toContain("multi-repo workspace review");
  });

  test("PR mode + either flag errors (the base comes from the pull request)", () => {
    const base = resolveReviewOpenState(
      input({ isPRMode: true, providerId: undefined, parsed: { base: "main" } }),
    );
    expect(base.error).toContain("pull request");
    const diffType = resolveReviewOpenState(
      input({ isPRMode: true, providerId: undefined, parsed: { diffType: "merge-base" } }),
    );
    expect(diffType.error).toContain("pull request");
  });

  test("--base with a base-irrelevant resolved default promotes to since-base with one notice", () => {
    // Without the promotion, "the base I passed did nothing" — the exact bug
    // the flag exists to fix. Without the notice, the second thing the flag
    // changed would be silent.
    const state = resolveReviewOpenState(
      input({
        parsed: { base: "feature/part-1" },
        resolvedDefaultDiffType: "uncommitted",
        baseResolves: true,
      }),
    );
    expect(state.error).toBeUndefined();
    expect(state.requestedDiffType).toBe("since-base");
    expect(state.notices).toHaveLength(1);
    expect(state.notices[0]).toContain("since-base");
    expect(state.notices[0]).toContain("uncommitted");
  });

  test("--base with an explicit base-irrelevant --diff-type is a fatal contradiction", () => {
    const state = resolveReviewOpenState(
      input({
        parsed: { base: "main", diffType: "uncommitted" },
        baseResolves: true,
      }),
    );
    expect(state.error).toContain("--base has no effect with --diff-type uncommitted");
    expect(state.error).toContain(BASE_RELATIVE_DIFF_TYPES.join(", "));
  });

  test("--base with a base-relative resolved default is left alone, no notice", () => {
    // Over-eager promotion would override a deliberate merge-base default.
    const state = resolveReviewOpenState(
      input({
        parsed: { base: "feature/part-1" },
        resolvedDefaultDiffType: "merge-base",
        baseResolves: true,
      }),
    );
    expect(state.requestedDiffType).toBe("merge-base");
    expect(state.notices).toEqual([]);
  });

  test("a probed base that does not resolve is fatal", () => {
    // The worst failure this feature could ship: since-base silently degrades
    // a bad base to HEAD (review-core.ts merge-base fallback) under the label
    // "All changes since <bad-ref>" — a plausible, wrong, confident diff.
    const state = resolveReviewOpenState(
      input({ parsed: { base: "feature/prat-1" }, baseResolves: false }),
    );
    expect(state.error).toContain("Base ref not found: feature/prat-1");
  });

  test("--diff-type alone seeds the diff type", () => {
    const state = resolveReviewOpenState(input({ parsed: { diffType: "merge-base" } }));
    expect(state).toEqual({ requestedDiffType: "merge-base" as DiffType, notices: [] });
  });
});

describe("buildBaseNotFoundError near matches", () => {
  test("suggests close branch names so an agent can self-correct", () => {
    const message = buildBaseNotFoundError("feature/prat-1", {
      local: ["feature/part-1", "main", "wip/unrelated"],
      remote: ["origin/feature/part-1"],
    });
    expect(message).toContain("feature/part-1");
    expect(message).not.toContain("wip/unrelated");
  });

  test("caps suggestions at five", () => {
    const local = Array.from({ length: 9 }, (_, i) => `topic/${i}`);
    expect(suggestBaseRefs("topic", { local, remote: [] })).toHaveLength(5);
  });
});
