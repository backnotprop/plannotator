import { describe, expect, test } from "bun:test";
import { parseReviewArgs } from "./review-args";

describe("parseReviewArgs", () => {
  test("defaults to auto VCS and local PR checkout", () => {
    expect(parseReviewArgs("")).toEqual({
      prUrl: undefined,
      vcsType: undefined,
      useLocal: true,
    });
  });

  test("parses --git without a PR URL", () => {
    expect(parseReviewArgs("--git")).toEqual({
      prUrl: undefined,
      vcsType: "git",
      useLocal: true,
    });
  });

  test("parses PR URLs before or after --git", () => {
    expect(parseReviewArgs("--git https://github.com/acme/repo/pull/12")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: true,
    });
    expect(parseReviewArgs("https://github.com/acme/repo/pull/12 --git")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: true,
    });
  });

  test("preserves --no-local for PR review mode", () => {
    expect(parseReviewArgs("--no-local https://github.com/acme/repo/pull/12")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: undefined,
      useLocal: false,
    });
  });

  test("accepts argv arrays from the compiled CLI", () => {
    expect(parseReviewArgs(["--git", "--no-local", "https://github.com/acme/repo/pull/12"])).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: false,
    });
  });

  test("strips wrapping quotes from string and argv inputs", () => {
    expect(parseReviewArgs(`--git "https://github.com/acme/repo/pull/12"`).prUrl)
      .toBe("https://github.com/acme/repo/pull/12");
    expect(parseReviewArgs(["--git", "\"https://github.com/acme/repo/pull/12\""]).prUrl)
      .toBe("https://github.com/acme/repo/pull/12");
  });

  test("keeps non-url positional input as local review mode", () => {
    expect(parseReviewArgs("--git not-a-url")).toEqual({
      prUrl: undefined,
      vcsType: "git",
      useLocal: true,
    });
  });

  test("parses --tripwires", () => {
    expect(parseReviewArgs("--tripwires").tripwires).toBe(true);
  });

  test("parses the -t alias", () => {
    expect(parseReviewArgs("-t").tripwires).toBe(true);
  });

  test("parses --add-tripwire <description>", () => {
    expect(parseReviewArgs("--add-tripwire src/auth/**").addTripwire).toBe("src/auth/**");
  });

  test("--add-tripwire consumes the whole unquoted multi-word description", () => {
    const parsed = parseReviewArgs("--add-tripwire protect the billing module from edits");
    expect(parsed.addTripwire).toBe("protect the billing module from edits");
    expect(parsed.prUrl).toBeUndefined();
  });

  test("flags before --add-tripwire still parse; tokens after it join the description", () => {
    const parsed = parseReviewArgs("--git --add-tripwire the auth core --no-local");
    expect(parsed.vcsType).toBe("git");
    // Everything after the flag is description, even flag-shaped tokens.
    expect(parsed.addTripwire).toBe("the auth core --no-local");
  });

  test("-t composes with --git and a PR URL", () => {
    const parsed = parseReviewArgs("-t --git https://github.com/acme/repo/pull/12");
    expect(parsed.tripwires).toBe(true);
    expect(parsed.vcsType).toBe("git");
    expect(parsed.prUrl).toBe("https://github.com/acme/repo/pull/12");
  });

  test("--add-tripwire as the last token with no value leaves addTripwire undefined", () => {
    // The glob is expected as the NEXT token; missing it must not consume a
    // positional or default to a URL.
    expect(parseReviewArgs("--add-tripwire").addTripwire).toBeUndefined();
  });

  test("--add-tripwire value is not treated as a positional PR target", () => {
    const parsed = parseReviewArgs("--add-tripwire src/**");
    expect(parsed.addTripwire).toBe("src/**");
    expect(parsed.prUrl).toBeUndefined();
  });

  test("flags parse identically through the argv-array path", () => {
    const parsed = parseReviewArgs(["-t", "--add-tripwire", "lib/*.ts"]);
    expect(parsed.tripwires).toBe(true);
    expect(parsed.addTripwire).toBe("lib/*.ts");
  });
});
