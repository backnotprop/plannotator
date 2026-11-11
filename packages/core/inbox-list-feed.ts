/**
 * Plannotator Inbox: the list feed, the agreement between the server and a window about getting only what the
 * window shows (stage 3). Nothing here is served yet: these are the wire types, the one place rule, the paging
 * rule and the pure applier that the server, its tests and the window all build on.
 *
 * - A window asks for a first page (`GET /api/inbox/threads?page=1`): every row above Quiet, every pinned row,
 *   the whole Snoozed band, then the top of Quiet. Older Quiet rows come a page at a time (`after`), or up to a
 *   row (`through`).
 * - While it is open, every change reaches it as a `list` frame on its event stream (`/events?…&list=1`): the
 *   rows that changed, where each now sits, and the counts the window draws without holding every row.
 * - After a gap (sleep, a dropped connection) it asks what changed since the version it holds (`since`).
 *
 * The server works out every row and its place (the store's row plus pins, snoozes by its clock, launches,
 * checklists and PRs); the window never does. The window keeps its own held list, "N new", Show and settle
 * rules unchanged, over the rows it holds.
 *
 * Every field is additive to what the routes answer today, and a reader that does not ask (no `page`, no
 * `list=1`: an older window, the paired phone, a linked machine, agents) gets exactly today's answers.
 */

import type { FoldSnippet } from "./inbox-folding";
import { inboxRowSnoozed, inboxRowAsOf } from "./inbox-snooze";
import { inboxRowArchived, type InboxAgentsGroup, type InboxListGroupId, type InboxListRow, type InboxMessageWire, INBOX_SECTIONS } from "./inbox-types";

// ─────────────────────────── versions ───────────────────────────

/** `<run>.<n>`: this Inbox run (hex), then a count that grows by one per published change. A run's versions are never reused. */
export type InboxFeedVersion = string;

/** `a` before (< 0), equal to (0) or after (> 0) `b`; null when they are from different runs (or malformed): a gap. */
export function inboxFeedVersionOrder(a: InboxFeedVersion, b: InboxFeedVersion): number | null {
  const left = /^([0-9a-f]+)\.(\d+)$/.exec(a);
  const right = /^([0-9a-f]+)\.(\d+)$/.exec(b);
  if (!left || !right || left[1] !== right[1]) return null;
  return Number(left[2]) - Number(right[2]);
}

// ─────────────────────────── a row's place ───────────────────────────

/** The groups in the order the list draws them: the sections (`INBOX_SECTIONS`), then the Snoozed band. */
export const INBOX_LIST_GROUPS: readonly InboxListGroupId[] = [...INBOX_SECTIONS.map((section) => section.id), "snoozed"];

/**
 * Where a row sits, worked out by the server as of its clock (`inboxRowPlace`).
 *
 * Order inside a group is today's (`inboxListSections`, `inboxSplitSnoozed`): a section newest `at` first, ties on
 * the thread id A→Z; the Snoozed band soonest `at` first, ties the same. `inboxPlaceCompare` is that order.
 */
export interface InboxRowPlace {
  /** Its section, or "snoozed" (the band under Quiet) while a snooze runs. */
  group: InboxListGroupId;
  /** The time it is ordered by: `last_at` as of now (a snooze that ran out moves it), or the snooze's `until` in the band. */
  at: string;
  /** Resolved and not come back: the window keeps it out of the list (Settings' Archived block reads its own route). */
  archived: boolean;
}

/**
 * A row's place by `now`. `row` is the row as the window's list reads it (pins, snooze, launch, checklist and PRs
 * already on it), before or after `inboxRowAsOf`: a snooze past its time is a return either way.
 */
export function inboxRowPlace(row: InboxListRow, now: Date): InboxRowPlace {
  const archived = inboxRowArchived(row);
  const asOf = inboxRowAsOf(row, now);
  if (!archived && inboxRowSnoozed(asOf, now)) return { group: "snoozed", at: asOf.snoozed!.until, archived };
  return { group: asOf.section, at: asOf.last_at, archived };
}

/** A row and its place, keyed by its thread id: what pages, frames and the window's held list are made of. */
export interface InboxPlacedRow {
  row: InboxListRow;
  place: InboxRowPlace;
}

/** List order: group, then inside the group today's order. Negative: `a` is drawn above `b`. */
export function inboxPlaceCompare(a: { place: InboxRowPlace; row: { thread_id: string } }, b: { place: InboxRowPlace; row: { thread_id: string } }): number {
  const groups = INBOX_LIST_GROUPS.indexOf(a.place.group) - INBOX_LIST_GROUPS.indexOf(b.place.group);
  if (groups !== 0) return groups;
  const at = a.place.group === "snoozed" ? Date.parse(a.place.at) - Date.parse(b.place.at) : b.place.at.localeCompare(a.place.at);
  return at || a.row.thread_id.localeCompare(b.row.thread_id);
}

// ─────────────────────────── counts ───────────────────────────

/** One project's numbers, as today's sidebar folder carries them (`threads`, `unread`, `listed`, `archived`). */
export interface InboxListProjectCounts {
  id: string;
  /** The machine whose project it is, on the merged view (`machines=1`) only. */
  machine?: string;
  /** Every thread, archived and snoozed ones too. */
  threads: number;
  /** Rows drawn bold (`unread`), not snoozed. */
  unread: number;
  /** Threads the window's list holds: not archived. */
  listed: number;
  archived: number;
}

/** What the window counts without holding every row: the same rules as today's folders, tab title and group headers. */
export interface InboxListCounts {
  /** Rows per group, archived left out (a group with none is absent). */
  groups: Partial<Record<InboxListGroupId, number>>;
  /**
   * The browser tab's number (tabCount.ts, approval "inbox-tab-count"): threads with agent messages the person has
   * not looked at (`unseen > 0`), not archived, not in the Snoozed band.
   */
  tab: number;
  /** Every project the folders list, in their order, with no rows too (all zero). */
  projects: InboxListProjectCounts[];
}

/** The counts of a whole list (every row, not only a page's). `projects`: every project the folders list, in order. */
export function inboxListCounts(rows: Iterable<InboxPlacedRow>, projects: readonly { id: string; machine?: string }[]): InboxListCounts {
  const groups: Partial<Record<InboxListGroupId, number>> = {};
  const keyOf = (id: string, machine?: string) => `${machine ?? ""}\0${id}`;
  const byProject = new Map(projects.map((p) => [keyOf(p.id, p.machine), { id: p.id, ...(p.machine !== undefined ? { machine: p.machine } : {}), threads: 0, unread: 0, listed: 0, archived: 0 }]));
  let tab = 0;
  for (const { row, place } of rows) {
    const folder = byProject.get(keyOf(row.project.id, row.machine));
    if (folder) {
      folder.threads += 1;
      if (place.archived) folder.archived += 1;
      else folder.listed += 1;
      if (row.unread && place.group !== "snoozed") folder.unread += 1;
    }
    if (place.archived) continue;
    groups[place.group] = (groups[place.group] ?? 0) + 1;
    if (row.unseen > 0 && place.group !== "snoozed") tab += 1;
  }
  return { groups, tab, projects: [...byProject.values()] };
}

// ─────────────────────────── the wire ───────────────────────────

/** One row as it is now. `row: null`: the thread is gone (deleted, or a linked machine's row withdrawn). */
export interface InboxRowChange {
  thread_id: string;
  row: InboxListRow | null;
  /** Null exactly when `row` is. */
  place: InboxRowPlace | null;
  /** The store line that moved it, when one did; null for a draft, pin, snooze, session, PR state or clock change. */
  seq: number | null;
}

/**
 * SSE `event: list`. Only to a reader that asked (`/events?…&list=1`): a window, the phone's door or a linked machine
 * (the same person on every door, the same rows; `machines=1` for the merged view where the door allows it).
 */
export interface InboxListFrame<P = unknown> {
  v: 1;
  version: InboxFeedVersion;
  /** The version it follows. A window holding an older one has a gap: it reads `since`. */
  after: InboxFeedVersion;
  /** The store cursor when it was published. */
  cursor: number;
  changes: InboxRowChange[];
  counts: InboxListCounts;
  /**
   * The sidebar's pins, thread ids in pin order: only when they changed (a pin, an unpin, a reorder, a pinned thread
   * gone). A pin or an unpin also changes that row (`pinned_at`), so its row is in `changes`.
   */
  pins?: string[];
  /** The sidebar's Agents: only when they moved. */
  agents?: InboxAgentsGroup[];
  /** The sidebar's folders as a page carries them (`projects`): only when a folder came, went, or its name or picture changed. */
  projects?: P[];
}

/**
 * A page of the list. `head` is today's list model without its rows and folders (`update`, `notice`, `restart_*`,
 * `session_labels`, `self`, `machines`…); `projects` are today's folders. Both stay typed by the window (`H`, `P`).
 *
 * GET /api/inbox/threads?page=1[&after=<cursor>][&through=<thread id>][&limit=200][&machines=1]
 */
export interface InboxListPage<H = Record<string, unknown>, P = unknown> {
  serverSession: string;
  cursor: number;
  /** Frames after this version apply on top. */
  version: InboxFeedVersion;
  head: H;
  projects: P[];
  counts: InboxListCounts;
  pins: string[];
  agents?: InboxAgentsGroup[];
  /** In list order (`inboxPageRows`). */
  rows: InboxPlacedRow[];
  /** The cursor of the last Quiet row sent (`inboxListCursor`): pass it as `after`. Null: Quiet is all here. */
  next: string | null;
}

/**
 * GET /api/inbox/threads?page=1&since=<version>: what changed after `since`, each changed row once as it is now.
 * A version this run no longer knows gets a first page instead (`isInboxListCatchUp` tells them apart).
 */
export interface InboxListCatchUp<H = Record<string, unknown>, P = unknown> {
  serverSession: string;
  cursor: number;
  version: InboxFeedVersion;
  since: InboxFeedVersion;
  head: H;
  projects: P[];
  counts: InboxListCounts;
  pins: string[];
  agents?: InboxAgentsGroup[];
  changes: InboxRowChange[];
}

export function isInboxListCatchUp<H, P>(answer: InboxListCatchUp<H, P> | InboxListPage<H, P>): answer is InboxListCatchUp<H, P> {
  return Array.isArray((answer as InboxListCatchUp<H, P>).changes);
}

// ─────────────────────────── pages ───────────────────────────

/** Quiet rows on a page, unless `limit` says otherwise. */
export const INBOX_LIST_PAGE_LIMIT = 200;
/** The most Quiet rows one page sends. */
export const INBOX_LIST_PAGE_MAX = 500;

/** A Quiet row's cursor, for `after` and `next`: its `at`, then its thread id. */
export function inboxListCursor(entry: InboxPlacedRow): string {
  return `${entry.place.at}|${entry.row.thread_id}`;
}

function cursorPlace(cursor: string): { place: InboxRowPlace; row: { thread_id: string } } | null {
  const bar = cursor.lastIndexOf("|");
  if (bar <= 0 || bar === cursor.length - 1) return null;
  return { place: { group: "quiet", at: cursor.slice(0, bar), archived: false }, row: { thread_id: cursor.slice(bar + 1) } };
}

/** The row is in Quiet below the cursor `edge` (a Quiet row not loaded yet). False for every other group, and with no edge. */
export function inboxBeyondEdge(entry: InboxPlacedRow, edge: string | null): boolean {
  if (edge === null || entry.place.group !== "quiet") return false;
  const at = cursorPlace(edge);
  return at !== null && inboxPlaceCompare(entry, at) > 0;
}

/**
 * The rows a page sends, from every row of the list (any order; archived ones are left out), in list order:
 * - a first page (`after` null): every row above Quiet, the whole Snoozed band, every pinned row (`pins`, an
 *   archived one too: it stays in the sidebar), and the first `limit` Quiet rows;
 * - a next page (`after`): the `limit` Quiet rows after that cursor;
 * - `through` (a thread id): as far as that row too, whatever the limit, when it is in Quiet.
 * `next` is the cursor of the last Quiet row sent, null when no Quiet row is left after it.
 * `sorted`: the rows come in list order already (`inboxPlaceCompare`), so none is sorted again.
 */
export function inboxPageRows(
  all: Iterable<InboxPlacedRow>,
  options: { after?: string | null; through?: string | null; limit?: number; pins?: readonly string[]; sorted?: boolean } = {},
): { rows: InboxPlacedRow[]; next: string | null } {
  const limit = Math.max(1, Math.min(options.limit ?? INBOX_LIST_PAGE_LIMIT, INBOX_LIST_PAGE_MAX));
  const pinned = new Set(options.pins ?? []);
  // An archived thread stays pinned (approval "inbox-pinned-threads"): a first page sends it for the sidebar only.
  const kept = [...all].filter((entry) => !entry.place.archived || (!options.after && pinned.has(entry.row.thread_id)));
  // `sorted`: `all` is already in list order (the server keeps it so), and is not sorted again.
  const listed = options.sorted ? kept : kept.sort(inboxPlaceCompare);
  const after = options.after ? cursorPlace(options.after) : null;
  const quiet = listed.filter((entry) => entry.place.group === "quiet" && !entry.place.archived && (!after || inboxPlaceCompare(entry, after) > 0));
  let take = Math.min(limit, quiet.length);
  if (options.through) {
    const at = quiet.findIndex((entry) => entry.row.thread_id === options.through);
    if (at >= 0) take = Math.max(take, at + 1);
  }
  const sent = new Set(quiet.slice(0, take));
  const rows = after
    ? quiet.slice(0, take)
    : listed.filter((entry) => entry.place.group !== "quiet" || sent.has(entry) || pinned.has(entry.row.thread_id));
  const next = take < quiet.length && take > 0 ? inboxListCursor(quiet[take - 1]!) : null;
  return { rows, next };
}

// ─────────────────────────── the window's held list ───────────────────────────

/** A row the window holds, with the version it was taken at: a newer one always wins, whatever arrived first. */
export interface InboxHeldRow extends InboxPlacedRow {
  version: InboxFeedVersion;
}

/** What the window holds of the list: every row it took, by thread id, and the newest of everything else. */
export interface InboxListHeld<H = Record<string, unknown>, P = unknown> {
  /** The newest version taken from a frame, a page or a catch-up. Frames that follow it apply. */
  version: InboxFeedVersion;
  cursor: number;
  head: H;
  projects: P[];
  counts: InboxListCounts;
  pins: string[];
  agents?: InboxAgentsGroup[];
  /** Every row the window took: the list's (`inboxListShown`), and every pinned row wherever it sits (archived ones too). */
  rows: Record<string, InboxHeldRow>;
  /** The loaded edge of Quiet (the last page's `next`). Null: all of Quiet is loaded. */
  next: string | null;
}

/** The held list from a first page. */
export function inboxListHeld<H, P>(page: InboxListPage<H, P>): InboxListHeld<H, P> {
  const rows: Record<string, InboxHeldRow> = {};
  for (const entry of page.rows) rows[entry.row.thread_id] = { ...entry, version: page.version };
  return { version: page.version, cursor: page.cursor, head: page.head, projects: page.projects, counts: page.counts, pins: page.pins, ...(page.agents ? { agents: page.agents } : {}), rows, next: page.next };
}

/**
 * Changes taken at `version`, each row newest-wins. A row new to the window joins only when it is not past the loaded
 * edge, and an archived row leaves, except a pinned one: the sidebar shows every pin, wherever its row sits.
 */
function takeChanges(rows: Record<string, InboxHeldRow>, changes: readonly InboxRowChange[], version: InboxFeedVersion, edge: string | null, pins: readonly string[]): Record<string, InboxHeldRow> {
  const out = { ...rows };
  const pinned = new Set(pins);
  for (const change of changes) {
    const held = out[change.thread_id];
    if (held && (inboxFeedVersionOrder(held.version, version) ?? -1) > 0) continue;
    if (!change.row || !change.place || (change.place.archived && !pinned.has(change.thread_id))) {
      delete out[change.thread_id];
      continue;
    }
    const entry = { row: change.row, place: change.place, version };
    // Never an island below the edge: a row the window does not hold joins only above it (or pinned).
    if (!held && inboxBeyondEdge(entry, edge) && !pinned.has(change.thread_id)) continue;
    out[change.thread_id] = entry;
  }
  // An archived row held only for its pin goes with the pin.
  for (const [id, entry] of Object.entries(out)) if (entry.place.archived && !pinned.has(id)) delete out[id];
  return out;
}

/**
 * A frame over the held list. "gap": the frame follows a version newer than the one held (a frame was missed): read
 * `since` the held version. A frame the window already has (its version not after the held one) changes nothing.
 */
export function applyInboxListFrame<H, P>(held: InboxListHeld<H, P>, frame: InboxListFrame<P>): InboxListHeld<H, P> | "gap" {
  const newer = inboxFeedVersionOrder(frame.version, held.version);
  const follows = inboxFeedVersionOrder(frame.after, held.version);
  if (newer === null || follows === null) return "gap";
  if (newer <= 0) return held;
  if (follows > 0) return "gap";
  const pins = frame.pins ?? held.pins;
  return {
    ...held,
    version: frame.version,
    cursor: frame.cursor,
    counts: frame.counts,
    pins,
    ...(frame.agents ? { agents: frame.agents } : {}),
    ...(frame.projects ? { projects: frame.projects } : {}),
    rows: takeChanges(held.rows, frame.changes, frame.version, held.next, pins),
  };
}

/**
 * A catch-up over the held list (after a gap). A first page in its place (the server did not know the version)
 * starts the held list again.
 */
export function applyInboxListCatchUp<H, P>(held: InboxListHeld<H, P>, answer: InboxListCatchUp<H, P> | InboxListPage<H, P>): InboxListHeld<H, P> {
  if (!isInboxListCatchUp(answer)) return inboxListHeld(answer);
  const order = inboxFeedVersionOrder(answer.version, held.version);
  if (order === null) return held;
  const newest = order >= 0;
  const pins = newest ? answer.pins : held.pins;
  return {
    ...held,
    ...(newest
      ? { version: answer.version, cursor: answer.cursor, head: answer.head, projects: answer.projects, counts: answer.counts, pins, ...(answer.agents ? { agents: answer.agents } : {}) }
      : {}),
    rows: takeChanges(held.rows, answer.changes, answer.version, held.next, pins),
  };
}

/**
 * A next page (`after`) or a page `through` a row, over the held list: its rows join (newest-wins), and the edge
 * moves to the page's `next`. Nothing else: the version, counts and pins follow frames and catch-ups only, since a
 * page carries only its slice of the list. `catchUpFrom`: the page is older than what the window holds, so a change
 * published in between may be missing from it; read `since` that version and apply it (`applyInboxListCatchUp`).
 * A page from another run (the Inbox restarted) is not taken: catch up from the held version, which answers a
 * first page.
 */
export function mergeInboxListPage<H, P>(held: InboxListHeld<H, P>, page: InboxListPage<H, P>): { held: InboxListHeld<H, P>; catchUpFrom: InboxFeedVersion | null } {
  const order = inboxFeedVersionOrder(page.version, held.version);
  if (order === null) return { held, catchUpFrom: held.version };
  const rows = { ...held.rows };
  for (const entry of page.rows) {
    const had = rows[entry.row.thread_id];
    if (had && (inboxFeedVersionOrder(had.version, page.version) ?? -1) > 0) continue;
    rows[entry.row.thread_id] = { ...entry, version: page.version };
  }
  // The edge only moves down: a page answered late never hides rows a later one already loaded.
  const edgeOf = (cursor: string) => cursorPlace(cursor) ?? { place: { group: "quiet" as const, at: "", archived: false }, row: { thread_id: "" } };
  const next = held.next === null || page.next === null ? null : inboxPlaceCompare(edgeOf(page.next), edgeOf(held.next)) > 0 ? page.next : held.next;
  return { held: { ...held, rows, next }, catchUpFrom: order < 0 ? page.version : null };
}

/**
 * The rows the list draws, in order: what the window holds, without Quiet rows past the loaded edge and without
 * archived ones (both held only for the sidebar's pins; `held.pins` orders those).
 */
export function inboxListShown(held: Pick<InboxListHeld, "rows" | "next">): InboxHeldRow[] {
  return Object.values(held.rows)
    .filter((entry) => !entry.place.archived && !inboxBeyondEdge(entry, held.next))
    .sort(inboxPlaceCompare);
}

// ─────────────────────────── thread pages ───────────────────────────

/** A thread with more messages than this opens as a page (`?page=1`): some of its messages come as stubs. At or under it, the read is today's, byte for byte. */
export const INBOX_THREAD_PAGE_MIN = 40;
/** The newest messages a thread page always sends whole. */
export const INBOX_THREAD_PAGE_TAIL = 20;
/** The most messages one `messages?ids=` read names. */
export const INBOX_MESSAGE_IDS_MAX = 100;

/**
 * A message a thread page sends without its body: everything else the thread pane reads of a folded message (its
 * author, time, seq, questions and their states, files, delivery), and the folded line's words worked out by the
 * server (`foldSnippet` over the whole thread). The window asks for the bodies (`messages?ids=`) on unfold, a jump
 * or search landing inside it, and Copy thread.
 */
export type InboxMessageStub = Omit<InboxMessageWire, "body"> & { stub: true; fold: FoldSnippet };

/** GET /api/inbox/threads/:id/messages?ids=a,b,c (at most `INBOX_MESSAGE_IDS_MAX`): the messages whole. */
export interface InboxThreadMessagesAnswer {
  cursor: number;
  messages: InboxMessageWire[];
}

export function isInboxMessageStub(message: InboxMessageWire | InboxMessageStub): message is InboxMessageStub {
  return (message as InboxMessageStub).stub === true;
}

/** A thread page's messages with the bodies read so far put in (`whole`, by id); stubs not read yet stay stubs. */
export function fillInboxMessageStubs(messages: readonly (InboxMessageWire | InboxMessageStub)[], whole: readonly InboxMessageWire[]): (InboxMessageWire | InboxMessageStub)[] {
  const byId = new Map(whole.map((message) => [message.id, message]));
  return messages.map((message) => (isInboxMessageStub(message) ? (byId.get(message.id) ?? message) : message));
}
