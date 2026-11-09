/**
 * Plannotator Inbox: a conversation that goes on under a new session id.
 *
 * A person's reply goes to a session id (the author of the message it
 * answers, or the session it is addressed to), and that session's connection
 * polls for it. When the host gives a conversation a new id (Claude Code's
 * branch of a conversation: the new transcript names the session it came
 * from; its hand-over to a new session: the old transcript names the new
 * one), the old id never polls again, and a reply would wait on it for good.
 *
 * So a connection may say, on every poll, which session ids its conversation
 * continues (`continues`, set by the host from its own records, never by the
 * model). While a session it continues is not live, the continuing session
 * stands in for it: it is handed what waits for the old id, and the old id
 * reads as there. Nothing is written for it: the store's routing is unchanged,
 * and a claim lasts as long as its session keeps polling with it.
 *
 * The rules, all of them here:
 * - A live session keeps its own. Nothing is inherited from a session whose
 *   connection polls (a fork where both conversations go on).
 * - A line stops at its first live session: with A → B → C and B live, C
 *   inherits nothing of A's (B is the nearer continuation).
 * - One heir at a time: the first live session to stand in for an old id
 *   keeps it while it is live and still claims it; another claimant (a second
 *   fork) takes over only after that.
 * - The old id polling again takes everything back at once.
 */

/** The most session ids one poll's `continues` may name. */
export const INBOX_CONTINUES_MAX = 8;
/** The longest session id a claim may name. */
const SESSION_ID_MAX = 200;

/** A poll's `continues` as a list of session ids, nearest first: a string or an array of strings, never `self`. */
export function parseInboxContinues(value: unknown, self: string): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > SESSION_ID_MAX || id === self || out.includes(id)) continue;
    out.push(id);
    if (out.length >= INBOX_CONTINUES_MAX) break;
  }
  return out;
}

export interface InboxContinuations {
  /** `heir`'s poll said which sessions its conversation continues (nearest first); an empty list withdraws the claim. */
  claim(heir: string, continues: readonly string[]): void;
  /** Every session `heir`'s conversation continues, nearest first, through the claims of the sessions it names. */
  lineOf(heir: string): string[];
  /** The sessions `heir` stands in for now, nearest first; empty when `heir` is not live. */
  inheritedBy(heir: string): string[];
  /** The live session standing in for `session` now, or null: `session` is live itself, or nobody continues it. */
  heirOf(session: string): string | null;
  /** Every session some claim names. */
  claimed(): string[];
  /** Who stands in for whom now, as one string: it changes when an heir arrives, goes, or the old id comes back. */
  signature(): string;
}

export function createInboxContinuations(deps: { isLive(session: string): boolean }): InboxContinuations {
  /** heir → the sessions its poll named, nearest first. */
  const claims = new Map<string, string[]>();
  /** old id → the session standing in for it. */
  const holders = new Map<string, string>();

  const lineOf = (heir: string): string[] => {
    const out: string[] = [];
    const walk = (session: string) => {
      for (const named of claims.get(session) ?? []) {
        if (named === heir || out.includes(named)) continue;
        out.push(named);
        walk(named);
      }
    };
    walk(heir);
    return out;
  };

  /** The part of `heir`'s line it may stand in for: up to, not including, its first live session. */
  const reachOf = (heir: string): string[] => {
    const out: string[] = [];
    for (const session of lineOf(heir)) {
      if (deps.isLive(session)) break;
      out.push(session);
    }
    return out;
  };

  const holds = (heir: string, session: string): boolean => deps.isLive(heir) && reachOf(heir).includes(session);

  const heirOf = (session: string): string | null => {
    if (deps.isLive(session)) {
      holders.delete(session);
      return null;
    }
    const current = holders.get(session);
    if (current !== undefined && holds(current, session)) return current;
    holders.delete(session);
    for (const heir of claims.keys()) {
      if (!holds(heir, session)) continue;
      holders.set(session, heir);
      return heir;
    }
    return null;
  };

  return {
    claim(heir, continues) {
      if (continues.length === 0) claims.delete(heir);
      else claims.set(heir, [...continues]);
    },
    lineOf,
    inheritedBy: (heir) => (deps.isLive(heir) ? reachOf(heir).filter((session) => heirOf(session) === heir) : []),
    heirOf,
    claimed: () => [...new Set([...claims.values()].flat())],
    signature: () =>
      [...new Set([...claims.values()].flat())]
        .sort()
        .flatMap((session) => {
          const heir = heirOf(session);
          return heir ? [`${session}>${heir}`] : [];
        })
        .join(","),
  };
}
