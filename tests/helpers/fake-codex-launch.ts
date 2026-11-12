/**
 * A fake `codex` for launch (packages/server/inbox-launch-codex.ts): a scratch `bin/codex` that answers
 * `--version`, `login status` and `queue`, and speaks the subset of `codex app-server` JSON-RPC over stdio a launch
 * uses: `initialize`, `account/read`, `account/rateLimits/read`, `thread/start`, `thread/resume`, `thread/name/set`,
 * `turn/start` (a turn started during another one waits for it, or is refused with `refuseSecondTurn`), `turn/steer`,
 * `turn/interrupt`, with `turn/started` and `turn/completed` notifications. A turn whose text holds `APPROVE` asks a
 * command approval first and waits for the answer; one holding `ASK` asks `item/tool/requestUserInput`; one holding
 * `SLOW` runs until it is interrupted. Every start, call, answer and stop goes to `calls.jsonl`. The real Codex is
 * never run, and nothing reads the person's `~/.codex`.
 *
 * Runs under Bun and node. POSIX only.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeCodexLaunchState {
  /** `codex --version`'s line. */
  version?: string;
  /** `codex login status` and `account/read`: signed in with ChatGPT (the default), an API key, or not at all. */
  login?: "chatgpt" | "apikey" | "none";
  /** `account/read`'s plan. */
  plan?: string;
  /** `account/rateLimits/read`'s `rateLimits`, or "fail". */
  rateLimits?: Record<string, unknown> | "fail";
  /** How long a turn runs (ms). */
  turnMs?: number;
  /** Every turn fails with this error message. */
  failTurn?: string | null;
  /** `turn/start` during a turn is refused (as an older Codex might), so the text must be steered in. */
  refuseSecondTurn?: boolean;
  /** `thread/resume` is refused as another Codex holding the thread. */
  heldElsewhere?: boolean;
  models?: { id: string; efforts: string[]; hidden?: boolean }[] | "fail";
  /** No `codex` at all: the script exits 127. */
  gone?: boolean;
}

export type FakeCodexLaunchCall =
  | { event: "start"; pid: number; argv: string[]; cwd: string; env: Record<string, string> }
  | { event: "call"; pid: number; method: string; params: Record<string, any> }
  | { event: "answer"; pid: number; method: string; result: unknown }
  | { event: "stop"; pid: number; why: string }
  | { event: "cli"; pid: number; argv: string[] };

export interface FakeCodexLaunch {
  bin: string;
  set(state: FakeCodexLaunchState): void;
  calls(): FakeCodexLaunchCall[];
  /** Every JSON-RPC call (`initialize` included) with its params. */
  rpc(method?: string): { pid: number; method: string; params: Record<string, any> }[];
  starts(): Extract<FakeCodexLaunchCall, { event: "start" }>[];
  /** The text of every turn the app-servers took, steered ones included. */
  turnTexts(): string[];
  alive(pid: number): boolean;
}

const SCRIPT = String.raw`
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const log = (line) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ pid: process.pid, ...line }) + "\n");
const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const all = process.argv.slice(2);
// "-c key=value" overrides come first (Ask AI and voice turn the Inbox MCP off that way): the subcommand follows.
const args = all.filter((arg, i) => arg !== "-c" && all[i - 1] !== "-c");
const overrides = all.filter((arg, i) => all[i - 1] === "-c");
const s = state();
if (s.gone) process.exit(127);
if (args[0] === "--version") { process.stdout.write((s.version || "codex-cli 0.165.0") + "\n"); process.exit(0); }
if (args[0] === "login" && args[1] === "status") {
  log({ event: "cli", argv: args });
  const login = s.login || "chatgpt";
  if (login === "none") { process.stderr.write("Not logged in\n"); process.exit(1); }
  process.stderr.write(login === "apikey" ? "API key configured - sk-***abcd\n" : "Logged in using ChatGPT\n");
  process.exit(0);
}
if (args[0] !== "app-server") { log({ event: "cli", argv: args }); process.exit(0); }

const env = {};
for (const name of ["HOME", "CODEX_HOME", "PLANNOTATOR_DATA_DIR", "LOGIN_ONLY", "CODEX_THREAD_ID", "PLANNOTATOR_PORT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
let started = false;
const logStart = () => { if (!started) { started = true; log({ event: "start", argv: args, cwd: process.cwd(), env, overrides }); } };
let stopped = false;
const stop = (why) => { if (stopped) return; stopped = true; if (started) log({ event: "stop", why }); process.exit(0); };
process.on("SIGTERM", () => stop("SIGTERM"));
process.stdin.on("end", () => stop("stdin"));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let seq = 0;
const uuid7 = () => { const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join(""); return "0199" + hex(4) + "-" + hex(4) + "-7" + hex(3) + "-8" + hex(3) + "-" + hex(12); };
let thread = null;
let active = null;
const waiting = [];
const asked = new Map();
let nextAsk = 1000;
const ask = (method, params) => new Promise((resolve) => { const id = nextAsk++; asked.set(id, { method, resolve }); send({ id, method, params }); });
const textOf = (input) => (input || []).map((i) => i.text || "").join("");
function runTurn(turn) {
  active = turn;
  send({ method: "turn/started", params: { threadId: thread, turn: { id: turn.id, status: "inProgress" } } });
  (async () => {
    if (turn.text.includes("APPROVE")) {
      const itemId = "item-" + turn.id;
      const result = await ask("item/commandExecution/requestApproval", { threadId: thread, turnId: turn.id, itemId, command: "touch approved.txt", cwd: process.cwd(), reason: "Make a file" });
      if (active !== turn) return;
    }
    if (turn.text.includes("ASK")) {
      await ask("item/tool/requestUserInput", { threadId: thread, turnId: turn.id, itemId: "ask-" + turn.id, questions: [{ id: "q1", header: "Pick", question: "Which colour?", options: [{ label: "Red" }] }] });
      if (active !== turn) return;
    }
    const ms = turn.text.includes("SLOW") ? 600000 : (state().turnMs ?? 200);
    turn.timer = setTimeout(() => finish(turn, state().failTurn ? "failed" : "completed"), ms);
  })();
}
function finish(turn, status) {
  if (active !== turn) return;
  clearTimeout(turn.timer);
  active = null;
  const failTurn = state().failTurn;
  if (status === "failed") send({ method: "error", params: { threadId: thread, turnId: turn.id, willRetry: false, error: { message: failTurn } } });
  send({ method: "turn/completed", params: { threadId: thread, turn: { id: turn.id, status, error: status === "failed" ? { message: failTurn } : null } } });
  const next = waiting.shift();
  if (next) runTurn(next);
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(msg) {
  if (msg.method === undefined && msg.id !== undefined) {
    const pending = asked.get(msg.id);
    if (pending) { asked.delete(msg.id); log({ event: "answer", method: pending.method, result: msg.result ?? { error: msg.error } }); pending.resolve(msg.result); }
    return;
  }
  if (msg.method !== "initialize" && msg.method !== "initialized" && msg.method !== "model/list") logStart();
  log({ event: "call", method: msg.method, params: msg.params ?? {} });
  if (msg.id === undefined) return;
  const now = state();
  const reply = (result) => send({ id: msg.id, result });
  const fail = (message, code) => send({ id: msg.id, error: { code: code ?? -32600, message } });
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize": return reply({ userAgent: "codex/0.165.0", codexHome: process.env.CODEX_HOME || "" });
    case "model/list": {
      if (now.models === "fail") return fail("model catalog unavailable");
      const models = now.models || [{ id: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }, { id: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] }];
      return reply({ data: models.map((m, i) => ({ id: m.id, model: m.id, displayName: m.id, hidden: !!m.hidden, isDefault: i === 0, supportedReasoningEfforts: m.efforts.map((e) => ({ reasoningEffort: e, description: e })), defaultReasoningEffort: m.efforts[0] })), nextCursor: null });
    }
    case "account/read": {
      const login = now.login || "chatgpt";
      return reply({ account: login === "none" ? null : login === "apikey" ? { type: "apiKey" } : { type: "chatgpt", email: "someone@example.com", planType: now.plan || "plus" }, requiresOpenaiAuth: true });
    }
    case "account/rateLimits/read": {
      if (now.rateLimits === "fail" || (now.login || "chatgpt") !== "chatgpt") return fail("chatgpt authentication required to read rate limits");
      return reply({ rateLimits: now.rateLimits || { limitId: "codex", primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1900500000 }, planType: now.plan || "plus" }, rateLimitsByLimitId: null });
    }
    case "thread/start": thread = uuid7(); reply({ thread: { id: thread, cwd: p.cwd } }); return send({ method: "thread/started", params: { thread: { id: thread } } });
    case "thread/resume": if (now.heldElsewhere) return fail("thread " + p.threadId + " already has an active writer"); thread = p.threadId; return reply({ thread: { id: thread } });
    case "thread/name/set": return reply({});
    case "turn/start": {
      const turn = { id: "turn-" + (++seq), text: textOf(p.input) };
      if (active && now.refuseSecondTurn) return fail("a turn is already running");
      if (active) { waiting.push(turn); return reply({ turn: { id: turn.id, status: "inProgress", startedAt: null } }); }
      reply({ turn: { id: turn.id, status: "inProgress", startedAt: Math.floor(Date.now() / 1000) } });
      return runTurn(turn);
    }
    case "turn/steer": if (!active || active.id !== p.expectedTurnId) return fail("no active turn to steer"); return reply({ turnId: active.id });
    case "turn/interrupt": {
      if (!active || active.id !== p.turnId) return fail("no active turn to interrupt");
      const turn = active;
      waiting.length = 0;
      for (const [id, pending] of asked) { asked.delete(id); pending.resolve(null); }
      finish(turn, "interrupted");
      return reply({});
    }
    default: return fail("unknown method " + msg.method, -32601);
  }
}
`;

export function installFakeCodexLaunch(root: string, state: FakeCodexLaunchState = {}): FakeCodexLaunch {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = (name: string) => join(bin, name);
  const set = (next: FakeCodexLaunchState) => writeFileSync(file("state.json"), JSON.stringify(next));
  set(state);
  writeFileSync(file("fake-codex-launch.cjs"), SCRIPT);
  writeFileSync(file("codex"), `#!/bin/sh\nexec "${process.execPath}" "${file("fake-codex-launch.cjs")}" "$@"\n`);
  chmodSync(file("codex"), 0o755);
  const calls = (): FakeCodexLaunchCall[] =>
    existsSync(file("calls.jsonl"))
      ? readFileSync(file("calls.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeCodexLaunchCall)
      : [];
  const rpc = (method?: string) => calls().flatMap((call) => (call.event === "call" && (!method || call.method === method) ? [{ pid: call.pid, method: call.method, params: call.params }] : []));
  return {
    bin,
    set,
    calls,
    rpc,
    starts: () => calls().filter((call): call is Extract<FakeCodexLaunchCall, { event: "start" }> => call.event === "start"),
    turnTexts: () => [...rpc("turn/start"), ...rpc("turn/steer")].map((call) => (call.params.input ?? []).map((i: { text?: string }) => i.text ?? "").join("")),
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
