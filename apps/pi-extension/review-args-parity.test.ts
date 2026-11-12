import { describe, expect, test } from "bun:test";

describe("vendored review-args parity", () => {
  test("the vendored parser reports unknown dash-prefixed tokens", async () => {
    const { parseReviewArgs } = await import("./generated/review-args.ts");
    const parsed = parseReviewArgs("--bse main");
    expect(parsed.errors).toEqual(["Unknown review option: --bse"]);
  });

  test("the vendored parser yields --base / --diff-type", async () => {
    const { parseReviewArgs } = await import("./generated/review-args.ts");
    const parsed = parseReviewArgs("--base develop --diff-type merge-base");
    expect(parsed.base).toBe("develop");
    expect(parsed.diffType).toBe("merge-base");
    expect(parsed.errors).toEqual([]);
  });

  test("the vendored parser yields --no-git-remote-check", async () => {
    const { parseReviewArgs } = await import("./generated/review-args.ts");
    const parsed = parseReviewArgs("--no-git-remote-check");
    expect(parsed.gitRemoteCheck).toBe(false);
    expect(parsed.errors).toEqual([]);
  });

  test("the vendored resolver treats path-shaped prose as prose but keeps a sole typo fatal", async () => {
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
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
    expect(source).toContain("defaultBranch: reviewArgs.base");
    expect(source).toContain("diffType: reviewArgs.diffType");
    expect(source).toContain("openStateFromFlags:");
  });
});
