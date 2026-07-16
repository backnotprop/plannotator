/**
 * Review Skill Loader
 *
 * A custom review is a curated Agent Skill. This loader discovers skills in the
 * user's *global* skill roots, filters them to the ones the user explicitly
 * curated in `${PLANNOTATOR_DATA_DIR}/review-skills.json`, and maps each into a
 * ResolvedReviewProfile whose `instructions` is the skill's SKILL.md body.
 *
 * Server-side (node:fs). Vendored to Pi. The runtime-agnostic prompt-composition
 * spine lives in @plannotator/shared/review-profiles; this file only does disk
 * I/O + curation, then hands a ResolvedReviewProfile to that composer.
 *
 * Trust model (v1): global, user-owned roots only (`~/.claude/skills`,
 * `~/.codex/skills`, `~/.config/agents/skills`), honoring the standard env
 * overrides (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`). Project/repo
 * skills are NOT discovered (the fork-trust problem). See docs/custom-reviews.md.
 *
 * Skip-and-log discipline: an unreadable dir / file is skipped with one log
 * line and never throws. Read on each request — no file watching, no cache.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import {
  BUILTIN_DEFAULT_PROFILE,
  type ResolvedReviewProfile,
} from "@plannotator/shared/review-profiles";

/**
 * Oversized-body bound. A giant SKILL.md would blow up the review prompt; over
 * this length the skill is dropped with a log line and falls through to the
 * built-in default. This is the old MAX_INSTRUCTIONS_LEN value, re-homed here.
 */
export const MAX_SKILL_BODY_LEN = 20_000;

/** Directories never descended during discovery. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

type SkillRoot = "claude" | "codex" | "universal";

/** A skill discovered on disk — catalog stage, no body read, no frontmatter read. */
export interface DiscoveredSkill {
  /** The skill's directory name. */
  name: string;
  /** Absolute path to the skill directory. */
  sourcePath: string;
  /** Absolute path to SKILL.md. */
  skillMdPath: string;
  /** Which global root it came from. */
  root: SkillRoot;
}

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/**
 * The ordered global skill roots, honoring env overrides. First-seen wins on a
 * cross-root name clash, so order matters: Claude → Codex → universal.
 *
 * Roots that resolve (via realpath) to the same on-disk directory are deduped,
 * keeping the first occurrence.
 */
export function resolveGlobalSkillRoots(): Array<{ dir: string; root: SkillRoot }> {
  // Prefer $HOME (where the user's dotfiles live, and what every other skill
  // tool keys off), falling back to the OS home. homedir() caches at process
  // start and ignores a later HOME, so $HOME is also what makes this testable.
  const home = process.env.HOME?.trim() || homedir();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  // Universal root. Two locations are in the wild: the documented/de-facto
  // ~/.agents/skills (where the installer puts skills and Claude symlinks them)
  // and the XDG path ${XDG_CONFIG_HOME:-~/.config}/agents/skills. Scan both; the
  // realpath dedup below collapses them when they point at the same dir.
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");

  const candidates: Array<{ dir: string; root: SkillRoot }> = [
    { dir: join(claudeHome, "skills"), root: "claude" },
    { dir: join(codexHome, "skills"), root: "codex" },
    { dir: join(home, ".agents", "skills"), root: "universal" },
    { dir: join(configHome, "agents", "skills"), root: "universal" },
  ];

  // Dedup by realpath so two roots pointing at the same dir (e.g. via a symlink,
  // or CLAUDE_CONFIG_DIR and CODEX_HOME aimed at one place) collapse to one.
  // Keep first occurrence.
  const seen = new Set<string>();
  const roots: Array<{ dir: string; root: SkillRoot }> = [];
  for (const candidate of candidates) {
    let key: string;
    try {
      key = realpathSync(candidate.dir);
    } catch {
      // Dir doesn't exist or is unreadable; key on the literal path so a
      // non-existent root still dedupes against an identical literal.
      key = candidate.dir;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(candidate);
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** True iff `dir/SKILL.md` exists and is a regular file. */
function hasSkillMd(dir: string): boolean {
  try {
    return statSync(join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

/** List immediate subdirectories of `dir` (skipping known noise dirs), or []. */
function listSubdirs(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(
      `[plannotator] Could not read skill root ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .map((e) => e.name);
}

/**
 * Discover skills across the global roots. A skill is any directory containing a
 * SKILL.md; its `name` is the directory name (no frontmatter read).
 *
 * Container layout: roots are walked one extra level so the catalog layout
 * `skills/<category>/<skill>/SKILL.md` is found, matching the reference walk.
 * A child dir that itself holds a SKILL.md is taken as the skill and not
 * descended into.
 *
 * Dedup by skill `name` across roots — first-seen wins, ordered Claude → Codex
 * → universal (the same first-seen-wins clash story as the old JSON design).
 */
export function discoverSkills(): DiscoveredSkill[] {
  const byName = new Map<string, DiscoveredSkill>();

  const add = (dir: string, root: SkillRoot) => {
    const name = dir.replace(/^.*[\\/]/, "");
    if (byName.has(name)) return; // first-seen wins on a cross-root name clash
    byName.set(name, {
      name,
      sourcePath: dir,
      skillMdPath: join(dir, "SKILL.md"),
      root,
    });
  };

  for (const { dir: rootDir, root } of resolveGlobalSkillRoots()) {
    if (!existsSync(rootDir)) continue;

    for (const childName of listSubdirs(rootDir)) {
      const childDir = join(rootDir, childName);
      if (hasSkillMd(childDir)) {
        add(childDir, root);
        continue; // don't descend past a discovered skill
      }
      // Walk one extra level for the `skills/<category>/<skill>/` catalog layout.
      for (const grandName of listSubdirs(childDir)) {
        const grandDir = join(childDir, grandName);
        if (hasSkillMd(grandDir)) add(grandDir, root);
      }
    }
  }

  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Body extraction (no frontmatter parsing)
// ---------------------------------------------------------------------------

/**
 * Return the SKILL.md body. We do NOT parse frontmatter — we strip only the
 * leading `---…---` block (a split, not a parse) so we don't inject YAML noise,
 * and return everything after it. CRLF/BOM safe.
 *
 * No leading `---` block → the whole file is the body.
 */
export function stripFrontmatter(raw: string): string {
  // Tolerate a UTF-8 BOM and either line ending.
  const text = raw.replace(/^﻿/, "");
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return text;
  return text.slice(match[0].length);
}

/**
 * True iff the skill directory carries files beyond SKILL.md — `references/`,
 * `scripts/`, or `assets/` the body may point at by relative path. An unreadable
 * dir is treated as no extra files; never throws.
 */
function skillHasExtraFiles(sourcePath: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(sourcePath);
  } catch {
    return false;
  }
  return entries.some((name) => name !== "SKILL.md");
}

/**
 * The one line prepended to a skill's instructions when it carries extra files,
 * pointing the agent at the skill's REAL directory (read-only, no copy). The
 * agent's working directory is the repository under review, not the skill dir,
 * so relative references/scripts/assets must resolve against this absolute base.
 * The agent reads those files on demand (progressive disclosure) straight from
 * where the skill already lives — which it can, since it shares the filesystem.
 */
function skillFilesPointerLine(skillDir: string): string {
  return `This review skill's files (references, scripts, assets) are at: ${skillDir}\nResolve any relative paths in the instructions below (e.g. references/, scripts/, assets/) against that absolute directory — the working directory is the repository under review, not the skill directory.`;
}

// ---------------------------------------------------------------------------
// Curation
// ---------------------------------------------------------------------------

/**
 * Read the curated skill names from `${dataDir}/review-skills.json`.
 *
 * Schema (v1): `{ version: 1, enabled: string[] }`. `enabled` may be empty.
 * Anything that fails these checks — missing/non-1 `version`, `enabled` not an
 * array of strings, or unparseable JSON — is treated as no curation (zero
 * custom reviews), logged once. Absent file → no curation, silent.
 *
 * Returns the set of enabled names, or `null` when there is no valid curation.
 */
export function readCuratedSkillNames(): Set<string> | null {
  const path = join(getPlannotatorDataDir(), "review-skills.json");
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(
      `[plannotator] Ignoring malformed review-skills.json: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("[plannotator] Ignoring review-skills.json: not an object.");
    return null;
  }
  const { version, enabled } = parsed as Record<string, unknown>;
  if (version !== 1) {
    console.error("[plannotator] Ignoring review-skills.json: version must be 1.");
    return null;
  }
  if (!Array.isArray(enabled) || !enabled.every((n) => typeof n === "string")) {
    console.error(
      "[plannotator] Ignoring review-skills.json: `enabled` must be an array of strings.",
    );
    return null;
  }
  return new Set(enabled as string[]);
}

/** A discovered skill plus whether it is currently enabled as a review. */
export interface CatalogSkill {
  name: string;
  root: SkillRoot;
  sourcePath: string;
  enabled: boolean;
}

/**
 * Every discovered skill, each flagged with whether it is enabled as a review.
 * Drives the "add a review" picker: the user sees all their skills and turns one
 * on.
 */
export function listAllSkills(): CatalogSkill[] {
  const enabled = readCuratedSkillNames() ?? new Set<string>();
  return discoverSkills().map((s) => ({
    name: s.name,
    root: s.root,
    sourcePath: s.sourcePath,
    enabled: enabled.has(s.name),
  }));
}

/**
 * Enable a skill as a review by adding its name to
 * `${dataDir}/review-skills.json`. Creates the file (and the data dir) if absent,
 * keeps `version: 1`, and dedupes. Returns the updated enabled list.
 *
 * Only a name that matches a real discovered skill is accepted, so curation never
 * points at something that is not there. A malformed existing file is replaced
 * with a clean one (it was already being ignored).
 */
export function enableReviewSkill(name: string): { enabled: string[] } {
  const known = new Set(discoverSkills().map((s) => s.name));
  if (!known.has(name)) {
    throw new Error(`No skill named "${name}" found in any global skill root.`);
  }
  const current = readCuratedSkillNames() ?? new Set<string>();
  current.add(name);
  const enabled = [...current];

  const dir = getPlannotatorDataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "review-skills.json"),
    JSON.stringify({ version: 1, enabled }, null, 2) + "\n",
  );
  return { enabled };
}

// ---------------------------------------------------------------------------
// Load + map to ResolvedReviewProfile
// ---------------------------------------------------------------------------

/**
 * Map a discovered skill into the existing ResolvedReviewProfile contract so
 * nothing downstream learns the word "skill". The id is built inline as
 * `skill:<name>` (an id-string convention; `source` stays `"user"` and adds no
 * ReviewProfileSource variant). The body is read live at this call.
 *
 * Returns `null` when the body is over the size bound (dropped + logged) so the
 * caller falls through to the built-in default.
 */
export function resolveSkillProfile(skill: DiscoveredSkill): ResolvedReviewProfile | null {
  let raw: string;
  try {
    raw = readFileSync(skill.skillMdPath, "utf-8");
  } catch (err) {
    console.error(
      `[plannotator] Skipping review skill ${skill.name}: could not read ${
        skill.skillMdPath
      }: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const body = stripFrontmatter(raw);
  if (!body.trim()) {
    console.error(
      `[plannotator] Skipping review skill ${skill.name}: SKILL.md body is empty.`,
    );
    return null;
  }
  if (body.length > MAX_SKILL_BODY_LEN) {
    console.error(
      `[plannotator] Skipping review skill ${skill.name}: SKILL.md body exceeds ${MAX_SKILL_BODY_LEN} chars.`,
    );
    return null;
  }

  // When the skill carries extra files, point the agent at the skill's real
  // directory so its relative references resolve. No copy is made — the agent
  // reads those files live, on demand, from where the skill already lives.
  const instructions = skillHasExtraFiles(skill.sourcePath)
    ? `${skillFilesPointerLine(skill.sourcePath)}\n\n${body}`
    : body;

  return {
    id: `skill:${skill.name}`,
    label: skill.name,
    instructions,
    source: "user",
    sourcePath: skill.sourcePath,
  };
}

/**
 * Discover global skills and filter to the curated set.
 *
 * A discovered skill becomes a curated review iff its `name` is in
 * `review-skills.json.enabled`. Names in `enabled` with no matching discovered
 * skill are dropped with one log line. Absent/malformed curation → empty.
 */
export function discoverCuratedSkills(): DiscoveredSkill[] {
  const enabled = readCuratedSkillNames();
  if (!enabled || enabled.size === 0) return [];

  const discovered = discoverSkills();
  const byName = new Map(discovered.map((s) => [s.name, s]));

  const curated: DiscoveredSkill[] = [];
  for (const name of enabled) {
    const skill = byName.get(name);
    if (skill) {
      curated.push(skill);
    } else {
      console.error(
        `[plannotator] Curated review skill "${name}" not found in any global skill root; skipping.`,
      );
    }
  }
  return curated;
}

/**
 * Resolve the review profile a launch requested, or throw a clear error.
 *
 * The client only sends a reviewProfileId when the user picked a custom review,
 * so a non-default id that doesn't resolve is a real problem — a renamed or
 * removed skill, a stale cookie, a malformed request — not a reason to quietly
 * run the default against the wrong instructions. Explicit selection is
 * authoritative here. Absent or the reserved default id → the built-in default.
 */
export function resolveRequestedReviewProfile(
  requestedProfileId: string | undefined,
): ResolvedReviewProfile {
  if (!requestedProfileId || requestedProfileId === BUILTIN_DEFAULT_PROFILE.id) {
    return BUILTIN_DEFAULT_PROFILE;
  }
  const skill = discoverCuratedSkills().find((s) => `skill:${s.name}` === requestedProfileId);
  if (!skill) {
    throw new Error(
      `Review "${requestedProfileId}" is not available — it may have been renamed or removed. Pick another review.`,
    );
  }
  const resolved = resolveSkillProfile(skill);
  if (!resolved) {
    throw new Error(
      `Review "${skill.name}" could not be loaded — its SKILL.md is unreadable, empty, or too large. Fix the skill or pick another review.`,
    );
  }
  return resolved;
}

/**
 * Load and resolve review profiles from the curated skills + the built-in
 * default. Always returns at least `builtin:default` first.
 *
 * This is the entry the servers call (same shape as the old loader's
 * loadReviewProfiles). Bodies are read here, live — for the discovery endpoint
 * this is harmless (it only reads `id`/`label`/`source`/`sourcePath`); a future
 * catalog-only path can swap in `discoverCuratedSkills()` directly.
 */
export function loadReviewProfiles(): ResolvedReviewProfile[] {
  const profiles: ResolvedReviewProfile[] = [BUILTIN_DEFAULT_PROFILE];
  for (const skill of discoverCuratedSkills()) {
    const profile = resolveSkillProfile(skill);
    if (profile) profiles.push(profile);
  }
  return profiles;
}
