/**
 * Combine (approval "inbox-multi-select", 4A; inbox-combine.ts) on a real store, through its routes: the picked
 * threads are archived only once the asked session's new thread arrives; a session that ends, or ends its turn without
 * it, fails the Combine and nothing is archived; Stop withdraws a wake not yet delivered; Undo brings the threads back.
 * Who can be asked: running sessions that wrote in a picked thread.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxCombinePlan, InboxCombineRecord, InboxTidyReach } from "@plannotator/core/inbox-types";
import { inboxCombineAgentLabel } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxCombine } from "./inbox-combine";

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent = (session: string, host = "claude-code"): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host, session, name: null });
const ask = (q: string) => [q, "", ":::question", q, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-combine-"));
  roots.push(dir);
  const clock = { now: Date.parse("2026-11-14T10:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date((clock.now += 1000)) });
  const billing = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
  const live = new Map<string, InboxTidyReach>([["ses_a", "wakes"], ["ses_b", "wakes"]]);
  const idle = new Map<string, number>();
  const combine = createInboxCombine({
    store,
    serverSession: "srv",
    reachFor: () => (session) => live.get(session) ?? null,
    idleSince: (session) => idle.get(session) ?? null,
    titleOf: (session) => (session === "ses_a" ? "Invoice retries" : null),
    readBody: (req) => req.json() as Promise<Record<string, unknown>>,
    json: (body, status = 200) => Response.json(body, { status }),
    now: () => clock.now,
  });
  closers.push(combine.close);
  const send = (session: string, subject: string, body: string, extra: Record<string, unknown> = {}) =>
    store.sendMessage({ project_id: billing.id, author: agent(session), subject, body, ...extra }).message;
  const a1 = send("ses_a", "Invoice retries", ask("Retry declined cards after 24 hours?"));
  const a2 = send("ses_a", "Ledger export", "CSV export handles refunds now.");
  const b1 = send("ses_b", "Retry worker backoff", "Backoff is capped at 50 minutes.");
  const route = async (method: string, path: string, body?: Record<string, unknown>) => {
    const res = await combine
      .route(new Request(`http://127.0.0.1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify({ serverSession: "srv", ...body }) : undefined }), new URL(`http://127.0.0.1${path}`))
      .catch((error: { code?: string }) => Response.json({ code: error.code }));
    return (await res!.json()) as Record<string, unknown>;
  };
  const start = async (session = "ses_a", words?: string) =>
    (await route("POST", "/api/inbox/combine", { thread_ids: [a1.id, a2.id, b1.id], session, idempotency_key: `k-${session}`, ...(words ? { words } : {}) })).combine as InboxCombineRecord;
  const archived = () => [a1, a2, b1].map((m) => store.message(m.id)!.resolved_at !== null);
  return { store, live, idle, clock, combine, route, start, send, a1, a2, b1, archived };
}

test("who can be asked: running sessions that wrote in a picked thread, most threads first, named by host and title or project", async () => {
  const { route, live, send, start, a1, a2, b1 } = setup();
  const plan = (await route("GET", `/api/inbox/combine?threads=${a1.id},${a2.id},${b1.id}`)) as unknown as InboxCombinePlan;
  expect(plan.agents!.map((a) => [a.session, a.threads, inboxCombineAgentLabel(a, plan.agents)])).toEqual([
    ["ses_a", 2, "Claude Code · Invoice retries"],
    ["ses_b", 1, "Claude Code · billing-svc"],
  ]);
  // Two untitled sessions of one host in one project would read the same: each is named by its thread instead.
  live.set("ses_c", "wakes");
  const c1 = send("ses_c", "Webhook docs", "Every event type is listed.");
  const twins = (await route("GET", `/api/inbox/combine?threads=${a1.id},${b1.id},${c1.id}`)) as unknown as InboxCombinePlan;
  expect(twins.agents!.map((a) => inboxCombineAgentLabel(a, twins.agents))).toEqual(["Claude Code · Invoice retries", "Claude Code · Retry worker backoff", "Claude Code · Webhook docs"]);
  // The toasts name it the same way.
  expect((await start("ses_b")).name).toBe("Claude Code · billing-svc");
  live.delete("ses_b");
  const after = (await route("GET", `/api/inbox/combine?threads=${a1.id},${a2.id},${b1.id}`)) as unknown as InboxCombinePlan;
  expect(after.agents!.map((a) => a.session)).toEqual(["ses_a"]);
});

test("the wake lists every picked thread and its open questions, asks for one new thread under the Combine's key, and carries the person's words", async () => {
  const { store, start, a1, a2, b1 } = setup();
  const record = await start("ses_a", "Just the billing release work.");
  const wake = store.pendingReplies("ses_a").find((m) => m.tidy?.wake)!;
  expect(wake.tidy!.id).toBe(record.id);
  const [q] = store.questionsOf(a1.id);
  expect(wake.body).toContain(`idempotency_key "${record.id}"`);
  expect(wake.body).toContain('The person added: "Just the billing release work."');
  expect(wake.body).toContain(`1. Invoice retries · billing-svc (thread ${a1.id}, 1 message)`);
  expect(wake.body).toContain(`     ${a1.id}/${q!.key}  Retry declined cards after 24 hours?`);
  expect(wake.body).toContain(`3. Retry worker backoff · billing-svc (thread ${b1.id}, 1 message)`);
  expect(wake.body).toContain("--session claude-code:ses_a");
  // One quiet note in each picked thread; only the first wakes.
  expect([a1, a2, b1].map((m) => store.threadMessageIds(m.id).length)).toEqual([2, 2, 2]);
  expect(record.state).toBe("asked");
});

test("nothing is archived until the new thread arrives; then every picked thread is, and its questions stay answerable until then", async () => {
  const { store, start, send, archived, a1, route } = setup();
  const record = await start();
  // A reply in an old thread, or another session's new thread, is not it.
  send("ses_b", "Something else", "Unrelated.", {});
  store.sendMessage({ project_id: store.message(a1.id)!.project_id, author: agent("ses_a"), reply_to: a1.id, body: "Reading these now." });
  await Promise.resolve();
  expect(archived()).toEqual([false, false, false]);
  expect(store.questionsOf(a1.id)[0]!.state).toBe("open");
  const made = send("ses_a", "Billing retries and refunds", ask("Retry declined cards after 24 hours, instead of 6?"), { idempotency_key: record.id });
  await Promise.resolve();
  expect(archived()).toEqual([true, true, true]);
  const { combines } = (await route("GET", "/api/inbox/combine")) as unknown as InboxCombinePlan;
  expect(combines[0]).toMatchObject({ id: record.id, state: "done", thread: { id: made.id, subject: "Billing retries and refunds" } });
  // Undo: the three come back; the new thread stays.
  const undone = (await route("POST", `/api/inbox/combine/${record.id}/undo`, {})).combine as InboxCombineRecord;
  expect(undone.state).toBe("undone");
  expect(archived()).toEqual([false, false, false]);
  expect(store.message(made.id)!.resolved_at).toBeNull();
});

test("the session ends, or ends its turn without the thread: the Combine fails, nothing is archived, and a wake not delivered is withdrawn", async () => {
  const first = setup();
  const record = await first.start();
  first.live.delete("ses_a");
  first.combine.check();
  expect((await first.route("GET", "/api/inbox/combine")).combines).toMatchObject([{ id: record.id, state: "failed", reason: "ended" }]);
  expect(first.archived()).toEqual([false, false, false]);
  expect(first.store.pendingReplies("ses_a").some((m) => m.tidy?.wake)).toBe(false);

  const second = setup();
  const asked = await second.start();
  const wake = second.store.pendingReplies("ses_a").find((m) => m.tidy?.wake)!;
  const delivered = Date.parse(second.store.recordDelivery(wake.id, { host: "claude-code", session: "ses_a" }).delivery!.at);
  // Idle just after delivery: its message may still be on its way.
  second.idle.set("ses_a", delivered + 1);
  second.clock.now = delivered + 2;
  second.combine.check();
  expect(((await second.route("GET", "/api/inbox/combine")).combines as InboxCombineRecord[])[0]!.state).toBe("asked");
  // Idle after delivery, past the grace, without the thread.
  second.clock.now = delivered + 30_000;
  second.combine.check();
  expect((await second.route("GET", "/api/inbox/combine")).combines).toMatchObject([{ id: asked.id, state: "failed", reason: "nothing" }]);
  // A thread it writes after failing archives nothing.
  second.send("ses_a", "Late", "Late.", { idempotency_key: asked.id });
  await Promise.resolve();
  expect(second.archived()).toEqual([false, false, false]);
});

test("Stop: a Combine still waiting ends, its wake withdrawn; a replayed key answers the first Combine; a thread waiting in one is not combined again", async () => {
  const { store, start, route, a1, a2 } = setup();
  const record = await start();
  expect((await start()).id).toBe(record.id);
  const again = await route("POST", "/api/inbox/combine", { thread_ids: [a1.id, a2.id], session: "ses_a", idempotency_key: "other" });
  expect(again).toMatchObject({ code: "already_combining" });
  const stopped = (await route("POST", `/api/inbox/combine/${record.id}/cancel`, {})).combine as InboxCombineRecord;
  expect(stopped.state).toBe("stopped");
  expect(store.pendingReplies("ses_a").some((m) => m.tidy?.wake)).toBe(false);
});

test("a session that never wrote in the picked threads, or a single thread, is refused", async () => {
  const { route, a1, a2, live } = setup();
  live.set("ses_x", "wakes");
  expect(await route("POST", "/api/inbox/combine", { thread_ids: [a1.id, a2.id], session: "ses_x", idempotency_key: "x" })).toMatchObject({ code: "session_not_live" });
  expect(await route("POST", "/api/inbox/combine", { thread_ids: [a1.id], session: "ses_a", idempotency_key: "y" })).toMatchObject({ code: "validation_error" });
});
