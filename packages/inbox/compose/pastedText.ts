/**
 * Pasted text as an attachment (approval "inbox-paste-attachment", Option A,
 * 2026-11-02). A paste of 32 KB or more (UTF-8 bytes) becomes a tile, uploaded
 * as `pasted-text-<stamp>.txt` through the normal attachment path, so the
 * agent gets the usual `Attached:` line instead of the whole text in its turn.
 * Smaller pastes stay text, as before.
 *
 * The person can always put it back: the tile's Undo (its first 10 seconds),
 * then Put back in box, and the browser's own undo (`historyUndo`) as the very
 * next edit. Put back puts the exact text back where it was pasted, leaves the
 * words around it untouched, and leaves the caret after it. Where it was
 * pasted is kept as an offset into the box's text (the anchor), carried
 * through every later edit by `mapAnchor`.
 *
 * These are the pure rules; ComposeFiles.tsx does the paste, the tile and the
 * put back.
 */
import { pasteStamp } from './paste';

/** At this many UTF-8 bytes or more, a paste becomes a tile (the approval's threshold, as T3 Code's). */
export const PASTE_TO_FILE_BYTES = 32 * 1024;

/** How long the tile's line reads "Pasted text · Undo" before it reads its size. */
export const PASTED_UNDO_MS = 10_000;

/** The UTF-8 size of `text`, in bytes. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The paste is long enough to become a tile. Counted in UTF-8 bytes, not
 * characters: one UTF-16 unit is 1 to 3 bytes, so a text of 32 K units or more
 * always is, and one under a third of that never is; only the middle is encoded.
 */
export function isLongPaste(text: string): boolean {
  if (text.length >= PASTE_TO_FILE_BYTES) return true;
  if (text.length * 3 < PASTE_TO_FILE_BYTES) return false;
  return utf8Bytes(text) >= PASTE_TO_FILE_BYTES;
}

/** `pasted-text-2026-11-01-2256.txt` in the person's own time, `-2`, `-3` when that name is taken in this message. */
export function pastedTextName(at: Date, taken: Iterable<string>): string {
  const names = new Set(taken);
  const stem = `pasted-text-${pasteStamp(at)}`;
  let name = `${stem}.txt`;
  for (let n = 2; names.has(name); n++) name = `${stem}-${n}.txt`;
  return name;
}

/** What the tile shows as its name: the first line with words, its spaces collapsed (the tile cuts it with "…"). */
export function pastedPreview(text: string): string {
  // Only the head is read: the tile shows one line.
  const head = text.slice(0, 4096);
  for (const line of head.split(/\r\n|\r|\n/)) {
    const words = line.replace(/\s+/g, ' ').trim();
    if (words) return words.slice(0, 200);
  }
  return 'Pasted text';
}

/**
 * Where an anchor at `at` in `before` is in `after`, for one edit between them
 * (typing, a deletion, a paste, a replace). The edit is the span between the
 * texts' common start and common end. An anchor before it stays; one after it
 * moves by the change in length; one inside a deleted or replaced span goes to
 * that span's start. An insertion exactly at the anchor goes after the pasted
 * text's place (the anchor stays), so typing on at the caret after a paste
 * keeps the paste ahead of the new words, as a plain paste would.
 */
export function mapAnchor(before: string, after: string, at: number): number {
  if (before === after) return at;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end++;
  const removedEnd = before.length - end;
  if (at <= start) return at;
  if (at >= removedEnd) return at + (after.length - before.length);
  return start;
}

/** The box's text with `text` put back at `at` (clamped to the text), and the caret after it. */
export function putTextBack(value: string, at: number, text: string): { value: string; caret: number } {
  const place = Math.max(0, Math.min(at, value.length));
  return { value: value.slice(0, place) + text + value.slice(place), caret: place + text.length };
}
