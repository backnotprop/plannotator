/**
 * The Inbox and Rex (inbox-rex.ts), against a fake Rex server (tests/helpers/fake-rex.ts): where an agent lives is
 * shown only when Rex confirms it and a list never waits on Rex; Show in Rex asks the app only at the click and counts
 * only a confirmed success; Open in Rex makes its tab only in a session the Inbox made, through a login shell; only an
 * app attached over this computer's own socket is ever acted through; and nothing beyond ids, labels, new tabs and
 * focus is ever asked of Rex.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startFakeRex, type FakeRex } from "../../tests/helpers/fake-rex";
import { createInboxRex, inboxRexLine, inboxRexSocketOk, inboxRexSocketPath, INBOX_REX_REFUSED_MS, INBOX_REX_SLOW_BACKOFF_MS, type InboxRex } from "./inbox-rex";
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
  test("a Mac app over this computer's socket as this user", async () => {
    const { rex } = setup();
    rex.appAttached();
    await rex.settled();
    expect(rex.appAttached()).toBe(true);
    expect(rex.offersShow()).toBe(true);
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

describe("Show in Rex", () => {
  test("reading where agents live never asks the app anything", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    await placesRead(rex, new Map([["s", placeOf(ids)]]));
    rex.offersShow();
    expect(fake.methods()).not.toContain("client.perform");
  });

  test("goes to the pane on the click: select its tab, then focus it", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    expect(await rex.show(placeOf(ids))).toEqual({ shown: true });
    const select = fake.calls.find((c) => c.method === "client.perform")!;
    expect(select.payload.action).toBe("session.select");
    expect(select.payload.args).toEqual({ session_id: ids.session, window_id: ids.window });
    expect(fake.calls.find((c) => c.method === "session.focus_block")?.payload).toEqual({ session_id: ids.session, block_id: ids.block });
  });

  test("the app refuses (Remote Control off): not shown, and not offered again for a while", async () => {
    let clock = 5_000_000;
    const { fake, rex } = setup({ remote: false }, { now: () => clock });
    const ids = fake.addSession("p", "t");
    rex.appAttached();
    await rex.settled();
    expect(rex.offersShow()).toBe(true);
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false });
    expect(fake.methods()).not.toContain("session.focus_block");
    expect(rex.offersShow()).toBe(false);
    clock += INBOX_REX_REFUSED_MS + 1;
    await placesRead(rex, new Map());
    expect(rex.offersShow()).toBe(true);
  });

  test("an answer of a shape it does not know counts as no", async () => {
    const { fake, rex } = setup({ remote: true });
    const ids = fake.addSession("p", "t");
    fake.setPerformAnswer({ payload: { ok: true } });
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false });
    expect(rex.offersShow()).toBe(false);
  });

  test("an app that does not answer in time counts as no", async () => {
    const { fake, rex } = setup({ remote: true }, { showTimeoutMs: 200 });
    const ids = fake.addSession("p", "t");
    fake.setDelay(Infinity, "client.perform");
    const started = performance.now();
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false });
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

describe("Open in Rex", () => {
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
    // The app is asked to go only to the new session.
    for (const call of fake.calls.filter((c) => c.method === "client.perform")) expect((call.payload.args as { session_id: string }).session_id).not.toBe(theirs.session);
  });

  test("the session it made, by the id it kept (renamed or not): a new tab there; gone: a new session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rex-kept-"));
    const file = join(dir, "rex-sessions.json");
    const { fake, rex } = setup({ remote: true }, { sessionsFile: file });
    const first = await rex.open({ project: "my-app", projectKey: "proj-1", tab: "Claude Code", command: "a" });
    if (!first.opened) throw new Error("not opened");
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual({ "proj-1": first.session });
    fake.rename(first.session, "renamed by the person");

    // Another Inbox run (the file is what it remembers).
    const again = createInboxRex({ socketPath: fake.socketPath, sessionsFile: file });
    rexes.push(again);
    const second = await again.open({ project: "my-app", projectKey: "proj-1", tab: "Codex", command: "b" });
    expect(second).toMatchObject({ opened: true, session: first.session, line: "Rex · renamed by the person / Codex" });
    expect(fake.calls.find((c) => c.method === "session.new_window")!.payload).toEqual({ session_id: first.session, window_label: "Codex", layout: terminal("b"), focus: true });
    expect(fake.sessions).toHaveLength(1);

    // The person closed it: a new one, and that one is kept.
    fake.sessions.splice(0, 1);
    const third = await again.open({ project: "my-app", projectKey: "proj-1", tab: "Pi", command: "c" });
    if (!third.opened) throw new Error("not opened");
    expect(third.session).not.toBe(first.session);
    expect(JSON.parse(readFileSync(file, "utf8")).sessions).toEqual({ "proj-1": third.session });
  });

  test("Remote Control off: the tab is still made, and that is an open", async () => {
    const { fake, rex } = setup({ remote: false });
    expect((await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).opened).toBe(true);
    expect(fake.sessions).toHaveLength(1);
  });

  test("an app slow to go to the new tab does not undo the open", async () => {
    const { fake, rex } = setup({ remote: true });
    fake.setDelay(Infinity, "client.perform");
    const started = performance.now();
    expect((await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).opened).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  test("once the tab was asked for, a failure says so (sent), so nothing else opens it", async () => {
    const { fake, rex } = setup({}, { openTimeoutMs: 200 });
    fake.setDelay(Infinity, "session.create");
    expect(await rex.open({ project: "p", projectKey: "p", tab: "t", command: "c" })).toEqual({ opened: false, sent: true });
  });
});
