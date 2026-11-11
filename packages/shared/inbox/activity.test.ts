import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";
import { inboxActivity, type InboxActivitySource } from "./activity";

const H = 3_600_000;
const T0 = Date.parse("2026-11-01T00:00:00.000Z");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-activity-"));
  roots.push(dir);
  let now = T0;
  const store = InboxStore.open(dir, { now: () => new Date(now) });
  return { store, dir, at: (ms: number) => void (now = ms) };
}

const agent = (session: string): InboxAuthor => ({ kind: "agent", host: "claude-code", session, name: null });

const source = (thread_id: string, times: number[], project_id = "prj_a"): InboxActivitySource => ({ thread_id, project_id, name: () => thread_id, times });

describe("inboxActivity", () => {
  test("counts each message in the hour it falls in, counted from `from`", () => {
    const from = T0 + 30 * 60_000; // hours begin at :30, as a half-hour time zone's midnight would
    const model = inboxActivity([source("t1", [from, from + 10 * 60_000, from + H - 1, from + H, from + 5 * H + 1])], { fromMs: from, toMs: from + 24 * H, projectId: null });
    expect(model.hour_count).toBe(24);
    expect(model.threads[0]!.hours).toEqual([0, 3, 1, 1, 5, 1]);
  });

  test("leaves out messages before `from` and from `to` on, and threads with none in the span", () => {
    const model = inboxActivity(
      [source("before", [T0 - 1]), source("spans", [T0 - H, T0 + 2 * H, T0 + 10 * H]), source("after", [T0 + 10 * H])],
      { fromMs: T0, toMs: T0 + 10 * H, projectId: null },
    );
    expect(model.threads.map((t) => t.thread_id)).toEqual(["spans"]);
    expect(model.threads[0]).toMatchObject({ hours: [2, 1], total: 3, started_at: new Date(T0 - H).toISOString(), last_at: new Date(T0 + 10 * H).toISOString() });
  });

  test("orders rows by when each thread began, not by when it was last active", () => {
    const model = inboxActivity([source("late", [T0 + 5 * H]), source("early", [T0 - 3 * H, T0 + 6 * H]), source("middle", [T0 + H])], { fromMs: T0, toMs: T0 + 24 * H, projectId: null });
    expect(model.threads.map((t) => t.thread_id)).toEqual(["early", "middle", "late"]);
  });

  test("reads a thread's name only when it has a message in the span", () => {
    let reads = 0;
    const quiet: InboxActivitySource = { thread_id: "quiet", project_id: "prj_a", name: () => (reads++, "Quiet"), times: [T0 - H] };
    inboxActivity([quiet], { fromMs: T0, toMs: T0 + H, projectId: null });
    expect(reads).toBe(0);
  });
});

describe("InboxStore.activity", () => {
  test("one project's threads (a combined project's too), all of them with no project, by hour, every author counted", () => {
    const { store, at } = open();
    const billing = store.ensureProject({ name: "billing", root: "/work/billing" });
    const billingWt = store.ensureProject({ name: "billing-wt", root: "/work/billing-wt" });
    const docs = store.ensureProject({ name: "docs", root: "/work/docs" });
    at(T0 + 9 * H + 5 * 60_000);
    const retry = store.sendMessage({ project_id: billing.id, author: agent("ses_a"), body: "Started.", thread: "Retry queue" }).message;
    at(T0 + 9 * H + 40 * 60_000);
    store.sendMessage({ project_id: billing.id, author: agent("ses_a"), body: "More.", reply_to: retry.id });
    at(T0 + 11 * H);
    const person = store.sendReply(retry.id, { words: "Looks good.", idempotency_key: "k1" }).reply;
    expect(person.thread_id).toBe(retry.id);
    at(T0 + 10 * H);
    const wt = store.sendMessage({ project_id: billingWt.id, author: agent("ses_b"), body: "From a worktree.", thread: "Ledger export" }).message;
    at(T0 + 12 * H);
    store.sendMessage({ project_id: docs.id, author: agent("ses_c"), body: "Docs.", thread: "Landing copy" });

    const span = { fromMs: T0, toMs: T0 + 24 * H };
    expect(store.activity({ ...span, projectId: billing.id }).threads.map((t) => [t.name, t.hours])).toEqual([["Retry queue", [9, 2, 11, 1]]]);

    store.combineProject(billingWt.id, billing.id);
    const combined = store.activity({ ...span, projectId: billing.id });
    expect(combined.threads.map((t) => t.thread_id)).toEqual([retry.id, wt.id]);
    expect(combined.project_id).toBe(billing.id);

    const all = store.activity({ ...span, projectId: null });
    expect(all.threads.map((t) => t.name)).toEqual(["Retry queue", "Ledger export", "Landing copy"]);
    expect(all.threads[0]!.total).toBe(3);
  });

  test("a thread quiet since before the span is left out; the range moves with `from`", () => {
    const { store, at } = open();
    const project = store.ensureProject({ name: "api", root: "/work/api" });
    at(T0 - 3 * 24 * H);
    store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Old.", thread: "Old thread" });
    at(T0 + 2 * H);
    store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "New.", thread: "New thread" });
    expect(store.activity({ fromMs: T0, toMs: T0 + 24 * H, projectId: null }).threads.map((t) => t.name)).toEqual(["New thread"]);
    expect(store.activity({ fromMs: T0 - 7 * 24 * H, toMs: T0 + 24 * H, projectId: null }).threads.map((t) => t.name)).toEqual(["Old thread", "New thread"]);
  });
});
