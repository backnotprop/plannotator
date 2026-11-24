import {
  REVIEWER_SKILL_AUDIENCE,
  skillInstructionsIncludedNote,
  skillsReferencedHeading,
  type SkillBlockAudience,
} from './skill-reference-block';

/**
 * Where a skill came from. `plannotator`: one of Plannotator's own skills a
 * host serves itself (the Inbox's review skills, while Code review is on):
 * human-only, with no folder on disk; its instructions are the host's text.
 */
export type SkillRootId = 'claude' | 'codex' | 'universal' | 'plannotator';

export interface SkillCatalogEntry {
  name: string;
  root: SkillRootId;
  description?: string;
  /** Skill frontmatter carries `disable-model-invocation: true`: only a human can invoke it. */
  humanOnly: boolean;
  /** Absolute path to the skill directory, when the server provides it. */
  dir?: string;
}

/**
 * A human-only skill's SKILL.md body, fetched from the server for injection
 * into exported feedback (see utils/skillCatalog.ts, primeSkillContentsForExport).
 */
export interface SkillExportContent {
  /** Verbatim SKILL.md body (frontmatter stripped), possibly truncated. */
  content: string;
  /** True when the server cut the body at its injection bound. */
  truncated: boolean;
  /** Absolute path to the skill directory. */
  dir: string;
  /** Absolute path to SKILL.md. */
  path: string;
}

const humanOnlyExportNote = (audience: SkillBlockAudience): string =>
  `human-invocation-only: you cannot invoke this skill; the ${audience.requester} included it as context`;

/**
 * The structural forms the injection block itself uses: the BEGIN/END markers
 * (a skill's instructions, and the Inbox's PLANNOTATOR NOTE after them) and the truncation notice. A skill body line matching one of these could
 * close our block early (everything after it then reads to the receiving
 * agent as the reviewer's own words), forge a BEGIN marker for a skill nobody
 * referenced, or forge a truncation notice pointing at an attacker-chosen
 * path. Skill bodies are user-installed — routinely from third-party repos —
 * so lookalike lines are neutralized before injection. Leading whitespace and
 * case variants count, as do lines dressed in markdown decoration (`> `,
 * `**`, backticks, `#`), unicode-dash or `=` rules, and invisible format
 * characters laced through the words: a loose reader would still take every
 * one of them for markers. The match stays anchored to a leading dash/equals
 * run (after optional decoration), so the words "BEGIN SKILL INSTRUCTIONS"
 * appearing mid-sentence in ordinary prose are never touched.
 */
const MARKER_LOOKALIKE_RE =
  // Dash run: ASCII hyphen, `=`, the unicode hyphen/dash block U+2010–U+2015
  // (incl. en/em dash), and the minus sign U+2212.
  /^[\s>*_#`]*(?:[-=‐-―−]{2,}\s*(?:BEGIN|END)\s*(?:SKILL\s*INSTRUCTIONS|PLANNOTATOR\s*NOTE)\b|\[\s*Instructions\s*truncated\b)/i;

/**
 * Invisible format characters (Unicode category Cf: zero-width space/joiners
 * U+200B–U+200D, word joiner U+2060, BOM/zero-width no-break space U+FEFF,
 * soft hyphens, bidi controls, …). JS `\s` matches none of these, so
 * `---​BEGIN​SKILL​INSTRUCTIONS` slipped past the old regex
 * while still reading as a marker to an LLM. They are stripped (removed, not
 * replaced — an attacker can also lace them INSIDE a word) before matching;
 * the ORIGINAL line is what gets neutralized. The inter-word `\s*` in the
 * regex above is what keeps the stripped, jammed-together form matchable.
 */
const INVISIBLE_FORMAT_CHARS_RE = /\p{Cf}/gu;

const NEUTRALIZED_LINE_PREFIX =
  '[plannotator: the following skill-body line matched an injection marker and was neutralized] ';

/**
 * Neutralize body lines that match our own structural markers, visibly: each
 * matching line is kept verbatim but prefixed, never silently deleted, so the
 * line no longer parses as a marker while the reader can still see exactly
 * what the body contained. Matching runs against the line with invisible
 * format characters stripped, but the original line is what is prefixed.
 */
export function neutralizeSkillMarkerLines(body: string): string {
  return body
    .split('\n')
    .map((line) =>
      MARKER_LOOKALIKE_RE.test(line.replace(INVISIBLE_FORMAT_CHARS_RE, ''))
        ? NEUTRALIZED_LINE_PREFIX + line
        : line,
    )
    .join('\n');
}

/** Instruction block for one injected human-only skill. Unmistakably delimited
 *  (BEGIN/END markers survive any markdown inside the body, unlike a fence)
 *  and labeled so it can never read as the reviewer's own words. Body lines
 *  that imitate the markers are neutralized (see neutralizeSkillMarkerLines)
 *  so the body cannot close the block early or forge a sibling block. */
function injectedSkillSection(name: string, body: SkillExportContent, audience: SkillBlockAudience, builtin = false): string {
  let out = `--- BEGIN SKILL INSTRUCTIONS: ${name} ---\n`;
  if (builtin) {
    // One of Plannotator's own skills (root `plannotator`): no folder to name, nothing truncated.
    out += `A Plannotator Inbox skill, included here at the ${audience.requester}'s request. Follow it when acting on this ${audience.subject}.\n\n`;
    out += `${neutralizeSkillMarkerLines(body.content)}\n`;
    out += `--- END SKILL INSTRUCTIONS: ${name} ---\n`;
    return out;
  }
  out += `This skill cannot be invoked by a model, so its instructions are included here at the ${audience.requester}'s request. Follow them when acting on this ${audience.subject}.\n`;
  out += `Skill directory: ${body.dir}\n`;
  out += `Resolve any relative paths in the instructions below (e.g. references/, scripts/, assets/) against that absolute directory; your working directory is not the skill directory.\n\n`;
  out += `${neutralizeSkillMarkerLines(body.content)}\n`;
  if (body.truncated) {
    out += `\n[Instructions truncated: this is not the full skill. Read the rest at ${body.path}]\n`;
  }
  out += `--- END SKILL INSTRUCTIONS: ${name} ---\n`;
  return out;
}

/** What `renderSkillReferencesBlock` needs besides the references themselves. */
export interface SkillReferencesBlockOptions {
  /** The SKILL.md body of a human-only skill, when it is to be injected; undefined falls back to the name + directory line. */
  contentOf?: (name: string) => SkillExportContent | undefined;
  /** Per-export dedupe (see skillReferenceExportBlock). */
  injectedNames?: Set<string>;
  /** A comment that did not come from the person in this UI: never injects (see skillReferenceExportBlock). */
  external?: boolean;
  /** Who is asking, about what. Default: the reviewer, about this feedback (Plannotator's export). */
  audience?: SkillBlockAudience;
}

/**
 * The block itself, for references a caller already resolved: the export
 * above per comment, and a host that composes ONE block per message (the
 * Plannotator Inbox, with `INBOX_REPLY_SKILL_AUDIENCE`). '' when `refs` is
 * empty. Same rules and markers as skillReferenceExportBlock.
 */
export function renderSkillReferencesBlock(
  refs: readonly SkillCatalogEntry[],
  options: SkillReferencesBlockOptions = {},
): string {
  if (refs.length === 0) return '';
  const { injectedNames } = options;
  const audience = options.audience ?? REVIEWER_SKILL_AUDIENCE;
  const external = options.external === true;
  const toInject: Array<{ name: string; body: SkillExportContent; builtin?: boolean }> = [];
  let out = `${skillsReferencedHeading(audience)}\n`;
  for (const ref of refs) {
    if (ref.root === 'plannotator') {
      // Plannotator's own skill: the host supplies its text; never from an external tool.
      const body = external ? undefined : options.contentOf?.(ref.name);
      if (body) {
        toInject.push({ name: ref.name, body, builtin: true });
        out += `- \`${ref.name}\` (a Plannotator Inbox skill; ${skillInstructionsIncludedNote(audience)})\n`;
      } else {
        out += `- \`${ref.name}\` (a Plannotator Inbox skill; its instructions could not be included)\n`;
      }
      continue;
    }
    if (!ref.humanOnly) {
      out += `- \`${ref.name}\`\n`;
      continue;
    }
    const body = options.contentOf?.(ref.name);
    if (body && injectedNames?.has(ref.name)) {
      // Already injected earlier in this export (necessarily by a reviewer-
      // written comment) — true regardless of who references it now.
      out += `- \`${ref.name}\` (cannot be invoked by a model; its instructions are included earlier in this ${audience.subject})\n`;
    } else if (external) {
      // Tool-submitted comment: name + directory, never verbatim injection.
      out += ref.dir
        ? `- \`${ref.name}\` (cannot be invoked by a model; this comment came from an external tool, so its instructions are not included — SKILL.md is in ${ref.dir})\n`
        : `- \`${ref.name}\` (${humanOnlyExportNote(audience)})\n`;
    } else if (body) {
      injectedNames?.add(ref.name);
      toInject.push({ name: ref.name, body });
      out += `- \`${ref.name}\` (cannot be invoked by a model; ${skillInstructionsIncludedNote(audience)})\n`;
    } else if (ref.dir) {
      out += `- \`${ref.name}\` (cannot be invoked by a model; its instructions could not be included, read SKILL.md in ${ref.dir} and follow it)\n`;
    } else {
      out += `- \`${ref.name}\` (${humanOnlyExportNote(audience)})\n`;
    }
  }
  for (const { name, body, builtin } of toInject) {
    out += `\n${injectedSkillSection(name, body, audience, builtin)}`;
  }
  return out;
}
