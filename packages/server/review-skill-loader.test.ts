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
  resolveGlobalSkillRoots,
  stripFrontmatter,
} from "./review-skill-loader";
import { checkoutIsScratch, makeOutsideScratch } from "../../tests/helpers/outside-scratch";

const resolveLaunchProfile = resolveRequestedReviewProfile;

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

let home: string;
let dataDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

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

// The failure this catches: a test Inbox reading the person's real skill folders
// because its test left HOME alone (typing in a reply box lists them), or the
// sandbox check leaking into a real run. `outside` stands in for a real home: a
// folder that exists and is not scratch, made here, never the real one.
describe.skipIf(checkoutIsScratch)("resolveGlobalSkillRoots — test sandbox", () => {
  let outside = "";

  const seedEveryDefaultRoot = (at: string) => {
    writeSkill(join(at, ".claude", "skills"), "in-claude");
    writeSkill(join(at, ".codex", "skills"), "in-codex");
    writeSkill(join(at, ".agents", "skills"), "in-agents");
    writeSkill(join(at, ".config", "agents", "skills"), "in-config");
  };
  const everyDefaultRoot = (at: string) => [
    { dir: join(at, ".claude", "skills"), root: "claude" },
    { dir: join(at, ".codex", "skills"), root: "codex" },
    { dir: join(at, ".agents", "skills"), root: "universal" },
    { dir: join(at, ".config", "agents", "skills"), root: "universal" },
  ];
  const useDefaultRootsOf = (at: string) => {
    setEnv("HOME", at);
    setEnv("CLAUDE_CONFIG_DIR", undefined);
    setEnv("CODEX_HOME", undefined);
    setEnv("XDG_CONFIG_HOME", undefined);
  };

  beforeEach(() => {
    outside = makeOutsideScratch();
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  for (const [label, value] of [["unset", undefined], ["empty", ""]] as const) {
    test(`sandbox ${label}: the same four folders as ever, scratch or not`, () => {
      setEnv("PLANNOTATOR_TEST_SANDBOX", value);
      seedEveryDefaultRoot(outside);
      useDefaultRootsOf(outside);

      expect(resolveGlobalSkillRoots()).toEqual(everyDefaultRoot(outside));
      expect(discoverSkills().map((s) => s.name)).toEqual(["in-claude", "in-codex", "in-agents", "in-config"]);

      setEnv("CLAUDE_CONFIG_DIR", join(outside, "c"));
      setEnv("CODEX_HOME", join(outside, "x"));
      setEnv("XDG_CONFIG_HOME", join(outside, "g"));
      expect(resolveGlobalSkillRoots()).toEqual([
        { dir: join(outside, "c", "skills"), root: "claude" },
        { dir: join(outside, "x", "skills"), root: "codex" },
        { dir: join(outside, ".agents", "skills"), root: "universal" },
        { dir: join(outside, "g", "agents", "skills"), root: "universal" },
      ]);
    });
  }

  for (const value of ["1", "0", join(tmpdir(), "plannotator-test-marker")]) {
    test(`sandbox ${value}: a home that is not scratch is not read at all`, () => {
      setEnv("PLANNOTATOR_TEST_SANDBOX", value);
      seedEveryDefaultRoot(outside);
      useDefaultRootsOf(outside);

      expect(resolveGlobalSkillRoots()).toEqual([]);
      expect(discoverSkills()).toEqual([]);
      expect(listReferenceSkills()).toEqual([]);
    });

    test(`sandbox ${value}: a scratch HOME's seeded skills are all found`, () => {
      setEnv("PLANNOTATOR_TEST_SANDBOX", value);
      seedEveryDefaultRoot(home);
      useDefaultRootsOf(home);

      expect(resolveGlobalSkillRoots()).toEqual(everyDefaultRoot(home));
      expect(discoverSkills().map((s) => s.name)).toEqual(["in-claude", "in-codex", "in-agents", "in-config"]);
    });

    test(`sandbox ${value}: judged folder by folder, as for a runner's HOME with scratch overrides`, () => {
      setEnv("PLANNOTATOR_TEST_SANDBOX", value);
      seedEveryDefaultRoot(outside);
      writeSkill(join(home, ".claude", "skills"), "scratch-skill");
      setEnv("HOME", outside);

      expect(discoverSkills().map((s) => s.name)).toEqual(["scratch-skill"]);
    });

    test(`sandbox ${value}: a scratch link to a folder that is not scratch is not read`, () => {
      setEnv("PLANNOTATOR_TEST_SANDBOX", value);
      writeSkill(join(outside, ".claude", "skills"), "through-the-link");
      symlinkSync(join(outside, ".claude"), join(home, "claude-link"));
      setEnv("CLAUDE_CONFIG_DIR", join(home, "claude-link"));

      expect(discoverSkills()).toEqual([]);
    });
  }
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
    symlinkSync(join(root, "loop"), join(root, "loop"));
    symlinkSync(root, join(root, "up-link"));

    const names = discoverSkills().map((s) => s.name);
    expect(names).toContain("real-skill");
    expect(names).not.toContain("loop");
  });
});

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
    expect(
      profile.instructions.startsWith(
        `This review skill's files (references, scripts, assets) are at: ${dir}`,
      ),
    ).toBe(true);
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

    enableReviewSkill("security-review");
    const { enabled } = enableReviewSkill("perf-review");
    expect(enabled.sort()).toEqual(["perf-review", "security-review"]);
  });

  test("rejects a name with no matching discovered skill", () => {
    expect(() => enableReviewSkill("does-not-exist")).toThrow();
  });
});

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
    // Frontmatter opens but never closes in a file under the head bound: honor a flag line if present, fail closed otherwise.
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
    expect(parseSkillFrontmatterMeta("just a body\n---\n").humanOnly).toBe(false);
  });
});

describe("listReferenceSkills — the comment-reference catalog", () => {
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
    // The closing --- and the flag both sit past the 64KB head read: must fail closed.
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
    // The name is only matched against discovery output, never joined into a path, so a `..` substring check defended nothing and 404'd legitimate names.
    writeContentSkill("v1..2", "# Versioned body");
    expect(listReferenceSkills().map((s) => s.name)).toContain("v1..2");
    expect(readReferenceSkillContent("v1..2")).toMatchObject({
      name: "v1..2",
      content: "# Versioned body",
    });
  });

  test("every discovered skill name is servable — catalog and content endpoint agree", () => {
    if (process.platform === "win32") return; // backslash dirs are separators there
    // A POSIX directory name may contain a backslash; whatever name the catalog advertises, the content endpoint must serve.
    writeContentSkill("v1..2", "# A");
    writeContentSkill("odd\\name", "# B");
    const listed = listReferenceSkills();
    expect(listed.length).toBeGreaterThanOrEqual(2);
    for (const skill of listed) {
      expect(readReferenceSkillContent(skill.name)).not.toBeNull();
    }
  });

  test("a huge SKILL.md is read boundedly: capped content, flagged truncated", () => {
    // 8MB body: the read is head-bounded, and the visible result is the first cap chars with truncated: true.
    const line = "y".repeat(99) + "\n";
    const body = line.repeat(80_000);
    writeContentSkill("mega", body);
    const result = readReferenceSkillContent("mega")!;
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(MAX_INJECTED_SKILL_CONTENT_LEN);
    expect(result.content).toBe(body.slice(0, MAX_INJECTED_SKILL_CONTENT_LEN));
  });

  test("multibyte bodies keep exact char-cap semantics under the byte-bounded read", () => {
    const body = "é".repeat(MAX_INJECTED_SKILL_CONTENT_LEN + 500);
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
    // An exactly-boundary file must not be flagged truncated; a giant closed frontmatter plus a small body keeps the char cap out of play.
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
    expect(result.truncated).toBe(true);
    expect(result.content).toBe(bodyText.slice(0, -1));
  });

  test("a complete file with genuinely unterminated frontmatter keeps its old behavior", () => {
    const root = join(home, ".claude", "skills");
    const dir = join(root, "unterminated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: unterminated\n# not closed");
    const result = readReferenceSkillContent("unterminated")!;
    expect(result.content).toBe("---\nname: unterminated\n# not closed");
  });
});
