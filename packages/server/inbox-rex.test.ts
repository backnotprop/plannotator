/**
 * The Inbox and Rex (inbox-rex.ts), against a fake Rex server (tests/helpers/fake-rex.ts): where an agent lives is
 * shown only when Rex confirms it and a list never waits on Rex; Show in Rex asks the app only at the click and counts
 * only a confirmed success; starting in Rex makes its tab only in a session the Inbox made, through a login shell; what
 * a pane says it is doing is read only for a confirmed block, state and kind only, never with an attach; only an app
 * attached over this computer's own socket is ever acted through; Stop closes only the agent's own pane; and nothing
 * beyond ids, labels, status records, new tabs, focus and closing that pane is ever asked of Rex.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startFakeRex, type FakeRex } from "../../tests/helpers/fake-rex";
import { createInboxRex, inboxAppBundleOf, inboxRexLine, inboxRexSocketOk, inboxRexSocketPath, inboxRexStatusOf, INBOX_REX_MARK_STALE_MS, INBOX_REX_SLOW_BACKOFF_MS, type InboxRex } from "./inbox-rex";
import type { InboxPlace } from "@plannotator/shared/inbox/connection";

/** Every method the Inbox may call: view (ids and labels), status records (`block.method` `program_status` only), a new session or tab with its command, focus, Stop's close of a pane. */
const ALLOWED = new Set(["target.resolve", "client.list", "client.perform", "session.attach", "session.attach_all", "session.create", "session.new_window", "session.focus_block", "block.method", "block.close"]);

const fakes: FakeRex[] = [];
const rexes: InboxRex[] = [];
afterEach(async () => {
  for (const rex of rexes.splice(0)) rex.close();
  for (const fake of fakes.splice(0)) {
    expect(fake.methods().filter((m) => !ALLOWED.has(m))).toEqual([]);
    expect(fake.calls.filter((c) => c.method === "block.method" && c.payload.method !== "program_status")).toEqual([]);
    await fake.stop();
  }
});

function setup(options: Parameters<typeof startFakeRex>[0] = {}, rexOptions: Partial<Parameters<typeof createInboxRex>[0]> = {}) {
  const fake = startFakeRex(options);
  fakes.push(fake);
  const rex = createInboxRex({ socketPath: fake.socketPath, readTimeoutMs: 1_000, openTimeoutMs: 2_000, showTimeoutMs: 2_000, ...rexOptions });
  rexes.push(rex);
  return { fake, rex };
}

const placeOf = (ids: { session: string; block: string }): InboxPlace => ({ kind: "rex", session: ids.session, block: ids.block });

/** The list's answer once the background read it started has come back. */
async function placesRead(rex: InboxRex, hints: ReadonlyMap<string, InboxPlace>) {
  rex.places(hints);
  await rex.settled();
  return rex.places(hints);
}

describe("where an agent lives", () => {
  test("answered at once from the last read; a place Rex confirms gets its line, with the names read then", async () => {
    let clock = 1_000_000;
    const changes: number[] = [];
    const { fake, rex } = setup({}, { now: () => clock, onChange: () => changes.push(rex.version()) });
    const ids = fake.addSession("plannotator", "Claude Code");
    const hints = new Map([["sess-1", placeOf(ids)]]);
    // The first ask has nothing yet: it never waits on Rex.
    expect(rex.places(hints).size).toBe(0);
    await rex.settled();
    expect(rex.places(hints).get("sess-1")).toBe("Rex · plannotator / Claude Code");
    expect(changes.length).toBe(1);

    // Renamed in Rex: the next read says the new names (nothing was kept past it).
    fake.rename(ids.session, "renamed");
    fake.rename(ids.window, "tab two");
    clock += 3_000;
    expect((await placesRead(rex, hints)).get("sess-1")).toBe("Rex · renamed / tab two");
    expect(changes.length).toBe(2);
  });

  test("an idle close never drops a read that already started, and still closes once idle", async () => {
    let clock = 1_000_000;
    const changes: number[] = [];
    const { fake, rex } = setup({}, { idleCloseMs: 150, readTimeoutMs: 1_000, now: () => clock, onChange: () => changes.push(rex.version()) });
    const ids = fake.addSession("plannotator", "Claude Code");
    fake.setStatus(ids.block, [{ state: "working", app: "claude-code", updated_at: "2026-11-20T10:00:00Z" }]);
    const hints = new Map([["sess-1", placeOf(ids)]]);

    expect((await placesRead(rex, hints)).get("sess-1")).toBe("Rex · plannotator / Claude Code");
    expect(rex.statuses(hints).get("sess-1")).toEqual({ state: "working" });
    expect(changes.length).toBe(1);
    const attachesAfterFirst = fake.calls.filter((c) => c.method === "session.attach_all").length;
    expect(attachesAfterFirst).toBe(1);

    // Start the next read before idleCloseMs expires and let block.method finish well past idleCloseMs.
    await Bun.sleep(30);
    clock += 3_000;
    fake.setDelay(200, "block.method");
    expect((await placesRead(rex, hints)).get("sess-1")).toBe("Rex · plannotator / Claude Code");
    expect(rex.statuses(hints).get("sess-1")).toEqual({ state: "working" });
    expect(rex.appAttached()).toBe(true);
    expect(changes.length).toBe(1);
    // The existing connection was reused instead of dropped mid-read.
    expect(fake.calls.filter((c) => c.method === "session.attach_all").length).toBe(attachesAfterFirst);

    // Once truly idle past idleCloseMs, the connection closes and a later read opens a fresh one.
    fake.setDelay(0, "block.method");
    await Bun.sleep(250);
    clock += 3_000;
    expect((await placesRead(rex, hints)).get("sess-1")).toBe("Rex · plannotator / Claude Code");
    expect(fake.calls.filter((c) => c.method === "session.attach_all").length).toBe(attachesAfterFirst + 1);
  });

  test("a faster overlapping read does not arm the idle close under a slower read still in flight", async () => {
    let clock = 1_000_000;
    const changes: number[] = [];
    const { fake, rex } = setup({}, { idleCloseMs: 60, readTimeoutMs: 1_000, now: () => clock, onChange: () => changes.push(rex.version()) });
    const ids = fake.addSession("plannotator", "Claude Code");
    fake.setStatus(ids.block, [{ state: "working", app: "claude-code", updated_at: "2026-11-20T10:00:00Z" }]);
    const hints = new Map([["sess-1", placeOf(ids)]]);

    expect((await placesRead(rex, hints)).get("sess-1")).toBe("Rex · plannotator / Claude Code");
    expect(changes.length).toBe(1);

    // Delay only block.method so readNow stays in flight longer than idleCloseMs while paneGone completes immediately.
    clock += 3_000;
    fake.setDelay(180, "block.method");
    rex.places(hints);
    expect(await rex.paneGone(placeOf(ids))).toBe(false);
    await rex.settled();
    expect(rex.places(hints).get("sess-1")).toBe("Rex · plannotator / Claude Code");
    expect(rex.statuses(hints).get("sess-1")).toEqual({ state: "working" });
    expect(changes.length).toBe(1);
  });

  test("the last read stands until the next replaces it: no gap after a quiet spell; a slow Rex keeps it until stale", async () => {
    let clock = 1_000_000;
    const { fake, rex } = setup({}, { readTimeoutMs: 150, now: () => clock });
    const ids = fake.addSession("p", "t");
    const hints = new Map([["s", placeOf(ids)]]);
    expect((await placesRead(rex, hints)).get("s")).toBe("Rex · p / t");
    expect(rex.appAttached()).toBe(true);
    // A minute with no list read: the next read answers with the last confirmed line at once (and reads again).
    clock += 60_000;
    expect(rex.places(hints).get("s")).toBe("Rex · p / t");
    expect(rex.appAttached()).toBe(true);
    await rex.settled();
    // Rex is slow once: what it said last stands (one slow answer never blanks every place and mark)…
    clock += 3_000;
    fake.setDelay(Infinity);
    expect((await placesRead(rex, hints)).get("s")).toBe("Rex · p / t");
    expect(rex.appAttached()).toBe(true);
    await rex.settled();
    // …until it is stale, when it goes.
    clock += INBOX_REX_MARK_STALE_MS + 1_000;
    expect((await placesRead(rex, hints)).size).toBe(0);
    expect(rex.appAttached()).toBe(false);
  });

  test("Rex 0.1 reads a pane's status only on a connection attached to its session: the read attaches to all (no session joined); the older Rex needs none", async () => {
    for (const revision of [18, 7] as const) {
      const { fake, rex } = setup({ revision });
      const ids = fake.addSession("p", "t");
      fake.setStatus(ids.block, [{ state: "blocked", kind: "question", app: "claude-code", updated_at: "2026-11-18T09:00:00Z" }]);
      const hints = new Map([["s", placeOf(ids)]]);
      await placesRead(rex, hints);
      expect(rex.statuses(hints).get("s")).toEqual({ state: "blocked", kind: "question" });
      expect(fake.calls.filter((c) => c.method === "session.attach_all").map((c) => c.payload)).toEqual([{ event_scope: "session" }]);
      // Never joined to the person's session (that would make the Inbox one of its clients).
      expect(fake.methods()).not.toContain("session.attach");
    }
  });

  test("a miss shows nothing: a block that is gone, or one in another session than the hint says", async () => {
    const { fake, rex } = setup();
    const a = fake.addSession("one", "a");
    const b = fake.addSession("two", "b");
    const shown = await placesRead(
      rex,
      new Map([
        ["gone", { kind: "rex", session: a.session, block: "block:01a1eb35-0de6-701f-808a-16e06621d0ae" }],
        ["elsewhere", { kind: "rex", session: a.session, block: b.block }],
        ["no-session", { kind: "rex", session: "session:01a1eb35-0de6-701f-808a-16e06621d0ae", block: a.block }],
        ["here", placeOf(b)],
      ]),
    );
    expect([...shown.keys()]).toEqual(["here"]);
  });

  test("names Rex gives are drawn on one line, without control or bidi characters", async () => {
    const { fake, rex } = setup();
    const ids = fake.addSession("a‮b\nc", `x${"y".repeat(100)}`);
    const line = (await placesRead(rex, new Map([["s", placeOf(ids)]]))).get("s")!;
    expect(line).not.toMatch(/[‮\n]/);
    expect(line.startsWith("Rex · a b c / x")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(inboxRexLine("", "")).toBe("Rex");
  });

  test("no Rex here: nothing, quickly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-rex-"));
    const none = createInboxRex({ socketPath: join(dir, "server.sock") });
    rexes.push(none);
    const started = performance.now();
    expect((await placesRead(none, new Map([["s", { kind: "rex", session: "session:01a1eb35-0de6-701f-808a-16e06621d0ae", block: "block:01a1eb35-0de6-701f-808a-16e06621d0ae" }]]))).size).toBe(0);
    expect(none.appAttached()).toBe(false);
    expect(await none.open({ project: "p", projectKey: "p", tab: "t", command: "true" })).toEqual({ opened: false, sent: false });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(inboxRexSocketPath("linux", "/home/x")).toBeNull();
    expect(inboxRexSocketPath("darwin", "/Users/x")).toBe("/Users/x/Library/Application Support/rex/server.sock");
  });

  test("only a socket of this user's own: never a link to one, a plain file, or another user's", async () => {
    const { fake } = setup();
    const dir = mkdtempSync(join(tmpdir(), "rex-sock-"));
    const link = join(dir, "link.sock");
    symlinkSync(fake.socketPath, link);
    const file = join(dir, "file.sock");
    writeFileSync(file, "");
    const uid = process.getuid!();
    expect(inboxRexSocketOk(fake.socketPath, uid)).toBe(true);
    expect(inboxRexSocketOk(link, uid)).toBe(false);
    expect(inboxRexSocketOk(file, uid)).toBe(false);
    expect(inboxRexSocketOk(fake.socketPath, uid + 1)).toBe(false);
    // Through the link: never connected.
    const linked = createInboxRex({ socketPath: link });
    rexes.push(linked);
    const ids = fake.addSession("p", "t");
    expect((await placesRead(linked, new Map([["s", placeOf(ids)]]))).size).toBe(0);
    expect(fake.connections().opened).toBe(0);
  });

  test("a slow Rex: the list never waits; nothing past the deadline, and Rex is left alone a while after", async () => {
    let clock = 1_000_000;
    const { fake, rex } = setup({}, { readTimeoutMs: 150, now: () => clock });
    const ids = fake.addSession("p", "t");
    const hints = new Map([["s", placeOf(ids)]]);
    fake.setDelay(Infinity);
    const started = performance.now();
    expect(rex.places(hints).size).toBe(0);
    expect(performance.now() - started).toBeLessThan(50);
    await rex.settled();
    const opened = fake.connections().opened;
    fake.setDelay(0);
    clock += 3_000;
    expect((await placesRead(rex, hints)).size).toBe(0);
    expect(fake.connections().opened).toBe(opened);
    clock += INBOX_REX_SLOW_BACKOFF_MS;
    expect((await placesRead(rex, hints)).size).toBe(1);
  });
});

describe("the app attached here", () => {
  test("a Mac app over this computer's socket as this user (Show in Rex is offered while it is)", async () => {
    const { rex } = setup();
    rex.appAttached();
    await rex.settled();
    expect(rex.appAttached()).toBe(true);
    expect(rex.offersShow()).toBe(true);
  });

  test("the first ask after the Inbox starts (Settings → Agents' read) waits for one read: right at once, not the empty answer", async () => {
    const { fake, rex } = setup();
    expect(await rex.appAttachedNow()).toBe(true);
    const gone = setup();
    gone.fake.setApp(false);
    expect(await gone.rex.appAttachedNow()).toBe(false);
    expect(fake.connections().opened).toBe(1);
  });

  test("an app attached over the tailnet (another computer's) is never one", async () => {
    const { fake, rex } = setup({ appTransport: "tailscale", remote: true });
    rex.appAttached();
    await rex.settled();
    expect(rex.appAttached()).toBe(false);
    expect(rex.offersShow()).toBe(false);
    const ids = fake.addSession("p", "t");
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false });
    expect(await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).toEqual({ opened: false, sent: false });
    expect(fake.methods()).not.toContain("client.perform");
    expect(fake.methods()).not.toContain("session.create");
  });

  test("an app connected as another user is never one", async () => {
    const { rex } = setup({ appUid: process.getuid!() + 1 });
    rex.appAttached();
    await rex.settled();
    expect(rex.appAttached()).toBe(false);
  });
});

describe("Stop and a closed tab", () => {
  test("a start in Rex knows the pane Rex made (a new session's, or a new tab's in the Inbox's session)", async () => {
    const { fake, rex } = setup();
    const first = await rex.open({ project: "p", projectKey: "p", tab: "One", command: "c" });
    const second = await rex.open({ project: "p", projectKey: "p", tab: "Two", command: "c" });
    if (!first.opened || !second.opened) throw new Error("not opened");
    const made = fake.sessions.find((s) => s.session_id === first.session)!;
    expect(first.block).toBe(made.windows[0]!.blocks[0]!);
    expect(second.block).toBe(made.windows[1]!.blocks[0]!);
  });

  test("Stop closes only that pane (the tab goes with its last pane); one already gone counts as closed; no Rex or Rex's error: not closed", async () => {
    const { fake, rex } = setup();
    const opened = await rex.open({ project: "p", projectKey: "p", tab: "Agent", command: "c" });
    if (!opened.opened || !opened.block) throw new Error("not opened");
    const pane = placeOf({ session: opened.session, block: opened.block });
    const other = fake.addSession("their work", "shell");
    expect(await rex.closePane(pane)).toBe("closed");
    expect(fake.calls.filter((c) => c.method === "block.close").map((c) => c.payload)).toEqual([{ session_id: opened.session, block_id: opened.block }]);
    expect(fake.sessions.find((s) => s.session_id === opened.session)!.windows).toEqual([]);
    expect(fake.sessions.find((s) => s.session_id === other.session)!.windows[0]!.blocks).toEqual([other.block]);
    // Closed by hand already, or its session gone: Rex has no such pane.
    expect(await rex.closePane(pane)).toBe("gone");
    expect(await rex.closePane(placeOf({ session: "session:00000000-0000-4000-8000-000000000000", block: opened.block }))).toBe("gone");
    fake.setRefusal("block.close", { code: "permission_denied", message: "no", status: 403 });
    expect(await rex.closePane(placeOf(other))).toBe("refused");
    fake.setRefusal("block.close", null);
    fake.setDelay(Infinity, "block.close");
    const slow = createInboxRex({ socketPath: fake.socketPath, showTimeoutMs: 150 });
    rexes.push(slow);
    expect(await slow.closePane(placeOf(other))).toBe("no_answer");
    const none = createInboxRex({ socketPath: null });
    rexes.push(none);
    expect(await none.closePane(pane)).toBe("no_answer");
  });

  test("whether a pane is gone: Rex's own word (gone, there), or none when Rex does not answer", async () => {
    const { fake, rex } = setup();
    const ids = fake.addSession("p", "t");
    expect(await rex.paneGone(placeOf(ids))).toBe(false);
    expect(await rex.paneGone(placeOf({ session: ids.session, block: "block:00000000-0000-4000-8000-000000000000" }))).toBe(true);
    // Its whole session gone.
    expect(await rex.paneGone(placeOf({ session: "session:00000000-0000-4000-8000-000000000000", block: ids.block }))).toBe(true);
    const none = createInboxRex({ socketPath: null });
    rexes.push(none);
    expect(await none.paneGone(placeOf(ids))).toBeNull();
  });
});

describe("Show in Rex", () => {
  test("reading where agents live never asks the app anything", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    await placesRead(rex, new Map([["s", placeOf(ids)]]));
    rex.offersShow();
    expect(fake.methods()).not.toContain("client.perform");
  });

  test("goes to the pane on the click: select its tab, then focus the pane in a session the Inbox made", async () => {
    const { fake, rex } = setup({ remote: true });
    const opened = await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" });
    if (!opened.opened) throw new Error("not opened");
    const made = fake.sessions.find((s) => s.session_id === opened.session)!;
    const ids = { session: made.session_id, window: made.windows[0]!.window_id, block: made.windows[0]!.blocks[0]! };
    expect(await rex.show(placeOf(ids))).toEqual({ shown: true });
    const select = fake.calls.find((c) => c.method === "client.perform")!;
    expect(select.payload.action).toBe("session.select");
    expect(select.payload.args).toEqual({ session_id: ids.session, window_id: ids.window });
    expect(fake.calls.find((c) => c.method === "session.focus_block")?.payload).toEqual({ session_id: ids.session, block_id: ids.block });
  });

  test("the app brought to the front is the outermost bundle of its executable, never a helper app inside it", () => {
    expect(inboxAppBundleOf("/Applications/Rex Beta.app/Contents/MacOS/Rex")).toBe("/Applications/Rex Beta.app");
    expect(inboxAppBundleOf("/Applications/Rex.app/Contents/Frameworks/Rex Helper.app/Contents/MacOS/Rex Helper")).toBe("/Applications/Rex.app");
    expect(inboxAppBundleOf("/usr/local/bin/rex")).toBeNull();
    expect(inboxAppBundleOf("Rex.app/Contents/MacOS/Rex")).toBeNull();
  });

  test("Rex's app comes to the front once it went to the pane (by its process id); never when it did not go there", async () => {
    const raised: number[] = [];
    const { fake, rex } = setup({ remote: true, appPid: 4321 }, { raiseApp: (pid) => raised.push(pid) });
    const ids = fake.addSession("p", "t");
    expect(await rex.show(placeOf(ids))).toEqual({ shown: true });
    expect(raised).toEqual([4321]);
    fake.setRemote(false);
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false, refused: true });
    expect(raised).toEqual([4321]);
  });

  test("an agent the person started by hand in a session of their own: the app goes to its tab and the pane gets the focus too", async () => {
    const { fake, rex } = setup({ remote: true });
    const theirs = fake.addSession("their work", "shell");
    expect(await rex.show(placeOf(theirs))).toEqual({ shown: true });
    expect(fake.calls.find((c) => c.method === "session.focus_block")?.payload).toEqual({ session_id: theirs.session, block_id: theirs.block });
  });

  test("a refusal (Remote Control off) hides it for a minute, then it is offered again by itself; Rex's app gone and back brings it at once", async () => {
    let clock = Date.parse("2026-11-18T09:00:00.000Z");
    const { fake, rex } = setup({ remote: true }, { now: () => clock });
    const ids = fake.addSession("p", "t");
    rex.appAttached();
    await rex.settled();
    expect(rex.offersShow()).toBe(true);
    fake.setRemote(false);
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false, refused: true });
    expect(rex.offersShow()).toBe(false);
    // A new tab is Rex's server's (taken with Remote Control off too): it says nothing of Show.
    expect((await rex.open({ project: "p", projectKey: "p", tab: "t2", command: "c" })).opened).toBe(true);
    expect(rex.offersShow()).toBe(false);
    clock += 59_000;
    expect(rex.offersShow()).toBe(false);
    // A minute on: offered again, never hidden until a restart.
    clock += 1_500;
    expect(rex.offersShow()).toBe(true);
    // Refused again; then Rex's app quits and comes back (Remote Control may be on now): offered at once.
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false, refused: true });
    expect(rex.offersShow()).toBe(false);
    fake.setApp(false);
    clock += 3_000;
    rex.appAttached();
    await rex.settled();
    fake.setApp(true);
    clock += 3_000;
    rex.appAttached();
    await rex.settled();
    expect(rex.offersShow()).toBe(true);
    fake.setRemote(true);
    expect(await rex.show(placeOf(ids))).toEqual({ shown: true });
    expect(rex.offersShow()).toBe(true);
  });

  test("the windows hear when a hidden Show in Rex comes back by itself (nothing else may change meanwhile)", async () => {
    const { fake, rex } = setup({ remote: false }, { showRefusedMs: 80 });
    const ids = fake.addSession("p", "t");
    rex.appAttached();
    await rex.settled();
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false, refused: true });
    const hidden = rex.version();
    expect(rex.offersShow()).toBe(false);
    for (let i = 0; i < 100 && rex.version() === hidden; i++) await Bun.sleep(10);
    expect(rex.version()).toBeGreaterThan(hidden);
    expect(rex.offersShow()).toBe(true);
  });

  test("an answer of a shape it does not know counts as no", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    expect(await rex.show(placeOf(ids))).toEqual({ shown: true });
    fake.setPerformAnswer({ payload: { ok: true } });
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false, refused: true });
    expect(rex.offersShow()).toBe(false);
  });

  test("an app that does not answer in time counts as no", async () => {
    const { fake, rex } = setup({ remote: true }, { showTimeoutMs: 200 });
    const ids = fake.addSession("p", "t");
    fake.setDelay(Infinity, "client.perform");
    const started = performance.now();
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false, refused: true });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(fake.methods()).not.toContain("session.focus_block");
  });

  test("a pane that is gone: nothing is asked of the app", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    expect(await rex.show({ kind: "rex", session: ids.session, block: "block:01a1eb35-0de6-701f-808a-16e06621d0ae" })).toEqual({ shown: false });
    expect(fake.methods()).not.toContain("client.perform");
  });
});

describe("what a pane says it is doing", () => {
  test("the confirmed block's own record, state and kind only: never its free text, never another block's, never with an attach", async () => {
    let clock = 1_000_000;
    const { fake, rex } = setup({}, { now: () => clock });
    const mine = fake.addSession("proj", "Claude Code");
    const other = fake.addSession("theirs", "zsh");
    fake.setStatus(mine.block, [
      { state: "blocked", kind: "permission", app: "claude-code", title: "VGl0bGU=", msg: "Run rm -rf build?" },
      // A child record (a helper's) is not the program's own state.
      { id: "plannotator/plan", state: "working", app: "plannotator" },
    ]);
    fake.setStatus(other.block, [{ state: "working", app: "bash" }]);
    const hints = new Map([["ses_a", placeOf(mine)]]);
    await placesRead(rex, hints);
    expect(rex.statuses(hints).get("ses_a")).toEqual({ state: "blocked", kind: "permission" });
    const asked = fake.calls.filter((c) => c.method === "block.method");
    expect(asked.map((c) => c.payload.block_id)).toEqual([mine.block]);
    expect(fake.methods()).not.toContain("session.attach");

    // It changes: the next read says so (and the list hears of it).
    const before = rex.version();
    fake.setStatus(mine.block, [{ state: "working", app: "claude-code" }]);
    clock += 3_000;
    await placesRead(rex, hints);
    expect(rex.statuses(hints).get("ses_a")).toEqual({ state: "working" });
    expect(rex.version()).toBeGreaterThan(before);
  });

  test("an icon's mark only from a fresh read: stale, none; the next read brings it back and the list hears of it", async () => {
    let clock = 1_000_000;
    const { fake, rex } = setup({}, { now: () => clock });
    const ids = fake.addSession("proj", "Claude Code");
    fake.setStatus(ids.block, [{ state: "blocked", kind: "question", app: "claude-code" }]);
    const hints = new Map([["ses_m", placeOf(ids)]]);
    await placesRead(rex, hints);
    expect(rex.freshStatuses(hints).get("ses_m")).toEqual({ state: "blocked", kind: "question" });
    clock += INBOX_REX_MARK_STALE_MS + 1;
    // Stale: no mark (the hover card's word still stands until the next read).
    expect(rex.freshStatuses(hints).size).toBe(0);
    expect(rex.statuses(hints).get("ses_m")).toEqual({ state: "blocked", kind: "question" });
    const before = rex.version();
    await placesRead(rex, hints);
    expect(rex.freshStatuses(hints).get("ses_m")).toEqual({ state: "blocked", kind: "question" });
    expect(rex.version()).toBeGreaterThan(before);
  });

  test("no record, an unknown state or a failed read: no status (the place still shows)", async () => {
    const { fake, rex } = setup();
    const ids = fake.addSession("proj", "Pi");
    const hints = new Map([["ses_b", placeOf(ids)]]);
    expect((await placesRead(rex, hints)).get("ses_b")).toBe("Rex · proj / Pi");
    expect(rex.statuses(hints).size).toBe(0);
    expect(inboxRexStatusOf({ records: [{ state: "sleeping" }] })).toBeNull();
    expect(inboxRexStatusOf({ records: [{ state: "blocked", kind: "payment" }] })).toEqual({ state: "blocked" });
    expect(inboxRexStatusOf({ records: [{ state: "done", kind: "question" }] })).toEqual({ state: "done" });
    expect(inboxRexStatusOf(null)).toBeNull();
  });

  test("while a window watches, the read is kept fresh without a list read (at most every few seconds)", async () => {
    let clock = 1_000_000;
    const { fake, rex } = setup({}, { now: () => clock });
    const ids = fake.addSession("proj", "Claude Code");
    const hints = new Map([["ses_c", placeOf(ids)]]);
    rex.watch(hints);
    await rex.settled();
    const reads = () => fake.calls.filter((c) => c.method === "block.method").length;
    expect(reads()).toBe(1);
    rex.watch(hints);
    await rex.settled();
    expect(reads()).toBe(1);
    clock += 3_000;
    rex.watch(hints);
    await rex.settled();
    expect(reads()).toBe(2);
  });
});

describe("Start in Rex (its tab)", () => {
  const terminal = (command: string, path?: string[]) => ({
    block: { flavor: "com.superlogical.terminal.shell", options: { command: ["/bin/sh", "-c", command], login: true, ...(path ? { path_prepend: path } : {}) } },
  });

  test("only when Rex's app is attached here", async () => {
    const { fake, rex } = setup({ app: false });
    expect(await rex.open({ project: "p", projectKey: "p", tab: "Claude Code", command: "echo hi" })).toEqual({ opened: false, sent: false });
    expect(fake.methods()).not.toContain("session.create");
  });

  test("a session of its own for the project, its first tab running the command through a login shell", async () => {
    const { fake, rex } = setup();
    const opened = await rex.open({ project: "my-app", projectKey: "proj-1", tab: "Claude Code", command: "plannotator attach 'x'", pathPrepend: ["/opt/bin", "/home/me/.bun/bin"] });
    expect(opened).toMatchObject({ opened: true, line: "Rex · my-app / Claude Code" });
    const create = fake.calls.find((c) => c.method === "session.create")!;
    expect(create.payload).toEqual({ label: "my-app", initial_windows: [{ window_label: "Claude Code", layout: terminal("plannotator attach 'x'", ["/opt/bin", "/home/me/.bun/bin"]) }] });
    expect(fake.sessions.map((s) => s.label)).toEqual(["my-app"]);
  });

  test("a session the Inbox did not make is never used, even with the project's name", async () => {
    const { fake, rex } = setup({ remote: true });
    const theirs = fake.addSession("my-app", "older");
    const opened = await rex.open({ project: "my-app", projectKey: "proj-1", tab: "Codex", command: "run it" });
    expect(opened.opened).toBe(true);
    expect(fake.methods()).not.toContain("session.new_window");
    expect(fake.methods()).not.toContain("session.attach");
    expect(fake.sessions.find((s) => s.session_id === theirs.session)!.windows.map((w) => w.label)).toEqual(["older"]);
    // The app is never moved by a start.
    expect(fake.methods()).not.toContain("client.perform");
  });

  test("the session it made, by the id and label it kept: a new tab there; renamed by the person or gone: a new session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rex-kept-"));
    const file = join(dir, "rex-sessions.json");
    const { fake, rex } = setup({ remote: true }, { sessionsFile: file });
    const first = await rex.open({ project: "my-app", projectKey: "proj-1", tab: "Claude Code", command: "a" });
    if (!first.opened) throw new Error("not opened");
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual({ "proj-1": { id: first.session, label: "my-app" } });

    // Another Inbox run (the file is what it remembers): the same session gets the next tab.
    const again = createInboxRex({ socketPath: fake.socketPath, sessionsFile: file });
    rexes.push(again);
    const second = await again.open({ project: "my-app", projectKey: "proj-1", tab: "Codex", command: "b" });
    expect(second).toMatchObject({ opened: true, session: first.session, line: "Rex · my-app / Codex" });
    expect(fake.calls.find((c) => c.method === "session.new_window")!.payload).toEqual({ session_id: first.session, window_label: "Codex", layout: terminal("b"), focus: false });
    expect(fake.sessions).toHaveLength(1);

    // The person renamed it: theirs now. It gets no tab (and no switch); a new one is made and kept.
    fake.rename(first.session, "my work");
    const third = await again.open({ project: "my-app", projectKey: "proj-1", tab: "Pi", command: "c" });
    if (!third.opened) throw new Error("not opened");
    expect(third.session).not.toBe(first.session);
    expect(fake.sessions.find((s) => s.session_id === first.session)!.windows.map((w) => w.label)).toEqual(["Claude Code", "Codex"]);
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual({ "proj-1": { id: third.session, label: "my-app" } });

    // The person closed that one: a new one again.
    fake.sessions.splice(fake.sessions.findIndex((s) => s.session_id === third.session), 1);
    const fourth = await again.open({ project: "my-app", projectKey: "proj-1", tab: "Pi", command: "d" });
    if (!fourth.opened) throw new Error("not opened");
    expect([first.session, third.session]).not.toContain(fourth.session);
  });

  test("Remote Control off: the tab is still made, and that is an open", async () => {
    const { fake, rex } = setup({ remote: false });
    expect((await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).opened).toBe(true);
    expect(fake.sessions).toHaveLength(1);
  });

  test("a start never moves Rex's app: no select, and its tab is made without the focus", async () => {
    const { fake, rex } = setup({ remote: true });
    expect((await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).opened).toBe(true);
    expect((await rex.open({ project: "p", projectKey: "p", tab: "t2", command: "c" })).opened).toBe(true);
    expect(fake.methods()).not.toContain("client.perform");
    expect(fake.calls.find((c) => c.method === "session.new_window")!.payload.focus).toBe(false);
  });

  test("Rex says no (an error answer: it made nothing): refused, not sent, so the agent starts in the background", async () => {
    const { fake, rex } = setup({ remote: false });
    fake.setRefusal("session.create", { code: "refused", message: "Remote Control is off", status: 403 });
    expect(await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).toEqual({ opened: false, sent: false, refused: true });
    fake.setRefusal("session.create", null);
    expect((await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).opened).toBe(true);
    // A new tab in its own session that Rex refuses (an option this Rex does not take): the same.
    fake.setRefusal("session.new_window", { code: "bad_request", message: "unknown option path_prepend", status: 400 });
    expect(await rex.open({ project: "p", projectKey: "p", tab: "t2", command: "c" })).toEqual({ opened: false, sent: false, refused: true });
  });

  test("Rex says no to finding its own session again, or to attaching it: refused (said so), never that Rex isn't open", async () => {
    const { fake, rex } = setup({ remote: false });
    expect((await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).opened).toBe(true);
    fake.setRefusal("target.resolve", { code: "bad_request", message: "no", status: 400 });
    expect(await rex.open({ project: "p", projectKey: "p", tab: "t2", command: "c" })).toEqual({ opened: false, sent: false, refused: true });
    fake.setRefusal("target.resolve", null);
    fake.setRefusal("session.attach", { code: "forbidden", message: "no", status: 403 });
    expect(await rex.open({ project: "p", projectKey: "p", tab: "t3", command: "c" })).toEqual({ opened: false, sent: false, refused: true });
  });

  test("two starts at once for one project make one session of it (the second waits, then gets a tab there)", async () => {
    const { fake, rex } = setup();
    const [a, b] = await Promise.all([rex.open({ project: "p", projectKey: "p", tab: "A", command: "a" }), rex.open({ project: "p", projectKey: "p", tab: "B", command: "b" })]);
    expect(a.opened && b.opened).toBe(true);
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]!.windows.map((w) => w.label)).toEqual(["A", "B"]);
  });

  test("once the tab was asked for, a failure says so (sent), so nothing else opens it", async () => {
    const { fake, rex } = setup({}, { openTimeoutMs: 200 });
    fake.setDelay(Infinity, "session.create");
    expect(await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).toEqual({ opened: false, sent: true });
  });
});
