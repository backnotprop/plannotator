/**
 * Plan Storage Tests
 *
 * Run: bun test packages/server/storage.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSlug,
  resolvePlanHistorySlug,
  getPlanDir,
  savePlan,
  saveFinalSnapshot,
  saveToHistory,
  getPlanVersion,
  getVersionCount,
  listVersions,
  listArchivedPlans,
} from "./storage";

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

  test("archive slug is dated by the UTC day of the clock, independent of content", () => {
    const evening = new Date("2026-10-02T23:50:00Z");
    expect(generateSlug("# Deploy Strategy\nVersion A", evening)).toBe("deploy-strategy-2026-10-02");
    expect(generateSlug("# Deploy Strategy\nVersion B", evening)).toBe("deploy-strategy-2026-10-02");
    // Past UTC midnight the ARCHIVE name moves to the new date by design;
    // history continuity is resolvePlanHistorySlug's job (#1679).
    expect(generateSlug("# Deploy Strategy", new Date("2026-10-03T00:10:00Z"))).toBe("deploy-strategy-2026-10-03");
  });

  test("different headings produce different slugs", () => {
    const a = generateSlug("# Plan A");
    const b = generateSlug("# Plan B");
    expect(a).not.toBe(b);
  });
});

// #1679: the version-history chain must not reset at UTC midnight.
describe("resolvePlanHistorySlug", () => {
  const project = "midnight-project";
  const HOUR = 60 * 60 * 1000;

  /** Run with a temp data dir, set inside the test and restored after. */
  function withDataDir(fn: () => void): void {
    const saved = process.env.PLANNOTATOR_DATA_DIR;
    try {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
      fn();
    } finally {
      if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = saved;
    }
  }

  /** Save a version the way a plan server does at `now`, stamping its file time. */
  function saveAt(plan: string, now: Date) {
    const slug = resolvePlanHistorySlug(project, plan, { now });
    const result = saveToHistory(project, slug, plan);
    utimesSync(result.path, now, now);
    const previousPlan = result.version > 1 ? getPlanVersion(project, slug, result.version - 1) : null;
    return { slug, ...result, previousPlan };
  }

  test("a plan saved at 23:50 and revised at 00:10 keeps one chain with a diff base", () => {
    withDataDir(() => {
      const v1 = saveAt("# Deploy Strategy\n\nv1", new Date("2026-10-02T23:50:00Z"));
      const v2 = saveAt("# Deploy Strategy\n\nv2", new Date("2026-10-03T00:10:00Z"));
      expect(v1.slug).toBe("deploy-strategy-2026-10-02");
      expect(v2.slug).toBe(v1.slug);
      expect(v2.version).toBe(2);
      expect(v2.previousPlan).toBe("# Deploy Strategy\n\nv1");
      expect(getVersionCount(project, v1.slug)).toBe(2);
    });
  });

  test("the reported case: a review resumed ~39h later continues the chain", () => {
    withDataDir(() => {
      const v1 = saveAt("# Deploy Strategy\n\nv1", new Date("2026-10-02T20:02:00Z"));
      const v2 = saveAt("# Deploy Strategy\n\nv2", new Date("2026-10-04T10:57:00Z"));
      expect(v2.slug).toBe(v1.slug);
      expect(v2.previousPlan).toBe("# Deploy Strategy\n\nv1");
    });
  });

  test("a same-heading plan days later starts a fresh chain", () => {
    withDataDir(() => {
      const old = saveAt("# Implementation Plan\n\nauth work", new Date("2026-10-01T10:00:00Z"));
      const later = saveAt("# Implementation Plan\n\nbilling work", new Date("2026-10-05T10:00:00Z"));
      expect(later.slug).toBe("implementation-plan-2026-10-05");
      expect(later.slug).not.toBe(old.slug);
      expect(later.version).toBe(1);
      expect(later.previousPlan).toBeNull();
    });
  });

  test("today's chain wins when it already holds versions", () => {
    withDataDir(() => {
      saveAt("# Deploy Strategy\n\nyesterday", new Date("2026-10-02T23:00:00Z"));
      // A pre-fix binary already split the chain into today's directory.
      const today = "deploy-strategy-2026-10-03";
      const split = saveToHistory(project, today, "# Deploy Strategy\n\nsplit");
      const splitAt = new Date("2026-10-03T00:30:00Z");
      utimesSync(split.path, splitAt, splitAt);
      expect(saveAt("# Deploy Strategy\n\nnext", new Date("2026-10-03T01:00:00Z")).slug).toBe(today);
    });
  });

  test("a different heading's chain is never continued", () => {
    withDataDir(() => {
      saveAt("# Deploy\n\nv1", new Date("2026-10-02T23:50:00Z"));
      saveAt("# Deploy Strategy\n\nv1", new Date("2026-10-02T23:51:00Z"));
      const now = new Date("2026-10-03T00:10:00Z");
      expect(resolvePlanHistorySlug(project, "# Deploy\n\nv2", { now })).toBe("deploy-2026-10-02");
      expect(resolvePlanHistorySlug(project, "# Deploy Plan", { now })).toBe("deploy-plan-2026-10-03");
    });
  });

  test("an open session keeps its own chain while the heading is unchanged", () => {
    withDataDir(() => {
      const v1 = saveAt("# Deploy Strategy\n\nv1", new Date("2026-10-02T10:00:00Z"));
      // Far past the continuation window, the session's slug still holds.
      const late = new Date(Date.parse("2026-10-02T10:00:00Z") + 100 * HOUR);
      expect(resolvePlanHistorySlug(project, "# Deploy Strategy\n\nv2", { now: late, current: v1.slug })).toBe(v1.slug);
      // A renamed heading leaves it.
      expect(resolvePlanHistorySlug(project, "# Rollout\n\nv2", { now: late, current: v1.slug }))
        .toBe(generateSlug("# Rollout", late));
    });
  });

  test("archive snapshots stay dated by decision day while history continues", () => {
    withDataDir(() => {
      const v1 = saveAt("# Deploy Strategy\n\nv1", new Date("2026-10-02T23:50:00Z"));
      const now = new Date("2026-10-03T00:10:00Z");
      const v2 = saveAt("# Deploy Strategy\n\nv2", now);
      expect(v2.slug).toBe(v1.slug);
      saveFinalSnapshot(generateSlug("# Deploy Strategy", now), "approved", "# Deploy Strategy\n\nv2", "");
      const archived = listArchivedPlans();
      expect(archived.map((p) => p.filename)).toEqual(["deploy-strategy-2026-10-03-approved.md"]);
      expect(archived[0].date).toBe("2026-10-03");
    });
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
    // getPlanDir mkdirs its result, and os.homedir() ignores a HOME override, so
    // expand bare "~": the real home already exists and nothing is created in it.
    const result = getPlanDir("~");
    expect(result).not.toContain("~");
    expect(result).toBe(homedir());
  });

  test("uses default when no custom path", () => {
    const result = getPlanDir();
    expect(result).toMatch(/plans$/);
    expect(result).toBe(getPlanDir(null));
  });

  test("uses default for null", () => {
    const result = getPlanDir(null);
    expect(result).toMatch(/plans$/);
  });

  test("uses default for whitespace-only custom path", () => {
    const result = getPlanDir("   ");
    expect(result).toMatch(/plans$/);
    expect(result).not.toBe(process.cwd());
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

describe("PLANNOTATOR_DATA_DIR", () => {
  test("isolates plan and history data when the data directory changes after import", () => {
    const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    const firstDir = makeTempDir();
    const secondDir = makeTempDir();
    const project = "data-dir-project";
    const slug = "data-dir-plan";

    try {
      process.env.PLANNOTATOR_DATA_DIR = firstDir;
      savePlan(slug, "# First plan");
      saveToHistory(project, slug, "# First version");
      expect(readFileSync(join(firstDir, "plans", `${slug}.md`), "utf-8")).toBe("# First plan");
      expect(getPlanVersion(project, slug, 1)).toBe("# First version");
      expect(getVersionCount(project, slug)).toBe(1);

      process.env.PLANNOTATOR_DATA_DIR = secondDir;
      expect(getPlanVersion(project, slug, 1)).toBeNull();
      expect(getVersionCount(project, slug)).toBe(0);
      savePlan(slug, "# Second plan");
      saveToHistory(project, slug, "# Second version");
      expect(readFileSync(join(secondDir, "plans", `${slug}.md`), "utf-8")).toBe("# Second plan");
      expect(getPlanVersion(project, slug, 1)).toBe("# Second version");
      expect(getVersionCount(project, slug)).toBe(1);

      process.env.PLANNOTATOR_DATA_DIR = firstDir;
      expect(readFileSync(join(firstDir, "plans", `${slug}.md`), "utf-8")).toBe("# First plan");
      expect(getPlanVersion(project, slug, 1)).toBe("# First version");
      expect(getVersionCount(project, slug)).toBe(1);
    } finally {
      if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
    }
  });
});
