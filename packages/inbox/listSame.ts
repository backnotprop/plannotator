/**
 * Whether a list read shows nothing the list held does not: then the window
 * keeps the list it holds and draws nothing for that read.
 *
 * A record anywhere reads the list again, and the window's own saves do too
 * (each key typed in a question's "Other…" field is a save). Most of those
 * reads bring no row that changed, yet each one set a new list, which drew
 * the whole window again: the list, and the open thread with every message.
 *
 * Rows keep their objects from read to read (listRead.ts puts a change
 * together with the rows the window holds), so most rows compare by identity;
 * any other row, section or field compares by its JSON. `list_version` names
 * the read, not what it shows. `cursor` (the store's newest record) shows only
 * on Settings (the Archived count reads again when it moves): elsewhere a
 * read whose only change is the cursor is the same list.
 */
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const sameJson = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

function sameRows(a: readonly InboxListRow[] | undefined, b: readonly InboxListRow[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
  return true;
}

function sameSections(a: readonly InboxListSection[] | undefined, b: readonly InboxListSection[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left === right) continue;
    if (!sameRows(left.threads, right.threads)) return false;
    if (!sameJson({ ...left, threads: null }, { ...right, threads: null })) return false;
  }
  return true;
}

/** `cursor`: the store's cursor counts too (Settings is open). */
export function sameListModel(held: object | null | undefined, next: object | null | undefined, options: { cursor: boolean }): boolean {
  if (held === next) return true;
  if (!held || !next) return false;
  const a = held as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'list_version' || (key === 'cursor' && !options.cursor)) continue;
    const left = a[key];
    const right = b[key];
    if (left === right) continue;
    if (key === 'sections') {
      if (!sameSections(left as InboxListSection[] | undefined, right as InboxListSection[] | undefined)) return false;
    } else if (key === 'snoozed' || key === 'pins') {
      if (!sameRows(left as InboxListRow[] | undefined, right as InboxListRow[] | undefined)) return false;
    } else if (!sameJson(left, right)) return false;
  }
  return true;
}

/** `next`, or `held` when it is the same as JSON: a read that brought nothing new keeps the value drawn. */
export function keepSame<T>(held: T, next: T): T {
  return sameJson(held, next) ? held : next;
}
