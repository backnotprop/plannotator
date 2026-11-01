/**
 * A fake `codex` for voice dictation (packages/server/inbox-voice.ts): a scratch `bin/codex` that speaks just enough
 * of `codex app-server` over stdio. It answers `initialize`, `account/read` and `getAuthStatus` from `state.json`
 * (which a test changes between calls) and logs every start, call and stop to `calls.jsonl`. The real Codex is never
 * run, and nothing reads the person's `~/.codex`.
 *
 * Runs under Bun and node (the Inbox's world for the e2e spec starts it through the same PATH). POSIX only: a `.cmd`
 * shim is not worth a fake.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeCodexState {
  /** `account/read`'s `account`; null is signed out. */
  account?: Record<string, unknown> | null;
  /** `getAuthStatus`'s `authMethod`. */
  authMethod?: string | null;
  /** The token before a refresh. */
  token?: string | null;
  /** The token after `refreshToken: true`. */
  refreshedToken?: string | null;
  /** This method gets a JSON-RPC error. */
  failMethod?: string;
  /** Exit at once, as a Codex that cannot start does. */
  crash?: boolean;
}

export type FakeCodexCall =
  | { event: "start"; pid: number; argv: string[]; marker: string | null; home: string | null }
  | { event: "call"; pid: number; method: string; params: Record<string, unknown> }
  | { event: "stop"; pid: number };

export interface FakeCodex {
  bin: string;
  set(state: FakeCodexState): void;
  calls(): FakeCodexCall[];
  methods(): string[];
  starts(): number;
  /** Every start has logged its stop. */
  allStopped(): boolean;
}

const SCRIPT = String.raw`
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const log = (line) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ pid: process.pid, ...line }) + "\n");
const state = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
log({ event: "start", argv: process.argv.slice(2), marker: process.env.PLANNOTATOR_ASK_AI_CHILD ?? null, home: process.env.CODEX_HOME ?? null });
const stop = () => { log({ event: "stop" }); process.exit(0); };
if (state().crash) stop();
process.on("SIGTERM", stop);
process.stdin.on("end", stop);
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim()) answer(JSON.parse(line));
  }
});
function answer(msg) {
  if (msg.id === undefined) return;
  log({ event: "call", method: msg.method, params: msg.params ?? {} });
  const now = state();
  const reply = (body) => process.stdout.write(JSON.stringify({ id: msg.id, ...body }) + "\n");
  if (now.failMethod === msg.method) return reply({ error: { code: -32000, message: "no" } });
  if (msg.method === "initialize") return reply({ result: { userAgent: "codex/0.0.0" } });
  if (msg.method === "account/read") return reply({ result: { account: now.account ?? null, requiresOpenaiAuth: true } });
  if (msg.method === "getAuthStatus") {
    const token = msg.params.includeToken ? (msg.params.refreshToken ? now.refreshedToken : now.token) : null;
    return reply({ result: { authMethod: now.authMethod ?? null, authToken: token ?? null, requiresOpenaiAuth: true } });
  }
  reply({ error: { code: -32601, message: "unknown" } });
}
`;

export function installFakeCodex(root: string, state: FakeCodexState = {}): FakeCodex {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = (name: string) => join(bin, name);
  const set = (next: FakeCodexState) => writeFileSync(file("state.json"), JSON.stringify(next));
  set(state);
  writeFileSync(file("fake-codex.cjs"), SCRIPT);
  writeFileSync(file("codex"), `#!/bin/sh\nexec "${process.execPath}" "${file("fake-codex.cjs")}" "$@"\n`);
  chmodSync(file("codex"), 0o755);
  const calls = (): FakeCodexCall[] =>
    existsSync(file("calls.jsonl"))
      ? readFileSync(file("calls.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeCodexCall)
      : [];
  return {
    bin,
    set,
    calls,
    methods: () => calls().flatMap((call) => (call.event === "call" && call.method !== "initialize" ? [call.method] : [])),
    starts: () => calls().filter((call) => call.event === "start").length,
    allStopped: () => {
      const logged = calls();
      return logged.filter((call) => call.event === "start").length === logged.filter((call) => call.event === "stop").length;
    },
  };
}
