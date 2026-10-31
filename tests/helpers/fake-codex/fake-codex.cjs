/**
 * A fake `codex` (CLI 0.165.0, its app-server daemon the managed 0.160.0) for
 * the launch tests: the contract the real one showed in
 * .ops/work/launch-codex/smoke/ (HOST.md "Codex on the same interface"). The
 * real Codex is never run. Node-safe CommonJS, run by the test runtime's own
 * executable (`process.execPath`) through a `/bin/sh` wrapper on PATH.
 *
 * State lives in the folder the wrapper names (`FAKE_CODEX_STATE`):
 *  - config.json    what the test asks for (see FakeCodexConfig in index.ts)
 *  - calls.jsonl    one line per CLI call: argv, cwd, env names
 *  - rpc.jsonl      one line per JSON-RPC request the daemon took: method, params, and whether it answered
 *  - approvals.jsonl  one line per approval request settled: method, params, result, how
 *  - turns.jsonl    one line per turn: thread, turn, text, how it started (turn/start or queue), how it ended
 *  - replies.jsonl  one line per Inbox reply a turn posted
 *  - threads.json   the daemon's threads (kept across a daemon restart, as Codex keeps its rollouts)
 *  - pids.log       the daemon's pid, so the test kills only its own
 *
 * Calls:
 *  --version                      "codex-cli 0.165.0"
 *  app-server daemon start        idempotent: starts the daemon (detached) when its socket does not answer, then
 *                                 prints one JSON line (socketPath, managedCodexVersion, appServerVersion, cliVersion).
 *                                 config `daemonFault: "fail"`: exit 1.
 *  app-server daemon stop         SIGTERM to the daemon
 *  queue --thread=<id> --message=<text>   thread/queue/add: a turn now when the thread is idle, its next turn while one
 *                                 runs; waits (paused) on a thread whose last turn was interrupted. Unknown: exit 1.
 *  resume <id> / mcp ... / anything else   recorded, exit 0
 *
 * The daemon (`__daemon`) serves JSON-RPC over a WebSocket on
 * `$CODEX_HOME/app-server-control/app-server-control.sock` (frames by hand,
 * no "jsonrpc" field, as Codex): initialize, thread/start (writes the
 * folder's trust into config.toml as Codex does unless config.toml or the
 * request's `config.projects` already trusts it), thread/resume (re-sends a
 * pending approval, a new request id, the same item and approval ids),
 * thread/unsubscribe, thread/read, thread/loaded/list, thread/delete,
 * thread/name/set, turn/start, turn/interrupt (never answers with no turn
 * running), turn/steer. A turn plays config `prompts` in order (each a server
 * request to every subscribed connection; it waits for an answer), then
 * after `workMs` (and while `hold`) posts the reply to the Inbox's MCP
 * `send_message` (reply_to the wake's message id, with Codex's `_meta`),
 * found from the thread's `mcp_servers.plannotator-inbox.env.PLANNOTATOR_DATA_DIR`
 * (else the daemon's own), and completes.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const STATE = process.env.FAKE_CODEX_STATE;
const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.HOME || "/nonexistent", ".codex");
const SOCKET = path.join(CODEX_HOME, "app-server-control", "app-server-control.sock");
const CLI_VERSION = "0.165.0";
const SERVER_VERSION = "0.160.0";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const config = () => readJson(path.join(STATE, "config.json"), {});
const append = (name, value) => fs.appendFileSync(path.join(STATE, name), `${JSON.stringify(value)}\n`);

// ── The CLI ──

async function cli(argv) {
  append("calls.jsonl", { argv, cwd: process.cwd(), env: Object.keys(process.env).sort(), at: Date.now() });
  if (argv[0] === "--version") {
    process.stdout.write(`codex-cli ${config().version || CLI_VERSION}\n`);
    return 0;
  }
  if (argv[0] === "app-server" && argv[1] === "daemon" && argv[2] === "start") return daemonStart();
  if (argv[0] === "app-server" && argv[1] === "daemon" && argv[2] === "stop") {
    for (const pid of daemonPids()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    process.stdout.write(`${JSON.stringify({ status: "stopped" })}\n`);
    return 0;
  }
  if (argv[0] === "queue") {
    const thread = (argv.find((a) => a.startsWith("--thread=")) || "").slice("--thread=".length);
    const message = (argv.find((a) => a.startsWith("--message=")) || "").slice("--message=".length);
    const answer = await post("/fake/queue", { threadId: thread, text: message }).catch((error) => ({ status: 0, body: { error: String(error) } }));
    if (answer.status !== 200) {
      process.stderr.write(`Error: ${answer.body && answer.body.error ? answer.body.error : "the app-server did not answer"}\n`);
      return 1;
    }
    process.stdout.write(`queued ${answer.body.id}\n`);
    return 0;
  }
  return 0;
}

function post(route, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: SOCKET, path: route, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

function daemonPids() {
  const file = path.join(STATE, "pids.log");
  return fs.existsSync(file) ? [...new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number))] : [];
}

async function daemonUp() {
  if (!fs.existsSync(SOCKET)) return false;
  return post("/fake/ping", {}).then((r) => r.status === 200, () => false);
}

async function daemonStart() {
  if (config().daemonFault === "fail") {
    process.stderr.write("Error: failed to start the app-server daemon\n");
    return 1;
  }
  if (!(await daemonUp())) {
    fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
    fs.rmSync(SOCKET, { force: true });
    const child = spawn(process.execPath, [__filename, "__daemon"], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    fs.appendFileSync(path.join(STATE, "pids.log"), `${child.pid}\n`);
    const until = Date.now() + 5000;
    while (Date.now() < until && !(await daemonUp())) await sleep(50);
  }
  process.stdout.write(`${JSON.stringify({ status: "running", socketPath: SOCKET, managedCodexVersion: SERVER_VERSION, appServerVersion: SERVER_VERSION, cliVersion: CLI_VERSION })}\n`);
  return 0;
}

// ── The daemon ──

function daemon() {
  /** id → { id, cwd, name, config, approvalPolicy, sandbox, status, turns, loaded, interrupted, queue } */
  const threads = new Map(Object.entries(readJson(path.join(STATE, "threads.json"), {})).map(([id, t]) => [id, { ...t, loaded: false, status: { type: "notLoaded" }, queue: [], running: null, pending: null }]));
  const save = () => {
    const out = {};
    for (const [id, t] of threads) out[id] = { id, cwd: t.cwd, name: t.name, config: t.config, approvalPolicy: t.approvalPolicy, sandbox: t.sandbox, turns: t.turns, interrupted: t.interrupted };
    fs.writeFileSync(path.join(STATE, "threads.json"), JSON.stringify(out));
  };
  const conns = new Set();
  let nextRequest = 1;
  const log = (line) => fs.appendFileSync(path.join(STATE, "daemon.log"), `${new Date().toISOString()} ${line}\n`);

  const notify = (thread, method, params) => {
    for (const c of conns) if (thread.subscribers && thread.subscribers.has(c)) c.send({ method, params });
  };
  const setStatus = (thread, status) => {
    thread.status = status;
    notify(thread, "thread/status/changed", { threadId: thread.id, status });
  };
  const view = (thread, includeTurns) => ({ id: thread.id, cwd: thread.cwd, name: thread.name || null, status: thread.status, ...(includeTurns ? { turns: thread.turns } : {}) });

  /** Codex's trust write (thread_processor.rs): the folder trusted in config.toml unless the file or the request already trusts it. */
  const writeTrust = (cwd, params) => {
    const file = path.join(CODEX_HOME, "config.toml");
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const keyed = (key) => text.includes(`[projects."${key}"]`) || text.includes(`[projects.'${key}']`);
    const projects = (params.config && params.config.projects) || {};
    const overridden = (key) => projects[key] && typeof projects[key].trust_level === "string";
    let real = cwd;
    try {
      real = fs.realpathSync(cwd);
    } catch {}
    if (keyed(cwd) || keyed(real) || overridden(cwd) || overridden(real)) return;
    // Only when the thread's permissions can write the folder: a sandbox the request names, else config.toml's
    // top-level `sandbox_mode`, else read-only (Codex's default for a folder with no trust decision).
    const top = text.split(/^\[/m)[0];
    const mode = params.sandbox || ((/^sandbox_mode\s*=\s*"([^"]+)"/m.exec(top) || [])[1]) || "read-only";
    if (mode !== "workspace-write" && mode !== "danger-full-access") return;
    fs.appendFileSync(file, `\n[projects."${real}"]\ntrust_level = "trusted"\n`);
    log(`wrote trust for ${real}`);
  };

  const load = (thread) => {
    if (!thread.loaded) {
      thread.loaded = true;
      thread.status = { type: "idle" };
      thread.subscribers = new Set();
    }
  };

  /** A server request to every subscriber (the same id to all, as Codex's broadcast), re-sent to a connection that resumes. */
  const ask = (thread, method, params) =>
    new Promise((resolve) => {
      const id = nextRequest++;
      thread.pending = { id, method, params, resolve };
      setStatus(thread, { type: "active", activeFlags: ["waitingOnApproval"] });
      for (const c of conns) if (thread.subscribers.has(c)) c.send({ id, method, params });
      // The person answers in `codex resume` (config localAnswer: this thread): Codex settles it itself.
      const local = () => {
        if (thread.pending && thread.pending.params === params && config().localAnswer === thread.id) {
          settle(thread, { decision: "accept" }, "local");
          return;
        }
        if (thread.pending && thread.pending.params === params) setTimeout(local, 100);
      };
      setTimeout(local, 100);
    });
  const settle = (thread, result, how) => {
    const p = thread.pending;
    if (!p) return;
    thread.pending = null;
    append("approvals.jsonl", { threadId: thread.id, method: p.method, params: p.params, requestId: p.id, result, how, at: Date.now() });
    notify(thread, "serverRequest/resolved", { threadId: thread.id, requestId: p.id });
    if (thread.running && how !== "interrupted") setStatus(thread, { type: "active", activeFlags: [] });
    p.resolve(result);
  };

  const prompt = async (thread, turn, spec) => {
    const itemId = `item-${crypto.randomUUID().slice(0, 8)}`;
    const base = { threadId: thread.id, turnId: turn.id, itemId, approvalId: spec.approvalId || null, startedAtMs: Date.now() };
    if (spec.kind === "fileChange") {
      notify(thread, "item/started", { threadId: thread.id, turnId: turn.id, item: { type: "fileChange", id: itemId, changes: spec.changes, status: "inProgress" } });
      return ask(thread, "item/fileChange/requestApproval", { ...base, reason: spec.reason || null, grantRoot: null });
    }
    if (spec.kind === "permissions") return ask(thread, "item/permissions/requestApproval", { ...base, cwd: thread.cwd, reason: spec.reason || null, permissions: spec.permissions || {} });
    return ask(thread, "item/commandExecution/requestApproval", { ...base, cwd: thread.cwd, command: spec.command, reason: spec.reason || null });
  };

  const runTurn = async (thread, text, how) => {
    load(thread);
    const turn = { id: `turn-${crypto.randomUUID().slice(0, 8)}`, status: "inProgress", items: [] };
    thread.turns.push(turn);
    thread.running = { turn, interrupted: false };
    thread.interrupted = false;
    save();
    const startedAt = Date.now();
    append("turns.jsonl", { threadId: thread.id, turnId: turn.id, text, how, at: startedAt });
    setStatus(thread, { type: "active", activeFlags: [] });
    notify(thread, "turn/started", { threadId: thread.id, turn: { id: turn.id, status: "inProgress", items: [] } });
    // Async: the caller answers turn/start first.
    void (async () => {
      await sleep(50);
      const running = thread.running;
      const outcomes = [];
      for (const spec of config().prompts || []) {
        if (running.interrupted) break;
        const result = await prompt(thread, turn, spec);
        outcomes.push(result && result.decision ? result.decision : result && result.permissions ? `permissions ${JSON.stringify(result.permissions)}` : "none");
      }
      const until = Date.now() + (config().workMs ?? 300);
      while (!running.interrupted && (Date.now() < until || config().hold)) await sleep(50);
      if (!running.interrupted) await reply(thread, turn, text, outcomes, startedAt);
      if (thread.running !== running) return;
      thread.running = null;
      turn.status = running.interrupted ? "interrupted" : "completed";
      append("turns.jsonl", { threadId: thread.id, turnId: turn.id, ended: turn.status, at: Date.now() });
      save();
      notify(thread, "turn/completed", { threadId: thread.id, turn: { id: turn.id, status: turn.status, items: [], error: null } });
      if (thread.loaded) setStatus(thread, { type: "idle" });
      // The next queued message, unless the turn was interrupted (Codex keeps the queue waiting then).
      if (!running.interrupted && thread.queue.length > 0) {
        const next = thread.queue.shift();
        void runTurn(thread, next.text, "queue");
      }
    })();
    return turn;
  };

  /** The agent's answer, in the Inbox: `send_message` reply_to the wake's message, as Codex's MCP client calls it. */
  const reply = async (thread, turn, text, outcomes, startedAt) => {
    const id = /^Plannotator Inbox: .*\((msg_[A-Za-z0-9_-]+)\)\s*$/m.exec(text);
    if (!id) return;
    const dataDir = (thread.config && thread.config["mcp_servers.plannotator-inbox.env.PLANNOTATOR_DATA_DIR"]) || process.env.PLANNOTATOR_DATA_DIR;
    const registry = dataDir ? readJson(path.join(dataDir, "inbox", "inbox.json"), null) : null;
    if (!registry) return log(`no Inbox to answer ${id[1]} (data dir ${dataDir})`);
    const tools = outcomes.length > 0 ? ` [${outcomes.join(", ")}]` : "";
    const body = config().body || `${config().answer || "Done"} (turn ${thread.turns.length})${tools}`;
    const meta = { threadId: thread.id, "x-codex-turn-metadata": { thread_id: thread.id, turn_id: turn.id, turn_started_at_unix_ms: startedAt, codex_version: SERVER_VERSION } };
    const response = await fetch(`http://127.0.0.1:${registry.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "send_message", arguments: { body, reply_to: id[1], project_path: thread.cwd, agent_session: thread.id, agent_host: "codex" }, _meta: meta },
      }),
    }).catch((error) => ({ status: 0, text: async () => String(error) }));
    append("replies.jsonl", { threadId: thread.id, turnId: turn.id, replyTo: id[1], body, status: response.status, at: Date.now() });
  };

  const methods = {
    initialize: () => ({ userAgent: `fake-codex/${SERVER_VERSION}`, codexHome: CODEX_HOME, platformFamily: "unix", platformOs: "macos" }),
    "thread/start": (params, c) => {
      writeTrust(params.cwd, params);
      const id = crypto.randomUUID();
      const thread = { id, cwd: params.cwd, name: null, config: params.config || {}, approvalPolicy: params.approvalPolicy || "on-request", sandbox: params.sandbox || "workspace-write", turns: [], interrupted: false, queue: [], running: null, pending: null, loaded: false };
      threads.set(id, thread);
      load(thread);
      thread.subscribers.add(c);
      save();
      return { thread: view(thread), model: "fake", cwd: thread.cwd, approvalPolicy: thread.approvalPolicy, sandbox: { type: thread.sandbox === "danger-full-access" ? "dangerFullAccess" : "workspaceWrite" } };
    },
    "thread/resume": (params, c) => {
      const thread = threads.get(params.threadId);
      if (!thread) throw { code: -32600, message: `no rollout found for thread id ${params.threadId}` };
      load(thread);
      if (params.config) thread.config = { ...thread.config, ...params.config };
      thread.subscribers.add(c);
      // A pending approval is sent again to the connection that rejoined: a new request id, the same item.
      if (thread.pending) {
        const again = nextRequest++;
        const p = thread.pending;
        setTimeout(() => {
          if (thread.pending !== p) return;
          p.id = again;
          c.send({ id: again, method: p.method, params: p.params });
        }, 30);
      }
      return { thread: view(thread, !params.excludeTurns), model: "fake", cwd: thread.cwd, approvalPolicy: thread.approvalPolicy, sandbox: { type: "workspaceWrite" } };
    },
    "thread/unsubscribe": (params, c) => {
      const thread = threads.get(params.threadId);
      if (!thread || !thread.loaded || !thread.subscribers.has(c)) return { status: "notSubscribed" };
      thread.subscribers.delete(c);
      if (config().unloadOnUnsubscribe && thread.subscribers.size === 0 && !thread.running) {
        thread.loaded = false;
        thread.status = { type: "notLoaded" };
      }
      return { status: "unsubscribed" };
    },
    "thread/read": (params) => {
      const thread = threads.get(params.threadId);
      if (!thread) throw { code: -32600, message: `thread not found: ${params.threadId}` };
      return { thread: view(thread, params.includeTurns) };
    },
    "thread/loaded/list": () => ({ data: [...threads.values()].filter((t) => t.loaded).map((t) => t.id), nextCursor: null }),
    "thread/delete": (params) => {
      const thread = threads.get(params.threadId);
      if (!thread) throw { code: -32600, message: `thread not found: ${params.threadId}` };
      if (thread.running) thread.running.interrupted = true;
      threads.delete(params.threadId);
      save();
      return {};
    },
    "thread/name/set": (params) => {
      const thread = threads.get(params.threadId);
      if (thread) thread.name = params.name;
      save();
      return {};
    },
    "turn/start": (params, c) => {
      const thread = threads.get(params.threadId);
      if (!thread || !thread.loaded) throw { code: -32600, message: `thread not found: ${params.threadId}` };
      if (thread.running) throw { code: -32600, message: "a turn is already running" };
      const text = (params.input || []).map((i) => i.text || "").join("\n");
      const turn = runTurn(thread, text, "turn/start");
      // The turn starts, and the connection drops before its answer (config dropOnTurnStart).
      if (config().dropOnTurnStart) return turn.then(() => (c.drop(), NO_ANSWER));
      return turn.then((t) => ({ turn: { id: t.id, status: "inProgress", items: [], error: null } }));
    },
    "turn/interrupt": (params) => {
      const thread = threads.get(params.threadId);
      // Codex answers only once the running turn it names has stopped: with none, never.
      if (!thread || !thread.running || thread.running.turn.id !== params.turnId) return NO_ANSWER;
      thread.running.interrupted = true;
      thread.interrupted = true;
      const running = thread.running;
      thread.running = null;
      running.turn.status = "interrupted";
      append("turns.jsonl", { threadId: thread.id, turnId: running.turn.id, ended: "interrupted", at: Date.now() });
      save();
      notify(thread, "turn/completed", { threadId: thread.id, turn: { id: running.turn.id, status: "interrupted", items: [], error: null } });
      if (thread.pending) settle(thread, null, "interrupted");
      setStatus(thread, { type: "idle" });
      return {};
    },
    "turn/steer": (params) => {
      const thread = threads.get(params.threadId);
      if (!thread || !thread.running || thread.running.turn.id !== params.expectedTurnId) throw { code: -32600, message: "no turn to steer" };
      append("turns.jsonl", { threadId: thread.id, turnId: params.expectedTurnId, steer: (params.input || []).map((i) => i.text || "").join("\n"), at: Date.now() });
      return { turnId: params.expectedTurnId };
    },
  };
  const NO_ANSWER = Symbol("no answer");

  const handle = async (c, message) => {
    if (message.method && message.id === undefined) return; // `initialized` and other notifications.
    if (message.method === undefined && message.id !== undefined) {
      // An answer to an approval request.
      for (const thread of threads.values()) {
        if (thread.pending && thread.pending.id === message.id) {
          settle(thread, message.result ?? null, "answered");
          return;
        }
      }
      log(`an answer to no pending request: ${JSON.stringify(message)}`);
      return;
    }
    const fn = methods[message.method];
    append("rpc.jsonl", { method: message.method, params: message.params, at: Date.now() });
    if (!fn) return c.send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
    try {
      const result = await fn(message.params || {}, c);
      if (result === NO_ANSWER) return;
      c.send({ id: message.id, result });
    } catch (error) {
      c.send({ id: message.id, error: { code: error && error.code ? error.code : -32603, message: error && error.message ? error.message : String(error) } });
    }
  };

  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = (() => {
      try {
        return JSON.parse(text || "{}");
      } catch {
        return {};
      }
    })();
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/fake/ping") return send(200, { ok: true });
    if (req.url === "/fake/queue") {
      // thread/queue/add, as `codex queue` calls it on the shared daemon.
      append("rpc.jsonl", { method: "thread/queue/add", params: body, at: Date.now() });
      const thread = threads.get(body.threadId);
      if (!thread) return send(404, { error: `thread not found: ${body.threadId}` });
      load(thread);
      const id = `queued-${crypto.randomUUID().slice(0, 8)}`;
      if (!thread.running && !thread.interrupted) void runTurn(thread, body.text, "queue");
      else thread.queue.push({ id, text: body.text });
      return send(200, { id });
    }
    send(404, { error: "not found" });
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const frame = (opcode, payload) => {
      const len = payload.length;
      const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : (() => {
        const b = Buffer.alloc(10);
        b[0] = 0x80 | opcode;
        b[1] = 127;
        b.writeBigUInt64BE(BigInt(len), 2);
        return b;
      })();
      if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
    };
    const c = { send: (value) => frame(1, Buffer.from(JSON.stringify(value))), drop: () => socket.destroy() };
    conns.add(c);
    let buffer = Buffer.alloc(0);
    let fragments = [];
    const gone = () => {
      if (!conns.delete(c)) return;
      for (const thread of threads.values()) if (thread.subscribers) thread.subscribers.delete(c);
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let at = 2;
        if (len === 126) {
          if (buffer.length < 4) return;
          len = buffer.readUInt16BE(2);
          at = 4;
        } else if (len === 127) {
          if (buffer.length < 10) return;
          len = Number(buffer.readBigUInt64BE(2));
          at = 10;
        }
        const maskAt = at;
        if (masked) at += 4;
        if (buffer.length < at + len) return;
        const payload = Buffer.from(buffer.subarray(at, at + len));
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buffer[maskAt + (i % 4)];
        buffer = buffer.subarray(at + len);
        if (opcode === 8) {
          frame(8, Buffer.alloc(0));
          socket.end();
          gone();
          return;
        }
        if (opcode === 9) {
          frame(10, payload);
          continue;
        }
        if (opcode === 1 || opcode === 0) {
          fragments.push(payload);
          if (!fin) continue;
          const text = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          let message;
          try {
            message = JSON.parse(text);
          } catch {
            continue;
          }
          void handle(c, message);
        }
      }
    });
    socket.on("close", gone);
    socket.on("error", gone);
  });

  fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
  fs.rmSync(SOCKET, { force: true });
  server.listen(SOCKET, () => log(`listening on ${SOCKET} (pid ${process.pid})`));
  const stop = () => {
    log("stopping");
    try {
      fs.rmSync(SOCKET, { force: true });
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[2] === "__daemon") daemon();
else
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`fake codex: ${error && error.stack ? error.stack : error}\n`);
      process.exit(2);
    },
  );
