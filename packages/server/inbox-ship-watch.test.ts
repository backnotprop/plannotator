/**
 * Ship's watch (inbox-ship-watch.ts) on its own: a fake read of the pull request and a fake note writer, the records
 * in a temp data dir. Each change wakes the agent once, a tick's changes go in one note, the same state read again
 * sends nothing, the agent's own pushes never wake it, stuck is shown and the watch goes on, merged and Stop end it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxShip, InboxShipRead } from "@plannotator/core/inbox-ship";
import { createInboxShipStore } from "./inbox-ship-store";
import { createInboxShipWatch, shipEndedWaiting } from "./inbox-ship-watch";

const KEY = "github.com/harbor/fern-api#614";
const HEAD = "a".repeat(40);
const FIX1 = "b".repeat(40);
const FIX2 = "c".repeat(40);

const green = (over: Partial<InboxShipRead> = {}): InboxShipRead => ({
  state: "open",
  head_sha: HEAD,
  head_mine: true,
  base: "main",
  checks: "pending",
  failing: [],
  review: null,
  reviewer: null,
  conflicts: false,
  behind: false,
  comment: null,
  commenter: null,
  merged_at: null,
  ...over,
});

function world(endedAt: number | null = null, first: InboxShipRead = green()) {
  const ships = createInboxShipStore(mkdtempSync(join(tmpdir(), "ship-watch-")));
  let read: InboxShipRead | null = first;
  let clock = Date.parse("2026-11-24T14:19:00Z");
  const notes: { body: string; kind: string }[] = [];
  let changes = 0;
  const watch = createInboxShipWatch({
    ships,
    read: async () => read,
    note: (_ship, body, kind) => notes.push({ body, kind }),
    endedWaiting: () => endedAt,
    onChange: () => (changes += 1),
    now: () => clock,
    everyMs: 60 * 60_000,
  });
  const ship = watch.start({ key: KEY, url: "https://github.com/harbor/fern-api/pull/614", title: "Send a receipt after checkout", number: 614, repo: "harbor/fern-api", host: "github.com", thread_id: "thr_1", project_id: "prj_1", agent: { host: "claude-code", session: "ses_1", name: "Claude Code" } });
  return {
    ships,
    watch,
    ship,
    notes,
    changes: () => changes,
    set: (next: InboxShipRead | null) => (read = next),
    later: (ms: number) => (clock += ms),
    now: () => ships.get(KEY)!,
  };
}

const worlds: ReturnType<typeof world>[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.watch.close();
});
const make = (endedAt: number | null = null, first?: InboxShipRead) => {
  const w = world(endedAt, first);
  worlds.push(w);
  return w;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Ship's watch", () => {
  test("Ship makes the record with Started, and the first read is where the agent starts: remembered, never a wake", async () => {
    // Already green when Ship is pressed: the instruction says to merge when green; no "merge it now" on top.
    const w = make(null, green({ checks: "success" }));
    await settle();
    await w.watch.tick();
    expect(w.now().state).toBe("shipping");
    expect(w.now().log.map((e) => e.text)).toEqual(["Started"]);
    expect(w.notes).toEqual([]);
  });

  test("a failed check wakes the agent once; the same failure read again sends nothing", async () => {
    const w = make();
    await settle();
    w.set(green({ checks: "failure", failing: ["e2e-checkout"] }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.kind).toBe("watch");
    expect(w.notes[0]!.body).toContain("e2e-checkout");
    expect(w.notes[0]!.body).toContain("#614");
    await w.watch.tick();
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.now().log.at(-1)!.text).toBe("Checks failed: e2e-checkout");
  });

  test("a tick's changes go to the agent in one note, never one per change", async () => {
    const w = make();
    await settle();
    w.set(green({ checks: "failure", failing: ["lint"], review: "changes_requested", reviewer: "ada-novak", conflicts: true }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.body.split("\n").length).toBe(4);
    expect(w.now().log.map((e) => e.kind)).toEqual(["started", "checks_failed", "changes_requested", "conflict"]);
  });

  test("the agent's own push never wakes it as a stranger's commit; someone else's does", async () => {
    const w = make();
    await settle();
    // Its push, by the person's login (the agent works as the person).
    w.set(green({ head_sha: FIX1, head_mine: true }));
    await w.watch.tick();
    expect(w.notes).toEqual([]);
    // A commit it reported, even when authored by another login.
    w.watch.step("thr_1", { kind: "step", text: "Pushed a fix", sha: FIX2.slice(0, 7) });
    w.set(green({ head_sha: FIX2, head_mine: false }));
    await w.watch.tick();
    expect(w.notes).toEqual([]);
    // A teammate's commit.
    w.set(green({ head_sha: "d".repeat(40), head_mine: false }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.body).toContain("ddddddd");
  });

  test("a comment by the person (the agent answering) is no change; another person's is", async () => {
    const w = make();
    await settle();
    w.set(green({ comment: null }));
    await w.watch.tick();
    expect(w.notes).toEqual([]);
    w.set(green({ comment: "IC_1", commenter: "ada-novak" }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.now().log.at(-1)!.text).toBe("New comments from ada-novak");
  });

  test("ready to merge asks once per head", async () => {
    const w = make();
    await settle();
    w.set(green({ head_sha: FIX1, checks: "success" }));
    await w.watch.tick();
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.now().log.at(-1)!.text).toBe("Ready to merge");
  });

  test("the same check failing on three different heads reads Stuck; the watch goes on, and a pass clears it", async () => {
    const w = make();
    await settle();
    for (const head of [HEAD, FIX1, FIX2]) {
      w.set(green({ head_sha: head, checks: "failure", failing: ["e2e-checkout"] }));
      await w.watch.tick();
    }
    expect(w.now().state).toBe("stuck");
    expect(w.now().reason).toBe("e2e-checkout failing");
    // One wake per failure on a new head: the agent is never stopped by Stuck.
    expect(w.notes).toHaveLength(3);
    w.set(green({ head_sha: "e".repeat(40), checks: "success" }));
    await w.watch.tick();
    expect(w.now().state).toBe("shipping");
    expect(w.now().reason).toBeNull();
  });

  test("the agent says stuck: the row's words are its own, until it goes on", async () => {
    const w = make();
    await settle();
    w.watch.step("thr_1", { kind: "stuck", text: "needs a staging secret" });
    expect(w.now().state).toBe("stuck");
    expect(w.now().reason).toBe("needs a staging secret");
    w.watch.step("thr_1", { kind: "step", text: "Re-ran e2e-checkout" });
    expect(w.now().state).toBe("shipping");
    expect(w.now().log.at(-1)!.by).toBe("agent");
  });

  test("merged, by anyone, ends it with no wake; the watch reads it no more", async () => {
    const w = make();
    await settle();
    w.set(green({ state: "merged", merged_at: "2026-11-24T14:47:00Z" }));
    await w.watch.tick();
    expect(w.now().state).toBe("merged");
    expect(w.now().merged_at).toBe("2026-11-24T14:47:00Z");
    expect(w.notes).toEqual([]);
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    expect(w.notes).toEqual([]);
  });

  test("closed stops it and tells the agent", async () => {
    const w = make();
    await settle();
    w.set(green({ state: "closed" }));
    await w.watch.tick();
    expect(w.now().state).toBe("stopped");
    expect(w.notes.map((n) => n.kind)).toEqual(["stop"]);
  });

  test("Stop: at once, the agent gets the stop line, and nothing wakes it after", async () => {
    const w = make();
    await settle();
    const before = w.changes();
    w.watch.stop(w.ship.id);
    expect(w.now().state).toBe("stopped");
    expect(w.changes()).toBeGreaterThan(before);
    expect(w.notes.map((n) => n.kind)).toEqual(["stop"]);
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.watch.step("thr_1", { kind: "step", text: "late" })).toBeNull();
  });

  test("a session that ended with a note waiting reads Stuck after ten minutes", async () => {
    const start = Date.parse("2026-11-24T14:19:00Z");
    const w = make(start);
    await settle();
    await w.watch.tick();
    expect(w.now().state).toBe("shipping");
    w.later(11 * 60_000);
    await w.watch.tick();
    expect(w.now().state).toBe("stuck");
    expect(w.now().reason).toBe("Claude Code ended");
  });

  test("Ship again with another agent stops the one before and tells it", () => {
    const w = make();
    const { key, url, title, number, repo, host, project_id } = w.ship;
    w.watch.start({ key, url, title, number, repo, host, project_id, thread_id: "thr_2", agent: { host: "codex", session: "ses_2", name: "Codex" } });
    expect(w.notes.map((n) => n.kind)).toEqual(["stop"]);
    expect(w.now().thread_id).toBe("thr_2");
  });
});

describe("shipEndedWaiting", () => {
  const ship = { id: "shp_1", thread_id: "thr_1" } as Pick<InboxShip, "id" | "thread_id">;
  const messages: Record<string, { created_at: string; ship_note?: { ship: string }; delivery?: unknown }> = {
    m1: { created_at: "2026-11-24T14:00:00Z" },
    m2: { created_at: "2026-11-24T14:05:00Z", ship_note: { ship: "shp_1" }, delivery: { at: "x" } },
    m3: { created_at: "2026-11-24T14:10:00Z", ship_note: { ship: "shp_1" } },
  };
  const store = { threadMessageIds: () => ["m1", "m2", "m3"], message: (id: string) => messages[id] };
  test("the oldest undelivered note of the ship, only while the session has ended", () => {
    expect(shipEndedWaiting(store, ship, () => ({ ended: true }))).toBe(Date.parse("2026-11-24T14:10:00Z"));
    expect(shipEndedWaiting(store, ship, () => ({ ended: false }))).toBeNull();
  });
});
