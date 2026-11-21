/**
 * GFM footnotes: `text[^1]` references and `[^1]: note` definitions.
 *
 * The parser (`parseMarkdownToBlocks`) turns each definition of a note the
 * document cites into ONE 'paragraph' block tagged with `footnoteLabel`, its
 * `content` the definition as written (marker and continuation lines
 * included). A footnote-aware surface (the Viewer, RenderedMarkdown) calls
 * `indexFootnotes` and draws the definitions as a numbered list at the end,
 * and `InlineMarkdown` draws each reference to a defined note as a small
 * superscript link. A reference to a label nothing defines stays literal.
 *
 * A `[^label]:` line whose label nothing cites (`[^0-9]: digits` written as
 * prose) is not a note: it stays an ordinary paragraph where it is written.
 * A document with no cited note parses exactly as it did before footnotes
 * were drawn, and in one that has some every other block keeps its id.
 */
import type { Block } from '../types';
import { decodeHtmlEntities } from './inlineAutolinks';

/** A definition's first line: up to three spaces, `[^label]:`. */
export const FOOTNOTE_DEF_RE = /^ {0,3}\[\^([^\]\s]{1,64})\]:/;

/** A reference at the start of the text. */
export const FOOTNOTE_REF_RE = /^\[\^([^\]\s]{1,64})\]/;

/** Labels match without regard to case, as GFM's do. */
export const footnoteKey = (label: string): string => label.toLowerCase();

/** A continuation line of a definition: indented four spaces or a tab. */
export const FOOTNOTE_INDENTED_RE = /^(?: {4}|\t)/;

/**
 * A definition's own markdown: the marker taken off the first line and up to
 * four columns of indentation off the rest.
 */
export function footnoteBody(content: string): string {
  const lines = content.split('\n');
  lines[0] = lines[0].replace(FOOTNOTE_DEF_RE, '').replace(/^[ \t]+/, '');
  for (let i = 1; i < lines.length; i++) lines[i] = lines[i].replace(/^(?: {1,4}|\t)/, '');
  return lines.join('\n').trimEnd();
}

export interface FootnoteNote {
  /** `footnoteKey` of the label. */
  key: string;
  /** The number shown on the references and in the list, from 1. */
  number: number;
  /** The definition block (its id is the note's `data-block-id`). */
  block: Block;
  /** Whether a reference in the document's flow or another note names it (one
   *  that only cites itself does not; it is listed last, with no back link). */
  referenced: boolean;
}

export interface FootnoteIndex {
  /** The blocks to draw in the document's flow: everything but the definitions. */
  bodyBlocks: Block[];
  /** The notes in list order: by first reference, then the unreferenced ones as written. */
  notes: FootnoteNote[];
  /** Label key to number, for the references (the first definition of a label wins). */
  numbers: ReadonlyMap<string, number>;
}

const REF_SCAN = /\[\^([^\]\s]{1,64})\]/g;
const CODE_SPAN = /(`+)[\s\S]*?\1/g;

/** A link or image whose label is not itself a reference, one level of brackets deep: `[see [^1]](u)`. */
const LINK_SPAN = /!?\[(?!\^)(?:[^\[\]]|\[[^\[\]]*\])*\]\([^)]*\)/g;
/** A reference the way `InlineMarkdown` draws one: not escaped (`\[^1]` is text). */
const CITED_REF = /(?<!\\)\[\^([^\]\s]{1,64})\]/g;

/**
 * Labels cited in a block's text, in order: what `InlineMarkdown` draws as
 * a reference. Code spans, link and image labels (`[see [^1]](u)`),
 * escaped `\[^1]` and a definition's own marker are not citations.
 */
function referencedKeys(text: string, out: string[]): void {
  if (!text.includes('[^')) return;
  let prose = text.includes('`') ? text.replace(CODE_SPAN, '') : text;
  if (prose.includes('](')) prose = prose.replace(LINK_SPAN, ' ');
  for (const line of prose.split('\n')) {
    for (const m of line.replace(FOOTNOTE_DEF_RE, '').matchAll(CITED_REF)) out.push(footnoteKey(m[1]));
  }
}

const SCANNED_TYPES: ReadonlySet<Block['type']> = new Set(['paragraph', 'heading', 'blockquote', 'list-item', 'table', 'directive']);

/**
 * The labels (`footnoteKey`) of the `[^label]:` lines in a parse WITHOUT
 * notes (`blocks`, where every such line is paragraph text) that the
 * document also cites outside code: the ones the parser makes notes of.
 * Null when there is none, the usual case, which costs one `includes`.
 */
export function referencedDefinitionLabels(blocks: readonly Block[]): Set<string> | null {
  let defined: Set<string> | null = null;
  for (const block of blocks) {
    if (block.type !== 'paragraph' || !block.content.includes(']:')) continue;
    for (const line of block.content.split('\n')) {
      const m = FOOTNOTE_DEF_RE.exec(line);
      if (m) (defined ??= new Set()).add(footnoteKey(m[1]));
    }
  }
  if (!defined) return null;
  const cited: string[] = [];
  for (const block of blocks) if (SCANNED_TYPES.has(block.type)) referencedKeys(block.content, cited);
  const notes = new Set(cited.filter((key) => defined!.has(key)));
  return notes.size > 0 ? notes : null;
}

/**
 * The document's notes, or null when it defines none (then nothing about the
 * document's drawing changes). Numbers follow the first reference to each
 * note, as on GitHub. The parser makes notes only of cited labels; a note
 * cited from nowhere it could be reached (only from itself) is still listed,
 * last, so no written text disappears.
 */
export function indexFootnotes(blocks: readonly Block[]): FootnoteIndex | null {
  let defs: Block[] | null = null;
  for (const block of blocks) {
    if (block.footnoteLabel !== undefined) (defs ??= []).push(block);
  }
  if (!defs) return null;

  const firstDef = new Map<string, Block>();
  for (const def of defs) {
    const key = footnoteKey(def.footnoteLabel!);
    if (!firstDef.has(key)) firstDef.set(key, def);
  }

  const numbers = new Map<string, number>();
  const notes: FootnoteNote[] = [];
  const take = (keys: string[]) => {
    for (const key of keys) {
      const def = firstDef.get(key);
      if (!def || numbers.has(key)) continue;
      numbers.set(key, notes.length + 1);
      notes.push({ key, number: notes.length + 1, block: def, referenced: true });
    }
  };

  const bodyBlocks: Block[] = [];
  const keys: string[] = [];
  for (const block of blocks) {
    if (block.footnoteLabel !== undefined) continue;
    bodyBlocks.push(block);
    if (SCANNED_TYPES.has(block.type)) referencedKeys(block.content, keys);
  }
  take(keys);
  // A note may cite another note: those come next, in the order cited.
  for (let n = 0; n < notes.length; n++) {
    const nested: string[] = [];
    referencedKeys(footnoteBody(notes[n].block.content), nested);
    take(nested);
  }
  const listed = new Set(notes.map((note) => note.block));
  for (const def of defs) {
    if (listed.has(def)) continue;
    const key = footnoteKey(def.footnoteLabel!);
    notes.push({ key, number: notes.length + 1, block: def, referenced: false });
  }
  return { bodyBlocks, notes, numbers };
}

/**
 * The ways a saved quote may read on the page now, for the annotation
 * restore's text search (after the quote as written has missed):
 *
 * - A quote saved before references and character references were drawn
 *   holds them as written (`claim.[^1] and &amp;`). A reference is a
 *   superscript the quote leaves out (`annotation-exclude`), so it reads
 *   `claim. and &`.
 * - A quote that took a whole old definition paragraph starts a line with
 *   its marker (`[^1]: The note.`), which the notes list draws as the list's
 *   number, not text: also tried without it (`The note.`).
 *
 * `root` is the document; only labels it draws as references are dropped.
 * Returns the variants that differ from `quote`, most literal first.
 */
export function quoteVariantsAsRendered(quote: string, root: ParentNode): string[] {
  const drawn = new Set<string>();
  if (quote.includes('[^')) {
    for (const a of root.querySelectorAll('a[data-footnote-ref]')) drawn.add(footnoteKey(a.getAttribute('data-footnote-ref') ?? ''));
  }
  const render = (text: string): string => {
    let out = decodeHtmlEntities(text);
    if (drawn.size > 0) out = out.replace(REF_SCAN, (whole, label: string) => (drawn.has(footnoteKey(label)) ? '' : whole));
    return out;
  };
  const variants: string[] = [];
  const add = (text: string) => {
    if (text && text !== quote && !variants.includes(text)) variants.push(text);
  };
  add(render(quote));
  if (FOOTNOTE_DEF_RE.test(quote) || /\n {0,3}\[\^[^\]\s]{1,64}\]:/.test(quote)) {
    add(render(quote.split('\n').map((line) => line.replace(FOOTNOTE_DEF_RE, '').replace(/^[ \t]+/, '')).join('\n')).trim());
  }
  return variants;
}

/** The labels (`footnoteKey`) of a document's notes, or null when it has none. */
export function footnoteKeysOf(blocks: readonly { footnoteLabel?: string }[]): ReadonlySet<string> | null {
  let keys: Set<string> | null = null;
  for (const block of blocks) if (block.footnoteLabel !== undefined) (keys ??= new Set()).add(footnoteKey(block.footnoteLabel));
  return keys;
}

/**
 * Text without its references to the document's notes (`keys`): a heading's
 * slug, its line in the outline and the contents rail read `Title`, not
 * `Title[^1]`. A `[^x]` naming no note is text and stays.
 */
export function withoutFootnoteRefs(text: string, keys: ReadonlySet<string> | null): string {
  if (!keys || !text.includes('[^')) return text;
  return text.replace(REF_SCAN, (whole, label: string) => (keys.has(footnoteKey(label)) ? '' : whole));
}
