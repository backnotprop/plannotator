/**
 * Plan Storage Tests
 *
 * Run: bun test packages/server/storage.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSlug, getPlanDir, savePlan, saveToHistory, getPlanVersion, getVersionCount, listVersions } from "./storage";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-storage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateSlug", () => {
  test("uses first heading and date", () => {
    const slug = generateSlug("# My Plan\n\nSome content");
    const date = new Date().toISOString().split("T")[0];
    expect(slug).toMatch(/^my-plan-\d{4}-\d{2}-\d{2}$/);
    expect(slug).toEndWith(date);
  });

  test("falls back to 'plan' when no heading", () => {
    const slug = generateSlug("No heading here");
    expect(slug).toMatch(/^plan-\d{4}-\d{2}-\d{2}$/);
  });

  test("same heading on same day produces same slug", () => {
    const a = generateSlug("# Deploy Strategy\nVersion A");
    const b = generateSlug("# Deploy Strategy\nVersion B");
    expect(a).toBe(b);
  });

  test("different headings produce different slugs", () => {
    const a = generateSlug("# Plan A");
    const b = generateSlug("# Plan B");
    expect(a).not.toBe(b);
  });
});

describe("getPlanDir", () => {
  test("creates directory at custom path", () => {
    const dir = makeTempDir();
    const customPath = join(dir, "custom", "plans");
    const result = getPlanDir(customPath);
    expect(result).toBe(customPath);
    // Directory should exist
    expect(readdirSync(customPath)).toBeDefined();
  });

  test("expands tilde in custom path", () => {
    const result = getPlanDir("~/.plannotator/test-plans");
    expect(result).not.toContain("~");
    expect(result).toMatch(/\.plannotator\/test-plans$/);
  });

  test("uses default when no custom path", () => {
    const result = getPlanDir();
    expect(result).toMatch(/\.plannotator\/plans$/);
  });

  test("uses default for null", () => {
    const result = getPlanDir(null);
    expect(result).toMatch(/\.plannotator\/plans$/);
  });
});

describe("savePlan", () => {
  test("writes markdown file to disk", () => {
    const dir = makeTempDir();
    const path = savePlan("test-slug", "# Content", dir);
    expect(path).toBe(join(dir, "test-slug.md"));
    expect(readFileSync(path, "utf-8")).toBe("# Content");
  });
});

describe("saveToHistory", () => {
  test("creates first version as 001.md", () => {
    const slug = `first-version-${Date.now()}`;
    const result = saveToHistory("test-project", slug, "# V1");
    expect(result.version).toBe(1);
    expect(result.path).toEndWith("001.md");
    expect(result.isNew).toBe(true);
    expect(readFileSync(result.path, "utf-8")).toBe("# V1");
  });

  test("increments version number", () => {
    const slug = `inc-test-${Date.now()}`;
    const v1 = saveToHistory("test-project", slug, "# V1");
    const v2 = saveToHistory("test-project", slug, "# V2");
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.path).toEndWith("002.md");
  });

  test("deduplicates identical content", () => {
    const slug = `dedup-test-${Date.now()}`;
    const v1 = saveToHistory("test-project", slug, "# Same");
    const v2 = saveToHistory("test-project", slug, "# Same");
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(1);
    expect(v2.isNew).toBe(false);
  });

  test("saves when content differs", () => {
    const slug = `diff-test-${Date.now()}`;
    const v1 = saveToHistory("test-project", slug, "# V1");
    const v2 = saveToHistory("test-project", slug, "# V2");
    expect(v2.isNew).toBe(true);
    expect(v2.version).toBe(2);
  });
});

describe("getPlanVersion", () => {
  test("reads saved version content", () => {
    const slug = `read-test-${Date.now()}`;
    saveToHistory("test-project", slug, "# Read Me");
    const content = getPlanVersion("test-project", slug, 1);
    expect(content).toBe("# Read Me");
  });

  test("returns null for nonexistent version", () => {
    const content = getPlanVersion("test-project", "nonexistent", 99);
    expect(content).toBeNull();
  });
});

describe("getVersionCount", () => {
  test("returns 0 for nonexistent project", () => {
    expect(getVersionCount("nope", "nope")).toBe(0);
  });

  test("counts versions correctly", () => {
    const slug = `count-test-${Date.now()}`;
    saveToHistory("test-project", slug, "# V1");
    saveToHistory("test-project", slug, "# V2");
    saveToHistory("test-project", slug, "# V3");
    expect(getVersionCount("test-project", slug)).toBe(3);
  });
});

describe("listVersions", () => {
  test("returns empty for nonexistent project", () => {
    expect(listVersions("nope", "nope")).toEqual([]);
  });

  test("lists versions in ascending order", () => {
    const slug = `list-test-${Date.now()}`;
    saveToHistory("test-project", slug, "# V1");
    saveToHistory("test-project", slug, "# V2");
    const versions = listVersions("test-project", slug);
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(1);
    expect(versions[1].version).toBe(2);
    expect(versions[0].timestamp).toBeTruthy();
  });
});
