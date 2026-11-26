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
import { doorWriteKind } from "./inbox-outbox";

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

  test("a linked machine's canvas writes reach the window route under their key; a phone's reach nothing", async () => {
    const d = door(() => Response.json({ ok: true, rev: 5 }));
    const made = (await (await d.devices.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
    const phone = await d.pair({ code: made.offer.code, name: "iPhone", platform: "ios" });
    const offer = d.devices.machineDoor.openMachineOffer();
    const machine = await d.pair({ name: "Studio", platform: "machine", secret: offer.secret });
    const post = (token: string, path: string, body: string, type = "application/json") => {
      const url = new URL(`http://127.0.0.1/api/inbox/device/${path}`);
      return d.devices.door(new Request(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": type }, body }), url);
    };
    const save = JSON.stringify({ scene: { elements: [] }, have: 4, partial: true, idempotency_key: "k-save" });
    const undo = JSON.stringify({ rev: 4, idempotency_key: "k-undo" });
    const job = `job_${"a".repeat(32)}`;
    const writes: [string, string, string?][] = [
      ["threads/msg_A1/canvas", save],
      ["threads/msg_A1/canvas/undo", undo],
      ["threads/msg_A1/canvas/files?idempotency_key=k-files", JSON.stringify({ files: {} })],
      ["threads/msg_A1/canvas/picture?rev=4&x=0&y=0&w=10&h=10&scale=1&idempotency_key=k-pic", "PNGBYTES", "image/png"],
      [`canvas/jobs/${job}?x=0&y=0&w=10&h=10&scale=1&idempotency_key=k-job`, "PNGBYTES", "image/png"],
    ];
    for (const [path, body, type] of writes) expect([path, (await post(phone.token, path, body, type)).status]).toEqual([path, 404]);
    expect(d.handed).toEqual([]);
    for (const [path, body, type] of writes) expect([path, (await post(machine.token, path, body, type)).status]).toEqual([path, 200]);
    expect(d.handed.map((line) => line.split("?")[0])).toEqual([
      "POST /api/inbox/threads/msg_A1/canvas",
      "POST /api/inbox/threads/msg_A1/canvas/undo",
      "POST /api/inbox/threads/msg_A1/canvas/files",
      "POST /api/inbox/threads/msg_A1/canvas/picture",
      `POST /api/inbox/canvas/jobs/${job}`,
    ]);
    // A second copy under its key is answered without running again (the outbox may send a held save twice).
    expect((await post(machine.token, "threads/msg_A1/canvas", save)).status).toBe(200);
    expect(d.handed.length).toBe(5);
  });

  test("each canvas write has its outbox kind: a save and an Undo are held and put a state (a second copy changes nothing more), bytes and job answers go now", () => {
    expect(doorWriteKind("threads/msg_A1/canvas")).toBe("set");
    expect(doorWriteKind("threads/msg_A1/canvas/undo")).toBe("set");
    expect(doorWriteKind("threads/msg_A1/canvas/files")).toBe("file");
    expect(doorWriteKind("threads/msg_A1/canvas/picture")).toBe("file");
    expect(doorWriteKind(`canvas/jobs/job_${"a".repeat(32)}`)).toBe("file");
  });
});
