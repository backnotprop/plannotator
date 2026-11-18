/**
 * A "now" write sent straight to the device door (Wi-Fi or the tailnet) with `X-Plannotator-Not-After`
 * (inbox-not-after.ts; contract section 4, "not_after"), in process: the window's handler is a recorder. What
 * regresses: a write the app queued while offline applied long after its time when it finally goes direct; a
 * refusal kept under its key (so the intent sent again with a new time stays refused); the header handed to the
 * window; a write without the header, or a read, refused. No Inbox.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxDevices } from "./inbox-devices";
import { NOT_AFTER_HEADER } from "./inbox-not-after";

type Json = Record<string, any>;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function door() {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-door-not-after-"));
  roots.push(dataDir);
  const handed: { path: string; header: string | null }[] = [];
  const devices = createInboxDevices({
    dataDir,
    serverSession: "0".repeat(32),
    port: () => 1,
    registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    dispatch: async (req) => {
      handed.push({ path: new URL(req.url).pathname, header: req.headers.get(NOT_AFTER_HEADER) });
      return Response.json({ ok: true });
    },
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const made = (await (await devices.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
  const phone = (await (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) }), pairUrl)).json()) as Json;
  const send = (key: string, notAfter?: string) => {
    const url = new URL("http://127.0.0.1/api/inbox/device/messages/msg_01K70000000000000000000010/reply");
    const headers: Record<string, string> = { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" };
    if (notAfter !== undefined) headers[NOT_AFTER_HEADER] = notAfter;
    return devices.door(new Request(url, { method: "POST", headers, body: JSON.stringify({ idempotency_key: key, words: "Go ahead." }) }), url);
  };
  const read = (notAfter: string) => {
    const url = new URL("http://127.0.0.1/api/inbox/device/threads");
    return devices.door(new Request(url, { headers: { Authorization: `Bearer ${phone.token}`, [NOT_AFTER_HEADER]: notAfter } }), url);
  };
  return { handed, send, read };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("not_after on the door", () => {
  test("a write past its time by more than the grace is 410 command_expired with the computer's time, and never reaches the window", async () => {
    const d = await door();
    const late = await d.send("key-late", ago(60_000));
    expect(late.status).toBe(410);
    const body = (await late.json()) as Json;
    expect(body.code).toBe("command_expired");
    expect(Math.abs(Date.parse(body.now) - Date.now())).toBeLessThan(5_000);
    const malformed = await d.send("key-bad", "soon");
    expect([malformed.status, ((await malformed.json()) as Json).code]).toEqual([400, "bad_request"]);
    expect(d.handed).toEqual([]);
  });

  test("inside the grace, ahead of its time, or with no header (an app from before) the write is applied, and the header stays at the door", async () => {
    const d = await door();
    expect((await d.send("key-grace", ago(2_000))).status).toBe(200);
    expect((await d.send("key-ahead", new Date(Date.now() + 60_000).toISOString())).status).toBe(200);
    expect((await d.send("key-none")).status).toBe(200);
    expect(d.handed.map((h) => h.header)).toEqual([null, null, null]);
    expect(d.handed.length).toBe(3);
  });

  test("the refusal is not kept under its key: the same intent sent again with a new time is applied once", async () => {
    const d = await door();
    expect((await d.send("key-again", ago(60_000))).status).toBe(410);
    expect((await d.send("key-again", new Date(Date.now() + 60_000).toISOString())).status).toBe(200);
    expect(d.handed.length).toBe(1);
  });

  test("a read is never refused for its time", async () => {
    const d = await door();
    expect((await d.read(ago(60_000))).status).toBe(200);
  });
});
