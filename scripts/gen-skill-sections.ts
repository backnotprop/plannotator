/**
 * Writes the generated parts of the plannotator skill
 * (apps/skills/core/plannotator/SKILL.md) from their one source:
 *
 *   - Shape (packages/core/shape-skill.ts): the description phrase
 *     SHAPE_SKILL_DESCRIPTION_PHRASE, after "Guided Reviews,", and the section
 *     SHAPE_SKILL_SECTION, before "## Other subcommands". Both only while
 *     `shape` is released (not in HIDDEN_SUBCOMMANDS, apps/hook/server/cli.ts);
 *     while it is hidden they are taken out, so the skill names no unreleased
 *     command.
 *
 *   bun run gen:skills
 *
 * SKILL.md stays committed (the installers copy it from the release tag, and
 * Pi's vendor.sh and OpenCode's build:skill copy it from this folder).
 * apps/hook/server/plannotator-skill-reference.test.ts fails until you run this
 * after changing a source.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHAPE_SKILL_DESCRIPTION_PHRASE, SHAPE_SKILL_SECTION } from "../packages/core/shape-skill";

export const PLANNOTATOR_SKILL_MD = join(import.meta.dir, "..", "apps", "skills", "core", "plannotator", "SKILL.md");

/** Where the description phrase goes: right after this. */
const DESCRIPTION_ANCHOR = "Guided Reviews, ";
/** Where the section goes: right before this heading. */
const SECTION_ANCHOR = "## Other subcommands\n";
/** The section's heading. An old copy is found by it, whatever its text, and replaced. */
export const SHAPE_SECTION_HEADING = "## plannotator shape";
/** An old copy of the phrase, whatever its words: "Shape boards (…), " right after the anchor. */
const OLD_PHRASE = /(?<=Guided Reviews, )Shape boards \([^)]*\), /;

export interface SkillSectionOptions {
  /** `shape` is released (not in HIDDEN_SUBCOMMANDS). */
  shapeReleased: boolean;
}

/** The level-2 section that starts with `heading`, up to the next level-2 heading outside a code fence; null when absent. */
export function skillSectionOf(doc: string, heading: string): { start: number; end: number } | null {
  const at = doc.indexOf(`\n${heading}\n`);
  if (at < 0) return null;
  const start = at + 1;
  let inFence = false;
  let offset = start + heading.length + 1;
  for (const line of doc.slice(offset).split("\n")) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line)) return { start, end: offset };
    offset += line.length + 1;
  }
  return { start, end: doc.length };
}

/** SKILL.md with its generated parts written from their sources. Pure; the same input gives the same output. */
export function renderSkillSections(doc: string, options: SkillSectionOptions): string {
  const descriptionLine = doc.split("\n").find((line) => line.startsWith("description: "));
  if (!descriptionLine?.includes(DESCRIPTION_ANCHOR)) throw new Error(`SKILL.md's description has no "${DESCRIPTION_ANCHOR.trim()}" to put the Shape phrase after`);
  if (!doc.includes(`\n${SECTION_ANCHOR}`)) throw new Error(`SKILL.md has no "${SECTION_ANCHOR.trim()}" heading to put the Shape section before`);

  if (!SHAPE_SKILL_SECTION.startsWith(`${SHAPE_SECTION_HEADING}\n`)) throw new Error(`SHAPE_SKILL_SECTION must start with "${SHAPE_SECTION_HEADING}"`);
  if (!OLD_PHRASE.test(`${DESCRIPTION_ANCHOR}${SHAPE_SKILL_DESCRIPTION_PHRASE} `)) throw new Error("SHAPE_SKILL_DESCRIPTION_PHRASE no longer matches the pattern that removes an old copy");

  // Take both out first, by heading and by shape, not by text: a run after a source change (or a release) replaces them.
  let out = doc.replace(OLD_PHRASE, "");
  const old = skillSectionOf(out, SHAPE_SECTION_HEADING);
  if (old) out = out.slice(0, old.start) + out.slice(old.end);

  if (!options.shapeReleased) return out;
  const description = out.split("\n").find((line) => line.startsWith("description: "))!;
  out = out.replace(description, description.replace(DESCRIPTION_ANCHOR, `${DESCRIPTION_ANCHOR}${SHAPE_SKILL_DESCRIPTION_PHRASE} `));
  const anchor = out.indexOf(`\n${SECTION_ANCHOR}`) + 1;
  return `${out.slice(0, anchor)}${SHAPE_SKILL_SECTION}\n${out.slice(anchor)}`;
}

if (import.meta.main) {
  const { HIDDEN_SUBCOMMANDS } = await import("../apps/hook/server/cli");
  const before = readFileSync(PLANNOTATOR_SKILL_MD, "utf-8");
  const after = renderSkillSections(before, { shapeReleased: !HIDDEN_SUBCOMMANDS.has("shape") });
  if (after === before) {
    process.stdout.write(`${PLANNOTATOR_SKILL_MD}: up to date\n`);
  } else {
    writeFileSync(PLANNOTATOR_SKILL_MD, after);
    process.stdout.write(`wrote ${PLANNOTATOR_SKILL_MD}\n`);
  }
  process.exit(0);
}
