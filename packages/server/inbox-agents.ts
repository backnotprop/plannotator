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

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn as spawnChild } from "node:child_process";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  INBOX_AGENT_IDS,
  INBOX_AGENT_LABELS,
  inboxAgentList,
  type InboxAgentId,
  type InboxConnectReport,
} from "@plannotator/core/inbox-types";
import {
  configuredInboxTool,
  loadConfig,
  parseInboxToolEnv,
  resolveInboxTool,
  saveConfig,
  type InboxToolHost,
} from "@plannotator/shared/config";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { addJsonMember, removeJsonMember } from "./json-edit";
import {
  describeFsError,
  readAgentFile,
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
  /** Run argv with no stdin, the environment's env, killed after `timeoutMs`. */
  run(argv: readonly string[], options: { timeoutMs: number }): Promise<AgentRunResult>;
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
    run: (argv, options) => runWithTimeout(argv, env, options.timeoutMs),
  };
}

/**
 * Run argv in its own process group (POSIX), no stdin. The answer comes when
 * the process exits, never when its output closes, so a grandchild that keeps
 * stdout open cannot hold it; on the time limit the whole group is killed.
 */
function runWithTimeout(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, timeoutMs: number): Promise<AgentRunResult> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawnChild>;
    try {
      child = spawnChild(argv[0]!, argv.slice(1), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...env } as NodeJS.ProcessEnv,
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
    const cap = (text: string) => (text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text);
    child.stdout?.on("data", (chunk: Buffer) => (stdout = cap(stdout + chunk.toString("utf8"))));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = cap(stderr + chunk.toString("utf8"))));
    const finish = (result: AgentRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      done(result);
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish({ exitCode: 124, timedOut: true, stdout: "", stderr: "" });
    }, timeoutMs);
    child.on("error", (error) => finish({ exitCode: 127, timedOut: false, stdout, stderr: error.message }));
    // A short grace after exit for the last of its own output, then answer whatever a grandchild holds.
    child.on("exit", (code, signal) => setTimeout(() => finish({ exitCode: code ?? (signal ? 128 : 1), timedOut: false, stdout, stderr }), 50));
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

function rawJsonEntry(path: string, keys: readonly string[], jsonc: boolean): RawEntry {
  const read = readAgentFile(path);
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
  /** One key in a plain-JSON file. */
  | { kind: "json"; keys: readonly string[] }
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

/** Whether Plannotator's Claude Code plugin is enabled (`enabledPlugins` in Claude Code's settings). */
export function claudeCodePluginEnabled(e: AgentEnvironment): boolean {
  const read = readAgentFile(join(claudeConfigDir(e), "settings.json"));
  if (read.kind !== "file") return false;
  try {
    const enabled = (JSON.parse(read.text) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins;
    return !!enabled && Object.entries(enabled).some(([id, on]) => on === true && /^plannotator@/.test(id));
  } catch {
    return false;
  }
}

/**
 * Each CLI's own `--version` line, so a program that only shares the name
 * (cln's `pi` printing digits, amp.rs) is never handed an `mcp add`, and a
 * build older than its `mcp add` is left to the person: Pi before 0.99 (no
 * `pi mcp`: it would read the words as a chat prompt and run a model turn),
 * Codex CLI before 0.35.0 (`codex mcp add` landed in rust-v0.35.0, Sep 2025)
 * and Gemini CLI before 0.1.19 (`gemini mcp add`, Aug 2025). Read with no
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
  const shape = VERSION_SHAPES[bin];
  if (shape && probe) {
    const ran = await e.run([path, "--version"], { timeoutMs: Math.min(timeoutMs, 5_000) });
    const line = ran.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
    const match = ran.exitCode === 0 && !ran.timedOut ? shape.line.exec(line) : null;
    if (!match) return { kind: "manual", why: shape.manual };
    if (shape.min) {
      const version = [Number(match[1]), Number(match[2]), Number(match[3])];
      const [a, b, c] = shape.min;
      const older = version[0]! < a || (version[0] === a && (version[1]! < b || (version[1] === b && version[2]! < c)));
      if (older) return { kind: "manual", why: shape.older ?? shape.manual };
    }
  }
  return { kind: "cli", bin, add, remove };
}

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    id: "claude-code",
    detect: (e) => claudeCodePluginEnabled(e),
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
function undoJsonEntry(text: string, undo: JsonEntryUndo | undefined, keys: readonly string[]): string | null {
  if (!undo || !undo.after || !undo.after.includes(JSON.stringify(NAME))) return null;
  const first = text.indexOf(undo.after);
  if (first < 0 || text.indexOf(undo.after, first + 1) >= 0) return null;
  const restored = text.slice(0, first) + undo.before + text.slice(first + undo.after.length);
  if (!restored.trim()) return restored;
  try {
    return at(JSON.parse(restored), [...keys, NAME]) === undefined ? restored : null;
  } catch {
    return null;
  }
}

/**
 * Add (`value`) or remove (`undefined`) `plannotator-inbox` at `keys` in a
 * plain-JSON file, losslessly (json-edit.ts: only that member's text
 * changes; anything else is refused, with the reason), atomically, written at
 * a symlink's target, a no-op when nothing changes. `ours`: the commands a
 * removal may take away; an entry running anything else is never replaced or
 * removed.
 */
export function writeJsonEntry(
  path: string,
  keys: readonly string[],
  value: { command: string; args: string[] } | undefined,
  ours: readonly (readonly string[])[] = value ? [[value.command, ...value.args]] : [],
  undo?: JsonEntryUndo,
): WriteOutcome {
  const read = readAgentFile(path);
  if (read.kind === "refused") return { ok: false, reason: `${path} can't be edited (${read.reason})` };
  if (read.kind === "missing" && value === undefined) return { ok: true, changed: false };
  const original = read.kind === "file" ? read.text : "";
  if (original.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch {
      return { ok: false, reason: `${path} is not plain JSON, so Plannotator left it as it was` };
    }
    const current = at(parsed, [...keys, NAME]);
    if (current !== undefined) {
      const owned = ownsEntry(entryArgv(current), ours, false);
      if (value !== undefined) return owned ? { ok: true, changed: false } : { ok: false, reason: `${path} has its own ${NAME} entry` };
      if (!owned) return { ok: false, reason: `${path} has a ${NAME} entry Plannotator did not write` };
    } else if (value === undefined) return { ok: true, changed: false };
  }
  const undone = value === undefined ? undoJsonEntry(original, undo, keys) : null;
  const edit = undone !== null ? { ok: true as const, changed: true, text: undone } : value === undefined ? removeJsonMember(original, keys, NAME) : addJsonMember(original, keys, NAME, value);
  if (!edit.ok) return { ok: false, reason: `${path} can't be edited without reshaping it (${edit.reason}), so Plannotator left it as it was` };
  if (!edit.changed) return { ok: true, changed: false };
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
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
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
    const result = writeJsonEntry(file!, way.keys, { command: cmd!, args });
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
 * Whether a recorded MCP entry is still there (read only). Null: the agent's
 * file is not known or not readable, so nothing can be said.
 */
export function entryStillThere(id: InboxAgentId, e: AgentEnvironment, ours: readonly (readonly string[])[]): boolean | null {
  const read = readAgentEntry(id, e, ours, true);
  if (!read || read.kind === "unreadable") return null;
  return read.kind === "ours";
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
  report.claude_code = claudeCodePluginEnabled(e) && resolveInboxTool(loadConfig(), e.env as NodeJS.ProcessEnv, "claude-code");

  const pending = AGENT_SPECS.filter((spec) => spec.id !== "claude-code" && spec.detect(e));
  // An agent with a record is never added again by itself; an MCP entry it
  // had is checked (read only) so Settings can say it was removed outside.
  for (const spec of pending) {
    const record = file.agents[spec.id];
    if (!record || record.reach !== "mcp" || (record.state !== "added" && record.state !== "found") || record.removed_outside_at) continue;
    if (entryStillThere(spec.id, e, ourCommands(options, record)) === false) record.removed_outside_at = at;
  }
  const toConnect = pending.filter((spec) => !file.agents[spec.id]);
  const deadline = options.totalTimeoutMs ?? INBOX_CONNECT_TOTAL_TIMEOUT_MS;
  const settled = new Map<InboxAgentId, AgentOutcome>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(
      toConnect.map(async (spec) => {
        let outcome: AgentOutcome;
        try {
          outcome = await connectOne(spec, options, at);
        } catch (error) {
          outcome = { kind: "failed", reason: error instanceof Error ? error.message : String(error), path: spec.file(e) };
        }
        settled.set(spec.id, outcome);
      }),
    ),
    new Promise<void>((done) => {
      timer = setTimeout(done, deadline);
    }),
  ]);
  if (timer) clearTimeout(timer);

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
  if (report.added.length > 0 && !file.first_connected_at) file.first_connected_at = at;
  const news = report.added.length > 0 || report.failed.length > 0 || report.foreign.length > 0;
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
  for (const failure of report.failed) {
    lines.push(`Couldn't connect ${INBOX_AGENT_LABELS[failure.agent]}: ${failure.reason}. Plannotator tries again at the next plannotator inbox.`);
  }
  for (const manual of report.manual_why ?? []) {
    lines.push(`${INBOX_AGENT_LABELS[manual.agent]} needs connecting by hand: ${manual.why}.`);
  }
  for (const foreign of report.foreign) {
    lines.push(`${INBOX_AGENT_LABELS[foreign.agent]} has its own ${INBOX_MCP_SERVER_NAME} entry${foreign.path ? ` in ${foreign.path}` : ""}; left alone.`);
  }
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
  const skipped: string[] = [];
  if (!agentHomeAllowed(e)) return { items, skipped };
  for (const spec of AGENT_SPECS) {
    const record = file.agents[spec.id];
    if (record && (record.reach !== "mcp" || record.state !== "added")) continue;
    const raw = spec.raw(e);
    const label = INBOX_AGENT_LABELS[spec.id];
    if (!record) {
      // No record says Plannotator added it: never removed, only named when it runs this binary.
      const unrecorded = raw === null ? null : classify(raw, [[...ourCommand]], false);
      if (unrecorded?.kind === "ours") {
        const at = displayPath(spec.file(e), e);
        const how = jsonKeysFor(spec.id) ? "delete that entry by hand" : spec.remove ? `run \`${spec.remove.bin} ${spec.remove.args.join(" ")}\`` : "remove it in the agent's settings";
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
    const path = spec.file(e) ?? record.path ?? null;
    const shown = displayPath(path, e);
    const jsonKeys = jsonKeysFor(spec.id);
    if (jsonKeys && path) {
      items.push({
        agent: spec.id,
        describe: `MCP server ${NAME} from ${label} (${shown}, that entry only)`,
        apply: async () => {
          const result = writeJsonEntry(path, jsonKeys, undefined, ours, record.undo);
          if (result.ok && record.created) deleteIfOnlyOurs(path, jsonKeys);
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
  return { items, skipped };
}

function jsonKeysFor(id: InboxAgentId): readonly string[] | null {
  return id === "cursor" || id === "kiro" || id === "claude-app" ? ["mcpServers"] : null;
}

// ---------------------------------------------------------------------------
// Settings → Agents: one agent's reach, and the person's switch

export interface InboxAgentReachState {
  /** tool: Plannotator's plugin/extension (`inboxTool`); mcp: a plannotator-inbox entry; manual: only a person can add it; none: nothing to switch. */
  kind: "tool" | "mcp" | "manual" | "none";
  on: boolean;
  state: "connected" | "off" | "removed" | "foreign" | "not_connected" | "manual" | "unreadable";
  /** Where the entry is (`~` for home). */
  path: string | null;
  /** PLANNOTATOR_INBOX_TOOL decides the tool switch. */
  locked: boolean;
  /** Why it is unreadable or left to the person. */
  reason: string | null;
}

/** How one agent reaches the Inbox now (read only; may ask a CLI its version). */
export async function inboxAgentReach(id: InboxAgentId, options: ConnectOptions): Promise<InboxAgentReachState> {
  const e = options.environment;
  const spec = agentSpec(id);
  const way: ConnectWay = id === "claude-code" ? { kind: "tool", host: "claude-code" } : await spec.way(e);
  const path = displayPath(spec.file(e), e);
  const record = readInboxAgents(options.dataDir).agents[id];
  if (way.kind === "tool") {
    const locked = parseInboxToolEnv(e.env as NodeJS.ProcessEnv) !== undefined;
    const on = resolveInboxTool(loadConfig(), e.env as NodeJS.ProcessEnv, way.host);
    return { kind: "tool", on, state: on ? "connected" : "off", path: null, locked, reason: null };
  }
  if (way.kind === "manual") return { kind: "manual", on: false, state: "manual", path, locked: false, reason: way.why };
  if (way.kind === "none") return { kind: "none", on: false, state: "manual", path, locked: false, reason: null };
  const read = readAgentEntry(id, e, ourCommands(options, record), true);
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
export async function setInboxAgentReach(id: InboxAgentId, on: boolean, options: ConnectOptions): Promise<string | null> {
  const e = options.environment;
  if (!agentHomeAllowed(e)) return "not in a test's scratch home";
  const at = (options.now ?? (() => new Date()))().toISOString();
  const spec = agentSpec(id);
  const way: ConnectWay = id === "claude-code" ? { kind: "tool", host: "claude-code" } : await spec.way(e, true);
  const file = readInboxAgents(options.dataDir);
  if (way.kind === "manual") return `${INBOX_AGENT_LABELS[id]} is connected by hand: ${way.why}`;
  if (way.kind === "none") return `${INBOX_AGENT_LABELS[id]} is connected by hand`;
  if (way.kind === "tool") {
    const problem = setInboxTool(way.host, on, e);
    if (problem) return problem;
    file.agents[id] = { state: on ? "added" : "off", reach: "tool", path: null, at };
  } else if (on) {
    const previous = file.agents[id];
    const outcome = await connectOne(spec, options, at);
    if (outcome.kind === "failed") return outcome.reason;
    if (outcome.kind === "foreign") return `${displayPath(outcome.path, e) ?? INBOX_AGENT_LABELS[id]} has its own ${NAME} entry`;
    if (outcome.kind === "manual") return `${INBOX_AGENT_LABELS[id]} is connected by hand: ${outcome.why}`;
    if ("record" in outcome && outcome.record) file.agents[id] = outcome.record;
    else if (previous) delete file.agents[id];
  } else {
    const record = file.agents[id];
    const ours = ourCommands(options, record);
    const item = planInboxAgentRemoval(options.dataDir, e, ours[0]!).items.find((candidate) => candidate.agent === id);
    if (item) {
      const problem = await item.apply();
      if (problem) return problem;
    }
    file.agents[id] = { state: "off", reach: "mcp", path: spec.file(e), at };
  }
  if (file.failures) delete file.failures[id];
  if (file.last_report) file.last_report = { ...file.last_report, failed: file.last_report.failed.filter((failure) => failure.agent !== id) };
  writeInboxAgents(options.dataDir, file);
  return null;
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
