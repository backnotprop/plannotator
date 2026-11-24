/**
 * Ship's watch (inbox-ship-watch.ts) on its own: a fake read of the pull request and a fake note writer, the records
 * in a temp data dir. Each change wakes the agent once, a tick's changes go in one note, the same state read again
 * sends nothing, the agent's own pushes never wake it, stuck is shown and the watch goes on, merged and Stop end it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHIP_START_STUCK, type InboxShip, type InboxShipRead } from "@plannotator/core/inbox-pull-handoff";
import type { InboxShipReadResult } from "./inbox-ship-read";
import { shipBinds, shipLaunchFailed, shipShipper } from "./inbox-ship-agent";
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
  comments: [],
  // The login gh is signed in as: the agent's, and the person's own when they comment by hand.
  viewer: "ada-novak",
  merged_at: null,
  ...over,
});

function world(
  endedAt: number | null = null,
  first: InboxShipRead = green(),
  over: {
    dir?: string;
    shipper?: (ship: InboxShip) => { host: string; session: string } | null;
    mayBind?: (ship: InboxShip, session: string) => boolean;
    launchOf?: (messageId: string) => string | null;
    launchFailed?: (ship: InboxShip) => string | null;
    bound?: boolean;
    answers?: { ship: InboxShip; to: string }[];
  } = {},
) {
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
    ...(over.mayBind ? { mayBind: over.mayBind } : {}),
    ...(over.launchOf ? { launchOf: over.launchOf } : {}),
    ...(over.launchFailed ? { launchFailed: over.launchFailed } : {}),
    endedWaiting: () => endedAt,
    onStart: (ship, to) => (to ? over.answers?.push({ ship, to }) : started.push(ship)),
    onChange: () => (changes += 1),
    now: () => clock,
    everyMs: 60 * 60_000,
  });
  // The person chose the live session ses_1 (bound), unless a test ships to a new session.
  const ship = watch.start({ key: KEY, platform: "github", url: "https://github.com/harbor/fern-api/pull/614", title: "Send a receipt after checkout", number: 614, repo: "harbor/fern-api", host: "github.com", thread_id: "thr_1", project_id: "prj_1", agent: { host: "claude-code", session: "ses_1", name: "Claude Code" }, bound: over.bound ?? true });
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
    // A commit it never reported: the person pushing by hand with the same login is not the agent. Held one read
    // (the agent may log it a moment after), then told.
    w.set(green({ head_sha: FIX2 }));
    await w.watch.tick();
    expect(w.notes).toEqual([]);
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.body).toContain("ccccccc");
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
  });

  test("a read that sees the agent's push before the agent logs it tells nobody: the push it logs next is its own", async () => {
    const w = make();
    await settle();
    // The Reviews list's read saw the new head first.
    w.set(green({ head_sha: FIX1 }));
    w.watch.saw([{ key: KEY, head_sha: FIX1, state: "open" }]);
    await settle();
    expect(w.notes).toEqual([]);
    // Then the agent logs the push.
    w.watch.step("thr_1", { kind: "step", text: "Pushed a fix", sha: FIX1.slice(0, 7) }, "ses_1");
    await w.watch.tick();
    await w.watch.tick();
    expect(w.notes).toEqual([]);
    expect(w.now().log.some((e) => e.kind === "new_commit")).toBe(false);
  });

  test("a new comment by anyone else wakes the agent once", async () => {
    const w = make();
    await settle();
    w.set(green({ comments: [{ id: "IC_1", by: "charlie-dunn" }] }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.now().log.at(-1)!.text).toBe("New comments from charlie-dunn");
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    w.set(green({ comments: [{ id: "IC_1", by: "charlie-dunn" }, { id: "IC_2", by: "bob-tully" }] }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(2);
    expect(w.notes[1]!.body).toContain("New comments from bob-tully.");
  });

  test("the agent's own comment never wakes it; the person's, by the same login after it, does once", async () => {
    const w = make();
    await settle();
    // The agent answers a reviewer as the signed-in login, then logs the step: that step's read takes the comment as its own.
    w.set(green({ comments: [{ id: "IC_agent", by: "ada-novak" }] }));
    w.watch.step("thr_1", { kind: "step", text: "Answered the reviewer" }, "ses_1");
    await w.watch.tick();
    await w.watch.tick();
    expect(w.notes).toEqual([]);
    // The person comments by hand with the same login, after the agent's last step.
    w.set(green({ comments: [{ id: "IC_agent", by: "ada-novak" }, { id: "IC_person", by: "ada-novak" }] }));
    await w.watch.tick();
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]!.body).toContain("New comments from ada-novak.");
  });

  test("the agent's comment read before it logs its step wakes it once at most, never again (no loop)", async () => {
    const w = make();
    await settle();
    w.set(green({ comments: [{ id: "IC_agent", by: "ada-novak" }] }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    w.watch.step("thr_1", { kind: "step", text: "Answered the reviewer" }, "ses_1");
    await w.watch.tick();
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
  });

  test("a step logged while a read is going is claimed by a read after it: the comment it wrote just before is its own", async () => {
    const w = make();
    await settle();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const slow = createInboxShipWatch({
      ships: w.ships,
      read: async () => {
        reads += 1;
        // The first read was asked before the agent commented; the comment shows only in the read after the step.
        if (reads === 1) {
          await gate;
          return green();
        }
        return green({ comments: [{ id: "IC_agent", by: "ada-novak" }] });
      },
      note: (_s, body, kind) => w.notes.push({ body, kind, to: null }),
      everyMs: 60 * 60_000,
    });
    worlds.push({ watch: slow } as ReturnType<typeof world>);
    const going = slow.tick();
    expect(slow.step("thr_1", { kind: "step", text: "Answered the reviewer" }, "ses_1")).not.toBeNull();
    release();
    await going;
    await settle();
    await slow.tick();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(w.notes).toEqual([]);
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
      // The agent's own fixes, each logged.
      if (head !== HEAD) w.watch.step("thr_1", { kind: "step", text: "Pushed a fix", sha: head }, "ses_1");
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
    // A step it logs after: it is told again to stop, and nothing is logged.
    expect(w.watch.step("thr_1", { kind: "step", text: "late" }, "ses_1")).toEqual({ stopped: "#614" });
    expect(w.now().log.at(-1)!.text).toBe("Stopped");
    // Another session of the thread was never shipping it.
    expect(w.watch.step("thr_1", { kind: "step", text: "late" }, "ses_reviewer")).toBeNull();
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
    // Told that another session ships it, not that nothing ships.
    expect(w.watch.step("thr_1", { kind: "stuck", text: "not mine" }, "ses_reviewer")).toEqual({ other: true });
    expect(w.watch.step("thr_1", { kind: "step", text: "pushed", sha: FIX1.slice(0, 7) }, "ses_reviewer")).toEqual({ other: true });
    expect(w.watch.step("thr_1", { kind: "step", text: "no session" }, null)).toEqual({ other: true });
    expect(w.watch.step("thr_9", { kind: "step", text: "nothing ships here" }, "ses_1")).toBeNull();
    expect(w.now().state).toBe("shipping");
    expect(w.now().told).toEqual([]);
    expect(w.now().log.map((e) => e.text)).toEqual(["Started"]);
    // Its push was never logged by the shipping agent: it still wakes it (after the one read it is held).
    w.set(green({ head_sha: FIX1 }));
    await w.watch.tick();
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
  });

  // The thread's messages as the Inbox keeps them, and the shipper as the Inbox reads it (inbox-ship-agent.ts).
  type Carried = { id: string; author: { kind: "person" }; to?: { host: string; session: string } | null; launch?: { id: string; session?: string | null; session_ref?: string | null; error?: { code: "failed"; text: string; at: string } | null; deleted_at?: string | null } | null; delivery?: { state: "delivered"; host: string; session: string; at: string; read_by?: string | null } | null };
  const thread = () => {
    const messages = new Map<string, Carried>();
    const deps = { message: (id: string) => (messages.get(id) ?? null) as never, threadMessageIds: () => [...messages.keys()] };
    return {
      messages,
      over: {
        shipper: (ship: InboxShip) => shipShipper(deps, ship),
        mayBind: (ship: InboxShip, session: string) => shipBinds(deps, ship).includes(session),
        launchOf: (id: string) => messages.get(id)?.launch?.id ?? null,
        launchFailed: (ship: InboxShip) => shipLaunchFailed(deps, ship),
      },
    };
  };
  /** The person ships it again in the same thread, to a new session the reply `msg_ship` launches. */
  const shipToNew = (w: ReturnType<typeof make>, launchId = "lch_1") => {
    const { key, platform, url, title, number, repo, host, project_id } = w.ship;
    return w.watch.start({ key, platform, url, title, number, repo, host, project_id, thread_id: "thr_1", agent: { host: "claude-code", session: `launch:${launchId}`, name: "Claude Code" }, instruction_id: "msg_ship" });
  };
  const launchedReply = (launchId = "lch_1"): Carried => ({ id: "msg_ship", author: { kind: "person" }, to: { host: "claude-code", session: `launch:${launchId}` }, launch: { id: launchId, session: null, session_ref: null }, delivery: null });

  test("shipped again to a new session while the first agent is mid-turn: its late step never takes the new ship", async () => {
    const t = thread();
    const w = make(null, green(), t.over);
    await settle();
    t.messages.set("msg_ship", launchedReply());
    const again = shipToNew(w);
    await settle();
    // ses_1 was shipping it: told to stop.
    expect(w.notes.map((n) => [n.kind, n.to])).toEqual([["stop", "ses_1"]]);
    // It logs a step before its stop note arrives: it is told to stop again, and the new ship is not its.
    expect(w.watch.step("thr_1", { kind: "step", text: "Pushed a fix", sha: FIX1.slice(0, 7) }, "ses_1")).toEqual({ stopped: "#614" });
    expect(w.now().id).toBe(again.id);
    expect(w.now().bound).toBeUndefined();
    expect(w.now().told).toEqual([]);
    expect(w.now().log.map((e) => e.text)).toEqual(["Started"]);
    // A check fails before the new session started: the note waits, and goes to nobody else.
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    expect(w.notes).toHaveLength(1);
    // The launch reports its session: the waiting note goes to it.
    t.messages.set("msg_ship", { ...launchedReply(), to: { host: "claude-code", session: "ses_new" }, launch: { id: "lch_1", session: "ses_new", session_ref: "ref_1" } });
    await w.watch.tick();
    expect(w.notes.map((n) => [n.kind, n.to])).toEqual([["stop", "ses_1"], ["watch", "ses_new"]]);
    expect(w.notes[1]!.body).toContain("lint");
    expect(w.now().agent.session).toBe("ses_new");
    expect(w.watch.step("thr_1", { kind: "step", text: "Fixed lint" }, "ses_new")).toMatchObject({ ship: { id: again.id } });
    expect(w.watch.step("thr_1", { kind: "step", text: "still mine?" }, "ses_1")).toEqual({ stopped: "#614" });
    expect(w.watch.step("thr_1", { kind: "step", text: "reviewing" }, "ses_reviewer")).toEqual({ other: true });
  });

  test("a new session's ship binds to the session its own launch reported, and to no other launch's", async () => {
    const t = thread();
    const w = make(null, green(), t.over);
    await settle();
    t.messages.set("msg_ship", launchedReply());
    shipToNew(w);
    await settle();
    expect(w.now().launch_id).toBe("lch_1");
    // Nothing reported yet: a call from any session binds nothing.
    expect(w.watch.step("thr_1", { kind: "step", text: "first" }, "ses_new")).toEqual({ other: true });
    t.messages.set("msg_ship", { ...launchedReply(), to: { host: "claude-code", session: "ses_new" }, launch: { id: "lch_1", session: "ses_new", session_ref: "ref_1" } });
    const first = w.watch.step("thr_1", { kind: "step", text: "Reviewed the diff" }, "ses_new");
    expect(first && "ship" in first ? first.ship.agent.session : null).toBe("ses_new");
    expect(w.now().bound).toBe(true);
    // A launch that is not the one this ship started never binds it.
    const u = thread();
    const v = make(null, green(), u.over);
    await settle();
    u.messages.set("msg_ship", { ...launchedReply("lch_2"), to: { host: "claude-code", session: "ses_other" }, launch: { id: "lch_2", session: "ses_other", session_ref: "ref_2" } });
    const { key, platform, url, title, number, repo, host, project_id } = v.ship;
    v.watch.start({ key, platform, url, title, number, repo, host, project_id, thread_id: "thr_1", agent: { host: "claude-code", session: "launch:lch_1", name: "Claude Code" }, instruction_id: "msg_ship", launch_id: "lch_1" });
    expect(v.watch.step("thr_1", { kind: "step", text: "mine?" }, "ses_other")).toEqual({ other: true });
    expect(v.now().bound).toBeUndefined();
  });

  test("a new session's ship binds to the session its instruction was delivered to, not to another agent's read", async () => {
    const t = thread();
    const w = make(null, green(), t.over);
    await settle();
    const root: Carried = { id: "msg_ship", author: { kind: "person" }, to: null, launch: null, delivery: null };
    t.messages.set("msg_ship", root);
    const { key, platform, url, title, number, repo, host, project_id } = w.ship;
    w.watch.start({ key, platform, url, title, number, repo, host, project_id, thread_id: "thr_1", agent: { host: "claude-code", session: null, name: null }, instruction_id: "msg_ship" });
    // Settled by another agent's read: not that session's own.
    t.messages.set("msg_ship", { ...root, delivery: { state: "delivered", host: "claude-code", session: "ses_reader", at: "2026-11-24T14:20:00Z", read_by: "codex" } });
    expect(w.watch.step("thr_1", { kind: "step", text: "mine?" }, "ses_reader")).toEqual({ other: true });
    t.messages.set("msg_ship", { ...root, delivery: { state: "delivered", host: "claude-code", session: "ses_reader", at: "2026-11-24T14:20:00Z" } });
    expect(w.watch.step("thr_1", { kind: "step", text: "first" }, "ses_someone")).toEqual({ other: true });
    expect(w.watch.step("thr_1", { kind: "step", text: "Reviewed the diff" }, "ses_reader")).toMatchObject({ ship: { bound: true, agent: { session: "ses_reader" } } });
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    expect(w.notes.at(-1)).toMatchObject({ kind: "watch", to: "ses_reader" });
  });

  test("a new session whose launch failed reads Stuck at once, its launch's reason in the log; Stop still ends it", async () => {
    const t = thread();
    const w = make(null, green(), t.over);
    await settle();
    t.messages.set("msg_ship", launchedReply());
    shipToNew(w);
    await settle();
    expect(w.now().state).toBe("shipping");
    // The launch answers: it did not start. The launch's own change tells the watch, no tick needed.
    t.messages.set("msg_ship", { ...launchedReply(), launch: { id: "lch_1", session: null, session_ref: null, error: { code: "failed", text: "Claude Code isn't installed here.", at: "2026-11-24T14:19:05Z" } } });
    w.watch.starting();
    expect(w.now().state).toBe("stuck");
    expect(w.now().reason).toBe(SHIP_START_STUCK);
    expect(w.now().log.at(-1)!.text).toBe(`Stuck: ${SHIP_START_STUCK} (Claude Code isn't installed here.)`);
    // Ticks after it change nothing, and tell nobody.
    await w.watch.tick();
    expect(w.now().log.filter((e) => e.kind === "stuck")).toHaveLength(1);
    w.watch.stop(w.now().id);
    expect(w.now().state).toBe("stopped");
  });

  test("a new session that never reports a session reads Stuck at the watch's first tick, and nothing waits on it for ever", async () => {
    const t = thread();
    const w = make(null, green(), t.over);
    await settle();
    t.messages.set("msg_ship", launchedReply());
    shipToNew(w);
    await settle();
    w.later(30_000);
    await w.watch.tick();
    expect(w.now().state).toBe("shipping");
    // The watch's own tick, two minutes after Ship.
    w.later(90_000);
    await w.watch.tick();
    expect(w.now().state).toBe("stuck");
    expect(w.now().reason).toBe(SHIP_START_STUCK);
    expect(w.now().log.at(-1)!.text).toBe(`Stuck: ${SHIP_START_STUCK} (no session started)`);
    expect(w.notes.filter((n) => n.kind === "watch")).toEqual([]);
  });

  test("a session reported after Stuck binds the ship, it recovers by itself, and the notes that waited go out once", async () => {
    const t = thread();
    const w = make(null, green(), t.over);
    await settle();
    t.messages.set("msg_ship", launchedReply());
    shipToNew(w);
    await settle();
    w.later(2 * 60_000);
    w.set(green({ checks: "failure", failing: ["lint"] }));
    await w.watch.tick();
    expect(w.now().state).toBe("stuck");
    expect(w.notes.filter((n) => n.kind === "watch")).toEqual([]);
    // The launch reports its session late.
    t.messages.set("msg_ship", { ...launchedReply(), to: { host: "claude-code", session: "ses_new" }, launch: { id: "lch_1", session: "ses_new", session_ref: "ref_1" } });
    w.watch.starting();
    await settle();
    await settle();
    expect(w.now().state).toBe("shipping");
    expect(w.now().reason).toBeNull();
    expect(w.now().agent.session).toBe("ses_new");
    expect(w.notes.filter((n) => n.kind === "watch").map((n) => n.to)).toEqual(["ses_new"]);
    expect(w.notes.at(-1)!.body).toContain("lint");
    await w.watch.tick();
    await w.watch.tick();
    expect(w.notes.filter((n) => n.kind === "watch")).toHaveLength(1);
  });

  test("pushes the agent never logs hold a 'someone pushed' note back one read per head at most", async () => {
    const w = make();
    await settle();
    const heads = ["1", "2", "3", "4"].map((c) => c.repeat(40));
    // A new head every read, none logged: the first read holds it, the next tells (the head it finds), and so on.
    const told: number[] = [];
    for (const head of heads) {
      w.set(green({ head_sha: head }));
      await w.watch.tick();
      told.push(w.notes.length);
    }
    expect(told).toEqual([0, 1, 1, 2]);
    expect(w.notes[0]!.body).toContain("2222222");
    expect(w.notes[1]!.body).toContain("4444444");
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
    const stepped = watch.step("thr_1", { kind: "step", text: "Fixed e2e" }, "ses_1");
    expect(stepped && "ship" in stepped ? stepped.ship.log.at(-1)!.text : null).toBe("Fixed e2e");
  });

  const MINI = { id: "mch_mini", name: "Mac mini" };

  test("a ship tells the linked computers it started; told of a ship of the PR pressed there after it, this one stops", async () => {
    const w = make();
    await settle();
    expect(w.started.map((s) => s.id)).toEqual([w.ship.id]);
    expect(w.now().generation).toBe(1);
    // The Mini heard of this one (generation 1) and the person pressed Ship there: generation 2 stops this one.
    const stopped = w.watch.newer({ key: KEY, id: "shp_new", started_at: "2026-11-24T15:00:00.000Z", generation: 2 }, MINI);
    expect(stopped?.state).toBe("stopped");
    expect(w.now().log.at(-1)!.text).toBe("Stopped: shipping on Mac mini");
    expect(w.notes.map((n) => [n.kind, n.to])).toEqual([["stop", "ses_1"]]);
  });

  test("a Ship just pressed on a computer whose clock is 3 minutes slow still wins over the older one", async () => {
    const answers: { ship: InboxShip; to: string }[] = [];
    const w = make(null, green(), { answers });
    await settle();
    // The Mini heard of this ship (14:19 here) and the person pressed Ship there a minute later; its clock reads 14:17.
    const stopped = w.watch.newer({ key: KEY, id: "shp_mini", started_at: "2026-11-24T14:17:00.000Z", generation: 2 }, MINI);
    expect(stopped?.state).toBe("stopped");
    expect(answers).toEqual([]);
    // Shipping again here knows of the Mini's: it takes the next generation.
    const { key, platform, url, title, number, repo, host, project_id } = w.ship;
    const again = w.watch.start({ key, platform, url, title, number, repo, host, project_id, thread_id: "thr_1", agent: { host: "claude-code", session: "ses_1", name: "Claude Code" }, bound: true });
    expect(again.generation).toBe(3);
  });

  test("word of an older Ship (a lower generation) stops nothing here and is answered, so that one stops", async () => {
    const answers: { ship: InboxShip; to: string }[] = [];
    const w = make(null, green(), { answers });
    await settle();
    const { key, platform, url, title, number, repo, host, project_id } = w.ship;
    // Pressed again here: generation 2.
    const mine = w.watch.start({ key, platform, url, title, number, repo, host, project_id, thread_id: "thr_1", agent: { host: "claude-code", session: "ses_1", name: "Claude Code" }, bound: true });
    expect(mine.generation).toBe(2);
    // The Mini's word of its own older press arrives late, with a clock far ahead: it changes nothing here.
    expect(w.watch.newer({ key: KEY, id: "shp_mini", started_at: "2026-11-24T23:59:00.000Z", generation: 1 }, MINI)).toBeNull();
    expect(w.now().state).toBe("shipping");
    expect(answers.map((a) => [a.ship.id, a.to])).toEqual([[mine.id, "mch_mini"]]);
    // Two presses that never heard of each other (the same generation): the later press by each computer's own time
    // wins, whatever the ids, the same way on both computers. This one was pressed at 14:19 here.
    expect(w.watch.newer({ key: KEY, id: "shp_zzzzzzzzzzzzzzzzzzzzzzzz", started_at: "2026-11-24T14:00:00.000Z", generation: 2 }, MINI)).toBeNull();
    expect(w.now().state).toBe("shipping");
    expect(w.watch.newer({ key: KEY, id: "shp_0", started_at: "2026-11-24T14:25:00.000Z", generation: 2 }, MINI)?.state).toBe("stopped");
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
