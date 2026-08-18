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
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
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

export type SkillRoot = "claude" | "codex" | "universal";

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
    .filter((e) => {
      if (SKIP_DIRS.has(e.name)) return false;
      if (e.isDirectory()) return true;
      // A symlinked skill dir (`~/.claude/skills/foo -> /elsewhere/foo`) has
      // isDirectory() false on its dirent — follow it with statSync. A broken
      // symlink (or any stat failure, e.g. an ELOOP symlink cycle) is skipped
      // silently. No extra cycle detection is needed: statSync resolves to
      // the final target (throwing on loops), and discovery is a fixed
      // depth-2 walk with a hard cap, never a recursion that could follow a
      // symlink back up the tree.
      if (e.isSymbolicLink()) {
        try {
          return statSync(join(dir, e.name)).isDirectory();
        } catch {
          return false;
        }
      }
      return false;
    })
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
// Reference catalog (skill mentions in plan/annotate comments)
// ---------------------------------------------------------------------------

/**
 * Discovery bound for the reference catalog, mirroring the bounded-discovery
 * precedent of PLANNOTATOR_FILE_BROWSER_MAX_FILES: the picker never grows
 * past this many skills, however large the roots are.
 */
export const MAX_REFERENCE_SKILLS = 500;

/**
 * Only the head of SKILL.md is read for catalog metadata — frontmatter lives at
 * the top, and this caps I/O per skill regardless of body size. Frontmatter
 * that overflows even this generous bound is treated as truncated and FAILS
 * CLOSED on the invocation flag (see parseSkillFrontmatterMeta) — never open.
 */
const SKILL_META_HEAD_BYTES = 65_536;

/** Descriptions are picker subtitles, not documents. */
const MAX_SKILL_DESCRIPTION_LEN = 200;

/** A skill as served to the comment-composer picker. */
export interface ReferenceSkill {
  name: string;
  root: SkillRoot;
  description?: string;
  /**
   * True when SKILL.md frontmatter carries `disable-model-invocation: true` —
   * the skill can only be invoked by a human, so a model receiving feedback
   * that references it cannot run it. The exported feedback injects such a
   * skill's instructions instead of just naming it (a human referencing a
   * human-only skill IS the human invocation).
   */
  humanOnly: boolean;
  /**
   * Absolute path to the skill directory. Lets the exported feedback name a
   * real location the acting agent can read even when the content endpoint
   * later fails (skill deleted mid-session, unreadable file). Same exposure
   * as `sourcePath` on /api/agents/skills.
   */
  dir: string;
}

/**
 * Read at most `maxBytes` from the start of a file, or null when unreadable.
 * `truncated` reports whether the file continues past the read (the head may
 * have cut frontmatter short — the parser must not fail open on that).
 */
function readFileHead(
  path: string,
  maxBytes: number,
): { text: string; truncated: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    // Truncation means the file CONTINUES past the read — judged from the
    // real size (fstat on the already-open fd), not from `bytes === maxBytes`,
    // which spuriously flagged a file of exactly maxBytes as truncated.
    const truncated = fstatSync(fd).size > bytes;
    return { text: buf.subarray(0, bytes).toString("utf-8"), truncated };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Strip a trailing YAML comment from an unquoted scalar: a `#` preceded by
 * whitespace starts a comment (`true # note` → `true`). Quoted scalars keep
 * their content verbatim; a comment after the closing quote is dropped.
 */
function stripYamlScalarComment(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    if (close > 0) return value.slice(0, close + 1);
    return value;
  }
  return value.replace(/(^|[ \t])#.*$/, "").trim();
}

/** The truthy spellings accepted for `disable-model-invocation` (YAML 1.1 bools + `1`). */
function isYamlTruthy(value: string): boolean {
  const v = stripYamlScalarComment(value).replace(/^["']|["']$/g, "").toLowerCase();
  return v === "true" || v === "yes" || v === "on" || v === "1";
}

/**
 * Extract the two frontmatter fields the reference picker needs: `description`
 * and `disable-model-invocation`. A deliberate line-scan, not a YAML parser —
 * the same conservative posture as stripFrontmatter. Handles quoted scalars,
 * `>` / `|` block scalars (folded to one line), and trailing `# comments` on
 * the flag value.
 *
 * Failure posture is asymmetric on purpose: `description` may silently come
 * back empty, but the invocation flag guards a safety property (a human-only
 * skill must never be presented as model-invocable). So whenever frontmatter
 * OPENED but no closing `---` was seen — whether the head read truncated the
 * file or the file itself never terminates the block — the scan still honors
 * a flag line it DID see, and fails closed (`humanOnly: true`) when it saw
 * none: the flag could sit past the truncation point, and an unterminated
 * block in a complete file means the frontmatter cannot be trusted at all.
 * A complete file with no leading `---` yields `{ humanOnly: false }` as
 * before. (`options.truncated` is kept for callers but no longer gates the
 * fail-closed path.)
 */
export function parseSkillFrontmatterMeta(
  raw: string,
  _options: { truncated?: boolean } = {},
): {
  description?: string;
  humanOnly: boolean;
} {
  const text = raw.replace(/^﻿/, "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  let block: string;
  let failClosed = false;
  if (match) {
    block = match[1];
  } else if (/^---\r?\n/.test(text)) {
    // Frontmatter opened but never closed (truncated head read OR a complete
    // file with an unterminated block): scan what we have, and fail closed on
    // the flag unless a flag line was seen.
    block = text.replace(/^---\r?\n/, "");
    failClosed = true;
  } else {
    return { humanOnly: false };
  }

  const lines = block.split(/\r?\n/);
  let description: string | undefined;
  let humanOnly = false;
  let sawFlag = false;

  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();

    if (key === "disable-model-invocation") {
      sawFlag = true;
      humanOnly = isYamlTruthy(value);
    } else if (key === "description") {
      if (value === "" || /^[>|][+-]?$/.test(value)) {
        // Block scalar: gather the following indented lines into one line.
        const parts: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === "") continue;
          if (!/^[ \t]/.test(lines[j])) break;
          parts.push(lines[j].trim());
        }
        description = parts.join(" ");
      } else {
        description = stripYamlScalarComment(value).replace(/^["']|["']$/g, "");
      }
    }
  }

  if (failClosed && !sawFlag) humanOnly = true;
  if (description) description = description.slice(0, MAX_SKILL_DESCRIPTION_LEN);
  return { ...(description ? { description } : {}), humanOnly };
}

/**
 * The reference catalog: every discovered skill (same roots, dedupe, and
 * first-seen precedence as discoverSkills — Claude → Codex → universal) with
 * picker metadata read from the head of its SKILL.md. Read fresh on each call,
 * never cached or persisted server-side (the catalog is ephemeral by design).
 * A skill whose SKILL.md cannot be read is skipped; this never throws.
 */
export function listReferenceSkills(): ReferenceSkill[] {
  const skills: ReferenceSkill[] = [];
  // Sort BEFORE capping: readdir order is filesystem-dependent, so slicing
  // first would make which 500 survive nondeterministic across machines.
  const discovered = discoverSkills()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_REFERENCE_SKILLS);
  for (const skill of discovered) {
    const head = readFileHead(skill.skillMdPath, SKILL_META_HEAD_BYTES);
    if (head === null) continue;
    const meta = parseSkillFrontmatterMeta(head.text, { truncated: head.truncated });
    skills.push({ name: skill.name, root: skill.root, ...meta, dir: skill.sourcePath });
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Reference content (human-only skill injection into exported feedback)
// ---------------------------------------------------------------------------

/**
 * Injection bound for a referenced skill's SKILL.md body. Same value as
 * MAX_SKILL_BODY_LEN (the "a giant SKILL.md would blow up the prompt" bound),
 * but a separate constant: review profiles DROP an oversized skill, while
 * reference injection TRUNCATES and says so, pointing the agent at the file.
 */
export const MAX_INJECTED_SKILL_CONTENT_LEN = 20_000;

/**
 * Read bound for the content endpoint. The endpoint is unauthenticated on
 * localhost and reachable by a no-cors fetch loop from any page, so the read
 * itself must be bounded — reading a whole multi-GB SKILL.md and then slicing
 * would let response-unreadable requests balloon process RSS. The bound is the
 * frontmatter allowance the catalog already uses (SKILL_META_HEAD_BYTES) plus
 * 4 bytes per capped content char (UTF-8 worst case) and slack, so any file
 * whose frontmatter fits the catalog bound always yields the full
 * MAX_INJECTED_SKILL_CONTENT_LEN characters of body — truncation detection is
 * unchanged for every such file. Exported for the boundary tests only.
 */
export const SKILL_CONTENT_HEAD_BYTES =
  SKILL_META_HEAD_BYTES + MAX_INJECTED_SKILL_CONTENT_LEN * 4 + 4_096;

/** A referenced skill's SKILL.md body, prepared for feedback injection. */
export interface ReferenceSkillContent {
  name: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** Absolute path to SKILL.md. */
  path: string;
  /** Frontmatter-stripped SKILL.md body, possibly truncated. */
  content: string;
  /** True when the body was cut at MAX_INJECTED_SKILL_CONTENT_LEN. */
  truncated: boolean;
  humanOnly: boolean;
}

/**
 * Read a referenced skill's SKILL.md body for injection into exported
 * feedback.
 *
 * Security: the client-supplied name is only ever MATCHED against the names
 * produced by discoverSkills() — it is never used to build a filesystem path,
 * so traversal sequences, separators, and absolute paths cannot reach outside
 * the discovered roots (they simply match no skill). Because matching is the
 * whole defense, the fast-fail guard rejects only names that can never be a
 * readdir entry (empty, `.`, `..`) — a substring check like `includes("..")`
 * would 404 legitimately discovered directories such as `v1..2`, and POSIX
 * directory names may legitimately contain `\`.
 *
 * The read is bounded (SKILL_CONTENT_HEAD_BYTES): only the head that can
 * contribute to the response is read, so a giant SKILL.md costs bounded
 * memory per request instead of its file size.
 *
 * Returns null (never throws) when the name matches no discovered skill, the
 * file cannot be read, or the body is empty — the client then falls back to
 * naming the skill plus its directory.
 */
export function readReferenceSkillContent(name: string): ReferenceSkillContent | null {
  if (!name || name === "." || name === "..") return null;
  const skill = discoverSkills().find((s) => s.name === name);
  if (!skill) return null;

  const head = readFileHead(skill.skillMdPath, SKILL_CONTENT_HEAD_BYTES);
  if (head === null) {
    console.error(`[plannotator] Could not read skill "${name}" for reference injection.`);
    return null;
  }

  // Frontmatter is metadata (name, description, invocation flags), not
  // instruction — strip it, matching how review profiles consume skills.
  const meta = parseSkillFrontmatterMeta(head.text, { truncated: head.truncated });
  const raw = head.text.replace(/^﻿/, "");
  // Frontmatter that OPENED but never closed within the head read: when the
  // file continues past the read, the metadata alone exceeds the bound — fall
  // back rather than injecting a screenful of raw YAML as "instructions". (In
  // a complete file the unterminated block keeps its pre-bound behavior: the
  // whole text is the body, exactly as readFileSync produced before.)
  const frontmatterOpened = /^---\r?\n/.test(raw);
  const frontmatterClosed = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.test(raw);
  if (head.truncated && frontmatterOpened && !frontmatterClosed) return null;

  const body = stripFrontmatter(head.text).trim();
  if (!body) return null;

  // `head.truncated` alone marks truncation even when the head yielded fewer
  // than the cap's worth of characters (multibyte-heavy files): the file
  // continues past what was read, and the notice must say so.
  const truncated = head.truncated || body.length > MAX_INJECTED_SKILL_CONTENT_LEN;
  return {
    name: skill.name,
    dir: skill.sourcePath,
    path: skill.skillMdPath,
    content:
      body.length > MAX_INJECTED_SKILL_CONTENT_LEN
        ? body.slice(0, MAX_INJECTED_SKILL_CONTENT_LEN)
        : body,
    truncated,
    humanOnly: meta.humanOnly,
  };
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
