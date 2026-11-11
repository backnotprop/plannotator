/** Agent connection (discoverInboxTools, InboxAgentConnection, InboxWake) for hosts that run node: modules (Pi, OpenCode). Imports only ./connection and node: modules so the vendored copy resolves inside generated/inbox/. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_SEND_NOW_POLL_FIELD,
  INBOX_STEER_POLLS_POLL_FIELD,
  inboxClaimName,
  INBOX_TAGS_POLL_FIELD,
  INBOX_TOOL_NAME,
  inboxHealthPeeks,
  inboxSessionThreadsParams,
  inboxSessionThreadsText,
  inboxToolCall,
  inboxResultWithNote,
  inboxToolCallParams,
  inboxToolResultText,
  inboxToolsWithoutBro,
  inboxWakeText,
  mcpAnswerOfResponse,
  parseInboxBridgeCommands,
  parseInboxRegistry,
  parseInboxToolList,
  type InboxRegistryView,
  type InboxReplyCommand,
  type InboxToolInfo,
} from "./connection";

export const INBOX_DISCOVER_TIMEOUT_MS = 2_000;
export const INBOX_SESSION_THREADS_TIMEOUT_MS = 1_500;
/** Poll wait asked of the bridge (the server holds at most 25 s). */
export const INBOX_POLL_WAIT_MS = 20_000;
/** After a failed poll: 5 s, doubling to 60 s while the Inbox stays away, never giving up. */
export const INBOX_RETRY_MS = { first: 5_000, max: 60_000 } as const;
/** The wake's tick. A reply goes in after two idle ticks in a row. */
export const INBOX_TICK_MS = 1_000;
/** `plannotator inbox --background` waits up to 20 s for the Inbox to answer. */
const START_TIMEOUT_MS = 30_000;
export const INBOX_LEASE_EVERY_MS = 5_000;
/** A lease not renewed for this long belongs to a process that exited, slept or hung (the mod's 20 s). */
export const INBOX_LEASE_STALE_MS = 20_000;
/** While nothing waits for delivery, a wake asks its host whether a turn runs every this many ticks (5 s at the default tick). */
export const INBOX_STATE_EVERY_TICKS = 5;

export const INBOX_INSTALL_TEXT =
  "The Plannotator Inbox is not running, and there is no plannotator command on this machine to start it: install Plannotator (https://plannotator.ai/docs/getting-started/installation/), then call again.";
export const INBOX_STILL_MISSING_TEXT = "The Plannotator Inbox is not running (no plannotator command on PATH).";

export function inboxRegistryFileOf(dataDir: string): string {
  return join(dataDir, "inbox", "inbox.json");
}

function rememberedToolsFileOf(dataDir: string): string {
  return join(dataDir, "inbox", "connection-tools.json");
}

/** The claim names the session too: a reply can go to several sessions sharing this data dir, and each is delivered once. */
function claimDirOf(dataDir: string, replyId: string, session: string): string {
  return join(dataDir, "inbox", "claims", inboxClaimName(replyId, session));
}

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
  const tools = inboxToolsWithoutBro(parseInboxToolList(remembered));
  return tools.length > 0 ? tools : null;
}

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
  host: string;
  agentName: string;
  tools: readonly InboxToolInfo[];
  command?: string;
}

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

  async callTool(input: unknown, at: { sessionId: string; cwd: string; wakes?: boolean }): Promise<{ text: string; isError: boolean }> {
    const call = inboxToolCall(input, this.tools, {
      project_path: at.cwd,
      agent_session: at.sessionId,
      agent_host: this.options.host,
      agent_name: this.options.agentName,
    });
    if ("error" in call) return { text: call.error, isError: true };
    if (call.projectPath !== undefined) {
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
      if (/not found|unknown tool/i.test(message)) return { text: `This Plannotator Inbox has no ${call.name}; update Plannotator. (${message})`, isError: true };
      return { text: `The Plannotator Inbox refused the call: ${message}`, isError: true };
    }
    const result = inboxToolResultText(answer.result);
    return { ...result, text: inboxResultWithNote(result.text, call.note) };
  }

  /** Null when no Inbox runs here, it does not answer in time, no thread is open, or it predates the peek mark (it would make a project for the folder). Read with the peek mark so rows do not count as read. Never throws. */
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

  private async isRunning(registry: InboxRegistryView): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${registry.port}/api/inbox/health`, { signal: AbortSignal.timeout(5_000) });
      if (response.status !== 200) return false;
      return ((await response.json()) as { serverSession?: unknown }).serverSession === registry.serverSession;
    } catch {
      return false;
    }
  }

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

  private async startInbox(): Promise<{ missing: boolean; exitCode: number | null; output: string }> {
    for (const command of plannotatorCommands(this.options.command)) {
      const run = await runOnce(command, ["inbox", "--background"], { ...process.env, PLANNOTATOR_DATA_DIR: this.dataDir });
      if (!run.missing) return run;
    }
    return { missing: true, exitCode: null, output: "" };
  }

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
  output: string;
  stdout?: string;
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

function plannotatorCommands(command?: string): string[] {
  if (command) return [command];
  const bin = process.env.PLANNOTATOR_BIN?.trim();
  return bin ? [bin] : ["plannotator", join(homedir(), ".local", "bin", "plannotator")];
}

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
    if (/unknown inbox option: --open|unknown command/i.test(why)) return { error: INBOX_OPEN_UPDATE_TEXT };
    return { error: `Could not open the Plannotator Inbox: ${why}` };
  }
  return { error: "There is no plannotator command on this machine: install Plannotator (https://plannotator.ai/docs/getting-started/installation/)." };
}

export const INBOX_OPEN_UPDATE_TEXT =
  "The plannotator on PATH is older than /plannotator-inbox. Update it with `plannotator update`, or run `plannotator inbox` in a terminal.";

export function inboxOpenedText(url: string, note?: string): string {
  return `Plannotator Inbox: ${url}${note?.trim() ? `\n${note.trim()}` : ""}`;
}

export interface InboxWakeTarget {
  isBusy(): boolean | Promise<boolean>;
  deliver(text: string, command: InboxReplyCommand): Promise<void>;
  /** Optional: puts the wake text into the running turn (Pi's steer, OpenCode 2's `delivery: "steer"`). A host without it never offers Send now. */
  steer?(text: string, command: InboxReplyCommand): Promise<void>;
  /** False while the running turn is this session's own "Ask this session" question (its answer streams to Plannotator, so a steered reply would be answered there). Absent: as long as `steer` exists. */
  canSteer?(): boolean;
  notify(message: string): void;
  /** The folder the session works in; each poll carries it as `project_path`. Optional. */
  projectPath?(): string | null | undefined | Promise<string | null | undefined>;
  /** "" clears the title; null, undefined or a throw mean unknown now, so the poll repeats the last title (sending nothing would clear it). Set by the host, never by the model. */
  label?(): string | null | undefined | Promise<string | null | undefined>;
  /** The plugin version this process loaded. `plugin` wins when both exist. */
  pluginVersion?(): string | null;
  /** `on_disk` is null when the package is gone from disk (OpenCode 2: its generation folder was deleted); `host` is `oh-my-pi` inside Oh My Pi. */
  plugin?(): InboxLoadedPluginReport | null;
}

export interface InboxLoadedPluginReport {
  version: string;
  on_disk: string | null;
  host?: "pi" | "oh-my-pi";
}

/** A deliver failure for a reason that passes (the session closed and cleared its queue): the wake gives the claim back instead of reporting the reply lost. */
export class InboxDeliverLater extends Error {
  readonly deliverLater = true;
}

function isInboxDeliverLater(error: unknown): boolean {
  return error instanceof InboxDeliverLater || (typeof error === "object" && error !== null && (error as { deliverLater?: unknown }).deliverLater === true);
}

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
  private readonly pending = new Map<string, InboxReplyCommand>();
  private readonly noSteer = new Set<string>();
  private readonly settled = new Set<string>();
  private readonly unacked = new Set<string>();
  private readonly instanceId = randomUUID();
  private readonly leaseFile: string;
  private leader = false;
  private leaseCheckedAt = Number.NEGATIVE_INFINITY;
  private touchedAt = 0;
  private readonly startedAt = Date.now();
  private lastLabel = "";
  private busy: boolean | null = null;
  private idleSince: number | null = null;
  private stateCheckedAt = Number.NEGATIVE_INFINITY;
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
    if (this.leader) writeLease(this.leaseFile, { owner: null, at: 0, touchedAt: 0 });
    this.leader = false;
  }

  touch(): void {
    this.touchedAt = Date.now();
    if (!this.disposed) this.holdLease(this.touchedAt);
  }

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

  onForeignPrompt(): void {
    this.idleTicks = 0;
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    // While a reply waits the session is asked every tick; otherwise every few seconds.
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
    // Send now: waiting replies go in without two idle ticks, oldest first, and only into a turn that accepts them (`canSteer`).
    const urgent =
      [...this.pending.values()].some((command) => command.now === true && !this.noSteer.has(command.id)) &&
      (this.steerable || busy === false);
    if (!this.delivering && this.pending.size > 0 && (this.idleTicks >= 2 || urgent)) {
      this.delivering = true;
      // Not awaited: a steer resolves only when the message enters the run, which a long tool call can hold for
      // minutes, and the tick has to go on polling meanwhile, or the session reads as ended (the Claude Code mod's way).
      void this.deliverNext(this.idleTicks < 2 && urgent)
        .catch(() => undefined)
        .finally(() => {
          this.delivering = false;
        });
    }
  }

  private get steerable(): boolean {
    return typeof this.target.steer === "function" && (this.target.canSteer?.() ?? true);
  }

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

  private async pendingNow(waitMs: number): Promise<InboxReplyCommand[] | null> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(waitMs + 10_000)]);
    let projectPath: string | null | undefined = null;
    try {
      projectPath = await this.target.projectPath?.();
    } catch {
      projectPath = null;
    }
    try {
      const label = await this.target.label?.();
      if (typeof label === "string") this.lastLabel = label;
    } catch {
      // It cannot tell now: the last word stands.
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
        ...(this.target.label ? { label: this.lastLabel } : {}),
        started_at: this.startedAt,
        ...(this.busy === null ? {} : { busy: this.busy, idle_since: this.idleSince }),
        ...(this.steerable ? { [INBOX_SEND_NOW_POLL_FIELD]: true } : {}),
        [INBOX_STEER_POLLS_POLL_FIELD]: true,
        [INBOX_TAGS_POLL_FIELD]: true,
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
        this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, INBOX_RETRY_MS.max) : INBOX_RETRY_MS.first;
        this.retryAt = Date.now() + this.backoffMs;
        return;
      }
      this.backoffMs = 0;
      this.retryAt = 0;
      const handedOut = new Set(commands.map((command) => command.id));
      for (const id of this.settled) if (!handedOut.has(id)) this.settled.delete(id);
      for (const command of commands) {
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

  private async deliverNext(urgent = false): Promise<void> {
    const waiting = this.pending.values().next().value as InboxReplyCommand | undefined;
    if (!waiting) return;
    const fresh = await this.pendingNow(0);
    if (fresh === null || this.disposed) return;
    const command = fresh.find((candidate) => candidate.id === waiting.id);
    if (!command) {
      this.pending.delete(waiting.id);
      return;
    }
    const busy = await this.target.isBusy();
    const steering = busy && urgent && this.steerable;
    if (busy && !steering) {
      this.idleTicks = 0;
      return;
    }
    if (this.disposed || !this.holdLease(Date.now())) return;
    if (!command.tagged && existsSync(join(this.connection.dataDir, "inbox", "claims", command.id))) {
      this.settle(command.id);
      return;
    }
    const claim = claimDirOf(this.connection.dataDir, command.id, this.sessionId);
    try {
      mkdirSync(join(claim, ".."), { recursive: true, mode: 0o700 });
      mkdirSync(claim, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") this.settle(command.id);
      return;
    }
    // Who holds it: the Inbox calls it stuck only once this process is gone (never while it may still deliver).
    writeQuietly(join(claim, "by"), this.instanceId);
    writeQuietly(join(claim, "pid"), String(process.pid));
    if (steering) {
      try {
        await this.target.steer!(inboxWakeText(command), command);
      } catch {
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
      if (isInboxDeliverLater(error)) {
        try {
          rmSync(claim, { recursive: true, force: true });
        } catch {
          // A leftover claim: another process reports it.
        }
        return;
      }
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

  private async acknowledge(id: string): Promise<void> {
    const response = await this.connection.bridge(INBOX_BRIDGE_EVENT_PATH, this.sessionId, { type: "delivered", id });
    if (!response) return;
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
