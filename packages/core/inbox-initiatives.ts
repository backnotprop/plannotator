/**
 * The Board's initiatives (approval "board-initiatives", 2026-11-04): what a
 * piece of work is for ("Code review", "Shape"), named by the person, across
 * projects. A card carries at most one (`InboxCard.initiative`, an `ini_` id;
 * absent or null is none). Cards show no mark for it: the Board's one filter
 * (Projects and Initiatives) is where an initiative shows.
 *
 * Stored in `inbox/initiatives.jsonl` (one file, not per project: an
 * initiative crosses projects), one full snapshot per line on the store's one
 * seq counter (kind `initiative`), so the event stream carries them. Deleting
 * one keeps its record (`deleted_at`) and writes no card: a card whose
 * initiative is deleted reads as none (the store's `cardWire`), and its
 * history still names it.
 *
 * The person names, renames and deletes them. An agent puts its own card in
 * one by name through the card tool's `initiative` (approval
 * "board-initiatives", "Agents and initiatives"): a name no live initiative
 * matches makes a new one, the only way an agent makes one.
 */

import { isInboxId, type InboxAuthor } from "./inbox-types";

export interface InboxInitiative {
  /** `ini_` + ULID. */
  id: string;
  /** One line, at most INBOX_INITIATIVE_NAME_MAX characters, unique (ignoring case) among the live ones. */
  name: string;
  created_at: string;
  created_by: InboxAuthor;
  /** The last rename (or the creation). */
  updated_at: string;
  /** Set when the person deleted it: cards that named it read as none; the record stays for their history. */
  deleted_at: string | null;
}

/** The longest initiative name, in characters. */
export const INBOX_INITIATIVE_NAME_MAX = 40;

/** The most live initiatives at once (the filter menu stays a menu). */
export const INBOX_INITIATIVES_MAX = 50;

/** The filter's value for cards with no initiative (`#board&initiative=none`). */
export const INBOX_NO_INITIATIVE = "none";

/** Whether `value` reads as an initiative id. */
export function isInboxInitiativeId(value: unknown): value is string {
  return isInboxId("ini", value);
}

/** Whether a stored record reads as an initiative (a line a later Inbox wrote with fields this one lacks still does). */
export function isInboxInitiativeRecord(value: unknown): value is InboxInitiative {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isInboxInitiativeId(record.id) &&
    typeof record.name === "string" &&
    typeof record.created_at === "string" &&
    typeof record.updated_at === "string" &&
    (record.deleted_at === null || typeof record.deleted_at === "string")
  );
}

/** The key two names are the same by: case and surrounding space ignored. */
export function inboxInitiativeNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * The key an agent's name for an initiative (the card tool's `initiative`)
 * matches a live one by: case and every space ignored, so "code review",
 * "Code  Review" and "CodeReview" all reuse "Code review" rather than make a
 * near-duplicate. Wider than inboxInitiativeNameKey (what two names may not
 * share), so an exact match there is tried first.
 */
export function inboxInitiativeMatchKey(name: string): string {
  return inboxInitiativeNameKey(name).replace(/\s+/gu, "");
}

/**
 * The initiative a card is in, among `initiatives`: its id when that one is
 * live, else null (none set, or deleted since).
 */
export function inboxCardInitiativeOf(card: { initiative?: string | null }, live: ReadonlySet<string>): string | null {
  const id = card.initiative ?? null;
  return id !== null && live.has(id) ? id : null;
}
