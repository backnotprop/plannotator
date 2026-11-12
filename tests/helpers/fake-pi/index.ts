import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "fake-pi.cjs");

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
  version?: string;
  startFail?: string | null;
  noConnect?: boolean;
  readyDelayMs?: number;
  dialog?: { method?: "select" | "confirm" | "input" | "editor"; title: string; options?: string[] } | null;
  dialogOnStart?: boolean;
  workMs?: number;
  hold?: boolean;
  answer?: string;
  turnError?: string | null;
  retries?: number;
  settles?: boolean;
  turnOnStart?: boolean;
}

export interface FakePiCall {
  argv: string[];
  cwd: string;
  env: string[];
  dataDir: string | null;
  inboxTool: string | null;
  pid: number;
  startedAt?: number;
  at: number;
}

export interface FakePi {
  state: string;
  shell: string;
  configure(patch: FakePiConfig): void;
  calls(): FakePiCall[];
  starts(): FakePiCall[];
  terminals(): FakePiCall[];
  delivered(): string[];
  dialogs(): { sessionId: string; title: string; response: { cancelled?: boolean; value?: string; confirmed?: boolean } | null }[];
  exits(): { sessionId: string; pid: number; why: string; aborted?: boolean; terminal?: boolean; at: number }[];
  osascript(): string[][];
  sessionFiles(): string[];
  setExtension(on: boolean): void;
  setInstalled(on: boolean): void;
  setExec(on: boolean): void;
  alive(pid: number): boolean;
  stopAll(): number;
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function installFakePi(input: { bin: string; state: string; home: string; config?: FakePiConfig }): FakePi {
  const { bin, state, home } = input;
  for (const dir of [bin, state, join(home, ".pi", "agent")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(state, "config.json"), JSON.stringify(input.config ?? {}));
  const pi = join(bin, "pi");
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
  const alive = (pid: number) => {
    const call = lines<FakePiCall>("calls.jsonl").filter((c) => c.pid === pid).at(-1);
    if (!call) return false;
    const row = spawnSync("/bin/ps", ["-o", "etime=,command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(row);
    if (!match) return false;
    const command = match[5]!.trim();
    if (command !== "pi" && !command.includes(SCRIPT)) return false;
    const elapsed = ((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 60 + Number(match[3])) * 60 + Number(match[4]);
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
        .slice(0, -1)
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
        }
      }
      return stopped;
    },
  };
}
