/**
 * The reaction tray's saved emoji (config.json `inboxReactions`, each with its optional name and skill), one set for
 * the person on every linked machine, as "Show archived" is (inbox-show-archived.ts). Each Inbox keeps its copy and its
 * revision (`inboxReactionsRev`); a save here carries a revision one past the newest this Inbox knows of on any
 * machine, and an Inbox takes a linked machine's list (its list's `reactions`, sent to a machine only) when that one is
 * newer. Two machines that saved the same revision at once settle on the same list: the one whose JSON sorts higher.
 *
 * Except the first time: while either side has never synced its set with a linked machine (`synced`, config.json
 * `inboxReactionsSynced`), the two sets are merged instead (`mergeSharedReactions`), so a set saved on a fresh
 * computer before it was linked (even one saved and then emptied) never wipes the other's. After that, newest wins,
 * so removing every emoji on one of a synced pair removes them on both.
 */
import { INBOX_SAVED_REACTIONS_MAX, parseInboxSavedReactions, type InboxReaction } from "@plannotator/core/inbox-types";

export interface SharedReactions {
  reactions: InboxReaction[];
  rev: number;
  /** This Inbox has synced its set with a linked machine before (absent: never). */
  synced?: boolean;
}

/** The highest revision kept; a far copy past it reads as none. */
export const SHARED_REACTIONS_REV_MAX = 2 ** 31;

/** A linked machine's `reactions` as its list said it; null for an Inbox before this, or anything unreadable. */
export function readSharedReactions(value: unknown): SharedReactions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const list = parseInboxSavedReactions(v.reactions);
  if (!list || typeof v.rev !== "number" || !Number.isInteger(v.rev) || v.rev < 0 || v.rev > SHARED_REACTIONS_REV_MAX) return null;
  return { reactions: list, rev: v.rev, ...(v.synced === true ? { synced: true } : {}) };
}

/**
 * Two sets as one: every emoji either has, once; the set with more entries (the same count: the one whose JSON sorts
 * higher) gives the order and its names, and the other's emoji follow in theirs. A skill is kept where either has one,
 * and so is a name. The same two sets merge the same way on either machine. At most `INBOX_SAVED_REACTIONS_MAX`.
 */
export function mergeSharedReactions(a: readonly InboxReaction[], b: readonly InboxReaction[]): InboxReaction[] {
  const aFirst = a.length !== b.length ? a.length > b.length : JSON.stringify(a) >= JSON.stringify(b);
  const [first, second] = aFirst ? [a, b] : [b, a];
  const out: InboxReaction[] = first.map((entry) => {
    const other = second.find((o) => o.emoji === entry.emoji);
    const label = entry.label ?? other?.label;
    const skill = entry.skill ?? other?.skill;
    return { emoji: entry.emoji, ...(label !== undefined ? { label } : {}), ...(skill !== undefined ? { skill } : {}) };
  });
  for (const entry of second) if (!out.some((o) => o.emoji === entry.emoji)) out.push({ ...entry });
  return out.slice(0, INBOX_SAVED_REACTIONS_MAX);
}

/**
 * What this Inbox keeps after reading a linked machine's set, or null to keep its own as it is: newest wins when both
 * have synced before; otherwise the two are merged, written one past both revisions so the other machine takes the
 * merge too (or the far set as it is, when the merge is exactly that).
 */
export function settleSharedReactions(held: SharedReactions, far: SharedReactions): SharedReactions | null {
  if (held.synced && far.synced) return sharedReactionsNewer(far, held) ? { reactions: far.reactions, rev: far.rev } : null;
  const merged = mergeSharedReactions(held.reactions, far.reactions);
  const same = (list: readonly InboxReaction[]) => JSON.stringify(list) === JSON.stringify(merged);
  if (same(far.reactions)) {
    const rev = Math.max(held.rev, far.rev);
    return same(held.reactions) && rev === held.rev ? null : { reactions: merged, rev };
  }
  return { reactions: merged, rev: Math.min(SHARED_REACTIONS_REV_MAX, Math.max(held.rev, far.rev) + 1) };
}

/** `next` wins over `held`: a higher revision, or the same one with a different list whose JSON sorts higher. */
export function sharedReactionsNewer(next: SharedReactions, held: SharedReactions): boolean {
  if (next.rev !== held.rev) return next.rev > held.rev;
  return JSON.stringify(next.reactions) > JSON.stringify(held.reactions);
}

/** A save's revision: one past this Inbox's and every linked machine's it has read. */
export function nextSharedReactionsRev(held: number, far: readonly SharedReactions[]): number {
  return Math.min(SHARED_REACTIONS_REV_MAX, Math.max(held, ...far.map((copy) => copy.rev)) + 1);
}
