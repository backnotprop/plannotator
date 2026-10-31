/**
 * Puts a fake Pi on a test's PATH (fake-pi.cjs: `--version`, `--mode rpc
 * --session-id`, its session file, and Plannotator's Pi extension's bridge
 * poll), Pi's settings in the test HOME listing Plannotator's Pi extension
 * (the launch row's check), a fake `osascript` (Open in Terminal, recorded,
 * nothing opens) and a stand-in login shell. Never the real Pi.
 *
 * Node-safe (the Playwright specs import it under node): the fake runs on this
 * process's own executable. `stopAll` signals only pids it recorded whose
 * command line is still this fake.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "fake-pi.cjs");

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
}

export interface FakePiCall {
  argv: string[];
  cwd: string;
  env: string[];
  dataDir: string | null;
  inboxTool: string | null;
  pid: number;
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
  const install = () => {
    writeFileSync(pi, `#!/bin/sh\nFAKE_PI_STATE=${q(state)} exec ${q(process.execPath)} ${q(SCRIPT)} "$@"\n`);
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
  const alive = (pid: number) => spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(SCRIPT);

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
