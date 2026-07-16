import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_DEFAULT_ID } from "@plannotator/shared/review-profiles";
import {
  BUILTIN_DEFAULT_PROFILE,
  type ResolvedReviewProfile,
} from "@plannotator/shared/review-profiles";
import {
  discoverCuratedSkills,
  discoverSkills,
  enableReviewSkill,
  listAllSkills,
  loadReviewProfiles,
  readCuratedSkillNames,
  resolveRequestedReviewProfile,
  stripFrontmatter,
} from "./review-skill-loader";

// Launch-time resolution used by review.ts / serverReview.ts. Tested directly so
// both runtimes' resolution stays pinned without standing up a full review server.
const resolveLaunchProfile = resolveRequestedReviewProfile;

// ---------------------------------------------------------------------------
// Test 1 — Body extraction (no frontmatter parsing)
// ---------------------------------------------------------------------------

describe("stripFrontmatter", () => {
  test("removes only the leading --- block and returns the body", () => {
    const raw = "---\nname: security-review\ndescription: x\n---\n# Body\n\ntext";
    expect(stripFrontmatter(raw)).toBe("# Body\n\ntext");
  });

  test("no frontmatter → the whole file is the body", () => {
    const raw = "# Just a heading\n\nno frontmatter here";
    expect(stripFrontmatter(raw)).toBe(raw);
  });

  test("an internal --- (markdown rule) in the body is not stripped", () => {
    const raw = "---\nname: x\n---\nintro\n\n---\n\nafter the rule";
    expect(stripFrontmatter(raw)).toBe("intro\n\n---\n\nafter the rule");
  });

  test("empty body after frontmatter → empty string", () => {
    const raw = "---\nname: x\n---\n";
    expect(stripFrontmatter(raw)).toBe("");
  });

  test("CRLF + BOM frontmatter is tolerated", () => {
    const raw = "﻿---\r\nname: x\r\n---\r\nbody line";
    expect(stripFrontmatter(raw)).toBe("body line");
  });
});

// ---------------------------------------------------------------------------
// Discovery / curation harness
// ---------------------------------------------------------------------------

let home: string;
let dataDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Create a skill dir `<root>/<name>/SKILL.md` with the given body. */
function writeSkill(root: string, name: string, body = `# ${name}\n\ninstructions`) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n${body}`);
  return dir;
}

function writeCuration(enabled: unknown, version: unknown = 1) {
  writeFileSync(
    join(dataDir, "review-skills.json"),
    JSON.stringify({ version, enabled }),
  );
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "plannotator-skills-"));
  home = join(base, "home");
  dataDir = join(base, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  // Point every root at isolated dirs under the fake home so the host's real
  // ~/.claude etc. are never scanned. HOME isolates ~/.agents/skills, which has
  // no env override (Bun's homedir() honors HOME).
  setEnv("HOME", home);
  setEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  setEnv("CODEX_HOME", join(home, ".codex"));
  setEnv("XDG_CONFIG_HOME", join(home, ".config"));
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  rmSync(join(home, ".."), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 2 — Root resolution + env overrides + realpath-dedup + clash
// ---------------------------------------------------------------------------

describe("discoverSkills — root resolution", () => {
  test("env overrides point discovery at the right dirs (all three roots)", () => {
    writeSkill(join(home, ".claude", "skills"), "claude-skill");
    writeSkill(join(home, ".codex", "skills"), "codex-skill");
    writeSkill(join(home, ".config", "agents", "skills"), "universal-skill");

    const names = discoverSkills().map((s) => s.name).sort();
    expect(names).toEqual(["claude-skill", "codex-skill", "universal-skill"]);
  });

  test("walks the skills/<category>/<skill> catalog layout one level deeper", () => {
    const claude = join(home, ".claude", "skills");
    writeSkill(join(claude, "category"), "nested-skill");

    const found = discoverSkills().find((s) => s.name === "nested-skill");
    expect(found).toBeDefined();
    expect(found!.sourcePath).toBe(join(claude, "category", "nested-skill"));
  });

  test("cross-root name clash → first-seen wins (Claude before Codex)", () => {
    writeSkill(join(home, ".claude", "skills"), "dup", "# claude version");
    writeSkill(join(home, ".codex", "skills"), "dup", "# codex version");

    const dups = discoverSkills().filter((s) => s.name === "dup");
    expect(dups).toHaveLength(1);
    expect(dups[0].root).toBe("claude");
  });

  test("two roots resolving to the same path dedupe (no double discovery)", () => {
    // Aim the Claude and Codex roots at one on-disk dir: CODEX_HOME is a symlink
    // to the real CLAUDE_CONFIG_DIR, so .claude/skills and .codex/skills realpath
    // to the same place and must collapse to one discovery.
    writeSkill(join(home, ".claude", "skills"), "shared-skill");
    symlinkSync(join(home, ".claude"), join(home, ".codex-link"));
    setEnv("CODEX_HOME", join(home, ".codex-link"));

    const matches = discoverSkills().filter((s) => s.name === "shared-skill");
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Curation filter (membership; missing name; absent/malformed)
// ---------------------------------------------------------------------------

describe("loadReviewProfiles — curation filter", () => {
  test("a discovered skill is a review iff its name is in `enabled`", () => {
    const root = join(home, ".claude", "skills");
    writeSkill(root, "security-review", "# Security\n\ncheck auth");
    writeSkill(root, "not-curated");
    writeCuration(["security-review"]);

    const profiles = loadReviewProfiles();
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain(BUILTIN_DEFAULT_ID);
    expect(ids).toContain("skill:security-review");
    expect(ids).not.toContain("skill:not-curated");

    const sec = profiles.find((p) => p.id === "skill:security-review")!;
    expect(sec.label).toBe("security-review");
    expect(sec.source).toBe("user");
    expect(sec.instructions).toBe("# Security\n\ncheck auth");
    expect(sec.sourcePath).toBe(join(root, "security-review"));
  });

  test("an enabled name with no matching skill is dropped (not fatal)", () => {
    writeSkill(join(home, ".claude", "skills"), "present");
    writeCuration(["present", "ghost"]);

    const ids = loadReviewProfiles().map((p) => p.id);
    expect(ids).toContain("skill:present");
    expect(ids).not.toContain("skill:ghost");
  });

  test("absent curation → only builtin:default", () => {
    writeSkill(join(home, ".claude", "skills"), "available");
    const profiles = loadReviewProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe(BUILTIN_DEFAULT_ID);
  });

  test("malformed curation (bad version) → only builtin:default", () => {
    writeSkill(join(home, ".claude", "skills"), "available");
    writeCuration(["available"], 2);
    const profiles = loadReviewProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe(BUILTIN_DEFAULT_ID);
  });

  test("empty enabled array → only builtin:default", () => {
    writeSkill(join(home, ".claude", "skills"), "available");
    writeCuration([]);
    const profiles = loadReviewProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe(BUILTIN_DEFAULT_ID);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Trust gating: repo-local .claude/skills is NOT discovered
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Launch-time resolution — reviewProfileId → curated skill body; absent → default
// ---------------------------------------------------------------------------

describe("launch resolution", () => {
  test("a curated skill id resolves to that skill's live body", () => {
    const root = join(home, ".claude", "skills");
    writeSkill(root, "security-review", "# Security\n\ncheck auth");
    writeCuration(["security-review"]);

    const profile = resolveLaunchProfile("skill:security-review");
    expect(profile.id).toBe("skill:security-review");
    expect(profile.label).toBe("security-review");
    expect(profile.source).toBe("user");
    expect(profile.instructions).toBe("# Security\n\ncheck auth");
  });

  test("absent reviewProfileId → builtin:default", () => {
    writeSkill(join(home, ".claude", "skills"), "security-review");
    writeCuration(["security-review"]);
    expect(resolveLaunchProfile(undefined)).toBe(BUILTIN_DEFAULT_PROFILE);
  });

  test("the reserved default id → builtin:default (no throw)", () => {
    expect(resolveLaunchProfile(BUILTIN_DEFAULT_ID)).toBe(BUILTIN_DEFAULT_PROFILE);
  });

  test("an unknown / uncurated id throws instead of silently running default", () => {
    writeSkill(join(home, ".claude", "skills"), "not-curated");
    writeCuration([]);
    // Renamed/removed skill or stale cookie — fail loud, never quietly downgrade.
    expect(() => resolveLaunchProfile("skill:not-curated")).toThrow(/not available/);
    expect(() => resolveLaunchProfile("skill:does-not-exist")).toThrow(/not available/);
  });

  test("a curated skill with an empty body throws (could not be loaded)", () => {
    writeSkill(join(home, ".claude", "skills"), "blank", "");
    writeCuration(["blank"]);
    expect(() => resolveLaunchProfile("skill:blank")).toThrow(/could not be loaded/);
  });
});

describe("skill files pointer (point at the real folder, no copy)", () => {
  test("a skill with extra files prepends a pointer to its real directory", () => {
    const root = join(home, ".claude", "skills");
    const dir = writeSkill(root, "with-refs", "# Body\n\ncheck auth");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "references", "owasp.md"), "checklist");
    writeCuration(["with-refs"]);

    const profile = resolveLaunchProfile("skill:with-refs");
    // Points at the skill's REAL directory — no copy is made.
    expect(
      profile.instructions.startsWith(
        `This review skill's files (references, scripts, assets) are at: ${dir}`,
      ),
    ).toBe(true);
    // The body still follows the pointer line.
    expect(profile.instructions.endsWith("# Body\n\ncheck auth")).toBe(true);
  });

  test("an instruction-only skill (just SKILL.md) gets no pointer line", () => {
    writeSkill(join(home, ".claude", "skills"), "plain", "# Body\n\njust instructions");
    writeCuration(["plain"]);

    const profile = resolveLaunchProfile("skill:plain");
    expect(profile.instructions).toBe("# Body\n\njust instructions");
    expect(profile.instructions).not.toContain("This review skill's files");
  });
});

describe("trust gating — global roots only", () => {
  test("a repo-local .claude/skills/<name>/SKILL.md is not discovered", () => {
    // A project checkout living somewhere under the fake home, with its own
    // .claude/skills — must never be scanned (global-only).
    const repo = join(home, "work", "some-repo");
    writeSkill(join(repo, ".claude", "skills"), "repo-only-skill");
    writeCuration(["repo-only-skill"]);

    const ids = loadReviewProfiles().map((p) => p.id);
    expect(ids).not.toContain("skill:repo-only-skill");
    expect(ids).toEqual([BUILTIN_DEFAULT_ID]);
  });
});

describe("the documented ~/.agents/skills root is scanned", () => {
  test("a skill in ~/.agents/skills is discovered and loadable", () => {
    writeSkill(join(home, ".agents", "skills"), "agents-review");
    writeCuration(["agents-review"]);
    expect(loadReviewProfiles().map((p) => p.id)).toContain("skill:agents-review");
  });
});

describe("listAllSkills — the add-a-review picker source", () => {
  test("lists every discovered skill, flagged by enabled state", () => {
    const root = join(home, ".claude", "skills");
    writeSkill(root, "security-review");
    writeSkill(root, "perf-review");
    writeCuration(["security-review"]);

    const all = listAllSkills();
    const byName = new Map(all.map((s) => [s.name, s.enabled]));
    expect(byName.get("security-review")).toBe(true);
    expect(byName.get("perf-review")).toBe(false);
  });

  test("no curation file → everything is not-enabled", () => {
    writeSkill(join(home, ".claude", "skills"), "perf-review");
    expect(listAllSkills().every((s) => !s.enabled)).toBe(true);
  });
});

describe("enableReviewSkill — curation write", () => {
  test("adds a real skill name to review-skills.json (creates the file)", () => {
    writeSkill(join(home, ".claude", "skills"), "security-review");
    const { enabled } = enableReviewSkill("security-review");
    expect(enabled).toEqual(["security-review"]);
    expect([...(readCuratedSkillNames() ?? [])]).toEqual(["security-review"]);
  });

  test("dedupes and preserves existing enabled names", () => {
    const root = join(home, ".claude", "skills");
    writeSkill(root, "security-review");
    writeSkill(root, "perf-review");
    writeCuration(["security-review"]);

    enableReviewSkill("security-review"); // already enabled → no duplicate
    const { enabled } = enableReviewSkill("perf-review");
    expect(enabled.sort()).toEqual(["perf-review", "security-review"]);
  });

  test("rejects a name with no matching discovered skill", () => {
    expect(() => enableReviewSkill("does-not-exist")).toThrow();
  });
});
