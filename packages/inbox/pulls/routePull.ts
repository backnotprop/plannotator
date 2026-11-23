/**
 * A PR's page reopened on a PR the list no longer names (the owner, 2026-11-23: "my diff while I'm viewing diffs or
 * refresh it just goes away"). The address names the PR: after a reload, or a restart of the Inbox, the page asks for
 * it (`GET /api/inbox/pulls/pull`, the forge's answer when no list has it: inbox-pull-forge.ts) and opens on it, its
 * diff read as before. The person's own merged PR is still in the raw list (no stack holds it): taken from there.
 *
 * Its state as the forge says it (the diff read's, or this read's) shows on the page with the mark the PR gets
 * everywhere: a PR merged or closed elsewhere says so. Only merged or closed is taken from the forge: the list's
 * word stands otherwise (GitHub's search lags a merge made here, never the other way). Checks are not shown for a PR
 * the list no longer reads: an old answer would read as current.
 */
import { useEffect, useMemo, useState } from 'react';
import { inboxPullIsOpen, type InboxPull, type InboxPullDiffAnswer, type InboxPullItem, type InboxPullsAnswer, type InboxPullStack } from '@plannotator/core/inbox-types';
import { get } from '../api';
import { pullUrl } from './pullMachines';

/** The server's copy of one PR, listed or not (`pull` null: none it may read). */
export const readRoutePull = (key: string, signal?: AbortSignal) => get<{ pull: InboxPull | null }>(pullUrl('/pulls/pull', key), signal);

/** One PR as a stack of its own. */
export function loneStack(pull: InboxPull): InboxPullStack {
  return { id: pull.key, platform: pull.platform, host: pull.host, repo: pull.repo, layers: [pull], parents: { [pull.key]: null }, base: pull.base, open_base: pull.base };
}

/** A stack as the row the review reads it from. */
export function itemOf(stack: InboxPullStack, key: string): InboxPullItem {
  const focus = stack.layers.find((l) => l.key === key) ?? stack.layers[0]!;
  return { stack, move: 'waiting', focus, reason: 'review', updated_at: focus.updated_at };
}

/**
 * The PR the address names when no stack the list draws holds it (`wanted`): the raw list's copy, else the server's
 * (asked once per PR). `asking` while that read is out, so the page says it is reading, not that the PR is gone.
 */
export function useRoutePull(key: string, model: Pick<InboxPullsAnswer, 'pulls'> | null, wanted: boolean): { pull: InboxPull | null; asking: boolean } {
  const raw = useMemo(() => (wanted && model ? (model.pulls.find((p) => p.key === key) ?? null) : null), [wanted, model, key]);
  const [got, setGot] = useState<{ key: string; pull: InboxPull | null } | null>(null);
  // Asked once each time the list stops naming it (or the page opens so): not on every list read.
  const ask = wanted && !!model;
  useEffect(() => {
    if (!ask) return;
    const controller = new AbortController();
    readRoutePull(key, controller.signal)
      .then((answer) => {
        if (!controller.signal.aborted) setGot({ key, pull: answer.pull });
      })
      .catch(() => {
        if (!controller.signal.aborted) setGot({ key, pull: null });
      });
    return () => controller.abort();
  }, [ask, key]);
  const fetched = got?.key === key ? got.pull : null;
  // The forge's read is newer than the raw list's for a PR no stack holds (its state, its head).
  return { pull: wanted ? (fetched ?? raw) : null, asking: wanted && !!model && got?.key !== key };
}

/** What the forge said of this PR at the diff's read: only merged or closed. */
export function forgeSaid(diff: Pick<InboxPullDiffAnswer, 'key' | 'state' | 'merged_at'> | null, key: string): Pick<InboxPull, 'state' | 'merged_at'> | null {
  if (!diff || diff.key !== key || !diff.state || inboxPullIsOpen({ state: diff.state })) return null;
  return { state: diff.state, merged_at: diff.merged_at ?? null };
}

/**
 * The stack to draw: the layer's state as the forge last said it when that is merged or closed, and no checks for a
 * PR the list no longer names (`listed` false).
 */
export function withForgeState(stack: InboxPullStack | null, key: string, listed: boolean, said: Pick<InboxPull, 'state' | 'merged_at'> | null, read: InboxPull | null): InboxPullStack | null {
  if (!stack) return null;
  const forge = said ?? (read && !inboxPullIsOpen(read) ? { state: read.state, merged_at: read.merged_at } : null);
  const at = stack.layers.findIndex((l) => l.key === key);
  if (at < 0) return stack;
  const layer = stack.layers[at]!;
  const moved = forge && forge.state !== layer.state;
  const stale = !listed && layer.checks !== null;
  if (!moved && !stale) return stack;
  const now: InboxPull = { ...layer, ...(moved ? { state: forge.state, merged_at: forge.merged_at ?? layer.merged_at } : {}), ...(stale ? { checks: null } : {}) };
  return { ...stack, layers: stack.layers.map((l, i) => (i === at ? now : l)) };
}
