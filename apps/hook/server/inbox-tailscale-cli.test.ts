/**
 * `plannotator inbox --tailscale` and PLANNOTATOR_INBOX_TAILSCALE as
 * processes: the real CLI (the compiled binary when
 * PLANNOTATOR_INBOX_TEST_BINARY names one) in a temp world, with a fake
 * `tailscale` on PATH that keeps its serve config in a file and logs every
 * call, the way the phones gate and the review --tailscale tests fake it. A
 * request "through serve" goes to the loopback port the mapping points at,
 * with the Host and `Tailscale-User-Login` serve would send. The real
 * `tailscale` never runs and ~/.plannotator is never touched.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPidAlive } from "@plannotator/shared/inbox/registry";
import { createInboxWorld, destroyInboxWorld, registry, removeStubbedHtml, signalInbox, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";

type Json = Record<string, any>;

const MAGIC = "studio.tail0000.ts.net";
const OWNER = "owner@example.com";

/** The fake CLI: `status --json`, `serve status --json`, `serve --bg --https=P <target>`, `serve --https=P off`. */
const FAKE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [state, log] = process.argv.slice(2, 4);
const args = process.argv.slice(4);
appendFileSync(log, args.join(" ") + "\\n");
const serve = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
const out = (text) => { process.stdout.write(text); process.exit(0); };
if (args.includes("funnel")) { process.stderr.write("never funnel\\n"); process.exit(9); }
if (args[0] === "status") out(JSON.stringify({ Self: { DNSName: "${MAGIC}.", UserID: 1 }, User: { "1": { LoginName: "${OWNER}" } } }));
if (args[0] === "serve" && args[1] === "status") {
  const ports = Object.keys(serve);
  if (ports.length === 0) out("{}");
  out(JSON.stringify({
    TCP: Object.fromEntries(ports.map((p) => [p, { HTTPS: true }])),
    Web: Object.fromEntries(ports.map((p) => ["${MAGIC}:" + p, { Handlers: { "/": { Proxy: serve[p] } } }])),
  }));
}
const port = /--https=(\\d+)/.exec(args.join(" "))?.[1];
if (args[0] === "serve" && port && args.includes("off")) { delete serve[port]; writeFileSync(state, JSON.stringify(serve)); out(""); }
if (args[0] === "serve" && port && args.includes("--bg")) {
  serve[port] = args.at(-1);
  writeFileSync(state, JSON.stringify(serve));
  out("Available within your tailnet:\\n\\nhttps://${MAGIC}:" + port + "/\\n|-- proxy " + args.at(-1) + "\\n");
}
process.stderr.write("unexpected: " + args.join(" ") + "\\n");
process.exit(2);
`;

describe("plannotator inbox --tailscale (processes, a fake tailscale on PATH)", () => {
  let w: InboxWorld;
  let stubs: string[] = [];
  let state = "";
  let log = "";

  const mappings = (): Record<string, string> => (existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {});
  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", ...args], { env: { ...process.env, ...worldEnv(w), ...env }, cwd: w.root });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const throughServe = (path: string, init: { method?: string; login?: string | null; headers?: Record<string, string>; body?: string } = {}) => {
    const { port } = registry(w);
    const target = mappings()[String(port)];
    if (!target) throw new Error("no mapping");
    const headers: Record<string, string> = { Host: `${MAGIC}:${port}`, ...(init.headers ?? {}) };
    const login = init.login === undefined ? OWNER : init.login;
    if (login !== null) headers["Tailscale-User-Login"] = login;
    return fetch(`${target}${path}`, { method: init.method ?? "GET", headers, body: init.body });
  };
  const codeOf = async (response: Response) => [response.status, ((await response.json()) as Json).code];
  const stop = async (signal: "SIGTERM" | "route") => {
    const entry = registry(w);
    if (signal === "SIGTERM") await signalInbox(w, "SIGTERM");
    else await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/stop`, { method: "POST", headers: { Authorization: `Bearer ${entry.token}` } });
    await waitFor("the Inbox to exit", () => !isPidAlive(entry.pid));
  };

  beforeAll(() => {
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-inbox-tailscale-cli-", "tailscale-cli", "tailscale-cli");
    state = join(w.root, "serve.json");
    log = join(w.root, "tailscale-calls.txt");
    writeFileSync(join(w.root, "fake-tailscale.mjs"), FAKE);
    writeFileSync(join(w.bin, "tailscale"), `#!/bin/sh\nexec '${process.execPath}' '${join(w.root, "fake-tailscale.mjs")}' '${state}' '${log}' "$@"\n`);
    chmodSync(join(w.bin, "tailscale"), 0o755);
  });

  afterAll(async () => {
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
  });

  test("PLANNOTATOR_INBOX_TAILSCALE=1: an agent's --background start publishes; only the owner gets in; the connection surface stays local; SIGTERM takes the mapping down", async () => {
    const started = run(["--background"], { PLANNOTATOR_INBOX_TAILSCALE: "1" });
    expect(started.code).toBe(0);
    const entry = registry(w);
    // Stdout stays the local URL alone; the tailnet goes to stderr.
    expect(started.stdout).toBe(`${entry.url}\n`);
    expect(started.stderr).toContain(`Over your tailnet: https://${MAGIC}:${entry.port}/`);

    const target = mappings()[String(entry.port)]!;
    expect(target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(target).not.toBe(`http://127.0.0.1:${entry.port}`);
    expect(readFileSync(log, "utf8")).not.toContain("funnel");

    expect((await throughServe("/api/inbox/threads")).status).toBe(200);
    expect(await codeOf(await throughServe("/api/inbox/threads", { login: "guest@example.com" }))).toEqual([403, "tailnet_identity_refused"]);
    expect(await codeOf(await throughServe("/api/inbox/threads", { login: null }))).toEqual([403, "tailnet_identity_required"]);
    const bearer = { Authorization: `Bearer ${entry.token}`, "Content-Type": "application/json" };
    for (const path of ["/mcp", "/api/inbox/bridge/poll", "/api/inbox/control/stop"]) {
      expect([path, ...(await codeOf(await throughServe(path, { method: "POST", headers: { ...bearer, Host: `127.0.0.1:${entry.port}` }, body: "{}" })))]).toEqual([path, 403, "forbidden_host"]);
      expect([path, ...(await codeOf(await throughServe(path, { method: "POST", headers: bearer, body: "{}" })))]).toEqual([path, 403, "local_only"]);
    }
    // Loopback is unchanged.
    expect((await fetch(`http://127.0.0.1:${entry.port}/api/inbox/threads`)).status).toBe(200);

    await stop("SIGTERM");
    expect(mappings()).toEqual({});
  });

  test("--tailscale against a running Inbox asks it to publish for this run; the stop route (uninstall --purge) takes the mapping down", async () => {
    const started = run(["--background"]);
    expect(started.code).toBe(0);
    expect(mappings()).toEqual({});
    const before = registry(w);

    const asked = run(["--background", "--tailscale"]);
    expect(asked.code).toBe(0);
    expect(asked.stdout).toBe(`${before.url}\n`);
    expect(asked.stderr).toContain(`Over your tailnet: https://${MAGIC}:${before.port}/ (only ${OWNER})`);
    expect(asked.stderr).toContain("Published for this run");
    // The same Inbox, not a second one.
    expect(registry(w).pid).toBe(before.pid);
    expect((await throughServe("/api/inbox/threads")).status).toBe(200);
    // config.json was not changed by the flag.
    const config = join(w.dataDir, "config.json");
    expect(existsSync(config) ? JSON.parse(readFileSync(config, "utf8")).inboxTailscale : undefined).toBeUndefined();

    await stop("route");
    expect(mappings()).toEqual({});
  });

  /** The window's Restart on the owner's phone: POST through serve, then what its reconnect loop asks until a new run answers. */
  const restartFromPhone = async () => {
    const before = registry(w);
    const page = (await (await throughServe("/api/inbox/health")).json()) as Json;
    const target = mappings()[String(before.port)];
    const asked = await throughServe("/api/inbox/restart", {
      method: "POST",
      headers: { Origin: `https://${MAGIC}:${before.port}`, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: page.serverSession }),
    });
    expect(asked.status).toBe(200);
    await waitFor("the next Inbox to publish", () => {
      const next = mappings()[String(before.port)];
      return next !== undefined && next !== target;
    });
    const answer = await throughServe("/api/inbox/health");
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as Json).serverSession).not.toBe(page.serverSession);
    expect(registry(w).port).toBe(before.port);
    await waitFor("the old run to exit", () => !isPidAlive(before.pid));
    expect(readFileSync(log, "utf8")).not.toContain("funnel");
  };

  test("the switch on: Restart from the owner's phone comes back on the same address, and so does a phone's door on 8443", async () => {
    const config = join(w.dataDir, "config.json");
    writeFileSync(config, JSON.stringify({ inboxTailscale: true }));
    const phones = { PLANNOTATOR_INBOX_PHONES: "1" };
    expect(run(["--background"], phones).code).toBe(0);
    const entry = registry(w);
    expect((await fetch(`http://127.0.0.1:${entry.port}/api/inbox/tailnet`, { method: "POST", body: JSON.stringify({ on: true }) })).status).toBe(200);
    expect(mappings()["8443"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const local = (path: string, body: Json) => fetch(`http://127.0.0.1:${entry.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const offer = (await (await local("/api/inbox/pairing", {})).json()) as Json;
    const paired = (await (await local("/api/inbox/device/pair", { code: offer.offer.code, name: "iPhone", platform: "ios" })).json()) as Json;

    await restartFromPhone();

    await waitFor("the door to publish again", () => mappings()["8443"] !== undefined);
    const health = await fetch(`${mappings()["8443"]}/api/inbox/device/health`, { headers: { Host: `${MAGIC}:8443`, "Tailscale-User-Login": OWNER, Authorization: `Bearer ${paired.token}` } });
    expect(health.status).toBe(200);
    // Still owner rules on the new run, and still no way in for anyone else.
    expect((await throughServe("/api/inbox/agents")).status).toBe(200);
    expect(await codeOf(await throughServe("/api/inbox/agents", { login: "guest@example.com" }))).toEqual([403, "tailnet_identity_refused"]);

    await stop("SIGTERM");
    expect(mappings()).toEqual({});
    rmSync(config);
    rmSync(join(w.dataDir, "inbox", "tailnet-door.json"), { force: true });
  });

  test("a run published only by --tailscale: Restart from the owner's phone publishes the new run too, and config.json stays as it was", async () => {
    expect(run(["--background", "--tailscale"]).code).toBe(0);
    await restartFromPhone();
    expect((await throughServe("/api/inbox/threads")).status).toBe(200);
    await stop("SIGTERM");
    expect(mappings()).toEqual({});
    const config = join(w.dataDir, "config.json");
    expect(existsSync(config) ? JSON.parse(readFileSync(config, "utf8")).inboxTailscale : undefined).toBeUndefined();
  });

  test("Tailscale missing never stops the Inbox: it starts locally and says why", async () => {
    // A PATH of one folder holding only the world's wrapper and a link to bun:
    // no tailscale at all, even where bun and tailscale share a directory.
    const bare = join(w.root, "no-tailscale");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "plannotator"), readFileSync(join(w.bin, "plannotator")));
    chmodSync(join(bare, "plannotator"), 0o755);
    symlinkSync(process.execPath, join(bare, "bun"));
    const PATH = bare;
    expect(Bun.which("tailscale", { PATH })).toBeNull();
    const env = { ...worldEnv(w), PATH };
    const result = Bun.spawnSync([join(bare, "plannotator"), "inbox", "--background", "--tailscale"], { env: { ...process.env, ...env }, cwd: w.root });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("Not published over your tailnet");
    expect(result.stderr.toString()).toContain("`tailscale` CLI not found on PATH");
    const entry = registry(w);
    expect((await fetch(`http://127.0.0.1:${entry.port}/api/inbox/health`)).status).toBe(200);
    expect(JSON.parse(readFileSync(join(w.dataDir, "inbox", "inbox.json"), "utf8")).tailscale.error).toContain("not found on PATH");
    await stop("SIGTERM");
  });
});
