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
 * The person's only: agents neither make nor set one (no agent field yet).
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
 * The initiative a card is in, among `initiatives`: its id when that one is
 * live, else null (none set, or deleted since).
 */
export function inboxCardInitiativeOf(card: { initiative?: string | null }, live: ReadonlySet<string>): string | null {
  const id = card.initiative ?? null;
  return id !== null && live.has(id) ? id : null;
}

// ─────────────── Hashtags (prototype "board-hashtags") ───────────────
// `#Shape` in what the person writes names an initiative. A tag is `#`, then
// a letter or digit, then letters, digits, `_` or `-`; never all digits
// (`#123` is an issue), never after a letter, digit, `/`, `&` or `#` (a URL's
// fragment, `owner/repo#1`, `##`). Code (fenced or `inline`) holds no tag.

/** A hashtag's key: letters and digits only, lowercased, so `#CodeReview`, `#code-review` and "Code review" are one. */
export function inboxInitiativeTagKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** How a pick is written: `#Shape`, `#CodeReview` (the words joined, each after the first capitalised). */
export function inboxInitiativeTag(name: string): string {
  const words = name
    .normalize("NFKC")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean);
  return `#${words.map((word, i) => (i === 0 ? word : word.charAt(0).toLocaleUpperCase() + word.slice(1))).join("")}`;
}

/** Code blocked out (same length, spaces), so a `#name` in code is never a tag. */
function withoutCode(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return text.replace(/```[\s\S]*?(```|$)/g, blank).replace(/`[^`\n]*`/g, blank);
}

export interface InboxHashtag {
  /** Index of the `#`. */
  start: number;
  /** Index just past the tag. */
  end: number;
  /** As written, without the `#`. */
  tag: string;
  key: string;
}

/** Every hashtag in `text`, in order. */
export function inboxHashtags(text: string): InboxHashtag[] {
  const out: InboxHashtag[] = [];
  const re = /(^|[^\p{L}\p{N}_&/#])#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;
  const plain = withoutCode(text);
  for (let match = re.exec(plain); match; match = re.exec(plain)) {
    const tag = match[2]!.replace(/[-_]+$/, "");
    if (/^\d+$/.test(tag)) continue;
    const start = match.index + match[1]!.length;
    out.push({ start, end: start + 1 + tag.length, tag, key: inboxInitiativeTagKey(tag) });
  }
  return out;
}

/** The live initiative a tag names, or null. */
export function inboxInitiativeOfTag<T extends Pick<InboxInitiative, "name" | "deleted_at">>(key: string, initiatives: readonly T[]): T | null {
  if (!key) return null;
  return initiatives.find((i) => i.deleted_at === null && inboxInitiativeTagKey(i.name) === key) ?? null;
}

/** The live initiative the last tag in `text` that names one names, or null (what a message puts its thread's card in). */
export function inboxTaggedInitiative<T extends Pick<InboxInitiative, "name" | "deleted_at">>(text: string, initiatives: readonly T[]): T | null {
  let found: T | null = null;
  for (const tag of inboxHashtags(text)) found = inboxInitiativeOfTag(tag.key, initiatives) ?? found;
  return found;
}
