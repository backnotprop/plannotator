/**
 * Asking the agent about a guide: one ACP session per guide, kept while the
 * window is open, that answers the reader's questions one at a time.
 *
 * Which session (owner's decision, 2026-10-23): when the agent says in
 * `initialize` that it can load sessions (`agentCapabilities.loadSession`),
 * the first question loads the guide's own session (or the ask session of an
 * earlier window), so the agent remembers what it read while writing the
 * guide. When it cannot, or the load fails, a new session starts and the
 * prompt carries the guide, the selected code and the file's diff.
 *
 * The agent runs as for a guide run (agent policy, 2026-10-23): the user's
 * own config and permissions; permission requests go to the user with every
 * option, and automatic approval is opt-in. The answer arrives through the
 * `show_answer` tool on the builder's MCP relay; an agent that ends its turn
 * without it (or cannot reach MCP servers) has its last message shown as a
 * text answer.
 *
 * No `vscode` here.
 */

import type { McpServer, RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionNotification, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { isAbsolute, relative } from "node:path";
import { ACP_AUTH_REQUIRED_CODE, AcpClient, readEffortSelect, readModeSelect, readModelSelect, type AcpClientInfo, type AgentLaunch } from "@plannotator/acp-client/client";
import { loginCommands, type AgentDescriptor, type LoginCommand } from "@plannotator/acp-client/agents";
import { builderAutoAllow } from "../acp/permission-policy";
import { AUTH_TEXT, allowOption, describeTarget, type ActivityEntry, type PendingPermission, type PermissionAnswer } from "../generation";
import type { RelayHost, RelaySession } from "../mcp/relay-host";
import type { AgentChoiceRecord } from "../store";
import { SHOW_ANSWER_TOOL, SHOW_ANSWER_TOOL_NAME, checkShowAnswer, type AnswerLinkHooks } from "./answer-tool";

/** The agent process stops after this long with nothing asked. */
export const ASK_IDLE_MS = 10 * 60 * 1000;
const MAX_ACTIVITY = 200;
const SHOW_ANSWER_TITLE = /(?:^|[_.:/ ])show_answer$/;

export type AskRunStatus = "starting" | "working" | "answered" | "text" | "stopped" | "failed";

export interface AskRunState {
  answerId: string;
  status: AskRunStatus;
  statusMessage?: string;
  startedAt: number;
  endedAt?: number;
  activity: ActivityEntry[];
  /** What the agent is writing now (its current message), shown in grey while it works. */
  stream: string;
  pendingPermissions: PendingPermission[];
  autoApprove: boolean;
  offerAutoApprove: boolean;
  permissiveMode?: string;
  /** What this question cost (the agent's session total, less what it had cost before). */
  cost?: { amount: number; currency: string };
  /** Whether the guide's own session (or an earlier ask session) answered, or a new one. */
  session?: "loaded" | "fresh";
  answer?: { title: string; html: string };
  /** The agent's last message, when it answered without `show_answer`. */
  text?: string;
  appliedModel?: string;
  appliedEffort?: string;
  signIn?: { logins: LoginCommand[] };
}

/** A session the ask session may load, with what it holds. */
export interface SavedSession {
  id: string;
  /** `guide`: the session that wrote the guide; `asks`: an ask session of an earlier window. */
  from: "guide" | "asks";
}

export interface AskSessionDeps {
  relay: RelayHost;
  agent: AgentDescriptor;
  agentLaunch(cwd: string): AgentLaunch;
  mcpServer: { command: string; args: string[]; env?: Record<string, string> };
  clientInfo: AcpClientInfo;
  linkHooks: AnswerLinkHooks;
  requestPermission?(pending: PendingPermission, signal: AbortSignal): Promise<PermissionAnswer | null>;
  approveAlways?(): void;
  log?(line: string): void;
  now?(): number;
  idleMs?: number;
}

export interface AskSessionInput {
  guideId: string;
  /** Where the agent runs: the guide's head (the repository, or the PR worktree). */
  cwd: string;
  /** Sessions to try loading, in order (the guide's ask session, then the guide's own). */
  saved: SavedSession[];
}

export interface AskQuestion {
  answerId: string;
  agent: AgentChoiceRecord;
  autoApprove: boolean;
  /** The prompt for the session the question lands in. */
  prompt(mode: { session: "loaded" | "fresh"; loadedFrom?: SavedSession["from"]; firstInSession: boolean }): string;
}

/**
 * Which saved sessions to try loading, in order: none when the agent cannot
 * load sessions (it said so in `initialize`), else every saved session, the
 * ask session of an earlier window first.
 */
export function sessionsToLoad(capabilities: { loadSession?: boolean | null } | null | undefined, saved: readonly SavedSession[]): SavedSession[] {
  if (capabilities?.loadSession !== true) return [];
  const seen = new Set<string>();
  return [...saved.filter((s) => s.from === "asks"), ...saved.filter((s) => s.from === "guide")].filter((s) => !!s.id && !seen.has(s.id) && !!seen.add(s.id));
}

/** One question being answered. */
export class AskRun {
  readonly state: AskRunState;
  private readonly listeners = new Set<(s: AskRunState) => void>();
  private nextActivity = 1;
  private nextPermission = 1;
  readonly toolEntries = new Map<string, ActivityEntry>();
  readonly toolKinds = new Map<string, ToolKind>();
  readonly toolTitles = new Map<string, string>();
  readonly permissionWaiters = new Map<number, { request: RequestPermissionRequest; resolve: (r: RequestPermissionResponse) => void }>();
  messageEntry: ActivityEntry | null = null;
  /** The last thing the agent wrote that is not followed by a tool call. */
  lastMessage = "";
  cancelled = false;
  costBaseline: number | null = null;
  readonly done: Promise<AskRunState>;
  resolveDone!: (s: AskRunState) => void;

  constructor(answerId: string, autoApprove: boolean, private readonly now: () => number, private readonly session: GuideAskSession) {
    this.state = { answerId, status: "starting", startedAt: now(), activity: [], stream: "", pendingPermissions: [], autoApprove, offerAutoApprove: false };
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  onChange(listener: (s: AskRunState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const l of this.listeners) l(this.state);
  }

  addActivity(entry: Omit<ActivityEntry, "id" | "at">): ActivityEntry {
    const full: ActivityEntry = { id: this.nextActivity++, at: this.now() - this.state.startedAt, ...entry };
    this.state.activity.push(full);
    if (this.state.activity.length > MAX_ACTIVITY) this.state.activity.splice(0, this.state.activity.length - MAX_ACTIVITY);
    return full;
  }

  get live(): boolean {
    return this.state.status === "starting" || this.state.status === "working";
  }

  nextPermissionId(): number {
    return this.nextPermission++;
  }

  /** Stop answering: `session/cancel`; the agent process stays for the next question. */
  cancel(): Promise<void> {
    return this.session.cancelRun(this);
  }

  answerPermission(id: number, answer: PermissionAnswer): void {
    this.session.answerPermission(this, id, answer);
  }

  approveAutomatically(): void {
    this.session.approveAutomatically(this);
  }

  settlePermission(id: number, response: RequestPermissionResponse): void {
    const waiter = this.permissionWaiters.get(id);
    if (!waiter) return;
    this.permissionWaiters.delete(id);
    this.state.pendingPermissions = this.state.pendingPermissions.filter((p) => p.id !== id);
    waiter.resolve(response);
  }
}

export class GuideAskSession {
  private client: AcpClient | null = null;
  private sessionId: string | null = null;
  private relaySession: RelaySession | null = null;
  private mode: "loaded" | "fresh" | null = null;
  private loadedFrom: SavedSession["from"] | undefined;
  private questions = 0;
  private run: AskRun | null = null;
  private replaying = false;
  private sessionCost: number | null = null;
  private latestOptions: readonly SessionConfigOption[] = [];
  private sessionModes: { currentModeId: string; availableModes: Array<{ id: string }> } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(
    readonly input: AskSessionInput,
    private readonly deps: AskSessionDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** The ACP session answering this guide's questions (saved, so a later window can load it). */
  get askSessionId(): string | null {
    return this.sessionId;
  }

  get sessionMode(): "loaded" | "fresh" | null {
    return this.mode;
  }

  get current(): AskRun | null {
    return this.run && this.run.live ? this.run : null;
  }

  get agentId(): string {
    return this.deps.agent.id;
  }

  /** Whether the agent process is running (between questions it stays up until the idle timeout). */
  get isAlive(): boolean {
    return !!this.client && !this.client.hasExited;
  }

  /** Ask a question. One at a time: a second one while the first is answering throws. */
  ask(question: AskQuestion): AskRun {
    if (this.disposed) throw new Error("This ask session was closed.");
    if (this.current) throw new Error("Another question is being answered.");
    this.clearIdle();
    const run = new AskRun(question.answerId, question.autoApprove, this.now, this);
    this.run = run;
    void this.runQuestion(run, question).finally(() => {
      run.resolveDone(run.state);
      this.armIdle();
    });
    return run;
  }

  private async runQuestion(run: AskRun, question: AskQuestion): Promise<void> {
    try {
      run.emit();
      await this.ensureSession(run);
      if (run.cancelled) return this.end(run, "stopped", "Stopped.");
      run.state.session = this.mode ?? "fresh";
      await this.applyChoices(question.agent);
      if (run.state.autoApprove) await this.enterPermissiveMode(run);
      if (run.cancelled) return this.end(run, "stopped", "Stopped.");
      run.state.status = "working";
      run.addActivity({ kind: "info", title: "Thinking about the question" });
      run.emit();
      run.costBaseline = this.sessionCost;
      const prompt = question.prompt({ session: this.mode ?? "fresh", ...(this.loadedFrom && { loadedFrom: this.loadedFrom }), firstInSession: this.questions === 0 });
      this.questions++;
      const response = await this.client!.prompt(this.sessionId!, prompt);
      if (run.state.answer) return this.end(run, "answered");
      if (run.cancelled || response.stopReason === "cancelled") {
        if (run.lastMessage.trim() || run.state.stream.trim()) run.state.text = (run.lastMessage || run.state.stream).trim();
        return this.end(run, "stopped", "Stopped before the answer was shown.");
      }
      const text = run.lastMessage.trim();
      if (text) {
        run.state.text = text;
        return this.end(run, "text", `${this.deps.agent.label} answered in text (it did not call show_answer).`);
      }
      return this.end(run, "failed", response.stopReason === "end_turn" ? `${this.deps.agent.label} ended its turn without an answer.` : `${this.deps.agent.label} stopped (${response.stopReason}).`);
    } catch (err) {
      if (run.state.answer) return this.end(run, "answered");
      if (run.cancelled) return this.end(run, "stopped", "Stopped.");
      const message = this.client ? await this.client.describeFailure(err) : err instanceof Error ? err.message : String(err);
      const needsSignIn = (err as { code?: unknown } | null)?.code === ACP_AUTH_REQUIRED_CODE || AUTH_TEXT.test(message);
      if (needsSignIn) run.state.signIn = { logins: loginCommands(this.client?.authMethods) };
      // The session may be broken: the next question starts the agent again.
      this.stopAgent();
      this.end(run, "failed", needsSignIn ? `${this.deps.agent.label} is not signed in. Sign in, then ask again.\n${message}` : message);
    }
  }

  private end(run: AskRun, status: AskRunStatus, message?: string): void {
    run.state.status = status;
    if (message) run.state.statusMessage = message;
    run.state.endedAt = this.now();
    for (const [id] of [...run.permissionWaiters]) run.settlePermission(id, { outcome: { outcome: "cancelled" } });
    run.state.pendingPermissions = [];
    if (status !== "answered") run.addActivity({ kind: status === "failed" ? "error" : "info", title: message ?? status, ...(status === "failed" && { isError: true }) });
    run.emit();
  }

  /** Start the agent and open the session: load a saved one when the agent can, else a new one. */
  private async ensureSession(run: AskRun): Promise<void> {
    if (this.client && !this.client.hasExited && this.sessionId) {
      run.addActivity({ kind: "info", title: "Same conversation as the last question" });
      return;
    }
    this.stopAgent();
    this.relaySession = this.deps.relay.openSession({
      instructions: "The Plannotator VS Code extension's answer page: call show_answer with your whole answer as one HTML page, then end your turn.",
      listTools: () => [SHOW_ANSWER_TOOL],
      callTool: (name, args) => this.callTool(name, args),
    });
    const mcpServer: McpServer = {
      name: "plannotator-guide",
      command: this.deps.mcpServer.command,
      args: this.deps.mcpServer.args,
      env: Object.entries({ ...this.deps.mcpServer.env, ...this.relaySession.env }).map(([name, value]) => ({ name, value })),
    };
    run.addActivity({ kind: "info", title: `Starting ${this.deps.agent.label}`, detail: run.state.autoApprove ? "Its permission requests are approved automatically (you opted in)." : "With your own settings: you approve what it asks about." });
    run.emit();
    this.client = await AcpClient.start(this.deps.agentLaunch(this.input.cwd), {
      onUpdate: (n) => this.onUpdate(n),
      requestPermission: (req, signal) => this.onPermission(req, signal),
      onStderr: (text) => this.deps.log?.(`[agent] ${text.trimEnd()}`),
    }, this.deps.clientInfo);
    this.questions = 0;
    for (const saved of sessionsToLoad(this.client.agentCapabilities, this.input.saved)) {
      try {
        this.replaying = true;
        const loaded = await this.client.loadSession(saved.id, this.input.cwd, [mcpServer]);
        this.sessionId = saved.id;
        this.mode = "loaded";
        this.loadedFrom = saved.from;
        this.latestOptions = loaded.configOptions ?? [];
        this.sessionModes = loaded.modes ?? null;
        run.addActivity({ kind: "info", title: saved.from === "guide" ? "Picked up the session that wrote this guide" : "Picked up the earlier conversation about this guide" });
        return;
      } catch (err) {
        this.deps.log?.(`[guides] session/load ${saved.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (this.client.hasExited) throw err;
      } finally {
        this.replaying = false;
      }
    }
    const session = await this.client.newSession(this.input.cwd, [mcpServer]);
    this.sessionId = session.sessionId;
    this.mode = "fresh";
    this.loadedFrom = undefined;
    this.latestOptions = session.configOptions ?? [];
    this.sessionModes = session.modes ?? null;
    run.addActivity({ kind: "info", title: "Started a new session with the guide and the code" });
  }

  /** Apply the model and effort for this question (the guide's, or what the reader picked). */
  private async applyChoices(agent: AgentChoiceRecord): Promise<void> {
    const client = this.client!;
    const sessionId = this.sessionId!;
    const run = this.run!;
    let options = this.latestOptions;
    try {
      const model = readModelSelect(options);
      if (model && agent.model?.id && model.current !== agent.model.id && model.options.some((o) => o.value === agent.model!.id)) options = await client.setConfigOption(sessionId, model.configId, agent.model.id);
      const effort = readEffortSelect(options);
      if (effort && agent.effort?.id && effort.current !== agent.effort.id && effort.options.some((o) => o.value === agent.effort!.id)) options = await client.setConfigOption(sessionId, effort.configId, agent.effort.id);
    } catch (err) {
      run.addActivity({ kind: "info", title: `Kept the agent's model and effort: ${err instanceof Error ? err.message : String(err)}` });
    }
    this.latestOptions = options;
    const m = readModelSelect(options);
    const e = readEffortSelect(options);
    if (m) run.state.appliedModel = m.options.find((o) => o.value === m.current)?.name ?? m.current;
    if (e) run.state.appliedEffort = e.options.find((o) => o.value === e.current)?.name ?? e.current;
  }

  /** Only when the reader opted in to automatic approval: the agent's own permissive mode, where it has one. */
  private async enterPermissiveMode(run: AskRun): Promise<void> {
    const wanted = this.deps.agent.permissiveModes ?? [];
    const client = this.client;
    const sessionId = this.sessionId;
    if (!wanted.length || !client || !sessionId) return;
    const select = readModeSelect(this.latestOptions);
    const current = select?.current ?? this.sessionModes?.currentModeId;
    if (current && wanted.includes(current)) {
      run.state.permissiveMode = current;
      return;
    }
    const viaConfig = select ? wanted.find((id) => select.options.some((o) => o.value === id)) : undefined;
    const viaModes = !viaConfig && this.sessionModes ? wanted.find((id) => this.sessionModes!.availableModes.some((m) => m.id === id)) : undefined;
    try {
      if (select && viaConfig) {
        this.latestOptions = await client.setConfigOption(sessionId, select.configId, viaConfig);
        run.state.permissiveMode = viaConfig;
      } else if (viaModes) {
        await client.setMode(sessionId, viaModes);
        run.state.permissiveMode = viaModes;
      }
      if (run.state.permissiveMode) run.addActivity({ kind: "info", title: `Switched ${this.deps.agent.label} to ${run.state.permissiveMode} for automatic approval` });
    } catch (err) {
      run.addActivity({ kind: "info", title: `${this.deps.agent.label} stayed in its own mode: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // ---------------------------------------------------------------------------
  // show_answer (from the relay)
  // ---------------------------------------------------------------------------

  private async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    if (name !== SHOW_ANSWER_TOOL_NAME) return { text: `Unknown tool ${name}.`, isError: true };
    const run = this.run;
    if (!run || !run.live) return { text: "No question is open: nothing to answer. End your turn.", isError: true };
    const check = await checkShowAnswer(args, this.deps.linkHooks);
    if (!check.ok) {
      run.addActivity({ kind: "builder", title: SHOW_ANSWER_TOOL_NAME, detail: check.text.split("\n").slice(1).join(" ").slice(0, 300), status: "failed", isError: true });
      run.emit();
      return { text: check.text, isError: true };
    }
    run.state.answer = { title: check.title, html: check.html };
    run.addActivity({ kind: "builder", title: SHOW_ANSWER_TOOL_NAME, detail: `shown · ${check.title}`, status: "completed" });
    run.emit();
    return { text: check.text, isError: false };
  }

  // ---------------------------------------------------------------------------
  // ACP updates
  // ---------------------------------------------------------------------------

  private onUpdate(notification: SessionNotification): void {
    const u = notification.update;
    if (u.sessionUpdate === "usage_update") {
      if (u.cost && typeof u.cost.amount === "number") {
        this.sessionCost = u.cost.amount;
        const run = this.run;
        if (run && run.live && !this.replaying) {
          // Adapters report the session's running total; one that reports less than before counts per turn.
          if (run.costBaseline !== null && u.cost.amount < run.costBaseline) run.costBaseline = 0;
          const base = run.costBaseline;
          const amount = base !== null ? u.cost.amount - base : u.cost.amount;
          run.state.cost = { amount, currency: u.cost.currency ?? "USD" };
          run.emit();
        }
      }
      return;
    }
    if (u.sessionUpdate === "config_option_update") {
      this.latestOptions = u.configOptions;
      return;
    }
    if (u.sessionUpdate === "current_mode_update") {
      if (this.sessionModes) this.sessionModes = { ...this.sessionModes, currentModeId: u.currentModeId };
      return;
    }
    // A loaded session replays its conversation first: none of it is this question.
    if (this.replaying) return;
    const run = this.run;
    if (!run || !run.live) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        if (u.content.type !== "text") return;
        if (!run.messageEntry) {
          run.messageEntry = run.addActivity({ kind: "message", title: "" });
          run.lastMessage = "";
          run.state.stream = "";
        }
        run.messageEntry.title += u.content.text;
        run.lastMessage += u.content.text;
        run.state.stream = run.lastMessage;
        break;
      }
      case "tool_call": {
        run.messageEntry = null;
        if (u.kind) run.toolKinds.set(u.toolCallId, u.kind);
        if (u.title) run.toolTitles.set(u.toolCallId, u.title);
        if (SHOW_ANSWER_TITLE.test(u.title ?? "")) {
          // Shown from the tool's side, with whether it was accepted.
          run.toolEntries.set(u.toolCallId, run.addActivity({ kind: "tool", title: "Drawing the answer", status: u.status ?? "in_progress" }));
          break;
        }
        run.toolEntries.set(u.toolCallId, run.addActivity({
          kind: "tool",
          title: u.title || "Tool call",
          status: u.status ?? "pending",
          ...(u.locations?.length && { locations: this.relLocations(u.locations) }),
        }));
        break;
      }
      case "tool_call_update": {
        if (u.kind) run.toolKinds.set(u.toolCallId, u.kind);
        if (u.title) run.toolTitles.set(u.toolCallId, u.title);
        const entry = run.toolEntries.get(u.toolCallId);
        if (!entry) return;
        if (u.title && !SHOW_ANSWER_TITLE.test(u.title) && entry.title !== "Drawing the answer") entry.title = u.title;
        if (u.status) entry.status = u.status;
        if (u.locations?.length) entry.locations = this.relLocations(u.locations);
        if (u.status === "failed") entry.isError = true;
        break;
      }
      case "plan": {
        run.messageEntry = null;
        const done = u.entries.filter((e) => e.status === "completed").length;
        run.addActivity({ kind: "plan", title: `Plan · ${done} of ${u.entries.length} done` });
        break;
      }
      default:
        return;
    }
    run.emit();
  }

  private relLocations(locations: ToolCallLocation[]): Array<{ path: string; line?: number }> {
    return locations.map((l) => {
      const rel = relative(this.input.cwd, l.path);
      const path = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : l.path;
      return { path, ...(typeof l.line === "number" && { line: l.line }) };
    });
  }

  // ---------------------------------------------------------------------------
  // Permissions: as in a guide run
  // ---------------------------------------------------------------------------

  private async onPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const own = builderAutoAllow(request);
    if (own) return { outcome: { outcome: "selected", optionId: own } };
    const run = this.run;
    if (!run || !run.live) return { outcome: { outcome: "cancelled" } };
    const title = request.toolCall.title ?? run.toolTitles.get(request.toolCall.toolCallId) ?? "a tool";
    if (run.state.autoApprove) {
      const allow = allowOption(request);
      if (allow) {
        run.addActivity({ kind: "permission", title: `Approved automatically: ${title}`, detail: allow.name, status: "completed" });
        run.emit();
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
    }
    const id = run.nextPermissionId();
    const kind = request.toolCall.kind ?? run.toolKinds.get(request.toolCall.toolCallId);
    const target = describeTarget(request);
    const pending: PendingPermission = {
      id,
      title,
      ...(kind && { kind }),
      ...(target && { target }),
      options: request.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    };
    const entry = run.addActivity({ kind: "permission", title: `Waiting for your approval: ${title}`, ...(target && { detail: target }), status: "pending" });
    run.state.pendingPermissions.push(pending);
    if (!run.state.autoApprove) run.state.offerAutoApprove = true;
    run.emit();
    const answer = await new Promise<RequestPermissionResponse>((resolve) => {
      run.permissionWaiters.set(id, { request, resolve });
      signal.addEventListener("abort", () => run.settlePermission(id, { outcome: { outcome: "cancelled" } }), { once: true });
      void this.deps.requestPermission?.(pending, signal).then((a) => {
        if (a) this.answerPermission(run, id, a);
      }, () => {});
    });
    const chosen = answer.outcome.outcome === "selected" ? request.options.find((o) => o.optionId === (answer.outcome as { optionId: string }).optionId) : undefined;
    const allowed = !!chosen && chosen.kind.startsWith("allow");
    entry.title = `${allowed ? "Allowed" : chosen ? "Turned down" : "Not answered"}: ${title}`;
    entry.status = allowed ? "completed" : "failed";
    entry.detail = chosen ? chosen.name : "Cancelled";
    run.emit();
    return answer;
  }

  answerPermission(run: AskRun, id: number, answer: PermissionAnswer): void {
    if ("approve" in answer) {
      if (answer.approve === "always") this.deps.approveAlways?.();
      if (run.live) this.approveAutomatically(run);
      return;
    }
    const waiter = run.permissionWaiters.get(id);
    if (!waiter || !waiter.request.options.some((o) => o.optionId === answer.optionId)) return;
    run.settlePermission(id, { outcome: { outcome: "selected", optionId: answer.optionId } });
  }

  approveAutomatically(run: AskRun): void {
    if (!run.state.autoApprove) {
      run.state.autoApprove = true;
      run.state.offerAutoApprove = false;
      run.addActivity({ kind: "info", title: "Approving the agent's requests automatically for the rest of this question" });
      void this.enterPermissiveMode(run).then(() => run.emit(), () => {});
    }
    for (const [id, waiter] of [...run.permissionWaiters]) {
      const allow = allowOption(waiter.request);
      if (allow) run.settlePermission(id, { outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    run.emit();
  }

  // ---------------------------------------------------------------------------
  // Stopping
  // ---------------------------------------------------------------------------

  async cancelRun(run: AskRun): Promise<void> {
    if (!run.live || run.cancelled) return;
    run.cancelled = true;
    for (const [id] of [...run.permissionWaiters]) run.settlePermission(id, { outcome: { outcome: "cancelled" } });
    const client = this.client;
    if (!client || !this.sessionId) return;
    await client.cancel(this.sessionId);
    const ended = await Promise.race([run.done.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    // An agent that does not end its turn is stopped; the next question starts it again.
    if (!ended) this.stopAgent();
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.disposed || !this.client) return;
    this.idleTimer = setTimeout(() => this.stopAgent(), this.deps.idleMs ?? ASK_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Stop the agent process; the session id is kept so the next question can load it. */
  private stopAgent(): void {
    this.clearIdle();
    this.relaySession?.dispose();
    this.relaySession = null;
    this.client?.dispose();
    this.client = null;
    if (this.sessionId) {
      // A later question loads this session when the agent can (it holds the conversation so far).
      this.input.saved = [{ id: this.sessionId, from: this.loadedFrom === "guide" ? "guide" : "asks" }, ...this.input.saved.filter((s) => s.id !== this.sessionId)];
    }
    this.sessionId = null;
    this.mode = null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.run?.live) void this.run.cancel();
    this.stopAgent();
  }

  /** VS Code is closing: stop the agent and everything it started at once. */
  kill(): void {
    this.disposed = true;
    this.clearIdle();
    this.client?.kill();
    this.relaySession?.dispose();
  }
}
