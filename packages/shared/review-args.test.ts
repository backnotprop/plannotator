import { describe, expect, test } from "bun:test";
import { parseReviewArgs } from "./review-args";

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

  test("an unknown dashed token cannot shadow a PR URL", () => {
    // Before the errors[] contract, `--bse` landed in positional[0] and the
    // real PR URL in positional[1] was never inspected — the PR silently
    // became a local review. Now the invocation refuses instead.
    const parsed = parseReviewArgs("--bse https://github.com/acme/repo/pull/12");
    expect(parsed.errors).toEqual(["Unknown review option: --bse"]);
    expect(parsed.prUrl).toBe("https://github.com/acme/repo/pull/12");
  });
});
