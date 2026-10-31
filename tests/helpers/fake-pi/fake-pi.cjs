#!/usr/bin/env node
/**
 * A fake `pi` for launch tests (never the real Pi). It follows the contract the
 * Pi launch host relies on, as recorded against Pi 0.85.1 in
 * .ops/work/launch-pi/ (smoke-2):
 *
 *  - `pi --version` prints the version alone.
 *  - `pi --mode rpc --session-id <uuid> --name <name>`: strict JSONL on stdin
 *    and stdout. `get_state` answers `{ sessionId, sessionFile, messageCount }`;
 *    `abort` answers at once. The session file is
 *    `<agent dir>/sessions/--<cwd with / as ->--/<stamp>_<uuid>.jsonl`, its
 *    first line the header `{ type: "session", id, cwd }`; an existing file
 *    for the id is reopened (its lines are the context). stdin's end ends the
 *    process with exit 0, as Pi's RPC mode does.
 *  - It acts as Plannotator's Pi extension: it polls the bridge of the Inbox in
 *    `$PLANNOTATOR_DATA_DIR` (else ~/.plannotator) as host `pi`, session
 *    `<uuid>`, only when `PLANNOTATOR_INBOX_TOOL` is on. A command: `delivered`,
 *    `agent_start`, busy, an optional extension dialog (`extension_ui_request`,
 *    waiting for the `extension_ui_response`), then the answer through the
 *    Inbox's MCP `send_message`, idle, `agent_settled`.
 *
 * State in $FAKE_PI_STATE: config.json (read on each use), calls.jsonl (argv,
 * cwd, env names, the data dir and Inbox-tool values it got), pids.log,
 * delivered.log, dialogs.jsonl (each dialog and the answer it got), exits.jsonl.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STATE = process.env.FAKE_PI_STATE;
const args = process.argv.slice(2);
const config = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE, "config.json"), "utf8"));
  } catch {
    return {};
  }
};
const append = (name, line) => fs.appendFileSync(path.join(STATE, name), `${typeof line === "string" ? line : JSON.stringify(line)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

append("calls.jsonl", {
  argv: args,
  cwd: process.cwd(),
  env: Object.keys(process.env).sort(),
  dataDir: process.env.PLANNOTATOR_DATA_DIR ?? null,
  inboxTool: process.env.PLANNOTATOR_INBOX_TOOL ?? null,
  pid: process.pid,
  at: Date.now(),
});

if (args[0] === "--version") {
  process.stdout.write(`${config().version || "0.85.1"}\n`);
  process.exit(0);
}

if (flag("--mode") !== "rpc") {
  process.stderr.write("fake pi: only --version and --mode rpc\n");
  process.exit(2);
}

const sessionId = flag("--session-id");
if (config().startFail) {
  process.stderr.write(`${config().startFail}\n`);
  process.exit(1);
}
fs.appendFileSync(path.join(STATE, "pids.log"), `${process.pid}\n`);

// ── The session file ──
const home = process.env.HOME || "";
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
const cwd = path.resolve(process.cwd());
const sessionDir = path.join(agentDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
fs.mkdirSync(sessionDir, { recursive: true });
let sessionFile = fs.readdirSync(sessionDir).find((name) => name.endsWith(`_${sessionId}.jsonl`));
if (sessionFile) sessionFile = path.join(sessionDir, sessionFile);
else {
  sessionFile = path.join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`);
}
const messageCount = () => fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).length - 1;

// ── RPC ──
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const dialogs = new Map();
let stopped = false;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (let at = input.indexOf("\n"); at >= 0; at = input.indexOf("\n")) {
    const line = input.slice(0, at);
    input = input.slice(at + 1);
    if (!line.trim()) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      continue;
    }
    if (command.type === "extension_ui_response") {
      const waiter = dialogs.get(command.id);
      if (waiter) waiter(command);
      continue;
    }
    if (command.type === "prompt") {
      // A prompt over RPC: a turn of its own here (its dialog, if configured), with no Inbox answer.
      out({ id: command.id, type: "response", command: "prompt", success: true });
      void localTurn();
      continue;
    }
    if (command.type === "get_state") out({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId, sessionFile, messageCount: messageCount(), isStreaming: busy, sessionName: flag("--name") } });
    else out({ id: command.id, type: "response", command: command.type, success: true });
  }
});
process.stdin.on("end", () => {
  stopped = true;
  append("exits.jsonl", { sessionId, pid: process.pid, why: "stdin", at: Date.now() });
  process.exit(0);
});
process.on("SIGTERM", () => {
  append("exits.jsonl", { sessionId, pid: process.pid, why: "SIGTERM", at: Date.now() });
  process.exit(143);
});

// ── A turn's extension dialog: asked over RPC, answered (or not) by the client ──
let busy = false;
async function askDialog() {
  const spec = config().dialog;
  if (!spec) return null;
  const id = crypto.randomUUID();
  const got = new Promise((resolve) => dialogs.set(id, resolve));
  out({ type: "extension_ui_request", id, method: spec.method || "select", title: spec.title, ...(spec.options ? { options: spec.options } : {}) });
  const answered = await Promise.race([got, sleep(10_000).then(() => null)]);
  append("dialogs.jsonl", { sessionId, title: spec.title, response: answered });
  return { answered };
}
async function localTurn() {
  busy = true;
  out({ type: "agent_start" });
  await askDialog();
  busy = false;
  out({ type: "agent_end", willRetry: false });
  out({ type: "agent_settled" });
}

// ── The extension: the bridge poll ──
const on = (value) => ["1", "true", "on"].includes(String(value || "").toLowerCase());
async function extension() {
  if (!on(process.env.PLANNOTATOR_INBOX_TOOL) || config().noConnect) return;
  const dataDir = process.env.PLANNOTATOR_DATA_DIR || path.join(home, ".plannotator");
  const registryFile = path.join(dataDir, "inbox", "inbox.json");
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(registryFile, "utf8"));
    } catch {
      return null;
    }
  };
  let registry = read();
  while (!registry && !stopped) {
    await sleep(300);
    registry = read();
  }
  const startedAt = Date.now();
  let idleSince = new Date().toISOString();
  const post = (p, body) =>
    fetch(`http://127.0.0.1:${registry.port}${p}`, {
      method: "POST",
      headers: { authorization: `Bearer ${registry.token}`, "content-type": "application/json" },
      body: JSON.stringify({ session: sessionId, host: "pi", ...body }),
    });
  const taken = new Set();
  const work = async (command) => {
    await post("/api/inbox/bridge/event", { type: "delivered", id: command.id }).catch(() => {});
    append("delivered.log", command.id);
    const context = messageCount();
    busy = true;
    out({ type: "agent_start" });
    await post("/api/inbox/bridge/event", { type: "state", busy: true }).catch(() => {});
    fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", role: "user", text: command.body.split("\n")[0] })}\n`);
    const asked = await askDialog();
    const until = Date.now() + (config().workMs ?? 600);
    while (!stopped && (Date.now() < until || config().hold)) await sleep(100);
    if (stopped) return;
    const first = command.body.split("\n")[0].slice(0, 60);
    const dialogPart = asked ? ` [dialog ${asked.answered && asked.answered.cancelled ? "cancelled" : "unanswered"}]` : "";
    const body = `${config().answer || "Done"}: ${first} (context ${context})${dialogPart}`;
    await fetch(`http://127.0.0.1:${registry.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body, reply_to: command.id, project_path: cwd, agent_session: sessionId, agent_host: "pi", agent_name: "Pi" } } }),
    }).catch(() => {});
    fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", role: "assistant", text: body })}\n`);
    busy = false;
    idleSince = new Date().toISOString();
    await post("/api/inbox/bridge/event", { type: "state", busy: false }).catch(() => {});
    out({ type: "agent_end", willRetry: false });
    out({ type: "agent_settled" });
  };
  let queue = Promise.resolve();
  while (!stopped) {
    const response = await post("/api/inbox/bridge/poll", { waitMs: 1000, project_path: cwd, started_at: startedAt, busy, idle_since: busy ? null : idleSince }).catch(() => null);
    if (!response) {
      registry = read() || registry;
      await sleep(300);
      continue;
    }
    let commands = [];
    try {
      const parsed = await response.json();
      commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    } catch {}
    for (const command of commands) {
      if (!command || typeof command.id !== "string" || taken.has(command.id)) continue;
      taken.add(command.id);
      queue = queue.then(() => work(command));
    }
  }
}
void extension();
// An extension that asks as the session starts (config `dialogOnStart`), before any turn.
if (config().dialogOnStart) void askDialog();
