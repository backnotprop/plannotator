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
  /**
   * Claude's folder trust: `--bg` and `respawn` fail as untrusted unless HOME's .claude.json trusts the folder or a
   * folder above it; a git repository's root only by its own entry (a parent's trust never covers a nested repository).
   */
  trustCheck?: boolean;
  /** `--bg --permission-mode auto` fails as a CLI without auto mode does (commander's refusal of the value). */
  refuseAuto?: boolean;
  /** Plannotator's plugin brings its own PermissionRequest hook (ExitPlanMode), as on a real install (default true; it turns the skip export off). */
  pluginPermissionHook?: boolean;
  /** How long a turn takes before the answer (ms, default 800). */
  workMs?: number;
  /** Keep the turn running until cleared. */
  hold?: boolean;
  /** List busy sessions as waiting on a permission prompt (and keep the turn running). */
  waiting?: boolean;
  /** The answer's first word. */
  answer?: string;
  /** The whole answer, in words, in place of the line tests read (screenshots). */
  body?: string;
  /** A session's first poll waits this long (ms): the Inbox shows "Starting" meanwhile. */
  startDelayMs?: number;
  /** `--bg` answers (and the session exists) only after this long (ms). */
  bgDelayMs?: number;
  /** A session takes a command, then reports busy only after this long (ms): the real mod's gap until its next poll. */
  busyDelayMs?: number;
  /** Permission prompts each turn plays, in order: the settings file's PermissionRequest hook runs with Claude Code's stdin. */
  prompts?: FakePermissionPrompt[];
  /** The person answers the open dialog in `claude attach`: the hook is ended (SIGTERM) and the session goes on. */
  localAnswer?: boolean;
  /** How long a safety check's own dialog (up once the hook ended with no decision) waits before it blocks the call (ms; Claude's is about 2 minutes). */
  safetyBlockMs?: number;
}

/** One tool call that needs permission (Claude Code's PermissionRequest stdin, less what the session fills in). */
export interface FakePermissionPrompt {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  permission_suggestions?: Record<string, unknown>[];
  /**
   * Claude's own safety check (a dangerous rm), for a person only: bypass mode still asks it (to the hook, or waived by
   * the export when no PermissionRequest hook exists at all), and in any mode a hook's allow is ignored (its deny counts);
   * its own dialog comes up only after the hook ends.
   */
  safetyCheck?: boolean;
}

/** What a permission prompt came to (permissions.jsonl). */
export interface FakePermissionResult {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  /** The hook's stdout, parsed; null when it printed nothing. */
  output: { hookSpecificOutput?: { hookEventName?: string; decision?: { behavior: string; updatedInput?: unknown; updatedPermissions?: unknown[]; message?: string } } } | null;
  exitCode: number | null;
  /** `autoblocked`: a safety check's own dialog blocked the call after `safetyBlockMs` with no answer in Terminal. */
  outcome: "ran" | "denied" | "local" | "blocked" | "autoblocked";
  /** False when the session's mode asked nothing (bypass mode). */
  asked?: boolean;
  /** The session's mode after the prompt (a hook's setMode changes it). */
  mode?: string;
  /** A hook's setMode to bypass that the session ignored (bypass not available: no consent). */
  modeIgnored?: boolean;
  /** A safety check whose hook allowed: Claude ignored the allow and kept its own dialog. */
  ignoredAllow?: boolean;
  ms: number;
}

export interface FakeClaudeCall {
  argv: string[];
  cwd: string;
  env: string[];
  at: number;
  settingsPath?: string;
  settings?: { env?: Record<string, string>; permissions?: { allow?: string[]; defaultMode?: string }; hooks?: Record<string, unknown>; [key: string]: unknown } | null;
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
  /** Bypass is available to the session (the person's consent, and the allow flag or a bypass start). */
  bypassAvailable?: boolean;
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
  /** How many times the stand-in login shell ran (the Inbox reads it once per start). */
  logins(): number;
  /** More names the stand-in login shell exports (a person's .zshrc), or none. */
  setLoginExports(vars: Record<string, string> | null): void;
  /** The ids of the commands sessions took, in order. */
  delivered(): string[];
  /** Each permission prompt a session played, in order. */
  permissions(): FakePermissionResult[];
  /** Each permission hook run, as it exited: its raw stdout and exit code. */
  hooks(): { sessionId: string; tool: string; stdout: string; exitCode: number | null; local: boolean; ms: number }[];
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
  // `$SHELL -ilc <command>`: run the command with one more CLAUDE_* value and the fakes on PATH, as a person's
  // .zshrc would export them (the Inbox starts it from a minimal env). Each run is counted.
  const shell = join(bin, "login-shell");
  writeFileSync(
    shell,
    `#!/bin/sh\necho run >> ${q(join(state, "logins.log"))}\n[ -f ${q(join(state, "login-exports.sh"))} ] && . ${q(join(state, "login-exports.sh"))}\n${FAKE_LOGIN_CLAUDE_VALUE.name}=${q(FAKE_LOGIN_CLAUDE_VALUE.value)}\nexport ${FAKE_LOGIN_CLAUDE_VALUE.name}\nPATH=${q(bin)}:"$PATH"\nexport PATH\nexec /bin/sh -c "$2"\n`,
    { mode: 0o755 },
  );

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
    logins() {
      const file = join(state, "logins.log");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    },
    setLoginExports(vars) {
      const file = join(state, "login-exports.sh");
      if (!vars) rmSync(file, { force: true });
      else writeFileSync(file, Object.entries(vars).map(([name, value]) => `${name}=${q(value)}\nexport ${name}\n`).join(""));
    },
    permissions: () => lines<FakePermissionResult>(join(state, "permissions.jsonl")),
    hooks: () => lines<ReturnType<FakeClaude["hooks"]>[number]>(join(state, "hooks.jsonl")),
    delivered() {
      const file = join(state, "delivered.log");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    },
    setInstalled(on) {
      if (on) install();
      else rmSync(claude, { force: true });
    },
    stopAll() {
      let stopped = 0;
      const pidsOf = (name: string) => {
        const file = join(state, name);
        return existsSync(file) ? [...new Set(readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number))] : [];
      };
      const candidates = [...pidsOf("pids.log").map((pid) => ({ pid, hook: false })), ...pidsOf("hookpids.log").map((pid) => ({ pid, hook: true }))];
      for (const { pid, hook } of candidates) {
        const command = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
        // Only a process that is still this fake's session, or a permission hook it ran (never a reused pid).
        if (hook ? !command.includes("permission-hook") : !command.includes(SCRIPT) || !command.includes("__session")) continue;
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
