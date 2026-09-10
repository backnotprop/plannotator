import { describe, expect, test } from "bun:test";

/**
 * Parity guard for the VENDORED review-args copy (generated/review-args.ts,
 * written by vendor.sh). Pi's /plannotator-review parses through this copy,
 * so a forgotten vendor run would leave Pi on a parser that silently swallows
 * flags the shared parser now reports — the exact cross-host drift the
 * `errors` contract exists to prevent.
 */
describe("vendored review-args parity", () => {
  test("the vendored parser reports unknown dash-prefixed tokens", async () => {
    const { parseReviewArgs } = await import("./generated/review-args.ts");
    const parsed = parseReviewArgs("--bse main");
    expect(parsed.errors).toEqual(["Unknown review option: --bse"]);
  });

  test("the vendored parser yields --base / --diff-type", async () => {
    // A stale vendor would leave Pi on a parser that reports these as
    // unknown options — the flag would be loudly refused instead of working.
    const { parseReviewArgs } = await import("./generated/review-args.ts");
    const parsed = parseReviewArgs("--base develop --diff-type merge-base");
    expect(parsed.base).toBe("develop");
    expect(parsed.diffType).toBe("merge-base");
    expect(parsed.errors).toEqual([]);
  });

  test("the vendored open-state validator applies the provider matrix", async () => {
    // Guards the vendor.sh entry for review-open-state: without it Pi's
    // review command would crash on import instead of validating.
    const { resolveReviewOpenState } = await import("./generated/review-open-state.ts");
    const { jjReviewPolicy } = await import("./generated/jj-review-policy.ts");
    const state = resolveReviewOpenState({
      parsed: { base: "main" },
      isPRMode: false,
      isWorkspace: false,
      provider: { resolve: jjReviewPolicy.resolveOpenState },
      resolvedDefaultDiffType: "since-base",
    });
    expect(state.error).toContain("--base is not supported in jj sessions");
  });

  test("the review command handler forwards the parsed open state", async () => {
    // Source-level pin: the fields being parsed and then dropped at the
    // startCodeReviewBrowserSession call site would make the flags silently
    // inert on Pi — precisely the degrade story §9.1 rules out.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
    expect(source).toContain("defaultBranch: reviewArgs.base");
    expect(source).toContain("diffType: reviewArgs.diffType");
    expect(source).toContain("openStateFromFlags:");
  });
});
