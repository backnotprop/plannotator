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

export function sameListModel(held: object | null | undefined, next: object | null | undefined, options: { cursor: boolean }): boolean {
  if (held === next) return true;
  if (!held || !next) return false;
  const a = held as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'list_version' || key === 'agents' || (key === 'cursor' && !options.cursor)) continue;
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

export function keepSame<T>(held: T, next: T): T {
  return sameJson(held, next) ? held : next;
}
