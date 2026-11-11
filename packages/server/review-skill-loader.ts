/** Discovers skills in the user's global skill roots, filters to those curated in `${PLANNOTATOR_DATA_DIR}/review-skills.json`, and maps them to ResolvedReviewProfile. Vendored to Pi. Repo-local skills are deliberately never discovered (fork trust). */

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
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import {
  BUILTIN_DEFAULT_PROFILE,
  type ResolvedReviewProfile,
} from "@plannotator/shared/review-profiles";

/** Oversized bodies are dropped with a log line and fall through to the built-in default. */
export const MAX_SKILL_BODY_LEN = 20_000;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

export type SkillRoot = "claude" | "codex" | "universal";

export interface DiscoveredSkill {
  name: string;
  sourcePath: string;
  skillMdPath: string;
  root: SkillRoot;
}

/** True when `dir` sits in a temp folder: test runs (PLANNOTATOR_TEST_SANDBOX) read only such folders, so tests never read the person's real skills. Mirrors `agentHomeAllowed` in inbox-agents.ts, which this file cannot import (vendored to Pi). */
function isScratchDir(dir: string): boolean {
  return [tmpdir(), "/tmp", "/private/tmp"].some((root) => {
    let base = root;
    try {
      base = realpathSync(root);
    } catch {
      // No such temp root here (/private/tmp off macOS); compare it as written.
    }
    return dir.startsWith(`${base.replace(/[\\/]+$/, "")}${sep}`);
  });
}

/** First-seen wins on a cross-root name clash (Claude, Codex, universal); roots with the same realpath are deduped. */
export function resolveGlobalSkillRoots(): Array<{ dir: string; root: SkillRoot }> {
  // Prefer $HOME: homedir() ignores a later HOME, so this is also what makes it testable.
  const home = process.env.HOME?.trim() || homedir();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  // Scan both ~/.agents/skills and ${XDG_CONFIG_HOME:-~/.config}/agents/skills; the realpath dedup collapses them when equal.
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");

  const candidates: Array<{ dir: string; root: SkillRoot }> = [
    { dir: join(claudeHome, "skills"), root: "claude" },
    { dir: join(codexHome, "skills"), root: "codex" },
    { dir: join(home, ".agents", "skills"), root: "universal" },
    { dir: join(configHome, "agents", "skills"), root: "universal" },
  ];

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
    if (process.env.PLANNOTATOR_TEST_SANDBOX && !isScratchDir(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(candidate);
  }
  return roots;
}

function hasSkillMd(dir: string): boolean {
  try {
    return statSync(join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

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
      // A symlinked skill dir has isDirectory() false on its dirent: follow it with statSync; stat failures (broken link, ELOOP) are skipped. The walk is fixed depth-2, so no cycle detection is needed.
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

/** A skill is any directory with a SKILL.md, named by the directory; roots are walked one extra level for the `skills/<category>/<skill>/` layout. Dedup by name, first-seen wins. */
export function discoverSkills(): DiscoveredSkill[] {
  const byName = new Map<string, DiscoveredSkill>();

  const add = (dir: string, root: SkillRoot) => {
    const name = dir.replace(/^.*[\\/]/, "");
    if (byName.has(name)) return;
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
      for (const grandName of listSubdirs(childDir)) {
        const grandDir = join(childDir, grandName);
        if (hasSkillMd(grandDir)) add(grandDir, root);
      }
    }
  }

  return [...byName.values()];
}

/** Strips only the leading `---...---` block (a split, not a parse); no block means the whole file is the body. */
export function stripFrontmatter(raw: string): string {
  const text = raw.replace(/^﻿/, "");
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return text;
  return text.slice(match[0].length);
}

function skillHasExtraFiles(sourcePath: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(sourcePath);
  } catch {
    return false;
  }
  return entries.some((name) => name !== "SKILL.md");
}

/** The agent's cwd is the repository under review, so relative references resolve against this absolute base. */
function skillFilesPointerLine(skillDir: string): string {
  return `This review skill's files (references, scripts, assets) are at: ${skillDir}\nResolve any relative paths in the instructions below (e.g. references/, scripts/, assets/) against that absolute directory — the working directory is the repository under review, not the skill directory.`;
}

export const MAX_REFERENCE_SKILLS = 500;

/** Only the head is read for catalog metadata; frontmatter overflowing it fails closed on the invocation flag. */
const SKILL_META_HEAD_BYTES = 65_536;

const MAX_SKILL_DESCRIPTION_LEN = 200;

export interface ReferenceSkill {
  name: string;
  root: SkillRoot;
  description?: string;
  /** True when frontmatter has `disable-model-invocation: true`; exported feedback then injects the skill's instructions instead of just naming it. */
  humanOnly: boolean;
  /** Lets exported feedback name a readable location even if the content endpoint later fails. */
  dir: string;
}

/** `truncated`: the file continues past the read, so the parser must not fail open on cut frontmatter. */
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

function stripYamlScalarComment(value: string): string {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    if (close > 0) return value.slice(0, close + 1);
    return value;
  }
  return value.replace(/(^|[ \t])#.*$/, "").trim();
}

function isYamlTruthy(value: string): boolean {
  const v = stripYamlScalarComment(value).replace(/^["']|["']$/g, "").toLowerCase();
  return v === "true" || v === "yes" || v === "on" || v === "1";
}

/** A line-scan, not a YAML parser. The invocation flag guards a safety property: when frontmatter opened but never closed, honor a flag line seen and otherwise fail closed (`humanOnly: true`); `description` may come back empty. */
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

/** Separate from MAX_SKILL_BODY_LEN: review profiles drop an oversized skill, reference injection truncates and says so. */
export const MAX_INJECTED_SKILL_CONTENT_LEN = 20_000;

/** The content endpoint is unauthenticated on localhost and reachable by a no-cors fetch loop, so the read is bounded: SKILL_META_HEAD_BYTES plus 4 bytes per capped char and slack. Exported for boundary tests. */
export const SKILL_CONTENT_HEAD_BYTES =
  SKILL_META_HEAD_BYTES + MAX_INJECTED_SKILL_CONTENT_LEN * 4 + 4_096;

export interface ReferenceSkillContent {
  name: string;
  dir: string;
  path: string;
  content: string;
  truncated: boolean;
  humanOnly: boolean;
}

/**
 * Security: the client-supplied name is only matched against discoverSkills() names, never used to build a path, so the fast-fail guard rejects only `''`, `.`, `..`; a substring check would 404 legitimate names like `v1..2`.
 * The read is head-bounded (SKILL_CONTENT_HEAD_BYTES); returns null instead of throwing.
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

  const meta = parseSkillFrontmatterMeta(head.text, { truncated: head.truncated });
  const raw = head.text.replace(/^﻿/, "");
  // Frontmatter opened but never closed within a truncated head read: the metadata alone exceeds the bound, so fall back rather than inject raw YAML.
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

export interface CatalogSkill {
  name: string;
  root: SkillRoot;
  sourcePath: string;
  enabled: boolean;
}

export function listAllSkills(): CatalogSkill[] {
  const enabled = readCuratedSkillNames() ?? new Set<string>();
  return discoverSkills().map((s) => ({
    name: s.name,
    root: s.root,
    sourcePath: s.sourcePath,
    enabled: enabled.has(s.name),
  }));
}

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

/** Id is `skill:<name>`; null when the body is over the size bound (dropped and logged) so the caller falls through to the default. */
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

/** A non-default id that does not resolve (renamed or removed skill, stale cookie) throws rather than quietly running the default against the wrong instructions. */
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

export function loadReviewProfiles(): ResolvedReviewProfile[] {
  const profiles: ResolvedReviewProfile[] = [BUILTIN_DEFAULT_PROFILE];
  for (const skill of discoverCuratedSkills()) {
    const profile = resolveSkillProfile(skill);
    if (profile) profiles.push(profile);
  }
  return profiles;
}
