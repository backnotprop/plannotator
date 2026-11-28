/**
 * A fake `vibe-acp` for launch (packages/server/inbox-launch-vibe.ts): a scratch `bin/vibe-acp` that answers
 * `--version` and speaks the subset of the Agent Client Protocol (JSON-RPC 2.0 over stdio) a launch uses, shaped as
 * Mistral Vibe 3.1.3 answers it: `initialize`, `session/new` (its model select, current value from
 * `VIBE_ACTIVE_MODEL`), `session/load`, `session/prompt` (answered when the turn ends; a second prompt during a turn
 * is refused), `session/cancel`, `session/close`. A turn whose text holds `APPROVE` sends a `bash` tool call and asks
 * `session/request_permission` first, waiting for the answer; one holding `SLOW` runs until it is cancelled. Every
 * start, call, answer and stop goes to `calls.jsonl`. The real Vibe is never run, and nothing reads `~/.vibe`.
 *
 * Runs under Bun and node. POSIX only.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeVibeLaunchState {
  /** `vibe-acp --version`'s line. */
  version?: string;
  /** `session/new` answers -32000 "Missing API key", as Vibe does with no key for its provider. */
  signedOut?: boolean;
  /** How long a turn runs (ms). */
  turnMs?: number;
  /** Every turn fails with this error message (code -31002). */
  failTurn?: string | null;
  /** `session/load` is refused as another Vibe process holding the session. */
  heldElsewhere?: boolean;
  models?: string[];
  /** No `vibe-acp` at all: the script exits 127. */
  gone?: boolean;
}

export type FakeVibeLaunchCall =
  | { event: "start"; pid: number; cwd: string; env: Record<string, string> }
  | { event: "call"; pid: number; method: string; params: Record<string, any> }
  | { event: "answer"; pid: number; method: string; result: unknown }
  | { event: "stop"; pid: number; why: string };

export interface FakeVibeLaunch {
  bin: string;
  set(state: FakeVibeLaunchState): void;
  calls(): FakeVibeLaunchCall[];
  rpc(method?: string): { pid: number; method: string; params: Record<string, any> }[];
  starts(): Extract<FakeVibeLaunchCall, { event: "start" }>[];
  /** The text of every prompt the processes took. */
  promptTexts(): string[];
  alive(pid: number): boolean;
}

const SCRIPT = String.raw`
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const log = (line) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ pid: process.pid, ...line }) + "\n");
const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const args = process.argv.slice(2);
const s = state();
if (s.gone) process.exit(127);
if (args[0] === "--version" || args[0] === "-v") { process.stdout.write((s.version || "vibe-acp 3.1.3") + "\n"); process.exit(0); }

const env = {};
for (const name of ["HOME", "VIBE_HOME", "VIBE_ACTIVE_MODEL", "LOGIN_ONLY", "VIBE_SESSION", "VIBE_CLI", "PLANNOTATOR_PORT", "PLANNOTATOR_DATA_DIR"]) if (process.env[name] !== undefined) env[name] = process.env[name];
let started = false;
const logStart = () => { if (!started) { started = true; log({ event: "start", cwd: process.cwd(), env }); } };
let stopped = false;
const stop = (why) => { if (stopped) return; stopped = true; if (started) log({ event: "stop", why }); process.exit(0); };
process.on("SIGTERM", () => stop("SIGTERM"));
process.stdin.on("end", () => stop("stdin"));
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
let session = null;
let active = null;
let seq = 0;
const asked = new Map();
let nextAsk = 0;
const ask = (method, params) => new Promise((resolve) => { const id = nextAsk++; asked.set(id, { method, resolve }); send({ id, method, params }); });
const update = (u) => send({ method: "session/update", params: { sessionId: session, update: u } });
const textOf = (prompt) => (prompt || []).map((p) => p.text || "").join("");
const models = () => state().models || ["mistral-medium-latest", "devstral-2"];
const configOptions = () => [
  { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "smart-approve", options: [{ value: "ask", name: "Ask" }, { value: "smart-approve", name: "Smart Approve" }] },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: process.env.VIBE_ACTIVE_MODEL || models()[0], options: models().map((m) => ({ value: m, name: m })) },
  { id: "thinking", name: "Thinking", category: "thinking", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];
function finish(turn, result, error) {
  if (active !== turn) return;
  clearTimeout(turn.timer);
  active = null;
  if (error) send({ id: turn.rpcId, error });
  else send({ id: turn.rpcId, result });
}
async function runTurn(turn) {
  active = turn;
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } });
  if (turn.text.includes("APPROVE")) {
    const toolCallId = "effect-" + hex(8);
    update({ sessionUpdate: "tool_call", toolCallId, title: "bash: touch approved.txt", kind: "execute", status: "in_progress", rawInput: { command: "touch approved.txt" }, _meta: { tool_name: "bash", effect_kind: "shell" } });
    const result = await ask("session/request_permission", {
      sessionId: session,
      toolCall: { toolCallId },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_always", name: "Allow for remainder of this session", kind: "allow_always", _meta: { required_permissions: [{ scope: "command_pattern", invocation_pattern: "touch approved.txt", session_pattern: "touch *", label: "touch *" }] } },
        { optionId: "allow_always_permanent", name: "Always allow", kind: "allow_always", _meta: { required_permissions: [{ scope: "command_pattern", invocation_pattern: "touch approved.txt", session_pattern: "touch *", label: "touch *" }] } },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
      ],
    });
    if (turn.cancelled) return finish(turn, { stopReason: "cancelled" });
    update({ sessionUpdate: "tool_call_update", toolCallId, status: result && result.outcome && result.outcome.optionId && result.outcome.optionId.startsWith("allow") ? "completed" : "failed" });
  }
  const now = state();
  const ms = turn.text.includes("SLOW") ? 600000 : (now.turnMs ?? 200);
  turn.timer = setTimeout(() => (now.failTurn ? finish(turn, null, { code: -31002, message: now.failTurn }) : finish(turn, { stopReason: "end_turn" })), ms);
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
  if (msg.method !== "initialize") logStart();
  log({ event: "call", method: msg.method, params: msg.params ?? {} });
  const now = state();
  const p = msg.params || {};
  if (msg.method === "session/cancel") {
    // A turn waiting on an approval ends once that is answered.
    if (active) { active.cancelled = true; if (asked.size === 0) finish(active, { stopReason: "cancelled" }); }
    return;
  }
  if (msg.id === undefined) return;
  const reply = (result) => send({ id: msg.id, result });
  const fail = (message, code) => send({ id: msg.id, error: { code: code ?? -32603, message } });
  switch (msg.method) {
    case "initialize": return reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } }, authMethods: [], agentInfo: { name: "@mistralai/mistral-vibe", version: "3.1.3" } });
    case "session/new":
      if (now.signedOut) return fail("Missing API key for mistral provider.", -32000);
      session = hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12);
      return reply({ sessionId: session, configOptions: configOptions() });
    case "session/load":
      if (now.heldElsewhere) return fail("Session is already open");
      session = p.sessionId;
      // Vibe replays the history before it answers.
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "(history)" } });
      return reply({ configOptions: configOptions() });
    case "session/prompt": {
      if (active) return fail("a prompt is already running");
      const turn = { id: ++seq, rpcId: msg.id, text: textOf(p.prompt), cancelled: false };
      return void runTurn(turn);
    }
    case "session/close": return reply({});
    default: return fail("Method not found: " + msg.method, -32601);
  }
}
`;

export function installFakeVibeLaunch(root: string, state: FakeVibeLaunchState = {}): FakeVibeLaunch {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = (name: string) => join(bin, name);
  const set = (next: FakeVibeLaunchState) => writeFileSync(file("state.json"), JSON.stringify(next));
  set(state);
  writeFileSync(file("fake-vibe-launch.cjs"), SCRIPT);
  writeFileSync(file("vibe-acp"), `#!/bin/sh\nexec "${process.execPath}" "${file("fake-vibe-launch.cjs")}" "$@"\n`);
  chmodSync(file("vibe-acp"), 0o755);
  const calls = (): FakeVibeLaunchCall[] =>
    existsSync(file("calls.jsonl"))
      ? readFileSync(file("calls.jsonl"), "utf8")
          .split("\n")
          // A line is whole only once its newline is written: the last piece is "" or a line still being appended.
          .slice(0, -1)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeVibeLaunchCall)
      : [];
  const rpc = (method?: string) => calls().flatMap((call) => (call.event === "call" && (!method || call.method === method) ? [{ pid: call.pid, method: call.method, params: call.params }] : []));
  return {
    bin,
    set,
    calls,
    rpc,
    starts: () => calls().filter((call): call is Extract<FakeVibeLaunchCall, { event: "start" }> => call.event === "start"),
    promptTexts: () => rpc("session/prompt").map((call) => (call.params.prompt ?? []).map((p: { text?: string }) => p.text ?? "").join("")),
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
