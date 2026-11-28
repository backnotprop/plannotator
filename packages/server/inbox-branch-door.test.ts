/**
 * Branch reviews on the device door (inbox-devices.ts), in process: `GET reviews/branches` is a linked machine's
 * alone. What regresses: a paired phone reading this computer's reported branches (their branch names, heads and
 * remotes), on the door or through the relay; a linked machine not reaching it, or its answer (the list, or Branch
 * reviews off) changed on the way. No Inbox: the window's handler is a recorder.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxDevices } from "./inbox-devices";

type Json = Record<string, any>;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function door(answer: () => Response) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-branch-door-"));
  roots.push(dataDir);
  const handed: string[] = [];
  const devices = createInboxDevices({
    dataDir,
    serverSession: "0".repeat(32),
    port: () => 1,
    registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: async (req) => {
      handed.push(new URL(req.url).pathname);
      return answer();
    },
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const pair = async (body: Json) => (await (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify(body) }), pairUrl)).json()) as Json;
  const read = (token: string) => {
    const url = new URL("http://127.0.0.1/api/inbox/device/reviews/branches");
    return devices.door(new Request(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } }), url);
  };
  return { devices, handed, pair, read };
}

describe("reported branches on the device door", () => {
  test("a paired phone gets 404, on the door and through the relay; nothing is handed to the window", async () => {
    const d = door(() => Response.json({ reports: [] }));
    const made = (await (await d.devices.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    const phone = await d.pair({ code: made.offer.code, name: "iPhone", platform: "ios" });
    const refused = await d.read(phone.token);
    expect([refused.status, ((await refused.json()) as Json).code]).toEqual([404, "device_route_not_found"]);
    expect((await d.devices.asDevice(phone.device.id, { method: "GET", path: "/api/inbox/device/reviews/branches" })).status).toBe(404);
    expect(d.handed).toEqual([]);
  });

  test("a linked machine reaches the window's route, and gets its answer: the list, or 409 while Branch reviews is off", async () => {
    let off = false;
    const d = door(() => (off ? Response.json({ error: "Branch reviews are off.", code: "branch_reviews_off" }, { status: 409 }) : Response.json({ reports: [] })));
    const offer = d.devices.machineDoor.openMachineOffer();
    const machine = await d.pair({ name: "MacBook", platform: "machine", secret: offer.secret });
    expect((await d.read(machine.token)).status).toBe(200);
    off = true;
    const refused = await d.read(machine.token);
    expect([refused.status, ((await refused.json()) as Json).code]).toEqual([409, "branch_reviews_off"]);
    expect(d.handed).toEqual(["/api/inbox/reviews/branches", "/api/inbox/reviews/branches"]);
  });
});
