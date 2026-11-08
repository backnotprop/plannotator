/**
 * A dragged box's Add to reply (owner approval 2026-11-05, q-3dcdec04 A): what goes into the reply to the board's
 * thread. The box's label (and, for several parts, the words inside it) as a quote line, then whatever was typed;
 * its picture as a file beside the words. The board itself stays as it was.
 */
import type { ShapeBoxSelection } from '@plannotator/ui/components/shape';

export interface ShapeReplyPart {
  /** The words the reply takes, after any it already holds. */
  words: string;
  /** The picture, or null when the box has none (a capture that failed). */
  file: File | null;
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

// A zero-width no-break space: the Inbox's markdown (InlineMarkdown) reads it as space, and nobody sees it.
const BREAK = '﻿';
/**
 * The board's words read as words in the reply, never as markup of the Inbox's markdown (InlineMarkdown): what it
 * lets a backslash escape gets one (code, links, emphasis, strikethrough, math, swatches and issue refs); what it
 * does not (an @mention, a bare or <auto> link, an HTML comment) gets the invisible break where its pattern starts.
 */
export const plainQuote = (text: string) =>
  text
    .replace(/[\\`*_~$[\]#]/g, (c) => `\\${c}`)
    .replace(/([@<])/g, `$1${BREAK}`)
    .replace(/:\/\//g, `:${BREAK}//`);
const plain = plainQuote;

/** The reply's words for a box: "> Picture · 3 parts · “Google DuckDuckGo Bing”", a blank line, what was typed. */
export function shapeReplyWords(selection: Pick<ShapeBoxSelection, 'label' | 'parts' | 'words'>, text: string): string {
  const label = selection.label?.trim() ?? '';
  // One part's label already quotes its words; several parts' says only how many.
  const quoted = selection.parts.length > 1 && selection.words.trim() ? ` · “${plain(clip(selection.words, 80))}”` : '';
  const head = label ? `> ${plain(label)}${quoted}` : '';
  const typed = text.trim();
  return head && typed ? `${head}\n\n${typed}` : head || typed;
}

/** The picture's file name: the parts it shows. */
export function shapeReplyFileName(selection: Pick<ShapeBoxSelection, 'parts' | 'view'>): string {
  const name = (selection.parts.join('-') || selection.view).replace(/[^\w.-]+/g, '-').slice(0, 60);
  return `${name || 'board'}.png`;
}

/** The part, once its picture is ready (a data: URL read into a file, never a request). */
export async function shapeReplyPart(selection: ShapeBoxSelection, text: string): Promise<ShapeReplyPart> {
  const words = shapeReplyWords(selection, text);
  const picture = await selection.picture.catch(() => null);
  if (!picture) return { words, file: null };
  const comma = picture.indexOf(',');
  const binary = atob(picture.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { words, file: new File([bytes], shapeReplyFileName(selection), { type: 'image/png' }) };
}

/** How many times the words already stand in the reply: the next press's are the next of them. */
export function replyWordsCount(reply: string, words: string): number {
  if (!words) return 0;
  let n = 0;
  for (let at = reply.indexOf(words); at >= 0; at = reply.indexOf(words, at + words.length)) n++;
  return n;
}

/**
 * The reply's words with an added part's words taken out again (its Undo): the `nth` time they stand there (0 the
 * first), which is that press's even when another press added the same words. Gone or changed: the reply as it is.
 */
export function withoutReplyWords(reply: string, words: string, nth = 0): string {
  if (!words) return reply;
  let at = reply.indexOf(words);
  for (let i = 0; i < nth && at >= 0; i++) at = reply.indexOf(words, at + words.length);
  if (at < 0) return reply;
  const before = reply.slice(0, at).trimEnd();
  const after = reply.slice(at + words.length).trimStart();
  return before && after ? `${before}\n\n${after}` : before || after;
}

/** A file's name, made "name-2.png", "name-3.png"… when the reply already holds one of that name. */
export function freeName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (taken.includes(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

/** The file under a name the reply doesn't hold yet, so a second press's picture sits beside the first. */
export function withFreeName(file: File, taken: readonly string[]): File {
  const name = freeName(file.name, taken);
  return name === file.name ? file : new File([file], name, { type: file.type });
}
