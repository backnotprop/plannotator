/**
 * The extension as an ACP v1 client (SPEC 4.1). It starts the agent as a
 * child process over stdio, with the user's own environment, and adds no
 * tools of its own beyond the builder's MCP server: every listed agent reads,
 * searches and runs commands with its own tools, so `fs/*` and `terminal/*`
 * are not advertised. An agent that calls `fs/read_text_file` anyway is
 * served (reading never needs to fail); write and terminal methods, which
 * were not advertised, answer "method not found". It advertises terminal
 * sign-in (`auth.terminal`), so the agent lists its own login commands for
 * the "Sign in" button. Permission requests go to
 * a callback that shows the agent's own options; this module never answers
 * one by itself, except "cancelled" for a request still open when the turn is
 * cancelled, which ACP requires.
 *
 * An agent's own extension notifications (`_x.ai/*` from Grok Build) can carry
 * secrets: Grok's `_x.ai/mcp/servers_updated` carries the person's MCP server
 * env values, API keys included. The client hands a host only the method name
 * (`onExtNotification`), never the params, and keeps no copy; extension
 * requests answer "method not found".
 *
 * Shared by the VS Code extension's Guides and the Inbox's ACP runner
 * (packages/server/inbox-acp-runner.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type AuthMethod,
  type Client,
  type AgentCapabilities,
  type InitializeResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { augmentedPath } from "./which";
import { planSpawn } from "./spawn-plan";

export interface AgentLaunch {
  command: string;
  args: string[];
  cwd: string;
  /** Added to the user's environment. */
  env?: Record<string, string>;
  /**
   * Added to the error when the agent fails before its first session is
   * ready (start, `initialize`, `session/new`, `session/load`), except a
   * sign-in error: Guides pointed the adapter at the user's own CLI, which
   * may be older than the adapter expects.
   */
  startHint?: string;
}

/** The error with `hint` on a line of its own; its `code` (an ACP error code) is kept. */
export function withStartHint(err: unknown, hint: string | undefined): unknown {
  if (!hint || (err as { code?: unknown } | null)?.code === ACP_AUTH_REQUIRED_CODE) return err;
  const message = err instanceof Error ? err.message : String(err);
  const out = new Error(`${message}\n${hint}`);
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== undefined) Object.assign(out, { code });
  return out;
}

export interface AcpClientHandlers {
  onUpdate(notification: SessionNotification): void;
  /** Show the agent's options and return the user's choice. */
  requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  onStderr?(text: string): void;
  onExit?(info: { code: number | null; signal: NodeJS.Signals | null }): void;
  /**
   * An extension notification arrived (`_vendor/...`). Only its method name:
   * the params never leave this module (they can carry secrets).
   */
  onExtNotification?(method: string): void;
}

/** How to start the agent's process beyond its launch. */
export interface AcpStartOptions {
  /** The environment the agent starts from (default: this process's). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Append the usual program folders to PATH (default true; the Inbox passes its own PATH as it is). */
  augmentPath?: boolean;
  /**
   * Give up on an agent that does not answer `initialize` in this long: its
   * process group is stopped (SIGTERM, then SIGKILL) and `start` rejects.
   * Default: no limit.
   */
  initializeTimeoutMs?: number;
  /**
   * Stop a process that is still starting: once aborted, its process group is
   * stopped and `start` rejects. Aborted with the reason `"kill"`, the group
   * gets SIGKILL at once (the caller is exiting); otherwise SIGTERM, then
   * SIGKILL after a grace period.
   */
  signal?: AbortSignal;
}

/** `start` gave up: the agent did not answer `initialize` in time, or the caller stopped it. */
export class AcpStartAbortedError extends Error {}

export interface AcpClientInfo {
  name: string;
  title: string;
  version: string;
}

const STDERR_TAIL = 8 * 1024;
/** How long a stopped agent gets to end before its whole process group is killed. */
const KILL_GRACE_MS = 3000;

/**
 * Process groups sent SIGTERM whose SIGKILL is still waiting out the grace
 * (the timer is unref'd, so it never fires once the program exits):
 * `killPendingProcessGroups` kills them now, for a program about to exit.
 */
const pendingGroupKills = new Set<number>();

/**
 * Whether the agent's process group still has a member (POSIX: `kill(-pid, 0)`).
 * An empty group's id is free: once its pid is reused by a new group leader (a
 * detached spawn, a shell, the Inbox's own isolated git), a signal to it would
 * reach an unrelated group, so a delayed signal is sent only while this holds.
 * EPERM (a group of another user's) counts as not ours. Windows: no group
 * probe; true.
 */
export function processGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM a group now, SIGKILL it after the grace (or at once through `killPendingProcessGroups`), if it still has a member then. */
function stopProcessGroup(pid: number): ReturnType<typeof setTimeout> {
  killProcessTree(pid, "SIGTERM");
  pendingGroupKills.add(pid);
  const timer = setTimeout(() => {
    if (!pendingGroupKills.delete(pid)) return;
    if (processGroupAlive(pid)) killProcessTree(pid, "SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref?.();
  return timer;
}

/**
 * SIGKILL every agent process group still inside its grace and not yet empty:
 * what a stopped, exited or crashed agent started (a dev server, a watcher)
 * never outlives a program that exits within the grace.
 */
export function killPendingProcessGroups(): void {
  for (const pid of pendingGroupKills) if (processGroupAlive(pid)) killProcessTree(pid, "SIGKILL");
  pendingGroupKills.clear();
}

/** The agents running now (POSIX): an exit hook kills their groups when this program exits, an uncaught exception included. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

/**
 * Synchronous, for `process.on("exit")` (which runs on an uncaught exception
 * too): SIGKILL every live agent's group and every group inside its grace.
 */
function killAgentGroupsOnExit(): void {
  for (const pid of liveGroups) killProcessTree(pid, "SIGKILL");
  liveGroups.clear();
  killPendingProcessGroups();
}

function trackLiveGroup(pid: number): void {
  if (process.platform === "win32") return;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", killAgentGroupsOnExit);
  }
  liveGroups.add(pid);
}

/**
 * What the client offers the agent: terminal sign-in, so it can list its login
 * commands. No file system or terminal: the agents Guides starts all bring
 * their own, and an agent that does not see these uses its own tools.
 */
export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: true },
} as const;

/** The largest file `fs/read_text_file` reads (10 MB). */
export const MAX_CLIENT_READ_BYTES = 10 * 1024 * 1024;

function notOffered(method: string): never {
  throw RequestError.methodNotFound(`${method} (not offered by this client: the agent's own tools do this)`);
}

/** `fs/read_text_file`: the file's text, from `line` (1-based) for `limit` lines when given. */
export async function readTextFileForAgent(params: { path: string; line?: number | null; limit?: number | null }): Promise<{ content: string }> {
  if (!isAbsolute(params.path)) throw RequestError.invalidParams(undefined, "path must be absolute");
  const info = await stat(params.path);
  if (!info.isFile()) throw RequestError.invalidParams(undefined, `${params.path} is not a file`);
  if (info.size > MAX_CLIENT_READ_BYTES) throw RequestError.invalidParams(undefined, `${params.path} is ${info.size} bytes; the client reads files up to ${MAX_CLIENT_READ_BYTES} bytes`);
  const text = await readFile(params.path, "utf8");
  if (params.line == null && params.limit == null) return { content: text };
  const lines = text.split("\n");
  const start = Math.max(0, (params.line ?? 1) - 1);
  const end = params.limit == null ? lines.length : start + Math.max(0, params.limit);
  return { content: lines.slice(start, end).join("\n") };
}

/** The ACP JSON-RPC error code for "authentication required". */
export const ACP_AUTH_REQUIRED_CODE = -32000;

/**
 * Signal a process and everything it started. POSIX: the agent runs as the
 * leader of its own process group, so the group is signalled even after the
 * leader exited (its children stay in the group). Windows: `taskkill /T /F`
 * kills the tree while the leader still runs; Windows has no group signal for
 * a tree whose leader is gone (untested on Windows).
 */
export function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    try {
      const t = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      t.on("error", () => {});
      t.unref();
    } catch {
      // nothing more to do
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the whole group is gone
  }
}

export class AcpClient {
  private readonly connection: ClientSideConnection;
  private readonly child: ChildProcess;
  private readonly pendingPermissions = new Set<AbortController>();
  private stderrTail = "";
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly exitWaiters: Array<() => void> = [];
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** `AgentLaunch.startHint`, until a session is ready. */
  private startHint: string | undefined;
  initializeResult: InitializeResponse | null = null;

  private constructor(child: ChildProcess, private readonly handlers: AcpClientHandlers, startHint?: string) {
    this.child = child;
    this.startHint = startHint;
    const input = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);
    const client: Client = {
      requestPermission: async (params) => {
        const controller = new AbortController();
        this.pendingPermissions.add(controller);
        try {
          const answer = await Promise.race([
            this.handlers.requestPermission(params, controller.signal),
            new Promise<RequestPermissionResponse>((resolve) =>
              controller.signal.addEventListener("abort", () => resolve({ outcome: { outcome: "cancelled" } }), { once: true }),
            ),
          ]);
          return answer;
        } finally {
          this.pendingPermissions.delete(controller);
        }
      },
      sessionUpdate: async (params) => {
        this.handlers.onUpdate(params);
      },
      // Reading is served even though it is not advertised. Writing and terminals
      // were not advertised; left out, the SDK would answer `fs/write_text_file`
      // with an empty success that wrote nothing, so they say so instead.
      readTextFile: (params) => readTextFileForAgent(params),
      writeTextFile: async () => notOffered("fs/write_text_file"),
      createTerminal: async () => notOffered("terminal/create"),
      terminalOutput: async () => notOffered("terminal/output"),
      releaseTerminal: async () => notOffered("terminal/release"),
      waitForTerminalExit: async () => notOffered("terminal/wait_for_exit"),
      killTerminal: async () => notOffered("terminal/kill"),
      // The method name only: the params are dropped here, never stored or passed on.
      extNotification: async (method: string) => {
        this.handlers.onExtNotification?.(method);
      },
      extMethod: async (method: string) => {
        throw RequestError.methodNotFound(method);
      },
    };
    this.connection = new ClientSideConnection((_agent: Agent) => client, stream);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL);
      this.handlers.onStderr?.(text);
    });
    if (child.pid !== undefined) trackLiveGroup(child.pid);
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      const pid = child.pid;
      if (pid !== undefined && process.platform !== "win32") {
        liveGroups.delete(pid);
        if (!this.stopped) {
          // The agent exited or crashed by itself: what it started may still be in its group (a dev server,
          // a watcher), which keeps the group's id while any member lives. An empty group gets no signal.
          this.stopped = true;
          if (processGroupAlive(pid)) this.killTimer = stopProcessGroup(pid);
        } else if (!processGroupAlive(pid)) {
          // Stopped (dispose) and the whole group is gone already: the delayed SIGKILL is not sent.
          if (this.killTimer) clearTimeout(this.killTimer);
          this.killTimer = null;
          pendingGroupKills.delete(pid);
        }
      }
      for (const c of this.pendingPermissions) c.abort();
      this.handlers.onExit?.({ code, signal });
      for (const w of this.exitWaiters.splice(0)) w();
    });
  }

  /** Start the agent process and run `initialize`. */
  static async start(launch: AgentLaunch, handlers: AcpClientHandlers, clientInfo: AcpClientInfo, options: AcpStartOptions = {}): Promise<AcpClient> {
    const plan = planSpawn(launch.command, launch.args);
    const base = options.env ?? process.env;
    const child = spawn(plan.command, plan.args, {
      cwd: launch.cwd,
      env: { ...base, PATH: options.augmentPath === false ? (base.PATH ?? "") : augmentedPath(base), ...plan.env, ...launch.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so Cancel can stop everything the agent started.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const startError = await new Promise<Error | null>((resolve) => {
      child.once("error", (err) => resolve(err));
      child.once("spawn", () => resolve(null));
    });
    if (startError) throw new Error(`Could not start ${launch.command}: ${startError.message}`);
    const client = new AcpClient(child, handlers, launch.startHint);
    // An agent that hangs in `initialize` (a self-update, a sign-in waiting on a prompt) can still be stopped:
    // by a time limit, or by the caller's signal.
    const { signal, initializeTimeoutMs } = options;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const gaveUp = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AcpStartAbortedError(`${launch.command} was stopped while it started.`));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      if (initializeTimeoutMs !== undefined) {
        timer = setTimeout(() => reject(new AcpStartAbortedError(`${launch.command} did not answer within ${Math.round(initializeTimeoutMs / 1000)} s of starting.`)), initializeTimeoutMs);
      }
    });
    try {
      client.initializeResult = await Promise.race([
        client.raceExit(
          client.connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: CLIENT_CAPABILITIES,
            clientInfo,
          }),
          "initialize",
        ),
        gaveUp,
      ]);
    } catch (err) {
      if (signal?.aborted && signal.reason === "kill") client.kill();
      else client.dispose();
      // A stop or time limit is the caller's, not the agent's CLI: it keeps its own class and message.
      throw err instanceof AcpStartAbortedError ? err : withStartHint(err, launch.startHint);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    const agentVersion = client.initializeResult.protocolVersion;
    if (agentVersion !== PROTOCOL_VERSION) {
      client.dispose();
      throw new Error(`The agent speaks ACP protocol version ${String(agentVersion)}; Plannotator speaks version ${PROTOCOL_VERSION}. Update the adapter, then try again.`);
    }
    return client;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** What the agent said it can do in `initialize` (`loadSession`, …). */
  get agentCapabilities(): AgentCapabilities {
    return this.initializeResult?.agentCapabilities ?? {};
  }

  /** The sign-ins the agent offered in `initialize`. */
  get authMethods(): readonly AuthMethod[] {
    return this.initializeResult?.authMethods ?? [];
  }

  /** Reject when the process exits before the request answers, with its stderr. */
  private raceExit<T>(promise: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const onExit = () => {
        if (done) return;
        done = true;
        const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
        reject(new Error(`The agent exited during ${what}${this.exitInfo?.code != null ? ` (code ${this.exitInfo.code})` : ""}.${tail ? `\n${tail}` : ""}`));
      };
      if (this.exited) return onExit();
      this.exitWaiters.push(onExit);
      promise.then(
        (v) => {
          if (done) return;
          done = true;
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          reject(e);
        },
      );
    });
  }

  newSession(cwd: string, mcpServers: McpServer[], meta?: Record<string, unknown>): Promise<NewSessionResponse> {
    return this.firstSession(this.raceExit(this.connection.newSession({ cwd, mcpServers, ...(meta && { _meta: meta }) }), "session/new"));
  }

  /** Until a session is ready, a failure carries the launch's `startHint`; after, it never does. */
  private async firstSession<T>(request: Promise<T>): Promise<T> {
    try {
      const result = await request;
      this.startHint = undefined;
      return result;
    } catch (err) {
      throw withStartHint(err, this.startHint);
    }
  }

  /**
   * `session/load`: reopen an earlier session (only when the agent advertises
   * `loadSession`). The agent replays the conversation as `session/update`
   * notifications before it answers.
   */
  loadSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<LoadSessionResponse> {
    return this.firstSession(this.raceExit(this.connection.loadSession({ sessionId, cwd, mcpServers }), "session/load"));
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    const res = await this.raceExit(this.connection.setSessionConfigOption({ sessionId, configId, value }), "session/set_config_option");
    return res.configOptions;
  }

  /** `session/set_mode`, for adapters that expose session modes rather than a `mode` config option. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.raceExit(this.connection.setSessionMode({ sessionId, modeId }), "session/set_mode");
  }

  /** The agent advertised `session/close` (`sessionCapabilities.close`). */
  get canCloseSession(): boolean {
    const caps = this.agentCapabilities as AgentCapabilities & { sessionCapabilities?: { close?: unknown } };
    return !!caps.sessionCapabilities?.close;
  }

  /** `session/close`: the agent lets go of the session (only when advertised; a failure is ignored). */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.canCloseSession || this.exited) return;
    try {
      await this.raceExit(this.connection.closeSession({ sessionId }), "session/close");
    } catch {
      // Closing is best effort: the session is still on disk.
    }
  }

  prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.raceExit(this.connection.prompt({ sessionId, prompt: [{ type: "text", text }] }), "session/prompt");
  }

  /** `session/cancel`; open permission prompts answer "cancelled". */
  async cancel(sessionId: string): Promise<void> {
    for (const c of this.pendingPermissions) c.abort();
    if (this.exited) return;
    try {
      await this.connection.cancel({ sessionId });
    } catch {
      // The process may be gone; dispose() handles the rest.
    }
  }

  /**
   * Stop the agent and everything it started: SIGTERM to its process group,
   * then SIGKILL to the group after a grace period, whether or not the agent
   * itself has exited by then (what it started may still run).
   */
  dispose(): void {
    for (const c of this.pendingPermissions) c.abort();
    const pid = this.child.pid;
    if (pid === undefined || this.stopped) return;
    this.stopped = true;
    if (process.platform === "win32") {
      killProcessTree(pid, "SIGKILL");
      return;
    }
    this.killTimer = stopProcessGroup(pid);
  }

  /** Kill the agent and everything it started now (VS Code is shutting down). */
  kill(): void {
    for (const c of this.pendingPermissions) c.abort();
    const pid = this.child.pid;
    if (pid === undefined) return;
    this.stopped = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    pendingGroupKills.delete(pid);
    killProcessTree(pid, "SIGKILL");
  }

  /**
   * Plain words for a failed request: when the process ended (the connection
   * closes first, then the exit arrives), say so with its code and the end of
   * its stderr.
   */
  async describeFailure(err: unknown): Promise<string> {
    const message = err instanceof Error ? err.message : String(err);
    if (!this.exited && /connection closed|closed/i.test(message)) await this.waitForExit(1000);
    if (!this.exited) return message;
    const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
    const code = this.exitInfo?.code != null ? ` with code ${this.exitInfo.code}` : this.exitInfo?.signal ? ` (${this.exitInfo.signal})` : "";
    const hint = this.startHint && (err as { code?: unknown } | null)?.code !== ACP_AUTH_REQUIRED_CODE ? `\n${this.startHint}` : "";
    return `The agent exited${code}.${tail ? `\n${tail}` : ""}${hint}`;
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }
}

/** A select option flattened from `configOptions` (groups included). */
export interface ConfigChoice {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigSelect {
  configId: string;
  name: string;
  current: string;
  options: ConfigChoice[];
}

/** The select option of a category (`model`, `thought_level`), or null when the agent exposes none. */
export function readConfigSelect(configOptions: readonly SessionConfigOption[] | null | undefined, category: string): ConfigSelect | null {
  for (const option of configOptions ?? []) {
    if (option.category !== category || option.type !== "select") continue;
    const raw = option.options as Array<{ value?: string; name: string; description?: string | null; options?: Array<{ value: string; name: string; description?: string | null }> }>;
    const flat: ConfigChoice[] = [];
    for (const entry of raw) {
      if (Array.isArray(entry.options)) {
        for (const o of entry.options) flat.push({ value: o.value, name: o.name, ...(o.description && { description: o.description }) });
      } else if (typeof entry.value === "string") {
        flat.push({ value: entry.value, name: entry.name, ...(entry.description && { description: entry.description }) });
      }
    }
    return { configId: option.id, name: option.name, current: String(option.currentValue), options: flat };
  }
  return null;
}

/**
 * The first select option among `configOptions` with this category, else with
 * one of these ids (agents name the same thing differently: Mistral Vibe's
 * effort is category `thinking`, Kiro's effort id is `effortLevel`).
 */
function readSelectBy(configOptions: readonly SessionConfigOption[] | null | undefined, category: string, ids: readonly string[]): ConfigSelect | null {
  const byCategory = readConfigSelect(configOptions, category);
  if (byCategory) return byCategory;
  for (const id of ids) {
    const option = (configOptions ?? []).find((o) => o.id === id && o.type === "select");
    if (option) return readConfigSelect([{ ...option, category }] as SessionConfigOption[], category);
  }
  return null;
}

/** The session's model select. */
export function readModelSelect(configOptions: readonly SessionConfigOption[] | null | undefined): ConfigSelect | null {
  return readSelectBy(configOptions, "model", ["model"]);
}

/** The session's effort (reasoning, thinking) select. */
export function readEffortSelect(configOptions: readonly SessionConfigOption[] | null | undefined): ConfigSelect | null {
  return readSelectBy(configOptions, "thought_level", ["thought_level", "thinking", "thinking_effort", "reasoning_effort", "effort", "effortLevel"])
    ?? readSelectBy(configOptions, "thinking", []);
}

/** The session's mode select. */
export function readModeSelect(configOptions: readonly SessionConfigOption[] | null | undefined): ConfigSelect | null {
  return readSelectBy(configOptions, "mode", ["mode"]);
}
