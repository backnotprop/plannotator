/**
 * Phones stay hidden until the iPhone app ships: PLANNOTATOR_INBOX_PHONES (or
 * config.json `inboxPhones`) turns the whole phone surface on, and it is off
 * by default. Proved on `plannotator inbox --background` (the CLI from source,
 * or the compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names one) under
 * a temp data dir, with a fake relay on loopback and `openssl` / `tailscale`
 * stand-ins on PATH that record every call:
 *
 *  1. On: pairing works as before, and the paired Inbox holds a socket to the relay.
 *  2. Off, over the state that run left (relay.json, a paired phone) plus the
 *     Wi-Fi and tailnet switches seeded on: every phone route answers the
 *     unknown-route 404, the settings payload says `phones: false`, nothing
 *     reaches the relay, openssl and tailscale never run, and no listener
 *     opens beyond the window's port.
 *  3. On again over the same state: the relay socket, openssl and tailscale
 *     all come back, so step 2's silence is the switch's doing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveInboxPhones } from "@plannotator/shared/config";
import { isPidAlive, readInboxRegistry, writeInboxRegistry } from "@plannotator/shared/inbox/registry";
import { createInboxWorld, destroyInboxWorld, registry, stopInbox, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

describe("resolveInboxPhones", () => {
  test("off by default; the env var wins over config.json; unrecognized env values count as unset", () => {
    expect(resolveInboxPhones({}, {})).toBe(false);
    expect(resolveInboxPhones({ inboxPhones: true }, {})).toBe(true);
    expect(resolveInboxPhones({ inboxPhones: true }, { PLANNOTATOR_INBOX_PHONES: "0" })).toBe(false);
    expect(resolveInboxPhones({ inboxPhones: false }, { PLANNOTATOR_INBOX_PHONES: "1" })).toBe(true);
    expect(resolveInboxPhones({}, { PLANNOTATOR_INBOX_PHONES: "on" })).toBe(true);
    expect(resolveInboxPhones({ inboxPhones: true }, { PLANNOTATOR_INBOX_PHONES: "maybe" })).toBe(true);
    expect(resolveInboxPhones({}, { PLANNOTATOR_INBOX_PHONES: "" })).toBe(false);
  });
});

/** Every route the phone surface adds, as the window or a phone would call it (no Origin). */
const PHONE_ROUTES: [method: string, path: string][] = [
  ["GET", "/api/inbox/device"],
  ["GET", "/api/inbox/device/health"],
  ["GET", "/api/inbox/device/threads"],
  ["POST", "/api/inbox/device/pair"],
  ["POST", "/api/inbox/device/revoke"],
  ["POST", "/api/inbox/pairing"],
  ["GET", "/api/inbox/devices"],
  ["POST", "/api/inbox/devices/dev_x/revoke"],
  ["GET", "/api/inbox/tailnet"],
  ["POST", "/api/inbox/tailnet"],
  ["GET", "/api/inbox/lan"],
  ["POST", "/api/inbox/lan"],
];

describe("the phone switch, on the binary", () => {
  let w: InboxWorld;
  let stubs: string[] = [];
  let relay: ReturnType<typeof Bun.serve>;
  const relayRequests: string[] = [];
  let relaySockets = 0;
  let marker = "";
  let token = "";

  const base = () => `http://127.0.0.1:${registry(w).port}`;
  const calls = () => (existsSync(marker) ? readFileSync(marker, "utf8") : "");

  /** `plannotator inbox --background` with the switch as given, pointed at the fake relay. */
  const start = (phones: "0" | "1" | null) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: `http://127.0.0.1:${relay.port}` };
    if (phones === null) delete env.PLANNOTATOR_INBOX_PHONES;
    else env.PLANNOTATOR_INBOX_PHONES = phones;
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background"], { env, cwd: w.root });
    if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`);
    return registry(w);
  };
  const stop = async () => {
    const { pid } = registry(w);
    stopInbox(w);
    await waitFor("the Inbox to exit", () => !isPidAlive(pid));
  };
  const call = (method: string, path: string, body: unknown = {}) =>
    fetch(`${base()}${path}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
  const refused = (port: number) =>
    new Promise<boolean>((resolve) => {
      Bun.connect({ hostname: "127.0.0.1", port, socket: { open: (s) => (s.end(), resolve(false)), data() {}, error: () => resolve(true), connectError: () => resolve(true) } }).catch(() => resolve(true));
    });

  beforeAll(() => {
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-inbox-phones-gate-", "phones-gate", "phones-gate");
    marker = join(w.root, "calls.txt");
    // Stand-ins that record a call and fail: openssl makes the Wi-Fi certificate, tailscale publishes the tailnet path.
    for (const name of ["openssl", "tailscale"]) {
      writeFileSync(join(w.bin, name), `#!/bin/sh\necho "${name} $*" >> '${marker}'\nexit 1\n`);
      chmodSync(join(w.bin, name), 0o755);
    }
    relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        const path = new URL(req.url).pathname;
        relayRequests.push(`${req.method} ${path}`);
        if (path.endsWith("/socket") && server.upgrade(req)) return undefined;
        if (req.method === "POST" && path === "/v1/mailboxes") return Response.json({ mailbox_id: "mbx_gate" }, { status: 201 });
        return Response.json({ ok: true });
      },
      websocket: { open: () => void relaySockets++, message() {} },
    });
  });

  afterAll(() => {
    relay?.stop(true);
    if (w) destroyInboxWorld(w);
    for (const path of stubs) rmSync(path, { force: true });
  });

  test("on: a phone pairs as before, and the paired Inbox holds the relay socket", async () => {
    start("1");
    const health = (await (await call("GET", "/api/inbox/health")).json()) as Json;
    expect(((await (await call("GET", "/api/inbox/settings")).json()) as Json).phones).toBe(true);
    const offer = await call("POST", "/api/inbox/pairing", { serverSession: health.serverSession });
    expect(offer.status).toBe(201);
    const { offer: open } = (await offer.json()) as Json;
    const paired = await call("POST", "/api/inbox/device/pair", { code: open.code, name: "Gate iPhone", platform: "ios" });
    expect(paired.status).toBe(201);
    const redeemed = (await paired.json()) as Json;
    token = redeemed.token;
    expect(redeemed.relay).toEqual({ url: `http://127.0.0.1:${relay.port}`, mailbox_id: "mbx_gate" });
    const asPhone = await fetch(`${base()}/api/inbox/device/health`, { headers: { Authorization: `Bearer ${token}` } });
    expect(asPhone.status).toBe(200);
    await waitFor("the relay socket", () => relaySockets > 0);
    await stop();
  }, 60_000);

  test("off (the default): the phone routes are the unknown-route 404, and nothing listens, connects, spawns or makes a certificate", async () => {
    // What a phones run leaves, plus both reach switches on, as an iPhone developer's data dir would hold.
    const previous = readInboxRegistry(w.dataDir)!;
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const lanPort = probe.port as number;
    probe.stop(true);
    writeInboxRegistry(w.dataDir, { ...previous, lan: { port: lanPort, on: true }, tailnet: { https_port: 8443, door_port: lanPort + 1 } });
    expect(existsSync(join(w.dataDir, "inbox", "relay.json"))).toBe(true);
    relayRequests.length = 0;
    relaySockets = 0;
    rmSync(marker, { force: true });

    const { pid, port } = start(null);
    const unknown = await call("GET", "/api/inbox/no-such-route");
    expect(unknown.status).toBe(404);
    const notFound = await unknown.json();
    for (const [method, path] of PHONE_ROUTES) {
      const response = await call(method, path, { serverSession: "x", on: true, code: "000000", name: "x", platform: "ios" });
      expect({ route: `${method} ${path}`, status: response.status, body: await response.json() }).toEqual({ route: `${method} ${path}`, status: 404, body: notFound });
    }
    // The paired phone's own token is just as unknown.
    expect((await fetch(`${base()}/api/inbox/device/health`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
    expect(((await (await call("GET", "/api/inbox/settings")).json()) as Json).phones).toBe(false);

    // Past the relay's first reconnect delay (1 s): nothing reached it.
    await Bun.sleep(2500);
    expect(relayRequests).toEqual([]);
    expect(relaySockets).toBe(0);
    expect(calls()).toBe("");
    expect(existsSync(join(w.dataDir, "inbox", "tls"))).toBe(false);
    expect(await refused(lanPort)).toBe(true);
    expect(await refused(lanPort + 1)).toBe(true);
    if (Bun.which("lsof")) {
      const out = Bun.spawnSync(["lsof", "-nP", "-a", "-p", String(pid), "-i"]).stdout.toString();
      const sockets = out.split("\n").slice(1).filter(Boolean);
      // Only the window's port: its listener and the test's own connections to it, no other local address.
      expect(sockets.filter((line) => line.includes("(LISTEN)")).length).toBe(1);
      for (const line of sockets) expect(line).toContain(`127.0.0.1:${port}`);
      for (const line of sockets) expect(line).not.toContain(`:${relay.port}`);
    }
    await stop();
  }, 60_000);

  test("on again over the same state: the relay socket, openssl and tailscale come back", async () => {
    start("1");
    await waitFor("the relay socket", () => relaySockets > 0);
    await waitFor("openssl and tailscale", () => calls().includes("openssl") && calls().includes("tailscale"));
    expect((await fetch(`${base()}/api/inbox/device/health`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    await stop();
  }, 60_000);
});
