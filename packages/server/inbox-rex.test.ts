/**
 * The Inbox and Rex (inbox-rex.ts), against a fake Rex server (tests/helpers/fake-rex.ts): where an agent lives is
 * shown only when Rex confirms it, Open in Rex makes exactly the tab it should, Show in Rex is offered only while the
 * app's Remote Control is on, and nothing beyond ids, labels, new tabs and focus is ever asked of Rex.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { startFakeRex, type FakeRex } from "../../tests/helpers/fake-rex";
import { createInboxRex, inboxRexLine, inboxRexSocketPath, INBOX_REX_REMOTE_MS, type InboxRex } from "./inbox-rex";
import type { InboxPlace } from "@plannotator/shared/inbox/connection";

/** Every method the Inbox may call: view (ids and labels), a new session or tab with its command, focus. */
const ALLOWED = new Set(["target.resolve", "client.list", "client.perform", "session.attach", "session.create", "session.new_window", "session.focus_block"]);

const fakes: FakeRex[] = [];
const rexes: InboxRex[] = [];
afterEach(async () => {
  for (const rex of rexes.splice(0)) rex.close();
  for (const fake of fakes.splice(0)) {
    expect(fake.methods().filter((m) => !ALLOWED.has(m))).toEqual([]);
    await fake.stop();
  }
});

function setup(options: Parameters<typeof startFakeRex>[0] = {}, rexOptions: Partial<Parameters<typeof createInboxRex>[0]> = {}) {
  const fake = startFakeRex(options);
  fakes.push(fake);
  const rex = createInboxRex({ socketPath: fake.socketPath, readTimeoutMs: 1_000, actionTimeoutMs: 2_000, ...rexOptions });
  rexes.push(rex);
  return { fake, rex };
}

const placeOf = (ids: { session: string; block: string }): InboxPlace => ({ kind: "rex", session: ids.session, block: ids.block });

async function until(check: () => Promise<boolean> | boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await Bun.sleep(20);
  }
  return false;
}

describe("where an agent lives", () => {
  test("a place Rex confirms gets its line, with the names read now", async () => {
    const { fake, rex } = setup();
    const ids = fake.addSession("plannotator", "Claude Code");
    const shown = await rex.places(new Map([["sess-1", placeOf(ids)]]), false);
    expect(shown.get("sess-1")).toEqual({ line: "Rex · plannotator / Claude Code", show: false });

    // Renamed in Rex: the next read says the new names (nothing was kept).
    fake.rename(ids.session, "renamed");
    fake.rename(ids.window, "tab two");
    expect((await rex.places(new Map([["sess-1", placeOf(ids)]]), false)).get("sess-1")?.line).toBe("Rex · renamed / tab two");
  });

  test("a miss shows nothing: a block that is gone, or one in another session than the hint says", async () => {
    const { fake, rex } = setup();
    const a = fake.addSession("one", "a");
    const b = fake.addSession("two", "b");
    const shown = await rex.places(
      new Map([
        ["gone", { kind: "rex", session: a.session, block: "block:01a1eb35-0de6-701f-808a-16e06621d0ae" }],
        ["elsewhere", { kind: "rex", session: a.session, block: b.block }],
        ["no-session", { kind: "rex", session: "session:01a1eb35-0de6-701f-808a-16e06621d0ae", block: a.block }],
        ["here", placeOf(b)],
      ]),
      false,
    );
    expect([...shown.keys()]).toEqual(["here"]);
  });

  test("names Rex gives are drawn on one line, without control or bidi characters", async () => {
    const { fake, rex } = setup();
    const ids = fake.addSession("a‮b\nc", `x${"y".repeat(100)}`);
    const line = (await rex.places(new Map([["s", placeOf(ids)]]), false)).get("s")!.line;
    expect(line).not.toMatch(/[‮\n]/);
    expect(line.startsWith("Rex · a b c / x")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(inboxRexLine("", "")).toBe("Rex");
  });

  test("no Rex here: nothing, quickly, and no socket is made", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-rex-"));
    const none = createInboxRex({ socketPath: join(dir, "server.sock") });
    rexes.push(none);
    const started = performance.now();
    expect((await none.places(new Map([["s", { kind: "rex", session: "session:01a1eb35-0de6-701f-808a-16e06621d0ae", block: "block:01a1eb35-0de6-701f-808a-16e06621d0ae" }]]), true)).size).toBe(0);
    expect(await none.opensHere()).toBe(false);
    expect(await none.open({ project: "p", tab: "t", command: "true" })).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(inboxRexSocketPath("linux", "/home/x")).toBeNull();
    expect(inboxRexSocketPath("darwin", "/Users/x")).toBe("/Users/x/Library/Application Support/rex/server.sock");
  });

  test("a slow Rex: nothing past the deadline, and it is left alone a while after", async () => {
    let clock = 1_000_000;
    const { fake, rex } = setup({}, { readTimeoutMs: 150, now: () => clock });
    const ids = fake.addSession("p", "t");
    fake.setDelay(Infinity);
    const started = performance.now();
    expect((await rex.places(new Map([["s", placeOf(ids)]]), false)).size).toBe(0);
    expect(performance.now() - started).toBeLessThan(600);
    const opened = fake.connections().opened;
    fake.setDelay(0);
    expect((await rex.places(new Map([["s", placeOf(ids)]]), false)).size).toBe(0);
    expect(fake.connections().opened).toBe(opened);
    clock += 31_000;
    expect((await rex.places(new Map([["s", placeOf(ids)]]), false)).size).toBe(1);
  });
});

describe("Show in Rex", () => {
  test("offered only once the app said it performs actions (Remote Control on)", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    const hints = new Map([["s", placeOf(ids)]]);
    expect(await until(async () => (await rex.places(hints, true)).get("s")?.show === true)).toBe(true);
    // The probe changes nothing: a select with no session.
    const probe = fake.calls.find((c) => c.method === "client.perform");
    expect((probe?.payload.args as Record<string, unknown>).session_id).toBe("");
  });

  test("never offered while Remote Control is off; the app's refusal is the answer", async () => {
    const { fake, rex } = setup({ remote: false });
    const ids = fake.addSession("p", "t");
    const hints = new Map([["s", placeOf(ids)]]);
    await rex.places(hints, true);
    expect(await until(() => fake.methods().includes("client.perform"))).toBe(true);
    await Bun.sleep(50);
    expect((await rex.places(hints, true)).get("s")).toEqual({ line: "Rex · p / t", show: false });
    // Asked once a minute at most.
    expect(fake.methods().filter((m) => m === "client.perform")).toHaveLength(1);
  });

  test("a window that is not on this computer never asks the app anything", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    expect((await rex.places(new Map([["s", placeOf(ids)]]), false)).get("s")?.show).toBe(false);
    await Bun.sleep(50);
    expect(fake.methods()).not.toContain("client.list");
    expect(fake.methods()).not.toContain("client.perform");
  });

  test("goes to the pane: select its tab, then focus it", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    expect(await rex.show(placeOf(ids))).toBe(true);
    const select = fake.calls.find((c) => c.method === "client.perform")!;
    expect(select.payload.action).toBe("session.select");
    expect(select.payload.args).toEqual({ session_id: ids.session, window_id: ids.window });
    expect(fake.calls.find((c) => c.method === "session.focus_block")?.payload).toEqual({ session_id: ids.session, block_id: ids.block });
  });

  test("refused while Remote Control is off, and then no longer offered", async () => {
    let clock = 5_000_000;
    const { fake, rex } = setup({ remote: true }, { now: () => clock });
    const ids = fake.addSession("p", "t");
    const hints = new Map([["s", placeOf(ids)]]);
    expect(await until(async () => (await rex.places(hints, true)).get("s")?.show === true)).toBe(true);
    fake.setRemote(false);
    expect(await rex.show(placeOf(ids))).toBe(false);
    expect(fake.methods()).not.toContain("session.focus_block");
    expect((await rex.places(hints, true)).get("s")?.show).toBe(false);
    // A minute on, the app is asked again (the person may have turned it back on).
    fake.setRemote(true);
    clock += INBOX_REX_REMOTE_MS + 1;
    expect(await until(async () => (await rex.places(hints, true)).get("s")?.show === true)).toBe(true);
  });

  test("a pane that is gone: nothing is asked of the app", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    expect(await rex.show({ kind: "rex", session: ids.session, block: "block:01a1eb35-0de6-701f-808a-16e06621d0ae" })).toBe(false);
    expect(fake.methods()).not.toContain("client.perform");
  });
});

describe("Open in Rex", () => {
  test("only when Rex's app is attached here", async () => {
    const { fake, rex } = setup({ app: false });
    expect(await rex.opensHere()).toBe(false);
    expect(await rex.open({ project: "p", tab: "Claude Code", command: "echo hi" })).toBeNull();
    expect(fake.methods()).not.toContain("session.create");
    fake.setApp(true);
    expect(await rex.opensHere()).toBe(true);
  });

  test("a new session named for the project, its first tab running the command", async () => {
    const { fake, rex } = setup();
    const opened = await rex.open({ project: "my-app", tab: "Claude Code", command: "plannotator attach 'x'" });
    expect(opened).not.toBeNull();
    const create = fake.calls.find((c) => c.method === "session.create")!;
    expect(create.payload).toEqual({
      label: "my-app",
      initial_windows: [{ window_label: "Claude Code", layout: { block: { flavor: "com.superlogical.terminal.shell", options: { command: ["/bin/sh", "-c", "plannotator attach 'x'"] } } } }],
    });
    expect(fake.sessions.map((s) => s.label)).toEqual(["my-app"]);
    expect(opened!.session).toBe(fake.sessions[0]!.session_id);
  });

  test("the project's session already there: a new tab in it", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("My-App", "older");
    const opened = await rex.open({ project: "my-app", tab: "Codex", command: "run it" });
    expect(opened?.session).toBe(ids.session);
    expect(fake.methods()).not.toContain("session.create");
    const made = fake.calls.find((c) => c.method === "session.new_window")!;
    expect(made.payload).toEqual({ session_id: ids.session, window_label: "Codex", layout: { block: { flavor: "com.superlogical.terminal.shell", options: { command: ["/bin/sh", "-c", "run it"] } } }, focus: true });
    expect(fake.sessions[0]!.windows.map((w) => w.label)).toEqual(["older", "Codex"]);
    // With Remote Control on, the app goes to the new tab.
    expect(fake.calls.find((c) => c.method === "client.perform")?.payload.args).toEqual({ session_id: ids.session, window_id: opened!.window });
  });

  test("Remote Control off: the tab is still made", async () => {
    const { fake, rex } = setup({ remote: false });
    expect(await rex.open({ project: "p", tab: "t", command: "c" })).not.toBeNull();
    expect(fake.sessions).toHaveLength(1);
  });
});
