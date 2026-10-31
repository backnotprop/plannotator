/**
 * Puts a fake Codex on a test's PATH (fake-codex.cjs: the CLI's `--version`,
 * `app-server daemon start|stop` and `queue`, and a daemon that speaks the
 * app-server's JSON-RPC over a WebSocket on its control socket, with threads,
 * turns, approval requests, and a turn's reply posted to the Inbox's MCP).
 * The real Codex is never run.
 *
 * Node-safe (the Playwright specs import it under node): the fake runs on this
 * process's own executable. The daemon's pid is recorded; `stopAll` signals
 * only a recorded pid whose command line is still this fake's daemon.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "fake-codex.cjs");

/** One approval request a turn plays, in order. */
export type FakeCodexPrompt =
  | { kind: "command"; command: string; reason?: string; approvalId?: string }
  | { kind: "fileChange"; changes: { path: string; kind: { type: "add" | "delete" | "update"; move_path?: string | null }; diff: string }[]; reason?: string }
  | { kind: "permissions"; permissions: Record<string, unknown>; reason?: string };

export interface FakeCodexConfig {
  /** `codex --version` (default 0.165.0). */
  version?: string;
  /** `fail`: `app-server daemon start` exits 1. */
  daemonFault?: "fail" | null;
  /** How long a turn works before its reply (ms, default 300). */
  workMs?: number;
  /** Keep every turn running until it is interrupted or this is cleared. */
  hold?: boolean;
  /** The reply's first word (default "Done"). */
  answer?: string;
  /** The whole reply, in place of the line tests read. */
  body?: string;
  /** Approval requests each turn plays before it replies. */
  prompts?: FakeCodexPrompt[];
  /** The person answers this thread's open approval in `codex resume` (accept): Codex settles it itself. */
  localAnswer?: string | null;
  /** turn/start starts the turn, then the connection drops before its answer. */
  dropOnTurnStart?: boolean;
  /** A thread no connection is subscribed to unloads at once (Codex: after 30 min). */
  unloadOnUnsubscribe?: boolean;
  /** Each turn fails with this error instead of replying (an `error` notification, then `turn/completed` with `status: "failed"`). */
  turnError?: { message: string; codexErrorInfo?: unknown } | null;
}

export interface FakeCodexRpc {
  method: string;
  params: Record<string, any>;
  at: number;
}

export interface FakeCodexApproval {
  threadId: string;
  method: string;
  params: Record<string, any>;
  requestId: number;
  /** What settled it: the Inbox's answer, the person in Terminal (`local`), or Stop. */
  result: any;
  how: "answered" | "local" | "interrupted";
  at: number;
}

export interface FakeCodexTurn {
  threadId: string;
  turnId: string;
  text?: string;
  how?: "turn/start" | "queue";
  ended?: "completed" | "interrupted" | "failed";
  steer?: string;
  at: number;
}

export interface FakeCodex {
  state: string;
  /** CODEX_HOME (HOME/.codex): config.toml and the daemon's socket. */
  home: string;
  configure(patch: FakeCodexConfig): void;
  /** Each CLI call. */
  calls(): { argv: string[]; cwd: string; env: string[]; at: number }[];
  /** Each JSON-RPC request the daemon took (and `codex queue`'s thread/queue/add). */
  rpc(method?: string): FakeCodexRpc[];
  approvals(): FakeCodexApproval[];
  /** Turn starts, ends and steers, in order. */
  turns(): FakeCodexTurn[];
  replies(): { threadId: string; turnId: string; replyTo: string; body: string; status: number; at: number }[];
  /** The daemon's threads as it last saved them (by id). */
  threads(): Record<string, { id: string; cwd: string; name: string | null; config: Record<string, unknown>; approvalPolicy: string; sandbox: string; turns: { id: string; status: string }[] }>;
  /** config.toml's text now (null when absent). */
  configToml(): string | null;
  /** Run the fake `codex` as the person would in a terminal (`queue`, `app-server daemon stop`): exit code and output. */
  cli(args: string[]): { status: number | null; stdout: string; stderr: string };
  /** Take `codex` off PATH (uninstalled) or put it back. */
  setInstalled(on: boolean): void;
  /** SIGTERM the fake daemon if it still runs; returns how many. */
  stopAll(): number;
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * `home`: the test HOME (its `.codex` is CODEX_HOME unless `codexHome` names one). `inboxMcp`: write config.toml with the Inbox's MCP entry
 * (this path as the `plannotator` program), as a person who connected Codex has it; omitted, config.toml is left as it is.
 */
export function installFakeCodex(input: { bin: string; state: string; home: string; codexHome?: string; config?: FakeCodexConfig; inboxMcp?: string; configToml?: string }): FakeCodex {
  const { bin, state } = input;
  // CODEX_HOME: HOME/.codex, or `codexHome` (the Inbox must then have CODEX_HOME set to it). macOS caps a socket's path
  // at 104 bytes, and the daemon's socket is under it: a deep temp HOME needs a short one.
  const home = input.codexHome ?? join(input.home, ".codex");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(state, "config.json"), JSON.stringify(input.config ?? {}));
  if (input.inboxMcp !== undefined || input.configToml !== undefined) {
    const entry = input.inboxMcp !== undefined ? `[mcp_servers.plannotator-inbox]\ncommand = ${JSON.stringify(input.inboxMcp)}\nargs = ["inbox", "mcp"]\n` : "";
    writeFileSync(join(home, "config.toml"), `${input.configToml ?? 'model = "gpt-5"\n'}\n${entry}`);
  }
  const codex = join(bin, "codex");
  const wrapper = `#!/bin/sh\nFAKE_CODEX_STATE=${q(state)} exec ${q(process.execPath)} ${q(SCRIPT)} "$@"\n`;
  const install = () => {
    writeFileSync(codex, wrapper);
    chmodSync(codex, 0o755);
  };
  install();

  const lines = <T>(file: string): T[] =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as T)
      : [];
  const readConfig = (): FakeCodexConfig => JSON.parse(readFileSync(join(state, "config.json"), "utf8")) as FakeCodexConfig;

  return {
    state,
    home,
    configure(patch) {
      writeFileSync(join(state, "config.json"), JSON.stringify({ ...readConfig(), ...patch }));
      if (patch.version !== undefined) {
        rmSync(codex, { force: true });
        install();
      }
    },
    calls: () => lines(join(state, "calls.jsonl")),
    rpc: (method) => lines<FakeCodexRpc>(join(state, "rpc.jsonl")).filter((r) => !method || r.method === method),
    approvals: () => lines<FakeCodexApproval>(join(state, "approvals.jsonl")),
    turns: () => lines<FakeCodexTurn>(join(state, "turns.jsonl")),
    replies: () => lines(join(state, "replies.jsonl")),
    threads: () => (existsSync(join(state, "threads.json")) ? JSON.parse(readFileSync(join(state, "threads.json"), "utf8")) : {}),
    configToml: () => (existsSync(join(home, "config.toml")) ? readFileSync(join(home, "config.toml"), "utf8") : null),
    cli(args) {
      const env = { HOME: input.home, PATH: `${bin}:/usr/bin:/bin`, ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}) };
      const run = spawnSync(codex, args, { env, encoding: "utf8", timeout: 20_000 });
      return { status: run.status, stdout: run.stdout, stderr: run.stderr };
    },
    setInstalled(on) {
      if (on) install();
      else rmSync(codex, { force: true });
    },
    stopAll() {
      let stopped = 0;
      const file = join(state, "pids.log");
      const pids = existsSync(file) ? [...new Set(readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number))] : [];
      for (const pid of pids) {
        const command = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
        // Only a process that is still this fake's daemon (never a reused pid).
        if (!command.includes(SCRIPT) || !command.includes("__daemon")) continue;
        try {
          process.kill(pid, "SIGTERM");
          stopped++;
        } catch {
          // Gone between the check and the signal.
        }
      }
      return stopped;
    },
  };
}
