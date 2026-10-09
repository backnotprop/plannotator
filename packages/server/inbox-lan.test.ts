/**
 * "Reach from this Wi-Fi" (mobile plan step P2; adr/implementation/inbox-mobile.md
 * section 3), proved against a real Inbox: `plannotator inbox --background`
 * as a process (the compiled binary when PLANNOTATOR_INBOX_TEST_BINARY names
 * one, as the inbox-e2e job runs it; the CLI from source otherwise) under a
 * temp HOME and data dir. Nothing is mocked: the certificate is made by the
 * real `openssl` at run time (never committed), the listener is a real TLS
 * socket on this machine's network address, and the "phone" is
 * tests/helpers/pinned-phone.ts, which pins the certificate by SHA-256 as the
 * app does and sends its requests byte for byte.
 *
 * Proved: the switch opens the listener and fills the QR's `lan` and `fp`;
 * a phone pairs over the LAN address (exchange 7.2) and reads with its token;
 * six digits are refused there (QR only over the Wi-Fi) while the window's
 * port still takes them;
 * a wrong fingerprint is refused by the phone before it sends anything; the
 * window, `/mcp`, the bridge, control, settings, restart and pairing are
 * absent there whatever Host, Origin or encoded path is sent; the Bonjour
 * record (read back with `dns-sd -L` on macOS) carries the port and `fp`,
 * and goes with the switch, a clean stop and a kill -9; the next start opens
 * the same port with the same certificate. In process: `openssl` missing
 * answers 409 lan_unavailable and the switch stays off.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxWorld, destroyInboxWorld, registry, startInbox, stubBuiltHtml, type InboxWorld } from "../../tests/helpers/inbox-world";
import { PinMismatchError, pinnedRequest } from "../../tests/helpers/pinned-phone";
import { startInboxServer } from "./inbox";
import { certificateFingerprint, INBOX_BONJOUR_TYPE } from "./inbox-lan";

type Json = Record<string, any>;

/** Read `dns-sd -L` for a few seconds: the record's port and TXT, or "" when nothing answers. */
async function bonjourLookup(name: string, ms = 3000): Promise<string> {
  const child = Bun.spawn(["dns-sd", "-L", name, INBOX_BONJOUR_TYPE, "local"], { stdout: "pipe", stderr: "ignore" });
  await Bun.sleep(ms);
  child.kill();
  return await new Response(child.stdout).text();
}

/**
 * Read `dns-sd -B` for a few seconds: the instance names whose last event is
 * Add. A record just taken down can show as a cached Add followed by its Rmv.
 */
async function bonjourBrowse(ms = 3000): Promise<string[]> {
  const child = Bun.spawn(["dns-sd", "-B", INBOX_BONJOUR_TYPE, "local"], { stdout: "pipe", stderr: "ignore" });
  await Bun.sleep(ms);
  child.kill();
  const out = await new Response(child.stdout).text();
  const last = new Map<string, string>();
  for (const line of out.split("\n")) {
    const event = /\s(Add|Rmv)\s/.exec(line)?.[1];
    const name = line.split(`${INBOX_BONJOUR_TYPE}.`)[1]?.trim();
    if (event && name) last.set(name, event);
  }
  return [...last].filter(([, event]) => event === "Add").map(([name]) => name);
}

const canBrowse = process.platform === "darwin" && Bun.which("dns-sd") !== null;
const canAdvertise = canBrowse || (process.platform !== "darwin" && Bun.which("avahi-publish") !== null);

describe("Reach from this Wi-Fi, on the binary", () => {
  let w: InboxWorld;
  let stubs: string[] = [];
  let base = "";
  let serverSession = "";
  let computerName = "";
  let lan: Json = {};
  let token = "";

  const win = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const setLan = async (on: boolean) => {
    const response = await win("/api/inbox/lan", { serverSession, on });
    expect(response.status).toBe(200);
    return ((await response.json()) as Json).lan;
  };
  const phone = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; fingerprint?: string } = {}) =>
    pinnedRequest(lan.address, init.fingerprint ?? lan.fingerprint, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      path,
      headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const restart = async () => {
    base = `http://127.0.0.1:${startInbox(w).port}`;
    serverSession = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession;
  };

  beforeAll(async () => {
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-inbox-lan-", "lan-listener", "lan-listener", { phones: true });
    await restart();
    computerName = ((await (await win("/api/inbox/pairing", { serverSession })).json()) as Json).computer.name;
  }, 60_000);

  afterAll(() => {
    if (w) destroyInboxWorld(w);
    for (const path of stubs) rmSync(path, { force: true });
  });

  test("off until switched on: no listener, no certificate, the QR carries no lan", async () => {
    expect(((await (await win("/api/inbox/lan")).json()) as Json).lan).toEqual({ on: false, address: null, fingerprint: null, bonjour: false, error: null });
    expect(existsSync(join(w.dataDir, "inbox", "tls"))).toBe(false);
    expect(registry(w)).not.toHaveProperty("lan");
  });

  test("on: a TLS listener at ip:port; the certificate made by openssl, 0600 in a 0700 folder; the QR carries lan and fp", async () => {
    lan = await setLan(true);
    expect(lan.on).toBe(true);
    expect(lan.error).toBeNull();
    expect(lan.bonjour).toBe(canAdvertise);
    expect(lan.address).toMatch(/^\d{1,3}(\.\d{1,3}){3}:\d+$/);
    expect(lan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const port = Number(lan.address.split(":")[1]);
    expect(port).not.toBe(registry(w).port);
    expect((registry(w) as Json).lan).toEqual({ port, on: true });

    const tls = join(w.dataDir, "inbox", "tls");
    const cert = readFileSync(join(tls, "cert.pem"), "utf8");
    expect(certificateFingerprint(cert)).toBe(lan.fingerprint);
    expect(readFileSync(join(tls, "key.pem"), "utf8")).toContain("PRIVATE KEY");
    if (process.platform !== "win32") {
      expect(statSync(tls).mode & 0o777).toBe(0o700);
      expect(statSync(join(tls, "cert.pem")).mode & 0o777).toBe(0o600);
      expect(statSync(join(tls, "key.pem")).mode & 0o777).toBe(0o600);
    }
    // Self-signed P-256 with CN=Plannotator Inbox, as the contract writes it.
    const { X509Certificate } = await import("node:crypto");
    const x509 = new X509Certificate(cert);
    expect(x509.subject).toBe("CN=Plannotator Inbox");
    expect(x509.issuer).toBe("CN=Plannotator Inbox");
    expect(x509.publicKey.asymmetricKeyDetails).toMatchObject({ namedCurve: "prime256v1" });

    const made = (await (await win("/api/inbox/pairing", { serverSession })).json()) as Json;
    expect(made.addresses).toEqual({ tailnet: null, lan: lan.address, fingerprint: lan.fingerprint });
    const link = new URL(made.link.replace("plannotator://", "https://pair.invalid/"));
    expect([...link.searchParams.keys()]).toEqual(["v", "name", "lan", "fp", "secret", "code"]);
    expect(link.searchParams.get("lan")).toBe(lan.address);
    expect(link.searchParams.get("fp")).toBe(lan.fingerprint);
    expect(made.link).toContain(`lan=${encodeURIComponent(lan.address)}&fp=${lan.fingerprint}&`);
  });

  test("7.2 over the LAN: the phone pins the certificate, redeems the QR secret, and reads with its token", async () => {
    const made = (await (await win("/api/inbox/pairing", { serverSession })).json()) as Json;
    const secret = new URL(made.link.replace("plannotator://", "https://pair.invalid/")).searchParams.get("secret");
    const paired = await phone("/api/inbox/device/pair", { body: { secret, name: "iPhone", platform: "ios" } });
    expect(paired.presented).toBe(lan.fingerprint);
    expect(paired.status).toBe(201);
    const body = JSON.parse(paired.text) as Json;
    expect(body.addresses).toEqual({ tailnet: null, lan: lan.address, fingerprint: lan.fingerprint });
    expect(body.device).toMatchObject({ name: "iPhone", platform: "ios", revoked_at: null });
    token = body.token;
    const again = await phone("/api/inbox/device/pair", { body: { secret, name: "iPhone", platform: "ios" } });
    expect([again.status, JSON.parse(again.text).code]).toEqual([410, "offer_expired"]);

    const health = await phone("/api/inbox/device/health", { headers: { Authorization: `Bearer ${token}` } });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ ok: true, app: "plannotator-inbox", serverSession });
    const threads = await phone("/api/inbox/device/threads", { headers: { Authorization: `Bearer ${token}` } });
    expect(threads.status).toBe(200);
    expect(JSON.parse(threads.text)).toHaveProperty("sections");
    // A command through the LAN keeps its idempotency key like any other path.
    const seen = await phone("/api/inbox/device/threads/msg_none/seen", { headers: { Authorization: `Bearer ${token}` }, body: { idempotency_key: "lan-1" } });
    const replay = await phone("/api/inbox/device/threads/msg_none/seen", { headers: { Authorization: `Bearer ${token}` }, body: { idempotency_key: "lan-1" } });
    expect(replay.status).toBe(seen.status);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });

  test("over the Wi-Fi, pairing is by the QR only: six digits are refused on the LAN listener (the offer stays open), the secret pairs, and the same digits still pair on the window's port", async () => {
    const made = (await (await win("/api/inbox/pairing", { serverSession })).json()) as Json;
    const digits = await phone("/api/inbox/device/pair", { body: { code: made.offer.code, name: "Typed", platform: "ios" } });
    expect([digits.status, JSON.parse(digits.text)]).toEqual([400, { error: "Over the Wi-Fi, pair by scanning the QR code on your computer's screen.", code: "code_not_accepted_here" }]);
    // Refused before the offer is read: no wrong try counted, the right code still works where digits are allowed.
    const onWindow = await fetch(`${base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "Typed on loopback", platform: "ios" }) });
    expect(onWindow.status).toBe(201);
    // The secret pairs over the LAN.
    const next = (await (await win("/api/inbox/pairing", { serverSession })).json()) as Json;
    const secret = new URL(next.link.replace("plannotator://", "https://pair.invalid/")).searchParams.get("secret");
    const wrongDigits = await phone("/api/inbox/device/pair", { body: { code: next.offer.code === "000000" ? "000001" : "000000", name: "Typed", platform: "ios" } });
    expect(JSON.parse(wrongDigits.text).code).toBe("code_not_accepted_here");
    const scanned = await phone("/api/inbox/device/pair", { body: { secret, name: "Scanned", platform: "ios" } });
    expect(scanned.status).toBe(201);
  });

  test("a wrong fingerprint is refused by the phone, before it sends a byte", async () => {
    const wrong = lan.fingerprint.replace(/^./, (c: string) => (c === "0" ? "1" : "0"));
    const made = (await (await win("/api/inbox/pairing", { serverSession })).json()) as Json;
    const secret = new URL(made.link.replace("plannotator://", "https://pair.invalid/")).searchParams.get("secret");
    const attempt = await phone("/api/inbox/device/pair", { fingerprint: wrong, body: { secret, name: "Impostor", platform: "ios" } }).catch((error) => error);
    expect(attempt).toBeInstanceOf(PinMismatchError);
    expect((attempt as PinMismatchError).presented).toBe(lan.fingerprint);
    // Nothing reached the Inbox: the offer is still open for the right phone.
    const right = await phone("/api/inbox/device/pair", { body: { secret, name: "iPhone 2", platform: "ios" } });
    expect(right.status).toBe(201);
  });

  test("the door review's spoofs: the window, /mcp, the bridge, control, settings, restart and pairing are absent on the LAN listener, whatever Host, Origin or encoded path", async () => {
    const windowPort = registry(w).port;
    const auth = { Authorization: `Bearer ${token}` };
    const hosts = ["localhost", "127.0.0.1", `127.0.0.1:${windowPort}`, `localhost:${windowPort}`, lan.address];
    const outside = [
      ["GET", "/"],
      ["GET", "/favicon.png"],
      ["GET", "/api/inbox/threads"],
      ["GET", "/api/inbox/health"],
      ["POST", "/mcp"],
      ["POST", "/api/inbox/bridge/poll"],
      ["POST", "/api/inbox/control/stop"],
      ["GET", "/api/inbox/settings"],
      ["POST", "/api/inbox/settings"],
      ["POST", "/api/inbox/restart"],
      ["POST", "/api/inbox/pairing"],
      ["GET", "/api/inbox/devices"],
      ["POST", "/api/inbox/tailnet"],
      ["POST", "/api/inbox/lan"],
      ["GET", "/api/inbox/attachments/att_x"],
      // Encoded and dotted paths that a lax router could resolve outside the door.
      ["GET", "/api/inbox/device/../threads"],
      ["GET", "/api/inbox/device/%2e%2e/threads"],
      ["GET", "/api/inbox/device/%2E%2E/%2E%2E/settings"],
      ["POST", "/api/inbox/device/./../../../mcp"],
      ["GET", "//api/inbox/threads"],
      ["GET", "/api/inbox/device%2fthreads"],
      ["GET", "/API/INBOX/DEVICE/threads"],
    ] as const;
    const seen: string[] = [];
    for (const host of hosts) {
      for (const [method, path] of outside) {
        for (const headers of [{ Host: host }, { Host: host, ...auth }, { Host: host, ...auth, "X-Forwarded-Host": "localhost" }]) {
          const answer = await phone(path, { method, headers, body: method === "POST" ? {} : undefined });
          seen.push(`${host} ${method} ${path} ${answer.status} ${JSON.parse(answer.text).code}`);
          expect([host, path, answer.status, JSON.parse(answer.text).code]).toEqual([host, path, 404, "device_route_not_found"]);
        }
      }
      // A door path that is not on the allowlist, with a valid token: the door's own 404.
      for (const path of ["/api/inbox/device/..%2fsettings", "/api/inbox/device/settings", "/api/inbox/device/restart", "/api/inbox/device/pairing", "/api/inbox/device/devices", "/api/inbox/device/bridge/poll"]) {
        const answer = await phone(path, { method: "POST", headers: { Host: host, ...auth }, body: { idempotency_key: "spoof" } });
        expect([path, answer.status, JSON.parse(answer.text).code]).toEqual([path, 404, "device_route_not_found"]);
      }
      // An encoded id on an allowed route reaches only that route's handler, which finds no such thread.
      const tricked = await phone("/api/inbox/device/threads/..%2f..%2fsettings", { headers: { Host: host, ...auth } });
      expect(tricked.status).toBe(404);
      expect(tricked.text).not.toContain("agent_tools");
      // A spoofed Origin (the window's own) is refused on the door itself.
      for (const origin of [`http://localhost:${windowPort}`, `http://127.0.0.1:${windowPort}`, "null"]) {
        const answer = await phone("/api/inbox/device/health", { headers: { Host: host, Origin: origin, ...auth } });
        expect([origin, answer.status, JSON.parse(answer.text).code]).toEqual([origin, 403, "origin_not_allowed"]);
      }
    }
    w.proof(seen.join("\n"));
    // Plain HTTP to the TLS port gets no answer from the door.
    const plain = await fetch(`http://${lan.address}/api/inbox/device/health`).then((r) => r.status, () => "refused");
    expect(plain).not.toBe(200);
  });

  test("an absolute-form request line and a WebSocket upgrade reach nothing outside the door on the LAN listener", async () => {
    const windowPort = registry(w).port;
    const auth = { Authorization: `Bearer ${token}` };
    // Absolute-form (as a proxy would send it), naming the window's own origin.
    for (const target of [`http://127.0.0.1:${windowPort}/api/inbox/threads`, `http://localhost:${windowPort}/mcp`, `https://${lan.address}/api/inbox/settings`, `http://localhost:${windowPort}/api/inbox/device/../threads`]) {
      for (const method of ["GET", "POST"]) {
        const answer = await phone(target, { method, headers: auth, body: method === "POST" ? {} : undefined });
        expect([method, target, answer.status, JSON.parse(answer.text).code]).toEqual([method, target, 404, "device_route_not_found"]);
      }
    }
    // A WebSocket upgrade: the LAN listener never upgrades; outside the door, and on a door path off the allowlist, it is a 404.
    const upgrade = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "AAAAAAAAAAAAAAAAAAAAAA==" };
    for (const path of ["/", "/mcp", "/api/inbox/threads", "/api/inbox/events", "/api/inbox/device/socket", "/api/inbox/device/bridge/poll"]) {
      const answer = await phone(path, { headers: { ...upgrade, ...auth } });
      expect([path, answer.status, JSON.parse(answer.text).code]).toEqual([path, 404, "device_route_not_found"]);
      expect(answer.headers.upgrade).toBeUndefined();
    }
  });

  test.skipIf(!canBrowse)("the Bonjour record: _plannotator-inbox._tcp under the computer's name, with the listener's port and fp", async () => {
    const lookup = await bonjourLookup(computerName);
    expect(lookup).toContain(`:${lan.address.split(":")[1]} `);
    expect(lookup).toContain(`fp=${lan.fingerprint}`);
    expect(lookup).toContain("v=1");
    expect(await bonjourBrowse()).toContain(computerName);
  }, 15_000);

  test("off: the listener and the record go, inbox.json keeps the port with the switch off; on again opens the same port with the same certificate", async () => {
    const before = lan;
    const port = Number(before.address.split(":")[1]);
    const off = await setLan(false);
    expect(off).toEqual({ on: false, address: null, fingerprint: null, bonjour: false, error: null });
    expect(await pinnedRequest(before.address, before.fingerprint, { path: "/api/inbox/device/health" }).then(() => "answered", () => "closed")).toBe("closed");
    expect((registry(w) as Json).lan).toEqual({ port, on: false });
    if (canBrowse) {
      await Bun.sleep(500);
      expect(await bonjourBrowse()).not.toContain(computerName);
    }
    // A start with the switch off opens nothing.
    process.kill(registry(w).pid, "SIGTERM");
    await Bun.sleep(500);
    await restart();
    expect(((await (await win("/api/inbox/lan")).json()) as Json).lan).toEqual({ on: false, address: null, fingerprint: null, bonjour: false, error: null });
    // The certificate and the port stay: on again, the same address and fingerprint, so a paired phone's pin and a written-down address still hold.
    lan = await setLan(true);
    expect(lan.fingerprint).toBe(before.fingerprint);
    expect(lan.address).toBe(before.address);
    expect((registry(w) as Json).lan).toEqual({ port, on: true });
  }, 15_000);

  test("a clean stop takes the listener and the record down; the next start opens the same port with the same certificate", async () => {
    const before = lan;
    process.kill(registry(w).pid, "SIGTERM");
    await Bun.sleep(500);
    expect(await pinnedRequest(before.address, before.fingerprint, { path: "/api/inbox/device/health" }).then(() => "answered", () => "closed")).toBe("closed");
    expect((registry(w) as Json).lan).toEqual({ port: Number(before.address.split(":")[1]), on: true });
    if (canBrowse) expect(await bonjourBrowse()).not.toContain(computerName);

    await restart();
    lan = ((await (await win("/api/inbox/lan")).json()) as Json).lan;
    expect(lan).toMatchObject({ on: true, address: before.address, fingerprint: before.fingerprint, error: null });
    const health = await phone("/api/inbox/device/health", { headers: { Authorization: `Bearer ${token}` } });
    expect(health.status).toBe(200);
    if (canBrowse) expect(await bonjourBrowse()).toContain(computerName);
  }, 30_000);

  test.skipIf(!canBrowse)("a kill -9 leaves no record behind: the publisher ends with the Inbox", async () => {
    process.kill(registry(w).pid, "SIGKILL");
    await Bun.sleep(1000);
    expect(await bonjourBrowse()).not.toContain(computerName);
    await restart();
    expect(((await (await win("/api/inbox/lan")).json()) as Json).lan).toMatchObject({ on: true, address: lan.address });
  }, 30_000);
});

describe("Reach from this Wi-Fi, in process", () => {
  test("openssl missing or failing: 409 lan_unavailable, the switch stays off, nothing is left in inbox/tls", async () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-inbox-lan-noopenssl-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "openssl"), "#!/bin/sh\necho 'openssl: broken' >&2\nexit 1\n");
    chmodSync(join(bin, "openssl"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    const inbox = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, phones: true });
    try {
      const main = `http://127.0.0.1:${inbox.port}`;
      const on = await fetch(`${main}/api/inbox/lan`, { method: "POST", body: JSON.stringify({ on: true }) });
      expect(on.status).toBe(409);
      expect(((await on.json()) as Json).code).toBe("lan_unavailable");
      expect(((await (await fetch(`${main}/api/inbox/lan`)).json()) as Json).lan).toMatchObject({ on: false, address: null });
      expect(existsSync(join(root, "data", "inbox", "tls"))).toBe(false);
      expect(JSON.parse(readFileSync(join(root, "data", "inbox", "inbox.json"), "utf8"))).not.toHaveProperty("lan");
      const bad = await fetch(`${main}/api/inbox/lan`, { method: "POST", body: JSON.stringify({ on: "yes" }) });
      expect(bad.status).toBe(422);
    } finally {
      process.env.PATH = path;
      inbox.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a listener that cannot open at start shows the switch on with the reason, and turning it off works", async () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-inbox-lan-startfail-"));
    const dataDir = join(root, "data");
    const first = await startInboxServer({ dataDir, binaryPath: null, phones: true });
    const on = await fetch(`http://127.0.0.1:${first.port}/api/inbox/lan`, { method: "POST", body: JSON.stringify({ on: true }) });
    const port = Number((((await on.json()) as Json).lan.address ?? ":0").split(":")[1]);
    first.stop();
    // The certificate is gone and openssl fails: the next start cannot open the listener.
    rmSync(join(dataDir, "inbox", "tls"), { recursive: true, force: true });
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "openssl"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "openssl"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    const inbox = await startInboxServer({ dataDir, binaryPath: null, phones: true });
    try {
      const main = `http://127.0.0.1:${inbox.port}`;
      const state = ((await (await fetch(`${main}/api/inbox/lan`)).json()) as Json).lan;
      expect(state).toMatchObject({ on: true, address: null, fingerprint: null, bonjour: false });
      expect(state.error).toContain("could not make its certificate");
      const off = await fetch(`${main}/api/inbox/lan`, { method: "POST", body: JSON.stringify({ on: false }) });
      expect(off.status).toBe(200);
      expect(((await off.json()) as Json).lan).toEqual({ on: false, address: null, fingerprint: null, bonjour: false, error: null });
      expect(JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).lan).toEqual({ port, on: false });
    } finally {
      process.env.PATH = path;
      inbox.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the switch's route keeps the window's guards: a foreign page and a stale tab are refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-inbox-lan-guards-"));
    const inbox = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, phones: true });
    try {
      const main = `http://127.0.0.1:${inbox.port}`;
      const foreign = await fetch(`${main}/api/inbox/lan`, { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ on: true }) });
      expect(foreign.status).toBe(403);
      const stale = await fetch(`${main}/api/inbox/lan`, { method: "POST", body: JSON.stringify({ on: true, serverSession: "0".repeat(32) }) });
      expect(stale.status).toBe(409);
      expect(existsSync(join(root, "data", "inbox", "tls"))).toBe(false);
    } finally {
      inbox.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

