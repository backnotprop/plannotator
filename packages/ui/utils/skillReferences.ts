import {
  REVIEWER_SKILL_AUDIENCE,
  skillInstructionsIncludedNote,
  skillsReferencedHeading,
  type SkillBlockAudience,
} from '@plannotator/core/skill-reference-block';

export type SkillRootId = 'claude' | 'codex' | 'universal' | 'plannotator';

export interface SkillCatalogEntry {
  name: string;
  root: SkillRootId;
  description?: string;
  humanOnly: boolean;
  dir?: string;
}

export const SKILL_TRIGGER_CHARS = ['/', '$'] as const;
export type SkillTriggerChar = (typeof SKILL_TRIGGER_CHARS)[number];

/** Longest query the composer keeps treating as a skill lookup. */
export const MAX_SKILL_QUERY_LEN = 48;

const TOKEN_CHARS = /^[A-Za-z0-9._-]*$/;

export interface SkillTriggerContext {
  start: number;
  trigger: SkillTriggerChar;
  /** Text between the trigger character and the caret. */
  query: string;
}

/** The active skill trigger at `caret`, or null. */
export function findSkillTrigger(text: string, caret: number): SkillTriggerContext | null {
  if (caret < 1 || caret > text.length) return null;

  let start = caret - 1;
  while (start >= 0 && !SKILL_TRIGGER_CHARS.includes(text[start] as SkillTriggerChar)) {
    if (caret - start > MAX_SKILL_QUERY_LEN) return null;
    start--;
  }
  if (start < 0) return null;

  const trigger = text[start] as SkillTriggerChar;
  const before = start === 0 ? '' : text[start - 1];
  if (before !== '' && !/[\s(]/.test(before)) return null;

  const query = text.slice(start + 1, caret);
  if (query.length > MAX_SKILL_QUERY_LEN) return null;
  if (!TOKEN_CHARS.test(query)) return null;

  return { start, trigger, query };
}

/**
 * Filter the catalog for the picker: case-insensitive, name prefix matches first, then name
 * substring, then description substring.
 */
export function filterSkillCatalog(
  catalog: SkillCatalogEntry[],
  query: string,
  limit = 50,
): SkillCatalogEntry[] {
  const q = query.toLowerCase();
  if (!q) return catalog.slice(0, limit);

  const prefix: SkillCatalogEntry[] = [];
  const substring: SkillCatalogEntry[] = [];
  const description: SkillCatalogEntry[] = [];
  for (const entry of catalog) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(entry);
    else if (name.includes(q)) substring.push(entry);
    else if (entry.description?.toLowerCase().includes(q)) description.push(entry);
  }
  return [...prefix, ...substring, ...description].slice(0, limit);
}

/**
 * `/run`, `/tmp`, `/etc`… read as filesystem paths in prose, so a `/`-triggered token with one
 * of these names is never extracted as a skill reference, even when a skill shares the name.
 */
const RESERVED_PATH_SEGMENTS = new Set([
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'media', 'mnt', 'opt',
  'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
]);

const SLASH_PROSE_PRECEDING_WORDS = new Set([
  'get', 'head', 'post', 'put', 'delete', 'options', 'patch',
  'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would',
]);

/**
 * A newline (or any non-space boundary) between the word and the trigger breaks the pairing — a
 * line-starting `/name` always reads as deliberate.
 */
function slashTokenReadsAsProse(text: string, triggerIndex: number): boolean {
  const before = text.slice(0, triggerIndex);
  const word = /([A-Za-z]+)[ \t]+$/.exec(before)?.[1];
  return word !== undefined && SLASH_PROSE_PRECEDING_WORDS.has(word.toLowerCase());
}

/**
 * Replace the in-progress trigger token with the chosen skill (keeping the trigger character the
 * user typed) plus a trailing space.
 */
export function insertSkillReference(
  text: string,
  caret: number,
  trigger: SkillTriggerContext,
  skill: SkillCatalogEntry,
): { text: string; caret: number } {
  const triggerChar =
    trigger.trigger === '/' &&
    (RESERVED_PATH_SEGMENTS.has(skill.name.toLowerCase()) ||
      slashTokenReadsAsProse(text, trigger.start))
      ? '$'
      : trigger.trigger;
  const inserted = `${triggerChar}${skill.name} `;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(caret),
    caret: trigger.start + inserted.length,
  };
}

/** One skill-reference occurrence in a text, with its exact span. */
export interface SkillReferenceToken {
  start: number;
  end: number;
  entry: SkillCatalogEntry;
}

/**
 * Every skill-reference occurrence in the text, in order, WITH positions and without dedupe —
 * this is what the composer's highlight overlay paints.
 */
export function findSkillReferenceTokens(
  text: string,
  catalog: SkillCatalogEntry[],
): SkillReferenceToken[] {
  if (!text || catalog.length === 0) return [];
  const byExactName = new Map<string, SkillCatalogEntry>();
  const byLowerName = new Map<string, SkillCatalogEntry>();
  for (const s of catalog) {
    if (!byExactName.has(s.name)) byExactName.set(s.name, s);
    const lower = s.name.toLowerCase();
    if (!byLowerName.has(lower)) byLowerName.set(lower, s);
  }
  const lookup = (n: string) => byExactName.get(n) ?? byLowerName.get(n.toLowerCase());

  const tokens: SkillReferenceToken[] = [];
  const re = /(^|[\s(])([$/])([A-Za-z0-9][A-Za-z0-9._-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const after = text[m.index + m[0].length];
    if (after === '/' || after === '\\') continue;
    if (m[1] === '(' && text[m.index - 1] === ']') continue;
    const name = m[3].toLowerCase();
    const trimmed = m[3].replace(/\.+$/, '');
    const trimmedName = trimmed.toLowerCase();
    // `/run`-style well-known absolute paths never count (only for `/`).
    if (m[2] === '/' && (RESERVED_PATH_SEGMENTS.has(name) || RESERVED_PATH_SEGMENTS.has(trimmedName)))
      continue;
    // Prose guard (only for `/`): "GET /show" is a route, "could /simplify"
    // is an emphasized verb — never a skill reference.
    if (m[2] === '/' && slashTokenReadsAsProse(text, m.index + m[1].length)) continue;
    const exact = lookup(m[3]);
    const entry = exact ?? lookup(trimmed);
    if (!entry) continue;
    const start = m.index + m[1].length;
    const nameLen = exact ? m[3].length : trimmed.length;
    tokens.push({ start, end: start + 1 + nameLen, entry });
  }
  return tokens;
}

/** Every skill the text references, in first-appearance order, deduped by name. */
export function extractSkillReferences(
  text: string,
  catalog: SkillCatalogEntry[],
): SkillCatalogEntry[] {
  const found: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const token of findSkillReferenceTokens(text, catalog)) {
    if (seen.has(token.entry.name)) continue;
    seen.add(token.entry.name);
    found.push(token.entry);
  }
  return found;
}

// Default (empty) means the exporters emit nothing extra — hosts without the endpoint are
// byte-for-byte unchanged.
let exportCatalog: SkillCatalogEntry[] = [];

export function setSkillCatalogForExport(catalog: SkillCatalogEntry[]): void {
  exportCatalog = catalog;
}

export function resetSkillCatalogForExport(): void {
  exportCatalog = [];
}

export interface SkillExportContent {
  content: string;
  /** True when the server cut the body at its injection bound. */
  truncated: boolean;
  dir: string;
  path: string;
}

const exportContents = new Map<string, SkillExportContent>();

export function registerSkillContentForExport(name: string, content: SkillExportContent): void {
  exportContents.set(name, content);
}

export function resetSkillContentsForExport(): void {
  exportContents.clear();
}

const humanOnlyExportNote = (audience: SkillBlockAudience): string =>
  `human-invocation-only: you cannot invoke this skill; the ${audience.requester} included it as context`;

/**
 * The structural forms the injection block itself uses: the BEGIN/END markers (a skill's
 * instructions, and the Inbox's PLANNOTATOR NOTE after them) and the truncation notice.
 */
const MARKER_LOOKALIKE_RE =
  /^[\s>*_#`]*(?:[-=‐-―−]{2,}\s*(?:BEGIN|END)\s*(?:SKILL\s*INSTRUCTIONS|PLANNOTATOR\s*NOTE)\b|\[\s*Instructions\s*truncated\b)/i;

const INVISIBLE_FORMAT_CHARS_RE = /\p{Cf}/gu;

const NEUTRALIZED_LINE_PREFIX =
  '[plannotator: the following skill-body line matched an injection marker and was neutralized] ';

/**
 * Matching runs against the line with invisible format characters stripped, but the original
 * line is what is prefixed.
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

/**
 * Unmistakably delimited (BEGIN/END markers survive any markdown inside the body, unlike a
 * fence) and labeled so it can never read as the reviewer's own words.
 */
function injectedSkillSection(name: string, body: SkillExportContent, audience: SkillBlockAudience, builtin = false): string {
  let out = `--- BEGIN SKILL INSTRUCTIONS: ${name} ---\n`;
  if (builtin) {
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

/**
 * The export block for a comment's skill references, or '' when the comment references none (or
 * no catalog was registered). Never throws, never emits a partial block.
 */
export function skillReferenceExportBlock(
  text: string | undefined,
  injectedNames?: Set<string>,
  options?: { external?: boolean },
): string {
  if (!text) return '';
  const refs = extractSkillReferences(text, exportCatalog);
  return renderSkillReferencesBlock(refs, {
    contentOf: (name) => exportContents.get(name),
    injectedNames,
    external: options?.external,
  });
}

/** What `renderSkillReferencesBlock` needs besides the references themselves. */
export interface SkillReferencesBlockOptions {
  contentOf?: (name: string) => SkillExportContent | undefined;
  injectedNames?: Set<string>;
  external?: boolean;
  audience?: SkillBlockAudience;
}

/**
 * The block itself, for references a caller already resolved: the export above per comment, and
 * a host that composes ONE block per message (the Plannotator Inbox.
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
