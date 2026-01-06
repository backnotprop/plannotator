/**
 * Project Detection Tests
 *
 * Run: bun test apps/hook/server/project.test.ts
 */

import { describe, expect, test } from "bun:test";
import { sanitizeTag, extractRepoName, extractDirName, detectProjectName } from "./project";

describe("sanitizeTag", () => {
  test("lowercases input", () => {
    expect(sanitizeTag("MyProject")).toBe("myproject");
  });

  test("replaces spaces with hyphens", () => {
    expect(sanitizeTag("my project")).toBe("my-project");
  });

  test("replaces underscores with hyphens", () => {
    expect(sanitizeTag("my_project")).toBe("my-project");
  });

  test("removes special characters", () => {
    expect(sanitizeTag("my@project!name")).toBe("myprojectname");
  });

  test("collapses multiple hyphens", () => {
    expect(sanitizeTag("my--project")).toBe("my-project");
  });

  test("trims to 30 chars", () => {
    const long = "a".repeat(50);
    expect(sanitizeTag(long)?.length).toBe(30);
  });

  test("returns null for empty string", () => {
    expect(sanitizeTag("")).toBeNull();
  });

  test("returns null for single char", () => {
    expect(sanitizeTag("a")).toBeNull();
  });

  test("returns null for null/undefined", () => {
    expect(sanitizeTag(null as any)).toBeNull();
    expect(sanitizeTag(undefined as any)).toBeNull();
  });
});

describe("extractRepoName", () => {
  test("extracts name from full path", () => {
    expect(extractRepoName("/Users/dev/projects/my-app")).toBe("my-app");
  });

  test("handles trailing slash", () => {
    expect(extractRepoName("/Users/dev/my-app/")).toBe("my-app");
  });

  test("handles multiple trailing slashes", () => {
    expect(extractRepoName("/home/user/repo///")).toBe("repo");
  });

  test("returns null for empty string", () => {
    expect(extractRepoName("")).toBeNull();
  });

  test("returns null for just slash", () => {
    expect(extractRepoName("/")).toBeNull();
  });
});

describe("extractDirName", () => {
  test("extracts directory name", () => {
    expect(extractDirName("/home/user/workspace")).toBe("workspace");
  });

  test("skips generic names", () => {
    expect(extractDirName("/home")).toBeNull();
    expect(extractDirName("/Users")).toBeNull();
    expect(extractDirName("/root")).toBeNull();
    expect(extractDirName("/tmp")).toBeNull();
  });

  test("returns null for root path", () => {
    expect(extractDirName("/")).toBeNull();
  });

  test("sanitizes the result", () => {
    expect(extractDirName("/home/user/My Project")).toBe("my-project");
  });
});

describe("detectProjectName", () => {
  test("returns a string or null", async () => {
    const result = await detectProjectName();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("result is sanitized if not null", async () => {
    const result = await detectProjectName();
    if (result) {
      expect(result).toMatch(/^[a-z0-9-]+$/);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.length).toBeLessThanOrEqual(30);
    }
  });

  // This test verifies we get "planning-hook" when run from this repo
  test("detects current repo name", async () => {
    const result = await detectProjectName();
    // We're in the planning-hook repo, so should get that name
    expect(result).toBe("planning-hook");
  });
});
