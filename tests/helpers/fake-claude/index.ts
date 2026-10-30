/**
 * Puts a fake Claude Code on a test's PATH (fake-claude.cjs: the `--bg`,
 * `agents --json`, stop / respawn / rm contract, and a session that polls the
 * Inbox's bridge as the mod does), plus the two other programs launch runs:
 * a fake `osascript` (Open in Terminal, recorded, nothing opens) and a
 * stand-in login shell (`$SHELL -ilc`) that adds one `CLAUDE_*` value, so a
 * test can see the shell's env reach the settings file.
 *
 * Node-safe (the Playwright specs import it under node): the fake runs on this
 * process's own executable. Every fake session's pid is recorded; `stopAll`
 * signals only pids it recorded whose command line is still this fake.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "fake-claude.cjs");

/** A value the stand-in login shell exports: it must reach the launch's settings file, never argv. */
export const FAKE_LOGIN_CLAUDE_VALUE = { name: "CLAUDE_CODE_FAKE_LOGIN_ONLY", value: "from-the-login-shell" } as const;

export interface FakeClaudeConfig {
  /** `claude --version` (default 2.1.314). */
  version?: string;
  /** `untrusted`: `--bg` fails with Claude's untrusted-folder error. `slow`: it never answers in time. */
  fault?: "untrusted" | "slow" | null;
  /** How long a turn takes before the answer (ms, default 800). */
  workMs?: number;
  /** Keep the turn running until cleared. */
  hold?: boolean;
  /** List busy sessions as waiting on a permission prompt (and keep the turn running). */
  waiting?: boolean;
  /** The answer's first word. */
  answer?: string;
  /** A session's first poll waits this long (ms): the Inbox shows "Starting" meanwhile. */
  startDelayMs?: number;
}

export interface FakeClaudeCall {
  argv: string[];
  cwd: string;
  env: string[];
  at: number;
  settingsPath?: string;
  settings?: { env?: Record<string, string>; permissions?: { allow?: string[] }; [key: string]: unknown } | null;
  settingsMode?: number | null;
  threadExisted?: boolean;
}

export interface FakeClaudeAgent {
  id: string;
  sessionId: string;
  cwd: string;
  name: string;
  status: string | null;
  state: string;
  pid?: number | null;
  permissionMode: string | null;
}

export interface FakeClaude {
  state: string;
  /** The stand-in login shell: give it to the Inbox as SHELL. */
  shell: string;
  configure(patch: FakeClaudeConfig): void;
  calls(): FakeClaudeCall[];
  /** The `--bg` calls only. */
  starts(): FakeClaudeCall[];
  agents(): FakeClaudeAgent[];
  /** Each fake `osascript` run's arguments. */
  osascript(): string[][];
  /** Take `claude` off PATH (uninstalled) or put it back. */
  setInstalled(on: boolean): void;
  /** SIGTERM every fake session still running that this fake started; returns how many. */
  stopAll(): number;
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function installFakeClaude(input: { bin: string; state: string; config?: FakeClaudeConfig }): FakeClaude {
  const { bin, state } = input;
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "config.json"), JSON.stringify(input.config ?? {}));
  const claude = join(bin, "claude");
  const wrapper = `#!/bin/sh\nFAKE_CLAUDE_STATE=${q(state)} exec ${q(process.execPath)} ${q(SCRIPT)} "$@"\n`;
  const install = () => {
    writeFileSync(claude, wrapper);
    chmodSync(claude, 0o755);
  };
  install();
  // Open in Terminal: what it would have run, recorded; nothing opens.
  writeFileSync(join(bin, "osascript"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> ${q(join(state, "osascript.log"))}\nprintf '\\n' >> ${q(join(state, "osascript.log"))}\n`, { mode: 0o755 });
  // `$SHELL -ilc <command>`: run the command with one more CLAUDE_* value, as a person's .zshrc would export it.
  const shell = join(bin, "login-shell");
  writeFileSync(shell, `#!/bin/sh\n${FAKE_LOGIN_CLAUDE_VALUE.name}=${q(FAKE_LOGIN_CLAUDE_VALUE.value)}\nexport ${FAKE_LOGIN_CLAUDE_VALUE.name}\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });

  const lines = <T>(file: string): T[] =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as T)
      : [];
  const readConfig = (): FakeClaudeConfig => JSON.parse(readFileSync(join(state, "config.json"), "utf8")) as FakeClaudeConfig;

  return {
    state,
    shell,
    configure(patch) {
      writeFileSync(join(state, "config.json"), JSON.stringify({ ...readConfig(), ...patch }));
      // A new version is a new program on disk (the Inbox keeps a --version answer per file), as an update would be.
      if (patch.version !== undefined) {
        rmSync(claude, { force: true });
        install();
      }
    },
    calls: () => lines<FakeClaudeCall>(join(state, "calls.jsonl")),
    starts: () => lines<FakeClaudeCall>(join(state, "calls.jsonl")).filter((c) => c.argv.includes("--bg")),
    agents() {
      const dir = join(state, "agents");
      if (!existsSync(dir)) return [];
      return spawnSync("/bin/ls", [dir], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((n) => n.endsWith(".json"))
        .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")) as FakeClaudeAgent);
    },
    osascript() {
      const file = join(state, "osascript.log");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\u001f").filter((part, i, all) => i < all.length - 1 || part !== ""));
    },
    setInstalled(on) {
      if (on) install();
      else rmSync(claude, { force: true });
    },
    stopAll() {
      const file = join(state, "pids.log");
      if (!existsSync(file)) return 0;
      let stopped = 0;
      for (const pid of new Set(readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number))) {
        const command = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
        // Only a process that is still this fake's session (never a reused pid).
        if (!command.includes(SCRIPT) || !command.includes("__session")) continue;
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
