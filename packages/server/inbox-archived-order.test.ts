/**
 * The Archived order when two threads are archived at the same instant (a fast machine archives two in one
 * millisecond): newest archived first, a tie on the thread id, on this Inbox's read and on the merged read across
 * machines. The failure this guards: a tie read in another order on another run, and "Show 20 more" (each read is
 * its first `offset + limit`) skipping or repeating a row that sits across the page edge.
 * On a real store in a temp dir with a fixed clock; no Inbox server.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxListRow } from "@plannotator/core/inbox-types";
import { inboxArchivedRows } from "@plannotator/shared/inbox/list";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { mergeArchived, type ArchivedPage } from "./inbox-archived-merged";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const M = "ibx_01K0000000000000000000000M";

function archivedStore() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-archived-order-")));
  roots.push(dir);
  const clock = { now: Date.parse("2026-11-15T09:00:00.000Z") };
  const store = InboxStore.open(join(dir, "data"), { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
  const send = (thread: string) => store.sendMessage({ project_id: project.id, author: AGENT, thread, body: thread }).message.id;
  const first = send("first");
  const second = send("second");
  const third = send("third");
  clock.now += 60_000;
  // Two in the same instant, one a second later.
  store.resolveThread(first, true, "person");
  store.resolveThread(second, true, "person");
  clock.now += 1_000;
  store.resolveThread(third, true, "person");
  return { store, first, second, third };
}

test("two archived at the same instant read in one order every time: newest first, the tie on the thread id", () => {
  const { store, first, second, third } = archivedStore();
  const tied = [first, second].sort();
  const order = inboxArchivedRows(store.listRows()).map((row) => row.thread_id);
  expect(order).toEqual([third, ...tied]);
  // The same rows in another order read the same.
  expect(inboxArchivedRows([...store.listRows()].reverse()).map((row) => row.thread_id)).toEqual(order);
});

test("pages across the tie neither skip nor repeat a row, on this Inbox's read and on the merged read", () => {
  const { store } = archivedStore();
  const own = inboxArchivedRows(store.listRows());
  const order = own.map((row) => row.thread_id);
  // This Inbox's read: each page a slice of the one order.
  const paged = [0, 1, 2].flatMap((offset) => own.slice(offset, offset + 1).map((row) => row.thread_id));
  expect(paged).toEqual(order);

  // The merged read: a linked machine's row archived at the same instant as the tie, each side asked for its first
  // offset + limit as the Archived group asks.
  const tieAt = own[1]!.resolved_at!;
  const far = { ...own[1]!, thread_id: "msg_00far", machine: M } as InboxListRow;
  const page = (offset: number, limit: number) => {
    const ownPage: ArchivedPage = { serverSession: "s", cursor: 1, project: null, projects: [], total: own.length, offset, limit, threads: own.slice(0, offset + limit) };
    return mergeArchived(ownPage, [{ machine: M, page: { total: 1, threads: [{ ...far, resolved_at: tieAt }], projects: [] }, away: false }], () => false).threads.map((row) => row.thread_id);
  };
  const whole = page(0, 4);
  expect(whole).toEqual([order[0], "msg_00far", order[1], order[2]]);
  expect([0, 1, 2, 3].flatMap((offset) => page(offset, 1))).toEqual(whole);
  expect([...page(0, 2), ...page(2, 2)]).toEqual(whole);
});
