/**
 * The reaction tray's saved emoji (config.json `inboxReactions`, each with its optional name and skill), one set for
 * the person on every linked machine, as "Show archived" is (inbox-show-archived.ts). Each Inbox keeps its copy and its
 * revision (`inboxReactionsRev`); a save here carries a revision one past the newest this Inbox knows of on any
 * machine, and an Inbox takes a linked machine's list (its list's `reactions`, sent to a machine only) when that one is
 * newer. Two machines that saved the same revision at once settle on the same list: the one whose JSON sorts higher.
 */
import { parseInboxSavedReactions, type InboxReaction } from "@plannotator/core/inbox-types";

export interface SharedReactions {
  reactions: InboxReaction[];
  rev: number;
}

/** The highest revision kept; a far copy past it reads as none. */
export const SHARED_REACTIONS_REV_MAX = 2 ** 31;

/** A linked machine's `reactions` as its list said it; null for an Inbox before this, or anything unreadable. */
export function readSharedReactions(value: unknown): SharedReactions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const list = parseInboxSavedReactions(v.reactions);
  if (!list || typeof v.rev !== "number" || !Number.isInteger(v.rev) || v.rev < 0 || v.rev > SHARED_REACTIONS_REV_MAX) return null;
  return { reactions: list, rev: v.rev };
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
