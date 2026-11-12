import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_AUTO_SEND_ACK_NOTES, INBOX_AUTO_SEND_AFTER_MS, inboxDeliveryState, type InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AFTER = INBOX_AUTO_SEND_AFTER_MS;
const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const START = Date.parse("2026-10-21T13:48:00.000Z");

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-auto-send-")), clock = { now: START }) {
  if (!roots.includes(dir)) roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  return { store, dir, clock };
}

function clocks() {
  const map = new Map<string, { since: number; autoSince: number | null }>();
  return {
    start: (id: string, at: number, autoAt: number | null = at) => map.set(id, { since: at, autoSince: autoAt }),
    clockOf: (id: string) => map.get(id) ?? null,
  };
}

function setup() {
  const opened = open();
  const project = opened.store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const asked = opened.store.sendMessage({ project_id: project.id, author: AGENT, body: "CSV or Parquet?", wakes: true }).message;
  return { ...opened, project, asked };
}

describe("autoSendDue", () => {
  test("fires 5 minutes after its clock started, not before, once; marked as the Inbox's (deliver_now_by: auto, wait_started_at)", () => {
    const { store, clock, asked } = setup();
    const c = clocks();
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    clock.now += 60 * 60_000;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    c.start(reply.id, clock.now);
    clock.now += AFTER - 1;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    expect(store.message(reply.id)!.deliver_now_at ?? null).toBeNull();

    clock.now += 1;
    const lines = store.cursor();
    const [marked] = store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf });
    expect(marked).toMatchObject({
      id: reply.id,
      deliver_now_by: "auto",
      deliver_now_at: new Date(clock.now).toISOString(),
      wait_started_at: new Date(clock.now - AFTER).toISOString(),
    });
    expect(store.cursor()).toBe(lines + 1);
    clock.now += 60 * 60_000;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    expect(store.cursor()).toBe(lines + 1);
    expect(store.autoSendDue("ses_b", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
  });

  test("the countdown runs from when the session was seen able to take it, not from when it began to wait", () => {
    const { store, clock, asked } = setup();
    const c = clocks();
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    c.start(reply.id, clock.now, null);
    clock.now += 20 * 60_000;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    c.start(reply.id, clock.now - 20 * 60_000, clock.now);
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    clock.now += AFTER;
    const [marked] = store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf });
    expect(marked!.wait_started_at).toBe(new Date(clock.now - AFTER - 20 * 60_000).toISOString());
  });

  test("a failed attempt (the connection said send_now_failed) is never retried by itself; the person's Send now still works", () => {
    const { store, clock, asked } = setup();
    const c = clocks();
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    c.start(reply.id, clock.now);
    clock.now += AFTER;
    store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf });
    store.clearDeliverNow(reply.id, "ses_a");
    expect(store.message(reply.id)).toMatchObject({ deliver_now_at: null, deliver_now_by: "auto" });
    clock.now += AFTER;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    expect(store.requestDeliverNow(reply.id)).toMatchObject({ deliver_now_by: "person" });
  });

  test("a reply the person already sent now is left alone; so is a delivered one", () => {
    const { store, clock, asked } = setup();
    const c = clocks();
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    c.start(reply.id, clock.now);
    store.requestDeliverNow(reply.id);
    clock.now += AFTER;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    expect(store.message(reply.id)!.deliver_now_by).toBe("person");
    store.recordDelivery(reply.id, { host: "claude-code", session: "ses_a" });
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
  });

  test("a message moved to another session loses the old session's mark: it neither goes in at once nor stays blocked", () => {
    const { store, clock, project } = setup();
    const c = clocks();
    const thread = store.startPersonThread({ project_id: project.id, to: { host: "claude-code", session: "ses_a" }, body: "Try the new parser.", idempotency_key: "p1" });
    const id = thread.message.id;
    c.start(id, clock.now);
    clock.now += AFTER;
    store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf });
    expect(store.message(id)).toMatchObject({ deliver_now_by: "auto" });
    store.clearDeliverNow(id, "ses_a");
    const moved = store.readdressMessage(id, { host: "claude-code", session: "ses_b" });
    expect(moved).toMatchObject({ deliver_now_at: null, deliver_now_by: null, wait_started_at: null });
    c.start(id, clock.now);
    expect(store.autoSendDue("ses_b", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    clock.now += AFTER;
    expect(store.autoSendDue("ses_b", { afterMs: AFTER, clockOf: c.clockOf }).map((m) => m.id)).toEqual([id]);
    const other = store.startPersonThread({ project_id: project.id, to: { host: "claude-code", session: "ses_a" }, body: "And the docs.", idempotency_key: "p2" });
    store.requestDeliverNow(other.message.id);
    expect(store.readdressMessage(other.message.id, { host: "claude-code", session: "ses_b" })).toMatchObject({ deliver_now_at: null, deliver_now_by: null });
  });

  test("the Inbox's set-aside note never goes in by itself; nor does the note carrying a 👍 (it waits for the turn to end), and its row shows no countdown", () => {
    const { store, clock, project } = setup();
    const c = clocks();
    expect(INBOX_AUTO_SEND_ACK_NOTES).toBe(false);
    const q = store.sendMessage({ project_id: project.id, author: AGENT, body: [":::question", "Which region?", "", "- [ ] us", "- [ ] eu", ":::"].join("\n"), wakes: true }).message;
    store.markRead(q.thread_id, true);
    clock.now += 10_000;
    const notes = store.tellSetAside(q.thread_id, 10_000);
    expect(notes.length).toBe(1);
    c.start(notes[0]!.id, clock.now);
    clock.now += AFTER;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf }).map((m) => m.id)).not.toContain(notes[0]!.id);

    const news = store.sendMessage({ project_id: project.id, author: AGENT, body: "Merged #12.", wakes: true }).message;
    store.ackMessage(news.id, true);
    clock.now += 10_000;
    const [settled] = store.settleAcks(10_000);
    const noteId = settled!.ack!.note_id!;
    c.start(noteId, clock.now);
    store.setDeliveryPresence({
      connection: () => ({ busy: true, send_now: true }),
      askerLive: () => true,
      autoSendAfterMs: AFTER,
      waitOf: (_session, id) => {
        const k = c.clockOf(id);
        return k ? { since: new Date(k.since).toISOString(), autoSince: k.autoSince === null ? null : new Date(k.autoSince).toISOString() } : null;
      },
    });
    clock.now += 3 * 60 * 60_000;
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf })).toEqual([]);
    expect(store.message(noteId)!.deliver_now_by ?? null).toBeNull();
    const d = store.listRow(news.thread_id)!.delivery!;
    expect(d).toMatchObject({ kind: "ack", state: "queued", reason: "working", send_now: false, auto_send_at: null, waiting_since: new Date(c.clockOf(noteId)!.since).toISOString() });
  });

  test("a tagged session's own wait: marked on its tag, not the owner's", () => {
    const { store, clock, asked } = setup();
    const c = clocks();
    const reply = store.sendReply(asked.id, { words: "Parquet, and Pi checks the schema.", idempotency_key: "k1", tags: [{ host: "pi", session: "ses_pi", wakes: true }] }).reply!;
    c.start(reply.id, clock.now);
    clock.now += AFTER;
    const [marked] = store.autoSendDue("ses_pi", { afterMs: AFTER, tags: true, clockOf: c.clockOf });
    expect(marked!.tags![0]).toMatchObject({ session: "ses_pi", deliver_now_by: "auto" });
    expect(store.message(reply.id)!.deliver_now_at ?? null).toBeNull();
    expect(store.autoSendDue("ses_pi", { afterMs: AFTER, tags: false, clockOf: c.clockOf })).toEqual([]);
    expect(store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf }).map((m) => m.id)).toEqual([reply.id]);
  });
});

describe("the row's delivery while it waits on a busy session", () => {
  test("Undelivered: since the server's clock; goes in by itself only where the connection can take it; after: auto_after_min", () => {
    const { store, clock, asked } = setup();
    const c = clocks();
    const busy = { busy: true as boolean | null, send_now: true };
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    store.setDeliveryPresence({
      connection: () => busy,
      askerLive: () => true,
      autoSendAfterMs: AFTER,
      waitOf: (_session, id) => {
        const k = c.clockOf(id);
        return k ? { since: iso(k.since)!, autoSince: iso(k.autoSince) } : null;
      },
    });
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    clock.now += 60 * 60_000;
    expect(store.listRow(asked.id)!.delivery!.waiting_since).toBeUndefined();
    const started = clock.now;
    c.start(reply.id, started);
    clock.now += 3 * 60_000;
    expect(store.listRow(asked.id)!.delivery).toMatchObject({
      state: "queued",
      reason: "working",
      send_now: true,
      waiting_since: iso(started),
      steerable: true,
      auto_send_at: iso(started + AFTER),
    });
    busy.send_now = false;
    expect(store.listRow(asked.id)!.delivery).toMatchObject({ send_now: false, steerable: false, auto_send_at: null, waiting_since: iso(started) });
    busy.busy = false;
    expect(store.listRow(asked.id)!.delivery!.waiting_since).toBeUndefined();

    busy.busy = true;
    busy.send_now = true;
    clock.now += 2 * 60_000;
    store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf });
    expect(store.listRow(asked.id)!.delivery).toMatchObject({ state: "sending", reason: "sending_now", auto_after_min: 5 });
    clock.now += 30_000;
    store.recordDelivery(reply.id, { host: "claude-code", session: "ses_a", intoTurn: true });
    expect(store.listRow(asked.id)!.delivery).toMatchObject({ state: "delivered", auto_after_min: 5 });
  });

  test("delivered after the Inbox's mark but at the end of the turn: no \"by itself\", it says the turn ended", () => {
    const { store, clock, asked } = setup();
    const c = clocks();
    store.setDeliveryPresence({ connection: () => ({ busy: true, send_now: true }), askerLive: () => true, autoSendAfterMs: AFTER });
    const reply = store.sendReply(asked.id, { words: "Parquet.", idempotency_key: "k1" }).reply!;
    c.start(reply.id, clock.now);
    clock.now += AFTER;
    store.autoSendDue("ses_a", { afterMs: AFTER, clockOf: c.clockOf });
    store.recordDelivery(reply.id, { host: "claude-code", session: "ses_a", intoTurn: false });
    expect(store.message(reply.id)!.delivery!.into_turn).toBe(false);
    const d = store.listRow(asked.id)!.delivery!;
    expect(d).toMatchObject({ state: "delivered", turn_ended: true });
    expect(d.auto_after_min).toBeUndefined();
  });

  test("the rule alone: no countdown from an older Inbox or before the auto clock, none after a person's Send now; a session gone wins over a pressed Send now", () => {
    const base = {
      delivered: false,
      undelivered: false,
      askerEnded: false,
      wakes: true,
      sendingNow: false,
      connection: { busy: true, send_now: true },
      waitingSince: "2026-10-21T13:48:00.000Z",
      autoSince: "2026-10-21T13:50:00.000Z",
    };
    expect(inboxDeliveryState(base).wait).toEqual({ since: base.waitingSince, steerable: true, autoSendAt: null });
    expect(inboxDeliveryState({ ...base, autoSendAfterMs: AFTER }).wait!.autoSendAt).toBe("2026-10-21T13:55:00.000Z");
    expect(inboxDeliveryState({ ...base, autoSince: null, autoSendAfterMs: AFTER }).wait!.autoSendAt).toBeNull();
    expect(inboxDeliveryState({ ...base, autoSendAfterMs: AFTER, nowBy: "person" }).wait!.autoSendAt).toBeNull();
    expect(inboxDeliveryState({ ...base, delivered: true, nowBy: "person", nowAt: "2026-10-21T13:50:00.000Z" }).autoAfterMin).toBeUndefined();
    expect(inboxDeliveryState({ ...base, sendingNow: true, nowBy: "auto", nowAt: "2026-10-21T13:55:00.000Z", connection: null })).toMatchObject({
      state: "queued",
      reason: "away",
    });
    expect(inboxDeliveryState({ ...base, sendingNow: true, nowBy: "person", nowAt: "2026-10-21T13:55:00.000Z", connection: null }).reason).toBe("away");
  });
});
