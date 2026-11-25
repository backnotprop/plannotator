/**
 * One skill's SKILL.md, for the person to read beside the thread (a sent
 * message's skill, opened from its chip in the words or its name on the
 * skills line):
 *
 *   GET /api/inbox/skills/file?name=…  → { found: true, name, source, root, text?, too_large? }
 *                                       | { found: false }
 *
 * The request names the skill; the name is matched against the catalog
 * (`inboxSkillEntries` with every built-in, so a person's own skill wins over
 * a built-in of the same name, exactly as the picker and the Send resolve it),
 * and the file read is that entry's own folder's SKILL.md. A built-in is
 * found by its name whatever the Code review and Routines switches say today:
 * its text ships in Plannotator, and a reply sent while the switch was on
 * still names it. The name is never used as a path: a traversal, a separator
 * or an absolute path matches no entry. A built-in (root `plannotator`)
 * answers its text from Plannotator itself. The read is bounded
 * (`INBOX_SKILL_FILE_MAX_BYTES`); a longer file answers `too_large` with no
 * text. Nothing beyond SKILL.md is ever read or named.
 *
 * Window only, like the catalog's other reads: same-origin check in
 * `inboxSkillsRoute`; not on the phone's device door. A linked machine's
 * skill is read through its door's `skills/content` (packages/inbox/data/skillFile.ts).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { inboxBuiltinSkillContent } from "@plannotator/core/inbox-skills-compose";
import type { SkillCatalogEntry } from "@plannotator/core/skill-references-render";

/** The most of a SKILL.md the viewer is sent. */
export const INBOX_SKILL_FILE_MAX_BYTES = 256 * 1024;

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

/** `name`'s SKILL.md as the catalog resolves it, or `{ found: false }`. `diagrams`: Chapter diagrams, for a review skill's text. */
export function inboxSkillFile(name: string, catalog: readonly SkillCatalogEntry[], diagrams: boolean, max = INBOX_SKILL_FILE_MAX_BYTES): InboxSkillFile {
  const entry = name ? catalog.find((skill) => skill.name === name) : undefined;
  if (!entry) return { found: false };
  if (entry.root === INBOX_BUILTIN_SKILL_ROOT) {
    const content = inboxBuiltinSkillContent(entry, diagrams);
    if (!content) return { found: false };
    return { found: true, name: entry.name, source: "plannotator", root: entry.root, text: content.content };
  }
  if (!entry.dir) return { found: false };
  const read = readBounded(join(entry.dir, "SKILL.md"), max);
  if (!read) return { found: false };
  const base = { found: true as const, name: entry.name, source: "own" as const, root: entry.root };
  return read.tooLarge ? { ...base, too_large: true } : { ...base, text: read.text };
}
