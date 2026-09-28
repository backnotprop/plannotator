import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Bun reads only the bunfig.toml in the directory `bun test` runs from. Without
 * a package-level copy, `bun test` inside a package skips the root preloads and
 * tests write drafts, history, and feedback into the contributor's real
 * ~/.plannotator. Catches a package that gains tests without a bunfig, or a
 * package bunfig that drifts from the root preload list.
 */
const repoRoot = resolve(import.meta.dir, "..");

function readPreload(bunfigPath: string): string[] {
  const parsed = Bun.TOML.parse(readFileSync(bunfigPath, "utf-8")) as {
    test?: { preload?: string[] };
  };
  return parsed.test?.preload ?? [];
}

function hasTestFiles(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (hasTestFiles(full)) return true;
    } else if (/\.test\.tsx?$/.test(entry)) {
      return true;
    }
  }
  return false;
}

const rootPreload = readPreload(join(repoRoot, "bunfig.toml")).map((p) => resolve(repoRoot, p));

const packageDirs = ["apps", "packages"].flatMap((group) =>
  readdirSync(join(repoRoot, group))
    .map((name) => join(repoRoot, group, name))
    .filter((dir) => statSync(dir).isDirectory() && hasTestFiles(dir)),
);

describe("package-directory bunfig.toml", () => {
  test("root preload sandboxes the data dir", () => {
    expect(rootPreload).toContain(resolve(repoRoot, "tests/setup/feedback-archive-off.ts"));
  });

  for (const dir of packageDirs) {
    const label = relative(repoRoot, dir);
    test(`${label} mirrors the root test preloads`, () => {
      const bunfig = join(dir, "bunfig.toml");
      expect(existsSync(bunfig)).toBe(true);
      expect(readPreload(bunfig).map((p) => resolve(dir, p))).toEqual(rootPreload);
    });
  }
});
