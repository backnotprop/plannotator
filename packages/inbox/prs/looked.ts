/**
 * "Changed since you looked" (approval "inbox-pr-dashboard", q-6cf84c0b: "remembered per PR across windows and
 * machines"): the head commit of each PR the person last opened in the PR page, by PR key.
 *
 * It lives on the machine that lists the PR (server's inbox-pull-looked.ts), as the Board's look lives on its
 * project's machine: a look is sent there (a linked machine's PR through the forward, held while it sleeps), and every
 * window reads it back on the board (`looked` on each PR). The browser keeps a copy for at once and for a machine
 * too old to keep one (no `looked` on its `machines` entry): that copy is what such a PR is marked by, here only. A
 * look kept only in this browser, from before, or that did not reach its machine, is sent once when the board shows
 * it is newer than the machine's.
 *
 * A PR is changed since the person looked when it is open, the list names its head, and that head is not the one they
 * last opened. A PR never opened is not marked.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { inboxPullIsOpen, type InboxPull, type InboxPullsAnswer, type InboxPullStack } from '@plannotator/core/inbox-types';
import { post } from '../api';
import { inboxUrl } from '../inboxUrl';

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

/** This browser's copy with the board's looks: the newer look of each PR wins. */
export function mergeLooked(local: LookedMap, pulls: readonly Pick<InboxPull, 'key' | 'looked'>[]): LookedMap {
  let out: Record<string, Looked> | null = null;
  for (const pull of pulls) {
    const far = pull.looked;
    if (!far || (local[pull.key] && local[pull.key]!.at >= far.at)) continue;
    out ??= { ...local };
    out[pull.key] = { sha: far.sha, at: far.at };
  }
  return out ?? local;
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

type Board = Pick<InboxPullsAnswer, 'pulls' | 'machines'>;

/** Where each PR's look is kept: `''` this machine, a linked machine's id, or null for one too old to keep it. */
function keeperOf(board: Board | null, key: string): string | null {
  const machine = board?.pulls.find((pull) => pull.key === key)?.machine;
  if (!machine) return '';
  return board?.machines?.[machine]?.looked ? machine : null;
}

/** Looks sent this page load, `key sha`: each goes once, and again only for a new head. */
const sent = new Set<string>();

function send(board: Board | null, looks: readonly { key: string; sha: string; at: number }[]): void {
  const byKeeper = new Map<string, { key: string; sha: string; at: number }[]>();
  for (const look of looks) {
    const keeper = keeperOf(board, look.key);
    if (keeper === null || sent.has(`${look.key} ${look.sha}`)) continue;
    sent.add(`${look.key} ${look.sha}`);
    byKeeper.set(keeper, [...(byKeeper.get(keeper) ?? []), look]);
  }
  for (const [keeper, seen] of byKeeper) {
    // Not kept there (Code review off, asleep and held, refused): this browser's copy still marks it.
    void post(inboxUrl('/pulls/looked', undefined, keeper || null), { seen }).catch(() => {});
  }
}

/** The person opened these PRs at these heads: kept in this browser at once, and on the machine that lists each. */
export function markLooked(seen: readonly { key: string; sha: string | null | undefined }[], board: Board | null = null): void {
  if (!seen.some((s) => s.sha)) return;
  const now = Date.now();
  try {
    window.localStorage.setItem(STORE, JSON.stringify(withLooked(read(), seen, now)));
  } catch {
    // Storage full or off: the machine keeps it.
  }
  for (const listener of listeners) listener();
  send(board, seen.flatMap(({ key, sha }) => (sha ? [{ key, sha: sha.toLowerCase(), at: now }] : [])));
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

/**
 * What the person last opened, for the board's PRs: the machines' looks and this browser's copy, kept current across
 * this browser's windows. A look this browser holds newer than its machine's is sent there once.
 */
export function useLooked(board: Board | null): LookedMap {
  const local = useSyncExternalStore(subscribe, read, () => EMPTY);
  const pulls = board?.pulls;
  const map = useMemo(() => mergeLooked(local, pulls ?? []), [local, pulls]);
  useEffect(() => {
    if (!board) return;
    const behind = board.pulls.flatMap((pull) => {
      const mine = local[pull.key];
      return mine && (!pull.looked || pull.looked.at < mine.at) ? [{ key: pull.key, sha: mine.sha, at: mine.at }] : [];
    });
    if (behind.length > 0) send(board, behind);
  }, [board, local]);
  return map;
}

/** By PR key: the head this window's visit started at, and what the person had opened before it. */
const visits = new Map<string, { head: string; was: Looked | null }>();

/**
 * What the person had last opened before this visit to a PR at `head`, while that is another commit: the PR page
 * marks the PR looked as soon as its diff is read, and still offers what changed since, for as long as the head stays.
 */
export function lookedBefore(key: string, head: string | null | undefined, map: LookedMap): Looked | null {
  if (!head) return null;
  const visit = visits.get(key);
  if (visit && visit.head === head) return visit.was;
  const was = map[key];
  const before = was && was.sha !== head.toLowerCase() ? was : null;
  visits.set(key, { head, was: before });
  return before;
}

/** Tests only. */
export function resetLookedVisits(): void {
  visits.clear();
  sent.clear();
  raw = null;
  cached = EMPTY;
}
