/**
 * Skill references in comments — pure logic.
 *
 * A comment may reference agent skills by name with a `/` or `$` trigger
 * (interchangeable). References live in the comment TEXT itself (`$write-better`),
 * never as separate annotation state, so they survive draft restore, panel
 * edits, and share round-trips, and deleting the token deletes the reference.
 *
 * The catalog comes from `/api/skills` (see utils/skillCatalog.ts). This module
 * is browser-safe and dependency-free: trigger detection for the composer,
 * token extraction against a known catalog, and the export rendering hook the
 * feedback exporters call through a module-level registry seam
 * (`setSkillCatalogForExport`) whose default — an empty catalog — reproduces
 * pre-feature behavior byte-for-byte.
 */

import {
  renderSkillReferencesBlock,
  type SkillCatalogEntry,
  type SkillExportContent,
} from '@plannotator/core/skill-references-render';

export {
  neutralizeSkillMarkerLines,
  renderSkillReferencesBlock,
  type SkillCatalogEntry,
  type SkillExportContent,
  type SkillReferencesBlockOptions,
  type SkillRootId,
} from '@plannotator/core/skill-references-render';

export const SKILL_TRIGGER_CHARS = ['/', '$'] as const;
export type SkillTriggerChar = (typeof SKILL_TRIGGER_CHARS)[number];

/** Longest query the composer keeps treating as a skill lookup. */
export const MAX_SKILL_QUERY_LEN = 48;

/** Characters a skill name (and thus an in-progress query) may contain. */
const TOKEN_CHARS = /^[A-Za-z0-9._-]*$/;

export interface SkillTriggerContext {
  /** Index of the trigger character in the text. */
  start: number;
  trigger: SkillTriggerChar;
  /** Text between the trigger character and the caret. */
  query: string;
}

/**
 * The active skill trigger at `caret`, or null.
 *
 * A trigger is a `/` or `$` that starts a word: at position 0 or preceded by
 * whitespace or `(`. This is what keeps ordinary typing inert — `packages/ui`,
 * `and/or`, and `a/b` never trigger because their `/` follows a word character.
 * The query runs from the trigger to the caret and must stay within skill-name
 * characters, so typing a space (or any other breaking character) ends the
 * lookup naturally.
 *
 * A bare `/` or `$` (empty query) IS a trigger: it opens the full catalog,
 * matching how slash/skill menus behave in the host agents. The safety story
 * for a multi-line composer where Enter means newline and Tab means leave the
 * field lives in the MENU, not here: while the menu is open with NO row
 * explicitly activated (arrow keys), every key behaves exactly as if the menu
 * were closed — "This costs $" + Enter is a newline, "cd /" + Tab leaves the
 * field. See useSkillReferenceAutocomplete.
 */
export function findSkillTrigger(text: string, caret: number): SkillTriggerContext | null {
  if (caret < 1 || caret > text.length) return null;

  // Walk back over query characters to the nearest candidate trigger.
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
 * Filter the catalog for the picker: case-insensitive, name prefix matches
 * first, then name substring, then description substring. Stable within each
 * tier (catalog order is alphabetical from the server).
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
 * Well-known single-segment absolute paths (Filesystem Hierarchy Standard
 * roots). `/run`, `/tmp`, `/etc`… read as filesystem paths in prose, so a
 * `/`-triggered token with one of these names is never extracted as a skill
 * reference, even when a skill shares the name. `$name` remains fully
 * available for such skills, and menu insertion switches a `/` trigger to `$`
 * for them so an inserted reference always survives extraction.
 */
const RESERVED_PATH_SEGMENTS = new Set([
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'media', 'mnt', 'opt',
  'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var',
]);

/**
 * Words that, when they immediately precede a `/`-triggered token on the same
 * line, mark it as prose rather than a skill reference (reproduced false
 * positives against real review comments — see #1229 hardening):
 *
 * - HTTP method verbs: "a POST /agents endpoint", "a GET /show route" — the
 *   token reads as a route path.
 * - Modal auxiliaries: "this step could /simplify a lot" — a modal is
 *   followed by a bare verb, so the token reads as an emphasized verb, not a
 *   skill noun.
 *
 * Deliberately narrow: ordinary verbs ("use /write-better here") and
 * line-starting or post-newline tokens are untouched, `$name` is never
 * affected, and menu insertion switches `/` to `$` when the reference would
 * land after one of these words (see insertSkillReference), so an inserted
 * reference always survives extraction.
 */
const SLASH_PROSE_PRECEDING_WORDS = new Set([
  // HTTP method verbs
  'get', 'head', 'post', 'put', 'delete', 'options', 'patch',
  // Modal auxiliaries
  'can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would',
]);

const LONGEST_PROSE_PRECEDING_WORD = Math.max(...[...SLASH_PROSE_PRECEDING_WORDS].map((word) => word.length));

/** `[A-Za-z]`, by UTF-16 code unit as the regex it replaces read it. */
function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * True when the character run immediately before `triggerIndex` is same-line
 * whitespace preceded by one of SLASH_PROSE_PRECEDING_WORDS. A newline (or
 * any non-space boundary) between the word and the trigger breaks the pairing
 * — a line-starting `/name` always reads as deliberate.
 */
function slashTokenReadsAsProse(text: string, triggerIndex: number): boolean {
  // The rule is `/([A-Za-z]+)[ \t]+$/` on the text before the trigger, walked back from the trigger instead of run
  // over a copy of everything before it (that was a pass over the whole text for each `/name`, every key). The word
  // is the whole letter run before the spaces; one longer than any listed word cannot be listed, so the walk stops.
  let wordEnd = triggerIndex;
  while (wordEnd > 0 && (text[wordEnd - 1] === ' ' || text[wordEnd - 1] === '\t')) wordEnd--;
  if (wordEnd === triggerIndex) return false;
  let wordStart = wordEnd;
  while (wordStart > 0 && isAsciiLetter(text.charCodeAt(wordStart - 1))) {
    wordStart--;
    if (wordEnd - wordStart > LONGEST_PROSE_PRECEDING_WORD) return false;
  }
  return wordStart < wordEnd && SLASH_PROSE_PRECEDING_WORDS.has(text.slice(wordStart, wordEnd).toLowerCase());
}

/**
 * Replace the in-progress trigger token with the chosen skill (keeping the
 * trigger character the user typed) plus a trailing space, so the inserted
 * reference is always cleanly word-bounded. The exceptions to "keep the
 * typed trigger" all switch `/` to `$` because extraction would otherwise
 * drop the inserted reference:
 * - a skill whose name is a well-known absolute path segment (`run`, `tmp`…)
 *   — extraction reads `/run` as a path;
 * - a trigger immediately preceded by an HTTP verb or modal auxiliary
 *   ("could /simplify") — extraction reads that `/name` as prose (see
 *   SLASH_PROSE_PRECEDING_WORDS).
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
  /** Index of the trigger character. */
  start: number;
  /** Index just past the last name character (excludes trailing punctuation). */
  end: number;
  entry: SkillCatalogEntry;
}

/**
 * Every skill-reference occurrence in the text, in order, WITH positions and
 * without dedupe — this is what the composer's highlight overlay paints, so a
 * name referenced twice highlights twice.
 *
 * A reference is a word-starting `/name` or `$name` whose name matches a
 * catalog entry — an exact-case match wins, with case-insensitive matching as
 * a fallback so a catalog holding two skills differing only by case (e.g.
 * `Write-Better` and `write-better` from different roots) never swaps
 * identities on an explicit pick. Path and prose forms are excluded:
 * - followed by `/` or `\` — a path continuation (`/docs/foo`, `$HOME/bin`);
 * - preceded by `](` — a markdown link destination (`[x](/write-better)`);
 * - a `/` token naming a well-known absolute path segment (`/run`, `/tmp`) —
 *   see RESERVED_PATH_SEGMENTS; `$run` still counts;
 * - a `/` token immediately preceded on the same line by an HTTP verb or a
 *   modal auxiliary ("GET /show", "could /simplify") — see
 *   SLASH_PROSE_PRECEDING_WORDS; `$show` still counts.
 *
 * There is deliberately NO shell-redirect exclusion (`cat /run > out`): the
 * motivating case is already covered by the reserved-path rule, and excluding
 * on a following `<`/`>` produced false negatives on ordinary prose
 * ("use /animate <- this one", "quality: /write-better > everything else").
 */
export function findSkillReferenceTokens(
  text: string,
  catalog: SkillCatalogEntry[],
): SkillReferenceToken[] {
  if (!text || catalog.length === 0) return [];
  // Exact-case entries win; the lowercase map is only a fallback, so two
  // skills differing only by case never collapse into one identity (an
  // explicit `$Write-Better` must never resolve to `write-better` — wrong
  // skill, wrong humanOnly flag, wrong SKILL.md injected). First catalog
  // entry wins each fallback slot, matching discovery's first-seen precedence.
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
    // Markdown link destination: `[label](/name)` is a URL, not a reference.
    if (m[1] === '(' && text[m.index - 1] === ']') continue;
    // Sentence-final dots are punctuation, not part of the name ("use $humanizer.").
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

/**
 * Every skill the text references, in first-appearance order, deduped by name.
 * Same matching rules as findSkillReferenceTokens above.
 */
export function extractSkillReferences(
  text: string,
  catalog: SkillCatalogEntry[],
): SkillCatalogEntry[] {
  return uniqueSkillReferences(findSkillReferenceTokens(text, catalog));
}

/**
 * extractSkillReferences from tokens already found (findSkillReferenceTokens), so a caller that has both does not
 * scan the text twice.
 */
export function uniqueSkillReferences(tokens: readonly SkillReferenceToken[]): SkillCatalogEntry[] {
  const found: SkillCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token.entry.name)) continue;
    seen.add(token.entry.name);
    found.push(token.entry);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Export seam
// ---------------------------------------------------------------------------

// Module-level registry seam (see packages/ui/CLAUDE.md): the exporters in
// utils/parser.ts are pure and cannot fetch, so the app registers the fetched
// catalog here once per session. Default (empty) means the exporters emit
// nothing extra — hosts without the endpoint are byte-for-byte unchanged.
let exportCatalog: SkillCatalogEntry[] = [];

export function setSkillCatalogForExport(catalog: SkillCatalogEntry[]): void {
  exportCatalog = catalog;
}

export function resetSkillCatalogForExport(): void {
  exportCatalog = [];
}

// Companion registry to the export catalog: bodies of the human-only skills
// the session has referenced, fetched lazily. Default (empty) means human-only
// references fall back to naming the skill plus its directory.
const exportContents = new Map<string, SkillExportContent>();

export function registerSkillContentForExport(name: string, content: SkillExportContent): void {
  exportContents.set(name, content);
}

export function resetSkillContentsForExport(): void {
  exportContents.clear();
}

/**
 * The export block for a comment's skill references, or '' when the comment
 * references none (or no catalog was registered). Appended to the comment in
 * the exported feedback so the acting agent knows which skills to apply.
 *
 * Model-invocable skills export as names — the agent can fetch those itself.
 * Human-only skills cannot be invoked by the agent, so their SKILL.md body is
 * injected verbatim (when the session fetched it): a human referencing a
 * human-only skill IS the human invocation. When no body is available the
 * skill falls back to its name plus its directory, and to the plain context
 * note when not even the directory is known. Never throws, never emits a
 * partial block.
 *
 * `injectedNames` is an optional per-export dedupe: exporters thread one Set
 * through every comment of a single export so a skill's instructions are
 * injected once, and later references point at the earlier injection.
 *
 * `options.external` marks a comment that was NOT written by the reviewer in
 * this UI — it arrived through the unauthenticated external-annotations API
 * (annotations carrying a `source`), which any local process can post to.
 * The whole justification for injection is that a human referencing a
 * human-only skill IS the human invocation, so a tool-submitted comment must
 * never cause it: external comments still LIST their skill references, but a
 * human-only reference falls back to naming the skill plus its directory
 * (the same shape as the content-unavailable path) instead of injecting.
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
