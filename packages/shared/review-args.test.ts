import { describe, expect, test } from "bun:test";
import { REVIEW_OPEN_DIFF_TYPES, parseReviewArgs } from "./review-args";
import { GIT_DIFF_TYPES, JJ_DIFF_TYPES } from "./vcs-core";

describe("parseReviewArgs", () => {
  test("defaults to auto VCS and local PR checkout", () => {
    expect(parseReviewArgs("")).toEqual({
      prUrl: undefined,
      vcsType: undefined,
      useLocal: true,
      errors: [],
    });
  });

  test("parses --git without a PR URL", () => {
    expect(parseReviewArgs("--git")).toEqual({
      prUrl: undefined,
      vcsType: "git",
      useLocal: true,
      errors: [],
    });
  });

  test("parses --gitbutler without a PR URL", () => {
    expect(parseReviewArgs("--gitbutler")).toEqual({
      prUrl: undefined,
      vcsType: "gitbutler",
      useLocal: true,
      errors: [],
    });
  });

  test("parses PR URLs before or after --git", () => {
    expect(parseReviewArgs("--git https://github.com/acme/repo/pull/12")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: true,
      errors: [],
    });
    expect(parseReviewArgs("https://github.com/acme/repo/pull/12 --git")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: true,
      errors: [],
    });
  });

  test("preserves --no-local for PR review mode", () => {
    expect(parseReviewArgs("--no-local https://github.com/acme/repo/pull/12")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: undefined,
      useLocal: false,
      errors: [],
    });
  });

  test("accepts argv arrays from the compiled CLI", () => {
    expect(parseReviewArgs(["--git", "--no-local", "https://github.com/acme/repo/pull/12"])).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: false,
      errors: [],
    });
  });

  test("strips wrapping quotes from string and argv inputs", () => {
    expect(parseReviewArgs(`--git "https://github.com/acme/repo/pull/12"`).prUrl)
      .toBe("https://github.com/acme/repo/pull/12");
    expect(parseReviewArgs(["--git", "\"https://github.com/acme/repo/pull/12\""]).prUrl)
      .toBe("https://github.com/acme/repo/pull/12");
  });

  test("keeps non-url positional input as local review mode", () => {
    // Positional word tolerance is load-bearing: slash-command hosts forward
    // raw user prose to `plannotator review` verbatim. Over-tightening this
    // would break every /plannotator-review invocation that carries words.
    expect(parseReviewArgs("--git not-a-url")).toEqual({
      prUrl: undefined,
      vcsType: "git",
      useLocal: true,
      errors: [],
    });
  });

  test("reports unknown dash-prefixed tokens instead of silently dropping them", () => {
    // The pre-existing silent-swallow bug: `--bse main` used to land in
    // `positional`, be ignored, and the session opened as if nothing happened —
    // on every host. A typo'd flag must fail loudly, exactly as on annotate.
    const parsed = parseReviewArgs("--bse main");
    expect(parsed.errors).toEqual(["Unknown review option: --bse"]);
    // The stray value token stays a tolerated positional word.
    expect(parsed.prUrl).toBeUndefined();
  });

  test("reports every unknown dashed token, including = forms", () => {
    // `--base=main` is not a supported value syntax (space-separated only), so
    // it must surface as an unknown option rather than being half-parsed.
    const parsed = parseReviewArgs("--verbose --base=main");
    expect(parsed.errors).toEqual([
      "Unknown review option: --verbose",
      "Unknown review option: --base=main",
    ]);
  });

  test("parses --base and --diff-type values into the struct", () => {
    // Failure caught: the value never reaching the struct at all (the
    // pre-PR silent swallow, or a broken value-consuming loop).
    const parsed = parseReviewArgs("--base feature/part-1 --diff-type merge-base");
    expect(parsed.base).toBe("feature/part-1");
    expect(parsed.diffType).toBe("merge-base");
    expect(parsed.errors).toEqual([]);
  });

  test("accepts stable JJ diff modes as explicit session overrides", () => {
    expect(parseReviewArgs(["--diff-type", "jj-line", "--base", "develop@origin"])).toMatchObject({
      vcsType: undefined,
      diffType: "jj-line",
      base: "develop@origin",
      errors: [],
    });
  });

  test("--base's value cannot shadow a following PR URL", () => {
    // Failure caught: the value token landing in positional[0] and shadowing
    // the URL — a real regression path since only positional[0] is a URL
    // candidate.
    const parsed = parseReviewArgs("--base main https://github.com/acme/repo/pull/12");
    expect(parsed.base).toBe("main");
    expect(parsed.prUrl).toBe("https://github.com/acme/repo/pull/12");
    expect(parsed.errors).toEqual([]);
  });

  test("--base at end of argv reports a missing value", () => {
    // Failure caught: a silently-undefined base that then diffs against the
    // detected default as if the flag had worked.
    expect(parseReviewArgs("--base").errors).toEqual(["Missing value for --base"]);
    expect(parseReviewArgs("--base --git").errors).toEqual(["Missing value for --base"]);
    expect(parseReviewArgs("--diff-type").errors).toEqual(["Missing value for --diff-type"]);
  });

  test("--base twice is an error, not last-wins", () => {
    const parsed = parseReviewArgs("--base a --base b");
    expect(parsed.errors).toEqual(["--base may only be specified once"]);
    // The second value must not silently replace the first.
    expect(parsed.base).toBe("a");
  });

  test("--diff-type rejects unknown ids, listing the valid set", () => {
    // Failure caught: an unowned diff type reaching resolveRequestedDiffType,
    // which silently falls back to the configured default.
    const parsed = parseReviewArgs("--diff-type nonsense");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("Unknown diff type: nonsense");
    for (const id of REVIEW_OPEN_DIFF_TYPES) {
      expect(parsed.errors[0]).toContain(id);
    }
    expect(parsed.diffType).toBeUndefined();
  });

  test("rejects base refs carrying range syntax", () => {
    // Defense in depth ahead of the rev-parse probe: `..` is range syntax,
    // never a single compare target.
    expect(parseReviewArgs("--base main..feature").errors).toEqual([
      "Invalid base ref: main..feature",
    ]);
  });

  test("REVIEW_OPEN_DIFF_TYPES is exactly the stable Git and JJ modes", () => {
    // Failure caught: a stable provider diff type added to one set and not the
    // other, making a valid mode unreachable from the CLI.
    expect(new Set(REVIEW_OPEN_DIFF_TYPES)).toEqual(new Set([...GIT_DIFF_TYPES, ...JJ_DIFF_TYPES]));
  });

  test("an unknown dashed token cannot shadow a PR URL", () => {
    // Before the errors[] contract, `--bse` landed in positional[0] and the
    // real PR URL in positional[1] was never inspected — the PR silently
    // became a local review. Now the invocation refuses instead.
    const parsed = parseReviewArgs("--bse https://github.com/acme/repo/pull/12");
    expect(parsed.errors).toEqual(["Unknown review option: --bse"]);
    expect(parsed.prUrl).toBe("https://github.com/acme/repo/pull/12");
  });
});
