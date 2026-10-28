/**
 * Plannotator Inbox: the Board's cards (approval "inbox-board", 2026-10-20).
 *
 * A card is one piece of work the person asked for (or an agent took on)
 * that outlasts the reply it was asked in. It is its own record, separate
 * from threads: threads and PRs link to it by explicit id, and nothing about
 * a card ever changes a thread's routing or its place in the person's list.
 *
 * Columns (COLUMNS.md, set d, as amended 2026-10-26): five live ones,
 * Backlog · Designing · Your look · Building · Your review, and three the
 * Board shows as links: Shipped, Icebox (only the person puts a card there
 * or takes one out; nothing happens to a card there) and Dropped. A card in
 * Backlog is not started and not sent to any agent (the column was "Asked"
 * until the owner renamed it; a stored `asked` reads as `backlog`,
 * inboxCardColumnOf). A card in the
 * person's columns (Your look, Your review) shows "You: …", what the person
 * owes; in the agents' columns it shows the agent's last word.
 *
 * A card shows how long ago anyone last wrote to it (`heard_at`, "2d ago");
 * no rule decides that a card is stalled (the owner dropped amber,
 * 2026-10-20). An agent's drop reaches the person: it stays unseen
 * (`dropped.seen_at` null) until they look at Dropped. Nothing moves a card
 * by guessing: a merged PR is shown, never acted on.
 *
 * Browser-safe and dependency-free; re-exported by `inbox-types`.
 */

import type { InboxAuthor } from "./inbox-types";

/**
 * Whether the Inbox serves the agents' `card` action (the MCP tool, so the
 * `plannotator_inbox` action and `plannotator card`). THE one line to change
 * to hold the action back until the Board page ships: the server stops
 * registering the tool, the agent guide drops its section, and the stated
 * tool cost (INBOX_TOOL_COST) goes back to the size without it. After
 * flipping it, run `bun run scripts/sync-mod-inbox-tools.ts` (the Claude Code
 * mod's bundled tool list is generated from a real Inbox). The store, the
 * window's card routes and the event stream are unaffected. Off since the
 * owner's answer (2026-10-20): it is switched on with the Board page (step 2).
 */
export const INBOX_CARD_ACTION_ON: boolean = true;

/** Every column a card can be in, in the Board's order. */
export const INBOX_CARD_COLUMNS = ["backlog", "designing", "your_look", "building", "your_review", "shipped", "icebox", "dropped"] as const;

export type InboxCardColumn = (typeof INBOX_CARD_COLUMNS)[number];

/** The Board's live lanes; the rest (Shipped, Icebox, Dropped) are links. */
export const INBOX_CARD_LIVE_COLUMNS: readonly InboxCardColumn[] = ["backlog", "designing", "your_look", "building", "your_review"];

/** The columns where a card waits on the person: it shows "You: …" (`you`). */
export const INBOX_CARD_PERSON_COLUMNS: readonly InboxCardColumn[] = ["your_look", "your_review"];

/** How the Board names each column. */
export const INBOX_CARD_COLUMN_LABELS: Readonly<Record<InboxCardColumn, string>> = {
  backlog: "Backlog",
  designing: "Designing",
  your_look: "Your look",
  building: "Building",
  your_review: "Your review",
  shipped: "Shipped",
  icebox: "Icebox",
  dropped: "Dropped",
};

/** The longest title, in characters. */
export const INBOX_CARD_TITLE_MAX = 120;
/**
 * Over this many characters a title gets a hint in the card call's answer
 * (approval "inbox-board-amendments-2026-10-27": "2–5 words naming the work,
 * never a sentence"; a gentle hint, never refused). 40 holds five long words.
 */
export const INBOX_CARD_TITLE_HINT_AT = 40;

/** The hint for a title that reads like a sentence, or null for one short enough. */
export function inboxCardTitleHint(title: string): string | null {
  if ([...title.trim()].length <= INBOX_CARD_TITLE_HINT_AT) return null;
  return `The title is ${[...title.trim()].length} characters. A title is 2–5 words naming the work ("Pi update fix"), never a sentence; where it stands goes in \`say\`. Shorten it with op say and \`title\`.`;
}

/** The markers around the Board request an agent receives (approval "inbox-compose-board-chip"), each on its own line. */
export const INBOX_BOARD_REQUEST_OPEN = "<plannotator-board-request>";
export const INBOX_BOARD_REQUEST_CLOSE = "</plannotator-board-request>";

/**
 * What an agent receives after the words of a message the person sent with
 * compose's Board chip on: the agent makes the card or cards itself, for
 * what was asked (owner, 2026-10-27: "create board card(s) depending on the
 * user ask"), linked to the thread, and keeps them current. Any session may
 * read it again (read_thread after compaction, a session the thread moved
 * to), so it makes cards only while none links the thread (review of #2249).
 * "Your Inbox card tool" fits every host: plannotator_inbox's card action, or
 * Codex's `card`; the CLI covers a session without either.
 */
export function inboxBoardRequestBlock(threadId: string): string {
  return [
    INBOX_BOARD_REQUEST_OPEN,
    `The person turned on Board tracking for this thread (thread_id ${threadId}). If no Board card links it yet (card op list, asked_by anyone, shows them), create card(s) for the work they asked for and link each to it; if one does, keep that one current instead of making another. How: your Inbox card tool, or \`plannotator card --help\`.`,
    INBOX_BOARD_REQUEST_CLOSE,
  ].join("\n");
}

/** The longest one-line `say` or `you`, in characters. */
export const INBOX_CARD_LINE_MAX = 280;
/** The longest drop reason, in characters. */
export const INBOX_CARD_REASON_MAX = 500;
/** The most threads, and the most PRs, one card links. */
export const INBOX_CARD_LINKS_MAX = 50;
/** The longest create `idempotency_key`, in characters (trimmed). */
export const INBOX_CARD_KEY_MAX = 128;

export function isInboxCardColumn(value: unknown): value is InboxCardColumn {
  return typeof value === "string" && (INBOX_CARD_COLUMNS as readonly string[]).includes(value);
}

/**
 * The column a stored or sent value names, or null. `asked` (the column's
 * name until the owner renamed it Backlog, 2026-10-26) reads as `backlog`,
 * so a record written before the rename, or a caller that still says
 * `asked`, keeps working.
 */
export function inboxCardColumnOf(value: unknown): InboxCardColumn | null {
  if (value === "asked") return "backlog";
  return isInboxCardColumn(value) ? value : null;
}

/** A stored card read through inboxCardColumnOf: `asked` in `column` or `aside_from` becomes `backlog`. */
export function readInboxCardColumns<T extends { column: string; aside_from: string | null }>(card: T): T {
  const column = inboxCardColumnOf(card.column) ?? card.column;
  const asideFrom = card.aside_from === null ? null : (inboxCardColumnOf(card.aside_from) ?? card.aside_from);
  return column === card.column && asideFrom === card.aside_from ? card : { ...card, column, aside_from: asideFrom };
}

export function isInboxCardLiveColumn(column: InboxCardColumn): boolean {
  return INBOX_CARD_LIVE_COLUMNS.includes(column);
}

export function isInboxCardPersonColumn(column: InboxCardColumn): boolean {
  return INBOX_CARD_PERSON_COLUMNS.includes(column);
}

/** A PR (or merge request) a card links: `ref` as people write it, `url` to open it. */
export interface InboxCardPr {
  /** `owner/repo#123` (GitHub, Bitbucket), `group/project!12` (GitLab). */
  ref: string;
  url: string;
}

/** Why a card was dropped, and who dropped it. */
export interface InboxCardDrop {
  at: string;
  by: InboxAuthor;
  /** Required from an agent, optional from the person. */
  reason: string | null;
  /**
   * When the person saw this drop: null while an agent's drop waits for them
   * (the Board says "N dropped by an agent", with the reasons, until they
   * look at Dropped: `POST /api/inbox/cards/dropped/seen`). A drop the person
   * made is seen when made.
   */
  seen_at: string | null;
}

/**
 * One card, as the store keeps it (`cards.jsonl`, one full snapshot per
 * line; the last line per id is current). Fields are only ever added.
 */
export interface InboxCard {
  /** `crd_` + ULID. */
  id: string;
  project_id: string;
  title: string;
  column: InboxCardColumn;
  /**
   * What the person owes, shown as "You: …" while the card is in Your look or
   * Your review. Cleared when the card leaves those columns, so a stale ask
   * never follows it back.
   */
  you: string | null;
  /** The agent's last word, shown in the agents' columns. */
  said: string | null;
  /** Thread root ids, in the order they were linked. */
  threads: string[];
  prs: InboxCardPr[];
  /**
   * The agent session the card belongs to (the one that made it): where "Ask
   * where this is" goes. Null for a card the person made. Named `agent`, not
   * `owner`: the Board's owner is the person.
   */
  agent: InboxAuthor | null;
  created_at: string;
  created_by: InboxAuthor;
  /** When the card last changed column. */
  moved_at: string;
  /** The last write by anyone (create, move, say, link, ship, drop): the card shows its age ("2d ago"). */
  heard_at: string;
  heard_by: InboxAuthor;
  /** Set while the card is in Dropped. */
  dropped: InboxCardDrop | null;
  /** The column a card left for Icebox or Dropped: where restoring puts it back. */
  aside_from: InboxCardColumn | null;
  /** An agent's create is idempotent on it, per project. */
  idempotency_key: string | null;
  /**
   * The person's notes (step 2): free text, line breaks kept, at most
   * INBOX_CARD_NOTES_MAX characters. When the card is sent to an agent the
   * notes are the message. Null on a card written before notes existed.
   */
  notes: string | null;
  /**
   * The person sent the card to an agent (step 2): the session it went to,
   * as a new thread the card links. The card is that agent's from then on
   * (`agent`). The Board shows "Sent to <agent>" while the card has not moved
   * since. Null otherwise, and on a card written before step 2.
   */
  sent: InboxCardSent | null;
  /**
   * Everything the card links outside the Inbox: PRs, issues (step 2). Kept
   * beside `prs` (still written, the PRs only, for an older Inbox); read
   * through inboxCardRefsOf.
   */
  refs: InboxCardRef[];
}

/**
 * Something outside the Inbox a card links (owner's answer, 2026-10-26: a
 * general reference model, not PR-only): a pull or merge request, an issue,
 * and later anything a new source adapter reads (a Linear issue, a Vercel
 * deployment). `kind` and `source` are open strings so an older window shows
 * a source it does not know as a plain link. `ref` is how people write it
 * (`owner/repo#123`, `group/project!12`); `url` opens it. The source adapters
 * live in `@plannotator/shared/inbox/card-refs` (parse) and the server's
 * `inbox-card-refs.ts` (resolve, read only).
 */
export interface InboxCardRef {
  kind: "pr" | "issue" | (string & {});
  source: "github" | "gitlab" | "bitbucket" | (string & {});
  ref: string;
  url: string;
}

/**
 * A card's references: `refs` when the card has them (written since step 2),
 * else its PRs as references (a card from step 1 has only `prs`).
 */
export function inboxCardRefsOf(card: { refs?: readonly InboxCardRef[] | null; prs: readonly InboxCardPr[] }): InboxCardRef[] {
  if (card.refs && card.refs.length > 0) return [...card.refs];
  return card.prs.map((pr) => ({ kind: "pr", source: prSourceOf(pr.url), ref: pr.ref, url: pr.url }));
}

function prSourceOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host === "bitbucket.org") return "bitbucket";
    return /\/-\/merge_requests\//.test(url) ? "gitlab" : "github";
  } catch {
    return "github";
  }
}

/**
 * The one link a lane card marks (approval "inbox-board", card variant C, and
 * the owner's 2026-10-26 "a symbol ... to indicate merged vs unmerged"): the
 * card's latest pull request, else its latest issue; null when it links
 * neither. The server resolves only this link per card, so the Board asks for
 * one state a card, never all of its links.
 */
export function inboxCardMarkRef(card: { refs?: readonly InboxCardRef[] | null; prs: readonly InboxCardPr[] }): InboxCardRef | null {
  const refs = inboxCardRefsOf(card);
  for (let i = refs.length - 1; i >= 0; i--) if (refs[i]!.kind === "pr") return refs[i]!;
  for (let i = refs.length - 1; i >= 0; i--) if (refs[i]!.kind === "issue") return refs[i]!;
  return null;
}

/**
 * What a lane card's mark says: the link's state in the forge's own words
 * (`completed` and `not_planned` are a closed issue's two kinds), or
 * `unknown` (not read yet, a source with no reader, a host this computer is
 * not signed in to, or a failure): a quiet neutral mark. Display only: a
 * link's state never moves a card.
 */
export type InboxCardMarkState = "open" | "draft" | "merged" | "closed" | "completed" | "not_planned" | "unknown";

export interface InboxCardMark {
  kind: "pr" | "issue";
  /** As people write it (`acme/widgets#12`). */
  ref: string;
  url: string;
  state: InboxCardMarkState;
  /** The forge's title, when read. */
  title: string | null;
}

/** The most cards one marks request names (the Board asks for the cards on screen). */
export const INBOX_CARD_MARKS_MAX = 200;

/** A card the person sent to an agent: when, to whom, and the thread it started. */
export interface InboxCardSent {
  at: string;
  to: InboxAuthor;
  thread_id: string;
}

/** The longest card notes, in characters. */
export const INBOX_CARD_NOTES_MAX = 4000;

/** A stored card with the fields added since step 1 filled in (`notes`, `sent`) and its columns read (`asked` → `backlog`). */
export function readInboxCard(card: InboxCard): InboxCard {
  const read = readInboxCardColumns(card);
  if (read.notes !== undefined && read.sent !== undefined && read.refs !== undefined) return read;
  return { ...read, notes: read.notes ?? null, sent: read.sent ?? null, refs: inboxCardRefsOf(read) };
}

/**
 * Notes as the store keeps them: line breaks kept (CRLF made LF), trimmed,
 * empty is none. Refused when not a string, holding a control or bidi
 * character other than a line break or tab, or over INBOX_CARD_NOTES_MAX.
 */
export function normalizeInboxCardNotes(value: unknown): { notes: string | null } | { error: string } {
  if (value === null || value === undefined) return { notes: null };
  if (typeof value !== "string") return { error: "notes: a string." };
  const text = value.replace(/\r\n?/g, "\n");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(text)) return { error: "notes: no control or bidi characters." };
  const trimmed = text.trim();
  if (!trimmed) return { notes: null };
  if ([...trimmed].length > INBOX_CARD_NOTES_MAX) return { error: `notes: at most ${INBOX_CARD_NOTES_MAX} characters.` };
  return { notes: trimmed };
}

/** Whether the Board shows a card as "Sent to <agent>": sent, in Backlog, and not moved since. */
export function isInboxCardSentWaiting(card: Pick<InboxCard, "sent" | "column" | "moved_at">): boolean {
  return card.sent !== null && card.sent !== undefined && card.column === "backlog" && card.moved_at <= card.sent.at;
}

/** One line of a card's history, newest first on the wire. */
export type InboxCardHistoryEntry =
  | { at: string; by: InboxAuthor; kind: "created"; column: InboxCardColumn; thread_id: string | null }
  | { at: string; by: InboxAuthor; kind: "moved"; column: InboxCardColumn; you: string | null }
  | { at: string; by: InboxAuthor; kind: "dropped"; reason: string | null }
  | { at: string; by: InboxAuthor; kind: "restored"; column: InboxCardColumn }
  | { at: string; by: InboxAuthor; kind: "said"; text: string }
  | { at: string; by: InboxAuthor; kind: "you"; text: string }
  | { at: string; by: InboxAuthor; kind: "linked_thread"; thread_id: string }
  | { at: string; by: InboxAuthor; kind: "linked_ref"; ref: string; ref_kind: string }
  | { at: string; by: InboxAuthor; kind: "renamed"; title: string }
  | { at: string; by: InboxAuthor; kind: "notes" }
  | { at: string; by: InboxAuthor; kind: "sent"; to: InboxAuthor; thread_id: string; /** Sent into a thread the card already linked (Start), not a new one. */ existing_thread: boolean };

/**
 * A card's history from its snapshots, oldest first in (one per store line),
 * newest first out: what each write changed. A line that changed nothing the
 * person reads (the person seeing an agent's drop) adds nothing.
 */
export function inboxCardHistory(snapshots: readonly InboxCard[]): InboxCardHistoryEntry[] {
  const out: InboxCardHistoryEntry[] = [];
  let before: InboxCard | null = null;
  for (const raw of snapshots) {
    const card = readInboxCard(raw);
    const at = card.heard_at;
    const by = card.heard_by;
    if (before === null) {
      out.push({ at: card.created_at, by: card.created_by, kind: "created", column: card.column, thread_id: card.threads[0] ?? null });
      if (card.sent) out.push({ at: card.sent.at, by, kind: "sent", to: card.sent.to, thread_id: card.sent.thread_id, existing_thread: false });
      before = card;
      continue;
    }
    // A line that changed nothing shown (the person seeing a drop) adds nothing: every entry
    // below is a difference. Two writes in one millisecond are still two entries.
    if (card.sent && (!before.sent || before.sent.at !== card.sent.at)) {
      out.push({ at, by, kind: "sent", to: card.sent.to, thread_id: card.sent.thread_id, existing_thread: before.threads.includes(card.sent.thread_id) });
    } else {
      for (const thread of card.threads) if (!before.threads.includes(thread)) out.push({ at, by, kind: "linked_thread", thread_id: thread });
    }
    const known = inboxCardRefsOf(before);
    for (const ref of inboxCardRefsOf(card)) if (!known.some((k) => k.url === ref.url)) out.push({ at, by, kind: "linked_ref", ref: ref.ref, ref_kind: ref.kind });
    if (card.title !== before.title) out.push({ at, by, kind: "renamed", title: card.title });
    if ((card.notes ?? null) !== (before.notes ?? null)) out.push({ at, by, kind: "notes" });
    if (card.column !== before.column) {
      if (card.column === "dropped") out.push({ at, by, kind: "dropped", reason: card.dropped?.reason ?? null });
      else if (before.column === "icebox" || before.column === "dropped") {
        if (card.column === (before.aside_from ?? "backlog") && by.kind === "person") out.push({ at, by, kind: "restored", column: card.column });
        else out.push({ at, by, kind: "moved", column: card.column, you: card.you });
      } else out.push({ at, by, kind: "moved", column: card.column, you: card.you });
    } else if (card.you !== before.you && card.you) out.push({ at, by, kind: "you", text: card.you });
    if (card.said !== before.said && card.said) out.push({ at, by, kind: "said", text: card.said });
    before = card;
  }
  return out.reverse();
}

/**
 * A card as every reader gets it: the record, its `threads` only those that
 * still exist, and `heard_seq` (additive): the store seq of the line that
 * last wrote to it (a line that only marks a drop seen is not a write), so
 * the Board tells news by seq, never by clock.
 */
export type InboxCardWire = InboxCard & { heard_seq?: number };

/**
 * Whether `next` differs from `prev` only in what the person saw (a drop's
 * `seen_at`): not a write to the card, so its `heard_seq` stays.
 */
export function isInboxCardSeenOnlyChange(prev: InboxCard, next: InboxCard): boolean {
  if (!prev.dropped || !next.dropped || prev.dropped.seen_at === next.dropped.seen_at) return false;
  return JSON.stringify({ ...next, dropped: { ...next.dropped, seen_at: prev.dropped.seen_at } }) === JSON.stringify(prev);
}

/** An agent's drop the person has not seen yet. */
export function isInboxCardDropUnseen(card: Pick<InboxCard, "column" | "dropped">): boolean {
  return card.column === "dropped" && card.dropped !== null && card.dropped.by.kind === "agent" && card.dropped.seen_at === null;
}

/** The line a card shows under its title: "You: …" in the person's columns, the agent's last word otherwise. */
export function inboxCardLine(card: Pick<InboxCard, "column" | "you" | "said">): string | null {
  if (isInboxCardPersonColumn(card.column) && card.you) return `You: ${card.you}`;
  return card.said;
}

/**
 * Whether a card is unread on the Board (approval "inbox-board-signal":
 * "bold when unread, like mail"): an agent wrote to it last, in a line after
 * the person's last look at the Board (`seenSeq`, the store's cursor when the
 * Board was last opened; null before the first look). By seq, never by
 * clock: two writes in one millisecond are told apart. The person's own
 * writes (a move, a drop) never make a card unread, and a mark that only
 * records the person saw a drop keeps `heard_seq`. A card without
 * `heard_seq` (an older Inbox) reads as unread until the first look.
 */
export function isInboxCardUnread(card: Pick<InboxCardWire, "heard_by" | "heard_seq">, seenSeq: number | null): boolean {
  if (card.heard_by.kind !== "agent") return false;
  return seenSeq === null || (card.heard_seq ?? 0) > seenSeq;
}

/** A sort key: the Board's column order. */
export function inboxCardColumnIndex(column: InboxCardColumn): number {
  return INBOX_CARD_COLUMNS.indexOf(column);
}

// Control characters other than whitespace, and the bidi controls (a line must read as written).
const REFUSED_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const REFUSED_CHARS_ALL = new RegExp(REFUSED_CHARS.source, "g");

/**
 * Text the agent did not write (a thread's subject, taken as a default
 * title) made acceptable instead of refused: the characters
 * normalizeInboxCardText refuses are removed.
 */
export function stripInboxCardRefusedChars(text: string): string {
  return text.replace(REFUSED_CHARS_ALL, "");
}

/**
 * A card's one line of text, made one line: every run of whitespace (line
 * breaks included) becomes one space, the ends trimmed. Refused (a message,
 * not the text) when it holds a control or bidi character, is empty, or is
 * longer than `max` characters.
 */
export function normalizeInboxCardText(value: unknown, field: string, max: number): { text: string } | { error: string } {
  if (typeof value !== "string") return { error: `${field}: a string.` };
  if (REFUSED_CHARS.test(value)) return { error: `${field}: no control or bidi characters.` };
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return { error: `${field}: empty.` };
  if ([...text].length > max) return { error: `${field}: at most ${max} characters (one line).` };
  return { text };
}
