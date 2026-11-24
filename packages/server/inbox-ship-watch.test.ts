/**
 * Ship's watch (inbox-ship-watch.ts) on its own: a fake read of the pull request and a fake note writer, the records
 * in a temp data dir. Each change wakes the agent once, a tick's changes go in one note, the same state read again
 * sends nothing, the agent's own pushes never wake it, stuck is shown and the watch goes on, merged and Stop end it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxShip, InboxShipRead } from "@plannotator/core/inbox-ship";
import type { InboxShipReadResult } from "./inbox-ship-read";
import { createInboxShipStore, INBOX_SHIPS_FILE } from "./inbox-ship-store";
import { createInboxShipWatch, shipEndedWaiting } from "./inbox-ship-watch";

const KEY = "github.com/harbor/fern-api#614";
const HEAD = "a".repeat(40);
const FIX1 = "b".repeat(40);
const FIX2 = "c".repeat(40);

const green = (over: Partial<InboxShipRead> = {}): InboxShipRead => ({
  state: "open",
  head_sha: HEAD,
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

function world(endedAt: number | null = null, first: InboxShipRead = green(), over: { dir?: string; shipper?: (ship: InboxShip) => { host: string; session: string } | null } = {}) {
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), "ship-watch-"));
  const ships = createInboxShipStore(dir);
  let read: InboxShipReadResult | null = first;
  let clock = Date.parse("2026-11-24T14:19:00Z");
  const notes: { body: string; kind: string; to: string | null }[] = [];
  const started: InboxShip[] = [];
  let changes = 0;
  const watch = createInboxShipWatch({
    ships,
    read: async () => read,
    note: (ship, body, kind) => notes.push({ body, kind, to: (over.shipper ? over.shipper(ship) : ship.agent)?.session ?? null }),
    ...(over.shipper ? { shipper: over.shipper } : {}),
    endedWaiting: () => endedAt,
    onStart: (ship) => started.push(ship),
    onChange: () => (changes += 1),
    now: () => clock,
    everyMs: 60 * 60_000,
  });
  const ship = watch.start({ key: KEY, platform: "github", url: "https://github.com/harbor/fern-api/pull/614", title: "Send a receipt after checkout", number: 614, repo: "harbor/fern-api", host: "github.com", thread_id: "thr_1", project_id: "prj_1", agent: { host: "claude-code", session: "ses_1", name: "Claude Code" } });
  return {
    dir,
    ships,
    watch,
    ship,
    notes,
    started,
    changes: () => changes,
    set: (next: InboxShipReadResult | null) => (read = next),
    later: (ms: number) => (clock += ms),
    now: () => ships.get(KEY)!,
  };
}

const worlds: ReturnType<typeof world>[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.watch.close();
});
const make = (endedAt: number | null = null, first?: InboxShipRead, over: Parameters<typeof world>[2] = {}) => {
  const w = world(endedAt, first, over);
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

  test("a push the agent logged never wakes it; any other new head does, the person's own push by the same login too", async () => {
    const w = make();
    await settle();
    // A commit it reported through `ship`.
    w.watch.step("thr_1", { kind: "step", text: "Pushed a fix", sha: FIX1.slice(0, 7) }, "ses_1");
    w.set(green({ head_sha: FIX1 }));
    await w.watch.tick();
    expect(w.notes).toEqual([]);
    // A commit it never reported: the person pushing by hand with the same login is not the agent.
    w.set(green({ head_sha: FIX2 }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.body).toContain("ccccccc");
  });

  test("a new comment wakes the agent whoever wrote it, the signed-in login too (a spare note beats a missed review)", async () => {
    const w = make();
    await settle();
    w.set(green({ comment: "IC_1", commenter: "charlie-dunn" }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.now().log.at(-1)!.text).toBe("New comments from charlie-dunn");
    w.set(green({ comment: "IC_2", commenter: "ada-novak" }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(2);
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
    w.watch.step("thr_1", { kind: "stuck", text: "needs a staging secret" }, "ses_1");
    expect(w.now().state).toBe("stuck");
    expect(w.now().reason).toBe("needs a staging secret");
    w.watch.step("thr_1", { kind: "step", text: "Re-ran e2e-checkout" }, "ses_1");
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
    expect(w.watch.step("thr_1", { kind: "step", text: "late" }, "ses_1")).toBeNull();
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
    const { key, platform, url, title, number, repo, host, project_id } = w.ship;
    w.watch.start({ key, platform, url, title, number, repo, host, project_id, thread_id: "thr_2", agent: { host: "codex", session: "ses_2", name: "Codex" } });
    expect(w.notes.map((n) => [n.kind, n.to])).toEqual([["stop", "ses_1"]]);
    expect(w.now().thread_id).toBe("thr_2");
  });

  test("Ship again in the same thread with another session tells the first one to stop", () => {
    const w = make();
    const { key, platform, url, title, number, repo, host, project_id } = w.ship;
    w.watch.start({ key, platform, url, title, number, repo, host, project_id, thread_id: "thr_1", agent: { host: "codex", session: "ses_2", name: "Codex" } });
    expect(w.notes.map((n) => [n.kind, n.to])).toEqual([["stop", "ses_1"]]);
  });

  test("only the shipping session's step changes the ship; another session's is refused and leaves no trace", async () => {
    const w = make();
    await settle();
    expect(w.watch.step("thr_1", { kind: "stuck", text: "not mine" }, "ses_reviewer")).toBeNull();
    expect(w.watch.step("thr_1", { kind: "step", text: "pushed", sha: FIX1.slice(0, 7) }, "ses_reviewer")).toBeNull();
    expect(w.watch.step("thr_1", { kind: "step", text: "no session" }, null)).toBeNull();
    expect(w.now().state).toBe("shipping");
    expect(w.now().told).toEqual([]);
    expect(w.now().log.map((e) => e.text)).toEqual(["Started"]);
    // Its push was never logged by the shipping agent: it still wakes it.
    w.set(green({ head_sha: FIX1 }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
  });

  test("a new session's notes go to the session its launch started, recorded on the ship, and its calls are its own", async () => {
    let started: string | null = null;
    const w = make(null, green(), { shipper: (ship) => ({ host: "claude-code", session: started ?? ship.agent.session! }) });
    await settle();
    started = "ses_launched";
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    expect(w.now().agent.session).toBe("ses_launched");
    expect(w.notes.map((n) => n.to)).toEqual(["ses_launched"]);
    expect(w.watch.step("thr_1", { kind: "step", text: "old" }, "ses_1")).toBeNull();
    expect(w.watch.step("thr_1", { kind: "step", text: "Fixed lint" }, "ses_launched")).not.toBeNull();
  });

  test("a pull request that can't be read three times in a row reads Stuck with why in the log, and recovers by itself", async () => {
    const w = make();
    await settle();
    w.set({ failed: "gh isn't signed in to github.com" });
    await w.watch.tick();
    await w.watch.tick();
    expect(w.now().state).toBe("shipping");
    await w.watch.tick();
    expect(w.now().state).toBe("stuck");
    expect(w.now().reason).toBe("can't read the pull request");
    expect(w.now().log.at(-1)!.text).toBe("Stuck: can't read the pull request (gh isn't signed in to github.com)");
    // More misses add nothing to the log.
    await w.watch.tick();
    expect(w.now().log.filter((e) => e.kind === "stuck")).toHaveLength(1);
    expect(w.notes).toEqual([]);
    w.set(green());
    await w.watch.tick();
    expect(w.now().state).toBe("shipping");
    expect(w.now().reason).toBeNull();
    expect(w.now().misses).toBeUndefined();
  });

  test("a read with nothing new writes nothing to ships.json", async () => {
    const w = make();
    await settle();
    await w.watch.tick();
    const file = join(w.dir, "inbox", INBOX_SHIPS_FILE);
    const before = statSync(file).ino;
    await w.watch.tick();
    await w.watch.tick();
    expect(statSync(file).ino).toBe(before);
  });

  test("an Inbox started again reads its ships from disk and goes on where it was: no first-read amnesty, no wake twice", async () => {
    const w = make();
    await settle();
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    w.watch.close();
    // The Inbox again: a new store and watch on the same folder, nothing started.
    const ships = createInboxShipStore(w.dir);
    let read: InboxShipRead = green({ checks: "failure", failing: ["lint"] });
    const notes: string[] = [];
    const watch = createInboxShipWatch({ ships, read: async () => read, note: (_s, body) => notes.push(body), everyMs: 60 * 60_000 });
    worlds.push({ watch } as ReturnType<typeof world>);
    watch.resume();
    expect(ships.get(KEY)!.id).toBe(w.ship.id);
    await watch.tick();
    expect(notes).toEqual([]);
    read = green({ checks: "failure", failing: ["lint", "e2e"] });
    await watch.tick();
    expect(notes).toHaveLength(1);
    expect(watch.step("thr_1", { kind: "step", text: "Fixed e2e" }, "ses_1")?.log.at(-1)!.text).toBe("Fixed e2e");
  });

  test("a ship tells the linked computers it started; told of a newer ship of the PR elsewhere, an older one here stops", async () => {
    const w = make();
    await settle();
    expect(w.started.map((s) => s.id)).toEqual([w.ship.id]);
    // An older ship there (started before this one) changes nothing here.
    expect(w.watch.newer({ key: KEY, id: "shp_old", started_at: "2026-11-24T14:00:00.000Z" }, "Mac mini")).toBeNull();
    expect(w.now().state).toBe("shipping");
    // A newer one there stops this one and tells its agent.
    const stopped = w.watch.newer({ key: KEY, id: "shp_new", started_at: "2026-11-24T15:00:00.000Z" }, "Mac mini");
    expect(stopped?.state).toBe("stopped");
    expect(w.now().log.at(-1)!.text).toBe("Stopped: shipping on Mac mini");
    expect(w.notes.map((n) => [n.kind, n.to])).toEqual([["stop", "ses_1"]]);
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
    expect(shipEndedWaiting(store, ship, () => true)).toBe(Date.parse("2026-11-24T14:10:00Z"));
    expect(shipEndedWaiting(store, ship, () => false)).toBeNull();
  });
});
