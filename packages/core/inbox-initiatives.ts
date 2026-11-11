import { isInboxId, type InboxAuthor } from "./inbox-types";
import { codeFenceCloseIndex } from "./markdown-structure";

export interface InboxInitiative {
  id: string;
  name: string;
  created_at: string;
  created_by: InboxAuthor;
  updated_at: string;
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
 * The initiative a card is in, among `initiatives`: its id when that one is live, else null (none
 * set, or deleted since).
 */
export function inboxCardInitiativeOf(card: { initiative?: string | null }, live: ReadonlySet<string>): string | null {
  const id = card.initiative ?? null;
  return id !== null && live.has(id) ? id : null;
}

/** Threads an initiative's preview lists (the window's `initiativePeek`); the rest read "+N more". */
export const INBOX_INITIATIVE_PEEK_THREADS = 3;

/** A name without the leading `#` an agent may copy from a tag: "#Billing" is "Billing". */
export function inboxInitiativeBareName(name: string): string {
  return name.trim().replace(/^#+\s*/u, "");
}

/**
 * What an agent's name joins a live initiative by: case, spaces, `-`, `_` and a leading `#`
 * ignored, and one spelling of the same letters (NFC), nothing else.
 */
export function inboxInitiativeJoinKey(name: string): string {
  return inboxInitiativeBareName(name).normalize("NFC").toLowerCase().replace(/[\s_-]+/gu, "");
}

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
  return before === "" || /[\s([{"'\u201C\u2018\u00AB*_~>\uFF08\u300C\u300E\u3010\u3008\u300A\u3014]/u.test(before);
}

const blank = (match: string) => match.replace(/[^\n]/g, " ");

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
    // The scheme's length is capped so that a long run of letters (a pasted log, base64) stays
    // linear; uncapped, the search walks the rest of the run from every letter.
    .replace(/(?:[a-z][a-z0-9+.-]{0,31}:\/\/|www\.)[^\s<>]*/gi, blank);
}

export interface InboxHashtag {
  start: number;
  end: number;
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
