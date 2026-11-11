/**
 * Fixtures for the list feed (inbox-list-feed.ts), shared by the server's tests and the window's: a row maker, a
 * small server that answers pages, frames and catch-ups from a set of rows by the contract's own rules, and one
 * worked scenario. Test-only; nothing in the product imports this.
 */

import {
  inboxListCounts,
  inboxPageRows,
  inboxRowPlace,
  type InboxListCatchUp,
  type InboxListFrame,
  type InboxListPage,
  type InboxPlacedRow,
  type InboxRowChange,
} from "./inbox-list-feed";
import type { InboxListRow, InboxSectionId } from "./inbox-types";

/** Thread ids that sort like real ones (`msg_` and 26 characters). */
export function feedThreadId(n: number): string {
  return `msg_${String(n).padStart(26, "0")}`;
}

/** A list row with every required field; `section`, `last_at` and the rest as given. */
export function feedRow(n: number, fields: Partial<InboxListRow> & { section?: InboxSectionId } = {}): InboxListRow {
  const at = fields.last_at ?? new Date(Date.UTC(2026, 10, 1) + n * 60_000).toISOString();
  return {
    thread_id: feedThreadId(n),
    project_id: "prj_web",
    subject: `Thread ${n}`,
    author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" },
    created_at: at,
    last_at: at,
    last_author: "agent",
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: false,
    project: { id: "prj_web", name: "web" },
    thread_name: null,
    section: "quiet",
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...fields,
  };
}

/**
 * A server in miniature: holds every row, publishes each change as one frame (the versions `<run>.<n>`), and answers
 * first pages, next pages and catch-ups. `now` is the clock places are worked out by.
 */
export function feedServer(options: { run?: string; now?: Date; projects?: { id: string; machine?: string }[]; head?: Record<string, unknown> } = {}) {
  const run = options.run ?? "a1b2c3";
  const now = options.now ?? new Date(Date.UTC(2026, 10, 2));
  const projects = options.projects ?? [{ id: "prj_web" }];
  const head = options.head ?? {};
  const rows = new Map<string, InboxListRow>();
  let pins: string[] = [];
  let n = 0;
  let cursor = 0;
  /** Each version's changed thread ids, for catch-ups. */
  const changed: string[][] = [];
  const version = () => `${run}.${n}`;
  /** A row as the list serves it: `pinned_at` on a pinned one (the server's decoration). */
  const served = (row: InboxListRow): InboxListRow => (pins.includes(row.thread_id) ? { ...row, pinned_at: "2026-11-01T00:00:00.000Z" } : row);
  const placed = (): InboxPlacedRow[] => [...rows.values()].map((row) => ({ row: served(row), place: inboxRowPlace(row, now) }));
  const counts = () => inboxListCounts(placed(), projects);
  const changeOf = (id: string, seq: number | null): InboxRowChange => {
    const row = rows.get(id) ?? null;
    return { thread_id: id, row: row ? served(row) : null, place: row ? inboxRowPlace(row, now) : null, seq };
  };

  return {
    version,
    /** Put rows (or `null`: delete) and pins, and return the one frame that says so. */
    change(next: (InboxListRow | { gone: string })[], nextPins?: string[]): InboxListFrame {
      const after = version();
      n += 1;
      cursor += 1;
      const ids: string[] = [];
      for (const item of next) {
        if ("gone" in item) {
          rows.delete(item.gone);
          ids.push(item.gone);
        } else {
          rows.set(item.thread_id, item);
          ids.push(item.thread_id);
        }
      }
      const before = pins;
      // A deleted thread leaves the pins; a pin or an unpin changes that row (`pinned_at`).
      pins = [...new Set(nextPins ?? pins)].filter((id) => rows.has(id));
      const pinsMoved = pins.join() !== before.join();
      for (const id of [...before, ...pins]) if (before.includes(id) !== pins.includes(id) && rows.has(id) && !ids.includes(id)) ids.push(id);
      changed.push(ids);
      return { v: 1, version: version(), after, cursor, changes: ids.map((id) => changeOf(id, cursor)), counts: counts(), ...(pinsMoved ? { pins } : {}) };
    },
    page(query: { after?: string | null; through?: string | null; limit?: number } = {}): InboxListPage {
      const { rows: sent, next } = inboxPageRows(placed(), { ...query, pins });
      return { serverSession: run, cursor, version: version(), head, projects: [], counts: counts(), pins, rows: sent, next };
    },
    catchUp(since: string): InboxListCatchUp | InboxListPage {
      const match = /^([0-9a-f]+)\.(\d+)$/.exec(since);
      if (!match || match[1] !== run || Number(match[2]) > n) return this.page();
      const ids = [...new Set(changed.slice(Number(match[2])).flat())];
      return { serverSession: run, cursor, version: version(), since, head, projects: [], counts: counts(), pins, changes: ids.map((id) => changeOf(id, null)) };
    },
  };
}

/**
 * The worked scenario: a list with three Waiting rows and 300 Quiet ones, a first page of 200 Quiet rows, then
 * three frames: a Quiet row past the edge gets an agent's message (it joins New), a held Quiet row is archived, and
 * a row past the edge changes and stays there (only the counts move).
 */
export function feedScenario() {
  const server = feedServer();
  const waiting = [1, 2, 3].map((n) => feedRow(n, { section: "waiting", unread: true, unseen: 1, questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: "Ship it?" } }));
  const quiet = Array.from({ length: 300 }, (_, i) => feedRow(10 + i));
  server.change([...waiting, ...quiet]);
  const first = server.page();
  const deep = quiet[0]!; // the oldest Quiet row: past the edge
  const frames = [
    server.change([{ ...deep, section: "new", unread: true, unseen: 1, last_at: "2026-11-02T00:00:00.000Z", last_author: "agent" }]),
    server.change([{ ...quiet[299]!, resolved_at: "2026-11-02T00:00:00.000Z" }]),
    server.change([{ ...quiet[5]!, subject: "Renamed" }]),
  ];
  return { server, first, frames, deep: deep.thread_id, archived: quiet[299]!.thread_id, unchanged: quiet[5]!.thread_id };
}
