/**
 * "Changed since you looked" (approval "inbox-pr-dashboard", q-6cf84c0b): the head commit of each PR the person last
 * opened in the PR page, by PR key. Kept as the PR page keeps its Viewed ticks, in the browser's storage: every window
 * of this browser shares it (a `storage` event reaches the others), another browser or computer keeps its own.
 *
 * A PR is changed since the person looked when it is open, the list names its head, and that head is not the one they
 * last opened. A PR never opened is not marked.
 */
import { useSyncExternalStore } from 'react';
import { inboxPullIsOpen, type InboxPull, type InboxPullStack } from '@plannotator/core/inbox-types';

const STORE = 'plannotator-inbox-pull-looked';
/** The newest this many PRs are kept. */
export const LOOKED_KEPT = 400;

export interface Looked {
  sha: string;
  /** When, in ms since the epoch. */
  at: number;
}
export type LookedMap = Readonly<Record<string, Looked>>;

const EMPTY: LookedMap = {};

/** A stored value as the map it holds; anything else is nothing kept. */
export function parseLooked(raw: string | null): LookedMap {
  try {
    const value = JSON.parse(raw ?? 'null') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;
    const out: Record<string, Looked> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const { sha, at } = (entry ?? {}) as { sha?: unknown; at?: unknown };
      if (typeof sha === 'string' && typeof at === 'number') out[key] = { sha, at };
    }
    return out;
  } catch {
    return EMPTY;
  }
}

/** The map with these PRs looked at now, the oldest dropped past `LOOKED_KEPT`. */
export function withLooked(map: LookedMap, seen: readonly { key: string; sha: string | null | undefined }[], now: number): LookedMap {
  const next: Record<string, Looked> = { ...map };
  for (const { key, sha } of seen) if (sha) next[key] = { sha: sha.toLowerCase(), at: now };
  const keys = Object.keys(next);
  if (keys.length <= LOOKED_KEPT) return next;
  for (const key of keys.sort((a, b) => next[a]!.at - next[b]!.at).slice(0, keys.length - LOOKED_KEPT)) delete next[key];
  return next;
}

/** The look a PR changed since: open, its head named and not the one last opened; null otherwise. */
export function changedSince(pull: Pick<InboxPull, 'key' | 'state' | 'head_sha'>, map: LookedMap): Looked | null {
  const was = map[pull.key];
  if (!was || !pull.head_sha || !inboxPullIsOpen(pull)) return null;
  return was.sha === pull.head_sha.toLowerCase() ? null : was;
}

/** A stack's layers that changed since the person looked. */
export function changedLayers(stack: Pick<InboxPullStack, 'layers'>, map: LookedMap): InboxPull[] {
  return stack.layers.filter((l) => changedSince(l, map));
}

let raw: string | null = null;
let cached: LookedMap = EMPTY;
const listeners = new Set<() => void>();

function read(): LookedMap {
  let now: string | null = null;
  try {
    now = window.localStorage.getItem(STORE);
  } catch {
    // Storage off: nothing kept.
  }
  if (now !== raw) {
    raw = now;
    cached = parseLooked(now);
  }
  return cached;
}

/** The person opened these PRs at these heads. */
export function markLooked(seen: readonly { key: string; sha: string | null | undefined }[]): void {
  if (!seen.some((s) => s.sha)) return;
  try {
    window.localStorage.setItem(STORE, JSON.stringify(withLooked(read(), seen, Date.now())));
  } catch {
    // Storage full or off: not remembered.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const fromAnother = (event: StorageEvent) => {
    if (event.key === null || event.key === STORE) listener();
  };
  window.addEventListener('storage', fromAnother);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', fromAnother);
  };
}

/** What the person last opened, kept current across this browser's windows. */
export function useLooked(): LookedMap {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

/** By PR key: the head this window's visit started at, and what the person had opened before it. */
const visits = new Map<string, { head: string; was: Looked | null }>();

/**
 * What the person had last opened before this visit to a PR at `head`, while that is another commit: the PR page
 * marks the PR looked as soon as its diff is read, and still offers what changed since, for as long as the head stays.
 */
export function lookedBefore(key: string, head: string | null | undefined): Looked | null {
  if (!head) return null;
  const visit = visits.get(key);
  if (visit && visit.head === head) return visit.was;
  const was = read()[key];
  const before = was && was.sha !== head.toLowerCase() ? was : null;
  visits.set(key, { head, was: before });
  return before;
}

/** Tests only. */
export function resetLookedVisits(): void {
  visits.clear();
  raw = null;
  cached = EMPTY;
}
