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
  listReferenceSkills,
  loadReviewProfiles,
  MAX_INJECTED_SKILL_CONTENT_LEN,
  MAX_REFERENCE_SKILLS,
  parseSkillFrontmatterMeta,
  readCuratedSkillNames,
  readReferenceSkillContent,
  resolveRequestedReviewProfile,
  SKILL_CONTENT_HEAD_BYTES,
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

describe("discoverSkills — symlinked skill directories", () => {
  test("a symlinked skill dir at the root level is discovered", () => {
    // `~/.claude/skills/my-skill -> /elsewhere/my-skill` — a common layout
    // (skills managed in a dotfiles repo). Dirents report isDirectory() false
    // for symlinks, so discovery must follow them.
    const target = writeSkill(join(home, "elsewhere"), "linked-skill");
    const root = join(home, ".claude", "skills");
    mkdirSync(root, { recursive: true });
    symlinkSync(target, join(root, "linked-skill"));

    const found = discoverSkills().find((s) => s.name === "linked-skill");
    expect(found).toBeDefined();
    expect(found!.root).toBe("claude");
    // And it flows through to the reference catalog / picker.
    expect(listReferenceSkills().map((s) => s.name)).toContain("linked-skill");
  });

  test("a symlinked category dir is walked for the nested layout", () => {
    const category = join(home, "elsewhere-cat");
    writeSkill(category, "nested-linked");
    const root = join(home, ".claude", "skills");
    mkdirSync(root, { recursive: true });
    symlinkSync(category, join(root, "category-link"));

    const found = discoverSkills().find((s) => s.name === "nested-linked");
    expect(found).toBeDefined();
  });

  test("a broken symlink is skipped silently", () => {
    const root = join(home, ".claude", "skills");
    writeSkill(root, "real-skill");
    symlinkSync(join(home, "does-not-exist"), join(root, "dangling"));

    const names = discoverSkills().map((s) => s.name);
    expect(names).toContain("real-skill");
    expect(names).not.toContain("dangling");
  });

  test("a symlink to a FILE is not a skill dir", () => {
    const root = join(home, ".claude", "skills");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(home, "some-file.md"), "not a dir");
    symlinkSync(join(home, "some-file.md"), join(root, "file-link"));

    expect(discoverSkills().map((s) => s.name)).not.toContain("file-link");
  });

  test("a symlink cycle neither hangs nor throws (depth-2 walk bounds it)", () => {
    const root = join(home, ".claude", "skills");
    writeSkill(root, "real-skill");
    // A self-referential loop and a link back to the root itself.
    symlinkSync(join(root, "loop"), join(root, "loop"));
    symlinkSync(root, join(root, "up-link"));

    const names = discoverSkills().map((s) => s.name);
    expect(names).toContain("real-skill");
    expect(names).not.toContain("loop");
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

// ---------------------------------------------------------------------------
// Reference catalog (skill mentions in plan/annotate comments)
// ---------------------------------------------------------------------------

describe("parseSkillFrontmatterMeta", () => {
  test("plain scalars: description + disable-model-invocation: true", () => {
    const meta = parseSkillFrontmatterMeta(
      "---\nname: x\ndescription: Reviews prose for clarity.\ndisable-model-invocation: true\n---\nbody",
    );
    expect(meta.description).toBe("Reviews prose for clarity.");
    expect(meta.humanOnly).toBe(true);
  });

  test("absent flag → humanOnly false", () => {
    const meta = parseSkillFrontmatterMeta("---\nname: x\ndescription: d\n---\nbody");
    expect(meta.humanOnly).toBe(false);
  });

  test("quoted values are unquoted; 'false' stays false", () => {
    const meta = parseSkillFrontmatterMeta(
      '---\ndescription: "Quoted description"\ndisable-model-invocation: "false"\n---\n',
    );
    expect(meta.description).toBe("Quoted description");
    expect(meta.humanOnly).toBe(false);
  });

  test("folded block-scalar description joins to one line", () => {
    const meta = parseSkillFrontmatterMeta(
      "---\ndescription: >-\n  First line of the\n  description text.\nname: x\n---\n",
    );
    expect(meta.description).toBe("First line of the description text.");
  });

  test("no frontmatter → no metadata, never throws", () => {
    expect(parseSkillFrontmatterMeta("# Just a body")).toEqual({ humanOnly: false });
  });

  test("descriptions are capped at 200 chars", () => {
    const meta = parseSkillFrontmatterMeta(`---\ndescription: ${"x".repeat(500)}\n---\n`);
    expect(meta.description?.length).toBe(200);
  });

  test("CRLF frontmatter is tolerated", () => {
    const meta = parseSkillFrontmatterMeta(
      "---\r\ndescription: windows\r\ndisable-model-invocation: true\r\n---\r\nbody",
    );
    expect(meta.description).toBe("windows");
    expect(meta.humanOnly).toBe(true);
  });

  test("a trailing YAML comment on the flag value does not flip it open", () => {
    const meta = parseSkillFrontmatterMeta(
      "---\ndisable-model-invocation: true # humans only\n---\nbody",
    );
    expect(meta.humanOnly).toBe(true);
    expect(
      parseSkillFrontmatterMeta("---\ndisable-model-invocation: false # note\n---\n").humanOnly,
    ).toBe(false);
  });

  test("the common YAML truthy spellings all read as true", () => {
    for (const v of ["true", "TRUE", "True", '"true"', "yes", "on", "1", "'yes'"]) {
      expect(
        parseSkillFrontmatterMeta(`---\ndisable-model-invocation: ${v}\n---\n`).humanOnly,
      ).toBe(true);
    }
    for (const v of ["false", "no", "off", "0", '"false"']) {
      expect(
        parseSkillFrontmatterMeta(`---\ndisable-model-invocation: ${v}\n---\n`).humanOnly,
      ).toBe(false);
    }
  });

  test("descriptions keep quoted content but lose trailing comments", () => {
    expect(
      parseSkillFrontmatterMeta('---\ndescription: "Keep #this" # not this\n---\n').description,
    ).toBe("Keep #this");
    expect(
      parseSkillFrontmatterMeta("---\ndescription: plain text # comment\n---\n").description,
    ).toBe("plain text");
  });

  test("truncated unterminated frontmatter fails CLOSED on the flag", () => {
    // No closing --- inside the head read. A flag line that WAS read is
    // honored; a flag that may sit past the truncation point defaults to
    // human-only, never to model-invocable.
    const truncated = { truncated: true };
    expect(
      parseSkillFrontmatterMeta("---\nname: x\ndescription: d", truncated).humanOnly,
    ).toBe(true);
    expect(
      parseSkillFrontmatterMeta("---\ndisable-model-invocation: false\nname: x", truncated)
        .humanOnly,
    ).toBe(false);
    expect(
      parseSkillFrontmatterMeta("---\ndisable-model-invocation: true\nname: x", truncated)
        .humanOnly,
    ).toBe(true);
  });

  test("unterminated frontmatter in a COMPLETE file also fails CLOSED", () => {
    // A file under the head-read bound whose frontmatter opens but never
    // closes: the flag line is sitting in plain sight, so honor it when
    // present and fail closed when absent — same posture as the truncated
    // case. (Previously this path returned humanOnly false.)
    expect(parseSkillFrontmatterMeta("---\nnot frontmatter, a rule").humanOnly).toBe(true);
    expect(
      parseSkillFrontmatterMeta("---\nname: x\ndescription: d").humanOnly,
    ).toBe(true);
    expect(
      parseSkillFrontmatterMeta("---\ndisable-model-invocation: true\nname: x").humanOnly,
    ).toBe(true);
    expect(
      parseSkillFrontmatterMeta("---\ndisable-model-invocation: false\nname: x").humanOnly,
    ).toBe(false);
    // No leading --- at all: a plain body, never fail-closed.
    expect(parseSkillFrontmatterMeta("just a body\n---\n").humanOnly).toBe(false);
  });
});

describe("listReferenceSkills — the comment-reference catalog", () => {
  /** Write a skill with explicit frontmatter fields. */
  function writeMetaSkill(
    root: string,
    name: string,
    opts: { description?: string; humanOnly?: boolean } = {},
  ) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const fm = [
      `name: ${name}`,
      ...(opts.description ? [`description: ${opts.description}`] : []),
      ...(opts.humanOnly ? ["disable-model-invocation: true"] : []),
    ].join("\n");
    writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n# ${name}\n`);
  }

  test("lists skills across all roots with metadata, sorted by name", () => {
    writeMetaSkill(join(home, ".claude", "skills"), "zeta", { description: "Z skill" });
    writeMetaSkill(join(home, ".codex", "skills"), "alpha", { humanOnly: true });
    writeMetaSkill(join(home, ".agents", "skills"), "mid");

    const skills = listReferenceSkills();
    expect(skills.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
    expect(skills[0]).toMatchObject({ root: "codex", humanOnly: true });
    expect(skills[2]).toMatchObject({ root: "claude", description: "Z skill", humanOnly: false });
  });

  test("cross-root name clash: first-seen wins (claude over codex)", () => {
    writeMetaSkill(join(home, ".claude", "skills"), "dupe", { description: "claude copy" });
    writeMetaSkill(join(home, ".codex", "skills"), "dupe", { description: "codex copy" });

    const skills = listReferenceSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ root: "claude", description: "claude copy" });
  });

  test("no roots at all → empty catalog, no throw", () => {
    expect(listReferenceSkills()).toEqual([]);
  });

  test("caps discovery at MAX_REFERENCE_SKILLS, keeping the alphabetically-first names", () => {
    const root = join(home, ".claude", "skills");
    // Written in REVERSE name order so a slice-before-sort implementation
    // (which survives on filesystems whose readdir order is creation order)
    // would keep the wrong end of the list.
    for (let i = MAX_REFERENCE_SKILLS + 24; i >= 0; i--) {
      writeMetaSkill(root, `skill-${String(i).padStart(4, "0")}`);
    }
    const skills = listReferenceSkills();
    expect(skills.length).toBe(MAX_REFERENCE_SKILLS);
    // Sort happens BEFORE the cap: which 500 survive must not depend on
    // readdir order.
    expect(skills[0].name).toBe("skill-0000");
    expect(skills[skills.length - 1].name).toBe(
      `skill-${String(MAX_REFERENCE_SKILLS - 1).padStart(4, "0")}`,
    );
  });

  test("large frontmatter within the head read keeps its metadata (flag honored)", () => {
    const root = join(home, ".claude", "skills");
    const dir = join(root, "big-frontmatter");
    mkdirSync(dir, { recursive: true });
    const padding = `comment-${"y".repeat(9000)}`;
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: big-frontmatter\npadding: ${padding}\ndisable-model-invocation: true\n---\nbody`,
    );
    const skills = listReferenceSkills();
    expect(skills.map((s) => s.name)).toEqual(["big-frontmatter"]);
    expect(skills[0].humanOnly).toBe(true);
  });

  test("frontmatter past the head read fails CLOSED, never model-invocable", () => {
    const root = join(home, ".claude", "skills");
    const dir = join(root, "giant-frontmatter");
    mkdirSync(dir, { recursive: true });
    // The closing --- and the flag both sit past the 64KB head read. The old
    // behavior read this as humanOnly: false — the unsafe direction. It must
    // fail closed instead.
    const padding = `comment-${"y".repeat(70_000)}`;
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: giant-frontmatter\npadding: ${padding}\ndisable-model-invocation: true\n---\nbody`,
    );
    const skills = listReferenceSkills();
    expect(skills.map((s) => s.name)).toEqual(["giant-frontmatter"]);
    expect(skills[0].humanOnly).toBe(true);
  });

  test("a flag read before the truncation point is honored even in giant frontmatter", () => {
    const root = join(home, ".claude", "skills");
    const dir = join(root, "flag-early");
    mkdirSync(dir, { recursive: true });
    const padding = `comment-${"y".repeat(70_000)}`;
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\ndisable-model-invocation: false\npadding: ${padding}\n---\nbody`,
    );
    const skills = listReferenceSkills();
    expect(skills[0].humanOnly).toBe(false);
  });

  test("each catalog entry carries its absolute skill directory", () => {
    const root = join(home, ".claude", "skills");
    writeMetaSkill(root, "with-dir");
    const skills = listReferenceSkills();
    expect(skills[0].dir).toBe(join(root, "with-dir"));
  });
});

describe("readReferenceSkillContent — human-only skill injection source", () => {
  function writeContentSkill(name: string, body: string, humanOnly = true) {
    const root = join(home, ".claude", "skills");
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const fm = [
      `name: ${name}`,
      ...(humanOnly ? ["disable-model-invocation: true"] : []),
    ].join("\n");
    writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}`);
    return dir;
  }

  test("returns the frontmatter-stripped body with dir and path", () => {
    const dir = writeContentSkill("human-skill", "# Steps\n\nDo the thing.");
    const result = readReferenceSkillContent("human-skill");
    expect(result).toEqual({
      name: "human-skill",
      dir,
      path: join(dir, "SKILL.md"),
      content: "# Steps\n\nDo the thing.",
      truncated: false,
      humanOnly: true,
    });
  });

  test("a model-invocable skill reads too (the client decides what to inject)", () => {
    writeContentSkill("model-skill", "# Body", false);
    expect(readReferenceSkillContent("model-skill")).toMatchObject({
      humanOnly: false,
      content: "# Body",
    });
  });

  test("truncates an oversized body at the bound and flags it", () => {
    const body = "x".repeat(MAX_INJECTED_SKILL_CONTENT_LEN + 500);
    writeContentSkill("giant", body);
    const result = readReferenceSkillContent("giant")!;
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(MAX_INJECTED_SKILL_CONTENT_LEN);
    expect(result.content).toBe(body.slice(0, MAX_INJECTED_SKILL_CONTENT_LEN));
  });

  test("an unknown or deleted skill returns null, never throws", () => {
    expect(readReferenceSkillContent("does-not-exist")).toBeNull();

    const dir = writeContentSkill("was-here", "# Body");
    expect(readReferenceSkillContent("was-here")).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
    expect(readReferenceSkillContent("was-here")).toBeNull();
  });

  test("an empty body returns null (the client falls back to naming the skill)", () => {
    writeContentSkill("blank-body", "");
    expect(readReferenceSkillContent("blank-body")).toBeNull();
  });

  test("traversal, separator, and absolute-path names never read outside the roots", () => {
    // A real file OUTSIDE every skill root that a traversal would love to read.
    writeFileSync(join(home, "secret.md"), "top secret");
    writeContentSkill("legit", "# Body");

    for (const name of [
      "../../secret.md",
      "..",
      ".",
      "legit/../../secret.md",
      "legit/SKILL.md",
      `${join(home, "secret.md")}`,
      "",
    ]) {
      expect(readReferenceSkillContent(name)).toBeNull();
    }
  });

  test("a discovered directory named with consecutive dots (v1..2) is servable", () => {
    // The old `name.includes("..")` guard 404'd this legitimately discovered
    // skill forever while the catalog and menu still listed it. The name is
    // only ever MATCHED against discovery output — never joined into a path —
    // so the substring check defended nothing.
    writeContentSkill("v1..2", "# Versioned body");
    expect(listReferenceSkills().map((s) => s.name)).toContain("v1..2");
    expect(readReferenceSkillContent("v1..2")).toMatchObject({
      name: "v1..2",
      content: "# Versioned body",
    });
  });

  test("every discovered skill name is servable — catalog and content endpoint agree", () => {
    if (process.platform === "win32") return; // backslash dirs are separators there
    // A POSIX directory name containing a backslash is legal; discovery
    // normalizes it (basename past either separator) and whatever name the
    // catalog advertises, the content endpoint must serve — the old guard
    // broke that invariant for dotted and backslashed names.
    writeContentSkill("v1..2", "# A");
    writeContentSkill("odd\\name", "# B");
    const listed = listReferenceSkills();
    expect(listed.length).toBeGreaterThanOrEqual(2);
    for (const skill of listed) {
      expect(readReferenceSkillContent(skill.name)).not.toBeNull();
    }
  });

  test("a huge SKILL.md is read boundedly: capped content, flagged truncated", () => {
    // 8MB of body. The endpoint must not materialize the whole file per
    // request (the read is head-bounded), and the visible behavior must be
    // identical to the old read-then-slice: first cap chars, truncated: true.
    const line = "y".repeat(99) + "\n";
    const body = line.repeat(80_000); // 8MB
    writeContentSkill("mega", body);
    const result = readReferenceSkillContent("mega")!;
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(MAX_INJECTED_SKILL_CONTENT_LEN);
    expect(result.content).toBe(body.slice(0, MAX_INJECTED_SKILL_CONTENT_LEN));
  });

  test("multibyte bodies keep exact char-cap semantics under the byte-bounded read", () => {
    const body = "é".repeat(MAX_INJECTED_SKILL_CONTENT_LEN + 500); // 2 bytes/char
    writeContentSkill("multibyte", body);
    const result = readReferenceSkillContent("multibyte")!;
    expect(result.truncated).toBe(true);
    expect(result.content).toBe(body.slice(0, MAX_INJECTED_SKILL_CONTENT_LEN));
  });

  test("frontmatter larger than the read bound falls back to null, never injects raw YAML", () => {
    // The closing --- sits past the bounded head read: the body cannot be
    // located, so the endpoint reports no content (client falls back to name +
    // directory) instead of serving a screenful of YAML as instructions.
    const root = join(home, ".claude", "skills");
    const dir = join(root, "yaml-bomb");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: yaml-bomb\npadding: ${"y".repeat(400_000)}\n---\n# Real body`,
    );
    expect(readReferenceSkillContent("yaml-bomb")).toBeNull();
  });

  test("a file of exactly the read bound is NOT flagged truncated", () => {
    // The old `bytes === maxBytes` check flagged an exactly-boundary file as
    // truncated, producing a false "[Instructions truncated...]" note. A
    // giant-but-closed frontmatter plus a small body keeps the char cap out
    // of play so head truncation is the only signal.
    const root = join(home, ".claude", "skills");
    const dir = join(root, "exact-boundary");
    mkdirSync(dir, { recursive: true });
    const bodyText = "# Real body";
    const prefix = "---\nname: exact-boundary\npadding: ";
    const suffix = "\n---\n" + bodyText;
    const padLen = SKILL_CONTENT_HEAD_BYTES - prefix.length - suffix.length;
    writeFileSync(join(dir, "SKILL.md"), prefix + "y".repeat(padLen) + suffix);

    const result = readReferenceSkillContent("exact-boundary")!;
    expect(result).not.toBeNull();
    expect(result.content).toBe(bodyText);
    expect(result.truncated).toBe(false);
  });

  test("one byte past the read bound IS flagged truncated", () => {
    const root = join(home, ".claude", "skills");
    const dir = join(root, "boundary-plus-one");
    mkdirSync(dir, { recursive: true });
    const bodyText = "# Real body";
    const prefix = "---\nname: boundary-plus-one\npadding: ";
    const suffix = "\n---\n" + bodyText;
    const padLen = SKILL_CONTENT_HEAD_BYTES - prefix.length - suffix.length + 1;
    writeFileSync(join(dir, "SKILL.md"), prefix + "y".repeat(padLen) + suffix);

    const result = readReferenceSkillContent("boundary-plus-one")!;
    expect(result).not.toBeNull();
    // The head read cut the file's last byte: the file continues past the
    // read, so the truncation notice is honest.
    expect(result.truncated).toBe(true);
    expect(result.content).toBe(bodyText.slice(0, -1));
  });

  test("a complete file with genuinely unterminated frontmatter keeps its old behavior", () => {
    // Under the bound, no closing ---: the whole text is the body, exactly as
    // the unbounded readFileSync produced before.
    const root = join(home, ".claude", "skills");
    const dir = join(root, "unterminated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: unterminated\n# not closed");
    const result = readReferenceSkillContent("unterminated")!;
    expect(result.content).toBe("---\nname: unterminated\n# not closed");
  });
});
