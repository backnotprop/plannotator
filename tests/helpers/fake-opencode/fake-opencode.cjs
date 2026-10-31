/**
 * A fake `opencode` (OpenCode 1.18.23) for the launch tests: the parts of
 * `opencode serve`'s HTTP API the Inbox's OpenCode host uses (checked against
 * the real 1.18.23, .ops/work/launch-opencode/smoke2/probe2.out), and the
 * agent with Plannotator's plugin answering through the Inbox. The real
 * OpenCode is never run. Node-safe CommonJS, run by the test runtime's own
 * executable through a `/bin/sh` wrapper on PATH.
 *
 * State lives in the folder the wrapper names (`FAKE_OPENCODE_STATE`):
 *  - config.json   what the test asks for: { version, workMs, hold, answer, prompts, localAnswer, failServe }
 *  - calls.jsonl   one line per call: argv, cwd, env names, and for `serve` the
 *                  launch's env values the test checks (never the password: only
 *                  whether one was set), and its pid
 *  - sessions/<id>.json  each session, kept across servers (OpenCode's database)
 *  - prompts.jsonl one line per turn a session took: session, text
 *  - replies.jsonl one line per permission reply: request, reply, message
 *  - pids.log      every fake server, and children.log every child it started
 *                  ("<child pid> <server pid>": a stand-in for a shell command
 *                  still running), so a test can see them end and kill only its own
 *
 * Calls:
 *  --version                          "<version>"
 *  serve --hostname 127.0.0.1 --port 0  prints "opencode server listening on http://127.0.0.1:<port>"
 *  session delete <id> [--pure]       drops the session
 *
 * The server needs Basic auth `opencode:$OPENCODE_SERVER_PASSWORD` on every
 * route (401 otherwise), as the real one does when the password is set.
 * A turn (`POST /session/:id/prompt_async`): busy, then each of `prompts` as a
 * `permission.asked` it waits on (the reply, or `localAnswer`: answered
 * "once" by the fake itself, as a person in `opencode attach` would), then
 * after `workMs` (and while `hold` is set) the agent answers through the
 * Inbox's MCP `send_message` (`reply_to` the item in the wake text), as
 * Plannotator's plugin does from `PLANNOTATOR_DATA_DIR`, and goes idle.
 */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const STATE = process.env.FAKE_OPENCODE_STATE;
if (!STATE) {
  process.stderr.write("FAKE_OPENCODE_STATE is not set\n");
  process.exit(2);
}
fs.mkdirSync(path.join(STATE, "sessions"), { recursive: true });
const config = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, "config.json"), "utf8"));
  } catch {
    return {};
  }
};
const append = (name, value) => fs.appendFileSync(path.join(STATE, name), `${typeof value === "string" ? value : JSON.stringify(value)}\n`);
const argv = process.argv.slice(2);
const KEPT = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_LAUNCH", "HOME"];
append("calls.jsonl", {
  argv,
  cwd: process.cwd(),
  env: Object.keys(process.env).sort(),
  values: Object.fromEntries(KEPT.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
  passwordSet: typeof process.env.OPENCODE_SERVER_PASSWORD === "string" && process.env.OPENCODE_SERVER_PASSWORD.length >= 32,
  pid: process.pid,
  at: Date.now(),
});

const sessionFile = (id) => path.join(STATE, "sessions", `${id}.json`);
const readSession = (id) => {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), "utf8"));
  } catch {
    return null;
  }
};

if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write(`${config().version ?? "1.18.23"}\n`);
  process.exit(0);
}
if (argv[0] === "session" && argv[1] === "delete") {
  const id = argv[2];
  if (!id || !readSession(id)) {
    process.stderr.write(`Session not found: ${id}\n`);
    process.exit(1);
  }
  fs.rmSync(sessionFile(id), { force: true });
  process.stdout.write(`Session ${id} deleted\n`);
  process.exit(0);
}
if (argv[0] !== "serve") {
  process.stderr.write(`fake opencode: ${argv.join(" ")} is not faked\n`);
  process.exit(2);
}

// ── serve ──
if (config().failServe) {
  process.stderr.write("Error: fake serve refused to start\n");
  process.exit(1);
}
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
append("pids.log", String(process.pid));
// A shell command the agent left running: it is in the server's process group, and goes with it.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "fake-opencode-child"], { stdio: "ignore" });
append("children.log", `${child.pid} ${process.pid}`);

const listeners = new Set();
const emit = (type, properties) => {
  const data = `data: ${JSON.stringify({ type, properties })}\n\n`;
  for (const res of listeners) res.write(data);
};
const busy = new Set();
const aborted = new Set();
/** Permission requests waiting: id → { info, resolve }. */
const pending = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inboxCall = async (args) => {
  const dataDir = process.env.PLANNOTATOR_DATA_DIR ?? path.join(process.env.HOME ?? "", ".plannotator");
  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, "inbox", "inbox.json"), "utf8"));
  const response = await fetch(`http://127.0.0.1:${registry.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: args } }),
  });
  return response.status;
};

const turn = async (session, text) => {
  busy.add(session.id);
  aborted.delete(session.id);
  emit("session.status", { sessionID: session.id, status: { type: "busy" } });
  const cfg = config();
  for (const prompt of cfg.prompts ?? []) {
    const id = `per_${crypto.randomBytes(8).toString("hex")}`;
    const info = { id, sessionID: session.id, permission: prompt.permission, patterns: prompt.patterns ?? [], metadata: prompt.metadata ?? {}, always: prompt.always ?? [], tool: { messageID: "msg_fake", callID: id } };
    const answered = new Promise((resolve) => pending.set(id, { info, resolve }));
    emit("permission.asked", info);
    if (config().localAnswer) {
      await sleep(300);
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        append("replies.jsonl", { session: session.id, request: id, permission: info.permission, reply: "once", local: true });
        emit("permission.replied", { sessionID: session.id, requestID: id, reply: "once" });
        entry.resolve("once");
      }
    }
    await answered;
    if (aborted.has(session.id)) break;
  }
  await sleep(cfg.workMs ?? 400);
  while (config().hold && !aborted.has(session.id)) await sleep(100);
  if (!aborted.has(session.id)) {
    const item = /\(([a-z]+_[0-9A-HJKMNP-TV-Z]{26})\)/.exec(text)?.[1];
    const n = fs.existsSync(path.join(STATE, "prompts.jsonl")) ? fs.readFileSync(path.join(STATE, "prompts.jsonl"), "utf8").split("\n").filter(Boolean).length : 0;
    const body = `${config().answer ?? "OpenCode here"} (turn ${n})`;
    await inboxCall({ body, ...(item ? { reply_to: item } : {}), project_path: session.directory, agent_session: session.id, agent_host: "opencode", agent_name: "OpenCode" }).catch((e) => append("errors.log", String(e)));
  }
  busy.delete(session.id);
  emit("session.status", { sessionID: session.id, status: { type: "idle" } });
  emit("session.idle", { sessionID: session.id });
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== expected) return send(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && url.pathname === "/global/health") return send(res, 200, { healthy: true, version: config().version ?? "1.18.23" });
  if (req.method === "GET" && url.pathname === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }
  if (req.method === "POST" && url.pathname === "/session") {
    const body = await readBody(req);
    const id = `ses_${crypto.randomBytes(12).toString("hex")}`;
    const session = { id, directory: url.searchParams.get("directory") ?? process.cwd(), title: body.title ?? null, permission: body.permission ?? null };
    fs.writeFileSync(sessionFile(id), JSON.stringify(session));
    return send(res, 200, session);
  }
  if (req.method === "GET" && url.pathname === "/session/status") return send(res, 200, Object.fromEntries([...busy].map((id) => [id, { type: "busy" }])));
  if (req.method === "GET" && url.pathname === "/permission") return send(res, 200, [...pending.values()].map((p) => p.info));
  if (req.method === "GET" && url.pathname === "/question") return send(res, 200, []);
  if (parts[0] === "permission" && parts[2] === "reply" && req.method === "POST") {
    const body = await readBody(req);
    const entry = pending.get(parts[1]);
    if (!entry) return send(res, 404, { error: "not found" });
    pending.delete(parts[1]);
    append("replies.jsonl", { session: entry.info.sessionID, request: parts[1], permission: entry.info.permission, reply: body.reply, message: body.message ?? null });
    emit("permission.replied", { sessionID: entry.info.sessionID, requestID: parts[1], reply: body.reply });
    entry.resolve(body.reply);
    return send(res, 200, true);
  }
  if (parts[0] === "session" && parts[1]) {
    const session = readSession(parts[1]);
    if (!session) return send(res, 404, { error: "session not found" });
    if (req.method === "GET" && parts.length === 2) return send(res, 200, session);
    if (req.method === "POST" && parts[2] === "prompt_async") {
      const body = await readBody(req);
      const text = (body.parts ?? []).map((p) => p.text ?? "").join("");
      append("prompts.jsonl", { session: session.id, text, server: process.pid });
      void turn(session, text);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "POST" && parts[2] === "abort") {
      aborted.add(session.id);
      for (const [id, entry] of pending) {
        if (entry.info.sessionID !== session.id) continue;
        pending.delete(id);
        entry.resolve("reject");
      }
      append("aborts.log", session.id);
      return send(res, 200, true);
    }
  }
  return send(res, 404, { error: "not faked" });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`);
});
