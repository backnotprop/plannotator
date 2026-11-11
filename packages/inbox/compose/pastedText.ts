import { pasteStamp } from './paste';

export const PASTE_TO_FILE_BYTES = 32 * 1024;

export const PASTED_UNDO_MS = 10_000;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Counted in UTF-8 bytes: one UTF-16 unit is 1 to 3 bytes, so only the middle range needs encoding. */
export function isLongPaste(text: string): boolean {
  if (text.length >= PASTE_TO_FILE_BYTES) return true;
  if (text.length * 3 < PASTE_TO_FILE_BYTES) return false;
  return utf8Bytes(text) >= PASTE_TO_FILE_BYTES;
}

export function pastedTextName(at: Date, taken: Iterable<string>): string {
  const names = new Set(taken);
  const stem = `pasted-text-${pasteStamp(at)}`;
  let name = `${stem}.txt`;
  for (let n = 2; names.has(name); n++) name = `${stem}-${n}.txt`;
  return name;
}

export function pastedPreview(text: string): string {
  const head = text.slice(0, 4096);
  for (const line of head.split(/\r\n|\r|\n/)) {
    const words = line.replace(/\s+/g, ' ').trim();
    if (words) return words.slice(0, 200);
  }
  return 'Pasted text';
}

/** A field's value never keeps a CR. */
export function boxText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export { mapAnchor } from '@plannotator/core/inbox-reply-draft';

export function putTextBack(value: string, at: number, text: string): { value: string; caret: number } {
  const place = Math.max(0, Math.min(at, value.length));
  return { value: value.slice(0, place) + text + value.slice(place), caret: place + text.length };
}
