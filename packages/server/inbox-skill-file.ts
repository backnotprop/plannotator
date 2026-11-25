/**
 * One skill's SKILL.md, for the person to read beside the thread (a sent
 * message's skill, opened from its chip in the words or its name on the
 * skills line):
 *
 *   GET /api/inbox/skills/file?name=…  → { found: true, name, source, root, text?, too_large?, other_files }
 *                                       | { found: false }
 *
 * The request names the skill; the name is matched against the catalog the
 * reply box lists (`inboxSkillEntries`, so a person's own skill wins over a
 * built-in of the same name, exactly as the picker and the Send resolve it),
 * and the file read is that entry's own folder's SKILL.md. The name is never
 * used as a path: a traversal, a separator or an absolute path matches no
 * entry. A built-in (root `plannotator`) answers its text from Plannotator
 * itself. The read is bounded (`INBOX_SKILL_FILE_MAX_BYTES`); a longer file
 * answers `too_large` with no text. `other_files` counts the folder's other
 * files (references/, scripts/, assets/), bounded; nothing beyond SKILL.md is
 * ever read or named.
 *
 * Window only, like the catalog's other reads: same-origin check in
 * `inboxSkillsRoute`; not on the phone's device door (the phone's page reads
 * it from its own Inbox).
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { inboxBuiltinSkillContent } from "@plannotator/core/inbox-skills-compose";
import type { SkillCatalogEntry } from "@plannotator/core/skill-references-render";

export const INBOX_SKILL_FILE_PATH = "/api/inbox/skills/file";

/** The most of a SKILL.md the viewer is sent. */
export const INBOX_SKILL_FILE_MAX_BYTES = 256 * 1024;

/** The most other files counted in a skill's folder (the count stops there). */
const MAX_COUNTED_FILES = 1000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__"]);

export type InboxSkillFile =
  | { found: false }
  | {
      found: true;
      name: string;
      /** `plannotator`: built into Plannotator; `own`: a skill in the person's global skill folders. */
      source: "plannotator" | "own";
      root: SkillCatalogEntry["root"];
      /** SKILL.md as it is on disk (frontmatter kept), absent when `too_large`. */
      text?: string;
      too_large?: true;
      other_files: number;
    };

function readBounded(path: string, max: number): { text: string; tooLarge: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    if (fstatSync(fd).size > max) return { text: "", tooLarge: true };
    const buf = Buffer.alloc(max);
    const bytes = readSync(fd, buf, 0, max, 0);
    return { text: buf.subarray(0, bytes).toString("utf-8").replace(/^﻿/, ""), tooLarge: false };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Files under `dir` other than its SKILL.md, to MAX_COUNTED_FILES; symlinked folders are not followed. */
function countOtherFiles(dir: string): number {
  let count = 0;
  const walk = (at: string, depth: number) => {
    if (count >= MAX_COUNTED_FILES || depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_COUNTED_FILES) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(at, entry.name), depth + 1);
      } else if (!(depth === 0 && entry.name === "SKILL.md")) {
        count++;
      }
    }
  };
  walk(dir, 0);
  return count;
}

/** `name`'s SKILL.md as the catalog resolves it, or `{ found: false }`. `diagrams`: Chapter diagrams, for a review skill's text. */
export function inboxSkillFile(name: string, catalog: readonly SkillCatalogEntry[], diagrams: boolean, max = INBOX_SKILL_FILE_MAX_BYTES): InboxSkillFile {
  const entry = name ? catalog.find((skill) => skill.name === name) : undefined;
  if (!entry) return { found: false };
  if (entry.root === INBOX_BUILTIN_SKILL_ROOT) {
    const content = inboxBuiltinSkillContent(entry, diagrams);
    if (!content) return { found: false };
    return { found: true, name: entry.name, source: "plannotator", root: entry.root, text: content.content, other_files: 0 };
  }
  if (!entry.dir) return { found: false };
  const read = readBounded(join(entry.dir, "SKILL.md"), max);
  if (!read) return { found: false };
  const base = { found: true as const, name: entry.name, source: "own" as const, root: entry.root, other_files: countOtherFiles(entry.dir) };
  return read.tooLarge ? { ...base, too_large: true } : { ...base, text: read.text };
}
