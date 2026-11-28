/**
 * The PR board's routes on the device door (inbox-devices.ts), in process: who reaches them and what the window's
 * route is told about the caller. What regresses: a paired phone reaching a PR read or write (on the door or through
 * the relay); a linked machine's write handed in as a window press without the window's mark; the relay's command
 * handed in as one (it carries no headers, so the window's route answers it `403 window_only`). No Inbox, no gh: the
 * window's handler is a recorder.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxDevices, type InboxDoorCaller } from "./inbox-devices";

type Json = Record<string, any>;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function door() {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-machine-pulls-door-"));
  roots.push(dataDir);
  const handed: { path: string; from: InboxDoorCaller }[] = [];
  const devices = createInboxDevices({
    dataDir,
    serverSession: "0".repeat(32),
    port: () => 1,
    registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: async (req, from) => {
      handed.push({ path: new URL(req.url).pathname, from });
      return Response.json({ ok: true });
    },
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const pair = async (body: Json) => (await (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify(body) }), pairUrl)).json()) as Json;
  const call = (token: string, route: string, method = "POST", headers: Record<string, string> = {}) => {
    const url = new URL(`http://127.0.0.1/api/inbox/device/${route}`);
    return devices.door(new Request(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, ...(method === "POST" ? { body: JSON.stringify({ key: "github.com/northwind/api#7", idempotency_key: `k-${route}-${Math.random()}` }) } : {}) }), url);
  };
  return { devices, handed, pair, call };
}

const WRITES = ["pulls/close", "pulls/reopen", "pulls/merge"];
const READS = ["pulls", "pulls/risk", "pulls/pull", "pulls/details", "pulls/diff"];

describe("the PR board on the device door", () => {
  test("a paired phone reaches none of it, on the door or through the relay; nothing is handed to the window", async () => {
    const d = door();
    const made = (await (await d.devices.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    const phone = await d.pair({ code: made.offer.code, name: "iPhone", platform: "ios" });
    for (const route of WRITES) {
      const refused = await d.call(phone.token, route);
      expect([route, refused.status, ((await refused.json()) as Json).code]).toEqual([route, 404, "device_route_not_found"]);
      const relayed = await d.devices.asDevice(phone.device.id, { method: "POST", path: `/api/inbox/device/${route}`, body: { key: "github.com/northwind/api#7" } });
      expect([route, relayed.status]).toEqual([route, 404]);
    }
    for (const route of READS) expect([route, (await d.call(phone.token, route, "GET")).status]).toEqual([route, 404]);
    expect(d.handed).toEqual([]);
  });

  test("a linked machine reads a PR that left its board here (`pulls/pull`), as it reads its diff", async () => {
    const d = door();
    const offer = d.devices.machineDoor.openMachineOffer();
    const machine = await d.pair({ name: "MacBook", platform: "machine", secret: offer.secret });
    for (const route of ["pulls/pull", "pulls/diff"]) expect([route, (await d.call(machine.token, route, "GET")).status]).toEqual([route, 200]);
    expect(d.handed.map((h) => [h.path, h.from.platform])).toEqual([
      ["/api/inbox/pulls/pull", "machine"],
      ["/api/inbox/pulls/diff", "machine"],
    ]);
  });

  test("a linked machine's write is a window press only with the window's mark; the relay's command never is", async () => {
    const d = door();
    const offer = d.devices.machineDoor.openMachineOffer();
    const machine = await d.pair({ name: "MacBook", platform: "machine", secret: offer.secret });
    expect(typeof machine.token).toBe("string");
    for (const route of WRITES) {
      expect((await d.call(machine.token, route)).status).toBe(200);
      expect((await d.call(machine.token, route, "POST", { "X-Plannotator-Window": "1" })).status).toBe(200);
      expect((await d.devices.asDevice(machine.device.id, { method: "POST", path: `/api/inbox/device/${route}`, body: { key: "github.com/northwind/api#7", idempotency_key: `relay-${route}` } })).status).toBe(200);
    }
    // Bare, marked, relayed: only the marked one is the window's (inbox.ts `pullWriteFromWindow` refuses the others).
    expect(d.handed.map((h) => [h.path, h.from.platform, h.from.window])).toEqual(
      WRITES.flatMap((route) => [
        [`/api/inbox/${route}`, "machine", false],
        [`/api/inbox/${route}`, "machine", true],
        [`/api/inbox/${route}`, "machine", false],
      ]),
    );
  });
});
