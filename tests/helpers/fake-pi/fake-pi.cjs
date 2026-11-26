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
 *    for the id is reopened (its lines are the context); with none, Pi's
 *    warning on stderr and a new one. stdin's end ends the process with exit 0,
 *    as Pi's RPC mode does (exits.jsonl says whether `abort` came first).
 *  - `pi --session-id <uuid>` alone: Pi in a terminal on the session (Open in
 *    Terminal). No RPC; the extension below only; it ends on SIGTERM or SIGINT.
 *  - It acts as Plannotator's Pi extension: it polls the bridge of the Inbox in
 *    `$PLANNOTATOR_DATA_DIR` (else ~/.plannotator) as host `pi`, session
 *    `<uuid>`, only when `PLANNOTATOR_INBOX_TOOL` is on. A command: `delivered`,
 *    `agent_start`, busy, an optional extension dialog (`extension_ui_request`,
 *    waiting for the `extension_ui_response`), then the answer through the
 *    Inbox's MCP `send_message`, idle, `agent_settled`. With `turnError` the
 *    turn instead ends as a provider error does (no answer; `agent_end` whose
 *    last assistant message has `stopReason: "error"` and `errorMessage`).
 *  - Its title is `pi`, as Pi sets it, so `ps` lists neither `--mode rpc` nor
 *    `--session-id`. As the extension does, it claims its session in
 *    `<data dir>/inbox/pi-sessions/<uuid>.<pid>.json` as it starts (the Inbox
 *    tool on or off, only where `inbox/inbox.json` exists) and removes the
 *    claim as it ends.
 *
 * With FAKE_PI_AS=omp it is a fake `omp` (Oh My Pi, tests/helpers/fake-omp) instead, as Oh My Pi 19.2.1's
 * source has it: titled `omp`; `omp --version` prints `omp/<version>`; `omp --mode rpc` prints its `ready`
 * frame first and makes its own session id (no `--session-id`), named over RPC (`set_session_name`);
 * `--resume <id>` reopens that session's file (any cwd's folder) and exits 1 with `Session "<id>" not found.`
 * when there is none; the file is written only from the first answer on; sessions live under
 * `$PI_CODING_AGENT_DIR` else `~/.omp/agent`, in Oh My Pi's folder names (`-tmp-<relative>` under the temp
 * root, `-<relative>` under home, else `--<absolute>--`); `omp --resume <id>` alone is the terminal's. Its
 * extension polls as host `pi` and says `plugin.host: "oh-my-pi"`, as Plannotator's Pi extension does there.
 * Config `autoResume`: a start with no `--resume` reopens the newest session in its folder (Oh My Pi's Auto Resume
 * setting); RPC `new_session` then makes a new id with its file on disk at once (`newSessionCancelled`: an
 * extension refused it). Config `resumeAs`: `--resume <id>` answers as another copy of that conversation, a new id
 * whose header points back (`continuation`: `continuationOf` and `parentSession`; `fork`: `parentSession`), or as
 * `stranger`, a new id that points back to nothing. rpc.jsonl lists each `new_session`.
 * As Oh My Pi's RPC mode, every frame but a dialog's answer is held until the `session_start` handlers are done (a
 * start dialog answered, the extension's poll under way, config `startMs`); `new_session` cancels a turn under way
 * (cancelled.jsonl: delivered, never answered); Auto Resume never picks a session with no turn, nor one another live
 * process writes (`<state>/leases/`). Its extension sends `continues` (the ids its header leads back to) and, started
 * with `PLANNOTATOR_INBOX_NEW_SESSION`, polls nothing as a session Auto Resume opened until `new_session`, as
 * Plannotator's Pi extension does on Oh My Pi. A `form` dialog (its `ask` tool) carries HTML, no title.
 *
 * State in $FAKE_PI_STATE: config.json (read on each use), calls.jsonl (argv,
 * cwd, env names, the data dir and Inbox-tool values it got), pids.log,
 * delivered.log, dialogs.jsonl (each dialog and the answer it got), exits.jsonl.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const OMP = process.env.FAKE_PI_AS === "omp";
// As Pi does (cli/setup.js, bundle/cli-runtime.js), and Oh My Pi (cli.ts): `ps` then shows this process by that name alone, never its argv.
process.title = OMP ? "omp" : "pi";

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
  // When this process started (for the helper's `alive`: a pid another program reused started later).
  startedAt: Date.now() - Math.round(process.uptime() * 1000),
  at: Date.now(),
});

if (args[0] === "--version") {
  process.stdout.write(OMP ? `omp/${config().version || "19.2.1"}\n` : `${config().version || "0.85.1"}\n`);
  process.exit(0);
}

// Without `--mode rpc`: Pi in a terminal on `--session-id` (Open in Terminal, Copy attach command). No RPC;
// the extension's bridge poll only (with the Inbox tool on, as there); it runs until SIGTERM or SIGINT.
const terminal = flag("--mode") !== "rpc";
const ID_FLAG = OMP ? "--resume" : "--session-id";
if (terminal && !flag(ID_FLAG)) {
  process.stderr.write("fake pi: only --version, --mode rpc and a terminal on --session-id\n");
  process.exit(2);
}

// `let`: Oh My Pi's session id changes on `new_session`, on Auto Resume and on a resume that answers as another copy.
let sessionId = flag(ID_FLAG) || (OMP ? crypto.randomUUID() : undefined);
if (!terminal && config().startFail) {
  process.stderr.write(`${config().startFail}\n`);
  process.exit(1);
}
fs.appendFileSync(path.join(STATE, "pids.log"), `${process.pid}\n`);

// ── The session file ──
const home = process.env.HOME || "";
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, OMP ? ".omp" : ".pi", "agent");
const cwd = path.resolve(process.cwd());
/** Oh My Pi's folder name for a cwd: the temp root first, then home, else the absolute path. */
const ompDirName = (at) => {
  const real = fs.realpathSync(at);
  const within = (root) => {
    const rel = path.relative(fs.realpathSync(root), real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) ? rel : null;
  };
  const encode = (prefix, rel) => (rel ? (prefix.endsWith("-") ? `${prefix}${rel.replace(/[/\\:]/g, "-")}` : `${prefix}-${rel.replace(/[/\\:]/g, "-")}`) : prefix);
  const tmp = within(require("node:os").tmpdir());
  if (tmp !== null) return encode("-tmp", tmp);
  const inHome = home ? within(home) : null;
  if (inHome !== null) return encode("-", inHome);
  return `--${real.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
};
const sessionDir = path.join(agentDir, "sessions", OMP ? ompDirName(cwd) : `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
fs.mkdirSync(sessionDir, { recursive: true });
let sessionFile = fs.readdirSync(sessionDir).find((name) => name.endsWith(`_${sessionId}.jsonl`));
if (OMP && !sessionFile && flag("--resume")) {
  // `--resume <id>` finds the session in any cwd's folder; none: Oh My Pi's error, exit 1.
  const root = path.join(agentDir, "sessions");
  for (const dir of fs.readdirSync(root)) {
    const found = fs.readdirSync(path.join(root, dir)).find((name) => name.endsWith(`_${sessionId}.jsonl`));
    if (found) sessionFile = path.join("..", dir, found);
  }
  if (!sessionFile) {
    process.stderr.write(`Session "${sessionId}" not found.\n`);
    process.exit(1);
  }
}
/** Oh My Pi writes a new session's file only from its first answer on: the lines wait until then. */
let unwritten = null;
const idOfFile = (name) => /_([0-9a-f-]{36})\.jsonl$/i.exec(name)?.[1];
/** Each session's lease (`<state>/leases/<id>`: the pid writing it), as Oh My Pi's session storage claims a file it writes. */
const leases = path.join(STATE, "leases");
const lease = () => {
  try {
    fs.mkdirSync(leases, { recursive: true });
    fs.writeFileSync(path.join(leases, sessionId), String(process.pid));
  } catch {}
};
const heldElsewhere = (id) => {
  try {
    const pid = Number(fs.readFileSync(path.join(leases, id), "utf8"));
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** The newest session in this folder with a turn in it (session-listing.ts findMostRecentNonEmptySession: an empty one is never picked). */
const newestHere = () =>
  fs
    .readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl") && idOfFile(name) && fs.readFileSync(path.join(sessionDir, name), "utf8").split("\n").filter(Boolean).length > 1)
    .sort()
    .at(-1);
// Auto Resume on (main.ts createSessionManager: `continueRecent`): the newest session in this folder, not a new one;
// a new one after all when another live process writes that one (session-storage.ts isSessionOwnedElsewhere).
const recent = OMP && !terminal && !flag("--resume") && config().autoResume ? newestHere() : undefined;
if (recent && !heldElsewhere(idOfFile(recent))) {
  sessionFile = recent;
  sessionId = idOfFile(sessionFile);
}
if (sessionFile) sessionFile = path.resolve(sessionDir, sessionFile);
if (OMP && !terminal && sessionFile && flag("--resume") && config().resumeAs) {
  // `--resume <id>` answering as another copy of the conversation (session-listing.ts findSessionContinuation, a
  // `continuationOf` sibling; session-transfer.ts forkIfMovedAway, a fork): a new id, its header pointing back
  // through `parentSession` (and `continuationOf`). "stranger": a new id that points back to nothing.
  const kind = config().resumeAs;
  const [head, ...rest] = fs.readFileSync(sessionFile, "utf8").split("\n").filter(Boolean);
  const previous = JSON.parse(head);
  const next = config().resumeId || crypto.randomUUID();
  const header = { ...previous, id: next, timestamp: new Date().toISOString(), ...(kind === "stranger" ? {} : { parentSession: previous.id }), ...(kind === "continuation" ? { continuationOf: previous.id } : {}) };
  if (kind === "stranger") delete header.parentSession;
  const to = path.join(path.dirname(sessionFile), `${new Date().toISOString().replace(/[:.]/g, "-")}_${next}.jsonl`);
  fs.writeFileSync(to, [JSON.stringify(header), ...rest].map((line) => `${line}\n`).join(""));
  sessionFile = to;
  sessionId = next;
} else if (sessionFile) {
  // Opened as it is.
} else if (OMP) {
  sessionFile = path.join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  unwritten = [`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`];
} else {
  // As Pi 0.85.1 (main.js): no file for the id, so a new session with that id, and this warning.
  process.stderr.write(`Warning: No project session found with id '${sessionId}'; creating a new session with that id.\n`);
  sessionFile = path.join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`);
}
const messageCount = () => (unwritten ? unwritten.join("") : fs.readFileSync(sessionFile, "utf8")).split("\n").filter(Boolean).length - 1;
/** One line of the session file (Oh My Pi's: held until an answer is written). */
const writeLine = (entry, answer = false) => {
  const line = `${JSON.stringify(entry)}\n`;
  if (unwritten && !answer) return void unwritten.push(line);
  if (unwritten) {
    fs.writeFileSync(sessionFile, unwritten.join(""));
    unwritten = null;
  }
  fs.appendFileSync(sessionFile, line);
};
let sessionName = flag("--name");
if (OMP && !terminal) lease();

// ── The extension: the session claim (packages/shared/inbox/pi-session-claim.ts) ──
// The default data dir only inside a scratch HOME: never the account's real ~/.plannotator.
const scratchHome = (() => {
  try {
    const real = fs.realpathSync(home);
    return [require("node:os").tmpdir(), "/tmp", "/private/tmp"].some((root) => {
      try {
        return real.startsWith(`${fs.realpathSync(root)}/`);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
})();
const claimDataDir = process.env.PLANNOTATOR_DATA_DIR || (scratchHome ? path.join(home, ".plannotator") : null);
// As the extension: only on a computer that has run the Inbox (`inbox/inbox.json`).
const claimRoot = claimDataDir && fs.existsSync(path.join(claimDataDir, "inbox", "inbox.json")) ? path.join(claimDataDir, "inbox", "pi-sessions") : null;
let claimFile = null;
/** Claim the session it runs now, the previous claim released (the extension does so on each session start or switch). */
const claim = () => {
  if (!claimRoot) return;
  try {
    if (claimFile) fs.rmSync(claimFile, { force: true });
    claimFile = path.join(claimRoot, `${sessionId}.${process.pid}.json`);
    fs.mkdirSync(claimRoot, { recursive: true });
    fs.writeFileSync(claimFile, JSON.stringify({ session: sessionId, pid: process.pid, rpc: !terminal, title: process.title, owner: "fake-pi" }));
  } catch {}
};
claim();
if (claimRoot) {
  process.on("exit", () => {
    try {
      if (claimFile) fs.rmSync(claimFile, { force: true });
    } catch {}
  });
}

// ── RPC ──
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
// Oh My Pi's first frame (rpc-mode.ts): before any answer.
if (OMP && !terminal) out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
const dialogs = new Map();
let stopped = false;
let aborted = false;
let input = "";
if (terminal) {
  // Pi in a terminal: it reads keys, never RPC; it ends when the person quits (a signal here).
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      stopped = true;
      append("exits.jsonl", { sessionId, pid: process.pid, why: signal, terminal: true, at: Date.now() });
      process.exit(0);
    });
  }
  // Up until the person quits, connected or not (the Inbox tool off: no bridge poll keeps it running).
  setInterval(() => {}, 1 << 30);
} else process.stdin.setEncoding("utf8");
/**
 * Oh My Pi reads stdin from its start but holds every frame except a dialog's answer until its extensions'
 * `session_start` handlers are done (rpc-mode.ts `heldFrames`): a start dialog answered, Plannotator's extension's
 * bridge poll under way, and config `startMs` for other extensions' handlers. `get_state` waits with the rest.
 */
let held = OMP && !terminal ? [] : null;
/** Bumped by `new_session`: a turn under way when it changes is cancelled (agent-session.ts newSession aborts the run). */
let turnGeneration = 0;
if (!terminal) process.stdin.on("data", (chunk) => {
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
    if (held) held.push(command);
    else handle(command);
  }
});
function handle(command) {
  if (command.type === "prompt") {
    // A prompt over RPC: a turn of its own here (its dialog, if configured), with no Inbox answer.
    out({ id: command.id, type: "response", command: "prompt", success: true });
    void localTurn();
    return;
  }
  if (command.type === "get_state") {
    // Config `stateId`: the id it reports instead of its own (an answer that is not a session id).
    const answer = () => out({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: config().stateId ?? sessionId, sessionFile, messageCount: messageCount(), isStreaming: busy, sessionName } });
    // A Pi slow to come up (config `readyDelayMs`): its first answer waits.
    const delay = config().readyDelayMs ?? 0;
    if (delay > 0) setTimeout(answer, delay);
    else answer();
    return;
  }
  if (command.type === "abort") aborted = true;
  if (OMP && command.type === "new_session") {
    append("rpc.jsonl", { type: "new_session", from: sessionId });
    // An extension's `session_before_switch` may cancel it (agent-session.ts newSession): the session stays.
    if (config().newSessionCancelled) {
      out({ id: command.id, type: "response", command: "new_session", success: true, data: { cancelled: true } });
      return;
    }
    // The run under way ends unanswered (agent-session.ts newSession aborts it first).
    turnGeneration += 1;
    // A new id, its file on disk at once with its header alone (session-manager.ts newSession: ensureOnDisk).
    sessionId = crypto.randomUUID();
    sessionFile = path.join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
    unwritten = null;
    fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`);
    sessionName = undefined;
    claim();
    lease();
    out({ id: command.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
    return;
  }
  if (OMP && command.type === "set_session_name") {
    sessionName = command.name;
    append("names.jsonl", { sessionId, name: command.name });
  }
  out({ id: command.id, type: "response", command: command.type, success: true });
}
if (!terminal) {
  process.stdin.on("end", () => {
    stopped = true;
    append("exits.jsonl", { sessionId, pid: process.pid, why: "stdin", aborted, at: Date.now() });
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    append("exits.jsonl", { sessionId, pid: process.pid, why: "SIGTERM", aborted, at: Date.now() });
    process.exit(143);
  });
}

// ── A turn's extension dialog: asked over RPC, answered (or not) by the client ──
let busy = false;
async function askDialog() {
  const spec = config().dialog;
  if (!spec) return null;
  const id = crypto.randomUUID();
  const got = new Promise((resolve) => dialogs.set(id, resolve));
  // Oh My Pi's `form` (its `ask` tool in RPC mode) has no title: the whole form as HTML.
  const method = spec.method || "select";
  out({ type: "extension_ui_request", id, method, ...(method === "form" ? { html: spec.html ?? `<form><h1>${spec.title}</h1></form>` } : { title: spec.title }), ...(spec.options ? { options: spec.options } : {}) });
  const answered = await Promise.race([got, sleep(10_000).then(() => null)]);
  append("dialogs.jsonl", { sessionId, title: spec.title, response: answered });
  return { answered };
}
async function localTurn() {
  busy = true;
  out({ type: "agent_start" });
  await askDialog();
  if (await errorEnd()) return;
  busy = false;
  out({ type: "agent_end", willRetry: false });
  out({ type: "agent_settled" });
}

/**
 * A turn that ends in an error (config `turnError`), as Pi's agent loop ends one: the run's last assistant
 * message has `stopReason: "error"` and the provider's `errorMessage`, and nothing is answered. `retries`
 * runs end in the same error with `willRetry: true` first (each followed by `auto_retry_start` and a new
 * `agent_start`), then `auto_retry_end`; `settles: false` is a Pi before 0.80.4 (no `agent_settled`).
 */
async function errorEnd() {
  const { turnError, retries = 0, settles } = config();
  if (!turnError) return false;
  const failed = { role: "assistant", content: [{ type: "text", text: "" }], provider: "openai-codex", model: "gpt-5.5", stopReason: "error", errorMessage: turnError, timestamp: Date.now() };
  for (let attempt = 1; attempt <= retries; attempt++) {
    out({ type: "agent_end", messages: [failed], willRetry: true });
    out({ type: "auto_retry_start", attempt, maxAttempts: retries, delayMs: 50, errorMessage: turnError });
    await sleep(50);
    out({ type: "agent_start" });
  }
  writeLine({ type: "message", message: failed }, true);
  busy = false;
  out({ type: "agent_end", messages: [{ role: "user", content: "the prompt", timestamp: Date.now() }, failed], willRetry: false });
  if (retries > 0) out({ type: "auto_retry_end", success: false, attempt: retries, finalError: turnError });
  if (settles !== false) out({ type: "agent_settled" });
  return true;
}

// ── The extension: the bridge poll ──
const on = (value) => ["1", "true", "on"].includes(String(value || "").toLowerCase());
/** The extension's `session_start` is done (its bridge poll under way, or it does not connect). */
let extensionStarted;
const extensionStart = new Promise((resolve) => (extensionStarted = resolve));
/**
 * As Plannotator's Pi extension does on Oh My Pi (ompContinuesLine): the ids the session's header leads back to,
 * `continuationOf` else `parentSession`, each earlier header found by its id beside the file. The poll's `continues`.
 */
const continuesLine = () => {
  if (!OMP) return [];
  const headerOf = (text) => {
    try {
      return JSON.parse(text.split("\n", 1)[0]);
    } catch {
      return null;
    }
  };
  const readHeader = (file) => {
    try {
      return headerOf(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const dir = path.dirname(sessionFile);
  let at = unwritten ? headerOf(unwritten[0]) : readHeader(sessionFile);
  const line = [];
  const seen = new Set([sessionId]);
  while (at && line.length < 8) {
    const back = at.continuationOf || at.parentSession;
    if (typeof back !== "string" || seen.has(back)) break;
    seen.add(back);
    line.push(back);
    const name = fs.readdirSync(dir).find((entry) => entry.endsWith(`_${back}.jsonl`));
    at = name ? readHeader(path.join(dir, name)) : null;
  }
  return line;
};
/**
 * As the extension does on Oh My Pi: started by the Inbox for a new session (`PLANNOTATOR_INBOX_NEW_SESSION`), a session
 * Auto Resume opened instead (one with turns) is polled for nothing until the session changes (`new_session`).
 */
const reopened = OMP && process.env.PLANNOTATOR_INBOX_NEW_SESSION === "1" && messageCount() > 0 ? sessionId : null;
async function extension() {
  // `noConnect` is the RPC process's; a terminal's Pi connects whenever the Inbox tool is on.
  if (!on(process.env.PLANNOTATOR_INBOX_TOOL) || (!terminal && config().noConnect)) return extensionStarted();
  if (!process.env.PLANNOTATOR_DATA_DIR && !scratchHome) {
    process.stderr.write(`fake pi: no PLANNOTATOR_DATA_DIR and HOME (${home || "unset"}) is not a scratch folder; not connecting\n`);
    return extensionStarted();
  }
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
  // Its `session_start` never waits for an Inbox to come up.
  if (!registry) extensionStarted();
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
      body: JSON.stringify({ session: sessionId, host: "pi", ...(OMP ? { plugin: { version: "0.28.70", on_disk: "0.28.70", host: "oh-my-pi" } } : {}), ...body }),
    });
  const taken = new Set();
  const work = async (command) => {
    await post("/api/inbox/bridge/event", { type: "delivered", id: command.id }).catch(() => {});
    append("delivered.log", command.id);
    const context = messageCount();
    busy = true;
    out({ type: "agent_start" });
    await post("/api/inbox/bridge/event", { type: "state", busy: true }).catch(() => {});
    writeLine({ type: "message", role: "user", text: command.body.split("\n")[0] });
    const generation = turnGeneration;
    const asked = terminal ? null : await askDialog();
    const until = Date.now() + (config().workMs ?? 600);
    while (!stopped && generation === turnGeneration && (Date.now() < until || config().hold)) await sleep(100);
    if (stopped) return;
    if (generation !== turnGeneration) {
      // `new_session` cancelled the run: delivered, never answered.
      append("cancelled.jsonl", { id: command.id, sessionId, at: Date.now() });
      busy = false;
      out({ type: "agent_end", willRetry: false });
      out({ type: "agent_settled" });
      return;
    }
    if (!terminal && config().turnError) {
      // The provider refused the turn: no answer through the Inbox, only the run's end on RPC.
      idleSince = new Date().toISOString();
      await post("/api/inbox/bridge/event", { type: "state", busy: false }).catch(() => {});
      await errorEnd();
      return;
    }
    const first = command.body.split("\n")[0].slice(0, 60);
    const dialogPart = asked ? ` [dialog ${asked.answered && asked.answered.cancelled ? "cancelled" : "unanswered"}]` : "";
    const body = `${config().answer || "Done"}: ${first} (context ${context})${dialogPart}`;
    await fetch(`http://127.0.0.1:${registry.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body, reply_to: command.id, project_path: cwd, agent_session: sessionId, agent_host: "pi", agent_name: "Pi" } } }),
    }).catch(() => {});
    writeLine({ type: "message", role: "assistant", text: body }, true);
    busy = false;
    idleSince = new Date().toISOString();
    await post("/api/inbox/bridge/event", { type: "state", busy: false }).catch(() => {});
    out({ type: "agent_end", willRetry: false });
    out({ type: "agent_settled" });
  };
  let queue = Promise.resolve();
  while (!stopped) {
    if (reopened !== null && sessionId === reopened) {
      extensionStarted();
      await sleep(100);
      continue;
    }
    const continues = continuesLine();
    const polling = post("/api/inbox/bridge/poll", { waitMs: 1000, project_path: cwd, started_at: startedAt, busy, idle_since: busy ? null : idleSince, ...(continues.length > 0 ? { continues } : {}) }).catch(() => null);
    // The extension's `session_start` returns once its poll is under way.
    extensionStarted();
    const response = await polling;
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
const startDialog = !terminal && config().dialogOnStart ? askDialog() : Promise.resolve();
// Every `session_start` handler done (the dialog answered, the extension's poll under way, config `startMs` for other
// extensions'): the frames held meanwhile are handled, in the order they came.
if (held) {
  void Promise.all([startDialog, extensionStart, sleep(config().startMs ?? 0)]).then(() => {
    const frames = held;
    held = null;
    for (const command of frames) handle(command);
  });
}
// A turn as the session starts (config `turnOnStart`), as an extension's own prompt would run one.
if (!terminal && config().turnOnStart) setTimeout(() => void localTurn(), 200);
