/**
 * A new Inbox against relay 1.0 and relay 1.1 (adr/implementation/inbox-mobile.md,
 * section 4, "Relay 1.1" and its compatibility rules), and the `not_after`
 * of a sealed command.
 *
 * The relay is a loopback stand-in speaking the socket's frames: its `hello`
 * names no version (1.0, the relay deployed before 1.1) or `"1.1"`. Against
 * 1.0 the Inbox sends only what 1.0 takes: the push body stays
 * `{ device_id, collapse_id, ciphertext }` and no `live` push is posted.
 * A sealed command's `not_after` goes to the door with it, which checks it
 * after the command's key (inbox-door-not-after.test.ts proves the refusals);
 * every result carries the computer's `now`. No network beyond loopback.
 */
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { decryptWithKey, deriveRelayKeys, encryptWithKey } from "@plannotator/core/crypto";
import { InboxDevices } from "@plannotator/shared/inbox/devices";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { commandTimeRefusal, createInboxRelay } from "./inbox-relay";

const PHONE = "dev_01M4H6G73M9H3Z32T859E72DPY";
const AGENT = { kind: "agent" as const, host: "claude-code", session: "ses_a", name: null };

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

async function waitFor(check: () => boolean, problem: string, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(problem);
    await Bun.sleep(10);
  }
}

type Frame = Record<string, any>;

async function world(version: string | undefined) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-relay-version-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const posted: { path: string; body: Frame }[] = [];
  const frames: Frame[] = [];
  let inbox: ServerWebSocket<unknown> | null = null;
  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/socket")) return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
      if (req.method === "POST" && path === "/v1/mailboxes") return Response.json({ mailbox_id: "mbx_test" }, { status: 201 });
      if (req.method === "POST" && path.endsWith("/push")) {
        const body = (await req.json()) as Frame;
        posted.push({ path, body });
        // 1.0 takes only the sealed push: a body without its fields is a 400, as 1.0's relay answers.
        if (version === undefined && (typeof body.collapse_id !== "string" || typeof body.ciphertext !== "string")) return Response.json({ error: "bad request", code: "bad_request" }, { status: 400 });
        return Response.json({ sent: true }, { status: 202 });
      }
      if (req.method === "PUT") return Response.json({ device_id: PHONE });
      return new Response("not here", { status: 404 });
    },
    websocket: {
      open(ws) {
        inbox = ws;
        ws.send(JSON.stringify({ type: "hello", ...(version === undefined ? {} : { version }), devices: [{ device_id: PHONE, cursor: 0, carriage: true, apns: true, fcm: false }] }));
      },
      message(_ws, message) {
        frames.push(JSON.parse(String(message)));
      },
    },
  });
  cleanup.push(() => relay.stop(true));
  const store = InboxStore.open(dataDir);
  const devices = InboxDevices.open(dataDir);
  const secret = randomBytes(32).toString("base64url");
  const device = devices.add({ id: PHONE, name: "Phone", platform: "ios", token: "tok_x", secret, at: new Date().toISOString() });
  const applied: { method: string; path: string; not_after?: unknown }[] = [];
  const client = createInboxRelay({
    dataDir,
    store,
    devices,
    payload: () => ({}),
    apply: async (_deviceId, command) => {
      applied.push({ method: command.method, path: command.path, not_after: command.not_after });
      return Response.json({ ok: true });
    },
    url: `http://127.0.0.1:${relay.port}`,
    log: () => {},
  });
  expect(await client.paired(device)).not.toBeNull();
  client.start();
  cleanup.push(() => client.stop());
  await waitFor(() => inbox !== null && client.relayVersion() !== null, "the Inbox never read hello");
  const keys = await deriveRelayKeys(secret, PHONE);
  /** Hand the Inbox one sealed command, as the relay does, and wait for it to be reported applied. */
  const command = async (id: string, plaintext: Frame) => {
    const ciphertext = await encryptWithKey(JSON.stringify({ v: 1, id, method: "POST", path: "/api/inbox/device/threads/msg_x/reply", body: { idempotency_key: id }, ...plaintext }), keys.upKey);
    inbox!.send(JSON.stringify({ type: "command", device_id: PHONE, id, ciphertext }));
    await waitFor(() => frames.some((f) => f.type === "applied" && f.id === id), `command ${id} was never reported applied`);
    const results = await Promise.all(
      frames.filter((f) => f.type === "item" && f.cursor === null).map(async (f) => JSON.parse(await decryptWithKey(f.ciphertext, keys.key)) as Frame),
    );
    return results.find((r) => r.type === "result" && r.id === id) ?? null;
  };
  const project = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
  return { client, store, project, posted, applied, command };
}

test("against relay 1.0 (no version in hello): the push body is 1.0's, and no live push is posted", async () => {
  const w = await world(undefined);
  expect(w.client.relayVersion()).toBe("1.0");
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: ":::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::" });
  await waitFor(() => w.posted.length === 1, "no push");
  expect(Object.keys(w.posted[0]!.body).sort()).toEqual(["ciphertext", "collapse_id", "device_id"]);
  expect(await w.client.live(PHONE, { working: 1, stopped_on_you: 0, ended: false })).toBe("relay_too_old");
  expect(w.posted.length).toBe(1);
});

test("against relay 1.1: a live push carries counts only, in the clear", async () => {
  const w = await world("1.1");
  expect(w.client.relayVersion()).toBe("1.1");
  expect(await w.client.live(PHONE, { working: 2, stopped_on_you: 1, ended: false })).toBe("sent");
  const body = w.posted.at(-1)!.body;
  expect(body).toEqual({ device_id: PHONE, kind: "live", live: { timestamp: expect.any(Number), event: "update", "content-state": { working: 2, stopped_on_you: 1, ended: false } } });
});

test("a sealed command's not_after is handed to the door with it (which checks it after its key), and every result carries the computer's time", async () => {
  const w = await world(undefined);
  const at = new Date(Date.now() - 60_000).toISOString();
  const result = await w.command("key-late", { not_after: at });
  expect(result).toMatchObject({ status: 200 });
  expect(Math.abs(Date.parse(result!.now) - Date.now())).toBeLessThan(5_000);
  await w.command("key-old-app", {});
  expect(w.applied.map((a) => a.not_after)).toEqual([at, undefined]);
});

test("not_after that is not a time refuses the command rather than guess; a few seconds past it are allowed for transit", () => {
  expect(commandTimeRefusal(undefined, Date.now())).toBeNull();
  expect(commandTimeRefusal("soon", Date.now())).toMatchObject({ status: 400 });
  expect(commandTimeRefusal(1_700_000_000, Date.now())).toMatchObject({ status: 400 });
  expect(commandTimeRefusal("2026-11-18T10:00:00.000Z", Date.parse("2026-11-18T10:00:05.001Z"))).toMatchObject({ status: 410, body: { now: "2026-11-18T10:00:05.001Z" } });
  expect(commandTimeRefusal("2026-11-18T10:00:00.000Z", Date.parse("2026-11-18T10:00:05.000Z"))).toBeNull();
  expect(commandTimeRefusal("2026-11-18T10:00:00.000Z", Date.parse("2026-11-18T10:00:00.000Z"))).toBeNull();
});
