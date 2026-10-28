/**
 * Connecting the agents on this computer to the Plannotator Inbox (the
 * approved "inbox-agent-awareness" design, decisions 1, 2, 3, 7).
 *
 * `plannotator inbox` (never `--background`, never the shim or a connection
 * that starts a stopped Inbox) runs `connectInboxAgents` once per run: every
 * terminal agent found (its command on PATH, or its settings folder, the
 * install script's rules) gets a `plannotator-inbox` MCP server running
 * `<this CLI> inbox mcp`:
 *
 *  - through the agent's own `mcp add` command where it has one (Codex,
 *    Gemini CLI, Windsurf/Devin, Amp, Cline, Pi without Plannotator's
 *    extension), so Plannotator never edits TOML or JSONC itself;
 *  - else as one key in a plain-JSON file, after a strict parse (Cursor,
 *    Kiro, the Claude desktop app);
 *  - Pi and OpenCode with Plannotator's extension or plugin: `inboxTool` on in
 *    config.json (the same write as the Settings switch);
 *  - Claude Code: nothing (its plugin's mod has the tool).
 *
 * `inbox/agents.json` records what was found or added. An agent with a record
 * is never added again by itself: an entry the person turned off in Settings,
 * or removed outside Plannotator, stays off. An entry named
 * `plannotator-inbox` that runs something else is never replaced.
 *
 * `plannotator uninstall` (plain and --purge) removes what this added
 * (`removeInboxAgentEntries`): recorded entries that still run Plannotator,
 * then a scan of the known files for one whose record is gone.
 *
 * Every process and file access goes through `AgentEnvironment`, so tests
 * point HOME, PATH and the agents' own variables at temp folders and fake
 * CLIs; the real agent CLIs are never run by a test.
 */

import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn as spawnChild } from "node:child_process";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { cutText } from "@plannotator/core/inbox-questions";
import {
  INBOX_AGENT_IDS,
  INBOX_AGENT_LABELS,
  inboxAgentList,
  inboxElsewhereText,
  type InboxAgentId,
  type InboxConnectReport,
} from "@plannotator/core/inbox-types";
import {
  configuredInboxTool,
  loadConfig,
  parseInboxToolEnv,
  resolveClaudeCodeMod,
  resolveInboxTool,
  saveConfig,
  type InboxToolHost,
} from "@plannotator/shared/config";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { qwenHome, qwenHomeIsRelative } from "@plannotator/shared/inbox/qwen-sessions";
import { INBOX_QWEN_TRUST_ON_CONNECT, QWEN_TRUST_REVOKED_REASON, ensureQwenTrust, retryQwenRevoke, setQwenTrust, type QwenTrustOutcome } from "./inbox-qwen-trust";
import { addJsonMember, removeJsonMember } from "./json-edit";
import {
  describeFsError,
  readAgentFile,
  samePlace,
  stripJsonComments,
  withBom,
  writeAgentFileAtomic,
} from "./agent-files";

/** The server name every connect snippet uses (`packages/inbox/harnesses.ts`). */
export const INBOX_MCP_SERVER_NAME = "plannotator-inbox";
/** One agent's `mcp add` may take this long. */
export const INBOX_CONNECT_AGENT_TIMEOUT_MS = 10_000;
/** The whole step may take this long; agents still going are tried again at the next run. */
export const INBOX_CONNECT_TOTAL_TIMEOUT_MS = 30_000;
export const INBOX_AGENTS_FILE = "agents.json";
/** `PLANNOTATOR_INBOX_CONNECT=0` skips the step (dotfiles, managed setups). */
export const INBOX_CONNECT_ENV = "PLANNOTATOR_INBOX_CONNECT";

export interface AgentRunResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The process boundary: home, environment, PATH lookup and running a CLI.
 * Tests give temp folders and fake CLIs; nothing here reads the real home
 * except `createAgentEnvironment()`.
 */
export interface AgentEnvironment {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The absolute path of `command` on the environment's PATH, or null. */
  which(command: string): string | null;
  /**
   * Run argv with no stdin, the environment's env, killed (with its process
   * group) after `timeoutMs`, when `signal` aborts, or when this process exits.
   * `cwd`: the folder it runs in (default: this process's). `env`: variables
   * set on top of the environment's for this run.
   */
  run(argv: readonly string[], options: { timeoutMs: number; signal?: AbortSignal; cwd?: string; env?: Readonly<Record<string, string>> }): Promise<AgentRunResult>;
}

/** The real boundary: this process's home, environment and PATH. */
export function createAgentEnvironment(): AgentEnvironment {
  return createAgentEnvironmentFor({ platform: process.platform, homeDir: homedir(), env: process.env });
}

/** A boundary over a given home and environment: PATH lookups and runs use `env` (tests: fakes first on PATH). */
export function createAgentEnvironmentFor(input: {
  platform: NodeJS.Platform;
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
}): AgentEnvironment {
  const { env } = input;
  return {
    platform: input.platform,
    homeDir: input.homeDir,
    env,
    which: (command) => Bun.which(command, { PATH: env.PATH ?? "" }),
    run: (argv, options) => runWithTimeout(argv, options.env ? { ...env, ...options.env } : env, options.timeoutMs, options.signal, options.cwd),
  };
}

/**
 * The agent CLIs running now, each as the function that kills its process
 * group. A run is in its own group (detached), so nothing else ends it: when
 * this process exits (a quit, a restart, the end of a test run) before a
 * run's own time limit, the exit handler kills what is left, or a hung CLI
 * would run on with no parent, forever.
 */
const liveRuns = new Set<() => void>();
let exitHandlerInstalled = false;
function killLiveRuns(): void {
  for (const kill of [...liveRuns]) kill();
}

/** How many agent CLIs this process is running now (tests). */
export function liveAgentRunCount(): number {
  return liveRuns.size;
}

/**
 * Run argv in its own process group (POSIX), no stdin. The answer comes when
 * the process exits, never when its output closes, so a grandchild that keeps
 * stdout open cannot hold it. On the time limit, when `signal` aborts, or when
 * this process exits first, the whole group is killed (SIGKILL), so a CLI that
 * hangs never outlives its run. A CLI that exited by itself is left alone (its
 * group may hold a daemon it started on purpose).
 */
function runWithTimeout(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  signal?: AbortSignal,
  cwd?: string,
): Promise<AgentRunResult> {
  return new Promise((done) => {
    if (signal?.aborted) {
      done({ exitCode: 124, timedOut: true, stdout: "", stderr: "" });
      return;
    }
    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild(argv[0]!, argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...env } as NodeJS.ProcessEnv,
        ...(cwd ? { cwd } : {}),
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      done({ exitCode: 127, timedOut: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exited = false;
    const cap = (text: string) => (text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text);
    child.stdout?.on("data", (chunk: Buffer) => (stdout = cap(stdout + chunk.toString("utf8"))));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = cap(stderr + chunk.toString("utf8"))));
    const kill = () => {
      liveRuns.delete(kill);
      // Once it exited, its pid (and group id) may name another process.
      if (exited) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    const stopRun = () => {
      kill();
      finish({ exitCode: 124, timedOut: true, stdout: "", stderr: "" });
    };
    const finish = (result: AgentRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stopRun);
      liveRuns.delete(kill);
      child.stdout?.destroy();
      child.stderr?.destroy();
      done(result);
    };
    const timer = setTimeout(stopRun, timeoutMs);
    liveRuns.add(kill);
    if (!exitHandlerInstalled) {
      exitHandlerInstalled = true;
      process.on("exit", killLiveRuns);
    }
    signal?.addEventListener("abort", stopRun, { once: true });
    child.on("error", (error) => {
      exited = true;
      finish({ exitCode: 127, timedOut: false, stdout, stderr: error.message });
    });
    // A short grace after exit for the last of its own output, then answer whatever a grandchild holds.
    child.on("exit", (code, exitSignal) => {
      exited = true;
      liveRuns.delete(kill);
      setTimeout(() => finish({ exitCode: code ?? (exitSignal ? 128 : 1), timedOut: false, stdout, stderr }), 50);
    });
  });
}

/**
 * A test run (the preload marks it with PLANNOTATOR_TEST_SANDBOX) may touch
 * agents only in a scratch home: a test that forgot to point HOME at a temp
 * folder must never reach the person's real ~/.codex or ~/.cursor.
 */
export function agentHomeAllowed(e: Pick<AgentEnvironment, "homeDir" | "env">): boolean {
  if (!e.env.PLANNOTATOR_TEST_SANDBOX && !process.env.PLANNOTATOR_TEST_SANDBOX) return true;
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const home = real(e.homeDir);
  return [tmpdir(), "/tmp", "/private/tmp"].some((root) => {
    const base = real(root).replace(/[\\/]+$/, "");
    return home.startsWith(`${base}${sep}`) || home.startsWith(`${base}/`);
  });
}

/** `PLANNOTATOR_INBOX_CONNECT`: `0`/`false`/`off`/`disabled` skip the step. */
export function inboxConnectDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[INBOX_CONNECT_ENV]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "disabled";
}

// ---------------------------------------------------------------------------
// Paths

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function envDir(e: AgentEnvironment, name: string): string | null {
  const value = e.env[name]?.trim();
  if (!value) return null;
  const path = expandHome(value, e.homeDir);
  return isAbsolute(path) ? path : null;
}

/** `$CODEX_HOME` (a relative one resolved against the working folder, as Codex does), else `~/.codex`. */
export function codexHome(e: AgentEnvironment): string {
  const value = e.env.CODEX_HOME?.trim();
  if (value) return resolve(expandHome(value, e.homeDir));
  return join(e.homeDir, ".codex");
}
export function claudeConfigDir(e: AgentEnvironment): string {
  return envDir(e, "CLAUDE_CONFIG_DIR") ?? join(e.homeDir, ".claude");
}
export function piAgentDir(e: AgentEnvironment): string {
  return envDir(e, "PI_CODING_AGENT_DIR") ?? join(e.homeDir, ".pi", "agent");
}
export function xdgConfigHome(e: AgentEnvironment): string {
  return envDir(e, "XDG_CONFIG_HOME") ?? join(e.homeDir, ".config");
}
export function openCodeConfigDir(e: AgentEnvironment): string {
  return envDir(e, "OPENCODE_CONFIG_DIR") ?? join(xdgConfigHome(e), "opencode");
}
/** Gemini CLI's folder: `.gemini` under `$GEMINI_CLI_HOME` when set, else under the home folder. */
export function geminiDir(e: AgentEnvironment): string {
  return join(envDir(e, "GEMINI_CLI_HOME") ?? e.homeDir, ".gemini");
}
/**
 * Qwen Code's folder: `QWEN_HOME` itself when set (in the environment, else
 * in `~/.qwen/.env` or `~/.env`, as Qwen reads it), else `~/.qwen`. A relative
 * `QWEN_HOME` depends on the folder Qwen runs in; it is resolved against the
 * home folder, where Plannotator runs `qwen` (and the connect leaves it to the
 * person).
 */
export function qwenDir(e: AgentEnvironment): string {
  return qwenHome(e.env, e.homeDir, e.homeDir);
}
/** The Claude desktop app's settings folder on this platform. */
export function claudeAppDir(e: AgentEnvironment): string {
  if (e.platform === "darwin") return join(e.homeDir, "Library", "Application Support", "Claude");
  if (e.platform === "win32") return join(envDir(e, "APPDATA") ?? join(e.homeDir, "AppData", "Roaming"), "Claude");
  return join(xdgConfigHome(e), "Claude");
}

/** `~/.codex/config.toml` for display: the home folder as `~`. */
export function displayPath(path: string | null, e: Pick<AgentEnvironment, "homeDir">): string | null {
  if (!path) return null;
  const home = e.homeDir.replace(/[\\/]+$/, "");
  if (path === home) return "~";
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) return `~${path.slice(home.length)}`;
  return path;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The install script's Codex rule: `$CODEX_HOME` holds something besides skills/. */
function codexHomeHasUserConfig(e: AgentEnvironment): boolean {
  const dir = codexHome(e);
  if (!isDir(dir)) return false;
  try {
    return readdirSync(dir).some((name) => name !== "skills" && name !== ".DS_Store");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reading an entry

/** What a config holds under `plannotator-inbox`. */
export type InboxEntryRead =
  | { kind: "absent" }
  /** It runs this Inbox's stdio entry (or a recorded / Plannotator one; see `ownsEntry`). */
  | { kind: "ours"; argv: string[] }
  | { kind: "other"; argv: string[] | null }
  /** The file could not be read or parsed; nothing is written to it. */
  | { kind: "unreadable"; reason: string };

/**
 * Whether argv runs a Plannotator Inbox stdio entry, for uninstall's scan of
 * files whose record is gone and for "already connected": ends in `inbox
 * mcp`, and the program is a binary named exactly `plannotator` (any
 * folder), or a source checkout's entry script (`…/apps/hook/server/index.ts`
 * run by bun or node). `my-plannotator-proxy` is not.
 */
export function isPlannotatorInboxCommand(argv: readonly string[]): boolean {
  if (argv.length < 3) return false;
  if (argv[argv.length - 2] !== "inbox" || argv[argv.length - 1] !== "mcp") return false;
  const program = argv.slice(0, -2);
  if (program.length === 1) return /^plannotator(?:\.exe)?$/i.test(basename(program[0]!.replace(/\\/g, "/")));
  if (program.length === 2) {
    return /^(?:bun|node)(?:\.exe)?$/i.test(basename(program[0]!.replace(/\\/g, "/"))) && /[\\/]apps[\\/]hook[\\/]server[\\/]index\.ts$/.test(program[1]!);
  }
  return false;
}

/** A server entry's argv: `{ command, args }`, OpenCode's `command: [...]`, or an HTTP entry. */
export function entryArgv(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.command) && record.command.every((w) => typeof w === "string")) return record.command as string[];
  if (typeof record.command === "string") {
    const args = Array.isArray(record.args) ? record.args.filter((w): w is string => typeof w === "string") : [];
    return [record.command, ...args];
  }
  return null;
}

const sameArgv = (a: readonly string[] | null, b: readonly string[] | null) => !!a && !!b && a.length === b.length && a.every((w, i) => w === b[i]);

/**
 * Whether an entry is ours: exactly the command this CLI writes (or the one a
 * record says it wrote), else, with `heuristic`, any Plannotator Inbox entry
 * (`isPlannotatorInboxCommand`).
 */
export function ownsEntry(argv: readonly string[] | null, ours: readonly (readonly string[])[], heuristic: boolean): boolean {
  if (!argv) return false;
  if (ours.some((command) => sameArgv(argv, command))) return true;
  return heuristic && isPlannotatorInboxCommand(argv);
}

/** The value at a key path (a key may hold dots, as Amp's `amp.mcpServers`). */
function at(root: unknown, keys: readonly string[]): unknown {
  let value = root;
  for (const key of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** The raw `plannotator-inbox` value in a file: absent, a value, or why it cannot be read. */
type RawEntry = { kind: "absent" } | { kind: "value"; value: unknown } | { kind: "unreadable"; reason: string };

function rawJsonEntry(path: string, keys: readonly string[], jsonc: boolean, maxBytes?: number): RawEntry {
  const read = readAgentFile(path, maxBytes);
  if (read.kind === "missing") return { kind: "absent" };
  if (read.kind === "refused") return { kind: "unreadable", reason: read.reason };
  if (!read.text.trim()) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonc ? stripJsonComments(read.text) : read.text);
  } catch {
    return { kind: "unreadable", reason: "it is not plain JSON" };
  }
  const value = at(parsed, [...keys, INBOX_MCP_SERVER_NAME]);
  return value === undefined ? { kind: "absent" } : { kind: "value", value };
}

/** Codex's config.toml, parsed as TOML (every form: tables, inline tables, dotted keys, quoted parts). */
function rawCodexEntry(path: string): RawEntry {
  const read = readAgentFile(path);
  if (read.kind === "missing") return { kind: "absent" };
  if (read.kind === "refused") return { kind: "unreadable", reason: read.reason };
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(read.text);
  } catch {
    return { kind: "unreadable", reason: "it is not valid TOML" };
  }
  const value = at(parsed, ["mcp_servers", INBOX_MCP_SERVER_NAME]);
  return value === undefined ? { kind: "absent" } : { kind: "value", value };
}

function classify(raw: RawEntry, ours: readonly (readonly string[])[], heuristic: boolean): InboxEntryRead {
  if (raw.kind !== "value") return raw;
  const argv = entryArgv(raw.value);
  return ownsEntry(argv, ours, heuristic) ? { kind: "ours", argv: argv! } : { kind: "other", argv };
}

/** Codex's `plannotator-inbox` in config.toml (read only; `codex mcp` writes it). `ours`: the commands that count as ours. */
export function readCodexEntry(path: string, ours: readonly (readonly string[])[] = [], heuristic = true): InboxEntryRead {
  return classify(rawCodexEntry(path), ours, heuristic);
}

// ---------------------------------------------------------------------------
// The agents

/** How a found agent is connected. */
type ConnectWay =
  /** Run the agent's own `mcp add`; remove with its `mcp remove`. */
  | { kind: "cli"; bin: string; add: (command: readonly string[]) => string[]; remove: string[] }
  /** One key in a JSON file (`json`: how it is edited). */
  | { kind: "json"; keys: readonly string[]; json?: JsonFileRules }
  /** `inboxTool` on for Plannotator's own extension/plugin. */
  | { kind: "tool"; host: InboxToolHost }
  /** Only a person can connect it; `why` says how. */
  | { kind: "manual"; why: string }
  /** Nothing to do (Claude Code). */
  | { kind: "none" };

interface AgentSpec {
  id: InboxAgentId;
  /** Found on this computer. */
  detect(e: AgentEnvironment): boolean;
  /**
   * How it is connected, once found. `probe`: ask the CLI its `--version`
   * first (before writing anything); without it (the Settings model, a read)
   * nothing is run.
   */
  way(e: AgentEnvironment, probe?: boolean): Promise<ConnectWay>;
  /** Where its `plannotator-inbox` entry lives (null: unknown, or not a file). */
  file(e: AgentEnvironment): string | null;
  /** The raw entry, read only. Null: the agent's file is not known; the record decides. */
  raw(e: AgentEnvironment): RawEntry | null;
  /** How uninstall removes it, when not a JSON key. */
  remove?: { bin: string; args: string[] };
}

/**
 * How Plannotator edits an agent's JSON file itself. `comments`: the file is
 * JSON with comments (json-edit.ts keeps every one). `keepReadOnly`: a
 * read-only file is left as it is (the person locked it), never replaced.
 */
export interface JsonFileRules {
  comments?: boolean;
  keepReadOnly?: boolean;
}

const NAME = INBOX_MCP_SERVER_NAME;

/** Whether Plannotator's Pi extension is installed (Pi's settings.json `packages`). */
export function piExtensionInstalled(e: AgentEnvironment): boolean {
  const read = readAgentFile(join(piAgentDir(e), "settings.json"));
  if (read.kind !== "file") return false;
  try {
    const packages = (JSON.parse(stripJsonComments(read.text)) as { packages?: unknown }).packages;
    if (!Array.isArray(packages)) return false;
    return packages.some((entry) => {
      const source = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { source?: unknown }).source : null;
      return typeof source === "string" && /@plannotator\/pi-extension|plannotator[\\/]+apps[\\/]+pi-extension/.test(source);
    });
  } catch {
    return false;
  }
}

/**
 * Which OpenCode this computer runs, from evidence only: the global config's
 * own shape first (V2's `plugins`, V1's `plugin`), then the commands on PATH
 * (`opencode2` is OpenCode 2, whose package also ships `opencode`; `opencode`
 * alone is OpenCode 1). Undefined when nothing says.
 */
export function openCodeGeneration(e: AgentEnvironment): "1" | "2" | undefined {
  const dir = openCodeConfigDir(e);
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const read = readAgentFile(join(dir, name));
    if (read.kind !== "file") continue;
    try {
      const parsed = JSON.parse(stripJsonComments(read.text)) as { plugin?: unknown; plugins?: unknown };
      if (Array.isArray(parsed.plugins)) return "2";
      if (Array.isArray(parsed.plugin)) return "1";
    } catch {
      // Unreadable: no evidence here.
    }
  }
  if (e.which("opencode2")) return "2";
  if (e.which("opencode")) return "1";
  return undefined;
}

/** Whether Plannotator's OpenCode plugin is listed in the global opencode config: `plugin` (OpenCode 1) or `plugins` (OpenCode 2, strings or `{ package }`). */
export function openCodePluginInstalled(e: AgentEnvironment): boolean {
  const dir = openCodeConfigDir(e);
  const isOurs = (item: unknown) => {
    const spec =
      typeof item === "string"
        ? item
        : Array.isArray(item) && typeof item[0] === "string"
          ? item[0]
          : item && typeof item === "object" && typeof (item as { package?: unknown }).package === "string"
            ? (item as { package: string }).package
            : null;
    return spec !== null && /^@plannotator\/opencode(?:@|$)/.test(spec);
  };
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const read = readAgentFile(join(dir, name));
    if (read.kind !== "file") continue;
    try {
      const parsed = JSON.parse(stripJsonComments(read.text)) as { plugin?: unknown; plugins?: unknown };
      const lists = [parsed.plugin, parsed.plugins].filter(Array.isArray) as unknown[][];
      if (lists.some((list) => list.some(isOurs))) return true;
    } catch {
      // Unreadable: not found here.
    }
  }
  return false;
}

const CLAUDE_PLUGIN_ID = /^plannotator@/;

/** One Claude Code settings file, parsed (null: missing or unreadable). */
function readClaudeSettings(path: string): { enabledPlugins?: unknown; env?: unknown } | null {
  const read = readAgentFile(path);
  if (read.kind !== "file") return null;
  try {
    const parsed = JSON.parse(stripJsonComments(read.text)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as { enabledPlugins?: unknown; env?: unknown }) : null;
  } catch {
    return null;
  }
}

/** `enabledPlugins` in one Claude Code settings file: true or false when it names Plannotator's plugin, else undefined. */
function claudeSettingsPluginState(settings: { enabledPlugins?: unknown } | null): boolean | undefined {
  const enabled = settings?.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return undefined;
  const ours = Object.entries(enabled).filter(([id, on]) => CLAUDE_PLUGIN_ID.test(id) && typeof on === "boolean");
  if (ours.some(([, on]) => on === true)) return true;
  return ours.length > 0 ? false : undefined;
}

/** Claude Code's settings scopes the Inbox can read, strongest first: managed, then the user's settings.local.json, then settings.json. */
function claudeSettingsScopes(e: AgentEnvironment): { scope: "managed" | "user"; settings: { enabledPlugins?: unknown; env?: unknown } | null }[] {
  const managed = claudeManagedSettingsPath(e);
  return [
    ...(managed ? [{ scope: "managed" as const, settings: readClaudeSettings(managed) }] : []),
    { scope: "user" as const, settings: readClaudeSettings(join(claudeConfigDir(e), "settings.local.json")) },
    { scope: "user" as const, settings: readClaudeSettings(join(claudeConfigDir(e), "settings.json")) },
  ];
}

/**
 * The plugin's state from the scopes (strongest first) and the registry: the
 * strongest scope that names it decides (managed settings turning it off win
 * over the user's true), else the registry. Pure.
 */
export function claudePluginStateFromScopes(
  scopes: readonly { scope: "managed" | "user"; on: boolean | undefined }[],
  registered: boolean,
): { state: "enabled" | "disabled" | "absent"; managed: boolean } {
  const decided = scopes.find((scope) => scope.on !== undefined);
  if (decided) return { state: decided.on ? "enabled" : "disabled", managed: decided.scope === "managed" };
  return { state: registered ? "enabled" : "absent", managed: false };
}

/** Claude Code's managed (enterprise) settings file, per platform. */
function claudeManagedSettingsPath(e: AgentEnvironment): string | null {
  // A test's agents never read the machine's own managed settings.
  if (process.env.PLANNOTATOR_TEST_SANDBOX) return null;
  if (e.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (e.platform === "linux") return "/etc/claude-code/managed-settings.json";
  if (e.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return null;
}

/** Whether Claude Code's plugin registry (`plugins/installed_plugins.json`, v2 `{ plugins: { id: [...] } }` or the v1 object) records Plannotator's plugin. */
function claudePluginRegistered(e: AgentEnvironment): boolean {
  const read = readAgentFile(join(claudeConfigDir(e), "plugins", "installed_plugins.json"));
  if (read.kind !== "file") return false;
  try {
    const parsed = JSON.parse(read.text) as { plugins?: Record<string, unknown> } & Record<string, unknown>;
    const table = parsed.plugins && typeof parsed.plugins === "object" ? parsed.plugins : parsed;
    return Object.entries(table).some(([id, value]) => CLAUDE_PLUGIN_ID.test(id) && (Array.isArray(value) ? value.length > 0 : !!value && typeof value === "object"));
  } catch {
    return false;
  }
}

/**
 * Whether Plannotator's Claude Code plugin is enabled for this user: a
 * settings scope the Inbox can see (user `settings.json` and
 * `settings.local.json`, managed settings) enables it, or Claude Code's plugin
 * registry records it and no scope turns it off. A project's own
 * `.claude/settings.json` and `claude --plugin-dir` are not visible here; the
 * window counts a live Claude Code session as connected for those.
 */
export function claudeCodePluginEnabled(e: AgentEnvironment): boolean {
  return claudeCodePluginState(e) === "enabled";
}

/**
 * Plannotator's Claude Code plugin: `enabled` (see claudeCodePluginEnabled),
 * `disabled` (a settings scope turns it off by name, as `claude plugin
 * disable` does: the person's choice), or `absent`.
 */
export function claudeCodePluginState(e: AgentEnvironment): "enabled" | "disabled" | "absent" {
  return claudeCodePluginStatus(e).state;
}

/** claudeCodePluginState, and whether managed (enterprise) settings decided it. */
export function claudeCodePluginStatus(e: AgentEnvironment): { state: "enabled" | "disabled" | "absent"; managed: boolean } {
  const scopes = claudeSettingsScopes(e).map(({ scope, settings }) => ({ scope, on: claudeSettingsPluginState(settings) }));
  return claudePluginStateFromScopes(scopes, claudePluginRegistered(e));
}

/**
 * `PLANNOTATOR_CLAUDE_MOD` as Claude Code's own process sees it: the `env`
 * block of its settings (the strongest scope that sets it), else this
 * process's environment (the shell that started the Inbox may be the one that
 * starts Claude Code). Undefined when nothing sets it.
 */
function claudeCodeModEnv(e: AgentEnvironment): string | undefined {
  for (const { settings } of claudeSettingsScopes(e)) {
    const env = settings?.env;
    if (env && typeof env === "object") {
      const value = (env as Record<string, unknown>).PLANNOTATOR_CLAUDE_MOD;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    }
  }
  return e.env.PLANNOTATOR_CLAUDE_MOD;
}

/**
 * Whether the Claude Code mod, which registers the `plannotator_inbox` tool,
 * is on, with the mod's own precedence: `PLANNOTATOR_CLAUDE_MOD` (Claude
 * Code's settings `env`, else this process's environment), then config.json
 * `claudeCodeMod`. Off, Claude Code has no Inbox tool even with the plugin.
 */
export function claudeCodeModOn(e: AgentEnvironment): boolean {
  const value = claudeCodeModEnv(e);
  return resolveClaudeCodeMod(loadConfig(), value === undefined ? {} : { PLANNOTATOR_CLAUDE_MOD: value });
}

/** Claude Code's Inbox tool is on: the plugin's mod is on and `inboxTool` allows it. */
export function claudeCodeInboxToolOn(e: AgentEnvironment): boolean {
  return claudeCodeModOn(e) && resolveInboxTool(loadConfig(), e.env as NodeJS.ProcessEnv, "claude-code");
}

/**
 * Each CLI's own `--version` line, so a program that only shares the name
 * (cln's `pi` printing digits, amp.rs) is never handed an `mcp add`, and a
 * build older than its `mcp add` is left to the person: Pi before 0.99 (no
 * `pi mcp`: it would read the words as a chat prompt and run a model turn),
 * Codex CLI before 0.35.0 (`codex mcp add` landed in rust-v0.35.0, Sep 2025)
 * and Gemini CLI before 0.1.19 (`gemini mcp add`, Aug 2025). Qwen Code's
 * settings.json is edited by Plannotator itself, so any Qwen Code version
 * will do; the line only tells Qwen Code from another `qwen`. Read with no
 * stdin, under the limit.
 */
const VERSION_SHAPES: Record<string, { line: RegExp; min?: [number, number, number]; older?: string; manual: string }> = {
  codex: {
    line: /^codex-cli (\d+)\.(\d+)\.(\d+)\b/,
    min: [0, 35, 0],
    older: "Codex CLI before 0.35 has no `codex mcp add`; update Codex, or add plannotator-inbox to its config.toml by hand",
    manual: "this codex did not answer like Codex CLI",
  },
  gemini: {
    line: /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/,
    min: [0, 1, 19],
    older: "Gemini CLI before 0.1.19 has no `gemini mcp add`; update Gemini CLI, or add plannotator-inbox to its settings.json by hand",
    manual: "this gemini did not answer like Gemini CLI",
  },
  qwen: {
    line: /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/,
    manual: "this qwen did not answer like Qwen Code",
  },
  devin: { line: /^devin (\d+)\.(\d+)\.(\d+)\b/, manual: "this devin did not answer like Devin" },
  amp: { line: /^(\d+)\.(\d+)\.(\d+)-g[0-9a-f]+\b/, manual: "this amp did not answer like Sourcegraph Amp" },
  pi: {
    line: /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/,
    min: [0, 99, 0],
    manual: "Pi before 0.99 has no `pi mcp`; update Pi, or add plannotator-inbox to ~/.pi/agent/mcp.json by hand",
  },
};

async function cliWay(
  e: AgentEnvironment,
  bin: string,
  add: (command: readonly string[]) => string[],
  remove: string[],
  timeoutMs: number,
  probe: boolean,
): Promise<ConnectWay> {
  const path = e.which(bin);
  if (!path) return { kind: "manual", why: `${bin} is not on PATH` };
  if (probe) {
    const refused = await versionRefusal(e, bin, path, timeoutMs);
    if (refused) return { kind: "manual", why: refused };
  }
  return { kind: "cli", bin, add, remove };
}

/**
 * Ask a CLI its `--version` (VERSION_SHAPES) before anything is written for
 * it: why it is left to the person (not the CLI it is named for, or older
 * than its `mcp add`), or null. `cwd`: the folder it runs in.
 */
async function versionRefusal(e: AgentEnvironment, bin: string, path: string, timeoutMs: number, cwd?: string): Promise<string | null> {
  const shape = VERSION_SHAPES[bin];
  if (!shape) return null;
  const ran = await agentVersionRun(e, path, { timeoutMs: Math.min(timeoutMs, 5_000), ...(cwd ? { cwd } : {}) });
  const line = ran.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const match = ran.exitCode === 0 && !ran.timedOut ? shape.line.exec(line) : null;
  if (!match) return shape.manual;
  if (shape.min) {
    const version = [Number(match[1]), Number(match[2]), Number(match[3])];
    const [a, b, c] = shape.min;
    const older = version[0]! < a || (version[0] === a && (version[1]! < b || (version[1] === b && version[2]! < c)));
    if (older) return shape.older ?? shape.manual;
  }
  return null;
}

/** How long a CLI's `--version` answer is reused (one connect run asks it once, however many steps need it). */
const VERSION_ANSWER_TTL_MS = 60_000;
const versionAnswers = new Map<string, { at: number; answer: Promise<AgentRunResult> }>();

/**
 * `<path> --version`, answered once per minute for the same program (its
 * path, size and change time) and the same environment, so the connect step
 * and Qwen's trusted-sender check ask once. A run that timed out is not kept.
 */
export function agentVersionRun(e: AgentEnvironment, path: string, options: { timeoutMs: number; signal?: AbortSignal; cwd?: string }): Promise<AgentRunResult> {
  let stamp = "";
  try {
    const stat = statSync(path);
    stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  } catch {
    // Not there: asked as it is (the run says why).
  }
  const key = JSON.stringify([path, stamp, options.cwd ?? null, e.platform, e.homeDir, e.env]);
  const at = Date.now();
  for (const [old, value] of versionAnswers) if (at - value.at > VERSION_ANSWER_TTL_MS) versionAnswers.delete(old);
  const kept = versionAnswers.get(key);
  if (kept) return kept.answer;
  const answer = e.run([path, "--version"], options);
  versionAnswers.set(key, { at, answer });
  void answer.then((result) => {
    if (result.timedOut || result.exitCode === 127) versionAnswers.delete(key);
  });
  return answer;
}

/** Qwen Code's settings.json: JSON with comments, edited by Plannotator itself; a read-only one is left alone. */
const QWEN_SETTINGS_RULES: JsonFileRules = { comments: true, keepReadOnly: true };

/**
 * Qwen Code is connected by editing its user settings.json directly, never
 * with `qwen mcp add` / `remove`: those write back every MCP server with its
 * `$VAR` / `${VAR}` values expanded (a token kept in the environment would
 * land in the file as plain text). A `qwen` on PATH is asked its version
 * first (run in the home folder, so Qwen never touches a project's
 * `.qwen/settings.json`), so another program named `qwen` is not taken for
 * it. A relative `QWEN_HOME` names a different folder in every project, so
 * that is left to the person.
 */
async function qwenWay(e: AgentEnvironment, probe: boolean): Promise<ConnectWay> {
  if (qwenHomeIsRelative(e.env, e.homeDir)) {
    return { kind: "manual", why: "QWEN_HOME is a relative path, so Qwen Code's folder depends on where it runs; add plannotator-inbox to its settings.json by hand" };
  }
  const path = e.which("qwen");
  if (path && probe) {
    const refused = await versionRefusal(e, "qwen", path, INBOX_CONNECT_AGENT_TIMEOUT_MS, e.homeDir);
    if (refused) return { kind: "manual", why: refused };
  }
  return { kind: "json", keys: ["mcpServers"], json: QWEN_SETTINGS_RULES };
}

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    id: "claude-code",
    // The plugin, or `claude` on PATH without it (the first-run screen offers the plugin's install command).
    detect: (e) => claudeCodePluginEnabled(e) || !!e.which("claude"),
    way: async () => ({ kind: "none" }),
    file: () => null,
    raw: () => null,
  },
  {
    id: "codex",
    detect: (e) => !!e.which("codex") || codexHomeHasUserConfig(e),
    way: (e, probe) => cliWay(e, "codex", (cmd) => ["mcp", "add", NAME, "--", ...cmd], ["mcp", "remove", NAME], INBOX_CONNECT_AGENT_TIMEOUT_MS, probe === true),
    file: (e) => join(codexHome(e), "config.toml"),
    raw: (e) => rawCodexEntry(join(codexHome(e), "config.toml")),
    remove: { bin: "codex", args: ["mcp", "remove", NAME] },
  },
  {
    id: "gemini",
    detect: (e) => !!e.which("gemini") || isDir(geminiDir(e)),
    way: (e, probe) => cliWay(e, "gemini", (cmd) => ["mcp", "add", "-s", "user", NAME, ...cmd], ["mcp", "remove", "-s", "user", NAME], INBOX_CONNECT_AGENT_TIMEOUT_MS, probe === true),
    file: (e) => join(geminiDir(e), "settings.json"),
    raw: (e) => rawJsonEntry(join(geminiDir(e), "settings.json"), ["mcpServers"], true),
    remove: { bin: "gemini", args: ["mcp", "remove", "-s", "user", NAME] },
  },
  {
    id: "qwen",
    detect: (e) => !!e.which("qwen") || isDir(qwenDir(e)),
    way: (e, probe) => qwenWay(e, probe === true),
    file: (e) => join(qwenDir(e), "settings.json"),
    raw: (e) => rawJsonEntry(join(qwenDir(e), "settings.json"), ["mcpServers"], true),
  },
  {
    id: "cursor",
    detect: (e) => isDir(join(e.homeDir, ".cursor")) || !!e.which("cursor") || !!e.which("cursor-agent"),
    way: async () => ({ kind: "json", keys: ["mcpServers"] }),
    file: (e) => join(e.homeDir, ".cursor", "mcp.json"),
    raw: (e) => rawJsonEntry(join(e.homeDir, ".cursor", "mcp.json"), ["mcpServers"], false),
  },
  {
    id: "windsurf",
    detect: (e) => !!e.which("devin"),
    way: (e, probe) => cliWay(e, "devin", (cmd) => ["mcp", "add", "-s", "user", NAME, "--", ...cmd], ["mcp", "remove", "-s", "user", NAME], INBOX_CONNECT_AGENT_TIMEOUT_MS, probe === true),
    file: (e) => join(xdgConfigHome(e), "devin", "config.json"),
    raw: (e) => rawJsonEntry(join(xdgConfigHome(e), "devin", "config.json"), ["mcpServers"], true),
    remove: { bin: "devin", args: ["mcp", "remove", "-s", "user", NAME] },
  },
  {
    id: "amp",
    detect: (e) => !!e.which("amp"),
    way: (e, probe) => cliWay(e, "amp", (cmd) => ["mcp", "add", NAME, "--", ...cmd], ["mcp", "remove", NAME], INBOX_CONNECT_AGENT_TIMEOUT_MS, probe === true),
    file: (e) => join(xdgConfigHome(e), "amp", "settings.json"),
    raw: (e) => rawJsonEntry(join(xdgConfigHome(e), "amp", "settings.json"), ["amp.mcpServers"], true),
    remove: { bin: "amp", args: ["mcp", "remove", NAME] },
  },
  {
    id: "cline",
    detect: (e) => !!e.which("cline"),
    // Cline CLI's `mcp add` and its config file are not verified (and a positional word can start a task), so a person adds it.
    way: async () => ({ kind: "manual", why: "Cline's MCP command is not verified; add it in Cline's MCP settings" }),
    file: () => null,
    raw: () => null,
  },
  {
    id: "kiro",
    detect: (e) => !!e.which("kiro-cli") || isDir(join(e.homeDir, ".kiro")),
    way: async () => ({ kind: "json", keys: ["mcpServers"] }),
    file: (e) => join(e.homeDir, ".kiro", "settings", "mcp.json"),
    raw: (e) => rawJsonEntry(join(e.homeDir, ".kiro", "settings", "mcp.json"), ["mcpServers"], false),
  },
  {
    id: "pi",
    detect: (e) => piExtensionInstalled(e) || !!e.which("pi"),
    way: (e, probe) =>
      piExtensionInstalled(e)
        ? Promise.resolve({ kind: "tool", host: "pi" } as ConnectWay)
        : cliWay(e, "pi", (cmd) => ["mcp", "add", NAME, "--", ...cmd], ["mcp", "remove", NAME], INBOX_CONNECT_AGENT_TIMEOUT_MS, probe === true),
    file: (e) => join(piAgentDir(e), "mcp.json"),
    raw: (e) => rawJsonEntry(join(piAgentDir(e), "mcp.json"), ["mcpServers"], true),
    remove: { bin: "pi", args: ["mcp", "remove", NAME] },
  },
  {
    id: "opencode",
    detect: (e) => openCodePluginInstalled(e) || !!e.which("opencode") || !!e.which("opencode2"),
    // Without the plugin: opencode.json may be JSONC and per project, so a person adds it.
    way: async (e) => (openCodePluginInstalled(e) ? { kind: "tool", host: "opencode" } : { kind: "manual", why: "add Plannotator's OpenCode plugin, or the server to opencode.json" }),
    file: () => null,
    raw: () => null,
  },
  {
    id: "claude-app",
    detect: (e) => isDir(claudeAppDir(e)),
    way: async () => ({ kind: "json", keys: ["mcpServers"] }),
    file: (e) => join(claudeAppDir(e), "claude_desktop_config.json"),
    raw: (e) => rawJsonEntry(join(claudeAppDir(e), "claude_desktop_config.json"), ["mcpServers"], false),
  },
];

export function agentSpec(id: InboxAgentId): AgentSpec {
  return AGENT_SPECS.find((spec) => spec.id === id)!;
}

/** One agent's entry, read only, judged against the commands that count as ours. */
export function readAgentEntry(id: InboxAgentId, e: AgentEnvironment, ours: readonly (readonly string[])[], heuristic = false): InboxEntryRead | null {
  const raw = agentSpec(id).raw(e);
  return raw === null ? null : classify(raw, ours, heuristic);
}

// ---------------------------------------------------------------------------
// Writing one JSON key

/**
 * What an add changed, as text: the file was `prefix + before + suffix` and
 * became `prefix + after + suffix`. Kept on the record so removal gives the
 * file back byte for byte (an empty file stays empty, a final newline or its
 * absence stays, a container Plannotator created goes) while `after` is
 * still in the file untouched.
 */
export interface JsonEntryUndo {
  before: string;
  after: string;
}

type WriteOutcome = { ok: true; changed: boolean; undo?: JsonEntryUndo } | { ok: false; reason: string };

/** Delete a file Plannotator created once it holds nothing but the empty containers along `keys`. */
function deleteIfOnlyOurs(path: string, keys: readonly string[]): void {
  const read = readAgentFile(path);
  if (read.kind !== "file") return;
  let skeleton: unknown = {};
  for (const key of [...keys].reverse()) skeleton = { [key]: skeleton };
  try {
    if (read.text.trim() && JSON.stringify(JSON.parse(read.text)) !== JSON.stringify(skeleton)) return;
    rmSync(read.target, { force: true });
  } catch {
    // Not plain JSON any more, or not removable: left as it is.
  }
}

/** Whether a file may be written: its mode has the owner's write bit and this process may write it. */
function writableFile(target: string, mode: number): boolean {
  if ((mode & 0o200) === 0) return false;
  try {
    accessSync(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The smallest middle span that differs between two texts. */
function textChange(original: string, next: string): JsonEntryUndo {
  let start = 0;
  while (start < original.length && start < next.length && original[start] === next[start]) start++;
  let end = 0;
  while (end < original.length - start && end < next.length - start && original[original.length - 1 - end] === next[next.length - 1 - end]) end++;
  return { before: original.slice(start, original.length - end), after: next.slice(start, next.length - end) };
}

/**
 * Undo an add exactly: `after` appears once in `text` (the entry as written,
 * untouched) and putting `before` back leaves a file without the entry. Null
 * when that cannot be done; the caller then cuts the entry alone.
 */
function undoJsonEntry(text: string, undo: JsonEntryUndo | undefined, keys: readonly string[], comments: boolean): string | null {
  if (!undo || !undo.after || !undo.after.includes(JSON.stringify(NAME))) return null;
  const first = text.indexOf(undo.after);
  if (first < 0 || text.indexOf(undo.after, first + 1) >= 0) return null;
  const restored = text.slice(0, first) + undo.before + text.slice(first + undo.after.length);
  if (!restored.trim()) return restored;
  try {
    return at(JSON.parse(comments ? stripJsonComments(restored) : restored), [...keys, NAME]) === undefined ? restored : null;
  } catch {
    return null;
  }
}

/**
 * Add (`value`) or remove (`undefined`) `plannotator-inbox` at `keys` in a
 * JSON file, losslessly (json-edit.ts: only that member's text changes;
 * anything else is refused, with the reason), atomically, written at a
 * symlink's target, a no-op when nothing changes. `ours`: the commands a
 * removal may take away; an entry running anything else is never replaced or
 * removed. `rules`: comments allowed, a read-only file kept.
 */
export function writeJsonEntry(
  path: string,
  keys: readonly string[],
  value: { command: string; args: string[] } | undefined,
  ours: readonly (readonly string[])[] = value ? [[value.command, ...value.args]] : [],
  undo?: JsonEntryUndo,
  rules: JsonFileRules = {},
): WriteOutcome {
  const comments = rules.comments === true;
  const read = readAgentFile(path);
  if (read.kind === "refused") return { ok: false, reason: `${path} can't be edited (${read.reason})` };
  if (read.kind === "missing" && value === undefined) return { ok: true, changed: false };
  const original = read.kind === "file" ? read.text : "";
  if (original.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(comments ? stripJsonComments(original) : original);
    } catch {
      return { ok: false, reason: `${path} is not ${comments ? "valid" : "plain"} JSON, so Plannotator left it as it was` };
    }
    const current = at(parsed, [...keys, NAME]);
    if (current !== undefined) {
      const owned = ownsEntry(entryArgv(current), ours, false);
      if (value !== undefined) return owned ? { ok: true, changed: false } : { ok: false, reason: `${path} has its own ${NAME} entry` };
      if (!owned) return { ok: false, reason: `${path} has a ${NAME} entry Plannotator did not write` };
    } else if (value === undefined) return { ok: true, changed: false };
  }
  const undone = value === undefined ? undoJsonEntry(original, undo, keys, comments) : null;
  const edit =
    undone !== null
      ? { ok: true as const, changed: true, text: undone }
      : value === undefined
        ? removeJsonMember(original, keys, NAME, { comments })
        : addJsonMember(original, keys, NAME, value, { comments });
  if (!edit.ok) return { ok: false, reason: `${path} can't be edited without reshaping it (${edit.reason}), so Plannotator left it as it was` };
  if (!edit.changed) return { ok: true, changed: false };
  if (rules.keepReadOnly && read.kind === "file" && !writableFile(read.target, read.mode)) {
    return { ok: false, reason: `${path} is read-only, so Plannotator left it as it was` };
  }
  try {
    writeAgentFileAtomic(read.target, withBom(edit.text, read.kind === "file" && read.bom), read.kind === "file" ? read.mode : 0o600);
  } catch (error) {
    return { ok: false, reason: `${path} can't be written (${describeFsError(error)})` };
  }
  // A file Plannotator created holds nothing else once the entry goes: its undo is "no file".
  return value === undefined || read.kind !== "file" ? { ok: true, changed: true } : { ok: true, changed: true, undo: textChange(original, edit.text) };
}

// ---------------------------------------------------------------------------
// Records: inbox/agents.json

export interface InboxAgentRecord {
  /**
   * added: Plannotator connected it. found: it already reached the Inbox.
   * foreign: its `plannotator-inbox` runs something else. off: the person
   * turned it off (Settings, or `inboxTool` false).
   */
  state: "added" | "found" | "foreign" | "off";
  reach: "mcp" | "tool";
  /** The file the entry is in (null: the tool switch, or a file Plannotator does not know). */
  path: string | null;
  /** The argv written, for an entry Plannotator added. */
  command?: string[];
  /** A JSON add's exact change, so removal gives the file back byte for byte (writeJsonEntry). */
  undo?: JsonEntryUndo;
  /** Entries Plannotator added in other files that a move could not take back out: uninstall removes them too. */
  strays?: { path: string; command?: string[]; undo?: JsonEntryUndo; created?: boolean }[];
  /** Plannotator created the JSON file: removal deletes it when nothing but the empty containers is left. */
  created?: boolean;
  at: string;
  /** An `added`/`found` entry that is no longer there: never added back by itself. */
  removed_outside_at?: string;
}

export interface InboxAgentsFile {
  v: 1;
  /** When the first run connected something. */
  first_connected_at?: string;
  agents: Partial<Record<InboxAgentId, InboxAgentRecord>>;
  /** The last run's report, for the window's one-line card. `seen` once the person closed it. */
  last_report?: InboxConnectReport & { seen?: boolean };
  /** Each agent's last failure reason, so a lasting one is said once (the run still tries again). */
  failures?: Partial<Record<InboxAgentId, string>>;
  /** Each agent's last "connect it by hand" reason, so it is said once (said again when it changes). */
  manual_said?: Partial<Record<InboxAgentId, string>>;
  /** Each agent last said to be connected in another file than the environment names (`recorded -> now`): said once. */
  elsewhere_said?: Partial<Record<InboxAgentId, string>>;
}

export function inboxAgentsPath(dataDir: string): string {
  return join(inboxDir(dataDir), INBOX_AGENTS_FILE);
}

export function readInboxAgents(dataDir: string): InboxAgentsFile {
  try {
    const parsed = JSON.parse(readFileSync(inboxAgentsPath(dataDir), "utf8")) as Partial<InboxAgentsFile>;
    if (parsed && parsed.v === 1 && parsed.agents && typeof parsed.agents === "object") {
      const agents: InboxAgentsFile["agents"] = {};
      for (const id of INBOX_AGENT_IDS) {
        const record = (parsed.agents as Record<string, unknown>)[id];
        if (record && typeof record === "object" && typeof (record as InboxAgentRecord).state === "string") agents[id] = record as InboxAgentRecord;
      }
      return { ...parsed, v: 1, agents } as InboxAgentsFile;
    }
  } catch {
    // Missing or damaged: start over (nothing in it is the only copy of anything).
  }
  return { v: 1, agents: {} };
}

export function writeInboxAgents(dataDir: string, file: InboxAgentsFile): void {
  const dir = inboxDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAgentFileAtomic(inboxAgentsPath(dataDir), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

// ---------------------------------------------------------------------------
// The connect step

export interface ConnectOptions {
  dataDir: string;
  /** The stdio entry's argv without `inbox mcp`: `selfCommand()`. */
  selfCommand: readonly string[];
  environment: AgentEnvironment;
  now?: () => Date;
  agentTimeoutMs?: number;
  totalTimeoutMs?: number;
  /**
   * The caller is going away (the Inbox stops): agent CLIs still running are
   * killed and left for the next run, as at the step's time limit, and
   * nothing is written.
   */
  signal?: AbortSignal;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return cutText(line, 200);
}

/** A time limit as people read it: "10 s", "1.5 s" (never rounded up to a limit it was not). */
export function formatSeconds(ms: number): string {
  const seconds = Math.floor(ms / 100) / 10;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

type AgentOutcome =
  | { kind: "added"; record: InboxAgentRecord }
  | { kind: "already"; record: InboxAgentRecord | null }
  | { kind: "foreign"; record: InboxAgentRecord; path: string | null }
  | { kind: "failed"; reason: string; path: string | null }
  | { kind: "manual"; why: string }
  | { kind: "off"; record: InboxAgentRecord }
  | { kind: "none" };

/** The commands that count as this CLI's entry: what it writes now, and what a record says it wrote. */
function ourCommands(options: ConnectOptions, record?: InboxAgentRecord): string[][] {
  const commands = [[...options.selfCommand, "inbox", "mcp"]];
  if (record?.command) commands.push(record.command);
  return commands;
}

/**
 * Connect one agent. `force`: the person's own switch (Settings), which adds
 * the entry whatever the record says; the run itself only reaches agents with
 * no record. Never replaces an entry it did not write.
 */
async function connectOne(spec: AgentSpec, options: ConnectOptions, at: string): Promise<AgentOutcome> {
  const e = options.environment;
  const timeoutMs = options.agentTimeoutMs ?? INBOX_CONNECT_AGENT_TIMEOUT_MS;
  const way = await spec.way(e, true);
  const file = spec.file(e);
  const command = [...options.selfCommand, "inbox", "mcp"];
  if (way.kind === "none") return { kind: "none" };
  if (way.kind === "manual") return { kind: "manual", why: way.why };
  if (way.kind === "tool") {
    // The env var decides (and locks the switch): nothing to write.
    if (parseInboxToolEnv(e.env as NodeJS.ProcessEnv) !== undefined) {
      return resolveInboxTool(loadConfig(), e.env as NodeJS.ProcessEnv, way.host) ? { kind: "already", record: null } : { kind: "none" };
    }
    const configured = configuredInboxTool(loadConfig(), way.host);
    if (configured === true) return { kind: "already", record: { state: "found", reach: "tool", path: null, at } };
    if (configured === false) return { kind: "off", record: { state: "off", reach: "tool", path: null, at } };
    const current = loadConfig().inboxTool;
    const next: Partial<Record<InboxToolHost, boolean>> = {};
    for (const host of ["claude-code", "pi", "opencode"] as const) {
      const value = typeof current === "boolean" ? current : current?.[host];
      if (typeof value === "boolean") next[host] = value;
    }
    next[way.host] = true;
    saveConfig({ inboxTool: next });
    if (configuredInboxTool(loadConfig(), way.host) !== true) {
      return { kind: "failed", reason: "Plannotator's config.json can't be written", path: null };
    }
    return { kind: "added", record: { state: "added", reach: "tool", path: null, at } };
  }
  const before = classify(spec.raw(e) ?? { kind: "absent" }, ourCommands(options), true);
  if (before.kind === "unreadable") {
    return { kind: "failed", reason: `${displayPath(file, e)} can't be read (${before.reason}), so Plannotator left it as it was`, path: file };
  }
  if (before.kind === "ours") return { kind: "already", record: { state: "found", reach: "mcp", path: file, at } };
  if (before.kind === "other") return { kind: "foreign", record: { state: "foreign", reach: "mcp", path: file, at }, path: file };
  if (way.kind === "json") {
    const [cmd, ...args] = command;
    const created = readAgentFile(file!).kind === "missing";
    const result = writeJsonEntry(file!, way.keys, { command: cmd!, args }, undefined, undefined, way.json);
    if (!result.ok) return { kind: "failed", reason: result.reason.split(e.homeDir).join("~"), path: file };
    return { kind: "added", record: { state: "added", reach: "mcp", path: file, command, at, ...(result.undo ? { undo: result.undo } : {}), ...(created ? { created: true } : {}) } };
  }
  const bin = e.which(way.bin);
  if (!bin) return { kind: "manual", why: `${way.bin} is not on PATH` };
  const ran = await e.run([bin, ...way.add(command)], { timeoutMs });
  if (ran.timedOut) return { kind: "failed", reason: `${way.bin} mcp add did not finish within ${formatSeconds(timeoutMs)}`, path: file };
  if (ran.exitCode !== 0) {
    const why = firstLine(ran.stderr) || firstLine(ran.stdout);
    return { kind: "failed", reason: `${way.bin} mcp add exited with code ${ran.exitCode}${why ? ` (${why})` : ""}`, path: file };
  }
  const after = classify(spec.raw(e) ?? { kind: "absent" }, [command], false);
  if (after.kind !== "ours") {
    return { kind: "failed", reason: `${way.bin} mcp add ran, but ${displayPath(file, e)} does not have the entry`, path: file };
  }
  return { kind: "added", record: { state: "added", reach: "mcp", path: file, command, at } };
}

/**
 * Connect every agent found that has no record yet. Never throws: a failure
 * is reported per agent and tried again at the next run (said again only
 * when its reason changes).
 */
export async function connectInboxAgents(options: ConnectOptions): Promise<InboxConnectReport> {
  const now = options.now ?? (() => new Date());
  const at = now().toISOString();
  const e = options.environment;
  const empty: InboxConnectReport = { at, first: false, added: [], already: [], failed: [], foreign: [], manual: [], unfinished: [], claude_code: false };
  if (inboxConnectDisabled(e.env)) return { ...empty, skipped: "env" };
  if (!agentHomeAllowed(e)) return { ...empty, skipped: "sandbox" };
  const file = readInboxAgents(options.dataDir);
  const report: InboxConnectReport = { ...empty, first: !file.first_connected_at };
  report.claude_code = claudeCodePluginEnabled(e) && claudeCodeInboxToolOn(e);

  const pending = AGENT_SPECS.filter((spec) => spec.id !== "claude-code" && spec.detect(e));
  // An agent with a record is never added again by itself; an MCP entry it
  // had is checked (read only) so Settings can say it was removed outside.
  for (const spec of pending) {
    const record = file.agents[spec.id];
    if (!record || record.reach !== "mcp" || (record.state !== "added" && record.state !== "found") || record.removed_outside_at) continue;
    // Read where the entry was written, whatever the environment names now (read only).
    const raw = recordedRaw(spec, e, record);
    const read = raw === null ? null : classify(raw, ourCommands(options, record), true);
    if (read && read.kind !== "ours" && read.kind !== "unreadable") {
      record.removed_outside_at = at;
      continue;
    }
    if (recordedElsewhere(spec, e, record)) {
      // The environment names another file now (`QWEN_HOME` set in one shell, not in another: an accident of how
      // this Inbox was started). Neither file is touched: the entry stays where it was written, said once per pair of
      // places (kept when a run from the other shell matches; cleared when Settings acts), and only the person moves
      // it (Settings → Agents shows it off, "connected in …"; turning it on moves it).
      const path = displayPath(record.path, e);
      const now = displayPath(spec.file(e), e);
      const key = `${path} -> ${now}`;
      if (file.elsewhere_said?.[spec.id] !== key) (report.elsewhere ??= []).push({ agent: spec.id, path, now });
      (file.elsewhere_said ??= {})[spec.id] = key;
      continue;
    }
    // This run's environment names the recorded file: a line from a run elsewhere is not this Inbox's to show.
    if (file.last_report?.elsewhere?.some((moved) => moved.agent === spec.id)) {
      const elsewhere = file.last_report.elsewhere.filter((moved) => moved.agent !== spec.id);
      file.last_report = { ...file.last_report, elsewhere };
    }
  }
  // An agent connected through MCP before its plugin was installed (Pi before `pi install`), whose plugin's tool is
  // on now: the MCP entry Plannotator added goes, so the agent never carries both. Kept when it cannot be removed.
  for (const spec of pending) {
    const record = file.agents[spec.id];
    if (record?.reach !== "mcp" || record.state !== "added" || record.removed_outside_at) continue;
    const way = await spec.way(e);
    if (way.kind !== "tool" || !resolveInboxTool(loadConfig(), e.env as NodeJS.ProcessEnv, way.host)) continue;
    if ((await removeOurMcpEntry(spec.id, options, record)) === null) file.agents[spec.id] = { state: "found", reach: "tool", path: null, at };
  }
  const toConnect = pending.filter((spec) => !file.agents[spec.id]);
  const deadline = options.totalTimeoutMs ?? INBOX_CONNECT_TOTAL_TIMEOUT_MS;
  const results = new Map<InboxAgentId, AgentOutcome>();
  // Every agent CLI this step runs ends with the step: past its time limit, or
  // when the caller goes away, the ones still running are killed, never left
  // behind (a hung CLI in its own process group would otherwise outlive us).
  const runs = new AbortController();
  const scoped: AgentEnvironment = { ...e, run: (argv, runOptions) => e.run(argv, { ...runOptions, signal: runs.signal }) };
  const stepOptions: ConnectOptions = { ...options, environment: scoped };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  await Promise.race([
    Promise.all(
      toConnect.map(async (spec) => {
        let outcome: AgentOutcome;
        try {
          outcome = await connectOne(spec, stepOptions, at);
        } catch (error) {
          outcome = { kind: "failed", reason: error instanceof Error ? error.message : String(error), path: spec.file(e) };
        }
        if (!runs.signal.aborted) results.set(spec.id, outcome);
      }),
    ),
    new Promise<void>((done) => {
      timer = setTimeout(done, deadline);
      onAbort = () => done();
      if (options.signal?.aborted) done();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  // What finished in time; the rest is unfinished, and its CLIs are stopped now.
  const settled = new Map(results);
  runs.abort();
  if (options.signal?.aborted) return { ...report, unfinished: toConnect.filter((spec) => !settled.has(spec.id)).map((spec) => spec.id) };

  const failures = { ...(file.failures ?? {}) };
  const manualSaid = { ...(file.manual_said ?? {}) };
  for (const spec of toConnect) {
    const outcome = settled.get(spec.id);
    if (!outcome) {
      report.unfinished.push(spec.id);
      continue;
    }
    if (outcome.kind !== "failed") delete failures[spec.id];
    if (outcome.kind !== "manual") delete manualSaid[spec.id];
    switch (outcome.kind) {
      case "added":
        report.added.push(spec.id);
        file.agents[spec.id] = outcome.record;
        break;
      case "already":
        report.already.push(spec.id);
        if (outcome.record) file.agents[spec.id] = outcome.record;
        break;
      case "foreign":
        report.foreign.push({ agent: spec.id, path: displayPath(outcome.path, e) });
        file.agents[spec.id] = outcome.record;
        break;
      case "off":
        file.agents[spec.id] = outcome.record;
        break;
      case "failed":
        // A lasting failure is said once; tried again every run.
        if (failures[spec.id] !== outcome.reason) report.failed.push({ agent: spec.id, reason: outcome.reason, path: displayPath(outcome.path, e) });
        failures[spec.id] = outcome.reason;
        break;
      case "manual":
        report.manual.push(spec.id);
        // Why only a person can connect it (Pi before 0.99, no CLI on PATH): said once.
        if (manualSaid[spec.id] !== outcome.why) (report.manual_why ??= []).push({ agent: spec.id, why: outcome.why });
        manualSaid[spec.id] = outcome.why;
        break;
      case "none":
        break;
    }
  }
  file.failures = failures;
  file.manual_said = manualSaid;
  for (const spec of pending) {
    if (toConnect.includes(spec)) continue;
    const record = file.agents[spec.id];
    if (record && (record.state === "added" || record.state === "found") && !record.removed_outside_at) report.already.push(spec.id);
  }
  // Qwen Code connected: Plannotator registers itself as its trusted sender, so the person's replies go into its
  // running sessions (inbox-qwen-trust.ts; the owner's answer, 2026-10-27). A token already held is kept.
  const qwen = file.agents.qwen;
  const qwenConnected = qwen?.reach === "mcp" && (qwen.state === "added" || qwen.state === "found") && !qwen.removed_outside_at;
  // Connected in another Qwen home than this run's (`QWEN_HOME` differs): the grant stays with the entry, in the
  // home it was minted in; it moves only with the entry, when the person turns Qwen Code on in Settings.
  const qwenElsewhere = qwenConnected && recordedElsewhere(agentSpec("qwen"), e, qwen);
  if (INBOX_QWEN_TRUST_ON_CONNECT && qwenConnected && !qwenElsewhere) {
    const trust = await ensureQwenTrust(options.dataDir, e, { ...(options.signal ? { signal: options.signal } : {}), now }).catch(
      (error: unknown): QwenTrustOutcome => ({ kind: "failed", reason: error instanceof Error ? error.message : String(error) }),
    );
    if (options.signal?.aborted) return report;
    if (trust.kind === "added") (report.trusted ??= []).push("qwen");
    if (trust.kind === "failed" && !trust.repeated) (report.trust_failed ??= []).push({ agent: "qwen", reason: trust.reason });
    // Revoked in Qwen (seen now, or by the wake when Qwen stopped confirming): said once.
    if (trust.kind === "revoked_outside" && trust.first) (report.trust_failed ??= []).push({ agent: "qwen", reason: QWEN_TRUST_REVOKED_REASON });
  } else if (!qwenConnected) {
    // Not connected (turned off): a grant the switch could not revoke is tried again; its token is no longer used.
    const retry = await retryQwenRevoke(options.dataDir, e, options.signal).catch(() => null);
    if (options.signal?.aborted) return report;
    if (retry?.kind === "failed" && !retry.repeated) (report.trust_failed ??= []).push({ agent: "qwen", reason: retry.reason });
  }
  if (report.added.length > 0 && !file.first_connected_at) file.first_connected_at = at;
  const news =
    report.added.length > 0 ||
    report.failed.length > 0 ||
    report.foreign.length > 0 ||
    (report.elsewhere?.length ?? 0) > 0 ||
    (report.trusted?.length ?? 0) > 0 ||
    (report.trust_failed?.length ?? 0) > 0;
  file.last_report = news ? { ...report, seen: false } : file.last_report;
  try {
    writeInboxAgents(options.dataDir, file);
  } catch {
    // The records could not be kept: this run's adds are found again next time ("found").
  }
  return report;
}

/**
 * The terminal's lines for a run (stderr; stdout is unchanged). Nothing when
 * nothing changed.
 */
export function formatConnectReport(report: InboxConnectReport): string[] {
  if (report.skipped) return [];
  const lines: string[] = [];
  if (report.added.length > 0) {
    if (report.first) {
      const claude = report.claude_code ? " (Claude Code was already on)" : "";
      lines.push(`Connected ${inboxAgentList(report.added)} to the Inbox${claude}.`);
    } else {
      lines.push(`Connected ${inboxAgentList(report.added)} to the Inbox (new on this computer).`);
    }
    if (report.added.includes("claude-app")) lines.push("Restart the Claude app to use it there.");
  }
  if (report.trusted?.length) {
    lines.push(
      `Plannotator can now send your replies straight into any running ${inboxAgentList(report.trusted)} session, without it asking you first (Plannotator is its trusted sender). Turning it off in Settings → Agents, or plannotator uninstall, removes that.`,
    );
  }
  for (const failure of report.trust_failed ?? []) {
    lines.push(`${INBOX_AGENT_LABELS[failure.agent]} won't get your replies by itself: ${failure.reason}. Plannotator tries again at the next plannotator inbox.`);
  }
  for (const failure of report.failed) {
    lines.push(`Couldn't connect ${INBOX_AGENT_LABELS[failure.agent]}: ${failure.reason}. Plannotator tries again at the next plannotator inbox.`);
  }
  for (const manual of report.manual_why ?? []) {
    lines.push(`${INBOX_AGENT_LABELS[manual.agent]} needs connecting by hand: ${manual.why}.`);
  }
  for (const foreign of report.foreign) {
    lines.push(`${INBOX_AGENT_LABELS[foreign.agent]} has its own ${INBOX_MCP_SERVER_NAME} entry${foreign.path ? ` in ${foreign.path}` : ""}; left alone.`);
  }
  for (const moved of report.elsewhere ?? []) lines.push(inboxElsewhereText(moved));
  if (report.added.length > 0 && report.first) {
    lines.push(`Agents use it from their next session. ${INBOX_CONNECT_ENV}=0 skips this step; plannotator uninstall removes what it added.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Removal (plannotator uninstall)

export interface RemovalPlanItem {
  agent: InboxAgentId;
  /** What the dry run and the result say. */
  describe: string;
  /** Perform it; returns an error reason, or null. */
  apply: () => Promise<string | null>;
  /** An entry a move left in another file (the record's `strays`): its path. Not the agent's own entry. */
  stray?: string;
}

export interface RemovalPlan {
  items: RemovalPlanItem[];
  /** Entries left with a reason: one Plannotator added that runs something else now, or one no record says it added. */
  skipped: string[];
}

/**
 * What uninstall removes: only entries Plannotator ADDED (recorded in
 * agents.json) and that still run the command it wrote. An entry it merely
 * found (the person added it) is left. An entry with no record at all
 * (agents.json lost, or never written) is left too, even when it runs exactly
 * `ourCommand` (this binary's `inbox mcp`), because the person may have
 * added that by hand; it is named in `skipped` with how to remove it. Pi's
 * and OpenCode's `inboxTool` live in config.json, which a plain uninstall
 * keeps and --purge removes.
 */
export function planInboxAgentRemoval(dataDir: string, e: AgentEnvironment, ourCommand: readonly string[]): RemovalPlan {
  const file = readInboxAgents(dataDir);
  const items: RemovalPlanItem[] = [];
  /** After every agent's own entry, so a caller looking for an agent's item finds that one first. */
  const strays: RemovalPlanItem[] = [];
  const skipped: string[] = [];
  if (!agentHomeAllowed(e)) return { items, skipped };
  for (const spec of AGENT_SPECS) {
    const record = file.agents[spec.id];
    const label = INBOX_AGENT_LABELS[spec.id];
    // Entries a move left in another file (its new one could not be taken back out): removed too, that entry only,
    // whatever the record says of the agent's own entry now (turned off since, say).
    const strayJson = jsonFileFor(spec.id);
    for (const stray of strayJson ? (record?.strays ?? []) : []) {
      // Checked as the agent's own entry is: one gone is nothing to do, one the person replaced is theirs (named
      // once, then no longer recorded); one that can't be read is tried, so the reason is said.
      const strayOurs = stray.command ? [stray.command] : record?.command ? [record.command] : [];
      const strayRead = classify(rawJsonEntry(stray.path, strayJson!.keys, strayJson!.rules.comments === true), strayOurs, false);
      if (strayRead.kind === "absent") continue;
      if (strayRead.kind === "other") {
        skipped.push(`${label}'s "${NAME}" in ${displayPath(stray.path, e)} now runs something else (changed by hand), so it is yours`);
        continue;
      }
      strays.push({
        agent: spec.id,
        stray: stray.path,
        describe: `MCP server ${NAME} from ${label} (${displayPath(stray.path, e)}, that entry only)`,
        apply: async () => {
          const result = writeJsonEntry(stray.path, strayJson!.keys, undefined, strayOurs, stray.undo, strayJson!.rules);
          if (result.ok && stray.created) deleteIfOnlyOurs(stray.path, strayJson!.keys);
          return result.ok ? null : result.reason;
        },
      });
    }
    if (record && (record.reach !== "mcp" || record.state !== "added")) continue;
    // A recorded entry is removed where it was written, whatever the environment names now.
    const raw = record ? recordedRaw(spec, e, record) : spec.raw(e);
    if (!record) {
      // No record says Plannotator added it: never removed, only named when it runs this binary.
      const unrecorded = raw === null ? null : classify(raw, [[...ourCommand]], false);
      if (unrecorded?.kind === "ours") {
        const at = displayPath(spec.file(e), e);
        const how = jsonFileFor(spec.id) ? "delete that entry by hand" : spec.remove ? `run \`${spec.remove.bin} ${spec.remove.args.join(" ")}\`` : "remove it in the agent's settings";
        skipped.push(`${label}'s "${NAME}"${at ? ` in ${at}` : ""} runs this Plannotator, but no record says Plannotator added it, so it may be yours (to remove it, ${how})`);
      }
      continue;
    }
    const ours = record.command ? [record.command] : [];
    const read = raw === null ? null : classify(raw, ours, false);
    if (read?.kind === "other") {
      skipped.push(`${label}'s "${NAME}" now runs something else (changed by hand), so it is yours`);
      continue;
    }
    if (read && read.kind !== "ours") continue;
    const path = recordedFile(spec, e, record) ?? record.path ?? null;
    const shown = displayPath(path, e);
    const json = jsonFileFor(spec.id);
    if (json && path) {
      items.push({
        agent: spec.id,
        describe: `MCP server ${NAME} from ${label} (${shown}, that entry only)`,
        apply: async () => {
          const result = writeJsonEntry(path, json.keys, undefined, ours, record.undo, json.rules);
          if (result.ok && record.created) deleteIfOnlyOurs(path, json.keys);
          return result.ok ? null : result.reason;
        },
      });
      continue;
    }
    const remove = spec.remove;
    if (!remove) continue;
    const bin = e.which(remove.bin);
    if (!bin) {
      skipped.push(`${label}'s "${NAME}"${shown ? ` in ${shown}` : ""}: ${remove.bin} is not on PATH; run \`${remove.bin} ${remove.args.join(" ")}\``);
      continue;
    }
    items.push({
      agent: spec.id,
      describe: `MCP server ${NAME} from ${label} (${remove.bin} ${remove.args.join(" ")})`,
      apply: async () => {
        const ran = await e.run([bin, ...remove.args], { timeoutMs: INBOX_CONNECT_AGENT_TIMEOUT_MS });
        if (ran.timedOut) return `${remove.bin} mcp remove did not finish`;
        if (ran.exitCode !== 0) return `${remove.bin} mcp remove exited with code ${ran.exitCode}`;
        return null;
      },
    });
  }
  return { items: [...items, ...strays], skipped };
}

/** The agents whose JSON file Plannotator edits itself: where their entry is and how the file is edited. */
function jsonFileFor(id: InboxAgentId): { keys: readonly string[]; rules: JsonFileRules } | null {
  if (id === "qwen") return { keys: ["mcpServers"], rules: QWEN_SETTINGS_RULES };
  return id === "cursor" || id === "kiro" || id === "claude-app" ? { keys: ["mcpServers"], rules: {} } : null;
}

/**
 * The file an agent's recorded entry is in. For an agent whose JSON file
 * Plannotator edits itself, the file the record names: the place it may move
 * with the environment (`QWEN_HOME` set in one shell and not in another), and
 * the entry is where it was written. Otherwise the file the environment names.
 */
function recordedFile(spec: AgentSpec, e: AgentEnvironment, record: InboxAgentRecord | undefined): string | null {
  const recorded = record?.reach === "mcp" && (record.state === "added" || record.state === "found") ? record.path : null;
  return jsonFileFor(spec.id) && recorded ? recorded : spec.file(e);
}

/** The recorded entry's raw value (`recordedFile`), read only. */
function recordedRaw(spec: AgentSpec, e: AgentEnvironment, record: InboxAgentRecord | undefined): RawEntry | null {
  const path = recordedFile(spec, e, record);
  const json = jsonFileFor(spec.id);
  if (!json || !path || path === spec.file(e)) return spec.raw(e);
  return rawJsonEntry(path, json.keys, json.rules.comments === true);
}

/** Whether the environment now names another file than the one the agent's recorded entry is in. */
function recordedElsewhere(spec: AgentSpec, e: AgentEnvironment, record: InboxAgentRecord | undefined): boolean {
  const recorded = recordedFile(spec, e, record);
  const now = spec.file(e);
  return recorded !== null && now !== null && !samePlace(recorded, now);
}

// ---------------------------------------------------------------------------
// Settings → Agents: one agent's reach, and the person's switch

export interface InboxAgentReachState {
  /** tool: Plannotator's plugin/extension (`inboxTool`); mcp: a plannotator-inbox entry; manual: only a person can add it; none: nothing to switch. */
  kind: "tool" | "mcp" | "manual" | "none";
  on: boolean;
  state: "connected" | "off" | "removed" | "foreign" | "not_connected" | "manual" | "unreadable" | "elsewhere";
  /** Where the entry is (`~` for home). */
  path: string | null;
  /** PLANNOTATOR_INBOX_TOOL decides the tool switch. */
  locked: boolean;
  /** Why it is unreadable or left to the person. */
  reason: string | null;
}

/**
 * Claude Code's user-scope MCP entry (`claude mcp add --scope user`), in
 * `.claude.json`: `$CLAUDE_CONFIG_DIR/.claude.json` when that is set, else
 * `~/.claude.json`. Read only, never written: Claude Code is connected through
 * its plugin, and this only says that one added by hand already reaches the Inbox.
 */
function claudeCodeMcpEntry(e: AgentEnvironment, ours: readonly (readonly string[])[]): InboxEntryRead {
  const dir = envDir(e, "CLAUDE_CONFIG_DIR");
  // .claude.json holds Claude Code's per-project history and often passes 1 MiB; this read only looks.
  return classify(rawJsonEntry(join(dir ?? e.homeDir, ".claude.json"), ["mcpServers"], false, CLAUDE_JSON_MAX_BYTES), ours, true);
}

/** The most `.claude.json` the read-only MCP lookup reads. */
const CLAUDE_JSON_MAX_BYTES = 32 * 1024 * 1024;

/** Claude Code reaches the Inbox through Plannotator's plugin (its mod registers the tool); without the plugin only a person can connect it. */
function claudeCodeWay(e: AgentEnvironment): ConnectWay {
  return claudeCodePluginEnabled(e) ? { kind: "tool", host: "claude-code" } : { kind: "manual", why: "install Plannotator's Claude Code plugin" };
}

/** Whether Plannotator's own connection is installed for one of its three hosts (null for every other agent). */
export function inboxPluginInstalled(id: InboxAgentId, e: AgentEnvironment): boolean | null {
  if (id === "claude-code") return claudeCodePluginEnabled(e);
  if (id === "pi") return piExtensionInstalled(e);
  if (id === "opencode") return openCodePluginInstalled(e);
  return null;
}

/**
 * What `GET /api/inbox/agents` says about Plannotator's own connection on one
 * of its three hosts (null for every other agent): installed; `disabled`, the
 * Claude Code plugin is installed and turned off by name (the person's
 * choice); `generation`, the OpenCode on PATH (`opencode2` is OpenCode 2,
 * which also ships as `opencode`; `opencode` alone is OpenCode 1), so the
 * first-run screen shows the plugin line that version reads.
 */
export function inboxPluginStatus(id: InboxAgentId, e: AgentEnvironment): { installed: boolean; disabled?: boolean; managed?: boolean; generation?: "1" | "2" } | null {
  const installed = inboxPluginInstalled(id, e);
  if (installed === null) return null;
  if (id === "claude-code" && !installed) {
    const status = claudeCodePluginStatus(e);
    if (status.state === "disabled") return status.managed ? { installed, disabled: true, managed: true } : { installed, disabled: true };
  }
  if (id === "opencode") {
    const generation = openCodeGeneration(e);
    return generation ? { installed, generation } : { installed };
  }
  return { installed };
}

/** How one agent reaches the Inbox now (read only; may ask a CLI its version). */
export async function inboxAgentReach(id: InboxAgentId, options: ConnectOptions): Promise<InboxAgentReachState> {
  const e = options.environment;
  const spec = agentSpec(id);
  const way: ConnectWay = id === "claude-code" ? claudeCodeWay(e) : await spec.way(e);
  const record = readInboxAgents(options.dataDir).agents[id];
  // Where its recorded entry is (`QWEN_HOME` may name another file now): that is what Settings shows and switches.
  const path = displayPath(recordedFile(spec, e, record), e);
  // Claude Code connected by hand through MCP, where the plugin gives it no tool (not installed, disabled, or its mod off):
  // it reaches the Inbox (without the wake). Checked before the agent is called off.
  if (id === "claude-code" && (way.kind === "manual" || !claudeCodeModOn(e)) && claudeCodeMcpEntry(e, ourCommands(options, record)).kind === "ours") {
    return { kind: "mcp", on: true, state: "connected", path: displayPath(join(envDir(e, "CLAUDE_CONFIG_DIR") ?? e.homeDir, ".claude.json"), e), locked: false, reason: null };
  }
  // Connected in another file than the environment names (`QWEN_HOME` differs): off here, the switch moves it.
  if (record && recordedElsewhere(spec, e, record)) {
    const raw = recordedRaw(spec, e, record);
    if (raw && classify(raw, ourCommands(options, record), true).kind === "ours") return { kind: "mcp", on: false, state: "elsewhere", path, locked: false, reason: null };
  }
  if (way.kind === "tool") {
    const locked = parseInboxToolEnv(e.env as NodeJS.ProcessEnv) !== undefined;
    // Claude Code's tool comes from the plugin's mod: with the mod off it has none, whatever inboxTool says.
    const modOff = way.host === "claude-code" && !claudeCodeModOn(e);
    const on = !modOff && resolveInboxTool(loadConfig(), e.env as NodeJS.ProcessEnv, way.host);
    return { kind: "tool", on, state: on ? "connected" : "off", path: null, locked, reason: modOff ? CLAUDE_CODE_MOD_OFF_REASON : null };
  }
  if (way.kind === "manual") return { kind: "manual", on: false, state: "manual", path, locked: false, reason: way.why };
  if (way.kind === "none") return { kind: "none", on: false, state: "manual", path, locked: false, reason: null };
  const raw = recordedRaw(spec, e, record);
  const read = raw === null ? null : classify(raw, ourCommands(options, record), true);
  if (read?.kind === "ours") return { kind: "mcp", on: true, state: "connected", path, locked: false, reason: null };
  if (read?.kind === "other") return { kind: "mcp", on: false, state: "foreign", path, locked: false, reason: null };
  if (read?.kind === "unreadable") return { kind: "mcp", on: false, state: "unreadable", path, locked: false, reason: read.reason };
  if (read === null && record && (record.state === "added" || record.state === "found")) {
    return { kind: "mcp", on: true, state: "connected", path, locked: false, reason: null };
  }
  if (record?.state === "off") return { kind: "mcp", on: false, state: "off", path, locked: false, reason: null };
  if (record && (record.state === "added" || record.state === "found")) return { kind: "mcp", on: false, state: "removed", path, locked: false, reason: null };
  return { kind: "mcp", on: false, state: "not_connected", path, locked: false, reason: null };
}

/** Turn a host's `plannotator_inbox` tool on or off in config.json (the old Settings switch). Returns an error reason, or null. */
export function setInboxTool(host: InboxToolHost, on: boolean, e: AgentEnvironment): string | null {
  if (parseInboxToolEnv(e.env as NodeJS.ProcessEnv) !== undefined) return "PLANNOTATOR_INBOX_TOOL decides this";
  const current = loadConfig().inboxTool;
  const next: Partial<Record<InboxToolHost, boolean>> = {};
  for (const name of ["claude-code", "pi", "opencode"] as const) {
    const value = typeof current === "boolean" ? current : current?.[name];
    if (typeof value === "boolean") next[name] = value;
  }
  next[host] = on;
  saveConfig({ inboxTool: next });
  return configuredInboxTool(loadConfig(), host) === on ? null : "Plannotator's config.json can't be written";
}

/**
 * The person's switch in Settings: on adds the entry (or turns the tool on)
 * whatever the record says; off removes Plannotator's entry (never one that
 * runs something else) and records `off`, so no later run adds it back. On
 * success the agent's failure leaves the last report, so the note dialog's
 * band stops naming it. Returns an error reason, or null.
 */
/** Why Claude Code has no Inbox tool with its plugin installed. */
export const CLAUDE_CODE_MOD_OFF_REASON = "Plannotator's Claude Code mod is off (PLANNOTATOR_CLAUDE_MOD or claudeCodeMod), so Claude Code has no Inbox tool";

/**
 * Remove the MCP entry Plannotator recorded adding for an agent whose own
 * plugin now gives it the Inbox tool (Pi after `pi install`), so it never
 * carries both. Only an entry the record says Plannotator added and that still
 * runs its command. Returns an error reason, or null (removed, or nothing to remove).
 */
async function removeOurMcpEntry(id: InboxAgentId, options: ConnectOptions, record: InboxAgentRecord | undefined): Promise<string | null> {
  if (record?.reach !== "mcp" || record.state !== "added") return null;
  const item = planInboxAgentRemoval(options.dataDir, options.environment, ourCommands(options, record)[0]!).items.find((candidate) => candidate.agent === id && !candidate.stray);
  return item ? item.apply() : null;
}

/**
 * Once the entry is added where the environment names now (the person turned
 * the agent on in Settings): take the one Plannotator added out of the file
 * its record names (that entry only). A found entry is the person's and stays;
 * one gone or changed by hand is left too. Returns an error reason (the old
 * file cannot be read or written: the caller takes the new entry back out), or null.
 */
async function moveRecordedEntry(spec: AgentSpec, options: ConnectOptions, record: InboxAgentRecord): Promise<string | null> {
  if (record.reach !== "mcp" || record.state !== "added") return null;
  const raw = recordedRaw(spec, options.environment, record);
  if (raw?.kind === "unreadable") return `${displayPath(record.path, options.environment)} can't be read (${raw.reason})`;
  return removeOurMcpEntry(spec.id, options, record);
}

/**
 * The record once Settings turned an agent on: entries a move left elsewhere
 * (`strays`) stay recorded, so uninstall still removes them. A stray where it
 * connects now is the entry it found there: Plannotator's, recorded as added.
 */
function keepStrays(previous: InboxAgentRecord | undefined, next: InboxAgentRecord): InboxAgentRecord {
  const strays = previous?.strays ?? [];
  const here = next.reach === "mcp" && next.state === "found" && next.path ? strays.find((stray) => samePlace(stray.path, next.path!)) : undefined;
  const record: InboxAgentRecord = here
    ? { ...next, state: "added", ...(here.command ? { command: here.command } : {}), ...(here.undo ? { undo: here.undo } : {}), ...(here.created ? { created: true } : {}) }
    : next;
  const rest = strays.filter((stray) => stray !== here);
  return rest.length > 0 ? { ...record, strays: rest } : record;
}

let beforeMoveRollback: (() => void) | null = null;
/** Tests only: runs just before a move takes its new entry back out, so a test can make that fail. */
export function setMoveRollbackHookForTests(hook: (() => void) | null): void {
  beforeMoveRollback = hook;
}

export async function setInboxAgentReach(id: InboxAgentId, on: boolean, options: ConnectOptions): Promise<string | null> {
  /** Said once the switch is done: the switch held, and something beside it did not (Qwen Code's trusted sender). */
  let notice: string | null = null;
  const e = options.environment;
  if (!agentHomeAllowed(e)) return "not in a test's scratch home";
  const at = (options.now ?? (() => new Date()))().toISOString();
  const spec = agentSpec(id);
  const way: ConnectWay = id === "claude-code" ? claudeCodeWay(e) : await spec.way(e, true);
  const file = readInboxAgents(options.dataDir);
  let strayProblem: string | null = null;
  // The person acted: the "connected elsewhere" line is said again only for a new pair of places.
  if (file.elsewhere_said?.[id]) delete file.elsewhere_said[id];
  const there = file.agents[id] && recordedElsewhere(spec, e, file.agents[id]) ? displayPath(file.agents[id]!.path, e) : null;
  if (way.kind === "manual") return `${INBOX_AGENT_LABELS[id]} is connected by hand: ${way.why}${there ? `, so it stays connected in ${there}` : ""}`;
  if (way.kind === "none") return `${INBOX_AGENT_LABELS[id]} is connected by hand`;
  if (way.kind === "tool") {
    // Claude Code's tool comes from the plugin's mod: with the mod off a switch here would change nothing.
    if (way.host === "claude-code" && !claudeCodeModOn(e)) return CLAUDE_CODE_MOD_OFF_REASON;
    // The plugin's tool replaces the MCP entry Plannotator added before the plugin was there (`pi mcp add`):
    // removed first, so the agent never carries both; if it cannot be removed, the tool stays off and MCP keeps working.
    if (on) {
      const removed = await removeOurMcpEntry(id, options, file.agents[id]);
      if (removed) return `Plannotator's earlier MCP entry for ${INBOX_AGENT_LABELS[id]} could not be removed, so its Inbox tool stays off: ${removed}`;
    }
    const problem = setInboxTool(way.host, on, e);
    if (problem) return problem;
    file.agents[id] = { state: on ? "added" : "off", reach: "tool", path: null, at };
  } else if (on) {
    const previous = file.agents[id];
    // Its entry is in another file than the environment names now (`QWEN_HOME` changed): the person moves it here.
    // The old entry stays until the new file has one, so a problem in the new home never leaves the agent with none.
    const moving = previous !== undefined && recordedElsewhere(spec, e, previous);
    const old = moving ? displayPath(previous!.path, e) : null;
    const stays = moving ? `, so ${INBOX_AGENT_LABELS[id]} stays connected in ${old}` : "";
    const outcome = await connectOne(spec, options, at);
    if (outcome.kind === "failed") return `${outcome.reason}${stays}`;
    if (outcome.kind === "foreign") return `${displayPath(outcome.path, e) ?? INBOX_AGENT_LABELS[id]} has its own ${NAME} entry${stays}`;
    if (outcome.kind === "manual") return `${INBOX_AGENT_LABELS[id]} is connected by hand: ${outcome.why}${stays}`;
    if (moving) {
      const moved = await moveRecordedEntry(spec, options, previous!);
      if (moved) {
        // The old one cannot go: the new one is taken back out, so only the recorded entry is ever left.
        const json = jsonFileFor(id);
        const added = outcome.kind === "added" ? outcome.record : null;
        if (json && added?.path) {
          beforeMoveRollback?.();
          const undone = writeJsonEntry(added.path, json.keys, undefined, added.command ? [added.command] : [], added.undo, json.rules);
          if (undone.ok && added.created) deleteIfOnlyOurs(added.path, json.keys);
          if (!undone.ok) {
            // Both stay: the new one is recorded too, so uninstall removes it.
            file.agents[id] = { ...previous!, strays: [...(previous!.strays ?? []), { path: added.path, ...(added.command ? { command: added.command } : {}), ...(added.undo ? { undo: added.undo } : {}), ...(added.created ? { created: true } : {}) }] };
            writeInboxAgents(options.dataDir, file);
            return `Plannotator's entry in ${old} could not be removed (${moved}), and the one it had just added in ${displayPath(added.path, e)} could not be taken back out (${undone.reason}). ${INBOX_AGENT_LABELS[id]} has both now; plannotator uninstall removes both`;
          }
        }
        return `Plannotator's entry in ${old} could not be removed (${moved})${stays}`;
      }
    }
    if ("record" in outcome && outcome.record) file.agents[id] = keepStrays(previous, outcome.record);
    else if (previous) delete file.agents[id];
    // Turned on by the person: also a trusted sender again, even after a revoke in Qwen (its grant moves with the
    // entry, to this Qwen home). A failure leaves it reached through MCP, and is said.
    if (id === "qwen" && INBOX_QWEN_TRUST_ON_CONNECT) {
      // The record first: the Inbox stopping during the qwen call never leaves the entry unrecorded.
      writeInboxAgents(options.dataDir, file);
      notice = await setQwenTrust(true, options.dataDir, e).catch((error: unknown) => `Qwen Code won't get your replies by itself: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const record = file.agents[id];
    const ours = ourCommands(options, record);
    const items = planInboxAgentRemoval(options.dataDir, e, ours[0]!).items.filter((candidate) => candidate.agent === id);
    const item = items.find((candidate) => !candidate.stray);
    // The entry goes first: one that cannot be removed keeps the agent on, its Qwen trusted sender too.
    if (item) {
      const problem = await item.apply();
      if (problem) return problem;
    }
    // Entries a move left elsewhere go too; one that cannot stays recorded, so uninstall tries it again.
    const left: NonNullable<InboxAgentRecord["strays"]> = [];
    for (const stray of items.filter((candidate) => candidate.stray)) {
      const problem = await stray.apply();
      if (!problem) continue;
      strayProblem ??= `Plannotator's entry in ${displayPath(stray.stray!, e)} could not be removed (${problem}); plannotator uninstall tries it again`;
      left.push(...(record?.strays ?? []).filter((kept) => kept.path === stray.stray));
    }
    file.agents[id] = { state: "off", reach: "mcp", path: spec.file(e), at, ...(left.length > 0 ? { strays: left } : {}) };
    // Then Qwen Code's trusted-sender token: off is kept either way (no later run mints one for an agent turned off).
    if (id === "qwen") {
      // Off is recorded first: the Inbox stopping during the qwen call never reads as removed outside (the revoke
      // itself is written ahead: inbox-qwen-trust.ts).
      writeInboxAgents(options.dataDir, file);
      notice = await setQwenTrust(false, options.dataDir, e).catch((error: unknown) => `Plannotator's trusted-sender token in Qwen Code could not be removed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (file.failures) delete file.failures[id];
  // The band stops naming it: neither a failure nor "connected in another folder" holds once the person acted.
  if (file.last_report) {
    file.last_report = {
      ...file.last_report,
      failed: file.last_report.failed.filter((failure) => failure.agent !== id),
      ...(file.last_report.trust_failed ? { trust_failed: file.last_report.trust_failed.filter((failure) => failure.agent !== id) } : {}),
      ...(file.last_report.elsewhere ? { elsewhere: file.last_report.elsewhere.filter((moved) => moved.agent !== id) } : {}),
    };
  }
  writeInboxAgents(options.dataDir, file);
  return strayProblem && notice ? `${strayProblem}. ${notice}` : (strayProblem ?? notice);
}

/** After a plain uninstall removed entries: forget their records, so a reinstall connects them again. */
export function forgetInboxAgents(dataDir: string, ids: readonly InboxAgentId[]): void {
  if (ids.length === 0 || !existsSync(inboxAgentsPath(dataDir))) return;
  const file = readInboxAgents(dataDir);
  for (const id of ids) delete file.agents[id];
  try {
    writeInboxAgents(dataDir, file);
  } catch {
    // Best effort.
  }
}
