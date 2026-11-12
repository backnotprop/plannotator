/**
 * A fake `opencode2` for launch (packages/server/inbox-launch-opencode.ts): `--version`, `--standalone api GET
 * /api/model`, and `serve --hostname --port`, an HTTP server with the subset of OpenCode 2.2.7's API a launch uses
 * (info, plugin list, sessions, prompt, interrupt, permission replies, forms, the event stream), behind the server
 * password. It also plays Plannotator's OpenCode plugin: with the Inbox tool on and `PLANNOTATOR_INBOX_LAUNCHED`, it
 * polls the bridge as host `opencode` for each session created here and for `PLANNOTATOR_INBOX_LAUNCHED_SESSION`,
 * and a command becomes a turn that answers through the Inbox's MCP. A turn whose text holds `APPROVE` asks a shell
 * permission first; one holding `ASK` opens a form. Every start, request and stop goes to `calls.jsonl`. Never the
 * real OpenCode.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeOpenCodeLaunchState {
  /** `opencode2 --version`'s version (default 2.2.7). */
  version?: string;
  /** The plugin `/api/plugin` lists (default 0.28.62, active); null: none. */
  plugin?: { version: string; status?: "active" | "failed"; error?: string } | null;
  /** `GET /api/model`'s models (default: two with variants). */
  models?: { providerID: string; id: string; variants: string[] }[];
  /** Every turn fails with this error. */
  failTurn?: string | null;
  /** How long a turn works (ms). */
  turnMs?: number;
}

export type FakeOpenCodeLaunchCall =
  | { event: "start"; pid: number; argv: string[]; cwd: string; env: Record<string, string> }
  | { event: "http"; pid: number; method: string; path: string; body: any }
  | { event: "turn"; pid: number; session: string; text: string }
  | { event: "stop"; pid: number; why: string }
  | { event: "cli"; pid: number; argv: string[] };

export interface FakeOpenCodeLaunch {
  bin: string;
  set(state: FakeOpenCodeLaunchState): void;
  calls(): FakeOpenCodeLaunchCall[];
  starts(): Extract<FakeOpenCodeLaunchCall, { event: "start" }>[];
  http(method?: string, path?: RegExp): Extract<FakeOpenCodeLaunchCall, { event: "http" }>[];
  turns(): Extract<FakeOpenCodeLaunchCall, { event: "turn" }>[];
  alive(pid: number): boolean;
}

const SCRIPT = String.raw`
const fs = require("fs");
const path = require("path");
const http = require("http");
const dir = __dirname;
const log = (line) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ pid: process.pid, ...line }) + "\n");
const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const args = process.argv.slice(2);
const s0 = state();
if (args[0] === "--version") { process.stdout.write("opencode v" + (s0.version || "2.2.7") + "\n"); process.exit(0); }
const models = () => (state().models || [
  { providerID: "opencode", id: "flint-40b-free", variants: ["low", "medium", "high", "xhigh", "max"] },
  { providerID: "opencode", id: "big-pickle", variants: [] },
]).map((m) => ({ id: m.id, modelID: m.id, providerID: m.providerID, name: m.id, enabled: true, variants: m.variants.map((v) => ({ id: v, settings: { reasoningEffort: v } })) }));
if (args[0] === "--standalone" && args[1] === "api") {
  log({ event: "cli", argv: args });
  if (args[2] === "GET" && args[3] === "/api/model") { process.stdout.write(JSON.stringify({ location: { directory: process.cwd() }, data: models() })); process.exit(0); }
  process.exit(1);
}
if (args[0] !== "serve") { log({ event: "cli", argv: args }); process.exit(0); }

const port = Number(args[args.indexOf("--port") + 1]);
const env = {};
for (const name of ["HOME", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_INBOX_LAUNCHED", "PLANNOTATOR_INBOX_LAUNCHED_SESSION", "LOGIN_ONLY", "OPENCODE"]) if (process.env[name] !== undefined) env[name] = process.env[name];
log({ event: "start", argv: args, cwd: process.cwd(), env });
const auth = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const streams = new Set();
const emit = (type, data) => { const line = "data: " + JSON.stringify({ type, data }) + "\n\n"; for (const res of streams) res.write(line); };
const sessions = new Map();
const permissions = new Map();
let stopped = false;
const stop = (why) => { if (stopped) return; stopped = true; log({ event: "stop", why }); process.exit(0); };
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

// ── The plugin: the bridge poll per watched session ──
const on = (v) => ["1", "true", "on"].includes(String(v || "").toLowerCase());
const launched = on(process.env.PLANNOTATOR_INBOX_LAUNCHED);
const registryOf = () => { try { return JSON.parse(fs.readFileSync(path.join(process.env.PLANNOTATOR_DATA_DIR, "inbox", "inbox.json"), "utf8")); } catch { return null; } };
const watched = new Set();
async function watch(session) {
  if (!on(process.env.PLANNOTATOR_INBOX_TOOL) || !process.env.PLANNOTATOR_DATA_DIR || watched.has(session)) return;
  watched.add(session);
  let registry = registryOf();
  const post = (p, body) => fetch("http://127.0.0.1:" + registry.port + p, { method: "POST", headers: { authorization: "Bearer " + registry.token, "content-type": "application/json" }, body: JSON.stringify({ session, host: "opencode", ...body }) });
  const taken = new Set();
  let queue = Promise.resolve();
  const startedAt = Date.now();
  while (!stopped) {
    registry = registryOf() || registry;
    if (!registry) { await sleep(200); continue; }
    const busy = !!sessions.get(session)?.busy;
    const response = await post("/api/inbox/bridge/poll", { waitMs: 1000, project_path: process.cwd(), started_at: startedAt, busy, idle_since: busy ? null : new Date().toISOString() }).catch(() => null);
    if (!response) { await sleep(200); continue; }
    let commands = [];
    try { const parsed = await response.json(); commands = Array.isArray(parsed.commands) ? parsed.commands : []; } catch {}
    for (const command of commands) {
      if (!command || typeof command.id !== "string" || taken.has(command.id)) continue;
      taken.add(command.id);
      await post("/api/inbox/bridge/event", { type: "delivered", id: command.id }).catch(() => {});
      queue = queue.then(() => turn(session, command.body, { id: command.id, registry }));
    }
  }
}

async function turn(session, text, command) {
  const s = sessions.get(session) || { busy: false };
  sessions.set(session, s);
  log({ event: "turn", session, text });
  s.busy = true;
  emit("session.execution.started", { sessionID: session });
  if (text.includes("APPROVE")) {
    const id = "per_" + Math.random().toString(36).slice(2, 12);
    const decided = new Promise((resolve) => permissions.set(id, resolve));
    emit("permission.asked", { id, sessionID: session, action: "shell", resources: ["touch approved.txt"], save: ["touch *"] });
    const decision = await decided;
    if (decision === "reject") { s.busy = false; emit("session.execution.interrupted", { sessionID: session }); return; }
  }
  if (text.includes("ASK")) emit("form.created", { id: "frm_" + Math.random().toString(36).slice(2, 10), sessionID: session, title: "Which colour?" });
  await sleep(state().turnMs ?? 200);
  const failTurn = state().failTurn;
  if (failTurn) { s.busy = false; emit("session.execution.failed", { sessionID: session, error: { message: failTurn } }); return; }
  if (command && command.registry) {
    await fetch("http://127.0.0.1:" + command.registry.port + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "Done: " + text.split("\n")[0].slice(0, 60), reply_to: command.id, project_path: process.cwd(), agent_session: session, agent_host: "opencode", agent_name: "OpenCode" } } }),
    }).catch(() => {});
  }
  s.busy = false;
  emit("session.execution.succeeded", { sessionID: session });
}

const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : null); } catch { resolve(null); } }); });
const server = http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  if (req.headers.authorization !== auth) return send(401, { _tag: "UnauthorizedError" });
  const url = new URL(req.url, "http://x");
  const body = req.method === "GET" ? null : await readBody(req);
  if (url.pathname !== "/api/event" && url.pathname !== "/api/info") log({ event: "http", method: req.method, path: url.pathname, body });
  const now = state();
  if (url.pathname === "/api/info") return send(200, { version: now.version || "2.2.7", pid: process.pid });
  if (url.pathname === "/api/event") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: " + JSON.stringify({ type: "server.connected", data: {} }) + "\n\n"); streams.add(res); req.on("close", () => streams.delete(res)); return; }
  if (url.pathname === "/api/plugin") {
    const plugin = now.plugin === undefined ? { version: "0.28.62" } : now.plugin;
    return send(200, { data: plugin ? [{ id: "plannotator", source: { type: "package", version: plugin.version }, state: { status: plugin.status || "active", error: plugin.error } }] : [] });
  }
  if (url.pathname === "/api/model/default") { const m = models()[0]; return send(200, { data: m }); }
  if (url.pathname === "/api/session" && req.method === "POST") {
    const id = "ses_" + Math.random().toString(36).slice(2, 14);
    sessions.set(id, { busy: false, model: body && body.model });
    emit("session.created", { sessionID: id, location: body && body.location });
    if (launched) void watch(id);
    return send(200, { data: { id, model: body && body.model, title: body && body.title, location: body && body.location } });
  }
  let m;
  if ((m = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname))) { void turn(m[1], String((body && body.text) || "")); return send(200, { data: {} }); }
  if ((m = /^\/api\/session\/([^/]+)\/interrupt$/.exec(url.pathname))) { const s = sessions.get(m[1]); if (s) { s.busy = false; emit("session.execution.interrupted", { sessionID: m[1] }); } return send(204); }
  if ((m = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url.pathname))) {
    const resolve = permissions.get(m[2]);
    if (!resolve) return send(404, {});
    permissions.delete(m[2]);
    emit("permission.replied", { sessionID: m[1], requestID: m[2], reply: body.decision });
    resolve(body.decision);
    return send(204);
  }
  if ((m = /^\/api\/session\/([^/]+)\/form\/([^/]+)$/.exec(url.pathname)) && req.method === "DELETE") return send(204);
  return send(404, {});
});
server.listen(port, "127.0.0.1");
const resumed = process.env.PLANNOTATOR_INBOX_LAUNCHED_SESSION;
if (resumed) { sessions.set(resumed, { busy: false }); void watch(resumed); }
`;

export function installFakeOpenCodeLaunch(root: string, state: FakeOpenCodeLaunchState = {}): FakeOpenCodeLaunch {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = (name: string) => join(bin, name);
  const set = (next: FakeOpenCodeLaunchState) => writeFileSync(file("state.json"), JSON.stringify(next));
  set(state);
  writeFileSync(file("fake-opencode-launch.cjs"), SCRIPT);
  writeFileSync(file("opencode2"), `#!/bin/sh\nexec "${process.execPath}" "${file("fake-opencode-launch.cjs")}" "$@"\n`);
  chmodSync(file("opencode2"), 0o755);
  const calls = (): FakeOpenCodeLaunchCall[] =>
    existsSync(file("calls.jsonl"))
      ? readFileSync(file("calls.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeOpenCodeLaunchCall)
      : [];
  return {
    bin,
    set,
    calls,
    starts: () => calls().filter((call): call is Extract<FakeOpenCodeLaunchCall, { event: "start" }> => call.event === "start"),
    http: (method, path) => calls().filter((call): call is Extract<FakeOpenCodeLaunchCall, { event: "http" }> => call.event === "http" && (!method || call.method === method) && (!path || path.test(call.path))),
    turns: () => calls().filter((call): call is Extract<FakeOpenCodeLaunchCall, { event: "turn" }> => call.event === "turn"),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}
