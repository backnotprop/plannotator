/**
 * GFM footnotes: `text[^1]` references and `[^1]: note` definitions.
 *
 * The parser (`parseMarkdownToBlocks`) turns each definition into ONE
 * 'paragraph' block tagged with `footnoteLabel`, its `content` the definition
 * as written (marker and indented continuation lines included). A surface
 * that does not know footnotes therefore draws exactly the text it always
 * drew. A footnote-aware surface (the Viewer, RenderedMarkdown) calls
 * `indexFootnotes` and draws the definitions as a numbered list at the end,
 * and `InlineMarkdown` draws each reference to a defined note as a small
 * superscript link. A reference to a label nothing defines stays literal.
 *
 * A document without a definition is untouched: the parser only acts on a
 * line that matches `FOOTNOTE_DEF_RE`, and `indexFootnotes` returns null.
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
const INDENTED = /^(?: {4}|\t)/;

/**
 * The index of a definition's last line. `startsBlock(j)` says whether an
 * unindented line would start a block of its own (a heading, a list, a fence,
 * another definition…); any other unindented text line right after the note
 * is a lazy continuation of its paragraph. After a blank line only indented
 * lines continue the note, so a note can hold several paragraphs, a list or a
 * fence, indented as GFM wants.
 */
export function footnoteDefinitionEnd(lines: readonly string[], i: number, startsBlock: (j: number) => boolean): number {
  let end = i;
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === '') {
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === '') k++;
      if (k < lines.length && INDENTED.test(lines[k])) {
        end = k;
        j = k + 1;
        continue;
      }
      break;
    }
    if (!INDENTED.test(line) && startsBlock(j)) break;
    end = j;
    j++;
  }
  return end;
}

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
  /** Whether any reference names it (a note nothing names has no back link). */
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

/** Labels referenced in a block's text, in order (code spans skipped). */
function referencedKeys(text: string, out: string[]): void {
  if (!text.includes('[^')) return;
  const prose = text.includes('`') ? text.replace(CODE_SPAN, '') : text;
  for (const m of prose.matchAll(REF_SCAN)) out.push(footnoteKey(m[1]));
}

const SCANNED_TYPES: ReadonlySet<Block['type']> = new Set(['paragraph', 'heading', 'blockquote', 'list-item', 'table', 'directive']);

/**
 * The document's notes, or null when it defines none (then nothing about the
 * document's drawing changes). Numbers follow the first reference to each
 * note, as on GitHub; a note nothing references is still listed (after the
 * others), so no written text disappears.
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
 * A quote saved before references and character references were drawn
 * (`text[^1] and &amp;`) as the page shows it now (`text1 and &`), so the
 * annotation restore's text search still finds it. `root` is the document;
 * each `[^label]` becomes the number its reference shows there, and a label
 * the document does not draw stays as written.
 */
export function quoteAsRendered(quote: string, root: ParentNode): string {
  let out = decodeHtmlEntities(quote);
  if (out.includes('[^')) {
    const shown = new Map<string, string>();
    for (const a of root.querySelectorAll('a[data-footnote-ref]')) {
      const key = footnoteKey(a.getAttribute('data-footnote-ref') ?? '');
      if (!shown.has(key)) shown.set(key, a.textContent ?? '');
    }
    if (shown.size > 0) out = out.replace(REF_SCAN, (whole, label: string) => shown.get(footnoteKey(label)) ?? whole);
  }
  return out;
}
