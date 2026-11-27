/**
 * Hide a pull request (the owner's ask, 2026-11-17: "dismiss PRs that need me without closing them … hide them from
 * my inbox … also the bulk action selector"). A hidden PR leaves Reviews, the PR board and every count drawn from
 * them (the sidebar's On you, the board's "need you"); a thread whose open PRs are all hidden leaves the Inbox list
 * and its counts (the server's list model). Nothing is done on the forge. The server keeps it
 * (`POST /api/inbox/pulls/hidden`, server's inbox-pull-hidden.ts) and leaves it out of the lists, listing it under
 * `hidden`, which Reviews' Hidden fold shows with Show again. It stays hidden until shown again or merged or closed.
 *
 * The window drops it at once (`pending`, applied by usePulls and useSheetPulls over each answer) and reads the lists
 * again once the write lands; an answer that already says so settles the pending change. A write that fails puts the
 * PR back. One toast with Undo, as the board's Close.
 */
import { useSyncExternalStore } from 'react';
import { inboxPullLabel, inboxPullRepoOfKey, type InboxPull, type InboxPullHidden, type InboxPullsAnswer, type InboxRepoHidden, type InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { pullInProject } from './model';
import { post } from '../api';
import { inboxUrl } from '../inboxUrl';
import type { InboxToastModel } from '../components/Toast';
import { forgeName } from './labels';
import { rowInSlot } from '../settle';

/**
 * A change made here that the lists may not show yet: hidden (with its record) or shown again; `since`, when (ms). A
 * repository's change is keyed `repo:<repo key>` (`repoChangeKey`) and carries its record as `repo`.
 */
export type HiddenChange = ({ hide: true; record: InboxPullHidden } | { hide: true; repo: InboxRepoHidden } | { hide: false }) & { since: number };

/** A repository's change's key in the changes made here. */
export const repoChangeKey = (repoKey: string) => `repo:${repoKey}`;
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

/** The changes not yet in the lists, now (outside React). */
export function hiddenChangesNow(): HiddenChanges {
  return pending;
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

const backListeners = new Set<(threadIds: readonly string[]) => void>();

/**
 * Inbox threads a write made here brought back into the Inbox list (Undo of a Hide, Show again): the window puts them
 * back in place at once, as its own write, never behind "N new" (App's `afterWrite`).
 */
export function onThreadsBack(listener: (threadIds: readonly string[]) => void): () => void {
  backListeners.add(listener);
  return () => void backListeners.delete(listener);
}

const threadsBack = (ids: readonly string[]) => {
  if (ids.length === 0) return;
  for (const listener of backListeners) listener(ids);
};

/**
 * How long a change made here holds, whatever an answer says: both lists read again in that time, so one that hears
 * first never brings the PR back into the other for a moment.
 */
export const HIDDEN_SETTLE_MS = 10_000;
/**
 * After this long the server's answer is taken as it is, even when it disagrees (the PR merged meanwhile, so its
 * record went): a change made here never holds for the rest of the session.
 */
export const HIDDEN_GIVE_UP_MS = 60_000;

/** An answer came: a change it already shows is settled (an answer read before the write landed settles nothing). */
export function settleHidden(hidden: readonly InboxPullHidden[] | undefined, now = Date.now(), repos?: readonly InboxRepoHidden[]): void {
  if (!hidden || pending.size === 0) return;
  const keys = new Set([...hidden.map((h) => h.key), ...(repos ?? []).map((r) => repoChangeKey(r.key))]);
  const holds = (key: string, change: HiddenChange) => {
    const age = now - change.since;
    if (age < HIDDEN_SETTLE_MS) return true;
    if (age >= HIDDEN_GIVE_UP_MS) return false;
    return change.hide ? !keys.has(key) : keys.has(key);
  };
  const next = new Map([...pending].filter(([key, change]) => holds(key, change)));
  if (next.size !== pending.size) setPending(next.size === 0 ? NONE : next);
}

/** The hidden list with the changes made here: the newest first. */
export function hiddenWith(hidden: readonly InboxPullHidden[] | undefined, changes: HiddenChanges): InboxPullHidden[] {
  const kept = (hidden ?? []).filter((h) => !changes.has(h.key));
  const added = [...changes.values()].flatMap((change) => (change.hide && 'record' in change ? [change.record] : []));
  return [...added, ...kept].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The hidden repositories with the changes made here: the newest first. */
export function reposWith(repos: readonly InboxRepoHidden[] | undefined, changes: HiddenChanges): InboxRepoHidden[] {
  const kept = (repos ?? []).filter((r) => !changes.has(repoChangeKey(r.key)));
  const added = [...changes.values()].flatMap((change) => (change.hide && 'repo' in change ? [change.repo] : []));
  return [...added, ...kept].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** A PR hidden here: itself, or its repository. */
const hiddenHere = (changes: HiddenChanges) => (key: string) => changes.get(key)?.hide === true || changes.get(repoChangeKey(inboxPullRepoOfKey(key)))?.hide === true;

/** The PR list without the PRs hidden here. */
export function pullsShown(answer: InboxPullsAnswer | null, changes: HiddenChanges): InboxPullsAnswer | null {
  if (!answer || changes.size === 0) return answer;
  const hidden = hiddenHere(changes);
  return { ...answer, pulls: answer.pulls.filter((pull) => !hidden(pull.key)), hidden: hiddenWith(answer.hidden, changes), hidden_repos: reposWith(answer.hidden_repos, changes) };
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
  return { ...answer, rows, hidden: hiddenWith(answer.hidden, changes), hidden_repos: reposWith(answer.hidden_repos, changes) };
}

const written = () => {
  for (const reload of reloaders) reload();
};

/** Another window (or a read that saw a hidden PR merged) changed what is hidden: the lists read again. */
export function hiddenChangedElsewhere(): void {
  written();
}

/** The server takes this many at once (its PULL_HIDDEN_MAX): more go in parts, one after another. */
export const HIDE_AT_ONCE = 200;

const inParts = <T,>(items: readonly T[]): T[][] => {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += HIDE_AT_ONCE) parts.push(items.slice(i, i + HIDE_AT_ONCE));
  return parts;
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

/**
 * Hide these PRs: gone from the lists at once; a refused write puts them back and throws. Resolves how many Inbox
 * threads left the list with them (a thread whose PRs are now all hidden).
 */
export async function hidePulls(pulls: readonly HidePick[], now = new Date()): Promise<number> {
  if (pulls.length === 0) return 0;
  const at = now.toISOString();
  const keys = pulls.map((pull) => pull.key);
  const byKey = new Map(pulls.map((pull) => [pull.key, pull]));
  const was = change(keys, (key) => ({ hide: true, record: { key, title: byKey.get(key)!.title, url: byKey.get(key)!.url, at }, since: now.getTime() }));
  const left = new Set<string>();
  let applied = 0;
  try {
    for (const part of inParts(pulls)) {
      const answer = await writeHidden({ hide: part.map(({ key, title, url }) => ({ key, title, url })) });
      applied += part.length;
      for (const id of answer.threads_left ?? []) left.add(id);
    }
  } catch (cause) {
    putBack(keys.slice(applied), was);
    if (applied > 0) written();
    throw cause;
  }
  written();
  return left.size;
}

/** Show these PRs again: back on the next read. A refused write puts them back in Hidden and throws. */
export async function showPulls(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const was = change(keys, () => ({ hide: false, since: Date.now() }));
  const back: string[] = [];
  let applied = 0;
  try {
    for (const part of inParts(keys)) {
      back.push(...((await writeHidden({ show: part })).threads_back ?? []));
      applied += part.length;
    }
  } catch (cause) {
    putBack(keys.slice(applied), was);
    if (applied > 0) {
      written();
      threadsBack(back);
    }
    throw cause;
  }
  written();
  threadsBack(back);
}

/**
 * Hide the open PRs of these Inbox threads (the list's row menu and picks): the server names them (`hid`), and the
 * lists drop them at once. Resolves the keys it hid; a refused write throws.
 */
export async function hideThreadPulls(threadIds: readonly string[], now = new Date()): Promise<{ hid: string[]; rehid: string[]; left: number }> {
  const hid: string[] = [];
  const rehid: string[] = [];
  const left = new Set<string>();
  const records = new Map<string, InboxPullHidden>();
  for (const part of inParts(threadIds)) {
    const answer = await writeHidden({ threads: part });
    hid.push(...(answer.hid ?? []));
    rehid.push(...(answer.rehid ?? []));
    for (const id of answer.threads_left ?? []) left.add(id);
    for (const record of answer.hidden) records.set(record.key, record);
  }
  if (hid.length > 0) change(hid, (key) => ({ hide: true, record: records.get(key) ?? { key, title: key, url: '', at: now.toISOString() }, since: now.getTime() }));
  written();
  return { hid, rehid, left: left.size };
}

/** Undo of the Inbox list's Hide: its PRs shown again, and the threads it hid again (`rehid`) let back. */
async function undoThreadHide(hid: readonly string[], rehid: readonly string[]): Promise<void> {
  await showPulls(hid);
  const back: string[] = [];
  for (const part of inParts(rehid)) back.push(...((await writeHidden({ show_threads: part })).threads_back ?? []));
  if (rehid.length > 0) written();
  threadsBack(back);
}

/**
 * A Hide's lead: "Hid #12", and the threads it took out of the Inbox list with it: "with its thread" for one PR,
 * "with their thread" for several, "with 2 threads".
 */
export function hidLead(what: string, threads: number, pulls = 1): string {
  if (threads === 0) return what;
  return threads === 1 ? `${what}, with ${pulls === 1 ? 'its' : 'their'} thread` : `${what}, with ${plural(threads, 'thread')}`;
}

/**
 * The hidden PRs and repositories Reviews' Hidden fold lists under its project filter, by Reviews' own project rule
 * (model.ts `pullInProject`): of a repository that is a clone of the project, or, for a PR from a fork, whose head
 * repository is (`head_repo`, kept at hide time; a record from before has none). A PR's key is `host/owner/repo#n`, a
 * repository's `host/owner/repo`. No filter: all of them.
 */
export function hiddenInProject<T extends { key: string; head_repo?: string }>(hidden: readonly T[], project: string | null, projects: Readonly<Record<string, readonly string[]>>): T[] {
  if (!project) return [...hidden];
  return hidden.filter((h) => {
    const repo = inboxPullRepoOfKey(h.key);
    const slash = repo.indexOf('/');
    return pullInProject({ host: repo.slice(0, slash), repo: repo.slice(slash + 1), head_repo: h.head_repo ?? null }, project, projects);
  });
}

/**
 * Hide a repository (the board's Hide repository): every PR in it leaves the board and Reviews at once, new ones too.
 * It never takes a thread out of the Inbox list. A refused write puts it back and throws.
 */
export async function hideRepo(repo: Pick<InboxRepoHidden, 'key' | 'label'>, now = new Date()): Promise<void> {
  const key = repoChangeKey(repo.key);
  const was = change([key], () => ({ hide: true, repo: { key: repo.key, label: repo.label, at: now.toISOString() }, since: now.getTime() }));
  try {
    await writeHidden({ hide_repos: [{ key: repo.key, label: repo.label }] });
  } catch (cause) {
    putBack([key], was);
    throw cause;
  }
  written();
}

/** Show a repository again: its PRs are back on the next read. A refused write puts it back in Hidden and throws. */
export async function showRepo(repoKey: string): Promise<void> {
  const key = repoChangeKey(repoKey);
  const was = change([key], () => ({ hide: false, since: Date.now() }));
  try {
    await writeHidden({ show_repos: [repoKey] });
  } catch (cause) {
    putBack([key], was);
    throw cause;
  }
  written();
}

/** "Hid #12" for one, "Hid 3 pull requests" for several. */
export function hidToast(pulls: readonly Pick<InboxPull, 'number' | 'platform'>[]): string {
  return pulls.length === 1 ? `Hid ${inboxPullLabel(pulls[0]!)}` : `Hid ${formatCount(pulls.length)} pull requests`;
}

/** The Inbox list's Hide item: "Hide pull request", "Hide merge request" (GitLab), "Hide 3 pull requests". */
export function hideKeysWords(keys: readonly string[]): string {
  const noun = keys.length > 0 && keys.every((key) => key.endsWith(':pull')) ? 'merge request' : 'pull request';
  return keys.length === 1 ? `Hide ${noun}` : `Hide ${formatCount(keys.length)} ${noun}s`;
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

/** Hide PRs from Reviews, the board and their counts, or show them again (`POST /api/inbox/pulls/hidden`): kept on this machine, nothing goes to the forge. */
const writeHidden = (change: { hide?: readonly { key: string; title: string; url: string }[]; threads?: readonly string[]; show?: readonly string[]; show_threads?: readonly string[]; hide_repos?: readonly { key: string; label: string }[]; show_repos?: readonly string[] }) =>
  post<{ hidden: InboxPullHidden[]; hidden_repos?: InboxRepoHidden[]; hid?: string[]; rehid?: string[]; threads_left?: string[]; threads_back?: string[] }>(inboxUrl('/pulls/hidden'), {
    hide: [...(change.hide ?? [])],
    threads: [...(change.threads ?? [])],
    show: [...(change.show ?? [])],
    ...(change.show_threads ? { show_threads: [...change.show_threads] } : {}),
    ...(change.hide_repos ? { hide_repos: [...change.hide_repos] } : {}),
    ...(change.show_repos ? { show_repos: [...change.show_repos] } : {}),
  });

export type Toast = (toast: Omit<InboxToastModel, 'id'>, ms: number) => void;

/** How long the toast, and so its Undo, stays: the board's Close's. */
export const HIDE_UNDO_MS = 8_000;

/**
 * Hide, then the one toast with Undo (its button only, as the board's Close). Undo shows exactly those again. A refusal
 * is a warning toast in the server's words. Resolves true when they were hidden.
 */
export async function hideWithUndo(pulls: readonly InboxPull[], toast: Toast | undefined): Promise<boolean> {
  let threads: number;
  try {
    threads = await hidePulls(pulls);
  } catch (cause) {
    toast?.({ icon: 'warn', lead: 'Couldn’t hide', detail: cause instanceof Error ? cause.message : undefined, wrap: true }, HIDE_UNDO_MS);
    return false;
  }
  const keys = pulls.map((pull) => pull.key);
  const labels = pulls.map(inboxPullLabel);
  toast?.(
    {
      icon: 'check',
      lead: hidLead(hidToast(pulls), threads, pulls.length),
      detail: `Still open on ${new Set(pulls.map((pull) => pull.platform)).size === 1 ? forgeName(pulls[0]!) : 'GitHub and GitLab'}`,
      onUndo: () => void showWithToast(keys, labels, toast),
      noKey: true,
    },
    HIDE_UNDO_MS,
  );
  return true;
}

/** Where a hidden PR is still open, from its keys: "GitHub", "GitLab" or both. */
function stillOpenOn(keys: readonly string[]): string {
  const gitlab = keys.filter((key) => key.endsWith(':pull')).length;
  return gitlab === 0 ? 'GitHub' : gitlab === keys.length ? 'GitLab' : 'GitHub and GitLab';
}

/**
 * The Inbox list's Hide (a row's menu, or the picks): its open PRs hidden, the one toast with Undo, which shows exactly
 * those again. Resolves true when any were hidden.
 */
export async function hideThreadsWithUndo(threadIds: readonly string[], toast: Toast | undefined): Promise<boolean> {
  let hid: string[];
  let rehid: string[];
  let threads: number;
  try {
    ({ hid, rehid, left: threads } = await hideThreadPulls(threadIds));
  } catch (cause) {
    toast?.({ icon: 'warn', lead: 'Couldn’t hide', detail: cause instanceof Error ? cause.message : undefined, wrap: true }, HIDE_UNDO_MS);
    return false;
  }
  if (hid.length === 0 && rehid.length === 0) {
    // Hidden elsewhere meanwhile (another window, a phone): say so, rather than nothing at all.
    toast?.({ icon: 'check', lead: 'Already hidden', detail: 'Its pull requests were hidden already.' }, HIDE_UNDO_MS);
    return false;
  }
  const labels = hid.map((key) => hiddenLabel({ key }));
  // Only threads hidden again (their PRs were hidden already): the toast names the threads.
  const lead =
    hid.length > 0
      ? hidLead(hid.length === 1 ? `Hid ${labels[0]}` : `Hid ${formatCount(hid.length)} pull requests`, threads, hid.length)
      : rehid.length === 1
        ? 'Hid the thread again'
        : `Hid ${formatCount(rehid.length)} threads again`;
  toast?.(
    {
      icon: 'check',
      lead,
      detail: hid.length > 0 ? `Still open on ${stillOpenOn(hid)}` : 'Its pull requests were hidden already',
      onUndo: () =>
        void undoThreadHide(hid, rehid).then(
          () => toast?.({ icon: 'check', lead: hid.length > 0 ? shownToast(labels) : rehid.length === 1 ? 'The thread is back' : `${formatCount(rehid.length)} threads are back` }, HIDE_UNDO_MS),
          (cause: unknown) => toast?.({ icon: 'warn', lead: 'Couldn’t show it again', detail: cause instanceof Error ? cause.message : undefined, wrap: true }, HIDE_UNDO_MS),
        ),
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

/** How many frames focus waits for a hidden item to leave the screen before it gives up (a refused write keeps it). */
const LEAVE_FRAMES = 30;

/**
 * Focus after Hide or Show again takes an item off the screen (the board's tile, a Reviews row, a Hidden row): once it
 * has left, and only if focus fell to the page with it, the item now in its slot takes focus, else `fallback`. Call it
 * before the change. `items`: the items on screen in order, each with its id.
 */
export function focusWhenGone(items: () => readonly { id: string; el: HTMLElement }[], gone: string, fallback: () => HTMLElement | null = () => null): void {
  const order = items().map((item) => item.id);
  let frames = 0;
  const step = () => {
    const now = new Map(items().map((item) => [item.id, item.el] as const));
    if (now.has(gone)) {
      if (frames++ < LEAVE_FRAMES) requestAnimationFrame(step);
      return;
    }
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const next = rowInSlot(order, gone, (id) => now.has(id));
    (next ? now.get(next)! : fallback())?.focus({ preventScroll: true });
  };
  requestAnimationFrame(step);
}

/** The items under `root` that carry `attr`, in order, by its value. */
export function itemsBy(root: () => ParentNode | null, attr: string): () => { id: string; el: HTMLElement }[] {
  return () => [...(root()?.querySelectorAll<HTMLElement>(`[${attr}]`) ?? [])].map((el) => ({ id: el.getAttribute(attr) ?? '', el }));
}

/**
 * Hide repository (the board's section header), with its one toast and Undo (its button only), which shows the
 * repository again. Resolves true when it was hidden.
 */
export async function hideRepoWithUndo(repo: Pick<InboxRepoHidden, 'key' | 'label'> & Pick<InboxPull, 'platform'>, toast: Toast | undefined): Promise<boolean> {
  try {
    await hideRepo({ key: repo.key, label: repo.label });
  } catch (cause) {
    toast?.({ icon: 'warn', lead: 'Couldn’t hide', detail: cause instanceof Error ? cause.message : undefined, wrap: true }, HIDE_UNDO_MS);
    return false;
  }
  toast?.(
    {
      icon: 'check',
      lead: `Hid ${repo.label}`,
      detail: `New pull requests there stay hidden too · Still open on ${forgeName(repo)}`,
      onUndo: () => void showRepoWithToast({ key: repo.key, label: repo.label }, toast),
      noKey: true,
      wrap: true,
    },
    HIDE_UNDO_MS,
  );
  return true;
}

/** Show a repository again (Hidden's button, or Undo), with its toast. */
export async function showRepoWithToast(repo: Pick<InboxRepoHidden, 'key' | 'label'>, toast: Toast | undefined): Promise<void> {
  try {
    await showRepo(repo.key);
  } catch (cause) {
    toast?.({ icon: 'warn', lead: 'Couldn’t show it again', detail: cause instanceof Error ? cause.message : undefined, wrap: true }, HIDE_UNDO_MS);
    return;
  }
  toast?.({ icon: 'check', lead: shownToast([repo.label]) }, HIDE_UNDO_MS);
}
