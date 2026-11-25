/**
 * A thread's canvas on the device door (inbox-devices.ts), in process: the read path for a linked machine's window
 * (`GET threads/:id/canvas`, its pictures' files, `canvases`; mark `canvas`). What regresses: a paired phone reading a
 * canvas; a linked machine not reaching it, its query (`look`, `since`) dropped on the way, or the canvas's own answer
 * (the scene, or 409 while the canvas is off) changed; a canvas write carried before the door classifies it. No
 * Inbox: the window's handler is a recorder.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_LINKED_MARKS } from "@plannotator/core/inbox-types";
import { createInboxDevices } from "./inbox-devices";

type Json = Record<string, any>;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function door(answer: () => Response) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-canvas-door-"));
  roots.push(dataDir);
  const handed: string[] = [];
  const devices = createInboxDevices({
    dataDir,
    serverSession: "0".repeat(32),
    port: () => 1,
    registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: async (req) => {
      const url = new URL(req.url);
      handed.push(`${req.method} ${url.pathname}${url.search}`);
      return answer();
    },
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const pair = async (body: Json) => (await (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify(body) }), pairUrl)).json()) as Json;
  const ask = (token: string, path: string, method = "GET") => {
    const url = new URL(`http://127.0.0.1/api/inbox/device/${path}`);
    return devices.door(new Request(url, { method, headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(method === "POST" ? { body: "{}" } : {}) }), url);
  };
  return { devices, handed, pair, ask };
}

const READS = ["threads/msg_A1/canvas?look=1", "threads/msg_A1/canvas?since=3", "threads/msg_A1/canvas/files/f_1", "canvases"];

describe("a thread's canvas on the device door", () => {
  test("a linked machine Inbox says it takes canvas reads", () => {
    expect(INBOX_LINKED_MARKS as readonly string[]).toContain("canvas");
  });

  test("a paired phone gets 404 for every canvas read; nothing is handed to the window", async () => {
    const d = door(() => Response.json({ scene: { elements: [] } }));
    const made = (await (await d.devices.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    const phone = await d.pair({ code: made.offer.code, name: "iPhone", platform: "ios" });
    for (const path of READS) {
      const refused = await d.ask(phone.token, path);
      expect([path, refused.status]).toEqual([path, 404]);
    }
    expect(d.handed).toEqual([]);
  });

  test("a linked machine reaches each canvas read with its query, and gets the canvas's own answer, 409 while it is off", async () => {
    let off = false;
    const d = door(() => (off ? Response.json({ error: "The canvas is off in this Inbox (Settings → Capabilities).", code: "canvas_off" }, { status: 409 }) : Response.json({ rev: 4, scene: { elements: [] } })));
    const offer = d.devices.machineDoor.openMachineOffer();
    const machine = await d.pair({ name: "Studio", platform: "machine", secret: offer.secret });
    for (const path of READS) {
      const got = await d.ask(machine.token, path);
      expect([path, got.status]).toEqual([path, 200]);
    }
    expect(d.handed).toEqual(["GET /api/inbox/threads/msg_A1/canvas?look=1", "GET /api/inbox/threads/msg_A1/canvas?since=3", "GET /api/inbox/threads/msg_A1/canvas/files/f_1", "GET /api/inbox/canvases"]);
    off = true;
    const refused = await d.ask(machine.token, "threads/msg_A1/canvas");
    expect([refused.status, ((await refused.json()) as Json).code]).toEqual([409, "canvas_off"]);
  });

  test("a canvas write is not carried yet: a save, an Undo or a picture from a linked machine reaches nothing", async () => {
    const d = door(() => Response.json({ ok: true }));
    const offer = d.devices.machineDoor.openMachineOffer();
    const machine = await d.pair({ name: "Studio", platform: "machine", secret: offer.secret });
    for (const path of ["threads/msg_A1/canvas", "threads/msg_A1/canvas/undo", "threads/msg_A1/canvas/picture"]) {
      const refused = await d.ask(machine.token, path, "POST");
      expect([path, refused.status]).toEqual([path, 404]);
    }
    expect(d.handed).toEqual([]);
  });
});
