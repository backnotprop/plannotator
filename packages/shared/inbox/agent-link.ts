/**
 * Plannotator Inbox: the agent connection for hosts whose plugins run in a
 * JavaScript runtime with `node:` modules (plan step 7): the Pi extension
 * (vendored into `apps/pi-extension/generated/inbox/` by `vendor.sh`) and the
 * OpenCode plugin. The Claude Code mod has its own copy of this logic over the
 * engine's `$` (`apps/hook/hooks/mod/inbox.ts`); the contract, the wake text
 * and the tool shape are shared through `./connection`, never re-written.
 *
 *  - `discoverInboxTools`: read once at session start, and only where
 *    `inbox/inbox.json` exists: the running Inbox's `tools/list`, bounded so a
 *    wedged Inbox cannot hold the host's start; a stopped Inbox is described
 *    by the list it last answered with (`inbox/connection-tools.json`).
 *  - `InboxAgentConnection`: the `plannotator_inbox` tool. Each call re-reads
 *    the registry, starts a stopped Inbox with `plannotator inbox --background`
 *    (detached, never a browser tab), and proxies to the Inbox's `/mcp` with
 *    the filled arguments. No `plannotator` on PATH: the result says to
 *    install Plannotator, once per connection.
 *  - `InboxWake`: one per agent session. A 1 s tick long-polls the bridge for
 *    the person's replies to that session's messages (5 to 60 s backoff, never
 *    giving up), holds a reply until the session has been idle for two ticks,
 *    checks it once more with the Inbox, claims it once across processes
 *    (mkdir of `inbox/claims/<reply id>`), hands the wake text to the host,
 *    and acknowledges `delivered`. It never interrupts a turn: a prompt typed
 *    into the wake's turn takes it over, and the reply is never sent again.
 *    Two host processes on one session (`pi -c` or `--session` twice): only
 *    the holder of the session's lease (`inbox/leases/<host>-<session>.json`)
 *    polls and delivers, and the process the person used last holds it (the
 *    Claude Code mod's rule); the claim keeps a delivery once whatever the
 *    lease says.
 *
 * Imports: `./connection` and `node:` modules only, so the vendored copy
 * resolves inside `generated/inbox/`.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_SEND_NOW_POLL_FIELD,
  INBOX_TAGS_POLL_FIELD,
  INBOX_TOOL_NAME,
  inboxHealthPeeks,
  inboxSessionThreadsParams,
  inboxSessionThreadsText,
  inboxToolCall,
  inboxToolCallParams,
  inboxToolResultText,
  inboxWakeText,
  mcpAnswerOfResponse,
  parseInboxBridgeCommands,
  parseInboxRegistry,
  parseInboxToolList,
  type InboxRegistryView,
  type InboxReplyCommand,
  type InboxToolInfo,
} from "./connection";

/** The longest a host's start waits for a running Inbox's `tools/list` (the mod's bound). */
export const INBOX_DISCOVER_TIMEOUT_MS = 2_000;
/** The longest the session's thread list may take (the Claude Code mod's bound); past it there is no list. */
export const INBOX_SESSION_THREADS_TIMEOUT_MS = 1_500;
/** Poll wait asked of the bridge (the server holds at most 25 s). */
export const INBOX_POLL_WAIT_MS = 20_000;
/** After a failed poll: 5 s, doubling to 60 s while the Inbox stays away, never giving up. */
export const INBOX_RETRY_MS = { first: 5_000, max: 60_000 } as const;
/** The wake's tick. A reply goes in after two idle ticks in a row. */
export const INBOX_TICK_MS = 1_000;
/** `plannotator inbox --background` waits up to 20 s for the Inbox to answer. */
const START_TIMEOUT_MS = 30_000;
/** How often a wake renews or re-reads its session's lease (the mod's 5 s). */
export const INBOX_LEASE_EVERY_MS = 5_000;
/** A lease not renewed for this long belongs to a process that exited, slept or hung (the mod's 20 s). */
export const INBOX_LEASE_STALE_MS = 20_000;
/** While nothing waits for delivery, a wake asks its host whether a turn runs every this many ticks (5 s at the default tick). */
export const INBOX_STATE_EVERY_TICKS = 5;

/** The first time a call finds no `plannotator` to start the Inbox with. */
export const INBOX_INSTALL_TEXT =
  "The Plannotator Inbox is not running, and there is no plannotator command on this machine to start it: install Plannotator (https://plannotator.ai/docs/getting-started/installation/), then call again.";
/** Every later call that finds none, in the same session. */
export const INBOX_STILL_MISSING_TEXT = "The Plannotator Inbox is not running (no plannotator command on PATH).";

export function inboxRegistryFileOf(dataDir: string): string {
  return join(dataDir, "inbox", "inbox.json");
}

function rememberedToolsFileOf(dataDir: string): string {
  return join(dataDir, "inbox", "connection-tools.json");
}

/**
 * The claim folder of one delivery. A reply that tags agents goes to several
 * sessions, which may share this data dir (two Pi sessions, Pi and OpenCode):
 * a tagged session's claim names its session too, so each is delivered once.
 */
function claimDirOf(dataDir: string, replyId: string, taggedSession?: string | null): string {
  const name = taggedSession ? `${replyId}.${taggedSession.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}` : replyId;
  return join(dataDir, "inbox", "claims", name);
}

/** One session's lease on one host: which of its processes polls and delivers. */
export function inboxLeaseFileOf(dataDir: string, host: string, sessionId: string): string {
  return join(dataDir, "inbox", "leases", `${host}-${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

interface InboxLease {
  owner: string | null;
  at: number;
  touchedAt: number;
}

function parseLease(text: string | null): InboxLease | null {
  try {
    const value = JSON.parse(text ?? "") as Record<string, unknown>;
    if (typeof value.at !== "number") return null;
    return {
      owner: typeof value.owner === "string" && value.owner ? value.owner : null,
      at: value.at,
      touchedAt: typeof value.touchedAt === "number" ? value.touchedAt : 0,
    };
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readRegistry(dataDir: string): InboxRegistryView | null {
  return parseInboxRegistry(readText(inboxRegistryFileOf(dataDir)));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mcpCall(
  port: number,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ result?: unknown; error?: { message?: string } } | null> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal,
  });
  return mcpAnswerOfResponse(response.status, await response.text());
}

/**
 * The Inbox tools a session's `plannotator_inbox` tool carries, decided once
 * at session start; null: no tool (no registry, or nothing known about the
 * Inbox's tools).
 */
export async function discoverInboxTools(
  dataDir: string,
  options: { timeoutMs?: number } = {},
): Promise<InboxToolInfo[] | null> {
  if (!existsSync(inboxRegistryFileOf(dataDir))) return null;
  const registry = readRegistry(dataDir);
  if (registry) {
    const answer = await mcpCall(registry.port, "tools/list", {}, AbortSignal.timeout(options.timeoutMs ?? INBOX_DISCOVER_TIMEOUT_MS)).catch(() => null);
    const tools = answer && "result" in answer ? parseInboxToolList(answer.result) : [];
    if (tools.length > 0) {
      try {
        const file = rememberedToolsFileOf(dataDir);
        writeFileSync(`${file}.tmp`, JSON.stringify({ tools }), { mode: 0o600 });
        chmodSync(`${file}.tmp`, 0o600);
        renameSync(`${file}.tmp`, file);
      } catch {
        // Remembering is a convenience: the next start reads the live list again.
      }
      return tools;
    }
  }
  let remembered: unknown = null;
  try {
    remembered = JSON.parse(readText(rememberedToolsFileOf(dataDir)) ?? "null");
  } catch {
    remembered = null;
  }
  const tools = parseInboxToolList(remembered);
  return tools.length > 0 ? tools : null;
}

/** An agent's `project_path` as an existing folder's realpath (relative to `cwd` unless absolute), or null. */
export function inboxProjectDir(cwd: string, given: string): string | null {
  try {
    const real = realpathSync(isAbsolute(given) ? given : resolve(cwd, given));
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export interface InboxAgentConnectionOptions {
  dataDir: string;
  /** The host named on messages and deliveries (`pi`, `opencode`). */
  host: string;
  /** How the person sees this agent ("Pi", "OpenCode"): the thread's "Delivered to <name>". */
  agentName: string;
  tools: readonly InboxToolInfo[];
  /** The command that starts the Inbox. Default: PLANNOTATOR_BIN, else `plannotator` on PATH, else ~/.local/bin/plannotator. */
  command?: string;
}

/** The `plannotator_inbox` tool and the bridge doors, for one host process. */
export class InboxAgentConnection {
  readonly tools: readonly InboxToolInfo[];
  private saidInstall = false;

  constructor(readonly options: InboxAgentConnectionOptions) {
    this.tools = options.tools;
  }

  get dataDir(): string {
    return this.options.dataDir;
  }

  get host(): string {
    return this.options.host;
  }

  /** A `plannotator_inbox` call from `sessionId`, working in `cwd`; `wakes` when this session's wake runs (replies arrive as turns). */
  async callTool(input: unknown, at: { sessionId: string; cwd: string; wakes?: boolean }): Promise<{ text: string; isError: boolean }> {
    const call = inboxToolCall(input, this.tools, {
      project_path: at.cwd,
      agent_session: at.sessionId,
      agent_host: this.options.host,
      agent_name: this.options.agentName,
    });
    if ("error" in call) return { text: call.error, isError: true };
    if (call.projectPath !== undefined) {
      // The agent named the project: an existing folder, relative to the working folder, or nothing reaches the Inbox.
      const resolved = inboxProjectDir(at.cwd, call.projectPath);
      if (!resolved) return { text: `Invalid plannotator_inbox call: project_path ${call.projectPath} is not an existing folder.`, isError: true };
      call.arguments.project_path = resolved;
    }
    const running = await this.ensureRunning();
    if ("error" in running) return { text: running.error, isError: true };
    let answer: Awaited<ReturnType<typeof mcpCall>>;
    try {
      answer = await mcpCall(running.port, "tools/call", inboxToolCallParams(call, { wakes: at.wakes === true }));
    } catch (error) {
      return { text: `The Plannotator Inbox did not answer (${errorText(error)}).`, isError: true };
    }
    if (!answer) return { text: "The Plannotator Inbox gave an answer this session could not read.", isError: true };
    if (answer.error) {
      const message = answer.error.message ?? "unknown error";
      // An action this Inbox lost (a downgrade since session start).
      if (/not found|unknown tool/i.test(message)) return { text: `This Plannotator Inbox has no ${call.name}; update Plannotator. (${message})`, isError: true };
      return { text: `The Plannotator Inbox refused the call: ${message}`, isError: true };
    }
    return inboxToolResultText(answer.result);
  }

  /**
   * The session's open threads as a few short lines (`inboxSessionThreadsText`),
   * or null: no Inbox has run here, it is not running (it is never started
   * for this), it did not answer within `timeoutMs`, there is no open
   * thread, or the Inbox is older than the peek mark (no `peek: true` in its
   * health: it would make a project for the folder). Read with the peek mark, so the Inbox makes no project and the
   * rows do not count as the session having read them. Never throws.
   */
  async sessionThreads(at: { sessionId: string; cwd: string }, toolName: string = INBOX_TOOL_NAME, timeoutMs = INBOX_SESSION_THREADS_TIMEOUT_MS): Promise<string | null> {
    const registry = readRegistry(this.dataDir);
    if (!registry || !at.sessionId || !at.cwd) return null;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const health = await fetch(`http://127.0.0.1:${registry.port}/api/inbox/health`, { signal });
      if (health.status !== 200 || !inboxHealthPeeks(await health.json(), registry.serverSession)) return null;
      const answer = await mcpCall(registry.port, "tools/call", inboxSessionThreadsParams(at.cwd, at.sessionId), signal);
      if (!answer || !("result" in answer)) return null;
      const result = answer.result as { isError?: unknown } | undefined;
      return result?.isError === true ? null : inboxSessionThreadsText(result, toolName);
    } catch {
      return null;
    }
  }

  /** Running: the registry's port answers health with the registry's serverSession. */
  private async isRunning(registry: InboxRegistryView): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${registry.port}/api/inbox/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.status !== 200) return false;
      return ((await response.json()) as { serverSession?: unknown }).serverSession === registry.serverSession;
    } catch {
      return false;
    }
  }

  /** The running Inbox, starting a stopped one detached (no browser) first. */
  async ensureRunning(): Promise<InboxRegistryView | { error: string }> {
    const known = readRegistry(this.dataDir);
    if (known && (await this.isRunning(known))) return known;
    const started = await this.startInbox();
    if (started.missing) {
      const text = this.saidInstall ? INBOX_STILL_MISSING_TEXT : INBOX_INSTALL_TEXT;
      this.saidInstall = true;
      return { error: text };
    }
    if (started.exitCode !== 0) {
      const why = started.output.trim() || `exit ${started.exitCode}`;
      if (/unknown command/i.test(why)) return { error: "The plannotator on PATH has no Inbox (an older version); update Plannotator." };
      return { error: `The Plannotator Inbox did not start: ${why}` };
    }
    return readRegistry(this.dataDir) ?? { error: "The Plannotator Inbox started but wrote no registry." };
  }

  /** `plannotator inbox --background`: a one-shot that detaches the Inbox into its own session and waits for it. */
  private async startInbox(): Promise<{ missing: boolean; exitCode: number | null; output: string }> {
    for (const command of plannotatorCommands(this.options.command)) {
      const run = await runOnce(command, ["inbox", "--background"], { ...process.env, PLANNOTATOR_DATA_DIR: this.dataDir });
      if (!run.missing) return run;
    }
    return { missing: true, exitCode: null, output: "" };
  }

  /** One bridge request for `session` (bearer token from the registry, re-read every time); null when the Inbox did not answer. */
  async bridge(path: string, session: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; text: string } | null> {
    const registry = readRegistry(this.dataDir);
    if (!registry) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${registry.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${registry.token}` },
        body: JSON.stringify({ session, host: this.options.host, ...body }),
        signal,
      });
      return { status: response.status, text: await response.text() };
    } catch {
      return null;
    }
  }
}

interface RunOnceResult {
  missing: boolean;
  exitCode: number | null;
  /** Stdout and stderr together, in arrival order. */
  output: string;
  /** Stdout alone. */
  stdout?: string;
  /** Stderr alone. */
  stderr?: string;
}

function runOnce(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<RunOnceResult> {
  return new Promise((resolve) => {
    let output = "";
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (value: RunOnceResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ missing: (error as NodeJS.ErrnoException).code === "ENOENT", exitCode: null, output: errorText(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ missing: false, exitCode: null, output: `${output}\n(no answer within ${START_TIMEOUT_MS / 1000} s)` });
    }, START_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
      stderr += String(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => done({ missing: error.code === "ENOENT", exitCode: null, output: error.message }));
    child.on("close", (code) => done({ missing: false, exitCode: code, output, stdout, stderr }));
  });
}

/** The commands that run Plannotator: PLANNOTATOR_BIN, else `plannotator` on PATH, else ~/.local/bin/plannotator. */
function plannotatorCommands(command?: string): string[] {
  if (command) return [command];
  const bin = process.env.PLANNOTATOR_BIN?.trim();
  return bin ? [bin] : ["plannotator", join(homedir(), ".local", "bin", "plannotator")];
}

/**
 * `/plannotator-inbox` on Pi and OpenCode: `plannotator inbox --open`, which
 * opens the person's Inbox in the browser (starting a stopped one detached)
 * and prints its address. Never blocks the session: it returns once the
 * Inbox answers (at most the CLI's 20 s start wait). `note` is what the CLI
 * said on stderr, e.g. that no browser opened in a remote session and how to
 * reach the Inbox from here.
 */
export async function openInboxInBrowser(
  options: { dataDir?: string; command?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ url: string; note?: string } | { error: string }> {
  const env = { ...(options.env ?? process.env), ...(options.dataDir ? { PLANNOTATOR_DATA_DIR: options.dataDir } : {}) };
  for (const command of plannotatorCommands(options.command)) {
    const run = await runOnce(command, ["inbox", "--open"], env);
    if (run.missing) continue;
    const url = /https?:\/\/\S+/.exec(run.stdout ?? "")?.[0];
    if (run.exitCode === 0 && url) {
      const note = run.stderr?.trim();
      return note ? { url, note } : { url };
    }
    const why = run.output.trim() || `exit ${run.exitCode}`;
    // A plannotator older than --open (or than the Inbox itself).
    if (/unknown inbox option: --open|unknown command/i.test(why)) return { error: INBOX_OPEN_UPDATE_TEXT };
    return { error: `Could not open the Plannotator Inbox: ${why}` };
  }
  return { error: "There is no plannotator command on this machine: install Plannotator (https://plannotator.ai/docs/getting-started/installation/)." };
}

/** An older plannotator answered `/plannotator-inbox` with "Unknown inbox option: --open". */
export const INBOX_OPEN_UPDATE_TEXT =
  "The plannotator on PATH is older than /plannotator-inbox. Update it with `plannotator update`, or run `plannotator inbox` in a terminal.";

/** What `/plannotator-inbox` says: where the Inbox is, and the CLI's note when it gave one. */
export function inboxOpenedText(url: string, note?: string): string {
  return `Plannotator Inbox: ${url}${note?.trim() ? `\n${note.trim()}` : ""}`;
}

/** What a host gives one session's wake. */
export interface InboxWakeTarget {
  /** A turn runs, a prompt waits, or the session cannot take a turn now. */
  isBusy(): boolean | Promise<boolean>;
  /** Put the wake text into the session as a turn; resolves once it entered, rejects when it could not. */
  deliver(text: string, command: InboxReplyCommand): Promise<void>;
  /**
   * Send now, while a turn runs: put the wake text into that turn (Pi's
   * steer, OpenCode 2's `delivery: "steer"`), so the model reads it at its
   * next step instead of after the turn. Resolves once the host took it.
   * Optional: a host without it never says it can (`INBOX_SEND_NOW_POLL_FIELD`)
   * and the window never offers Send now for its sessions.
   */
  steer?(text: string, command: InboxReplyCommand): Promise<void>;
  /**
   * Whether `steer` can work right now (OpenCode 2: only while its event
   * stream runs, which is how a steer's delivery is confirmed). False while
   * the running turn is this session's own "Ask this session" question (its
   * answer streams to Plannotator, so a reply steered in would be answered
   * there): the reply then waits for idle, and the poll stops offering Send
   * now. Absent: as long as `steer` exists.
   */
  canSteer?(): boolean;
  /** A line for the person, outside the model's context (a toast, a notice). */
  notify(message: string): void;
  /**
   * The folder the session works in (Pi: `ctx.cwd`; OpenCode: the session's
   * `location.directory`). Each poll carries it as `project_path`, so the
   * Inbox lists the session under its real project, even before it wrote
   * there (compose, New message). Optional: a host without it is listed only
   * where it wrote.
   */
  projectPath?(): string | null | undefined | Promise<string | null | undefined>;
  /**
   * The version of Plannotator's plugin or extension this process loaded
   * (Pi: the extension's package.json). Each poll carries it as `plugin:
   * { version }`, so the Inbox can say when the session runs an older one.
   * Optional: a host without it sends nothing. `plugin` wins when both exist.
   */
  pluginVersion?(): string | null;
  /**
   * What this process loaded AND what is on disk now (owner approval
   * "reload-hosts"): `{ version, on_disk, host }`. `on_disk` is null when the
   * package is gone from disk (OpenCode 2: its generation folder was
   * deleted), `host` `oh-my-pi` inside Oh My Pi. Each poll carries it as
   * `plugin`, so the Inbox can say which command loads the newer code.
   */
  plugin?(): InboxLoadedPluginReport | null;
}

/** A poll's `plugin` as Pi, Oh My Pi and OpenCode 2 send it. */
export interface InboxLoadedPluginReport {
  version: string;
  on_disk: string | null;
  host?: "pi" | "oh-my-pi";
}

/**
 * The reply wake for one agent session: polls the bridge, waits for idle,
 * delivers each reply once, acknowledges it. Never interrupts a turn.
 */
export class InboxWake {
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private ticking = false;
  private polling = false;
  private delivering = false;
  private retryAt = 0;
  private backoffMs = 0;
  private idleTicks = 0;
  private readonly abort = new AbortController();
  /** Handed out by the Inbox and not yet settled here, in arrival order. */
  private readonly pending = new Map<string, InboxReplyCommand>();
  /** Send now could not go into the running turn: these wait for idle, as before. */
  private readonly noSteer = new Set<string>();
  /** Settled here: delivered, claimed by another process, or reported. */
  private readonly settled = new Set<string>();
  /** Delivered, not yet acknowledged to the Inbox. */
  private readonly unacked = new Set<string>();
  /** Names this wake in the session's lease. */
  private readonly instanceId = randomUUID();
  private readonly leaseFile: string;
  private leader = false;
  private leaseCheckedAt = Number.NEGATIVE_INFINITY;
  /** When the person last acted in this process; the most recent touch wins the lease. */
  private touchedAt = 0;
  /** When this wake started: the poll's `started_at`, as the Claude Code mod sends it. */
  private readonly startedAt = Date.now();
  /** Whether a turn runs, as last asked (null until asked), and since when the session is idle. */
  private busy: boolean | null = null;
  private idleSince: number | null = null;
  private stateCheckedAt = Number.NEGATIVE_INFINITY;
  /** Whether Send now could go in, as last told to the Inbox. */
  private lastSteerable: boolean | null = null;

  constructor(
    private readonly connection: InboxAgentConnection,
    readonly sessionId: string,
    private readonly target: InboxWakeTarget,
    private readonly tickMs = INBOX_TICK_MS,
  ) {
    this.leaseFile = inboxLeaseFileOf(connection.dataDir, connection.host, sessionId);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Start the tick. The person is in this process now. */
  start(): void {
    if (this.timer || this.disposed) return;
    this.touch();
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      // A throw in a timer would take the host down: every failure is a retry.
      void this.tick()
        .catch(() => undefined)
        .finally(() => {
          this.ticking = false;
        });
    }, this.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort();
    // Let another process on this session take over at once.
    if (this.leader) writeLease(this.leaseFile, { owner: null, at: 0, touchedAt: 0 });
    this.leader = false;
  }

  /** The person acted in this process (typed, or its agent called the tool): replies land here from now on. */
  touch(): void {
    this.touchedAt = Date.now();
    if (!this.disposed) this.holdLease(this.touchedAt);
  }

  /**
   * Whether this process polls and delivers: it holds the session's lease
   * unless another live process does and the person touched that one at
   * least as recently.
   */
  private holdLease(now: number): boolean {
    this.leaseCheckedAt = now;
    const lease = parseLease(readText(this.leaseFile));
    const foreign = !!lease?.owner && lease.owner !== this.instanceId && Math.abs(now - lease.at) < INBOX_LEASE_STALE_MS;
    if (foreign && lease && lease.touchedAt >= this.touchedAt) {
      this.leader = false;
      return false;
    }
    writeLease(this.leaseFile, { owner: this.instanceId, at: now, touchedAt: this.touchedAt });
    this.leader = true;
    return true;
  }

  /** Someone else's prompt is entering the session: the idle count starts over. */
  onForeignPrompt(): void {
    this.idleTicks = 0;
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    // While a reply waits the session is asked every tick (idle for two ticks
    // in a row, then it goes in); otherwise every few seconds, for the
    // Inbox's live sessions ("idle" or "working").
    let busy: boolean | null = null;
    const asked = Date.now();
    if (this.pending.size > 0 || asked - this.stateCheckedAt >= this.tickMs * INBOX_STATE_EVERY_TICKS) {
      this.stateCheckedAt = asked;
      busy = await this.target.isBusy();
      this.noteBusy(busy, asked);
    }
    this.idleTicks = this.pending.size === 0 || busy !== false ? 0 : this.idleTicks + 1;
    for (const id of [...this.unacked]) await this.acknowledge(id);
    const now = Date.now();
    if (now - this.leaseCheckedAt >= INBOX_LEASE_EVERY_MS) this.holdLease(now);
    if (!this.leader) return;
    if (!this.polling && now >= this.retryAt) void this.poll();
    // Send now: once the person asked for one, the waiting replies go in without waiting for two idle
    // ticks, oldest first (an urgent reply never overtakes an older one to the same session).
    // Only when there is a turn it may go into, or the session is idle: never into a turn the target
    // refuses (`canSteer`: this session's own "Ask this session" question, as the Claude Code mod rules).
    const urgent =
      [...this.pending.values()].some((command) => command.now === true && !this.noSteer.has(command.id)) &&
      (this.steerable || busy === false);
    if (!this.delivering && this.pending.size > 0 && (this.idleTicks >= 2 || urgent)) {
      this.delivering = true;
      try {
        await this.deliverNext(this.idleTicks < 2 && urgent);
      } finally {
        this.delivering = false;
      }
    }
  }

  /** `steer` exists and can work now. */
  private get steerable(): boolean {
    return typeof this.target.steer === "function" && (this.target.canSteer?.() ?? true);
  }

  /**
   * A turn started or ended, or whether Send now can go in changed (an Ask
   * question began or ended): the Inbox's live sessions say so (a `state`
   * event, as the Claude Code mod posts), so the window offers Send now only
   * when it can work.
   */
  private noteBusy(busy: boolean, now: number): void {
    const steerable = this.steerable;
    if (busy === this.busy && steerable === this.lastSteerable) return;
    const known = this.busy !== null;
    if (busy !== this.busy && !busy) this.idleSince = now;
    this.busy = busy;
    this.lastSteerable = steerable;
    if (known && this.leader && !this.disposed) {
      void this.connection
        .bridge(INBOX_BRIDGE_EVENT_PATH, this.sessionId, { type: "state", busy, idle_since: this.idleSince, [INBOX_SEND_NOW_POLL_FIELD]: steerable })
        .catch(() => null);
    }
  }

  /**
   * The replies and messages waiting for this session (waitMs 0: now). The
   * poll says where the session works and whether a turn runs
   * (`project_path`, `started_at`, `busy`, `idle_since`), as the Claude Code
   * mod's does, for the Inbox's live sessions.
   */
  private async pendingNow(waitMs: number): Promise<InboxReplyCommand[] | null> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(waitMs + 10_000)]);
    let projectPath: string | null | undefined = null;
    try {
      projectPath = await this.target.projectPath?.();
    } catch {
      projectPath = null;
    }
    let plugin: InboxLoadedPluginReport | { version: string } | null = null;
    try {
      plugin = this.target.plugin?.() ?? null;
      if (!plugin) {
        const version = this.target.pluginVersion?.() ?? null;
        plugin = version ? { version } : null;
      }
    } catch {
      plugin = null;
    }
    const response = await this.connection.bridge(
      INBOX_BRIDGE_POLL_PATH,
      this.sessionId,
      {
        waitMs,
        ...(typeof projectPath === "string" && projectPath ? { project_path: projectPath } : {}),
        started_at: this.startedAt,
        ...(this.busy === null ? {} : { busy: this.busy, idle_since: this.idleSince }),
        ...(this.steerable ? { [INBOX_SEND_NOW_POLL_FIELD]: true } : {}),
        // Tags (approval "inbox-tag-agents"): this connection words a reply it was tagged in truthfully.
        [INBOX_TAGS_POLL_FIELD]: true,
        // What this process loaded (additive): the Inbox says when the session runs an older one.
        ...(plugin?.version ? { plugin } : {}),
      },
      signal,
    );
    return response && response.status === 200 ? parseInboxBridgeCommands(response.text) : null;
  }

  private async poll(): Promise<void> {
    this.polling = true;
    try {
      const commands = await this.pendingNow(INBOX_POLL_WAIT_MS);
      if (this.disposed) return;
      if (commands === null) {
        // No registry, a stopped Inbox, an older one without the route, a
        // rotated token: wait and try again, longer each time, never for good.
        this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, INBOX_RETRY_MS.max) : INBOX_RETRY_MS.first;
        this.retryAt = Date.now() + this.backoffMs;
        return;
      }
      this.backoffMs = 0;
      this.retryAt = 0;
      for (const command of commands) {
        // A later poll may carry `now` (the person pressed Send now): the newest command wins.
        if (!this.settled.has(command.id)) this.pending.set(command.id, command);
      }
    } finally {
      this.polling = false;
    }
  }

  private settle(id: string): void {
    this.pending.delete(id);
    this.settled.add(id);
  }

  /**
   * Deliver the oldest waiting reply as a turn, once; `urgent` (the person
   * pressed Send now, the session not idle for two ticks yet): into the
   * running turn when one runs (`steer`), else as a turn at once.
   */
  private async deliverNext(urgent = false): Promise<void> {
    const command = this.pending.values().next().value as InboxReplyCommand | undefined;
    if (!command) return;
    // Still waiting? An agent may have read it through the tool meanwhile, or
    // another process delivered it.
    const fresh = await this.pendingNow(0);
    if (fresh === null || this.disposed) return;
    if (!fresh.some((candidate) => candidate.id === command.id)) {
      this.settle(command.id);
      return;
    }
    const busy = await this.target.isBusy();
    const steering = busy && urgent && this.steerable;
    if (busy && !steering) {
      this.idleTicks = 0;
      return;
    }
    // The person may have moved to another process since the last tick.
    if (this.disposed || !this.holdLease(Date.now())) return;
    const claim = claimDirOf(this.connection.dataDir, command.id, command.tagged ? this.sessionId : null);
    try {
      mkdirSync(join(claim, ".."), { recursive: true, mode: 0o700 });
      mkdirSync(claim, { mode: 0o700 });
    } catch (error) {
      // EEXIST: another process (or an earlier instance here) took it.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") this.settle(command.id);
      return;
    }
    if (steering) {
      try {
        await this.target.steer!(inboxWakeText(command), command);
      } catch {
        // It did not go into the running turn: give the claim back, and the
        // reply reads as queued again and waits for idle, as before.
        try {
          rmSync(claim, { recursive: true, force: true });
        } catch {
          // A leftover claim: this instance cannot take it again; another process reports it.
        }
        this.noSteer.add(command.id);
        void this.connection.bridge(INBOX_BRIDGE_EVENT_PATH, this.sessionId, { type: "send_now_failed", id: command.id }).catch(() => null);
        return;
      }
      writeQuietly(join(claim, "delivered"), new Date().toISOString());
      this.settle(command.id);
      this.unacked.add(command.id);
      await this.acknowledge(command.id);
      return;
    }
    try {
      await this.target.deliver(inboxWakeText(command), command);
    } catch (error) {
      this.settle(command.id);
      writeQuietly(join(claim, "reported"), "1");
      this.target.notify(
        `A reply in the Plannotator Inbox (${command.subject ?? "a thread"}) could not be delivered to this session (${errorText(error)}). Read it in the Inbox: ${command.url}`,
      );
      return;
    }
    writeQuietly(join(claim, "delivered"), new Date().toISOString());
    this.settle(command.id);
    this.unacked.add(command.id);
    await this.acknowledge(command.id);
  }

  /** Tell the Inbox a reply was delivered (retried every tick until it answers). */
  private async acknowledge(id: string): Promise<void> {
    const response = await this.connection.bridge(INBOX_BRIDGE_EVENT_PATH, this.sessionId, { type: "delivered", id });
    if (!response) return;
    // 200, or a refusal that will not change (the reply is gone or not ours): done.
    if (response.status === 200 || (response.status >= 400 && response.status < 500 && response.status !== 401)) this.unacked.delete(id);
  }
}

function writeLease(file: string, lease: InboxLease): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lease), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Unwritable: the claim still keeps every delivery once.
  }
}

function writeQuietly(path: string, text: string): void {
  try {
    writeFileSync(path, text, { mode: 0o600 });
  } catch {
    // A marker only.
  }
}
