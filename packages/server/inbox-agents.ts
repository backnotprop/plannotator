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

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
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
import {
  describeFsError,
  jsonIndentOf,
  readAgentFile,
  stripJsonComments,
  withLineEndings,
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

async function runWithTimeout(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, timeoutMs: number): Promise<AgentRunResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...env } as Record<string, string> });
  } catch (error) {
    return { exitCode: 127, timedOut: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  const stdout = new Response(proc.stdout).text().catch(() => "");
  const stderr = new Response(proc.stderr).text().catch(() => "");
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<number>((done) => {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      done(124);
    }, timeoutMs);
  });
  const exitCode = await Promise.race([proc.exited, limit]);
  if (timer) clearTimeout(timer);
  return { exitCode, timedOut, stdout: timedOut ? "" : await stdout, stderr: timedOut ? "" : await stderr };
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

export function codexHome(e: AgentEnvironment): string {
  return envDir(e, "CODEX_HOME") ?? join(e.homeDir, ".codex");
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
export function geminiDir(e: AgentEnvironment): string {
  return join(e.homeDir, ".gemini");
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
  | { kind: "ours"; argv: string[] }
  | { kind: "other"; argv: string[] | null }
  /** The file could not be read or parsed; nothing is written to it. */
  | { kind: "unreadable"; reason: string };

/**
 * Whether argv runs this Inbox's stdio entry: ends in `inbox mcp`, run by a
 * `plannotator` binary (any path: an older install, a moved binary) or by a
 * source checkout of it. People rename servers, so callers also match on this.
 */
export function isPlannotatorInboxCommand(argv: readonly string[]): boolean {
  if (argv.length < 3) return false;
  if (argv[argv.length - 2] !== "inbox" || argv[argv.length - 1] !== "mcp") return false;
  return argv.slice(0, -2).some((word) => /^plannotator(?:\.exe)?$/i.test(basename(word)) || /plannotator/i.test(word));
}

/** A server entry's argv: `{ command, args }`, OpenCode's `command: [...]`, or an HTTP entry on this machine's `/mcp`. */
function entryArgv(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.command) && record.command.every((w) => typeof w === "string")) return record.command as string[];
  if (typeof record.command === "string") {
    const args = Array.isArray(record.args) ? record.args.filter((w): w is string => typeof w === "string") : [];
    return [record.command, ...args];
  }
  const url = typeof record.url === "string" ? record.url : typeof record.httpUrl === "string" ? record.httpUrl : null;
  if (url && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp\/?$/.test(url)) return [url];
  return null;
}

function classify(value: unknown): InboxEntryRead {
  const argv = entryArgv(value);
  if (argv && (isPlannotatorInboxCommand(argv) || (argv.length === 1 && argv[0]!.startsWith("http")))) return { kind: "ours", argv };
  return { kind: "other", argv };
}

/** The value at a key path (`["mcpServers", name]`; a key may hold dots, as Amp's `amp.mcpServers`). */
function at(root: unknown, keys: readonly string[]): unknown {
  let value = root;
  for (const key of keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Read `plannotator-inbox` at `keys` in a JSON (or, when `jsonc`, JSON with comments) file. */
function readJsonEntry(path: string, keys: readonly string[], jsonc: boolean): InboxEntryRead {
  const read = readAgentFile(path);
  if (read.kind === "missing") return { kind: "absent" };
  if (read.kind === "refused") return { kind: "unreadable", reason: `${read.reason}` };
  if (!read.text.trim()) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonc ? stripJsonComments(read.text) : read.text);
  } catch {
    return { kind: "unreadable", reason: "it is not plain JSON" };
  }
  const value = at(parsed, [...keys, INBOX_MCP_SERVER_NAME]);
  return value === undefined ? { kind: "absent" } : classify(value);
}

/** TOML strings in `text`: basic ("…", escapes) and literal ('…'). */
function tomlStrings(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g)) {
    if (match[2] !== undefined) out.push(match[2]);
    else {
      try {
        out.push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        out.push(match[1]!);
      }
    }
  }
  return out;
}

/** Codex's `[mcp_servers.plannotator-inbox]` table in config.toml: its command and args. Read only; `codex mcp` writes it. */
export function readCodexEntry(path: string): InboxEntryRead {
  const read = readAgentFile(path);
  if (read.kind === "missing") return { kind: "absent" };
  if (read.kind === "refused") return { kind: "unreadable", reason: read.reason };
  const lines = read.text.split(/\r?\n/);
  const header = /^\s*\[\s*mcp_servers\s*\.\s*(?:"plannotator-inbox"|'plannotator-inbox'|plannotator-inbox)\s*\]\s*(?:#.*)?$/;
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return { kind: "absent" };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n");
  const command = /^\s*command\s*=\s*(.+)$/m.exec(body);
  const commandWords = command ? tomlStrings(command[1]!) : [];
  const argsStart = body.search(/^\s*args\s*=\s*\[/m);
  let args: string[] = [];
  if (argsStart !== -1) {
    const open = body.indexOf("[", argsStart);
    const close = body.indexOf("]", open);
    if (close === -1) return { kind: "unreadable", reason: "its plannotator-inbox table could not be read" };
    args = tomlStrings(body.slice(open + 1, close));
  }
  if (commandWords.length === 0) {
    const url = /^\s*url\s*=\s*(.+)$/m.exec(body);
    const urlWords = url ? tomlStrings(url[1]!) : [];
    return urlWords.length ? classify({ url: urlWords[0] }) : { kind: "other", argv: null };
  }
  return classify({ command: commandWords[0], args });
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
  /** Only a person can connect it. */
  | { kind: "manual" }
  /** Nothing to do (Claude Code). */
  | { kind: "none" };

interface AgentSpec {
  id: InboxAgentId;
  /** Found on this computer. */
  detect(e: AgentEnvironment): boolean;
  /** How it is connected, once found. */
  way(e: AgentEnvironment): ConnectWay;
  /** Where its `plannotator-inbox` entry lives (null: unknown, or not a file). */
  file(e: AgentEnvironment): string | null;
  /** The entry, read only. Null: the agent's file is not known; the record decides. */
  read(e: AgentEnvironment): InboxEntryRead | null;
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

/** Whether Plannotator's OpenCode plugin is listed in the global opencode config (`plugin` / `plugins`). */
export function openCodePluginInstalled(e: AgentEnvironment): boolean {
  const dir = openCodeConfigDir(e);
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const read = readAgentFile(join(dir, name));
    if (read.kind !== "file") continue;
    try {
      const parsed = JSON.parse(stripJsonComments(read.text)) as { plugin?: unknown; plugins?: unknown };
      const lists = [parsed.plugin, parsed.plugins].filter(Array.isArray) as unknown[][];
      if (lists.some((list) => list.some((item) => {
        const spec = typeof item === "string" ? item : Array.isArray(item) && typeof item[0] === "string" ? item[0] : null;
        return spec !== null && /^@plannotator\/opencode(?:@|$)/.test(spec);
      }))) return true;
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

function cliWay(e: AgentEnvironment, bin: string, add: (command: readonly string[]) => string[], remove: string[]): ConnectWay {
  return e.which(bin) ? { kind: "cli", bin, add, remove } : { kind: "manual" };
}

export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    id: "claude-code",
    detect: (e) => claudeCodePluginEnabled(e),
    way: () => ({ kind: "none" }),
    file: () => null,
    read: () => null,
  },
  {
    id: "codex",
    detect: (e) => !!e.which("codex") || codexHomeHasUserConfig(e),
    way: (e) => cliWay(e, "codex", (cmd) => ["mcp", "add", NAME, "--", ...cmd], ["mcp", "remove", NAME]),
    file: (e) => join(codexHome(e), "config.toml"),
    read: (e) => readCodexEntry(join(codexHome(e), "config.toml")),
  },
  {
    id: "gemini",
    detect: (e) => !!e.which("gemini") || isDir(geminiDir(e)),
    way: (e) => cliWay(e, "gemini", (cmd) => ["mcp", "add", "-s", "user", NAME, ...cmd], ["mcp", "remove", "-s", "user", NAME]),
    file: (e) => join(geminiDir(e), "settings.json"),
    read: (e) => readJsonEntry(join(geminiDir(e), "settings.json"), ["mcpServers"], true),
  },
  {
    id: "cursor",
    detect: (e) => isDir(join(e.homeDir, ".cursor")) || !!e.which("cursor") || !!e.which("cursor-agent"),
    way: () => ({ kind: "json", keys: ["mcpServers"] }),
    file: (e) => join(e.homeDir, ".cursor", "mcp.json"),
    read: (e) => readJsonEntry(join(e.homeDir, ".cursor", "mcp.json"), ["mcpServers"], false),
  },
  {
    id: "windsurf",
    detect: (e) => !!e.which("devin"),
    way: (e) => cliWay(e, "devin", (cmd) => ["mcp", "add", "-s", "user", NAME, "--", ...cmd], ["mcp", "remove", "-s", "user", NAME]),
    file: (e) => join(xdgConfigHome(e), "devin", "config.json"),
    read: (e) => readJsonEntry(join(xdgConfigHome(e), "devin", "config.json"), ["mcpServers"], true),
  },
  {
    id: "amp",
    detect: (e) => !!e.which("amp"),
    way: (e) => cliWay(e, "amp", (cmd) => ["mcp", "add", NAME, "--", ...cmd], ["mcp", "remove", NAME]),
    file: (e) => join(xdgConfigHome(e), "amp", "settings.json"),
    read: (e) => readJsonEntry(join(xdgConfigHome(e), "amp", "settings.json"), ["amp.mcpServers"], true),
  },
  {
    id: "cline",
    detect: (e) => !!e.which("cline"),
    way: (e) => cliWay(e, "cline", (cmd) => ["mcp", "add", NAME, "--yes", "--", ...cmd], ["mcp", "remove", NAME]),
    // Cline CLI's config file is not verified: its record decides.
    file: () => null,
    read: () => null,
  },
  {
    id: "kiro",
    detect: (e) => !!e.which("kiro-cli") || isDir(join(e.homeDir, ".kiro")),
    way: () => ({ kind: "json", keys: ["mcpServers"] }),
    file: (e) => join(e.homeDir, ".kiro", "settings", "mcp.json"),
    read: (e) => readJsonEntry(join(e.homeDir, ".kiro", "settings", "mcp.json"), ["mcpServers"], false),
  },
  {
    id: "pi",
    detect: (e) => piExtensionInstalled(e) || !!e.which("pi"),
    way: (e) =>
      piExtensionInstalled(e)
        ? { kind: "tool", host: "pi" }
        : cliWay(e, "pi", (cmd) => ["mcp", "add", NAME, "--", ...cmd], ["mcp", "remove", NAME]),
    file: (e) => (piExtensionInstalled(e) ? null : join(piAgentDir(e), "mcp.json")),
    read: (e) => readJsonEntry(join(piAgentDir(e), "mcp.json"), ["mcpServers"], true),
  },
  {
    id: "opencode",
    detect: (e) => openCodePluginInstalled(e) || !!e.which("opencode"),
    // Without the plugin: opencode.json may be JSONC and project-scoped, so a person adds it.
    way: (e) => (openCodePluginInstalled(e) ? { kind: "tool", host: "opencode" } : { kind: "manual" }),
    file: () => null,
    read: () => null,
  },
  {
    id: "claude-app",
    detect: (e) => isDir(claudeAppDir(e)),
    way: () => ({ kind: "json", keys: ["mcpServers"] }),
    file: (e) => join(claudeAppDir(e), "claude_desktop_config.json"),
    read: (e) => readJsonEntry(join(claudeAppDir(e), "claude_desktop_config.json"), ["mcpServers"], false),
  },
];

export function agentSpec(id: InboxAgentId): AgentSpec {
  return AGENT_SPECS.find((spec) => spec.id === id)!;
}

// ---------------------------------------------------------------------------
// Writing one JSON key

type WriteOutcome = { ok: true; changed: boolean } | { ok: false; reason: string };

/**
 * Set (or with `value === undefined`, delete) `plannotator-inbox` at `keys`
 * in a plain-JSON file: a strict parse, the file's own indentation and line
 * endings, atomic, a no-op when nothing changes. Never replaces an entry that
 * is not ours.
 */
export function writeJsonEntry(path: string, keys: readonly string[], value: { command: string; args: string[] } | undefined): WriteOutcome {
  const read = readAgentFile(path);
  if (read.kind === "refused") return { ok: false, reason: `${path} ${read.reason === "permission denied" ? "can't be read (permission denied)" : `can't be edited: ${read.reason}`}` };
  if (read.kind === "missing" && value === undefined) return { ok: true, changed: false };
  const original = read.kind === "file" ? read.text : "";
  let root: Record<string, unknown> = {};
  if (original.trim()) {
    try {
      const parsed: unknown = JSON.parse(original);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: `${path} is not a JSON object, so Plannotator left it as it was` };
      root = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: `${path} is not plain JSON, so Plannotator left it as it was` };
    }
  }
  let parent: Record<string, unknown> = root;
  for (const key of keys) {
    const next = parent[key];
    if (next === undefined) {
      if (value === undefined) return { ok: true, changed: false };
      parent[key] = {};
    } else if (!next || typeof next !== "object" || Array.isArray(next)) {
      return { ok: false, reason: `${path} has a "${key}" that is not an object, so Plannotator left it as it was` };
    }
    parent = parent[key] as Record<string, unknown>;
  }
  const current = parent[NAME];
  if (current !== undefined && classify(current).kind !== "ours") {
    return { ok: false, reason: `${path} has its own ${NAME} entry` };
  }
  if (value === undefined) {
    if (current === undefined) return { ok: true, changed: false };
    delete parent[NAME];
  } else {
    if (current !== undefined) return { ok: true, changed: false };
    parent[NAME] = value;
  }
  const crlf = read.kind === "file" ? read.crlf : false;
  const trailing = original === "" || /\n$/.test(original) ? "\n" : "";
  const text = withLineEndings(`${JSON.stringify(root, null, jsonIndentOf(original))}${trailing}`, crlf);
  if (read.kind === "file" && text === read.text) return { ok: true, changed: false };
  try {
    writeAgentFileAtomic(read.target, text, read.kind === "file" ? read.mode : 0o600);
  } catch (error) {
    return { ok: false, reason: `${path} can't be written (${describeFsError(error)})` };
  }
  return { ok: true, changed: true };
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

type AgentOutcome =
  | { kind: "added"; record: InboxAgentRecord }
  | { kind: "already"; record: InboxAgentRecord | null }
  | { kind: "foreign"; record: InboxAgentRecord; path: string | null }
  | { kind: "failed"; reason: string; path: string | null }
  | { kind: "manual" }
  | { kind: "off"; record: InboxAgentRecord }
  | { kind: "none" };

async function connectOne(spec: AgentSpec, options: ConnectOptions, at: string): Promise<AgentOutcome> {
  const e = options.environment;
  const way = spec.way(e);
  const file = spec.file(e);
  const command = [...options.selfCommand, "inbox", "mcp"];
  const timeoutMs = options.agentTimeoutMs ?? INBOX_CONNECT_AGENT_TIMEOUT_MS;
  if (way.kind === "none") return { kind: "none" };
  if (way.kind === "manual") return { kind: "manual" };
  if (way.kind === "tool") {
    // The env var decides (and locks the switch): nothing to write.
    if (parseInboxToolEnv(e.env as NodeJS.ProcessEnv) !== undefined) {
      return resolveInboxTool(loadConfig(), e.env as NodeJS.ProcessEnv, way.host) ? { kind: "already", record: null } : { kind: "none" };
    }
    const configured = configuredInboxTool(loadConfig(), way.host);
    if (configured === true) return { kind: "already", record: { state: "found", reach: "tool", path: null, at } };
    if (configured === false) return { kind: "off", record: { state: "off", reach: "tool", path: null, at } };
    const config = loadConfig();
    const current = config.inboxTool;
    const next: Partial<Record<InboxToolHost, boolean>> =
      current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
    next[way.host] = true;
    saveConfig({ inboxTool: next });
    if (configuredInboxTool(loadConfig(), way.host) !== true) {
      return { kind: "failed", reason: "Plannotator's config.json can't be written", path: null };
    }
    return { kind: "added", record: { state: "added", reach: "tool", path: null, at } };
  }
  const before = spec.read(e);
  if (before?.kind === "unreadable") {
    return { kind: "failed", reason: `${displayPath(file, e)} can't be read (${before.reason}), so Plannotator left it as it was`, path: file };
  }
  if (before?.kind === "ours") return { kind: "already", record: { state: "found", reach: "mcp", path: file, at } };
  if (before?.kind === "other") return { kind: "foreign", record: { state: "foreign", reach: "mcp", path: file, at }, path: file };
  if (way.kind === "json") {
    const [cmd, ...args] = command;
    const result = writeJsonEntry(file!, way.keys, { command: cmd!, args });
    if (!result.ok) return { kind: "failed", reason: result.reason.replace(e.homeDir, "~"), path: file };
    return { kind: "added", record: { state: "added", reach: "mcp", path: file, command, at } };
  }
  const bin = e.which(way.bin);
  if (!bin) return { kind: "manual" };
  const ran = await e.run([bin, ...way.add(command)], { timeoutMs });
  if (ran.timedOut) return { kind: "failed", reason: `${way.bin} mcp add did not finish within ${Math.round(timeoutMs / 1000)} s`, path: file };
  if (ran.exitCode !== 0) {
    const why = firstLine(ran.stderr) || firstLine(ran.stdout);
    return { kind: "failed", reason: `${way.bin} mcp add exited with code ${ran.exitCode}${why ? ` (${why})` : ""}`, path: file };
  }
  const after = spec.read(e);
  if (after && after.kind !== "ours") {
    return { kind: "failed", reason: `${way.bin} mcp add ran, but ${displayPath(file, e)} does not have the entry`, path: file };
  }
  return { kind: "added", record: { state: "added", reach: "mcp", path: file, command, at } };
}

/**
 * Whether an `added`/`found` MCP entry is still there (read only). Null: the
 * agent's file is not known or not readable, so nothing can be said.
 */
export function entryStillThere(id: InboxAgentId, e: AgentEnvironment): boolean | null {
  const read = agentSpec(id).read(e);
  if (!read || read.kind === "unreadable") return null;
  return read.kind === "ours";
}

/**
 * Connect every agent found that has no record yet. Never throws: a failure
 * is reported per agent and tried again at the next run.
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
    if (entryStillThere(spec.id, e) === false) record.removed_outside_at = at;
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

  for (const spec of toConnect) {
    const outcome = settled.get(spec.id);
    if (!outcome) {
      report.unfinished.push(spec.id);
      continue;
    }
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
        report.failed.push({ agent: spec.id, reason: outcome.reason, path: displayPath(outcome.path, e) });
        break;
      case "manual":
        report.manual.push(spec.id);
        break;
      case "none":
        break;
    }
  }
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
      lines.push(`Connected ${inboxAgentList(report.added)} to the Inbox (new on this computer). Change it in Settings.`);
    }
    if (report.added.includes("claude-app")) lines.push("Restart the Claude app to use it there.");
  }
  for (const failure of report.failed) {
    lines.push(`Couldn't connect ${INBOX_AGENT_LABELS[failure.agent]}: ${failure.reason}. Turn it on in Settings once that's fixed.`);
  }
  for (const foreign of report.foreign) {
    lines.push(`${INBOX_AGENT_LABELS[foreign.agent]} has its own ${INBOX_MCP_SERVER_NAME} entry${foreign.path ? ` in ${foreign.path}` : ""}; left alone.`);
  }
  if (report.added.length > 0 && report.first) lines.push("Agents use it from their next session. Change this in the Inbox's Settings.");
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
  /** Entries named `plannotator-inbox` that run something else now: the person's. */
  skipped: string[];
}

/**
 * What uninstall removes: every recorded entry that still runs Plannotator,
 * then every known file's `plannotator-inbox` entry that runs Plannotator
 * (the record may be gone). Pi's and OpenCode's `inboxTool` live in
 * config.json, which a plain uninstall keeps and --purge removes.
 */
export function planInboxAgentRemoval(dataDir: string, e: AgentEnvironment): RemovalPlan {
  const file = readInboxAgents(dataDir);
  const items: RemovalPlanItem[] = [];
  const skipped: string[] = [];
  if (!agentHomeAllowed(e)) return { items, skipped };
  for (const spec of AGENT_SPECS) {
    const record = file.agents[spec.id];
    if (record?.reach === "tool") continue;
    const recorded = record?.reach === "mcp" && (record.state === "added" || record.state === "found");
    const read = spec.read(e);
    const label = INBOX_AGENT_LABELS[spec.id];
    if (read?.kind === "other" && recorded) {
      skipped.push(`${label}'s "${NAME}" now runs something else (changed by hand), so it is yours`);
      continue;
    }
    const ours = read ? read.kind === "ours" : recorded;
    if (!ours) continue;
    const path = spec.file(e) ?? record?.path ?? null;
    const shown = displayPath(path, e);
    const jsonKeys = jsonKeysFor(spec.id);
    if (jsonKeys && path) {
      items.push({
        agent: spec.id,
        describe: `MCP server ${NAME} from ${label} (${shown}, that entry only)`,
        apply: async () => {
          const result = writeJsonEntry(path, jsonKeys, undefined);
          return result.ok ? null : result.reason;
        },
      });
      continue;
    }
    const remove = cliRemoveArgs(spec.id);
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

function cliRemoveArgs(id: InboxAgentId): { bin: string; args: string[] } | null {
  switch (id) {
    case "codex":
      return { bin: "codex", args: ["mcp", "remove", NAME] };
    case "gemini":
      return { bin: "gemini", args: ["mcp", "remove", "-s", "user", NAME] };
    case "windsurf":
      return { bin: "devin", args: ["mcp", "remove", "-s", "user", NAME] };
    case "amp":
      return { bin: "amp", args: ["mcp", "remove", NAME] };
    case "cline":
      return { bin: "cline", args: ["mcp", "remove", NAME] };
    case "pi":
      return { bin: "pi", args: ["mcp", "remove", NAME] };
    default:
      return null;
  }
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
  reason: string | null;
}

/** How one agent reaches the Inbox now (read only). */
export function inboxAgentReach(id: InboxAgentId, dataDir: string, e: AgentEnvironment): InboxAgentReachState {
  const spec = agentSpec(id);
  const way = id === "claude-code" ? ({ kind: "tool", host: "claude-code" } as const) : spec.way(e);
  const file = spec.file(e);
  const path = displayPath(file, e);
  const record = readInboxAgents(dataDir).agents[id];
  if (way.kind === "tool") {
    const locked = parseInboxToolEnv(e.env as NodeJS.ProcessEnv) !== undefined;
    const on = resolveInboxTool(loadConfig(), e.env as NodeJS.ProcessEnv, way.host);
    return { kind: "tool", on, state: on ? "connected" : "off", path: null, locked, reason: null };
  }
  if (way.kind === "manual" || way.kind === "none") return { kind: way.kind, on: false, state: "manual", path, locked: false, reason: null };
  const read = spec.read(e);
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

/**
 * The person's switch in Settings: on adds the entry (or turns the tool on)
 * whatever the record says; off removes Plannotator's entry (never one that
 * runs something else) and records `off`, so no later run adds it back.
 * Returns an error reason, or null.
 */
export async function setInboxAgentReach(id: InboxAgentId, on: boolean, options: ConnectOptions): Promise<string | null> {
  const e = options.environment;
  if (!agentHomeAllowed(e)) return "not in a test's scratch home";
  const at = (options.now ?? (() => new Date()))().toISOString();
  const spec = agentSpec(id);
  const way = id === "claude-code" ? ({ kind: "tool", host: "claude-code" } as const) : spec.way(e);
  const file = readInboxAgents(options.dataDir);
  if (way.kind === "manual" || way.kind === "none") return `${INBOX_AGENT_LABELS[id]} is connected by hand`;
  if (way.kind === "tool") {
    if (parseInboxToolEnv(e.env as NodeJS.ProcessEnv) !== undefined) return "PLANNOTATOR_INBOX_TOOL decides this";
    const config = loadConfig();
    const current = config.inboxTool;
    const next: Partial<Record<InboxToolHost, boolean>> = {};
    for (const host of ["claude-code", "pi", "opencode"] as const) {
      const value = typeof current === "boolean" ? current : current?.[host];
      if (typeof value === "boolean") next[host] = value;
    }
    next[way.host] = on;
    saveConfig({ inboxTool: next });
    if (configuredInboxTool(loadConfig(), way.host) !== on) return "Plannotator's config.json can't be written";
    file.agents[id] = { state: on ? "added" : "off", reach: "tool", path: null, at };
  } else if (on) {
    delete file.agents[id];
    const outcome = await connectOne(spec, options, at);
    if (outcome.kind === "failed") return outcome.reason;
    if (outcome.kind === "foreign") return `${displayPath(outcome.path, e) ?? INBOX_AGENT_LABELS[id]} has its own ${NAME} entry`;
    if (outcome.kind === "manual") return `${INBOX_AGENT_LABELS[id]} is connected by hand`;
    if ("record" in outcome && outcome.record) file.agents[id] = outcome.record;
  } else {
    const item = planInboxAgentRemoval(options.dataDir, e).items.find((candidate) => candidate.agent === id);
    if (item) {
      const problem = await item.apply();
      if (problem) return problem;
    }
    file.agents[id] = { state: "off", reach: "mcp", path: spec.file(e), at };
  }
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
