/**
 * The attach line's lookup (the owner's call, 2026-11-15: "look it up after
 * the message is sent"): a bare `#12` an agent's message names in its
 * project's GitHub repository, that this Inbox does not know as a PR or an
 * issue, is looked up once after the send has answered, never on its path.
 * A PR found this way is named on that agent's next send in the thread
 * (inbox-mcp-hints.ts); an issue is kept as an issue and never named.
 *
 * - Through the hover cards' read (ref-cards.ts: `issueOrPullRequest`, one
 *   call that answers either kind; its hosts, accounts, rate-limit pause and
 *   CLI slots), only while Code review is on and this computer's gh is signed
 *   in to the host; otherwise nothing runs. GitHub only: a GitLab `#12` is an
 *   issue there (its merge requests are `!12`, read from the text already).
 * - At most `LOOKUPS_PER_SEND` numbers per message, `LOOKUPS_RUNNING` at once
 *   and `LOOKUPS_WAITING` waiting (one past that is dropped, not cached).
 * - Every answer is kept (a PR, an issue, no such number), in memory, at most
 *   `LOOKUPS_KEPT` (least recently used dropped first), so a number is looked
 *   up once per repository per Inbox run; a restart forgets them. A failure
 *   (offline, signed out, rate limited) is no answer: silent, asked again on a
 *   later message.
 */

import { forgePullUrl, forgeRefKey, type ForgeRef } from "@plannotator/core/forge-ref-card";
import type { RefCards } from "@plannotator/shared/ref-cards";

/** What a lookup found for a number: kept in this shape so a later issue feature can read it. */
export type InboxPullLookupAnswer = { kind: "pull" | "issue" | "missing"; at: number };

export const LOOKUPS_PER_SEND = 3;
export const LOOKUPS_RUNNING = 1;
export const LOOKUPS_WAITING = 30;
export const LOOKUPS_KEPT = 5_000;

export interface InboxPullLookups {
  /** The answer held for a `forgeRefKey`; never looks anything up. */
  answer(key: string): InboxPullLookupAnswer | null;
  /**
   * Looks up the numbers no answer holds yet, at most `LOOKUPS_PER_SEND` of them, in the background; `found` hears
   * each one that is a PR. Never throws, never waits.
   */
  lookUp(refs: readonly ForgeRef[], found: (ref: ForgeRef) => void): void;
  /** Settles when nothing is running or waiting (tests). */
  idle(): Promise<void>;
  sizes(): { kept: number; running: number; waiting: number };
}

export function createInboxPullLookups(options: {
  /** One number's kind through the forge; null when the forge could not say (no answer kept). */
  read(ref: ForgeRef): Promise<"pull" | "issue" | "missing" | null>;
  /** Whether a lookup may run for this ref now: Code review on and the CLI signed in to its host. */
  usable(ref: ForgeRef): Promise<boolean>;
  now?: () => number;
}): InboxPullLookups {
  const now = options.now ?? Date.now;
  const kept = new Map<string, InboxPullLookupAnswer>();
  const queued = new Map<string, ForgeRef>();
  const running = new Set<string>();
  /** Who hears each number now waiting or running: every send that named it meanwhile. */
  const listeners = new Map<string, ((ref: ForgeRef) => void)[]>();
  let idleWaiters: (() => void)[] = [];

  const settleIdle = () => {
    if (running.size > 0 || queued.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
  };

  const keep = (key: string, answer: InboxPullLookupAnswer) => {
    kept.delete(key);
    kept.set(key, answer);
    while (kept.size > LOOKUPS_KEPT) kept.delete(kept.keys().next().value!);
  };

  const one = async (key: string, ref: ForgeRef) => {
    try {
      if (!(await options.usable(ref))) return;
      const kind = await options.read(ref);
      if (!kind) return;
      keep(key, { kind, at: now() });
      if (kind === "pull") for (const found of listeners.get(key) ?? []) found(ref);
    } catch {
      // A lookup that fails is no answer: the send it came from answered long ago.
    }
  };

  const pump = () => {
    while (running.size < LOOKUPS_RUNNING && queued.size > 0) {
      const [key, ref] = queued.entries().next().value!;
      queued.delete(key);
      running.add(key);
      void one(key, ref).finally(() => {
        running.delete(key);
        listeners.delete(key);
        pump();
        settleIdle();
      });
    }
  };

  return {
    answer(key) {
      const hit = kept.get(key);
      if (!hit) return null;
      kept.delete(key);
      kept.set(key, hit);
      return hit;
    },
    lookUp(refs, found) {
      try {
        let taken = 0;
        for (const ref of refs) {
          if (taken >= LOOKUPS_PER_SEND) break;
          const key = forgeRefKey(ref);
          if (kept.has(key)) continue;
          if (running.has(key) || queued.has(key)) {
            listeners.get(key)?.push(found);
            continue;
          }
          if (queued.size >= LOOKUPS_WAITING) break;
          queued.set(key, ref);
          listeners.set(key, [found]);
          taken++;
        }
        pump();
      } catch {
        // Never an error for the caller.
      }
    },
    idle() {
      if (running.size === 0 && queued.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    sizes() {
      return { kept: kept.size, running: running.size, waiting: queued.size };
    },
  };
}

/** A number's kind through the hover cards' read: a PR or an issue, no such number, or null when the forge could not say. */
export function refCardsKindReader(cards: RefCards): (ref: ForgeRef) => Promise<"pull" | "issue" | "missing" | null> {
  return async (ref) => {
    const card = await cards.get(forgePullUrl(ref));
    if (!card) return null;
    if (card.ok) return card.data.kind;
    return card.error === "not_found" ? "missing" : null;
  };
}
