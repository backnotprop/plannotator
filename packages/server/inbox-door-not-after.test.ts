/**
 * A "now" write's `not_after` (inbox-not-after.ts; contract section 4, "not_after"), checked once in the door's
 * `claim`, after the command's key: on a write sent straight to the door (`X-Plannotator-Not-After`) and on one
 * the relay hands over (`asDevice`, which the Inbox's relay client calls with the sealed `not_after`). In process:
 * the window's handler is a recorder. What regresses: a late first write applied; a write that WAS applied
 * answering 410 "never applied" when it comes back late (a relay `hello` re-sends one the relay never heard
 * acknowledged; a phone retries one whose answer it lost), so the person presses Run again and a second session
 * starts; a late refusal kept under its key; the header handed to the window; a read, or an app from before,
 * refused; a removed phone or an app below the floor told 410 instead of 401 or 426. No Inbox.
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

const PATH = "/api/inbox/device/messages/msg_01K70000000000000000000010/reply";

async function door(hold?: Promise<void>) {
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
      if (hold) await hold;
      return Response.json({ id: `msg_${handed.length}` }, { status: req.method === "GET" ? 200 : 201 });
    },
  });
  const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
  const made = (await (await devices.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as Json;
  const phone = (await (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) }), pairUrl)).json()) as Json;
  /** Straight to the door, as over the Wi-Fi or the tailnet. */
  const send = (key: string, notAfter?: string, extra: Record<string, string> = {}, route = PATH) => {
    const url = new URL(`http://127.0.0.1${route}`);
    const headers: Record<string, string> = { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json", ...extra };
    if (notAfter !== undefined) headers[NOT_AFTER_HEADER] = notAfter;
    return devices.door(new Request(url, { method: "POST", headers, body: JSON.stringify({ idempotency_key: key, words: "Go ahead." }) }), url);
  };
  /** Through the relay: the sealed command as the relay client hands it over. */
  const relay = (key: string, notAfter?: unknown, app?: string) =>
    devices.asDevice(phone.device.id, { method: "POST", path: PATH, body: { idempotency_key: key, words: "Go ahead." }, not_after: notAfter, app });
  const read = (notAfter: string) => {
    const url = new URL("http://127.0.0.1/api/inbox/device/threads");
    return devices.door(new Request(url, { headers: { Authorization: `Bearer ${phone.token}`, [NOT_AFTER_HEADER]: notAfter } }), url);
  };
  return { devices, handed, send, relay, read, phone };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const ways = ["the door", "the relay"] as const;
const via = (d: Awaited<ReturnType<typeof door>>, way: (typeof ways)[number]) => (key: string, notAfter?: string) => (way === "the door" ? d.send(key, notAfter) : d.relay(key, notAfter));

describe("not_after", () => {
  for (const way of ways) {
    test(`${way}: a late first arrival is 410 command_expired with the computer's time, never reaches the window, and is not kept under its key`, async () => {
      const d = await door();
      const send = via(d, way);
      const late = await send("key-late", ago(60_000));
      expect(late.status).toBe(410);
      const body = (await late.json()) as Json;
      expect(body.code).toBe("command_expired");
      expect(Math.abs(Date.parse(body.now) - Date.now())).toBeLessThan(5_000);
      expect(d.handed).toEqual([]);
      // Not kept: the same intent sent again with a new time is applied, once.
      expect((await send("key-late", ahead(60_000))).status).toBe(201);
      expect(d.handed.length).toBe(1);
    });

    test(`${way}: a write that was applied, coming back past its time under its key, replays its recorded answer`, async () => {
      const d = await door();
      const send = via(d, way);
      const first = await send("key-run", ahead(30_000));
      expect([first.status, await first.json()]).toEqual([201, { id: "msg_1" }]);
      // Two minutes on: a hello re-sends it (the relay never heard `applied`), or the phone retries a lost answer.
      const again = await send("key-run", ago(90_000));
      expect([again.status, await again.json(), again.headers.get("Idempotent-Replayed")]).toEqual([201, { id: "msg_1" }, "true"]);
      expect(d.handed.length).toBe(1);
    });
  }

  test("a late duplicate of a write still being applied waits for it and replays its answer, never 410", async () => {
    let release!: () => void;
    const d = await door(new Promise<void>((resolve) => (release = resolve)));
    const first = d.send("key-slow", ahead(30_000));
    while (d.handed.length === 0) await Bun.sleep(1);
    const late = d.relay("key-slow", ago(60_000));
    release();
    expect((await first).status).toBe(201);
    const replay = await late;
    expect([replay.status, replay.headers.get("Idempotent-Replayed")]).toEqual([201, "true"]);
    expect(d.handed.length).toBe(1);
  });

  test("inside the grace, ahead of its time, or with none (an app from before) the write is applied; not a time is 400; the header stays at the door", async () => {
    const d = await door();
    expect((await d.send("key-grace", ago(2_000))).status).toBe(201);
    expect((await d.send("key-ahead", ahead(60_000))).status).toBe(201);
    expect((await d.send("key-none")).status).toBe(201);
    expect((await d.relay("key-none-relay")).status).toBe(201);
    expect(d.handed.map((h) => h.header)).toEqual([null, null, null, null]);
    for (const bad of ["soon", 1_700_000_000]) {
      const refused = await (typeof bad === "string" ? d.send(`key-${bad}`, bad) : d.relay(`key-${bad}`, bad));
      expect([refused.status, ((await refused.json()) as Json).code]).toEqual([400, "bad_request"]);
    }
    expect(d.handed.length).toBe(4);
  });

  test("a read is never refused for its time", async () => {
    const d = await door();
    expect((await d.read(ago(60_000))).status).toBe(200);
  });

  test("the same order on both paths: an app below the floor is 426, a removed phone 401, before its time is looked at", async () => {
    const d = await door();
    const old = "ios 0.9.0 contract 0";
    expect((await d.send("key-floor", ago(60_000), { "X-Plannotator-App": old })).status).toBe(426);
    expect((await d.relay("key-floor-relay", ago(60_000), old)).status).toBe(426);
    expect((await d.send("key-revoke", undefined, {}, "/api/inbox/device/revoke")).status).toBe(200);
    expect((await d.send("key-gone", ago(60_000))).status).toBe(401);
    expect((await d.relay("key-gone-relay", ago(60_000))).status).toBe(401);
    expect(d.handed).toEqual([]);
  });
});
