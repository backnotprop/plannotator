/**
 * The Files view's pure rules (packages/shared/project-listing.ts): which
 * file contents are locked, the explorer order, what a folder request may
 * name, and how git's name-status becomes change marks. The server half is
 * proved against a real repository in packages/server/inbox-files.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  compareProjectEntries,
  hasGitSegment,
  hiddenSegmentPrefixes,
  normalizeProjectDir,
  parseNameStatusZ,
  projectFileLock,
} from "./project-listing";

describe("projectFileLock", () => {
  const nothingTracked = () => false;
  const tracks = (...prefixes: string[]) => (p: string) => prefixes.includes(p);

  test("dotenv files are locked by the name asked for and by the file it leads to; .env.example is not", () => {
    expect(projectFileLock(".env", ".env", nothingTracked)).toBe("dotenv");
    expect(projectFileLock("config/prod.env", "config/prod.env", nothingTracked)).toBe("dotenv");
    expect(projectFileLock(".envrc", ".envrc", nothingTracked)).toBe("dotenv");
    expect(projectFileLock(".env.local", ".env.local", tracks(".env.local"))).toBe("dotenv");
    // A harmless name that resolves to a dotenv file.
    expect(projectFileLock("notes.txt", "secrets/.env", tracks("secrets/.env"))).toBe("dotenv");
    expect(projectFileLock(".env.example", ".env.example", tracks(".env.example"))).toBeNull();
  });

  test("a file under a hidden segment git tracks nothing under is locked; a tracked one is not", () => {
    expect(projectFileLock(".claude/settings.json", ".claude/settings.json", nothingTracked)).toBe("hidden");
    expect(projectFileLock(".npmrc", ".npmrc", nothingTracked)).toBe("hidden");
    expect(projectFileLock(".github/workflows/ci.yml", ".github/workflows/ci.yml", tracks(".github"))).toBeNull();
    // Every hidden segment counts: a tracked `.github` does not open an untracked `.github/.secret/x`.
    expect(projectFileLock(".github/.secret/x", ".github/.secret/x", tracks(".github"))).toBe("hidden");
    // A plain name that resolves into an untracked hidden folder.
    expect(projectFileLock("docs/key", ".ssh/id_rsa", nothingTracked)).toBe("hidden");
    expect(projectFileLock("src/a.ts", "src/a.ts", nothingTracked)).toBeNull();
  });
});

test("hiddenSegmentPrefixes names each prefix ending in a hidden segment", () => {
  expect(hiddenSegmentPrefixes("a/.b/c/.d/e")).toEqual(["a/.b", "a/.b/c/.d"]);
  expect(hiddenSegmentPrefixes("src/a.ts")).toEqual([]);
  expect(hiddenSegmentPrefixes("")).toEqual([]);
});

test(".git is caught at any depth, and only as a whole segment", () => {
  expect(hasGitSegment(".git")).toBe(true);
  expect(hasGitSegment("vendor/lib/.git/config")).toBe(true);
  expect(hasGitSegment(".github/ci.yml")).toBe(false);
  expect(hasGitSegment("a.git")).toBe(false);
});

test("entries sort folders first, then names case-insensitively with numbers by value", () => {
  const entries = [
    { name: "b.txt", kind: "file" as const },
    { name: "file10.txt", kind: "file" as const },
    { name: "zeta", kind: "dir" as const },
    { name: "A.txt", kind: "file" as const },
    { name: "file2.txt", kind: "file" as const },
    { name: "alpha", kind: "dir" as const },
  ];
  expect(entries.sort(compareProjectEntries).map((e) => e.name)).toEqual(["alpha", "zeta", "A.txt", "b.txt", "file2.txt", "file10.txt"]);
});

test("normalizeProjectDir: empty is the root; absolute, .. and NUL are refused", () => {
  expect(normalizeProjectDir(null)).toBe("");
  expect(normalizeProjectDir("")).toBe("");
  expect(normalizeProjectDir("./src//lib/")).toBe("src/lib");
  expect(normalizeProjectDir("/etc")).toBeNull();
  expect(normalizeProjectDir("C:/Windows")).toBeNull();
  expect(normalizeProjectDir("src/../..")).toBeNull();
  expect(normalizeProjectDir("..\\up")).toBeNull();
  expect(normalizeProjectDir("src\0")).toBeNull();
});

test("parseNameStatusZ maps git's letters to marks and stops at the cap", () => {
  const out = "M\0src/a.ts\0A\0new.ts\0D\0gone.ts\0T\0link\0U\0conflict.ts\0";
  const { changes, truncated } = parseNameStatusZ(out);
  expect(Object.fromEntries(changes)).toEqual({ "src/a.ts": "M", "new.ts": "A", "gone.ts": "D", link: "M", "conflict.ts": "M" });
  expect(truncated).toBe(false);
  const capped = parseNameStatusZ(out, 2);
  expect(capped.changes.size).toBe(2);
  expect(capped.truncated).toBe(true);
});
