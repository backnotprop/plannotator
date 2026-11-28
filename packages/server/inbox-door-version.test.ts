/**
 * The door's version handshake (adr/implementation/inbox-mobile.md section 14), in process: no Inbox, the window's
 * handler is a recorder. What regresses: `health.door` drifting from what the door answers (an app then calls a route
 * that 404s, through the relay or at all, or never offers one that works); an own route answered with no row, or
 * listed by an Inbox that does not answer it; an app from before the handshake refused or answered differently; an app
 * below the floor reaching a route other than health and revoke, on the door or through the relay; a relay command's
 * `app` that is not a header's characters turning into a 500 the app retries for ever; the app's header reaching the
 * window; a refusal at the door kept under the key; and a client offering a route an older Inbox does not list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatInboxAppHeader, inboxDoorOffers, parseInboxAppHeader, readInboxDoorHealth } from "@plannotator/core/inbox-door-version";
import { createInboxDevices, doorReachOf, doorRouteNames, doorRouteOf, doorRouteTable, type InboxDevicesContext } from "./inbox-devices";
import { APP_HEADER, APP_UPGRADE, DOOR_CONTRACT, doorHealth, MIN_APP_CONTRACT } from "./inbox-door-version";

type Json = Record<string, any>;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A door whose window answers what `answer` says, recording every request handed to it. */
function door(answer: (path: string) => Response = () => Response.json({ ok: true }), extra: Partial<InboxDevicesContext> = {}) {
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
    ...extra,
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const pair = async (body: Json): Promise<Json> => (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify(body) }), pairUrl))!.json();
  const phone = async (): Promise<Json> => {
    const made = (await (await devices.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    return pair({ code: made.offer.code, name: "iPhone", platform: "ios" });
  };
  const machine = async (): Promise<Json> => pair({ name: "MacBook", platform: "machine", secret: devices.machineDoor.openMachineOffer().secret });
  const call = async (token: string, route: string, init: { method?: string; body?: Json; app?: string; headers?: Record<string, string> } = {}) => {
    const url = new URL(`http://127.0.0.1/api/inbox/device/${route}`);
    const method = init.method ?? (init.body ? "POST" : "GET");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.app ? { [APP_HEADER]: init.app } : {}), ...init.headers };
    return (await devices.door(new Request(url, { method, headers, ...(init.body ? { body: JSON.stringify(init.body) } : {}) }), url))!;
  };
  const listed = async (): Promise<Json[]> => ((await (await devices.windowRoute(new Request("http://127.0.0.1/api/inbox/devices"), new URL("http://127.0.0.1/api/inbox/devices")))!.json()) as Json).devices;
  return { devices, handed, phone, machine, call, listed };
}

/** A path that the row's pattern matches: each `:id` tried with ids of the shapes the allowlist takes. */
function concrete(row: { route: string; pattern: string }): string | null {
  const ids = ["thr_1", "crd_1", "cmb_1", "sch_1", "a-0123abcd"];
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
    const own = new Set(["POST pair", "POST revoke", "GET accounts", "GET agent-read", "GET agent-file", "GET agent-search", "GET agent-threads", "GET taggable-agents", "POST far-wake", "POST agent-reply", "POST far-delivered", "GET update", "POST update", "POST link-back", "POST unlink", "POST link-through-ask", "POST link-through-offer", "POST link-through-introduce"]);
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
    // The two agree on a linked machine's own routes, `GET update` included.
    expect(doorRouteNames().filter((name) => !name.includes("/") && !doorRouteOf(name.split(" ")[0]!, name.split(" ")[1]!, true))).toEqual(
      doorRouteTable().filter((row) => row.grant === "machine" && row.pattern === `^${row.route}$` && !doorRouteOf(row.method, row.route, true)).map((row) => row.name),
    );
  });

  test("relay: false exactly where the sealed relay path refuses, true where it hands the command in", async () => {
    expect(doorRouteTable().filter((row) => !row.relay).map((row) => row.name).sort()).toEqual(["GET events", "POST markups", "POST pair", "POST uploads"]);
    const d = door();
    const phone = await d.phone();
    for (const row of doorRouteTable()) {
      if (row.grant !== "phone" || row.name === "POST revoke") continue;
      const path = row.name === "POST pair" ? "pair" : concrete(row)!;
      const answer = await d.devices.asDevice(phone.device.id, { method: row.method, path: `/api/inbox/device/${path}`, body: { idempotency_key: `k-${row.name}` } });
      const code = ((await answer.json()) as Json).code;
      expect([row.name, ["device_route_not_found", "relay_upload_unavailable"].includes(code)]).toEqual([row.name, !row.relay]);
    }
  });

  test("a phone's list is the phone rows; a linked computer's is every row", () => {
    const phone = doorReachOf("ios").routes;
    const machine = doorReachOf("machine").routes;
    expect(phone).toEqual(doorRouteTable().filter((row) => row.grant === "phone").map((row) => row.name));
    expect(phone).toContain("GET health");
    expect(phone).toContain("POST revoke");
    for (const only of ["GET cards", "POST threads/:id/tags", "POST link-back", "GET accounts", "GET agent-read", "GET agent-file", "GET agent-search", "GET agent-threads"]) {
      expect(phone).not.toContain(only);
      expect(machine).toContain(only);
    }
    expect(machine.length).toBe(doorRouteTable().length);
    expect(doorReachOf("ios").not_by_relay.sort()).toEqual(["GET events", "POST markups", "POST pair", "POST uploads"]);
  });

  test("a linked machine's own routes are listed exactly when this Inbox answers them, and each listed one answers", async () => {
    const own = ["GET accounts", "GET agent-read", "GET agent-file", "GET agent-search", "GET agent-threads", "POST link-back", "POST unlink", "GET update", "POST update"];
    const bare = door();
    expect(own.filter((name) => bare.devices.doorReach("machine").routes.includes(name))).toEqual(["GET accounts"]);
    const lone = await bare.machine();
    for (const name of ["GET agent-read", "GET agent-file", "GET agent-search", "GET agent-threads", "POST link-back", "POST unlink", "GET update", "POST update"]) {
      const [method, route] = name.split(" ");
      const answer = await bare.call(lone.token, route!, method === "POST" ? { body: { idempotency_key: `k-${route}` } } : {});
      expect([name, answer.status, ((await answer.json()) as Json).code]).toEqual([name, 404, "device_route_not_found"]);
    }
    const machines = { linkBack: async () => Response.json({ linked: true }), unlinkedBy: () => Response.json({ unlinked: true }), hasLinks: () => true };
    const agentRead = { read: () => Response.json({ thread_id: "msg_1" }), file: async () => new Response("bytes") };
    const agentFind = { search: async () => Response.json({ total: 0, results: [] }), threads: () => Response.json({ total: 0, threads: [] }) };
    const full = door(undefined, { machines: () => machines, agentRead, agentFind, machineUpdate: { read: () => ({ state: "idle" }), start: async () => ({ outcome: "started" }) } });
    expect(own.filter((name) => full.devices.doorReach("machine").routes.includes(name))).toEqual(own);
    const linked = await full.machine();
    for (const name of own) {
      const [method, route] = name.split(" ");
      const answer = await full.call(linked.token, route!, method === "POST" ? { body: { idempotency_key: `k-${route}` } } : {});
      expect([name, answer.status]).toEqual([name, 200]);
    }
    // A phone's token never reaches a linked machine's agents' reads.
    const phone = await full.phone();
    for (const route of ["agent-read", "agent-file", "agent-search", "agent-threads"]) {
      const answer = await full.call(phone.token, `${route}?thread_id=msg_1`);
      expect([route, answer.status, ((await answer.json()) as Json).code]).toEqual([route, 404, "device_route_not_found"]);
    }
  });

  test("a far tag's routes: a linked machine's token only, each write named by the machine its token belongs to", async () => {
    const seen: { route: string; machine: string; body: Json }[] = [];
    let deviceOf = "";
    const machines = { linkBack: async () => Response.json({}), unlinkedBy: () => Response.json({}), hasLinks: () => true, machineOfDevice: (device: string) => (device === deviceOf ? { machine: "ibx_LAPTOP", name: "Laptop" } : null) };
    const farTags = {
      agents: () => Response.json({ sessions: [{ session: "ses_a" }] }),
      wake: (machine: string, body: Json) => (seen.push({ route: "far-wake", machine, body }), { kept: true }),
      reply: async (machine: string, body: Json) => (seen.push({ route: "agent-reply", machine, body }), { message_id: "msg_2" }),
      delivered: (machine: string, body: Json) => (seen.push({ route: "far-delivered", machine, body }), { ok: true }),
    };
    const d = door(undefined, { machines: () => machines, farTags });
    const own = ["GET taggable-agents", "POST far-wake", "POST agent-reply", "POST far-delivered"];
    expect(own.filter((name) => d.devices.doorReach("machine").routes.includes(name))).toEqual(own);
    expect(own.filter((name) => d.devices.doorReach("ios").routes.includes(name))).toEqual([]);
    const linked = await d.machine();
    deviceOf = linked.device.id;
    expect(await (await d.call(linked.token, "taggable-agents")).json()).toEqual({ sessions: [{ session: "ses_a" }] });
    // The body cannot name another machine: who wrote it is its token's.
    for (const route of ["far-wake", "agent-reply", "far-delivered"]) {
      const answer = await d.call(linked.token, route, { body: { idempotency_key: `k-${route}`, machine: "ibx_SOMEONE_ELSE" } });
      expect([route, answer.status]).toEqual([route, 200]);
    }
    expect(seen.map((s) => [s.route, s.machine])).toEqual([["far-wake", "ibx_LAPTOP"], ["agent-reply", "ibx_LAPTOP"], ["far-delivered", "ibx_LAPTOP"]]);
    // A machine device no link names, and a phone, get the unknown route.
    deviceOf = "";
    expect((await d.call(linked.token, "far-wake", { body: { idempotency_key: "k2" } })).status).toBe(404);
    const phone = await d.phone();
    for (const route of ["taggable-agents", "far-wake", "agent-reply", "far-delivered"]) {
      const answer = await d.call(phone.token, route, route === "taggable-agents" ? {} : { body: { idempotency_key: `p-${route}` } });
      expect([route, answer.status, ((await answer.json()) as Json).code]).toEqual([route, 404, "device_route_not_found"]);
    }
  });

  test("linking through a third: a linked machine's token only, with its window's mark passed on as it sent it", async () => {
    const seen: { route: string; device: string; window: boolean; body: Json }[] = [];
    const machines = {
      linkBack: async () => Response.json({}),
      unlinkedBy: () => Response.json({}),
      hasLinks: () => true,
      linkThroughDoor: async (route: string, device: string, window: boolean, body: Json) => (seen.push({ route, device, window, body }), Response.json({ ok: true })),
    };
    const d = door(undefined, { machines: () => machines });
    const own = ["POST link-through-ask", "POST link-through-offer", "POST link-through-introduce"];
    expect(own.filter((name) => d.devices.doorReach("machine").routes.includes(name))).toEqual(own);
    expect(own.filter((name) => d.devices.doorReach("ios").routes.includes(name))).toEqual([]);
    const linked = await d.machine();
    for (const route of ["link-through-ask", "link-through-offer", "link-through-introduce"]) {
      expect((await d.call(linked.token, route, { body: { n: 1 }, headers: { "X-Plannotator-Window": "1" } })).status).toBe(200);
      expect((await d.call(linked.token, route, { body: { n: 2 } })).status).toBe(200);
    }
    expect(seen.map((s) => [s.route, s.device === linked.device.id, s.window, s.body.n])).toEqual([
      ["link-through-ask", true, true, 1],
      ["link-through-ask", true, false, 2],
      ["link-through-offer", true, true, 1],
      ["link-through-offer", true, false, 2],
      ["link-through-introduce", true, true, 1],
      ["link-through-introduce", true, false, 2],
    ]);
    // A phone's token, even sending the mark, gets the unknown route and reaches nothing.
    const phone = await d.phone();
    for (const route of ["link-through-ask", "link-through-offer", "link-through-introduce"]) {
      const answer = await d.call(phone.token, route, { body: { n: 3 }, headers: { "X-Plannotator-Window": "1" } });
      expect([route, answer.status, ((await answer.json()) as Json).code]).toEqual([route, 404, "device_route_not_found"]);
    }
    expect(seen).toHaveLength(6);
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

  test("a relay command's `app` that is not in the form, or not a header's characters, is served as if absent, never a 500", async () => {
    const d = door();
    const phone = await d.phone();
    for (const app of ["ios 1.0 ✓ contract 1", "ios 1.0.0 contract 1\r\nX-Evil: 1", "ios 1.0.0\u0000 contract 1", 7]) {
      const answer = await d.devices.asDevice(phone.device.id, { method: "GET", path: "/api/inbox/device/threads", app });
      expect([app, answer.status]).toEqual([app, 200]);
      const write = await d.devices.asDevice(phone.device.id, { method: "POST", path: "/api/inbox/device/threads/thr_1/seen", body: { idempotency_key: `k-${String(app)}` }, app });
      expect([app, write.status]).toEqual([app, 200]);
    }
    expect((await d.listed())[0]!.app).toBeNull();
    expect(d.handed.every((h) => h.headers.get(APP_HEADER) === null)).toBe(true);
  });

  test("below the floor: 426 app_needs_update everywhere but health and revoke, on the door and through the relay; nothing reaches the window", async () => {
    const d = door();
    const phone = await d.phone();
    const old = "ios 0.9.0 contract 0";
    const refused = { error: "Update Plannotator on your phone.", code: "app_needs_update", min_app_contract: MIN_APP_CONTRACT };
    const threads = await d.call(phone.token, "threads", { app: old });
    expect([threads.status, await threads.json(), threads.headers.get("Upgrade")]).toEqual([426, refused, APP_UPGRADE]);
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

describe("a refusal at the door is never kept under the key", () => {
  test("a POST to a route off the door: 404, and the same key is free for the route the app meant", async () => {
    const d = door();
    const phone = await d.phone();
    const missing = await d.call(phone.token, "threads/thr_1/no-such-write", { body: { idempotency_key: "k-1" } });
    expect([missing.status, ((await missing.json()) as Json).code]).toEqual([404, "device_route_not_found"]);
    const meant = await d.call(phone.token, "threads/thr_1/seen", { body: { idempotency_key: "k-1" } });
    expect([meant.status, meant.headers.get("Idempotent-Replayed")]).toEqual([200, null]);
  });
});

describe("what a client offers, both ways round", () => {
  const BEFORE = ["GET health", "GET threads", "POST messages/:id/reply"];
  const app = { contract: DOOR_CONTRACT, min_inbox_contract: 0, routes_before_door: BEFORE };

  test("this Inbox's own health: a phone is offered exactly its routes, never a linked computer's", () => {
    const skew = readInboxDoorHealth({ ok: true, door: doorHealth(doorReachOf("ios")) }, app);
    expect(skew.state).toBe("ok");
    expect(inboxDoorOffers(skew, "POST messages/:id/reply")).toBe(true);
    expect(inboxDoorOffers(skew, "POST messages/:id/reply", "relay")).toBe(true);
    expect(inboxDoorOffers(skew, "GET cards")).toBe(false);
    // Listed, but not through the relay.
    expect(inboxDoorOffers(skew, "POST uploads")).toBe(true);
    expect(inboxDoorOffers(skew, "POST uploads", "relay")).toBe(false);
  });

  test("a newer app on an Inbox from before the handshake: today's routes only, or update the computer once the app needs more", () => {
    const old = { ok: true, version: "0.28.8" };
    expect(readInboxDoorHealth(old, app)).toEqual({ state: "ok", contract: 0, routes: BEFORE, not_by_relay: [], grants: [] });
    expect(inboxDoorOffers(readInboxDoorHealth(old, { ...app, not_by_relay_before_door: ["POST messages/:id/reply"] }), "POST messages/:id/reply", "relay")).toBe(false);
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
    expect(readInboxDoorHealth(newer, app)).toEqual({ state: "ok", contract: 7, routes: ["GET health", "GET threads", "GET events:device"], not_by_relay: [], grants: ["agents"] });
    expect(readInboxDoorHealth({ door: { ...newer.door, min_app_contract: 5 } }, app)).toEqual({ state: "app_needs_update", contract: 7, min_app_contract: 5 });
  });
});
