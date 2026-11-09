/**
 * Plan Storage Tests
 *
 * Run: bun test packages/server/storage.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { generateSlug, getPlanDir, savePlan, saveToHistory, getPlanVersion, getVersionCount, listVersions, resolveHistoryChain, resolveHistorySlug } from "./storage";
import { PLAN_HISTORY_CONTINUE_WINDOW_MS } from "@plannotator/shared/storage";

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

describe("resolveHistorySlug", () => {
  /**
   * Plan review derives its slug from the plan's H1 plus today's date, and the
   * same string keys both the archive filename and the version history. These
   * tests cover the history half: a plan whose review spans midnight must keep
   * appending to the chain it started, instead of opening a second one that
   * looks like a plan with no history at all.
   */
  function withDataDir<T>(fn: (dataDir: string) => T): T {
    const saved = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
    try {
      return fn(process.env.PLANNOTATOR_DATA_DIR);
    } finally {
      if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = saved;
    }
  }

  /** Seed a chain whose versions were written `ageMs` ago (default: just now). */
  function seedChain(dataDir: string, project: string, slug: string, versions: string[], ageMs = 0): void {
    const dir = join(dataDir, "history", project, slug);
    mkdirSync(dir, { recursive: true });
    const when = new Date(Date.now() - ageMs);
    versions.forEach((content, i) => {
      const file = join(dir, `${String(i + 1).padStart(3, "0")}.md`);
      writeFileSync(file, content, "utf-8");
      utimesSync(file, when, when);
    });
  }

  const HOUR = 60 * 60 * 1000;

  test("continues the chain started on an earlier day", () => {
    withDataDir((dataDir) => {
      const project = "spans-midnight";
      seedChain(dataDir, project, "inference-capacity-2026-10-02", ["# V1"]);

      expect(resolveHistorySlug(project, "inference-capacity-2026-10-04")).toBe(
        "inference-capacity-2026-10-02"
      );
    });
  });

  test("the continued chain keeps numbering up, so the diff has a baseline", () => {
    withDataDir((dataDir) => {
      const project = "numbering";
      seedChain(dataDir, project, "inference-capacity-2026-10-02", ["# V1"]);

      const slug = resolveHistorySlug(project, "inference-capacity-2026-10-04");
      const saved = saveToHistory(project, slug, "# V2");

      expect(saved.version).toBe(2);
      expect(saved.isNew).toBe(true);
      expect(getVersionCount(project, slug)).toBe(2);
      expect(getPlanVersion(project, slug, 1)).toBe("# V1");
    });
  });

  test("starts a fresh chain when the plan has no history", () => {
    withDataDir(() => {
      expect(resolveHistorySlug("fresh", "brand-new-plan-2026-10-04")).toBe(
        "brand-new-plan-2026-10-04"
      );
    });
  });

  test("picks the most recent of several earlier chains", () => {
    withDataDir((dataDir) => {
      const project = "several";
      seedChain(dataDir, project, "recurring-plan-2026-09-18", ["# old"], 30 * HOUR);
      seedChain(dataDir, project, "recurring-plan-2026-10-02", ["# newer"], 2 * HOUR);

      expect(resolveHistorySlug(project, "recurring-plan-2026-10-04")).toBe(
        "recurring-plan-2026-10-02"
      );
    });
  });

  test("never adopts a chain dated after the plan under review", () => {
    withDataDir((dataDir) => {
      const project = "future";
      seedChain(dataDir, project, "time-travel-2026-12-25", ["# later"]);

      expect(resolveHistorySlug(project, "time-travel-2026-10-04")).toBe(
        "time-travel-2026-10-04"
      );
    });
  });

  test("reuses the chain for the same day, which is the pre-existing behaviour", () => {
    withDataDir((dataDir) => {
      const project = "same-day";
      seedChain(dataDir, project, "same-day-plan-2026-10-04", ["# V1"]);

      expect(resolveHistorySlug(project, "same-day-plan-2026-10-04")).toBe(
        "same-day-plan-2026-10-04"
      );
    });
  });

  test("does not confuse a plan with a longer-named sibling", () => {
    withDataDir((dataDir) => {
      const project = "prefixes";
      seedChain(dataDir, project, "wave-s2-inference-capacity-2026-10-02", ["# other plan"]);

      expect(resolveHistorySlug(project, "wave-s2-2026-10-04")).toBe("wave-s2-2026-10-04");
    });
  });

  test("ignores history directories that are not date-suffixed", () => {
    withDataDir((dataDir) => {
      const project = "annotate-neighbour";
      seedChain(dataDir, project, "annotate-readme-md-1a2b3c4d", ["# a document"]);

      expect(resolveHistorySlug(project, "annotate-readme-md-2026-10-04")).toBe(
        "annotate-readme-md-2026-10-04"
      );
    });
  });

  test("ignores an empty chain directory left behind by an earlier run", () => {
    withDataDir((dataDir) => {
      const project = "empty-dir";
      mkdirSync(join(dataDir, "history", project, "abandoned-plan-2026-10-03"), {
        recursive: true,
      });
      seedChain(dataDir, project, "abandoned-plan-2026-10-01", ["# real"]);

      expect(resolveHistorySlug(project, "abandoned-plan-2026-10-04")).toBe(
        "abandoned-plan-2026-10-01"
      );
    });
  });

  test("continues the reported case: a revision about 39 hours after v1", () => {
    withDataDir((dataDir) => {
      const project = "reported-gap";
      seedChain(dataDir, project, "inference-capacity-2026-10-02", ["# V1"], 39 * HOUR);

      expect(resolveHistorySlug(project, "inference-capacity-2026-10-04")).toBe(
        "inference-capacity-2026-10-02"
      );
    });
  });

  test("a same-heading plan after two quiet days starts a new chain", () => {
    withDataDir((dataDir) => {
      const project = "generic-heading";
      seedChain(dataDir, project, "implementation-plan-2026-09-30", ["# Implementation Plan"], PLAN_HISTORY_CONTINUE_WINDOW_MS + HOUR);

      expect(resolveHistorySlug(project, "implementation-plan-2026-10-04")).toBe(
        "implementation-plan-2026-10-04"
      );
    });
  });

  test("today's chain wins over an older chain written more recently", () => {
    withDataDir((dataDir) => {
      const project = "split";
      seedChain(dataDir, project, "split-plan-2026-10-04", ["# today"], 5 * HOUR);
      seedChain(dataDir, project, "split-plan-2026-10-03", ["# yesterday"], HOUR);

      expect(resolveHistorySlug(project, "split-plan-2026-10-04")).toBe("split-plan-2026-10-04");
    });
  });

  test("an open session keeps its chain while the heading names it", () => {
    withDataDir((dataDir) => {
      const project = "session";
      seedChain(dataDir, project, "session-plan-2026-10-04", ["# today, another session"]);

      expect(
        resolveHistorySlug(project, "session-plan-2026-10-04", { current: "session-plan-2026-10-01" })
      ).toBe("session-plan-2026-10-01");
      // A revision that renames the plan leaves the session's chain.
      expect(
        resolveHistorySlug(project, "renamed-plan-2026-10-04", { current: "session-plan-2026-10-01" })
      ).toBe("renamed-plan-2026-10-04");
    });
  });

  test("leaves a slug without a date suffix untouched", () => {
    withDataDir(() => {
      expect(resolveHistorySlug("no-date", "annotate-readme-md-1a2b3c4d")).toBe(
        "annotate-readme-md-1a2b3c4d"
      );
    });
  });
});

describe("resolveHistoryChain", () => {
  /**
   * #2197: the Claude Code hosts pass the current folder's project first and
   * the session root's second. An existing chain is looked for in that order;
   * a new chain always starts under the first, exactly as before.
   */
  function withDataDir<T>(fn: (dataDir: string) => T): T {
    const saved = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
    try {
      return fn(process.env.PLANNOTATOR_DATA_DIR);
    } finally {
      if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = saved;
    }
  }

  function seed(dataDir: string, project: string, slug: string): void {
    const dir = join(dataDir, "history", project, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "001.md"), "# V1", "utf-8");
  }

  test("the first project's existing chain wins when both hold one", () => {
    withDataDir((dataDir) => {
      seed(dataDir, "service-a", "ship-it-2026-10-04");
      seed(dataDir, "workspace", "ship-it-2026-10-04");
      expect(resolveHistoryChain(["service-a", "workspace"], "ship-it-2026-10-04")).toEqual({
        project: "service-a",
        slug: "ship-it-2026-10-04",
      });
    });
  });

  test("a chain only the second project (the session root's) holds is continued", () => {
    withDataDir((dataDir) => {
      seed(dataDir, "workspace", "ship-it-2026-10-03");
      expect(resolveHistoryChain(["service-a", "workspace"], "ship-it-2026-10-04")).toEqual({
        project: "workspace",
        slug: "ship-it-2026-10-03",
      });
    });
  });

  test("no chain anywhere starts one under the first project (the current folder's)", () => {
    withDataDir(() => {
      expect(resolveHistoryChain(["service-a", "workspace"], "ship-it-2026-10-04")).toEqual({
        project: "service-a",
        slug: "ship-it-2026-10-04",
      });
    });
  });
});

