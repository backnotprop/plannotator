import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import {
  detectGeneratedFiles,
  detectGeneratedFilesByName,
  isDefaultGeneratedPath,
  parseCheckAttrStates,
} from "./generated-files";
import type { ReviewGitRuntime } from "./review-core";

// Same minimal git harness as review-core.test.ts (per-file test harnesses
// are this package's style — each suite stays runnable in isolation).
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function makeRuntime(baseCwd: string): ReviewGitRuntime {
  return {
    async getFileInfo() {
      return null;
    },
    async readLink() {
      return null;
    },
    async runGit(args: string[], options?: { cwd?: string; stdin?: string }) {
      const result = spawnSync("git", args, {
        cwd: options?.cwd ?? baseCwd,
        encoding: "utf-8",
        input: options?.stdin,
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? (result.error ? 1 : 0),
      };
    },
    async readTextFile(path: string) {
      try {
        const fullPath = path.startsWith("/") ? path : resolvePath(baseCwd, path);
        return readFileSync(fullPath, "utf-8");
      } catch {
        return null;
      }
    },
  };
}

function initRepo(): string {
  const repoDir = makeTempDir("plannotator-generated-files-");
  git(repoDir, ["init", "-q"]);
  return repoDir;
}

describe("detectGeneratedFiles", () => {
  test("resolves bare, =true, negated, and =false rules exactly as git does", async () => {
    const repo = initRepo();
    writeFileSync(
      join(repo, ".gitattributes"),
      [
        "/CLAUDE.md linguist-generated=true",
        "gen/** linguist-generated",
        // Negated rule stacked after the glob: git must win this resolution,
        // not a naive first-match parser.
        "gen/keep.ts -linguist-generated",
        "docs/api.md linguist-generated=false",
      ].join("\n") + "\n",
    );
    mkdirSync(join(repo, "gen"), { recursive: true });

    const generated = await detectGeneratedFiles(makeRuntime(repo), repo, [
      "CLAUDE.md",
      "gen/schema.sql",
      "gen/keep.ts",
      "docs/api.md",
      "src/app.ts",
    ]);

    expect(generated).toEqual(["CLAUDE.md", "gen/schema.sql"]);
  });

  test("dedupes paths and preserves diff order in the result", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, ".gitattributes"), "*.lock linguist-generated\n");

    const generated = await detectGeneratedFiles(makeRuntime(repo), repo, [
      "b.lock",
      "a.lock",
      "b.lock",
    ]);

    expect(generated).toEqual(["b.lock", "a.lock"]);
  });

  test("handles paths with spaces via NUL-terminated stdin", async () => {
    const repo = initRepo();
    // Quoted-pattern support for spaces in .gitattributes is inconsistent
    // across git versions; a directory rule covers the spaced filename.
    writeFileSync(join(repo, ".gitattributes"), "generated/** linguist-generated\n");

    const generated = await detectGeneratedFiles(makeRuntime(repo), repo, [
      "generated/weird name.md",
      "src/ok.ts",
    ]);

    expect(generated).toEqual(["generated/weird name.md"]);
  });

  test("outside a git work tree the name-based defaults still apply", async () => {
    const plainDir = makeTempDir("plannotator-generated-nogit-");
    const generated = await detectGeneratedFiles(makeRuntime(plainDir), plainDir, [
      "a.md",
      "bun.lock",
    ]);
    // check-attr fails (not a work tree) — the built-in list stands alone.
    expect(generated).toEqual(["bun.lock"]);
  });

  test("explicit .gitattributes wins over the built-in list in BOTH directions", async () => {
    const repo = initRepo();
    writeFileSync(
      join(repo, ".gitattributes"),
      [
        // Un-mark a built-in default: the lockfile must render expanded.
        "yarn.lock -linguist-generated",
        "package-lock.json linguist-generated=false",
        // Mark a file the built-in list knows nothing about.
        "src/schema.ts linguist-generated",
      ].join("\n") + "\n",
    );

    const generated = await detectGeneratedFiles(makeRuntime(repo), repo, [
      "yarn.lock",
      "package-lock.json",
      "bun.lock", // unspecified — falls through to the built-in default
      "src/schema.ts",
      "src/app.ts",
    ]);

    expect(generated).toEqual(["bun.lock", "src/schema.ts"]);
  });

  test("returns empty for an empty path list without spawning git", async () => {
    let spawned = false;
    const runtime: ReviewGitRuntime = {
      async getFileInfo() {
        return null;
      },
      async readLink() {
        return null;
      },
      async runGit() {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readTextFile() {
        return null;
      },
    };
    expect(await detectGeneratedFiles(runtime, undefined, ["", ""])).toEqual([]);
    expect(spawned).toBe(false);
  });
});

describe("parseCheckAttrStates", () => {
  test("maps set/true to set, unset/false to unset, everything else to unspecified", () => {
    const stdout = [
      "a.md", "linguist-generated", "true",
      "b.sql", "linguist-generated", "set",
      "c.ts", "linguist-generated", "unset",
      "d.md", "linguist-generated", "false",
      "e.ts", "linguist-generated", "unspecified",
    ].join("\0") + "\0";
    expect(parseCheckAttrStates(stdout)).toEqual(
      new Map([
        ["a.md", "set"],
        ["b.sql", "set"],
        ["c.ts", "unset"],
        ["d.md", "unset"],
        ["e.ts", "unspecified"],
      ]),
    );
  });
});

describe("built-in generated defaults", () => {
  test("matches exact lockfile names and *.min/*.map globs on the LAST path segment only", () => {
    // Exact names, at the root and nested.
    expect(isDefaultGeneratedPath("bun.lock")).toBe(true);
    expect(isDefaultGeneratedPath("apps/web/package-lock.json")).toBe(true);
    // Glob suffixes.
    expect(isDefaultGeneratedPath("vendor/app.min.js")).toBe(true);
    expect(isDefaultGeneratedPath("dist/styles.min.css")).toBe(true);
    expect(isDefaultGeneratedPath("dist/app.js.map")).toBe(true);
    // A DIRECTORY named bun.lock never marks the files inside it.
    expect(isDefaultGeneratedPath("bun.lock/README.md")).toBe(false);
    // Ordinary sources stay unmarked.
    expect(isDefaultGeneratedPath("src/app.ts")).toBe(false);
    expect(isDefaultGeneratedPath("src/min.js")).toBe(false);
  });

  test("detectGeneratedFilesByName dedupes and preserves input order (the non-git sidecar path)", () => {
    expect(
      detectGeneratedFilesByName([
        "folder/yarn.lock",
        "src/app.ts",
        "bun.lock",
        "folder/yarn.lock",
      ]),
    ).toEqual(["folder/yarn.lock", "bun.lock"]);
  });
});
