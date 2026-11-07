/**
 * Puts a fake Pi on a test's PATH (fake-pi.cjs: `--version`, `--mode rpc
 * --session-id`, its session file, and Plannotator's Pi extension's bridge
 * poll), Pi's settings in the test HOME listing Plannotator's Pi extension
 * (the launch row's check), a fake `osascript` (Open in Terminal, recorded,
 * nothing opens) and a stand-in login shell. Never the real Pi.
 *
 * Node-safe (the Playwright specs import it under node): the fake runs on Node
 * when there is one, as Pi does, else on this process's own executable.
 * `stopAll` signals only pids it recorded that still run as this fake: titled
 * `pi`, as Pi is, and started when that fake started.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "fake-pi.cjs");

/**
 * The runtime the fake runs on: Node, as Pi does, wherever there is one (Bun ignores `process.title`, so under
 * Bun ps would still list the fake's argv); else this process's own executable.
 */
function fakeRuntime(): string {
  const bun = (globalThis as { Bun?: { which(name: string): string | null } }).Bun;
  if (!bun) return process.execPath;
  const node = bun.which("node");
  try {
    return node ? realpathSync(node) : process.execPath;
  } catch {
    return process.execPath;
  }
}

export interface FakePiConfig {
  /** `pi --version` (default 0.85.1). */
  version?: string;
  /** The process prints this on stderr and exits 1 before it answers (a start that fails). */
  startFail?: string | null;
  /** The RPC process's extension never polls (not connected to the Inbox); a terminal's Pi still does. */
  noConnect?: boolean;
  /** The RPC process answers its first `get_state` this much later (ms): a Pi slow to come up. */
  readyDelayMs?: number;
  /** Each turn first asks this extension dialog over RPC, and waits for the answer (10 s at most). */
  dialog?: { method?: "select" | "confirm" | "input" | "editor"; title: string; options?: string[] } | null;
  /** Ask `dialog` once as the session starts, before any turn (an extension's session_start). */
  dialogOnStart?: boolean;
  /** How long a turn works before it answers (ms, default 600). */
  workMs?: number;
  /** Keep the turn running until cleared. */
  hold?: boolean;
  /** The answer's first word. */
  answer?: string;
  /** Each turn ends in this provider error instead of answering (`stopReason: "error"`, `errorMessage`). */
  turnError?: string | null;
  /** With `turnError`: this many runs end in it with `willRetry: true` first (Pi's auto-retry). */
  retries?: number;
  /** false: no `agent_settled` (a Pi before 0.80.4). */
  settles?: boolean;
  /** One turn of the RPC process's own as the session starts (no Inbox message). */
  turnOnStart?: boolean;
}

export interface FakePiCall {
  argv: string[];
  cwd: string;
  env: string[];
  dataDir: string | null;
  inboxTool: string | null;
  pid: number;
  /** When the process started (ms). */
  startedAt?: number;
  at: number;
}

export interface FakePi {
  state: string;
  shell: string;
  configure(patch: FakePiConfig): void;
  calls(): FakePiCall[];
  /** The `--mode rpc` processes it ran. */
  starts(): FakePiCall[];
  /** The terminal Pis it ran (`pi --session-id` without `--mode rpc`). */
  terminals(): FakePiCall[];
  delivered(): string[];
  dialogs(): { sessionId: string; title: string; response: { cancelled?: boolean; value?: string; confirmed?: boolean } | null }[];
  exits(): { sessionId: string; pid: number; why: string; aborted?: boolean; terminal?: boolean; at: number }[];
  osascript(): string[][];
  /** Every session file of Pi's agent dir in the test HOME. */
  sessionFiles(): string[];
  /** Pi's settings list Plannotator's Pi extension, or not. */
  setExtension(on: boolean): void;
  setInstalled(on: boolean): void;
  /** Whether `pi` execs the fake (the default), or runs it as its child. */
  setExec(on: boolean): void;
  /** Whether that pid is still a running fake. */
  alive(pid: number): boolean;
  stopAll(): number;
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function installFakePi(input: { bin: string; state: string; home: string; config?: FakePiConfig }): FakePi {
  const { bin, state, home } = input;
  for (const dir of [bin, state, join(home, ".pi", "agent")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(state, "config.json"), JSON.stringify(input.config ?? {}));
  const pi = join(bin, "pi");
  /** `exec` off: the wrapper runs Pi as its child, as Volta's shim or `node …/cli.js "$@"` does. */
  let exec = true;
  const runtime = fakeRuntime();
  const install = () => {
    writeFileSync(pi, `#!/bin/sh\nFAKE_PI_STATE=${q(state)} ${exec ? "exec " : ""}${q(runtime)} ${q(SCRIPT)} "$@"\n`);
    chmodSync(pi, 0o755);
  };
  install();
  const settings = join(home, ".pi", "agent", "settings.json");
  const setExtension = (on: boolean) => writeFileSync(settings, JSON.stringify({ packages: on ? ["npm:@plannotator/pi-extension"] : ["npm:pi-subagents"] }));
  setExtension(true);
  writeFileSync(join(bin, "osascript"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> ${q(join(state, "osascript.log"))}\nprintf '\\n' >> ${q(join(state, "osascript.log"))}\n`, { mode: 0o755 });
  const shell = join(bin, "login-shell");
  writeFileSync(shell, `#!/bin/sh\necho run >> ${q(join(state, "logins.log"))}\nPATH=${q(bin)}:"$PATH"\nexport PATH\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });

  const lines = <T>(name: string): T[] =>
    existsSync(join(state, name))
      ? readFileSync(join(state, name), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as T)
      : [];
  const readConfig = (): FakePiConfig => JSON.parse(readFileSync(join(state, "config.json"), "utf8")) as FakePiConfig;
  /**
   * Whether `pid` is still a fake this helper recorded. The fake titles itself `pi` as Pi does, so ps lists
   * it as `pi` alone (this script's path only in the instant before): the pid must also have started when
   * that fake did (ps's elapsed time against its `startedAt`), so a real Pi that reused the pid never counts.
   */
  const alive = (pid: number) => {
    const call = lines<FakePiCall>("calls.jsonl").filter((c) => c.pid === pid).at(-1);
    if (!call) return false;
    const row = spawnSync("/bin/ps", ["-o", "etime=,command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(row);
    if (!match) return false;
    const command = match[5]!.trim();
    if (command !== "pi" && !command.includes(SCRIPT)) return false;
    const elapsed = ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 + Number(match[3])) * 60 + Number(match[4]);
    // ps rounds the elapsed time down to the second.
    const started = Date.now() - elapsed * 1000;
    return Math.abs(started - (call.startedAt ?? call.at)) <= 2_000;
  };

  return {
    state,
    shell,
    configure(patch) {
      writeFileSync(join(state, "config.json"), JSON.stringify({ ...readConfig(), ...patch }));
      if (patch.version !== undefined) {
        rmSync(pi, { force: true });
        install();
      }
    },
    calls: () => lines<FakePiCall>("calls.jsonl"),
    starts: () => lines<FakePiCall>("calls.jsonl").filter((c) => c.argv.includes("--mode")),
    terminals: () => lines<FakePiCall>("calls.jsonl").filter((c) => c.argv.includes("--session-id") && !c.argv.includes("--mode")),
    delivered: () => (existsSync(join(state, "delivered.log")) ? readFileSync(join(state, "delivered.log"), "utf8").split("\n").filter(Boolean) : []),
    dialogs: () => lines("dialogs.jsonl"),
    exits: () => lines("exits.jsonl"),
    osascript() {
      const file = join(state, "osascript.log");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\u001f").filter((part, i, all) => i < all.length - 1 || part !== ""));
    },
    sessionFiles() {
      const root = join(home, ".pi", "agent", "sessions");
      if (!existsSync(root)) return [];
      return readdirSync(root).flatMap((dir) => readdirSync(join(root, dir)).map((name) => join(root, dir, name)));
    },
    setExtension,
    setInstalled(on) {
      if (on) install();
      else rmSync(pi, { force: true });
    },
    setExec(on) {
      exec = on;
      install();
    },
    alive,
    stopAll() {
      let stopped = 0;
      const file = join(state, "pids.log");
      const pids = existsSync(file) ? [...new Set(readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number))] : [];
      for (const pid of pids) {
        if (!alive(pid)) continue;
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
