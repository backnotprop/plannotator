/**
 * Grid's looks kept with the threads (inbox-grid-seen.ts), what a list row carries for Grid (inbox-grid-row.ts), and a
 * linked machine's clock (inbox-peer-link.ts `peerClockMs`), against a scratch folder. What regresses if these fail:
 * a look held in an outbox lands over a later one, a look from a clock ahead claims what it never showed, a look is
 * lost on restart, a broken file is written over, a row carries no look or no checklist for Grid, or a linked
 * machine a few seconds apart is read as a clock that is off.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxListRow, InboxSteps } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { createInboxGridSeen, gridSeenOf, INBOX_GRID_SEEN_FILE } from "./inbox-grid-seen";
import { gridRowDecorator, gridRowStripped } from "./inbox-grid-row";
import { peerClockMs } from "./inbox-peer-link";

/** A scratch data folder in the system's temp folder. */
const scratch = () => mkdtempSync(join(tmpdir(), "inbox-grid-seen-"));

test("each field keeps its larger value, so a late look never goes back; kept across a restart", () => {
  const dir = scratch();
  const seen = createInboxGridSeen(dir);
  expect(seen.mark([{ thread: "msg_a", through: 500, at: 900 }])).toEqual({ msg_a: { through: 500, at: 900 } });
  // A look held in an outbox since before: lands as of then, never over the later one.
  expect(seen.mark([{ thread: "msg_a", through: 300, at: 700 }])).toEqual({ msg_a: { through: 500, at: 900 } });
  seen.mark([{ thread: "msg_a", through: 800, at: 1000 }]);
  expect(createInboxGridSeen(dir).get("msg_a")).toEqual({ through: 800, at: 1000 });
});

test("a write's times ahead of this machine's clock are now; a bad body is refused", () => {
  expect(gridSeenOf({ seen: [{ thread: "msg_a", through: 5_000, at: 9_000 }] }, 4_000)).toEqual([{ thread: "msg_a", through: 4_000, at: 4_000 }]);
  expect(() => gridSeenOf({ seen: [] }, 1)).toThrow();
  expect(() => gridSeenOf({ seen: [{ thread: "../x", through: 1, at: 1 }] }, 1)).toThrow();
  expect(() => gridSeenOf({ seen: [{ thread: "msg_a", through: "1", at: 1 }] }, 1)).toThrow();
});

test("nothing is written until a look comes; a file that cannot be read is moved aside, never written over", () => {
  const dir = scratch();
  const seen = createInboxGridSeen(dir);
  expect(seen.get("msg_a")).toBeUndefined();
  expect(existsSync(join(inboxDir(dir), INBOX_GRID_SEEN_FILE))).toBe(false);
  const other = scratch();
  mkdirSync(inboxDir(other), { recursive: true });
  writeFileSync(join(inboxDir(other), INBOX_GRID_SEEN_FILE), "{ not json");
  expect(createInboxGridSeen(other).get("msg_a")).toBeUndefined();
  expect(readdirSync(inboxDir(other)).some((name) => name.startsWith(`${INBOX_GRID_SEEN_FILE}.unreadable-`))).toBe(true);
});

test("a row carries its look and its latest checklist's progress; a row with neither is unchanged", () => {
  const row = (id: string) => ({ thread_id: id }) as InboxListRow;
  const list = (thread: string, updated: string, steps: InboxSteps["steps"]) => ({ id: `stp_${thread}${updated}`, project_id: "prj_a", thread_id: thread, agent: { kind: "agent", host: "claude-code", session: "ses_a", name: null }, steps, updated_at: updated }) as InboxSteps;
  const decorate = gridRowDecorator({ get: (id) => (id === "msg_a" ? { through: 5, at: 9 } : undefined) }, [
    list("msg_a", "2026-11-24T10:00:00.000Z", [{ step: "Old", status: "doing", note: null, at: "2026-11-24T10:00:00.000Z" }]),
    list("msg_a", "2026-11-24T11:00:00.000Z", [
      { step: "Read the code", status: "done", note: null, at: "2026-11-24T10:40:00.000Z" },
      { step: "Write the migration", status: "doing", note: null, at: "2026-11-24T11:00:00.000Z" },
      { step: "Skip", status: "dropped", note: "not needed", at: "2026-11-24T10:50:00.000Z" },
    ]),
  ]);
  expect(decorate(row("msg_a"))).toEqual({ thread_id: "msg_a", grid_seen: { through: 5, at: 9 }, steps_progress: { done: 1, total: 2, doing: "Write the migration", at: "2026-11-24T11:00:00.000Z" } } as InboxListRow);
  const plain = row("msg_b");
  expect(decorate(plain)).toBe(plain);
  // The Checklist switch off: no lists, no progress.
  expect(gridRowDecorator({ get: () => undefined }, null)(row("msg_a"))).toEqual(row("msg_a"));
});

test("a linked machine's clock: whole minutes ahead or behind, nothing within two minutes or from an older Inbox", () => {
  const arrived = Date.parse("2026-11-24T10:00:00.000Z");
  expect(peerClockMs("2026-11-24T10:00:40.000Z", arrived)).toBe(0);
  expect(peerClockMs("2026-11-24T10:21:10.000Z", arrived)).toBe(21 * 60_000);
  expect(peerClockMs("2026-11-24T09:35:00.000Z", arrived)).toBe(-25 * 60_000);
  expect(peerClockMs(undefined, arrived)).toBe(0);
});

test("a look is never forgotten for age or count while its thread is here; one whose thread is gone is", () => {
  const dir = scratch();
  const here = new Set(["msg_kept", "msg_new"]);
  const seen = createInboxGridSeen(dir, (thread) => here.has(thread));
  seen.mark([{ thread: "msg_kept", through: 1, at: 1 }, { thread: "msg_gone", through: 1, at: 1 }]);
  // Thousands of newer looks: the oldest one, of a thread still here, stays.
  for (let i = 0; i < 12; i += 1) seen.mark(Array.from({ length: 200 }, (_, j) => ({ thread: `msg_n${i}_${j}`, through: 10 + i, at: 10 + i })).concat([{ thread: "msg_new", through: 9, at: 9 }]));
  expect(seen.get("msg_kept")).toEqual({ through: 1, at: 1 });
  expect(seen.get("msg_gone")).toBeUndefined();
  expect(createInboxGridSeen(dir, () => true).get("msg_kept")).toEqual({ through: 1, at: 1 });
});

test("a list read that did not ask for Grid gets a linked machine's row without Grid's fields; one without them is the same object", () => {
  const far = { thread_id: "msg_a", grid_seen: { through: 1, at: 2 }, steps_progress: { done: 1, total: 2, doing: null, at: "x" }, pulls: { count: 1, headline: { key: "k", state: "open" }, items: [{ key: "k" }] } } as unknown as InboxListRow;
  expect(gridRowStripped(far)).toEqual({ thread_id: "msg_a", pulls: { count: 1, headline: { key: "k", state: "open" } } } as unknown as InboxListRow);
  const plain = { thread_id: "msg_b", pulls: { count: 1, headline: { key: "k", state: "open" } } } as unknown as InboxListRow;
  expect(gridRowStripped(plain)).toBe(plain);
});
