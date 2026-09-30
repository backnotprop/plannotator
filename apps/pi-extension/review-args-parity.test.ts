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

  test("the vendored parser yields --no-git-remote-check", async () => {
    // #1553: a stale vendor would leave Pi refusing the opt-out flag as an
    // unknown option, so the one host whose users cannot easily set env vars
    // would have no way to turn the remote check off.
    const { parseReviewArgs } = await import("./generated/review-args.ts");
    const parsed = parseReviewArgs("--no-git-remote-check");
    expect(parsed.gitRemoteCheck).toBe(false);
    expect(parsed.errors).toEqual([]);
  });

  test("the vendored resolver treats path-shaped prose as prose but keeps a sole typo fatal", async () => {
    // Pi's /plannotator-review passes raw words; a stale vendor would refuse
    // "look at the api/users code" instead of reviewing the cwd (v0.27.23).
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { parseReviewArgs, resolveReviewTarget } = await import("./generated/review-args.ts");
    const root = mkdtempSync(join(tmpdir(), "pi-review-target-"));
    try {
      mkdirSync(join(root, "backend"));
      writeFileSync(join(root, "notes.txt"), "x");
      const target = (input: string) => resolveReviewTarget(parseReviewArgs(input), root);
      expect(target("look at the api/users code").directory).toBeUndefined();
      expect(target("look at ./notes.txt please").ignored).toContain("./notes.txt");
      expect(target("look at ./backend please").directory).toBe(join(root, "backend"));
      expect(() => target("./backnd")).toThrow("does not exist");
      expect(() => target("./notes.txt")).toThrow("not a directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the vendored open-state validator applies the provider matrix", async () => {
    // Guards the vendor.sh entry for review-open-state: without it Pi's
    // review command would crash on import instead of validating.
    const { resolveReviewOpenState } = await import("./generated/review-open-state.ts");
    const state = resolveReviewOpenState({
      parsed: { base: "main" },
      isPRMode: false,
      isWorkspace: false,
      providerId: "jj",
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
