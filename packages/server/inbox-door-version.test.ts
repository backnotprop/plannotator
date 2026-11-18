/**
 * The door's version handshake (adr/implementation/inbox-mobile.md section 14), in process: no Inbox, the window's
 * handler is a recorder. What regresses: `health.door.routes` drifting from what the door answers (an app then calls a
 * route that 404s, or never offers one that works); an app from before the handshake refused or answered differently;
 * an app below the floor reaching a route other than health and revoke, on the door or through the relay; the app's
 * header reaching the window; a route-missing 404 kept under its key, so the same key never runs once the route is
 * there; and a client offering a route an older Inbox does not list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatInboxAppHeader, inboxDoorOffers, parseInboxAppHeader, readInboxDoorHealth } from "@plannotator/core/inbox-door-version";
import { createInboxDevices, doorRouteNames, doorRouteOf, doorRoutesFor, doorRouteTable } from "./inbox-devices";
import { APP_HEADER, DOOR_CONTRACT, doorHealth, MIN_APP_CONTRACT } from "./inbox-door-version";

type Json = Record<string, any>;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A door whose window answers what `answer` says, recording every request handed to it. */
function door(answer: (path: string) => Response = () => Response.json({ ok: true })) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-door-version-"));
  roots.push(dataDir);
  const handed: { path: string; headers: Headers }[] = [];
  const devices = createInboxDevices({
    dataDir,
    serverSession: "0".repeat(32),
    port: () => 1,
    registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: async (req) => {
      const path = new URL(req.url).pathname;
      handed.push({ path, headers: req.headers });
      return answer(path);
    },
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const phone = async (): Promise<Json> => {
    const made = (await (await devices.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    return (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) }), pairUrl))!.json();
  };
  const call = async (token: string, route: string, init: { method?: string; body?: Json; app?: string } = {}) => {
    const url = new URL(`http://127.0.0.1/api/inbox/device/${route}`);
    const method = init.method ?? (init.body ? "POST" : "GET");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.app ? { [APP_HEADER]: init.app } : {}) };
    return (await devices.door(new Request(url, { method, headers, ...(init.body ? { body: JSON.stringify(init.body) } : {}) }), url))!;
  };
  const listed = async (): Promise<Json[]> => ((await (await devices.windowRoute(new Request("http://127.0.0.1/api/inbox/devices"), new URL("http://127.0.0.1/api/inbox/devices")))!.json()) as Json).devices;
  return { devices, handed, phone, call, listed };
}

/** A path that the row's pattern matches: each `:id` tried with ids of the shapes the allowlist takes. */
function concrete(row: { route: string; pattern: string }): string | null {
  const ids = ["thr_1", "crd_1", "cmb_1", "a-0123abcd"];
  const slots = row.route.split("/").filter((part) => part === ":id").length;
  const pattern = new RegExp(row.pattern);
  const fill = (route: string, left: number): string | null => {
    if (left === 0) return pattern.test(route) ? route : null;
    for (const id of ids) {
      const found = fill(route.replace(":id", id), left - 1);
      if (found) return found;
    }
    return null;
  };
  return fill(row.route.replace(":path", "app/main.css"), slots);
}

describe("the route table: one source for health.door.routes", () => {
  test("every row is plain words that the door answers with the entry it came from, for the token the row names", () => {
    const own = new Set(["POST pair", "POST revoke", "GET accounts", "GET update", "POST update", "POST link-back", "POST unlink"]);
    const rows = doorRouteTable();
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
    for (const row of rows) {
      expect([row.name, /[\\^$()[\]|?*+{}]/.test(row.route)]).toEqual([row.name, false]);
      if (own.has(row.name)) continue;
      const path = concrete(row);
      expect([row.name, path === null]).toEqual([row.name, false]);
      expect([row.name, doorRouteOf(row.method, path!, row.grant === "machine")?.entry.route.source]).toEqual([row.name, row.pattern]);
      // A phone's token never reaches a machine row.
      if (row.grant === "machine") expect([row.name, doorRouteOf(row.method, path!, false)]).toEqual([row.name, null]);
    }
  });

  test("every door route name rule 8 knows is covered, with each alternation written out", () => {
    const names = doorRouteTable().map((row) => row.name);
    for (const name of ["POST messages/:id/reply", "POST messages/:id/take-back", "GET attachments/:id/video", "POST messages/:id/actions/:id", "GET html-assets/:id/:path", "GET pulls/media/sizes"]) expect(names).toContain(name);
    const patterns = new Set(doorRouteTable().map((row) => row.pattern.replace(/^\^|\$$/g, "")));
    const words = (pattern: string) => pattern.replaceAll("([^/]+)", ":id").replaceAll("\\/", "/");
    for (const name of doorRouteNames()) expect([name, [...patterns].some((pattern) => name === `${name.split(" ")[0]} ${words(pattern)}`)]).toEqual([name, true]);
  });

  test("a phone's list is the phone rows; a linked computer's is every row", () => {
    const phone = doorRoutesFor("ios");
    const machine = doorRoutesFor("machine");
    expect(phone).toEqual(doorRouteTable().filter((row) => row.grant === "phone").map((row) => row.name));
    expect(phone).toContain("GET health");
    expect(phone).toContain("POST revoke");
    for (const only of ["GET cards", "POST threads/:id/tags", "POST link-back", "GET accounts"]) {
      expect(phone).not.toContain(only);
      expect(machine).toContain(only);
    }
    expect(machine.length).toBe(doorRouteTable().length);
  });
});

describe("the app header", () => {
  test("read in its one form; anything else is no header", () => {
    expect(parseInboxAppHeader("ios 1.4.0 contract 14")).toEqual({ platform: "ios", app_version: "1.4.0", contract: 14 });
    expect(parseInboxAppHeader(" android 2.0.0-beta.3 contract 1 ")).toEqual({ platform: "android", app_version: "2.0.0-beta.3", contract: 1 });
    expect(formatInboxAppHeader({ platform: "ios", app_version: "1.4.0", contract: 14 })).toBe("ios 1.4.0 contract 14");
    for (const bad of [null, undefined, "", "ios 1.4.0", "ios 1.4.0 contract", "ios 1.4.0 contract -1", "ios 1.4.0 contract 1.5", "ios 1.4.0 contract 01", "iOS 1.4.0 contract 1", "ios 1.4.0 contract 1 extra"]) {
      expect([bad, parseInboxAppHeader(bad)]).toEqual([bad, null]);
    }
  });
});

describe("an app from before the handshake, on this Inbox", () => {
  test("no header: every route answers as before, nothing is refused, and its device shows no app", async () => {
    const d = door();
    const phone = await d.phone();
    expect((await d.call(phone.token, "health")).status).toBe(200);
    expect((await d.call(phone.token, "threads")).status).toBe(200);
    const first = await d.call(phone.token, "threads/thr_1/seen", { body: { idempotency_key: "k-old" } });
    expect(first.status).toBe(200);
    const again = await d.call(phone.token, "threads/thr_1/seen", { body: { idempotency_key: "k-old" } });
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await d.listed()).map((device) => device.app)).toEqual([null]);
  });
});

describe("an app that names itself", () => {
  test("its version is shown on the device; the header never reaches the window", async () => {
    const d = door();
    const phone = await d.phone();
    expect((await d.call(phone.token, "threads", { app: "ios 1.4.0 contract 1" })).status).toBe(200);
    expect(d.handed.map((h) => h.headers.get(APP_HEADER))).toEqual([null]);
    expect((await d.listed())[0]!.app).toEqual({ app_version: "1.4.0", contract: 1, seen_at: expect.any(String) });
    // Through the relay the sealed command names it as `app`.
    expect((await d.devices.asDevice(phone.device.id, { method: "GET", path: "/api/inbox/device/threads", app: "ios 1.5.0 contract 1" })).status).toBe(200);
    expect((await d.listed())[0]!.app).toMatchObject({ app_version: "1.5.0", contract: 1 });
  });

  test("below the floor: 426 app_needs_update everywhere but health and revoke, on the door and through the relay; nothing reaches the window", async () => {
    const d = door();
    const phone = await d.phone();
    const old = "ios 0.9.0 contract 0";
    const refused = { error: "Update Plannotator on your phone.", code: "app_needs_update", min_app_contract: MIN_APP_CONTRACT };
    const threads = await d.call(phone.token, "threads", { app: old });
    expect([threads.status, await threads.json()]).toEqual([426, refused]);
    const write = await d.call(phone.token, "threads/thr_1/seen", { app: old, body: { idempotency_key: "k-floor" } });
    expect([write.status, await write.json()]).toEqual([426, refused]);
    const relayed = await d.devices.asDevice(phone.device.id, { method: "POST", path: "/api/inbox/device/threads/thr_1/seen", body: { idempotency_key: "k-floor-relay" }, app: old });
    expect([relayed.status, await relayed.json()]).toEqual([426, refused]);
    expect(d.handed).toEqual([]);
    expect((await d.call(phone.token, "health", { app: old })).status).toBe(200);
    expect((await d.devices.asDevice(phone.device.id, { method: "GET", path: "/api/inbox/device/health", app: old })).status).toBe(200);
    // The refused write was not kept: once updated, the same key runs.
    expect((await d.call(phone.token, "threads/thr_1/seen", { app: "ios 1.0.0 contract 1", body: { idempotency_key: "k-floor" } })).headers.get("Idempotent-Replayed")).toBeNull();
    expect((await d.call(phone.token, "revoke", { app: old, method: "POST" })).status).toBe(200);
  });
});

describe("a route the Inbox does not have is never kept under the key", () => {
  test("a POST to a route off the door: 404, and the same key is free for the route the app meant", async () => {
    const d = door();
    const phone = await d.phone();
    const missing = await d.call(phone.token, "threads/thr_1/no-such-write", { body: { idempotency_key: "k-1" } });
    expect([missing.status, ((await missing.json()) as Json).code]).toEqual([404, "device_route_not_found"]);
    const meant = await d.call(phone.token, "threads/thr_1/seen", { body: { idempotency_key: "k-1" } });
    expect([meant.status, meant.headers.get("Idempotent-Replayed")]).toEqual([200, null]);
  });

  test("a route-missing 404 passed on from behind the door runs again under the same key once the route is there; any other 4xx is kept", async () => {
    let there = false;
    const d = door((path) => {
      if (path.endsWith("/snooze")) return there ? Response.json({ ok: true }) : Response.json({ error: "Not a phone route.", code: "device_route_not_found" }, { status: 404 });
      return Response.json({ error: "No such thread.", code: "thread_not_found" }, { status: 404 });
    });
    const phone = await d.phone();
    const body = { idempotency_key: "k-snooze", until: "2026-11-19T09:00:00.000Z" };
    expect((await d.call(phone.token, "threads/thr_1/snooze", { body })).status).toBe(404);
    there = true;
    const later = await d.call(phone.token, "threads/thr_1/snooze", { body });
    expect([later.status, later.headers.get("Idempotent-Replayed")]).toEqual([200, null]);
    expect((await d.call(phone.token, "threads/thr_1/snooze", { body })).headers.get("Idempotent-Replayed")).toBe("true");
    // Through the relay, the same rule.
    there = false;
    const relayed = { method: "POST", path: "/api/inbox/device/threads/thr_2/snooze", body: { idempotency_key: "k-relay", until: body.until } };
    expect((await d.devices.asDevice(phone.device.id, relayed)).status).toBe(404);
    there = true;
    expect((await d.devices.asDevice(phone.device.id, relayed)).headers.get("Idempotent-Replayed")).toBeNull();
    // A 404 about the thing, not the route, is the Inbox's answer and is replayed.
    expect((await d.call(phone.token, "threads/thr_9/seen", { body: { idempotency_key: "k-gone" } })).status).toBe(404);
    expect((await d.call(phone.token, "threads/thr_9/seen", { body: { idempotency_key: "k-gone" } })).headers.get("Idempotent-Replayed")).toBe("true");
  });
});

describe("what a client offers, both ways round", () => {
  const BEFORE = ["GET health", "GET threads", "POST messages/:id/reply"];
  const app = { contract: DOOR_CONTRACT, min_inbox_contract: 0, routes_before_door: BEFORE };

  test("this Inbox's own health: a phone is offered exactly its routes, never a linked computer's", () => {
    const skew = readInboxDoorHealth({ ok: true, door: doorHealth(doorRoutesFor("ios")) }, app);
    expect(skew.state).toBe("ok");
    expect(inboxDoorOffers(skew, "POST messages/:id/reply")).toBe(true);
    expect(inboxDoorOffers(skew, "GET cards")).toBe(false);
  });

  test("a newer app on an Inbox from before the handshake: today's routes only, or update the computer once the app needs more", () => {
    const old = { ok: true, version: "0.28.8" };
    expect(readInboxDoorHealth(old, app)).toEqual({ state: "ok", contract: 0, routes: BEFORE, grants: [] });
    expect(inboxDoorOffers(readInboxDoorHealth(old, app), "POST threads/:id/send")).toBe(false);
    expect(readInboxDoorHealth(old, { ...app, min_inbox_contract: 1 })).toEqual({ state: "inbox_needs_update", contract: 0, min_inbox_contract: 1 });
    // A `door` not in the shape is read as no door at all.
    expect(readInboxDoorHealth({ door: { contract: "1", routes: [] } }, app).state).toBe("ok");
  });

  test("a newer app on an older Inbox that lists its routes: only what is listed is offered", () => {
    const older = { door: { contract: 1, routes: ["GET health", "GET threads"], grants: [], min_app_contract: 1 } };
    const skew = readInboxDoorHealth(older, { ...app, contract: 3, min_inbox_contract: 1 });
    expect(inboxDoorOffers(skew, "GET threads")).toBe(true);
    expect(inboxDoorOffers(skew, "POST messages/:id/reply")).toBe(false);
  });

  test("an older app on a newer Inbox: routes and fields it does not know are left alone; below the Inbox's floor it is told to update", () => {
    const newer = { door: { contract: 7, routes: ["GET health", "GET threads", "GET events:device"], grants: ["agents"], min_app_contract: 1, later_field: true }, later_field: 1 };
    expect(readInboxDoorHealth(newer, app)).toEqual({ state: "ok", contract: 7, routes: ["GET health", "GET threads", "GET events:device"], grants: ["agents"] });
    expect(readInboxDoorHealth({ door: { ...newer.door, min_app_contract: 5 } }, app)).toEqual({ state: "app_needs_update", contract: 7, min_app_contract: 5 });
  });
});
