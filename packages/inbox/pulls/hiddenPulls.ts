/**
 * Hide a pull request (the owner's ask, 2026-11-17: "dismiss PRs that need me without closing them … hide them from
 * my inbox … also the bulk action selector"). A hidden PR leaves Reviews, the PR board and every count drawn from
 * them (the sidebar's On you, the board's "need you"); nothing is done on the forge. The server keeps it
 * (`POST /api/inbox/pulls/hidden`, server's inbox-pull-hidden.ts) and leaves it out of both lists, listing it under
 * `hidden`, which Reviews' Hidden fold shows with Show again. It stays hidden until shown again or merged or closed.
 *
 * The window drops it at once (`pending`, applied by usePulls and useSheetPulls over each answer) and reads both lists
 * again from the server's cache once the write lands; an answer that already says so settles the pending change. A
 * write that fails puts the PR back. One toast with Undo, as the board's Close.
 */
import { useSyncExternalStore } from 'react';
import { inboxPullLabel, type InboxPull, type InboxPullHidden, type InboxPullsAnswer, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { inboxApi } from '../api';
import type { InboxToastModel } from '../components/Toast';
import { forgeName } from './labels';

/** A change made here that the lists may not show yet: hidden (with its record) or shown again; `since`, when (ms). */
export type HiddenChange = ({ hide: true; record: InboxPullHidden } | { hide: false }) & { since: number };
export type HiddenChanges = ReadonlyMap<string, HiddenChange>;

const NONE: HiddenChanges = new Map();
let pending: HiddenChanges = NONE;
const listeners = new Set<() => void>();
const reloaders = new Set<() => void>();

const setPending = (next: HiddenChanges) => {
  pending = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const read = () => pending;

/** Tests only: forget every change made here (each test starts with none). */
export function forgetHiddenChanges(): void {
  setPending(NONE);
}

/** The changes not yet in the lists, for a list to apply over its answer. */
export function useHiddenChanges(): HiddenChanges {
  return useSyncExternalStore(subscribe, read, read);
}

/** A list's way to read again (from the server's cache) once a hide or a show landed. */
export function onHiddenWritten(reload: () => void): () => void {
  reloaders.add(reload);
  return () => void reloaders.delete(reload);
}

/**
 * How long a change made here holds, whatever an answer says: both lists read again in that time, so one that hears
 * first never brings the PR back into the other for a moment.
 */
export const HIDDEN_SETTLE_MS = 10_000;

/** An answer came: a change it already shows is settled (an answer read before the write landed settles nothing). */
export function settleHidden(hidden: readonly InboxPullHidden[] | undefined, now = Date.now()): void {
  if (!hidden || pending.size === 0) return;
  const keys = new Set(hidden.map((h) => h.key));
  const next = new Map([...pending].filter(([key, change]) => now - change.since < HIDDEN_SETTLE_MS || (change.hide ? !keys.has(key) : keys.has(key))));
  if (next.size !== pending.size) setPending(next.size === 0 ? NONE : next);
}

/** The hidden list with the changes made here: the newest first. */
export function hiddenWith(hidden: readonly InboxPullHidden[] | undefined, changes: HiddenChanges): InboxPullHidden[] {
  const kept = (hidden ?? []).filter((h) => !changes.has(h.key));
  const added = [...changes.values()].flatMap((change) => (change.hide ? [change.record] : []));
  return [...added, ...kept].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

const hiddenHere = (changes: HiddenChanges) => (key: string) => changes.get(key)?.hide === true;

/** The PR list without the PRs hidden here. */
export function pullsShown(answer: InboxPullsAnswer | null, changes: HiddenChanges): InboxPullsAnswer | null {
  if (!answer || changes.size === 0) return answer;
  const hidden = hiddenHere(changes);
  return { ...answer, pulls: answer.pulls.filter((pull) => !hidden(pull.key)), hidden: hiddenWith(answer.hidden, changes) };
}

/**
 * Reviews' rows without the PRs hidden here: a row whose PRs are all hidden goes; a stack's row loses only the hidden
 * layers (the server's next answer draws the stack again from what is left).
 */
export function reviewsShown(answer: InboxReviewsAnswer | null, changes: HiddenChanges): InboxReviewsAnswer | null {
  if (!answer || changes.size === 0) return answer;
  const hidden = hiddenHere(changes);
  const rows = answer.rows.flatMap((row) => {
    if (!row.pull_keys.some(hidden)) return [row];
    const left = row.pull_keys.filter((key) => !hidden(key));
    if (left.length === 0) return [];
    return [{ ...row, pull_keys: left, stacks: row.stacks.map((stack) => ({ ...stack, layers: stack.layers.filter((layer) => !hidden(layer.key)) })).filter((stack) => stack.layers.length > 0) }];
  });
  return { ...answer, rows, hidden: hiddenWith(answer.hidden, changes) };
}

const written = () => {
  for (const reload of reloaders) reload();
};

function change(keys: readonly string[], to: (key: string) => HiddenChange): HiddenChanges {
  const was = pending;
  const next = new Map(pending);
  for (const key of keys) next.set(key, to(key));
  setPending(next);
  return was;
}

function putBack(keys: readonly string[], was: HiddenChanges) {
  const next = new Map(pending);
  for (const key of keys) {
    const before = was.get(key);
    if (before) next.set(key, before);
    else next.delete(key);
  }
  setPending(next.size === 0 ? NONE : next);
}

type HidePick = Pick<InboxPull, 'key' | 'title' | 'url'>;

/** Hide these PRs: gone from the lists at once; a refused write puts them back and throws. */
export async function hidePulls(pulls: readonly HidePick[], now = new Date()): Promise<void> {
  if (pulls.length === 0) return;
  const at = now.toISOString();
  const keys = pulls.map((pull) => pull.key);
  const byKey = new Map(pulls.map((pull) => [pull.key, pull]));
  const was = change(keys, (key) => ({ hide: true, record: { key, title: byKey.get(key)!.title, url: byKey.get(key)!.url, at }, since: now.getTime() }));
  try {
    await inboxApi.pullsHidden({ hide: pulls.map(({ key, title, url }) => ({ key, title, url })) });
  } catch (cause) {
    putBack(keys, was);
    throw cause;
  }
  written();
}

/** Show these PRs again: back on the next read. A refused write puts them back in Hidden and throws. */
export async function showPulls(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const was = change(keys, () => ({ hide: false, since: Date.now() }));
  try {
    await inboxApi.pullsHidden({ show: keys });
  } catch (cause) {
    putBack(keys, was);
    throw cause;
  }
  written();
}

/** "Hid #12" for one, "Hid 3 pull requests" for several. */
export function hidToast(pulls: readonly Pick<InboxPull, 'number' | 'platform'>[]): string {
  return pulls.length === 1 ? `Hid ${inboxPullLabel(pulls[0]!)}` : `Hid ${formatCount(pulls.length)} pull requests`;
}

/** "Showing #12 again", "Showing 3 again". */
export function shownToast(labels: readonly string[]): string {
  return labels.length === 1 ? `Showing ${labels[0]} again` : `Showing ${formatCount(labels.length)} again`;
}

/** The PR's label from its key (`host/owner/repo#12`, a GitLab merge request's `…#12:pull`): "#12" or "!12". */
export function hiddenLabel(hidden: Pick<InboxPullHidden, 'key'>): string {
  const match = /#(\d+)(:pull)?$/.exec(hidden.key);
  return match ? `${match[2] ? '!' : '#'}${match[1]}` : hidden.key;
}

/** Its repository from its key: `owner/repo` (without github.com), else `host/owner/repo`. */
export function hiddenRepo(hidden: Pick<InboxPullHidden, 'key'>): string {
  const path = hidden.key.replace(/#\d+(?::pull)?$/, '');
  return path.startsWith('github.com/') ? path.slice('github.com/'.length) : path;
}

type Toast = (toast: Omit<InboxToastModel, 'id'>, ms: number) => void;

/** How long the toast, and so its Undo, stays: the board's Close's. */
export const HIDE_UNDO_MS = 8_000;

/**
 * Hide, then the one toast with Undo (its button only, as the board's Close). Undo shows exactly those again. A refusal
 * is a warning toast in the server's words. Resolves true when they were hidden.
 */
export async function hideWithUndo(pulls: readonly InboxPull[], toast: Toast | undefined): Promise<boolean> {
  try {
    await hidePulls(pulls);
  } catch (cause) {
    toast?.({ icon: 'warn', lead: 'Couldn’t hide', detail: cause instanceof Error ? cause.message : undefined, wrap: true }, HIDE_UNDO_MS);
    return false;
  }
  const keys = pulls.map((pull) => pull.key);
  const labels = pulls.map(inboxPullLabel);
  toast?.(
    {
      icon: 'check',
      lead: hidToast(pulls),
      detail: `Still open on ${new Set(pulls.map((pull) => pull.platform)).size === 1 ? forgeName(pulls[0]!) : 'GitHub and GitLab'}`,
      onUndo: () => void showWithToast(keys, labels, toast),
      noKey: true,
    },
    HIDE_UNDO_MS,
  );
  return true;
}

/** Show again (Hidden's button, or Undo), with its toast. */
export async function showWithToast(keys: readonly string[], labels: readonly string[], toast: Toast | undefined): Promise<void> {
  try {
    await showPulls(keys);
  } catch (cause) {
    toast?.({ icon: 'warn', lead: 'Couldn’t show it again', detail: cause instanceof Error ? cause.message : undefined, wrap: true }, HIDE_UNDO_MS);
    return;
  }
  toast?.({ icon: 'check', lead: shownToast(labels) }, HIDE_UNDO_MS);
}
