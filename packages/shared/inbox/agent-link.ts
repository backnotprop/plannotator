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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  inboxToolCall,
  inboxToolResultText,
  inboxWakeText,
  mcpAnswerOf,
  parseInboxBridgeCommands,
  parseInboxRegistry,
  parseInboxToolList,
  type InboxRegistryView,
  type InboxReplyCommand,
  type InboxToolInfo,
} from "./connection";

/** The longest a host's start waits for a running Inbox's `tools/list` (the mod's bound). */
export const INBOX_DISCOVER_TIMEOUT_MS = 2_000;
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

function claimDirOf(dataDir: string, replyId: string): string {
  return join(dataDir, "inbox", "claims", replyId);
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
  return mcpAnswerOf(await response.text());
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

  /** A `plannotator_inbox` call from `sessionId`, working in `cwd`. */
  async callTool(input: unknown, at: { sessionId: string; cwd: string }): Promise<{ text: string; isError: boolean }> {
    const call = inboxToolCall(input, this.tools, {
      project_path: at.cwd,
      agent_session: at.sessionId,
      agent_host: this.options.host,
      agent_name: this.options.agentName,
    });
    if ("error" in call) return { text: call.error, isError: true };
    const running = await this.ensureRunning();
    if ("error" in running) return { text: running.error, isError: true };
    let answer: Awaited<ReturnType<typeof mcpCall>>;
    try {
      answer = await mcpCall(running.port, "tools/call", { name: call.name, arguments: call.arguments });
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
    const candidates = this.options.command
      ? [this.options.command]
      : process.env.PLANNOTATOR_BIN?.trim()
        ? [process.env.PLANNOTATOR_BIN.trim()]
        : ["plannotator", join(homedir(), ".local", "bin", "plannotator")];
    for (const command of candidates) {
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

function runOnce(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ missing: boolean; exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const done = (value: { missing: boolean; exitCode: number | null; output: string }) => {
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
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => done({ missing: error.code === "ENOENT", exitCode: null, output: error.message }));
    child.on("close", (code) => done({ missing: false, exitCode: code, output }));
  });
}

/** What a host gives one session's wake. */
export interface InboxWakeTarget {
  /** A turn runs, a prompt waits, or the session cannot take a turn now. */
  isBusy(): boolean | Promise<boolean>;
  /** Put the wake text into the session as a turn; resolves once it entered, rejects when it could not. */
  deliver(text: string, command: InboxReplyCommand): Promise<void>;
  /** A line for the person, outside the model's context (a toast, a notice). */
  notify(message: string): void;
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
    // The session is only asked while a reply waits: idle for two ticks in a row, then it goes in.
    this.idleTicks = this.pending.size === 0 || (await this.target.isBusy()) ? 0 : this.idleTicks + 1;
    for (const id of [...this.unacked]) await this.acknowledge(id);
    const now = Date.now();
    if (now - this.leaseCheckedAt >= INBOX_LEASE_EVERY_MS) this.holdLease(now);
    if (!this.leader) return;
    if (!this.polling && now >= this.retryAt) void this.poll();
    if (!this.delivering && this.pending.size > 0 && this.idleTicks >= 2) {
      this.delivering = true;
      try {
        await this.deliverNext();
      } finally {
        this.delivering = false;
      }
    }
  }

  private async pendingNow(waitMs: number): Promise<InboxReplyCommand[] | null> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(waitMs + 10_000)]);
    const response = await this.connection.bridge(INBOX_BRIDGE_POLL_PATH, this.sessionId, { waitMs }, signal);
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

  /** Deliver the oldest waiting reply as a turn, once. */
  private async deliverNext(): Promise<void> {
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
    if (await this.target.isBusy()) {
      this.idleTicks = 0;
      return;
    }
    // The person may have moved to another process since the last tick.
    if (this.disposed || !this.holdLease(Date.now())) return;
    const claim = claimDirOf(this.connection.dataDir, command.id);
    try {
      mkdirSync(join(claim, ".."), { recursive: true, mode: 0o700 });
      mkdirSync(claim, { mode: 0o700 });
    } catch (error) {
      // EEXIST: another process (or an earlier instance here) took it.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") this.settle(command.id);
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
