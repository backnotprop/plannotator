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
 * The person names, renames and deletes them. An agent puts a card in one
 * through the card tool's `initiative`, a name or a live one's id (approval
 * "board-initiatives", "Agents and initiatives"): a name matches a live one
 * exactly, ignoring case, or else by `inboxInitiativeJoinKey`, so "Code-Review",
 * "Code Review" and "#CodeReview" are one; anything no live initiative answers
 * to makes a new one, the only way an agent makes one. An agent may delete one
 * too (op `initiative_delete`); only the person renames.
 */

import { isInboxId, type InboxAuthor } from "./inbox-types";
import { codeFenceCloseIndex } from "./markdown-structure";

export interface InboxInitiative {
  /** `ini_` + ULID. */
  id: string;
  /** One line, at most INBOX_INITIATIVE_NAME_MAX characters, unique (ignoring case) among the live ones. */
  name: string;
  created_at: string;
  created_by: InboxAuthor;
  /** The last rename (or the creation). */
  updated_at: string;
  /** Set when it was deleted (the person, or an agent): cards that named it read as none; the record stays for their history and an Undo. */
  deleted_at: string | null;
}

/** The longest initiative name, in characters. */
export const INBOX_INITIATIVE_NAME_MAX = 40;

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

// ─────────────── Hashtags (approval "board-hashtags") ───────────────
// `#Shape` in what the person writes names an initiative. A tag is `#`, then
// a letter or digit, then letters, digits, `_` or `-`; never all digits
// (`#123` is an issue). It starts a line or follows whitespace or opening
// punctuation (`inboxHashtagMayFollow`), so `owner/repo#1`, `a-#x`, `?q=#x`
// and `##` are not tags. Code (fenced, any fence length, or inline with any
// equal backtick runs), a link's destination (`](…)`, `<…>`) and a URL hold
// no tag. The store (what moves a card) and the window (what links) read the
// same tags.

/** Threads an initiative's preview lists (the window's `initiativePeek`); the rest read "+N more". */
export const INBOX_INITIATIVE_PEEK_THREADS = 3;

/** A name without the leading `#` an agent may copy from a tag: "#Billing" is "Billing". */
export function inboxInitiativeBareName(name: string): string {
  return name.trim().replace(/^#+\s*/u, "");
}

/**
 * What an agent's name joins a live initiative by: case, spaces, `-`, `_` and a
 * leading `#` ignored, nothing else. Narrower than a tag's key, which only has
 * letters and digits to go on: here "C#" must not join "C++", "Q&A" "QA", or
 * "v12" "v1.2". Empty for a name of only those marks: that joins nothing.
 */
export function inboxInitiativeJoinKey(name: string): string {
  return inboxInitiativeBareName(name).toLowerCase().replace(/[\s_-]+/gu, "");
}

/** A hashtag's key: letters and digits only, lowercased (not locale-dependent, the same in the server and every browser), so `#CodeReview`, `#code-review` and "Code review" are one. */
export function inboxInitiativeTagKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** How a pick is written: `#Shape`, `#CodeReview` (the words joined, each after the first capitalised). */
export function inboxInitiativeTag(name: string): string {
  const words = name
    .normalize("NFKC")
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean);
  return `#${words.map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join("")}`;
}

/** Whether a name can be written as a tag that names it back (not "123" or "!!!"): the picker offers only these. */
export function inboxInitiativeTaggable(name: string): boolean {
  const tag = inboxInitiativeTag(name);
  const read = inboxHashtags(tag);
  return read.length === 1 && read[0]!.start === 0 && read[0]!.end === tag.length && read[0]!.key === inboxInitiativeTagKey(name);
}

/** What may come right before a tag's `#` (an empty string: the text's start). */
export function inboxHashtagMayFollow(before: string): boolean {
  // Full-width and CJK opening brackets too: （「『【〈《〔.
  return before === "" || /[\s([{"'\u201C\u2018\u00AB*_~>\uFF08\u300C\u300E\u3010\u3008\u300A\u3014]/u.test(before);
}

/** `match` blanked (same length, spaces; newlines kept), so offsets in the rest of the text stay put. */
const blank = (match: string) => match.replace(/[^\n]/g, " ");

/** Inline code blanked: a run of N backticks up to the next run of exactly N (CommonMark); an unmatched run is text. */
function withoutInlineCode(text: string): string {
  let out = "";
  let at = 0;
  const runs = /`+/g;
  for (let open = runs.exec(text); open; open = runs.exec(text)) {
    const length = open[0].length;
    let close: RegExpExecArray | null = null;
    const next = /`+/g;
    next.lastIndex = open.index + length;
    for (let run = next.exec(text); run; run = next.exec(text)) {
      if (run[0].length === length) {
        close = run;
        break;
      }
    }
    if (!close) continue;
    const end = close.index + length;
    out += text.slice(at, open.index) + blank(text.slice(open.index, end));
    at = end;
    runs.lastIndex = end;
  }
  return out + text.slice(at);
}

/**
 * What holds no tag, blanked: fenced code (closed as the Viewer closes it,
 * `codeFenceCloseIndex`), inline code, link destinations and URLs.
 */
function withoutCode(text: string): string {
  const lines = text.split("\n");
  const parts: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length > 0) parts.push(withoutInlineCode(prose.join("\n")));
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```/.test(lines[i]!)) {
      prose.push(lines[i]!);
      continue;
    }
    flush();
    const close = Math.min(codeFenceCloseIndex(lines, i), lines.length - 1);
    parts.push(lines.slice(i, close + 1).map(blank).join("\n"));
    i = close;
  }
  flush();
  return parts
    .join("\n")
    .replace(/\]\([^)\n]*\)/g, (m) => "](" + blank(m.slice(2)))
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, blank)
    // The scheme's length is capped so that a long run of letters (a pasted log, base64) stays linear; uncapped,
    // the search walks the rest of the run from every letter. A longer scheme still blanks: from its last 32
    // characters on, and a tag can only start after its `://`.
    .replace(/(?:[a-z][a-z0-9+.-]{0,31}:\/\/|www\.)[^\s<>]*/gi, blank);
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
  if (!text.includes("#")) return out;
  const re = /#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;
  const plain = withoutCode(text);
  for (let match = re.exec(plain); match; match = re.exec(plain)) {
    const start = match.index;
    if (!inboxHashtagMayFollow(plain.slice(Math.max(0, start - 1), start))) continue;
    const tag = match[1]!.replace(/[-_]+$/, "");
    if (/^\d+$/.test(tag)) continue;
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
