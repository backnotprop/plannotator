/**
 * A dragged box's Add to reply (owner approval 2026-11-05, q-3dcdec04 A): what goes into the reply to the board's
 * thread. The box's label (and, for several parts, the words inside it) as a quote line, then whatever was typed;
 * its picture as a file beside the words. The board itself stays as it was.
 */
import type { ShapeBoxSelection } from '@plannotator/ui/components/shape';

export interface ShapeReplyPart {
  /** The words the reply takes, after any it already holds. */
  words: string;
  /** The picture, or null when the box has none (What to know, a capture that failed). */
  file: File | null;
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** The reply's words for a box: "> Picture · 3 parts · “Google DuckDuckGo Bing”", a blank line, what was typed. */
export function shapeReplyWords(selection: Pick<ShapeBoxSelection, 'label' | 'parts' | 'words'>, text: string): string {
  const label = selection.label?.trim() ?? '';
  // One part's label already quotes its words; several parts' says only how many.
  const quoted = selection.parts.length > 1 && selection.words.trim() ? ` · “${clip(selection.words, 80)}”` : '';
  const head = label ? `> ${label}${quoted}` : '';
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

/** The reply's words with an added part's words taken out again (its Undo), wherever the person left them. */
export function withoutReplyWords(reply: string, words: string): string {
  if (!words) return reply;
  const at = reply.lastIndexOf(words);
  if (at < 0) return reply;
  const before = reply.slice(0, at).trimEnd();
  const after = reply.slice(at + words.length).trimStart();
  return before && after ? `${before}\n\n${after}` : before || after;
}
