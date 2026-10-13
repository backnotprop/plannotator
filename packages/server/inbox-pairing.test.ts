/**
 * Pair a phone, step by step (design of record
 * `.product/approved/inbox-settings-tabs/`, sections 4.1 and 4.2): the two
 * read routes the window's flow uses, against a real Inbox in process.
 *
 *  - `GET /api/inbox/pairing/checks`: what this computer can tell about the
 *    Wi-Fi and Tailscale ways, read through the probe and runner seams (no
 *    test runs the real `tailscale`, `openssl` or system tools). It turns
 *    nothing on, makes no certificate and publishes nothing.
 *  - `GET /api/inbox/pairing`: the last offer's state and what reached the
 *    door while it showed (wrong digits, digits over the Wi-Fi, an older
 *    code, a phone after expiry, the pairing itself), never its secret or
 *    code.
 *
 * Both answer only this computer's own page: through the tailnet they are
 * `local_only`, and another site's read is `cross_origin`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxDevices } from "./inbox-devices";
import { parseFirewallState, parseIpconfigSsid, parseTailscaleBackend, runQuietly, type PairingProbes } from "./inbox-pairing-checks";
import { resetServedHostnamesForTests } from "./request-host-guard";

type Json = Record<string, any>;

const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "ramos@example.com";

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetServedHostnamesForTests();
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** A temp data dir that loadConfig() reads too. */
function world(config: Json = {}): string {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pairing-")));
  roots.push(dataDir);
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  return dataDir;
}

/** The probes as a computer on "Ramos Home" with everything in place; a test overrides what it needs. */
function probes(overrides: Partial<PairingProbes> = {}): Partial<PairingProbes> & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    lanAddress: () => (calls.push("lanAddress"), "192.168.1.42"),
    network: (address) => (calls.push(`network:${address}`), "Ramos Home"),
    which: (command) => (calls.push(`which:${command}`), `/usr/bin/${command}`),
    firewall: () => (calls.push("firewall"), "off"),
    ...overrides,
  };
}

/** Tailscale as a scripted CLI: its backend state, who owns this machine, HTTPS certificates, and serve's mappings. */
function fakeTailscale(state: { backend?: string; missing?: boolean; certs?: boolean; stderr?: string; timeout?: boolean } = {}) {
  const serve = new Map<number, string>();
  const calls: string[][] = [];
  const run: TailscaleRunner = (args) => {
    calls.push(args);
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (state.missing) return { error: Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" }), status: null, stdout: "", stderr: "" };
    if (state.timeout) return { error: Object.assign(new Error("tailscale did not answer in time"), { code: "ETIMEDOUT" }), status: null, stdout: "", stderr: "" };
    if (args[0] === "status") {
      if (state.stderr) return { status: 1, stdout: "", stderr: state.stderr };
      return ok(
        JSON.stringify({
          BackendState: state.backend ?? "Running",
          Self: { DNSName: `${MAGIC}.`, UserID: 42 },
          User: { "42": { ID: 42, LoginName: OWNER } },
          CertDomains: state.certs === false ? null : [MAGIC],
        }),
      );
    }
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
  return { run, serve, calls, state };
}

async function start(dataDir: string, run: TailscaleRunner, extra: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: true, tailscale: run, ...extra });
  servers.push(server);
  return server;
}

const get = async (inbox: InboxServer, path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`http://127.0.0.1:${inbox.port}${path}`, { headers });
  return { status: response.status, body: (await response.json()) as Json };
};
const post = async (inbox: InboxServer, path: string, body: unknown = {}) => {
  const response = await fetch(`http://127.0.0.1:${inbox.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as Json };
};
const redeem = (inbox: InboxServer, body: Json) =>
  fetch(`http://127.0.0.1:${inbox.port}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("the checks' parsers", () => {
  test("the macOS firewall: off, on (macOS asks per app), blocking everything, or unknown", () => {
    expect(parseFirewallState("Firewall is disabled. (State = 0)", "")).toBe("off");
    expect(parseFirewallState("Firewall is enabled. (State = 1)", "Firewall has block all state set to disabled.")).toBe("on");
    expect(parseFirewallState("Firewall is enabled. (State = 1)", "Block all DISABLED!")).toBe("on");
    expect(parseFirewallState("Firewall is enabled. (State = 1)", "Firewall has block all state set to enabled.")).toBe("block_all");
    expect(parseFirewallState("Firewall is blocking all non-essential incoming connections. (State = 2)", "")).toBe("block_all");
    expect(parseFirewallState("something else", "")).toBe("unknown");
  });

  test("the Wi-Fi name from ipconfig: the SSID line, never a redacted one", () => {
    expect(parseIpconfigSsid("<dictionary> {\n  InterfaceType : WiFi\n  SSID : Ramos Home\n  Security : WPA2\n}")).toBe("Ramos Home");
    expect(parseIpconfigSsid("  SSID : <redacted>\n")).toBeNull();
    expect(parseIpconfigSsid("<dictionary> {\n  InterfaceType : Ethernet\n}")).toBeNull();
  });

  test("tailscale status: the backend state, the owner's login and HTTPS certificates", () => {
    const status = (backend: string, extra: Json = {}) => JSON.stringify({ BackendState: backend, Self: { UserID: 1 }, User: { "1": { LoginName: OWNER } }, ...extra });
    expect(parseTailscaleBackend(status("Running", { CertDomains: [MAGIC] }))).toEqual({ state: "running", login: OWNER, https_certs: true });
    expect(parseTailscaleBackend(status("Running", { CertDomains: null }))).toEqual({ state: "running", login: OWNER, https_certs: false });
    expect(parseTailscaleBackend(status("NeedsLogin"))).toEqual({ state: "signed_out", login: null, https_certs: null });
    expect(parseTailscaleBackend(status("Stopped"))).toEqual({ state: "stopped", login: null, https_certs: null });
    expect(parseTailscaleBackend(status("NeedsMachineAuth"))).toEqual({ state: "needs_approval", login: null, https_certs: null });
    expect(parseTailscaleBackend("not json")).toEqual({ state: "unknown", login: null, https_certs: null });
  });
});

describe("GET /api/inbox/pairing/checks", () => {
  test("a computer where both ways can work: the Wi-Fi address and name, openssl, Bonjour, the firewall, Tailscale running with HTTPS and 8443 free; nothing is turned on or made", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const p = probes();
    const inbox = await start(dataDir, ts.run, { pairingProbes: p });
    const { status, body } = await get(inbox, "/api/inbox/pairing/checks");
    expect(status).toBe(200);
    expect(body.checks).toEqual({
      wifi: { address: "192.168.1.42", network: "Ramos Home", openssl: true, certificate: false, bonjour: true, firewall: "off" },
      tailscale: { state: "running", login: OWNER, https_certs: true, port_free: true, error: null },
    });
    expect(body.lan).toMatchObject({ on: false, address: null });
    expect(body.tailnet).toEqual({ on: false, address: null, error: null });
    // Read only: no serve on or off ran, no certificate was made, no listener opened.
    // `--peers=false`: the tailnet's other devices are never read.
    expect(ts.calls.map((args) => args.join(" ")).sort()).toEqual(["serve status --json", "status --json --peers=false"]);
    expect(existsSync(join(dataDir, "inbox", "tls"))).toBe(false);
    expect(p.calls).toContain(`network:192.168.1.42`);
  });

  test("each failure is reported, never turned into a refusal: no network, no openssl, the firewall blocking everything, Tailscale missing, stopped, signed out, without HTTPS, 8443 held by someone else", async () => {
    const dataDir = world();
    const ts = fakeTailscale({ missing: true });
    const inbox = await start(dataDir, ts.run, {
      pairingProbes: probes({ lanAddress: () => null, which: () => null, firewall: () => "block_all" }),
    });
    const read = async () => (await get(inbox, "/api/inbox/pairing/checks?fresh=1")).body.checks;
    const missing = await read();
    expect(missing.wifi).toEqual({ address: null, network: null, openssl: false, certificate: false, bonjour: false, firewall: "block_all" });
    // No `tailscale` command on PATH (the Mac App Store app has none until its CLI is turned on): not "not installed".
    expect(missing.tailscale).toEqual({ state: "cli_missing", login: null, https_certs: null, port_free: null, error: null });

    ts.state.missing = false;
    ts.state.timeout = true;
    expect((await read()).tailscale).toMatchObject({ state: "no_answer", error: null });
    ts.state.timeout = false;
    ts.state.stderr = "failed to connect to local tailscaled; it doesn't appear to be running";
    expect((await read()).tailscale.state).toBe("stopped");
    ts.state.stderr = undefined;
    ts.state.backend = "NeedsLogin";
    expect((await read()).tailscale).toMatchObject({ state: "signed_out", port_free: null });
    ts.state.backend = "Running";
    ts.state.certs = false;
    expect((await read()).tailscale).toMatchObject({ state: "running", https_certs: false, port_free: true });
    ts.state.certs = true;
    ts.serve.set(8443, "http://127.0.0.1:9999");
    expect((await read()).tailscale.port_free).toBe(false);
  });

  test("one read in flight is shared and kept a few seconds; fresh skips a kept answer; a slow tailscale never holds the Inbox", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    let release = () => {};
    const gate = new Promise<void>((done) => (release = done));
    let statusRuns = 0;
    // An asynchronous runner that answers only when released: what a slow `tailscale` looks like to the Inbox.
    const slow = async (args: string[], timeout: number) => {
      if (args[0] === "status") statusRuns += 1;
      await gate;
      return ts.run(args, timeout);
    };
    // An Inbox in this process: its health answering while the checks wait shows the event loop is free.
    const inbox = await start(dataDir, ts.run, { pairingProbes: probes() });
    const devices = createInboxDevices({
      dataDir,
      serverSession: "ses_test",
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "http://localhost:1/", version: "dev", token: "t", serverSession: "ses_test", startedAt: new Date().toISOString() }),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      dispatch: async () => new Response("{}"),
      tailscale: ts.run,
      checksTailscale: slow,
      probes: probes(),
    });
    const route = (path: string) => devices.windowRoute(new Request(`http://127.0.0.1:1${path}`), new URL(`http://127.0.0.1:1${path}`));
    const first = route("/api/inbox/pairing/checks");
    const second = route("/api/inbox/pairing/checks?fresh=1");
    // While both wait on tailscale, the Inbox still answers.
    const started = performance.now();
    expect((await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/health`)).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1000);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect((await a!.json()).checks.tailscale.state).toBe("running");
    expect((await b!.json()).checks.tailscale.state).toBe("running");
    expect(statusRuns).toBe(1);
    // Kept: a plain read inside the window runs nothing; fresh reads again.
    await route("/api/inbox/pairing/checks");
    expect(statusRuns).toBe(1);
    await route("/api/inbox/pairing/checks?fresh=1");
    expect(statusRuns).toBe(2);
    devices.stopTailnet();
    devices.stopLan();
  });

  test("runQuietly: a command not on PATH is ENOENT and one past its time limit is ETIMEDOUT, without blocking", async () => {
    const missing = await runQuietly("plannotator-no-such-command-xyz", [], 1000);
    expect((missing.error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    const started = performance.now();
    const slow = await runQuietly("sleep", ["5"], 200);
    expect((slow.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("runQuietly holds its limit through a shell wrapper whose child keeps the pipes (the Mac app's tailscale), and leaves no orphan", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-pairing-wrapper-")));
    roots.push(dir);
    const wrapper = join(dir, "tailscale");
    const pidFile = join(dir, "child.pid");
    // Runs its program as a child, without exec, as /usr/local/bin/tailscale does: the child keeps stdout open.
    writeFileSync(wrapper, `#!/bin/sh\nsleep 6 &\necho $! > '${pidFile}'\nwait\n`);
    chmodSync(wrapper, 0o755);
    const started = performance.now();
    const result = await runQuietly(wrapper, ["status"], 500);
    const took = performance.now() - started;
    expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    expect(took).toBeLessThan(2000);
    const child = Number(readFileSync(pidFile, "utf8").trim());
    expect(child).toBeGreaterThan(0);
    // The whole process group was killed: the grandchild is gone too.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(child, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  test("a read that never answers ends at the deadline as not answering, and never stays the shared read", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    let statusRuns = 0;
    const hung = (args: string[]) => {
      if (args[0] === "status") statusRuns += 1;
      return new Promise<never>(() => {});
    };
    const devices = createInboxDevices({
      dataDir,
      serverSession: "ses_test",
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "http://localhost:1/", version: "dev", token: "t", serverSession: "ses_test", startedAt: new Date().toISOString() }),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      dispatch: async () => new Response("{}"),
      tailscale: ts.run,
      checksTailscale: hung,
      checksDeadlineMs: 300,
      probes: probes({ network: () => new Promise<never>(() => {}) }),
    });
    const route = (path: string) => devices.windowRoute(new Request(`http://127.0.0.1:1${path}`), new URL(`http://127.0.0.1:1${path}`));
    const started = performance.now();
    const answer = (await (await route("/api/inbox/pairing/checks"))!.json()).checks;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(answer.tailscale.state).toBe("no_answer");
    expect(answer.wifi.network).toBeNull();
    // Check again starts a new read: the one that never answered is not joined.
    const again = (await (await route("/api/inbox/pairing/checks?fresh=1"))!.json()).checks;
    expect(again.tailscale.state).toBe("no_answer");
    expect(statusRuns).toBe(2);
    devices.stopTailnet();
    devices.stopLan();
  });

  test("the Inbox's own mapping on 8443 counts as free, and the switches' state comes along", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run, { pairingProbes: probes() });
    expect((await post(inbox, "/api/inbox/tailnet", { on: true })).status).toBe(200);
    const { body } = await get(inbox, "/api/inbox/pairing/checks");
    expect(body.checks.tailscale.port_free).toBe(true);
    expect(body.tailnet).toEqual({ on: true, address: `${MAGIC}:8443`, error: null });
  });
});

describe("GET /api/inbox/pairing: what reached the door while the code showed", () => {
  test("none before an offer; the offer is `reachable` only with an address a phone can use", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run, { pairingProbes: probes() });
    expect((await get(inbox, "/api/inbox/pairing")).body).toEqual({ offer: null });
    const bare = await post(inbox, "/api/inbox/pairing");
    expect(bare.status).toBe(201);
    expect(bare.body.reachable).toBe(false);
    expect((await post(inbox, "/api/inbox/tailnet", { on: true })).status).toBe(200);
    const made = await post(inbox, "/api/inbox/pairing");
    expect(made.body.reachable).toBe(true);
    expect(made.body.addresses.tailnet).toBe(`${MAGIC}:8443`);
    const view = (await get(inbox, "/api/inbox/pairing")).body.offer;
    expect(view).toEqual({ expires_at: made.body.offer.expires_at, state: "open", tries_left: 5, attempts: [] });
    // Never the secret or the code.
    expect(JSON.stringify(view)).not.toContain(made.body.offer.code);
  });

  test("wrong digits, an older code, then the pairing, each with where it came from; a later phone after it closed", async () => {
    const dataDir = world();
    const inbox = await start(dataDir, fakeTailscale().run, { pairingProbes: probes() });
    const old = (await post(inbox, "/api/inbox/pairing")).body;
    const current = (await post(inbox, "/api/inbox/pairing")).body;
    const wrong = current.offer.code === "000000" ? "000001" : "000000";
    expect((await redeem(inbox, { code: wrong, name: "iPhone", platform: "ios" })).status).toBe(401);
    const oldSecret = new URL(old.link.replace("plannotator://", "https://x/")).searchParams.get("secret");
    expect((await redeem(inbox, { secret: oldSecret, name: "iPhone", platform: "ios" })).status).toBe(410);
    let view = (await get(inbox, "/api/inbox/pairing")).body.offer;
    expect(view.state).toBe("open");
    expect(view.tries_left).toBe(4);
    expect(view.attempts.map((a: Json) => [a.via, a.result, a.tries_left])).toEqual([
      ["local", "wrong_code", 4],
      ["local", "old_code", undefined],
    ]);
    expect((await redeem(inbox, { code: current.offer.code, name: "Michael's iPhone", platform: "ios" })).status).toBe(201);
    expect((await redeem(inbox, { code: current.offer.code, name: "iPhone", platform: "ios" })).status).toBe(410);
    view = (await get(inbox, "/api/inbox/pairing")).body.offer;
    expect(view.state).toBe("redeemed");
    expect(view.attempts.map((a: Json) => [a.result, a.device])).toEqual([
      ["wrong_code", undefined],
      ["old_code", undefined],
      ["redeemed", "Michael's iPhone"],
      ["expired", undefined],
    ]);
  });

  test("the code expires with nothing seen: state expired and no attempts, so the window shows the troubleshooting list", async () => {
    const dataDir = world();
    let clock = Date.parse("2026-10-12T10:00:00.000Z");
    const inbox = await start(dataDir, fakeTailscale().run, { pairingProbes: probes(), now: () => new Date(clock) });
    await post(inbox, "/api/inbox/pairing");
    clock += 10 * 60_000;
    expect((await get(inbox, "/api/inbox/pairing")).body.offer).toMatchObject({ state: "expired", attempts: [] });
  });

  test("five wrong codes close it: state closed", async () => {
    const dataDir = world();
    const inbox = await start(dataDir, fakeTailscale().run, { pairingProbes: probes() });
    const made = (await post(inbox, "/api/inbox/pairing")).body;
    const wrong = made.offer.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) await redeem(inbox, { code: wrong, name: "iPhone", platform: "ios" });
    expect((await get(inbox, "/api/inbox/pairing")).body.offer).toMatchObject({ state: "closed", tries_left: 0 });
  });

  test("digits typed at the Wi-Fi's listener are seen as such (it pairs by the QR only), and the tailnet listener's wrong digits name the tailnet", async () => {
    const dataDir = world();
    const devices = createInboxDevices({
      dataDir,
      serverSession: "ses_test",
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "http://localhost:1/", version: "dev", token: "t", serverSession: "ses_test", startedAt: new Date().toISOString() }),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      dispatch: async () => new Response("{}"),
      tailscale: fakeTailscale().run,
    });
    const made = (await (await devices.windowRoute(new Request("http://127.0.0.1:1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1:1/api/inbox/pairing")))!.json()) as Json;
    const pair = (via: "wifi" | "tailnet", code: string) => {
      const url = new URL("http://127.0.0.1:1/api/inbox/device/pair");
      return devices.door(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "iPhone", platform: "ios" }) }), url, via);
    };
    expect((await pair("wifi", made.offer.code)).status).toBe(400);
    expect((await pair("tailnet", made.offer.code === "000000" ? "000001" : "000000")).status).toBe(401);
    const view = (await (await devices.windowRoute(new Request("http://127.0.0.1:1/api/inbox/pairing"), new URL("http://127.0.0.1:1/api/inbox/pairing")))!.json()) as Json;
    expect(view.offer.attempts.map((a: Json) => [a.via, a.result])).toEqual([
      ["wifi", "code_over_wifi"],
      ["tailnet", "wrong_code"],
    ]);
    devices.stopTailnet();
    devices.stopLan();
  });
});

describe("only this computer's own page reads them", () => {
  test("another site's read is cross_origin; the window's own page and a client with no Origin are served", async () => {
    const dataDir = world();
    const inbox = await start(dataDir, fakeTailscale().run, { pairingProbes: probes() });
    for (const path of ["/api/inbox/pairing", "/api/inbox/pairing/checks"]) {
      expect((await get(inbox, path, { "Sec-Fetch-Site": "cross-site" })).body.code).toBe("cross_origin");
      expect((await get(inbox, path, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await get(inbox, path, { Origin: `http://127.0.0.1:${inbox.port}`, "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
      expect((await get(inbox, path)).status).toBe(200);
    }
  });

  test("through the tailnet both are local_only, even for the owner", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run, { pairingProbes: probes(), publishTailnet: true });
    const listener = inbox.tailscale.listenerPort();
    expect(listener).not.toBeNull();
    for (const path of ["/api/inbox/pairing", "/api/inbox/pairing/checks"]) {
      const response = await fetch(`http://127.0.0.1:${listener}${path}`, { headers: { Host: `${MAGIC}:${inbox.port}`, "Tailscale-User-Login": OWNER } });
      expect([path, response.status, ((await response.json()) as Json).code]).toEqual([path, 403, "local_only"]);
    }
  });
});
