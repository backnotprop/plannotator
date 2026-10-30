/**
 * `plannotator annotate --tailscale` launched by a host with an "Ask this
 * session" bridge (#2166), as a process: the real CLI from source, a scripted
 * `tailscale` on PATH (status names the owner, serve keeps its mapping in a
 * file), a scratch data dir. A request "through serve" goes to the loopback
 * port the mapping points at with the headers serve would set
 * (`X-Forwarded-For`, `Tailscale-User-Login`, the served Host).
 *
 * What it guards: the owner's tab over the tailnet loses Ask this session (it
 * used to be discarded), anyone else on the tailnet gains it, the host's own
 * bridge and host-control routes become reachable through serve, or a session
 * without --tailscale behaves any differently than before.
 *
 * The real `tailscale` never runs, no browser opens, ~/.plannotator is never
 * touched; every process this file starts is stopped in afterEach.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const MAGIC = "studio.tail0000.ts.net";
const OWNER = "owner@example.com";
const TOKEN = "t".repeat(40);
const cliEntry = join(import.meta.dir, "index.ts");

/** The scripted CLI: `status --json`, `serve status --json`, `serve --bg --https=P <target>`, `serve --https=P off`. */
const FAKE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [state, log, mode] = process.argv.slice(2, 5);
const args = process.argv.slice(5);
appendFileSync(log, args.join(" ") + "\\n");
const serve = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
const out = (text) => { process.stdout.write(text); process.exit(0); };
if (args.includes("funnel")) { process.stderr.write("never funnel\\n"); process.exit(9); }
if (args[0] === "status") {
  if (mode === "tagged") out(JSON.stringify({ Self: { DNSName: "${MAGIC}.", UserID: 1, Tags: ["tag:server"] }, User: {} }));
  out(JSON.stringify({ Self: { DNSName: "${MAGIC}.", UserID: 1 }, User: { "1": { LoginName: "${OWNER}" } } }));
}
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
if (args[0] === "serve" && port && args.includes("--bg") && mode === "serve-off") {
  out("\\nServe is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         https://login.tailscale.com/f/serve?node=nTEST\\n\\n");
}
if (args[0] === "serve" && port && args.includes("--bg")) {
  serve[port] = args.at(-1);
  writeFileSync(state, JSON.stringify(serve));
  out("Available within your tailnet:\\n\\nhttps://${MAGIC}:" + port + "/\\n|-- proxy " + args.at(-1) + "\\n");
}
process.stderr.write("unexpected: " + args.join(" ") + "\\n");
process.exit(2);
`;

type Json = Record<string, any>;

let root = "";
let stubs: string[] = [];
let running: { proc: ReturnType<typeof Bun.spawn>; port: number } | null = null;

beforeAll(() => {
  stubs = stubHookDistHtml();
  root = mkdtempSync(join(tmpdir(), "plannotator-tailscale-ask-"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  writeFileSync(join(root, "fake-tailscale.mjs"), FAKE);
});

afterEach(async () => {
  if (running) {
    running.proc.kill("SIGTERM");
    await running.proc.exited;
    running = null;
  }
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  removeStubbedHtml(stubs);
});

const statePath = () => join(root, "serve.json");
const mappings = (): Record<string, string> => (existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) : {});

/** Start `plannotator annotate notes.md [...flags]` as a host would, and wait for its ready line. */
async function start(
  flags: string[],
  options: { bridge?: boolean; mode?: "tagged" | "serve-off"; argv?: string[]; cwd?: string } = {},
): Promise<{ port: number; ready: Json }> {
  rmSync(statePath(), { force: true });
  writeFileSync(
    join(root, "bin", "tailscale"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, "fake-tailscale.mjs")}' '${statePath()}' '${join(root, "calls.txt")}' '${options.mode ?? "owner"}' "$@"\n`,
  );
  chmodSync(join(root, "bin", "tailscale"), 0o755);
  const readyFile = join(root, `ready-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`,
    PLANNOTATOR_DATA_DIR: join(root, "data"),
    PLANNOTATOR_CWD: options.cwd ?? root,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: undefined,
    NO_BROWSER,
    PLANNOTATOR_REMOTE: undefined,
    PLANNOTATOR_PORT: undefined,
    PLANNOTATOR_AI: undefined,
  };
  if (options.bridge !== false) {
    env.PLANNOTATOR_SESSION_BRIDGE_TOKEN = TOKEN;
    env.PLANNOTATOR_SESSION_BRIDGE_HOST = "claude-code";
    env.PLANNOTATOR_SESSION_BRIDGE_MODES = "turn";
  }
  const proc = Bun.spawn([process.execPath, cliEntry, ...(options.argv ?? ["annotate", "notes.md"]), ...flags], {
    cwd: options.cwd ?? root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (existsSync(readyFile)) {
      const line = readFileSync(readyFile, "utf8").split("\n").find((l) => l.trim());
      if (line) {
        try {
          const ready = JSON.parse(line) as Json;
          running = { proc, port: ready.port };
          return { port: ready.port, ready };
        } catch {
          // Half-written: look again.
        }
      }
    }
    if (proc.exitCode !== null) throw new Error(`the CLI exited ${proc.exitCode}: ${await new Response(proc.stderr).text()}`);
    if (Date.now() > deadline) throw new Error("the CLI never became ready");
    await Bun.sleep(50);
  }
}

/** A request as `tailscale serve` would proxy it: the served Host, the peer's address, and the login it names. */
function throughServe(port: number, path: string, init: { method?: string; login?: string | null; headers?: Record<string, string>; body?: string } = {}) {
  const target = mappings()[String(port)];
  if (!target) throw new Error("no mapping");
  const headers: Record<string, string> = {
    Host: `${MAGIC}:${port}`,
    "X-Forwarded-For": "100.64.0.9",
    "X-Forwarded-Host": `${MAGIC}:${port}`,
    "X-Forwarded-Proto": "https",
    ...(init.headers ?? {}),
  };
  const login = init.login === undefined ? OWNER : init.login;
  if (login !== null) {
    headers["Tailscale-User-Login"] = login;
    headers["Tailscale-Headers-Info"] = "https://tailscale.com/s/serve-headers";
  }
  return fetch(`${target}${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

const local = (port: number, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
const providerIds = async (response: Response) => ((await response.json()) as Json).providers.map((p: Json) => p.id) as string[];
const ownerPage = (port: number) => ({ Origin: `https://${MAGIC}:${port}`, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" });
const SESSION_BODY = JSON.stringify({ providerId: "session-bridge", context: { mode: "annotate", annotate: { content: "# Notes", filePath: "notes.md" } } });

const unix = test.skipIf(process.platform === "win32");

describe("--tailscale with a host's bridge: Ask this session for this machine and its owner (#2166)", () => {
  unix("the owner's tab over the tailnet asks this session end to end; a guest gets Ask AI without it", async () => {
    const { port, ready } = await start(["--tailscale"]);
    expect(ready.url).toBe(`https://${MAGIC}:${port}`);
    expect(ready.tailnet).toEqual({ ask: true });
    expect(mappings()[String(port)]).toBe(`http://127.0.0.1:${port}`);

    // This machine and the owner's tab: the bridge is the Ask AI provider.
    expect(await providerIds(await local(port, "/api/ai/capabilities"))).toEqual(["session-bridge"]);
    expect(await providerIds(await throughServe(port, "/api/ai/capabilities"))).toEqual(["session-bridge"]);

    // Everyone else through serve: what --tailscale always served, never the bridge.
    for (const login of ["guest@example.com", null]) {
      const ids = await providerIds(await throughServe(port, "/api/ai/capabilities", { login }));
      expect(ids).not.toContain("session-bridge");
      const refused = await throughServe(port, "/api/ai/session", { method: "POST", login, headers: ownerPage(port), body: SESSION_BODY });
      expect(refused.status).toBe(503);
    }
    // The owner's login with a forwarded address that is not (only) Tailscale's: a forged header behind a local proxy.
    for (const forwarded of ["192.168.1.5", "100.64.0.9, 192.168.1.5"]) {
      const ids = await providerIds(await throughServe(port, "/api/ai/capabilities", { headers: { "X-Forwarded-For": forwarded } }));
      expect([forwarded, ids.includes("session-bridge")]).toEqual([forwarded, false]);
    }
    // Funnel is never the owner, whatever login it carries.
    expect(await providerIds(await throughServe(port, "/api/ai/capabilities", { headers: { "Tailscale-Funnel-Request": "?1" } }))).not.toContain("session-bridge");

    // The owner asks; the test plays the host on its loopback poll.
    const created = await throughServe(port, "/api/ai/session", { method: "POST", headers: ownerPage(port), body: SESSION_BODY });
    expect(created.status).toBe(200);
    const { sessionId } = (await created.json()) as Json;
    const answer = throughServe(port, "/api/ai/query", { method: "POST", headers: ownerPage(port), body: JSON.stringify({ sessionId, prompt: "What changed?" }) });
    const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    let ask: Json | undefined;
    for (let i = 0; i < 20 && !ask; i++) {
      const polled = (await (await local(port, "/api/ai/bridge/poll", { method: "POST", headers: bearer, body: JSON.stringify({ status: "ready", waitMs: 500 }) })).json()) as Json;
      ask = polled.commands?.find((c: Json) => c.type === "ask");
    }
    if (!ask) throw new Error(`no ask reached the host; the query answered ${(await answer).status}: ${await (await answer).text()}`);
    expect(ask.text).toContain("What changed?");
    const posted = await local(port, "/api/ai/bridge/event", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ events: [{ type: "started", askId: ask!.askId }, { type: "delta", askId: ask!.askId, text: "Only the intro." }, { type: "done", askId: ask!.askId, answer: "Only the intro." }] }),
    });
    expect(posted.status).toBe(200);
    expect(await (await answer).text()).toContain("Only the intro.");
  }, 30_000);

  unix("the host's channels answer this machine only: bridge poll and host control refuse anything through serve", async () => {
    const { port } = await start(["--tailscale"]);
    const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    // Even the owner, with the token, whether it sends the served name or claims a loopback Host.
    for (const login of [OWNER, "guest@example.com"]) {
      for (const host of [`${MAGIC}:${port}`, `127.0.0.1:${port}`]) {
        const poll = await throughServe(port, "/api/ai/bridge/poll", { method: "POST", login, headers: { ...bearer, Host: host }, body: JSON.stringify({ waitMs: 0 }) });
        // Refused before the token is looked at: 403 by the Host guard, else 404 (no bridge for this caller).
        expect([login, host, [403, 404].includes(poll.status)]).toEqual([login, host, true]);
        const status = await throughServe(port, "/api/host/status", { login, headers: { ...bearer, Host: host } });
        expect([login, host, status.status, ((await status.json()) as Json).code]).toEqual([login, host, 404, "host_control_disabled"]);
      }
    }
    // This machine: unchanged.
    expect((await local(port, "/api/host/status", { headers: bearer })).status).toBe(200);
    expect((await local(port, "/api/ai/bridge/poll", { method: "POST", headers: bearer, body: JSON.stringify({ waitMs: 0 }) })).status).toBe(200);
  });

  unix("the owner's tab must carry the served name: a loopback Host through serve cannot ask, another name is refused", async () => {
    const { port } = await start(["--tailscale"]);
    const claimed = await throughServe(port, "/api/ai/session", { method: "POST", headers: { "Content-Type": "application/json", Host: `127.0.0.1:${port}` }, body: SESSION_BODY });
    expect(claimed.status).toBe(403);
    expect(((await claimed.json()) as Json).code).toBe("session_bridge_forbidden_host");
    const elsewhere = await throughServe(port, "/api/ai/capabilities", { headers: { Host: `evil.example:${port}` } });
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.headers.get("X-Plannotator-Error")).toBe("host_not_allowed");
    // A page on another tailnet machine (same site) cannot write.
    const crossSite = await throughServe(port, "/api/ai/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `https://other.tail0000.ts.net`, "Sec-Fetch-Site": "same-site" },
      body: SESSION_BODY,
    });
    expect(crossSite.status).toBe(403);
  });

  unix("code review gets the same rule (the review server's wiring)", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo, env: gitEnv });
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "one");
    writeFileSync(join(repo, "a.txt"), "two\n");
    const { port, ready } = await start(["--tailscale"], { argv: ["review", "--no-git-remote-check"], cwd: repo });
    expect(ready.tailnet).toEqual({ ask: true });
    expect(await providerIds(await local(port, "/api/ai/capabilities"))).toEqual(["session-bridge"]);
    expect(await providerIds(await throughServe(port, "/api/ai/capabilities"))).toEqual(["session-bridge"]);
    expect(await providerIds(await throughServe(port, "/api/ai/capabilities", { login: "guest@example.com" }))).not.toContain("session-bridge");
    const bearer = { Authorization: `Bearer ${TOKEN}` };
    expect((await throughServe(port, "/api/host/status", { headers: bearer })).status).toBe(404);
    expect((await local(port, "/api/host/status", { headers: bearer })).status).toBe(200);
  }, 30_000);

  unix("a tagged machine has no owner: Ask this session stays on this computer, the ready line says so", async () => {
    const { port, ready } = await start(["--tailscale"], { mode: "tagged" });
    expect(ready.tailnet).toEqual({ ask: false });
    expect(await providerIds(await local(port, "/api/ai/capabilities"))).toEqual(["session-bridge"]);
    expect(await providerIds(await throughServe(port, "/api/ai/capabilities"))).not.toContain("session-bridge");
  });

  unix("SIGTERM takes the serve mapping down", async () => {
    const { port } = await start(["--tailscale"]);
    expect(mappings()[String(port)]).toBeDefined();
    running!.proc.kill("SIGTERM");
    await running!.proc.exited;
    running = null;
    expect(mappings()).toEqual({});
    expect(readFileSync(join(root, "calls.txt"), "utf8")).not.toContain("funnel");
  });
});

describe("nothing changes without --tailscale or without a bridge", () => {
  unix("a local session with a bridge: no tailnet field, no tailscale call; a LAN proxy's headers change nothing", async () => {
    rmSync(join(root, "calls.txt"), { force: true });
    const { port, ready } = await start([]);
    expect(ready.tailnet).toBeUndefined();
    expect(ready.url).toBe(`http://localhost:${port}`);
    expect(existsSync(join(root, "calls.txt"))).toBe(false);
    const lan = { "X-Forwarded-For": "192.168.1.5" };
    const plain = await providerIds(await local(port, "/api/ai/capabilities"));
    expect(plain).toEqual(["session-bridge"]);
    expect(await providerIds(await local(port, "/api/ai/capabilities", { headers: lan }))).toEqual(plain);
    const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    expect((await local(port, "/api/host/status", { headers: bearer })).status).toBe(200);
    expect((await local(port, "/api/host/status", { headers: { ...bearer, ...lan } })).status).toBe(200);
    expect((await local(port, "/api/ai/session", { method: "POST", headers: { ...bearer, ...lan }, body: SESSION_BODY })).status).toBe(200);
  });

  // A `--bg` mapping a crashed --tailscale session left behind can point at a
  // later local session on the same port: Tailscale's marks never reach the
  // host's channels or the agent session there, gate or no gate.
  unix("a local session refuses the bridge and host control to anything that came through Tailscale", async () => {
    const { port } = await start([]);
    const bearer = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    for (const marks of [{ "Tailscale-User-Login": OWNER, "X-Forwarded-For": "100.64.0.9" }, { "X-Forwarded-For": "100.101.102.103" }, { "Tailscale-Headers-Info": "x" }]) {
      const status = await local(port, "/api/host/status", { headers: { ...bearer, ...marks } });
      expect([marks, status.status, ((await status.json()) as Json).code]).toEqual([marks, 404, "host_control_disabled"]);
      const poll = await local(port, "/api/ai/bridge/poll", { method: "POST", headers: { ...bearer, ...marks }, body: JSON.stringify({ waitMs: 0 }) });
      // Refused before the token is read (the Host guard's 403).
      expect([marks, poll.status]).toEqual([marks, 403]);
      const ask = await local(port, "/api/ai/session", { method: "POST", headers: { "Content-Type": "application/json", ...marks }, body: SESSION_BODY });
      expect([marks, ask.status]).toEqual([marks, 403]);
    }
  });

  unix("--tailscale with no bridge (a person at a shell): Tailscale is asked nothing more, the ready line says ask: false", async () => {
    rmSync(join(root, "calls.txt"), { force: true });
    const { port, ready } = await start(["--tailscale"], { bridge: false });
    expect(ready.tailnet).toEqual({ ask: false });
    const calls = readFileSync(join(root, "calls.txt"), "utf8").trim().split("\n");
    expect(calls.some((line) => line.startsWith("status"))).toBe(false);
    expect(await providerIds(await throughServe(port, "/api/ai/capabilities"))).not.toContain("session-bridge");
  });
});

describe("--tailscale when Tailscale Serve is off for the tailnet", () => {
  unix("says it is a Tailscale setting, passes on Tailscale's link, and exits without leaving a mapping", async () => {
    rmSync(join(root, "calls.txt"), { force: true });
    let message = "";
    try {
      await start(["--tailscale"], { bridge: false, mode: "serve-off" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("the CLI exited 1");
    expect(message).toContain("Tailscale Serve is off for your tailnet");
    expect(message).toContain("https://login.tailscale.com/f/serve?node=nTEST");
    expect(message).toContain("without --tailscale");
    expect(mappings()).toEqual({});
    // Nothing was published, so there was nothing to take down.
    expect(readFileSync(join(root, "calls.txt"), "utf8")).not.toContain("off");
  });
});
