/**
 * The Inbox and a Rex with no app on its computer (Linux, FreeBSD: `headless`), and Show in Rex from another
 * computer's window, against a fake Rex server (tests/helpers/fake-rex.ts) whose apps are attached from elsewhere.
 * What this catches: an agent that cannot start in Rex because no app is attached to a server that needs none; a
 * place, a mark or Stop that depends on an app; Show in Rex offered with no app to show it, moving a Mac's own screen
 * for a click made on another computer, asking an app that is gone, or counted as shown when no app went there; and a
 * Mac's own window acting through any app but its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { startFakeRex, type FakeRex, type FakeRexOptions } from "../../tests/helpers/fake-rex";
import { doorRouteOf } from "./inbox-devices";
import { doorWriteKind } from "./inbox-outbox";
import { createInboxRex, type InboxRex } from "./inbox-rex";
import { inboxRaiseAfterFarShow } from "./inbox-rex-far";
import type { InboxPlace } from "@plannotator/shared/inbox/connection";

const fakes: FakeRex[] = [];
const rexes: InboxRex[] = [];
afterEach(async () => {
  for (const rex of rexes.splice(0)) rex.close();
  for (const fake of fakes.splice(0)) await fake.stop();
});

function setup(options: FakeRexOptions, rexOptions: Partial<Parameters<typeof createInboxRex>[0]> = {}) {
  const fake = startFakeRex(options);
  fakes.push(fake);
  const raised: number[] = [];
  const rex = createInboxRex({ socketPath: fake.socketPath, readTimeoutMs: 1_000, openTimeoutMs: 2_000, showTimeoutMs: 2_000, raiseApp: (pid) => raised.push(pid), ...rexOptions });
  rexes.push(rex);
  return { fake, rex, raised };
}
/** A Rex server with no app on its computer, and the apps attached to it from elsewhere. */
const headless = (apps: FakeRexOptions["apps"] = [], rexOptions: Partial<Parameters<typeof createInboxRex>[0]> = {}) => setup({ app: false, apps }, { headless: true, ...rexOptions });

const placeOf = (ids: { session: string; block: string }): InboxPlace => ({ kind: "rex", session: ids.session, block: ids.block });
const performs = (fake: FakeRex) => fake.calls.filter((call) => call.method === "client.perform").map((call) => call.payload.client_id);
const START = { project: "billing-svc", projectKey: "prj_bill", tab: "Claude Code", command: "cd /work && exec claude" };

async function read(rex: InboxRex, hints: ReadonlyMap<string, InboxPlace>) {
  rex.places(hints);
  await rex.settled();
}

describe("a Rex server with no app on its computer", () => {
  test("Rex is here while its server answers, with no app attached; with no server it is not", async () => {
    const { rex } = headless();
    expect(await rex.appAttachedNow()).toBe(true);
    const none = createInboxRex({ socketPath: "/tmp/no-rex-here/server.sock", headless: true });
    rexes.push(none);
    expect(await none.appAttachedNow()).toBe(false);
    expect(await none.open(START)).toEqual({ opened: false, sent: false });
  });

  test("a start needs no app: the session and its tab are made by the server, through a login shell, and the pane is known for Stop", async () => {
    const { fake, rex } = headless();
    const first = await rex.open(START);
    expect(first).toMatchObject({ opened: true, line: "Rex · billing-svc / Claude Code" });
    if (!first.opened) throw new Error("not opened");
    expect(fake.sessions).toHaveLength(1);
    expect(first.block).toBe(fake.sessions[0]!.windows[0]!.blocks[0]!);
    const made = fake.calls.find((call) => call.method === "session.create")!.payload as { initial_windows: { layout: { block: { options: Record<string, unknown> } } }[] };
    expect(made.initial_windows[0]!.layout.block.options).toMatchObject({ command: ["/bin/sh", "-c", START.command], login: true });
    // The next agent of the project: a tab of that same session, made without moving anything.
    const second = await rex.open({ ...START, tab: "Pi" });
    expect(second).toMatchObject({ opened: true, session: first.session, line: "Rex · billing-svc / Pi" });
    expect(fake.sessions).toHaveLength(1);
    expect(fake.calls.find((call) => call.method === "session.new_window")!.payload.focus).toBe(false);
    // No app was looked for or asked.
    expect(fake.methods()).not.toContain("client.list");
    expect(performs(fake)).toEqual([]);
  });

  test("its place line, what its pane says and Stop work as with an app: only its own pane is closed", async () => {
    const { fake, rex } = headless();
    const opened = await rex.open(START);
    if (!opened.opened || !opened.block) throw new Error("not opened");
    const theirs = fake.addSession("mine", "shell");
    const place = placeOf({ session: opened.session, block: opened.block });
    const hints = new Map([["ses_1", place]]);
    fake.setStatus(opened.block, [{ state: "blocked", kind: "permission", app: "claude" }]);
    await read(rex, hints);
    expect(rex.places(hints).get("ses_1")).toBe("Rex · billing-svc / Claude Code");
    expect(rex.freshStatuses(hints).get("ses_1")).toEqual({ state: "blocked", kind: "permission" });
    expect(await rex.closePane(place)).toBe("closed");
    expect(await rex.paneGone(place)).toBe(true);
    expect(fake.sessions.find((s) => s.session_id === theirs.session)!.windows[0]!.blocks).toEqual([theirs.block]);
  });
});

describe("Show in Rex with no app on this computer", () => {
  test("no Rex app attached: not offered, and a Show asks nobody", async () => {
    const { fake, rex } = headless();
    const ids = fake.addSession("billing-svc", "Claude Code");
    await read(rex, new Map([["ses_1", placeOf(ids)]]));
    expect(rex.offersShow()).toBe(false);
    expect(rex.offersShow("away")).toBe(false);
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false });
    expect(performs(fake)).toEqual([]);
  });

  test("an app attached from another computer (over the tailnet, or by ssh) goes to the pane; nothing here is brought to the front", async () => {
    for (const transport of ["tailscale", "ssh"] as const) {
      const { fake, rex, raised } = headless([{ id: "a1", transport }]);
      const ids = fake.addSession("billing-svc", "Claude Code");
      await read(rex, new Map([["ses_1", placeOf(ids)]]));
      expect(rex.offersShow()).toBe(true);
      expect(await rex.show(placeOf(ids))).toEqual({ shown: true, by: ["far-a1"] });
      const asked = fake.calls.find((call) => call.method === "client.perform")!.payload;
      expect(asked).toMatchObject({ client_id: fake.farAppId("a1"), action: "session.select", args: { session_id: ids.session, window_id: ids.window } });
      expect(fake.calls.find((call) => call.method === "session.focus_block")!.payload).toMatchObject({ session_id: ids.session, block_id: ids.block });
      expect(raised).toEqual([]);
    }
  });

  test("several apps attached (the person's Mac and phone): each is asked, and one that goes there is a Show", async () => {
    const { fake, rex } = headless([{ id: "a1", remote: false }, { id: "a2", platform: "ios" }, { id: "a3", actions: ["pane.split"] }, { id: "a4", lost: true }]);
    const ids = fake.addSession("billing-svc", "Claude Code");
    expect(await rex.show(placeOf(ids))).toEqual({ shown: true, by: ["far-a2"] });
    // The one whose connection dropped is not asked.
    expect(performs(fake).sort()).toEqual([fake.farAppId("a1"), fake.farAppId("a2"), fake.farAppId("a3")]);
  });

  test("another person's app is never asked: a colleague's on this server by ssh as their own account moves nothing", async () => {
    const other = (process.getuid?.() ?? 501) + 1;
    const { fake, rex } = headless([{ id: "a1", transport: "ssh" }, { id: "b1", transport: "ssh", uid: other }]);
    const ids = fake.addSession("billing-svc", "Claude Code");
    expect(await rex.show(placeOf(ids))).toEqual({ shown: true, by: ["far-a1"] });
    expect(performs(fake)).toEqual([fake.farAppId("a1")]);
    // Only theirs attached: not offered, and a Show asks nobody.
    fake.setFarApps([{ id: "b1", transport: "ssh", uid: other }]);
    await read(rex, new Map([["ses_1", placeOf(ids)]]));
    expect(rex.offersShow()).toBe(false);
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false });
    expect(performs(fake)).toEqual([fake.farAppId("a1")]);
  });

  test("a shared server (another account's, named by REX_SERVER): only apps that came in as this account are asked; a tailnet login there may be anyone's", async () => {
    // "This user" is another uid than the socket's owner, as on a shared server.
    const me = (process.getuid?.() ?? 501) + 1;
    const fake = startFakeRex({ app: false, apps: [{ id: "a1", transport: "ssh", uid: me }, { id: "b1", transport: "ssh" }, { id: "c1", transport: "tailscale" }] });
    fakes.push(fake);
    const rex = createInboxRex({ socketPath: [{ path: fake.socketPath, named: true }], headless: true, uid: me, readTimeoutMs: 1_000, showTimeoutMs: 2_000 });
    rexes.push(rex);
    const ids = fake.addSession("team", "Claude Code");
    expect(await rex.show(placeOf(ids))).toMatchObject({ shown: true });
    expect(performs(fake)).toEqual([fake.farAppId("a1")]);
  });

  test("every app says no (Remote Control off): refused, and hidden until an app that may say yes attaches", async () => {
    const { fake, rex } = headless([{ id: "a1", remote: false }]);
    const ids = fake.addSession("billing-svc", "Claude Code");
    const hints = new Map([["ses_1", placeOf(ids)]]);
    await read(rex, hints);
    expect(rex.offersShow()).toBe(true);
    expect(await rex.show(placeOf(ids))).toEqual({ shown: false, refused: true });
    expect(rex.offersShow()).toBe(false);
    // Another app attaches beside it: offered again at the next read.
    fake.setFarApps([{ id: "a1", remote: false }, { id: "a2" }]);
    rex.watch(new Map([["ses_2", placeOf(ids)]]));
    await rex.settled();
    expect(rex.offersShow()).toBe(true);
    expect(await rex.show(placeOf(ids))).toMatchObject({ shown: true });
  });
});

describe("Show in Rex on a Mac, by where the click came from", () => {
  test("this computer's own window: only this computer's own app, whatever else is attached", async () => {
    const { fake, rex, raised } = setup({ remote: true, appPid: 4242, apps: [{ id: "a1" }] });
    const ids = fake.addSession("billing-svc", "Claude Code");
    await read(rex, new Map([["ses_1", placeOf(ids)]]));
    expect(rex.offersShow()).toBe(true);
    expect(await rex.show(placeOf(ids))).toEqual({ shown: true });
    expect(performs(fake)).not.toContain(fake.farAppId("a1"));
    expect(performs(fake)).toHaveLength(1);
    expect(raised).toEqual([4242]);
  });

  test("another computer's window: the apps attached from elsewhere, never this Mac's own, and its screen is left alone", async () => {
    const { fake, rex, raised } = setup({ remote: true, appPid: 4242, apps: [{ id: "a1" }] });
    const ids = fake.addSession("billing-svc", "Claude Code");
    await read(rex, new Map([["ses_1", placeOf(ids)]]));
    expect(rex.offersShow("away")).toBe(true);
    expect(await rex.show(placeOf(ids), "away")).toEqual({ shown: true, by: ["far-a1"] });
    expect(performs(fake)).toEqual([fake.farAppId("a1")]);
    expect(raised).toEqual([]);
  });

  test("another computer's window with only this Mac's own app attached: not offered, and nothing moves", async () => {
    const { fake, rex, raised } = setup({ remote: true, appPid: 4242 });
    const ids = fake.addSession("billing-svc", "Claude Code");
    await read(rex, new Map([["ses_1", placeOf(ids)]]));
    expect(rex.offersShow("away")).toBe(false);
    expect(await rex.show(placeOf(ids), "away")).toEqual({ shown: false });
    expect(performs(fake)).toEqual([]);
    expect(raised).toEqual([]);
  });

  test("a start on a Mac still needs its app (a Mac's server is the app's)", async () => {
    const { rex } = setup({ app: false, apps: [{ id: "a1" }] });
    expect(await rex.open(START)).toEqual({ opened: false, sent: false });
    expect(await rex.appAttachedNow()).toBe(false);
  });
});

describe("a linked machine's Rex showed a pane", () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const FAR = "/api/inbox/m/ibx_01K0000000000000000000000M/rex/show";

  test("this computer's own Rex app comes to the front only when it is one of the apps that went there (by the name it gives itself); a headless Rex here is not asked at all", async () => {
    const mac = setup({ remote: true, appPid: 4242 });
    // Another device's app went there (the person's iPad): this Mac's stays where it is.
    await mac.rex.raise(["ipad"]);
    await mac.rex.raise([]);
    expect(mac.raised).toEqual([]);
    await mac.rex.raise(["ipad", "this-mac"]);
    expect(mac.raised).toEqual([4242]);
    expect(performs(mac.fake)).toEqual([]);
    const server = headless([{ id: "a1" }]);
    await server.rex.raise(["far-a1"]);
    expect(server.raised).toEqual([]);
    expect(server.fake.calls).toEqual([]);
  });

  test("the ask reaches that machine's door for a linked machine only, and is sent at the click or not at all (never held for later)", () => {
    expect(doorRouteOf("POST", "rex/show", true)?.windowPath).toBe("/api/inbox/rex/show");
    expect(doorRouteOf("POST", "rex/show", false)).toBeNull();
    expect(doorWriteKind("rex/show")).toBe("now");
  });

  test("only for that machine's own yes to a Show: never a refusal, a failure or another forwarded write", async () => {
    let raises = 0;
    const named: string[][] = [];
    const rex = { raise: async (labels: readonly string[]) => void (raises++, named.push([...labels])) };
    const shown = await inboxRaiseAfterFarShow(FAR, ok({ shown: true, by: ["this-mac", 7] }), rex);
    expect(raises).toBe(1);
    expect(named).toEqual([["this-mac"]]);
    // The answer goes to the window as that machine gave it.
    expect(await shown.json()).toEqual({ shown: true, by: ["this-mac", 7] });
    // A yes that names no app (an older Inbox there): nothing here moves.
    await inboxRaiseAfterFarShow(FAR, ok({ shown: true }), rex);
    await inboxRaiseAfterFarShow(FAR, ok({ shown: false, refused: true }), rex);
    await inboxRaiseAfterFarShow(FAR, ok({ error: "offline" }, 503), rex);
    await inboxRaiseAfterFarShow("/api/inbox/m/ibx_01K0000000000000000000000M/launch/lch_1/stop", ok({ shown: true, by: ["this-mac"] }), rex);
    await inboxRaiseAfterFarShow("/api/inbox/rex/show", ok({ shown: true, by: ["this-mac"] }), rex);
    expect(raises).toBe(1);
  });
});
