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
  env?: Record<string, string>;
  startHint?: string;
}

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
  requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
  onStderr?(text: string): void;
  onExit?(info: { code: number | null; signal: NodeJS.Signals | null }): void;
  onExtNotification?(method: string): void;
}

export interface AcpStartOptions {
  env?: Readonly<Record<string, string | undefined>>;
  augmentPath?: boolean;
  initializeTimeoutMs?: number;
  signal?: AbortSignal;
}

export class AcpStartAbortedError extends Error {}

export interface AcpClientInfo {
  name: string;
  title: string;
  version: string;
}

const STDERR_TAIL = 8 * 1024;
const KILL_GRACE_MS = 3000;

const pendingGroupKills = new Set<number>();

export function processGroupAlive(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

export function killPendingProcessGroups(): void {
  for (const pid of pendingGroupKills) if (processGroupAlive(pid)) killProcessTree(pid, "SIGKILL");
  pendingGroupKills.clear();
}

const liveGroups = new Set<number>();
let exitHookInstalled = false;

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

export const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: true },
} as const;

export const MAX_CLIENT_READ_BYTES = 10 * 1024 * 1024;

function notOffered(method: string): never {
  throw RequestError.methodNotFound(`${method} (not offered by this client: the agent's own tools do this)`);
}

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

export const ACP_AUTH_REQUIRED_CODE = -32000;

export function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    try {
      const t = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      t.on("error", () => {});
      t.unref();
    } catch {
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
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
      readTextFile: (params) => readTextFileForAgent(params),
      writeTextFile: async () => notOffered("fs/write_text_file"),
      createTerminal: async () => notOffered("terminal/create"),
      terminalOutput: async () => notOffered("terminal/output"),
      releaseTerminal: async () => notOffered("terminal/release"),
      waitForTerminalExit: async () => notOffered("terminal/wait_for_exit"),
      killTerminal: async () => notOffered("terminal/kill"),
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
          this.stopped = true;
          if (processGroupAlive(pid)) this.killTimer = stopProcessGroup(pid);
        } else if (!processGroupAlive(pid)) {
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

  static async start(launch: AgentLaunch, handlers: AcpClientHandlers, clientInfo: AcpClientInfo, options: AcpStartOptions = {}): Promise<AcpClient> {
    const plan = planSpawn(launch.command, launch.args);
    const base = options.env ?? process.env;
    const child = spawn(plan.command, plan.args, {
      cwd: launch.cwd,
      env: { ...base, PATH: options.augmentPath === false ? (base.PATH ?? "") : augmentedPath(base), ...plan.env, ...launch.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const startError = await new Promise<Error | null>((resolve) => {
      child.once("error", (err) => resolve(err));
      child.once("spawn", () => resolve(null));
    });
    if (startError) throw new Error(`Could not start ${launch.command}: ${startError.message}`);
    const client = new AcpClient(child, handlers, launch.startHint);
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

  get agentCapabilities(): AgentCapabilities {
    return this.initializeResult?.agentCapabilities ?? {};
  }

  get authMethods(): readonly AuthMethod[] {
    return this.initializeResult?.authMethods ?? [];
  }

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

  private async firstSession<T>(request: Promise<T>): Promise<T> {
    try {
      const result = await request;
      this.startHint = undefined;
      return result;
    } catch (err) {
      throw withStartHint(err, this.startHint);
    }
  }

  loadSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<LoadSessionResponse> {
    return this.firstSession(this.raceExit(this.connection.loadSession({ sessionId, cwd, mcpServers }), "session/load"));
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    const res = await this.raceExit(this.connection.setSessionConfigOption({ sessionId, configId, value }), "session/set_config_option");
    return res.configOptions;
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.raceExit(this.connection.setSessionMode({ sessionId, modeId }), "session/set_mode");
  }

  get canCloseSession(): boolean {
    const caps = this.agentCapabilities as AgentCapabilities & { sessionCapabilities?: { close?: unknown } };
    return !!caps.sessionCapabilities?.close;
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.canCloseSession || this.exited) return;
    try {
      await this.raceExit(this.connection.closeSession({ sessionId }), "session/close");
    } catch {
    }
  }

  prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.raceExit(this.connection.prompt({ sessionId, prompt: [{ type: "text", text }] }), "session/prompt");
  }

  async cancel(sessionId: string): Promise<void> {
    for (const c of this.pendingPermissions) c.abort();
    if (this.exited) return;
    try {
      await this.connection.cancel({ sessionId });
    } catch {
    }
  }

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

  kill(): void {
    for (const c of this.pendingPermissions) c.abort();
    const pid = this.child.pid;
    if (pid === undefined) return;
    this.stopped = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    pendingGroupKills.delete(pid);
    killProcessTree(pid, "SIGKILL");
  }

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

function readSelectBy(configOptions: readonly SessionConfigOption[] | null | undefined, category: string, ids: readonly string[]): ConfigSelect | null {
  const byCategory = readConfigSelect(configOptions, category);
  if (byCategory) return byCategory;
  for (const id of ids) {
    const option = (configOptions ?? []).find((o) => o.id === id && o.type === "select");
    if (option) return readConfigSelect([{ ...option, category }] as SessionConfigOption[], category);
  }
  return null;
}

export function readModelSelect(configOptions: readonly SessionConfigOption[] | null | undefined): ConfigSelect | null {
  return readSelectBy(configOptions, "model", ["model"]);
}

export function readEffortSelect(configOptions: readonly SessionConfigOption[] | null | undefined): ConfigSelect | null {
  return readSelectBy(configOptions, "thought_level", ["thought_level", "thinking", "thinking_effort", "reasoning_effort", "effort", "effortLevel"])
    ?? readSelectBy(configOptions, "thinking", []);
}

export function readModeSelect(configOptions: readonly SessionConfigOption[] | null | undefined): ConfigSelect | null {
  return readSelectBy(configOptions, "mode", ["mode"]);
}
