/**
 * Codex provider — `codex app-server` transport (registered as "codex-sdk").
 *
 * Why this replaces the old `@openai/codex-sdk` (codex exec) provider:
 *   The SDK ran `codex exec`, a headless one-shot mode that hard-codes
 *   `approval_policy = never`. In enterprise-managed Codex environments that
 *   ban `never`, Ask AI broke (GitHub #971). `codex exec` also has no channel
 *   to ask a human for approval.
 *
 * This provider instead drives a long-lived `codex app-server` process over
 * newline-delimited JSON-RPC 2.0 (stdio). The fix for #971 is simply to OMIT
 * `approvalPolicy` at `thread/start` so Codex resolves the user's + company's
 * configured policy itself; we pin `sandbox: "read-only"` to keep Ask AI safe.
 * Codex's approval prompts arrive as server→client JSON-RPC *requests*, which
 * we surface as the existing `permission_request` AIMessage and answer through
 * the existing `respondToPermission` path (same Allow/Deny UI as Claude).
 *
 * The registry name stays "codex-sdk" (it is the persisted cookie providerId,
 * the key in agents.ts, and the UI reasoning-effort gate) — only the transport
 * changed. Implemented with node:child_process so a single file works under
 * both the Bun server and the Node (Pi) extension.
 *
 * Note: `codex app-server`'s `thread/start` has no `skipGitRepoCheck` param —
 * unlike `codex exec`, it does not gate on being inside a git repo, so the
 * #965 "Ask AI outside git repos" fix needs no special handling here.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { BaseSession } from "../base-session.ts";
import { buildEffectivePrompt, buildSystemPrompt } from "../context.ts";
import type {
  AIMessage,
  AIPermissionRequestMessage,
  AIProvider,
  AIProviderCapabilities,
  AISession,
  CodexSDKConfig,
  CreateSessionOptions,
} from "../types.ts";
import { registerProviderFactory } from "../provider.ts";
import {
  buildWindowsCommandScriptSpawnCommand,
  killWindowsProcessTree,
  resolveWindowsCommandShim,
} from "./command-path.ts";

const PROVIDER_NAME = "codex-sdk";
const DEFAULT_MODEL = "gpt-5.6-sol";
const CLIENT_NAME = "plannotator";
/** Kill an idle app-server process after this long with no query. */
const IDLE_TIMEOUT_MS = 10 * 60_000;
/** Reject a JSON-RPC request that gets no response in this long (RPC acks are
 *  fast — turn output streams via notifications, not the turn/start response). */
const RPC_TIMEOUT_MS = 30_000;
/** Model discovery must not gate the AI panel: cap its handshake + model/list
 *  RPCs much shorter than RPC_TIMEOUT_MS so a codex that's installed but not
 *  logged in (or otherwise unresponsive) falls back to the static model list
 *  fast instead of blocking /api/ai/capabilities for the full timeout. */
const MODEL_DISCOVERY_TIMEOUT_MS = 6_000;

const CMD_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval";
// Permission-profile escalation (extra network/filesystem access). Distinct
// response shape from the two above ({permissions} grant, not {decision}).
const PERMISSIONS_APPROVAL_METHOD = "item/permissions/requestApproval";

/** Display labels for Codex's reasoning-effort ids. `xhigh` is shown verbatim
 *  (Codex's own term), not "Max" or "Extra High". */
const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xhigh",
  max: "Max",
  ultra: "Ultra",
};

type ProviderModel = {
  id: string;
  label: string;
  default?: boolean;
  reasoningEfforts?: { id: string; label: string }[];
  defaultReasoningEffort?: string;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export type RpcMessage = Record<string, unknown>;

export type RpcClassification =
  | { kind: "response"; id: string | number }
  | { kind: "request"; id: string | number; method: string; params: RpcMessage }
  | { kind: "notification"; method: string; params: RpcMessage }
  | { kind: "unknown" };

/**
 * Classify an incoming JSON-RPC message by SHAPE (not by a `type` field):
 *   - response:     has `id`, no `method`
 *   - server request: has both `id` and `method`
 *   - notification: has `method`, no `id`
 * Client-sent ids and server-sent ids live in separate id spaces, so a message
 * carrying `method` is NEVER treated as a response to one of our requests.
 */
export function classifyRpcMessage(msg: RpcMessage): RpcClassification {
  const hasId = msg.id !== undefined && msg.id !== null;
  const hasMethod = typeof msg.method === "string";
  if (hasId && !hasMethod) {
    return { kind: "response", id: msg.id as string | number };
  }
  if (hasId && hasMethod) {
    return {
      kind: "request",
      id: msg.id as string | number,
      method: msg.method as string,
      params: (msg.params as RpcMessage) ?? {},
    };
  }
  if (hasMethod) {
    return {
      kind: "notification",
      method: msg.method as string,
      params: (msg.params as RpcMessage) ?? {},
    };
  }
  return { kind: "unknown" };
}

/**
 * Map a Codex app-server notification (`{ method, params }`) to AIMessages.
 * `sessionId` is the resolved thread id, injected into the terminal result.
 */
export function mapCodexAppServerEvent(
  notification: { method: string; params?: RpcMessage },
  sessionId: string,
): AIMessage[] {
  const method = notification.method;
  const params = notification.params ?? {};

  switch (method) {
    case "item/agentMessage/delta": {
      const delta = params.delta as string | undefined;
      return delta ? [{ type: "text_delta", delta }] : [];
    }

    case "item/started": {
      const item = params.item as RpcMessage | undefined;
      if (item?.type === "commandExecution") {
        return [{
          type: "tool_use",
          toolName: "Bash",
          toolInput: { command: (item.command as string) ?? "" },
          toolUseId: (item.id as string) ?? "",
        }];
      }
      return [];
    }

    case "item/completed": {
      const item = params.item as RpcMessage | undefined;
      if (item?.type === "commandExecution") {
        const output = (item.aggregatedOutput as string) ?? "";
        const exitCode = item.exitCode as number | undefined;
        return [{
          type: "tool_result",
          toolUseId: (item.id as string) ?? "",
          result: exitCode != null ? `${output}\n[exit code: ${exitCode}]` : output,
        }];
      }
      if (item?.type === "error") {
        return [{ type: "error", error: (item.message as string) ?? "Error" }];
      }
      // agentMessage / fileChange / reasoning: streamed via deltas or shown
      // via approvals — nothing to emit on completion.
      return [];
    }

    case "turn/completed": {
      const turn = params.turn as RpcMessage | undefined;
      const status = turn?.status as string | undefined;
      if (status === "failed") {
        const error = turn?.error as RpcMessage | undefined;
        return [{
          type: "error",
          error: (error?.message as string) ?? "Turn failed",
          code: "turn_failed",
        }];
      }
      return [{ type: "result", sessionId, success: true }];
    }

    case "error": {
      // Transient errors carry willRetry=true: Codex retries on its own and the
      // turn keeps going, so don't surface them — that would flash a spurious
      // failure right before the real answer arrives.
      if (params.willRetry === true) return [];
      // Codex's ErrorNotification nests the text under `error` (a TurnError with
      // a `message`); fall back to a top-level message for forward-compat.
      const errObj = params.error as { message?: string } | undefined;
      return [{
        type: "error",
        error: errObj?.message ?? (params.message as string) ?? "Unknown error",
        code: "codex_error",
      }];
    }

    case "process_exited":
      return [{
        type: "error",
        error: "Codex app-server process exited unexpectedly.",
        code: "provider_error",
      }];

    // Streaming-only / informational notifications we intentionally ignore.
    case "thread/started":
    case "turn/started":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "thread/tokenUsage/updated":
      return [];

    default:
      return [{ type: "unknown", raw: notification }];
  }
}

/**
 * Map an inbound approval REQUEST to a `permission_request` AIMessage so the
 * existing PermissionCard renders it. `requestId` correlates the user's later
 * decision back to the JSON-RPC request id.
 */
export function mapApprovalRequest(
  method: string,
  params: RpcMessage,
  requestId: string,
): AIPermissionRequestMessage {
  const toolUseId = (params.itemId as string) ?? requestId;
  const reason = params.reason as string | undefined;

  if (method === CMD_APPROVAL_METHOD) {
    return {
      type: "permission_request",
      requestId,
      toolName: "Bash",
      toolInput: {
        command: (params.command as string) ?? "",
        ...(params.cwd ? { cwd: params.cwd } : {}),
      },
      ...(reason ? { description: reason } : {}),
      toolUseId,
    };
  }

  if (method === FILE_APPROVAL_METHOD) {
    return {
      type: "permission_request",
      requestId,
      toolName: "FileChange",
      toolInput: {},
      title: reason ?? "Approve file changes",
      toolUseId,
    };
  }

  // Generic fallback for any other approval-shaped request.
  return {
    type: "permission_request",
    requestId,
    toolName: method,
    toolInput: params,
    ...(reason ? { description: reason } : {}),
    toolUseId,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio (bidirectional: responses, notifications, server requests)
// ---------------------------------------------------------------------------

type NotificationListener = (notification: { method: string; params: RpcMessage }) => void;
type RequestHandler = (method: string, id: string | number, params: RpcMessage) => void;

class CodexAppServerProcess {
  private proc: ChildProcess | null = null;
  private listeners: NotificationListener[] = [];
  private requestHandlers: RequestHandler[] = [];
  private pendingRequests = new Map<
    string,
    { resolve: (data: RpcMessage) => void; reject: (err: Error) => void }
  >();
  private nextId = 0;
  private buffer = "";
  // Streaming decoder: a multi-byte UTF-8 char can split across stdout chunks;
  // decoding per-chunk with toString() would corrupt the boundary into U+FFFD.
  private decoder = new TextDecoder();
  private _alive = false;
  private startPromise: Promise<void> | null = null;

  /** Spawn + JSON-RPC initialize handshake, once. `initTimeoutMs` bounds the
   *  initialize wait (model discovery passes a short value so it can't hang). */
  start(codexPath: string, cwd: string, initTimeoutMs?: number): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart(codexPath, cwd, initTimeoutMs).catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  private async doStart(codexPath: string, cwd: string, initTimeoutMs?: number): Promise<void> {
    const commandPath = resolveWindowsCommandShim(codexPath);
    const command =
      buildWindowsCommandScriptSpawnCommand(commandPath, ["app-server"]) ?? [
        commandPath,
        "app-server",
      ];

    let proc: ChildProcess;
    try {
      const [file, ...args] = command;
      // stderr is "ignore", not "pipe": we never read it, and an un-drained
      // stderr pipe deadlocks the child once its buffer fills.
      proc = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleProcessEnd(error);
      throw error;
    }

    this.proc = proc;
    proc.once("exit", () => {
      this.handleProcessEnd(new Error("Codex app-server exited unexpectedly"));
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        proc.off("spawn", onSpawn);
        proc.off("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        this._alive = true;
        this.readStream();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        this.handleProcessEnd(err);
        reject(err);
      };
      proc.once("spawn", onSpawn);
      proc.once("error", onError);
    });

    // JSON-RPC handshake: initialize (request) then initialized (notification).
    // If initialize times out or rejects, the OS process is still alive but
    // never usable. Kill it here so `_alive` flips back to false — otherwise
    // ensureThread() sees a live process, skips re-spawn, and every subsequent
    // query hangs on the uninitialized handshake until the idle timer fires.
    try {
      await this.sendAndWait({
        method: "initialize",
        params: {
          clientInfo: { name: CLIENT_NAME, title: "Plannotator", version: "1.0.0" },
        },
      }, initTimeoutMs);
    } catch (err) {
      this.kill();
      throw err;
    }
    this.send({ method: "initialized", params: {} });
  }

  private handleProcessEnd(error: Error): void {
    if (!this.proc && this.pendingRequests.size === 0) return;
    this._alive = false;
    this.proc = null;
    for (const [, pending] of this.pendingRequests) pending.reject(error);
    this.pendingRequests.clear();
    for (const listener of this.listeners) {
      listener({ method: "process_exited", params: {} });
    }
  }

  private readStream(): void {
    if (!this.proc?.stdout) return;
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.decode(chunk, { stream: true });
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, "");
        if (!trimmed) continue;
        try {
          this.routeMessage(JSON.parse(trimmed));
        } catch {
          // Ignore malformed lines.
        }
      }
    });
  }

  private routeMessage(msg: RpcMessage): void {
    const classified = classifyRpcMessage(msg);
    switch (classified.kind) {
      case "response": {
        const pending = this.pendingRequests.get(String(classified.id));
        if (!pending) return;
        this.pendingRequests.delete(String(classified.id));
        if (msg.error) {
          const err = msg.error as RpcMessage;
          pending.reject(new Error((err.message as string) ?? "RPC error"));
        } else {
          pending.resolve((msg.result as RpcMessage) ?? {});
        }
        return;
      }
      case "request": {
        for (const handler of this.requestHandlers) {
          handler(classified.method, classified.id, classified.params);
        }
        return;
      }
      case "notification": {
        for (const listener of this.listeners) {
          listener({ method: classified.method, params: classified.params });
        }
        return;
      }
      default:
        return;
    }
  }

  send(message: RpcMessage): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendAndWait(message: RpcMessage, timeoutMs = RPC_TIMEOUT_MS): Promise<RpcMessage> {
    const id = ++this.nextId;
    const key = String(id);
    return new Promise((resolve, reject) => {
      // Guard against a process that's alive but unresponsive (e.g. stalled on
      // auth, or a turn queued behind an interrupting turn) — without a timer
      // the request would hang forever.
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(key)) {
          reject(new Error(`Codex app-server did not respond to ${String(message.method)} in ${timeoutMs}ms`));
        }
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pendingRequests.set(key, {
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.send({ ...message, id });
    });
  }

  /** Answer an inbound server request with a JSON-RPC result. */
  respond(id: string | number, result: RpcMessage): void {
    this.send({ id, result });
  }

  /** Answer an inbound server request with a JSON-RPC error. */
  respondError(id: string | number, message: string): void {
    this.send({ id, error: { code: -32601, message } });
  }

  onEvent(listener: NotificationListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  onRequest(handler: RequestHandler): () => void {
    this.requestHandlers.push(handler);
    return () => {
      const idx = this.requestHandlers.indexOf(handler);
      if (idx >= 0) this.requestHandlers.splice(idx, 1);
    };
  }

  get alive(): boolean {
    return this._alive;
  }

  kill(): void {
    this._alive = false;
    this.startPromise = null;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      if (!killWindowsProcessTree(proc.pid)) proc.kill();
    }
    this.listeners.length = 0;
    this.requestHandlers.length = 0;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Process killed"));
    }
    this.pendingRequests.clear();
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class CodexAppServerProvider implements AIProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities: AIProviderCapabilities = {
    fork: false, // thread/fork needs a shared thread store — out of scope
    resume: true,
    streaming: true,
    tools: true,
  };
  // Fallback used only until fetchModels() replaces it with Codex's real list
  // (model/list). Reasoning efforts are intentionally omitted here so the UI
  // hides the control until we have the model's actual supported set.
  models: ProviderModel[] = [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", default: true },
  ];

  private config: CodexSDKConfig;
  private sessions = new Set<CodexAppServerSession>();
  private modelsLoaded = false;

  constructor(config: CodexSDKConfig) {
    this.config = config;
  }

  /**
   * Populate `models` from Codex's `model/list` — the real models plus each
   * model's actual supportedReasoningEfforts + defaultReasoningEffort. Spawns a
   * throwaway app-server (like the Pi/OpenCode providers' fetchModels). Keeps
   * the static fallback on any failure.
   */
  async fetchModels(): Promise<void> {
    if (this.modelsLoaded) return;
    const proc = new CodexAppServerProcess();
    try {
      await proc.start(
        this.config.codexExecutablePath ?? "codex",
        this.config.cwd ?? process.cwd(),
        MODEL_DISCOVERY_TIMEOUT_MS,
      );
      // model/list is paginated (nextCursor); aggregate every page into one list
      // so larger model catalogs aren't silently truncated. The page guard is a
      // safety stop against a misbehaving cursor, not an expected limit.
      const data: RpcMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const res = await proc.sendAndWait({
          method: "model/list",
          params: { includeHidden: false, ...(cursor ? { cursor } : {}) },
        }, MODEL_DISCOVERY_TIMEOUT_MS);
        data.push(...((res.data as RpcMessage[] | undefined) ?? []));
        cursor = (res.nextCursor as string | undefined) ?? undefined;
        if (!cursor) break;
      }
      const models: ProviderModel[] = data
        .filter((m) => !m.hidden && typeof m.id === "string")
        .map((m) => {
          const efforts = ((m.supportedReasoningEfforts as RpcMessage[] | undefined) ?? [])
            .map((e) => e.reasoningEffort as string)
            .filter(Boolean)
            .map((id) => ({ id, label: REASONING_EFFORT_LABELS[id] ?? id }));
          return {
            id: m.id as string,
            label: (m.displayName as string) || (m.id as string),
            ...(m.isDefault ? { default: true } : {}),
            ...(efforts.length ? { reasoningEfforts: efforts } : {}),
            ...(m.defaultReasoningEffort
              ? { defaultReasoningEffort: m.defaultReasoningEffort as string }
              : {}),
          };
        });
      if (models.length) this.models = models;
      this.modelsLoaded = true;
    } catch {
      // Keep the static fallback list.
    } finally {
      proc.kill();
    }
  }

  async createSession(options: CreateSessionOptions): Promise<AISession> {
    const session = new CodexAppServerSession({
      systemPrompt: buildSystemPrompt(options.context),
      cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
      parentSessionId: null,
      codexExecutablePath: this.config.codexExecutablePath ?? "codex",
      model: options.model ?? this.config.model ?? DEFAULT_MODEL,
      reasoningEffort: options.reasoningEffort,
      onClosed: (s) => this.sessions.delete(s),
    });
    this.sessions.add(session);
    return session;
  }

  async forkSession(): Promise<never> {
    throw new Error(
      "Codex does not support session forking. " +
        "The endpoint layer should fall back to createSession().",
    );
  }

  async resumeSession(sessionId: string): Promise<AISession> {
    const session = new CodexAppServerSession({
      systemPrompt: null, // resumed thread already carries its context
      cwd: this.config.cwd ?? process.cwd(),
      parentSessionId: null,
      codexExecutablePath: this.config.codexExecutablePath ?? "codex",
      model: this.config.model ?? DEFAULT_MODEL,
      resumeThreadId: sessionId,
      onClosed: (s) => this.sessions.delete(s),
    });
    this.sessions.add(session);
    return session;
  }

  dispose(): void {
    for (const session of this.sessions) session.dispose();
    this.sessions.clear();
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
  systemPrompt: string | null;
  cwd: string;
  parentSessionId: string | null;
  codexExecutablePath: string;
  model: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  resumeThreadId?: string;
  onClosed: (session: CodexAppServerSession) => void;
}

class CodexAppServerSession extends BaseSession {
  private config: SessionConfig;
  private process: CodexAppServerProcess | null = null;
  private threadStarted = false;
  /**
   * The thread id used on the wire for turn/start + turn/interrupt. Usually
   * equal to the client-facing `id`, but decoupled so a resume failure can
   * fall back to a fresh thread without breaking the client's session id.
   */
  private liveThreadId: string | null = null;
  private activeTurnId: string | null = null;
  /** A turn we aborted; its still-arriving events must be ignored (it may keep
   *  flushing output on the shared thread before Codex stops it). */
  private abandonedTurnId: string | null = null;
  /** requestId → inbound JSON-RPC request id awaiting a decision. */
  private pendingApprovals = new Map<string, string | number>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: SessionConfig) {
    super({
      parentSessionId: config.parentSessionId,
      initialId: config.resumeThreadId,
    });
    this.config = config;
    if (config.resumeThreadId) this._resolvedId = config.resumeThreadId;
  }

  async *query(prompt: string): AsyncIterable<AIMessage> {
    const started = this.startQuery();
    if (!started) {
      yield BaseSession.BUSY_ERROR;
      return;
    }
    const { gen, signal } = started;
    this.clearIdleTimer();

    try {
      yield* this.runTurn(prompt, gen, signal);
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        code: "provider_error",
      };
    } finally {
      this.endQuery(gen);
      this.scheduleIdleTimer();
    }
  }

  private async *runTurn(
    prompt: string,
    gen: number,
    signal: AbortSignal,
  ): AsyncIterable<AIMessage> {
    await this.ensureThread();
    // Stopped (or superseded by a newer query) during startup — bail before
    // creating a turn so Codex doesn't run one in the background.
    if (signal.aborted) return;

    const proc = this.process;
    if (!proc || !proc.alive) {
      yield {
        type: "error",
        error:
          "Codex app-server exited during startup. Check that Codex is installed and authenticated (`codex login`).",
        code: "codex_startup_error",
      };
      return;
    }

    const effectivePrompt = buildEffectivePrompt(
      prompt,
      this.config.systemPrompt,
      this._firstQuerySent,
    );

    const queue: AIMessage[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    const push = (msg: AIMessage) => {
      queue.push(msg);
      resolve?.();
    };
    const finish = () => {
      done = true;
      resolve?.();
    };

    // Generation guard: once a newer query starts (or this one is aborted and
    // superseded), this turn's listeners must not push to its queue, end the
    // wrong turn, or mutate shared session state.
    const isCurrent = () => this._queryGen === gen;

    // Set once turn/start returns. Events that carry a different turn id —
    // e.g. a just-aborted turn still flushing output on the same thread — are
    // then ignored, so an old turn can't pollute or end this one.
    let myTurnId: string | null = null;
    const eventTurnId = (notif: { method: string; params: RpcMessage }): string | undefined =>
      notif.method === "turn/completed"
        ? ((notif.params.turn as RpcMessage | undefined)?.id as string | undefined)
        : (notif.params.turnId as string | undefined);

    const unsubEvents = proc.onEvent((notif) => {
      if (!isCurrent()) return;
      if (notif.method !== "process_exited") {
        const evTurn = eventTurnId(notif);
        // Reject an aborted turn's stragglers, or — once our turn id is known —
        // any event from a different turn.
        if (evTurn && (evTurn === this.abandonedTurnId || (myTurnId && evTurn !== myTurnId))) {
          return;
        }
      }
      for (const msg of mapCodexAppServerEvent(notif, this.id)) push(msg);
      if (notif.method === "turn/completed" || notif.method === "process_exited") {
        finish();
      }
    });
    const unsubRequests = proc.onRequest((method, id, params) => {
      // Permission-profile escalation (network/fs). Ask AI runs read-only, so
      // deny it by granting nothing — this is exactly Codex's own cancel
      // response (empty profile + turn scope), which lets the turn continue
      // sandboxed instead of failing with "Unsupported request". An interactive
      // grant card is deferred (Phase 2). Answered regardless of generation.
      if (method === PERMISSIONS_APPROVAL_METHOD) {
        proc.respond(id, { permissions: {}, scope: "turn" });
        return;
      }
      const isApproval = method === CMD_APPROVAL_METHOD || method === FILE_APPROVAL_METHOD;
      // Cancel approvals from a superseded generation or a different turn
      // (e.g. a just-aborted turn) instead of surfacing them to this UI.
      const evTurn = params.turnId as string | undefined;
      const staleTurn =
        isApproval &&
        !!evTurn &&
        (evTurn === this.abandonedTurnId || (!!myTurnId && evTurn !== myTurnId));
      if (!isCurrent() || staleTurn) {
        if (isApproval) proc.respond(id, { decision: "cancel" });
        else proc.respondError(id, `Unsupported request: ${method}`);
        return;
      }
      if (isApproval) {
        const requestId = String(id);
        this.pendingApprovals.set(requestId, id);
        push(mapApprovalRequest(method, params, requestId));
      } else {
        proc.respondError(id, `Unsupported request: ${method}`);
      }
    });

    // End the drain loop promptly on abort instead of waiting for turn/completed
    // (which may never arrive if startup was interrupted).
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort);

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      unsubEvents();
      unsubRequests();
      // Only the current turn owns the shared session state; a superseded turn
      // must not wipe the live turn's id or approvals.
      if (isCurrent()) {
        this.activeTurnId = null;
        this.pendingApprovals.clear();
      }
    };

    try {
      const res = await proc.sendAndWait({
        method: "turn/start",
        params: {
          threadId: this.liveThreadId ?? this.id,
          input: [{ type: "text", text: effectivePrompt, text_elements: [] }],
          ...(this.config.reasoningEffort && { effort: this.config.reasoningEffort }),
        },
      });
      myTurnId = ((res.turn as RpcMessage | undefined)?.id as string) ?? null;
      this.activeTurnId = myTurnId;
    } catch (err) {
      cleanup();
      yield {
        type: "error",
        error: `Codex rejected the turn: ${err instanceof Error ? err.message : String(err)}`,
        code: "codex_turn_rejected",
      };
      return;
    }
    this._firstQuerySent = true;

    // Aborted while turn/start was in flight — now that we know the turn id,
    // interrupt it and stop, instead of streaming a turn the user cancelled.
    if (signal.aborted) {
      if (myTurnId) this.abandonedTurnId = myTurnId;
      this.interruptActiveTurn();
      cleanup();
      return;
    }

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
          resolve = null;
        }
      }
    } finally {
      cleanup();
    }
  }

  /** thread/start params — OMIT approvalPolicy so Codex resolves the user's +
   *  enterprise-managed policy itself (the #971 fix); pin a read-only sandbox. */
  private threadStartParams(): RpcMessage {
    return {
      method: "thread/start",
      params: { model: this.config.model, cwd: this.config.cwd, sandbox: "read-only" },
    };
  }

  /** Ensure a live process + an active thread (start fresh or resume). */
  private async ensureThread(): Promise<void> {
    if (this.process?.alive && this.threadStarted) return;

    if (!this.process || !this.process.alive) {
      this.process = new CodexAppServerProcess();
      await this.process.start(this.config.codexExecutablePath, this.config.cwd);
      this.threadStarted = false;
    }
    if (this.threadStarted) return;

    if (this._resolvedId) {
      // Resume an existing thread (explicit resume, or after an idle restart).
      try {
        await this.process.sendAndWait({
          method: "thread/resume",
          params: { threadId: this._resolvedId },
        });
        this.liveThreadId = this._resolvedId;
      } catch {
        // The stored rollout is unavailable — start a fresh thread on the wire
        // but keep the client-facing session id stable (history is lost, but
        // the chat keeps working).
        const res = await this.process.sendAndWait(this.threadStartParams());
        this.liveThreadId =
          ((res.thread as RpcMessage | undefined)?.id as string) ?? this._resolvedId;
      }
    } else {
      const res = await this.process.sendAndWait(this.threadStartParams());
      const threadId = (res.thread as RpcMessage | undefined)?.id as string | undefined;
      if (threadId) {
        this.resolveId(threadId);
        this.liveThreadId = threadId;
      }
    }
    this.threadStarted = true;
  }

  respondToPermission(requestId: string, allow: boolean): void {
    const id = this.pendingApprovals.get(requestId);
    if (id === undefined || !this.process) return;
    this.pendingApprovals.delete(requestId);
    this.process.respond(id, { decision: allow ? "accept" : "decline" });
  }

  /** Tell Codex to interrupt the in-flight turn (no-op if none is running).
   *  turn/interrupt is a JSON-RPC *request* (not a notification), so it must
   *  carry an id — we fire it and don't await the ack. */
  private interruptActiveTurn(): void {
    const threadId = this.liveThreadId ?? this._resolvedId;
    if (this.process && this.activeTurnId && threadId) {
      this.process
        .sendAndWait({
          method: "turn/interrupt",
          params: { threadId, turnId: this.activeTurnId },
        })
        .catch(() => {});
    }
  }

  abort(): void {
    // Tear down the turn cleanly: cancel outstanding approvals so Codex doesn't
    // hang, interrupt the active turn, but keep the process alive (resumable).
    if (this.process) {
      for (const [, id] of this.pendingApprovals) {
        this.process.respond(id, { decision: "cancel" });
      }
      this.pendingApprovals.clear();
      // Remember the turn so any output it keeps flushing is ignored.
      if (this.activeTurnId) this.abandonedTurnId = this.activeTurnId;
      this.interruptActiveTurn();
    }
    super.abort();
  }

  /** Kill the process and release the session (idle timeout, evict, dispose). */
  dispose(): void {
    this.clearIdleTimer();
    this.process?.kill();
    this.process = null;
    this.threadStarted = false;
    this.pendingApprovals.clear();
    this.config.onClosed(this);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      // Kill the idle process but keep the session resumable: the next query
      // re-spawns and `thread/resume`s the persisted thread id.
      this.process?.kill();
      this.process = null;
      this.threadStarted = false;
    }, IDLE_TIMEOUT_MS);
    // Don't keep the event loop alive solely for the idle timer.
    (this.idleTimer as { unref?: () => void })?.unref?.();
  }
}

// ---------------------------------------------------------------------------
// Factory registration (same name as the old SDK provider)
// ---------------------------------------------------------------------------

registerProviderFactory(
  PROVIDER_NAME,
  async (config) => new CodexAppServerProvider(config as CodexSDKConfig),
);
