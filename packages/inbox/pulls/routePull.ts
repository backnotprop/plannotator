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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inboxPullIsOpen, type InboxPull, type InboxPullDiffAnswer, type InboxPullItem, type InboxPullsAnswer, type InboxPullStack } from '@plannotator/core/inbox-types';
import type { InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import { get, InboxApiError } from '../api';
import { forgetPullMachine, pullMachine, pullUrl } from './pullMachines';
import { hostName } from './labels';
import { unansweredLine } from './notices';
import { pageState } from './pageState';

/**
 * The server's copy of one PR, listed or not (`pull` null: none it may read). `unreadable`: the forge did not answer
 * (offline, down), which says nothing of the PR; `pull` is then the copy the server kept, if any. `missing`: the forge
 * answered that it has no such PR now (deleted, or no longer visible to the person); `pull` is the copy kept, if any.
 */
export const readRoutePull = (key: string, signal?: AbortSignal) => get<{ pull: InboxPull | null; unreadable?: true; missing?: true }>(pullUrl('/pulls/pull', key), signal);

/** The page's one line while the forge does not answer: what shows is its last read. */
export const unreadWords = (forge: string) => `${forge} didn't answer; showing its last read.`;

/** The page's one line once the forge says it has no such PR: what shows is its last read, never current again. */
export const missingWords = (forge: string) => `${forge} can't find this pull request any more; showing its last read.`;

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
 * `unread` while the forge does not answer (or the Inbox could not be reached): the copy the page has stays, never
 * "gone", and it is asked again when the window gets its focus back or the browser is back online. `missing` once the
 * forge says it has no such PR: the copy the page has stays too, as its last read, and the page says so.
 */
export interface RoutePull {
  pull: InboxPull | null;
  /** The read is out (or the Inbox could not be reached at all): the page says it is reading, not that the PR is gone. */
  asking: boolean;
  unread: boolean;
  missing: boolean;
  /** `pull` is the forge's answer now (or the list's own copy), not a copy kept from before. */
  fresh: boolean;
  /**
   * With no copy to show: what the page says instead of "no longer in the list", in words the Inbox already says for
   * the same cause. The forge did not answer: the list's own line for a host that did not ("GitHub didn't answer; its
   * pull requests aren't shown.", notices.ts); the linked computer that lists it could not be reached: that
   * computer's own answer ("Mac mini cannot be reached now."), or the server's own words for any other 5xx (a 502
   * `machine_unreachable`). Null: "no longer in the list" is the truth.
   */
  rest: string | null;
  /** Ask the server again now (an action it refused because the PR is no longer open). */
  again: () => void;
}

/**
 * `read`: the forge answered; `missing`: it answered that it has no such PR; `unread`: it did not answer (the server
 * said so); `away`: the linked computer that lists it could not be reached (its words in `away`); `none`: no Inbox
 * can answer for it (a linked computer too old for this read); `failed`: this Inbox could not be reached.
 */
type Got = { key: string; pull: InboxPull | null; as: 'read' | 'missing' | 'unread' | 'away' | 'none' | 'failed'; away?: string };

export function useRoutePull(key: string, model: Pick<InboxPullsAnswer, 'pulls'> | null, wanted: boolean): RoutePull {
  const raw = useMemo(() => (wanted && model ? (model.pulls.find((p) => p.key === key) ?? null) : null), [wanted, model, key]);
  const [got, setGot] = useState<Got | null>(null);
  const [retry, setRetry] = useState(0);
  const again = useCallback(() => setRetry((n) => n + 1), []);
  // Asked each time the list stops naming it (or the page opens so), and again on each list read while the copy it
  // has is not merged: the server's copy can be a list's older read (a list that never named it here, or the other
  // list), and only a new ask learns that it merged, closed or reopened. Merged is final: no more asks then (a closed
  // PR can be reopened).
  const ask = wanted && !!model;
  const final = got?.key === key && got.as === 'read' && got.pull?.state === 'merged';
  const seen = useRef({ model, ask });
  useEffect(() => {
    const was = seen.current;
    seen.current = { model, ask };
    // A new list read while it was already asked (not the read that made it asked: that one asks below).
    if (was.model !== model && was.ask && ask && !final) setRetry((n) => n + 1);
  }, [model, ask, final]);
  useEffect(() => {
    if (!ask) return;
    const controller = new AbortController();
    // A read that found nothing new keeps the copy this page has: an unanswered read never says "gone", nor does the
    // forge saying it has no such PR now (the page says that instead), nor a refusal (`none`). Only an answer of no PR
    // (`pull` null, `read`: the PR is not the person's to read here any more, hidden or its project removed) takes it away.
    const keep = (pull: InboxPull | null, as: Exclude<Got['as'], 'read'>, away?: string) => setGot((was) => ({ key, pull: pull ?? (was?.key === key ? was.pull : null), as, ...(away ? { away } : {}) }));
    readRoutePull(key, controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        if (answer.unreadable) keep(answer.pull, 'unread');
        else if (answer.missing) keep(answer.pull, 'missing');
        else setGot({ key, pull: answer.pull, as: 'read' });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof InboxApiError ? cause.code : null;
        // The computer it was learned from is not linked any more: this computer answers for it instead.
        if (code === 'machine_not_linked' && pullMachine(key)) {
          forgetPullMachine(key);
          setRetry((n) => n + 1);
        }
        // Asleep, or any other answer that it could not be read there (a 502 `machine_unreachable`, any 5xx): at rest
        // with the server's own words, asked again on focus, never "reading" for ever.
        else if (cause instanceof InboxApiError && (code === 'machine_offline' || cause.status >= 500)) keep(null, 'away', cause.message);
        // A linked computer whose Inbox has no such read (an older one), or a refusal: nothing can say more of it.
        else if (cause instanceof InboxApiError && cause.status >= 400 && cause.status < 500) keep(null, 'none');
        else keep(null, 'failed');
      });
    return () => controller.abort();
  }, [ask, key, retry]);
  const mine = ask && got?.key === key ? got : null;
  const unread = mine?.as === 'unread';
  const unanswered = unread || mine?.as === 'away' || mine?.as === 'failed';
  useEffect(() => {
    if (!unanswered) return;
    const askAgain = () => setRetry((n) => n + 1);
    window.addEventListener('focus', askAgain);
    window.addEventListener('online', askAgain);
    return () => {
      window.removeEventListener('focus', askAgain);
      window.removeEventListener('online', askAgain);
    };
  }, [unanswered]);
  const fetched = got?.key === key ? got.pull : null;
  const pull = wanted ? (fetched ?? raw) : null;
  // The forge's read is newer than the raw list's for a PR no stack holds (its state, its head). Every answer comes
  // to rest: only a read still out, or an Inbox that could not be reached, reads as still reading.
  const settled = got?.key === key && got.as !== 'failed';
  const host = /^([^/#]+)\//.exec(key)?.[1] ?? '';
  const rest = !pull && mine ? (mine.as === 'unread' ? unansweredLine(hostName(host), false) : mine.as === 'away' ? (mine.away ?? null) : null) : null;
  return {
    pull,
    asking: wanted && !!model && (got?.key !== key || (!settled && !fetched && !raw)),
    unread,
    missing: mine?.as === 'missing',
    fresh: !!pull && (!fetched || mine?.as === 'read'),
    rest,
    again,
  };
}

/** What the forge said of this PR at the diff's read: only merged or closed. */
export function forgeSaid(diff: Pick<InboxPullDiffAnswer, 'key' | 'state' | 'merged_at'> | null, key: string): Pick<InboxPull, 'state' | 'merged_at'> | null {
  if (!diff || diff.key !== key || !diff.state || inboxPullIsOpen({ state: diff.state })) return null;
  return { state: diff.state, merged_at: diff.merged_at ?? null };
}

/**
 * What a merged ship says of its PR (Ship: the record its Reviews row's "Merged <time>" reads, kept 6 hours, the
 * teammate's PR that left every list too): merged, at its time. Merged is final, so it is taken over any list's word.
 */
export function shipSaid(ship: Pick<InboxShipView, 'key' | 'state' | 'merged_at' | 'ended_at'> | null | undefined, key: string): Pick<InboxPull, 'state' | 'merged_at'> | null {
  if (!ship || ship.key !== key || ship.state !== 'merged') return null;
  return { state: 'merged', merged_at: ship.merged_at ?? ship.ended_at };
}

/**
 * A held page's stack with each open layer whose ship merged marked merged: the launchpad reads no forge, and a
 * teammate's PR held there would say open beside a row that says Merged. The same stack when no ship merged one.
 */
export function withShipState(stack: InboxPullStack, ships: ReadonlyMap<string, Pick<InboxShipView, 'key' | 'state' | 'merged_at' | 'ended_at'>> | null | undefined): InboxPullStack {
  if (!ships || ships.size === 0) return stack;
  let out = stack;
  for (const layer of stack.layers) {
    const said = inboxPullIsOpen(layer) ? shipSaid(ships.get(layer.key), layer.key) : null;
    if (said) out = withForgeState(out, layer.key, true, said, null)!;
  }
  return out;
}

/**
 * The stack to draw: the layer's state as the page's one rule has it (pageState.ts: the list, the diff's read, the
 * page's own read of the PR), and no checks for a PR the list no longer names (`listed` false).
 */
export function withForgeState(stack: InboxPullStack | null, key: string, listed: boolean, said: Pick<InboxPull, 'state' | 'merged_at'> | null, read: Pick<RoutePull, 'pull' | 'fresh'> | null): InboxPullStack | null {
  if (!stack) return null;
  const at = stack.layers.findIndex((l) => l.key === key);
  if (at < 0) return stack;
  const layer = stack.layers[at]!;
  const forge = pageState({ layer, listed, said, read: read?.pull ? { pull: read.pull, fresh: read.fresh } : null });
  const moved = forge.state !== layer.state;
  const stale = !listed && layer.checks !== null;
  if (!moved && !stale) return stack;
  const now: InboxPull = { ...layer, ...(moved ? { state: forge.state, merged_at: forge.merged_at ?? layer.merged_at } : {}), ...(stale ? { checks: null } : {}) };
  return { ...stack, layers: stack.layers.map((l, i) => (i === at ? now : l)) };
}
