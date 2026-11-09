/**
 * One guide run: the agent over ACP, the builder draft behind the MCP relay,
 * and the state the generating view draws (SPEC 3.3, 4.1 to 4.4).
 *
 * No `vscode` here: the VS Code layer passes in how to ask for a permission,
 * how to resolve a symbol and how to render-check Mermaid, and draws `state`.
 * The draft is written to disk after every builder call, so a stopped run can
 * be resumed or saved as is; with guide history off (`PLANNOTATOR_GUIDE_HISTORY=0`
 * or `{ "guideHistory": false }`) nothing is written and the guide lives in
 * memory for this VS Code session only.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { McpServer, NewSessionResponse, RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionNotification, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import {
  GUIDE_BUILDER_TOOLS,
  GUIDE_BUILDER_TOOL_NAMES,
  createGuideDraft,
  guideDraftProgress,
  guideSaveAsIs,
  runGuideBuilderTool,
  type GuideBuilderHooks,
  type GuideDraft,
  type GuideDraftProgress,
  type GuideFocusRange,
  type GuideSymbolResolution,
} from "./core/adapter";
import type { GuideLaunchReview, GuideSnapshot } from "@plannotator/core/guide-format";
import { ACP_AUTH_REQUIRED_CODE, AcpClient, readEffortSelect, readModeSelect, readModelSelect, type AcpClientInfo, type AgentLaunch } from "@plannotator/acp-client/client";
import { loginCommands, type AgentDescriptor, type LoginCommand } from "@plannotator/acp-client/agents";
import { builderAutoAllow } from "./acp/permission-policy";
import type { RelayHost, RelaySession } from "./mcp/relay-host";
import type { ChangedFileInfo } from "./sources/git";
import { buildGuidePrompt } from "./prompt";
import { realFileInside } from "./safe-path";
import {
  buildFinishedGuide,
  deleteDraftRecord,
  newDraftId,
  saveDraftRecord,
  saveFinishedGuide,
  type LoadedGuide,
  snapshotSource,
  sourceGitRef,
  type AgentChoiceRecord,
  type DraftRecord,
  type ReviewSourceRecord,
} from "./store";

export type GenerationStatus = "starting" | "running" | "finishing" | "finished" | "stopped" | "failed";

export interface ActivityEntry {
  id: number;
  /** Milliseconds since the run started. */
  at: number;
  kind: "message" | "tool" | "builder" | "plan" | "permission" | "info" | "error";
  title: string;
  detail?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  /** For tool calls: the files it touched, relative to the head root when inside it. */
  locations?: Array<{ path: string; line?: number }>;
  isError?: boolean;
}

/** A permission request the agent is waiting on, shown in the run view with the agent's own options. */
export interface PendingPermission {
  id: number;
  title: string;
  kind?: string;
  /** What it acts on: the files or the command, when the agent says. */
  target?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

/** The user's answer to a pending permission: one of the agent's options, or approve this and the rest automatically. */
export type PermissionAnswer = { optionId: string } | { approve: "run" | "always" };

/**
 * Something in the agent's setup that holds the run back (a request turned
 * down, a tool its settings or sandbox blocked, the guide's tools never
 * reached). Shown in the run view; the run goes on.
 */
export interface Bottleneck {
  key: string;
  title: string;
  detail?: string;
  /** One click that helps: approve automatically for the rest of this run, or resume the run with it on. */
  action?: "approveRun" | "resumeWithApproval";
}

export interface ChapterMark {
  /** Recently added chapters and the files that moved, for the draft panel's tags. */
  added: string[];
  moved: Record<string, number>;
}

export interface GenerationState {
  id: string;
  repoKey: string;
  status: GenerationStatus;
  statusMessage?: string;
  startedAt: number;
  endedAt?: number;
  source: ReviewSourceRecord;
  agent: AgentChoiceRecord;
  instructions?: string;
  cost?: { amount: number; currency: string };
  activity: ActivityEntry[];
  draft: GuideDraft;
  progress: GuideDraftProgress;
  marks: ChapterMark;
  savedGuideId?: string;
  acpSessionId?: string;
  /** Model and effort the agent reports after our choice was applied. */
  appliedModel?: string;
  appliedEffort?: string;
  /** The run failed because the agent is not signed in; these are its own login commands. */
  signIn?: { logins: LoginCommand[] };
  /** Guide history is off: nothing of this run is written to disk. */
  memoryOnly?: boolean;
  /** The overview diagram was saved without a render check (no Guides webview could run one). */
  diagramUnchecked?: boolean;
  /** Permission requests waiting on the user. */
  pendingPermissions: PendingPermission[];
  /** The user opted in to answering the agent's permission requests automatically for this run. */
  autoApprove: boolean;
  /** Offer automatic approval inline: set at the first request the user is asked about while it is off. */
  offerAutoApprove: boolean;
  /** The agent's own permissive mode Guides switched to because the user opted in to automatic approval. */
  permissiveMode?: string;
  bottlenecks: Bottleneck[];
}

export interface GenerationDeps {
  relay: RelayHost;
  /** The agent: its engine name, and its permissive modes for automatic approval. */
  agent: AgentDescriptor;
  /** The agent adapter to start in `cwd`. */
  agentLaunch(cwd: string): AgentLaunch;
  /** How the agent starts the relay script (`dist/guide-mcp.cjs`); the session env is added. */
  mcpServer: { command: string; args: string[]; env?: Record<string, string> };
  clientInfo: AcpClientInfo;
  /**
   * Tell the user about a pending permission outside the run view (a
   * notification), resolving with their answer, or null when they dismissed
   * it. The run view shows it too; whichever answers first wins.
   */
  requestPermission?(pending: PendingPermission, signal: AbortSignal): Promise<PermissionAnswer | null>;
  /** The user chose "Always approve during guides": turn the setting on. */
  approveAlways?(): void;
  resolveSymbol(name: string, path: string | undefined, files: readonly ChangedFileInfo[], headRoot: string): Promise<GuideSymbolResolution>;
  /** Render-check Mermaid with the Guide tab's engine; `checked: false` when no webview could do it. */
  checkMermaid(source: string): Promise<{ ok: true; checked: boolean } | { ok: false; message: string; line?: number }>;
  log?(line: string): void;
  now?(): number;
  /** Guide history (default on). Off: no draft or guide is written; the guide is kept in memory. */
  history?: boolean;
}

export interface GenerationInput {
  repoKey: string;
  source: ReviewSourceRecord;
  rawPatch: string;
  files: ChangedFileInfo[];
  agent: AgentChoiceRecord;
  instructions?: string;
  /** Continue a stopped draft: same id, its draft, a "continue" prompt. */
  resume?: DraftRecord;
  /** The user opted in to automatic approval (the setting, or the choice in the start flow). Off: the user's own config decides. */
  autoApprove?: boolean;
}

const MAX_ACTIVITY = 400;
const BUILDER_TITLE = /guide_(set_header|set_overview|add_chapter|update_chapter|move_chapter|remove_chapter|place_file|move_file|unplace_file|read|finish)(?![a-z_])/;

/**
 * The builder's `resolveFile` hook: whether a `code:` link's file is at the
 * head and how many lines it has. Read only when it is a regular file inside
 * the head once symlinks are followed; a symlink out of the repository reads
 * as not there.
 */
export async function resolveHeadFile(headRoot: string, path: string): Promise<{ exists: false } | { exists: true; lineCount: number }> {
  const real = realFileInside(headRoot, path);
  if (!real) return { exists: false };
  try {
    const text = await readFile(real, "utf8");
    return { exists: true, lineCount: text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
  } catch {
    return { exists: false };
  }
}

export class GuideGeneration {
  readonly state: GenerationState;
  private readonly listeners = new Set<(state: GenerationState) => void>();
  private client: AcpClient | null = null;
  private relaySession: RelaySession | null = null;
  private cancelled = false;
  private nextActivity = 1;
  private readonly toolEntries = new Map<string, ActivityEntry>();
  /** The kind the agent reported for each tool call, for permission requests that leave it out. */
  private readonly toolKinds = new Map<string, ToolKind>();
  private readonly toolTitles = new Map<string, string>();
  private nextPermission = 1;
  private readonly permissionWaiters = new Map<number, { request: RequestPermissionRequest; resolve: (r: RequestPermissionResponse) => void }>();
  /**
   * Requests the user turned down this run, for the end-of-run advice.
   * Tools the agent's own settings blocked are not counted: automatic
   * approval does not lift a deny rule, so resuming with it would not help.
   */
  private turnedDown = 0;
  private readonly blockedTools = new Map<string, string[]>();
  /** Whether the agent ever reached the builder's MCP server (an agent that drops the client's MCP servers never does). */
  private builderReached = false;
  private messageEntry: ActivityEntry | null = null;
  private builderQueue: Promise<unknown> = Promise.resolve();
  private readonly hooks: GuideBuilderHooks;
  private readonly now: () => number;
  private readonly history: boolean;
  /** Render-check results per Mermaid source: "ok", or "unchecked" when no webview could run it. */
  private readonly diagramChecks = new Map<string, "ok" | "unchecked">();
  /** With history off, the finished guide (nothing on disk). */
  memoryGuide: LoadedGuide | null = null;

  constructor(
    private readonly input: GenerationInput,
    private readonly deps: GenerationDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.history = deps.history !== false;
    const draft = input.resume?.draft ?? createGuideDraft({
      review: launchReview(input),
      generator: {
        engine: deps.agent.engine,
        ...(input.agent.model && { model: input.agent.model.id }),
        ...(input.instructions && { customInstructions: input.instructions }),
      },
      now: new Date(this.now()).toISOString(),
    });
    const id = input.resume?.id ?? newDraftId(this.now());
    this.hooks = this.makeHooks();
    this.state = {
      id,
      repoKey: input.repoKey,
      status: "starting",
      startedAt: this.now(),
      source: input.source,
      agent: input.agent,
      ...(input.instructions && { instructions: input.instructions }),
      ...(input.resume?.cost && { cost: input.resume.cost }),
      activity: [],
      draft,
      progress: guideDraftProgress(draft),
      marks: { added: [], moved: {} },
      ...(!this.history && { memoryOnly: true }),
      pendingPermissions: [],
      autoApprove: !!input.autoApprove,
      offerAutoApprove: false,
      bottlenecks: [],
    };
  }

  onChange(listener: (state: GenerationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.state.progress = guideDraftProgress(this.state.draft);
    for (const l of this.listeners) l(this.state);
  }

  private makeHooks(): GuideBuilderHooks {
    const { files, source } = this.input;
    const headRoot = source.headRoot;
    return {
      resolveFile: ({ path }) => resolveHeadFile(headRoot, path),
      resolveSymbol: ({ name, path }) => this.deps.resolveSymbol(name, path, files, headRoot),
      checkMermaid: async (src) => {
        const r = await this.deps.checkMermaid(src);
        if (r.ok) this.diagramChecks.set(src, r.checked ? "ok" : "unchecked");
        return r.ok ? { ok: true } : { ok: false, error: `${r.line ? `Line ${r.line}: ` : ""}${r.message}` };
      },
      now: () => new Date(this.now()).toISOString(),
    };
  }

  private addActivity(entry: Omit<ActivityEntry, "id" | "at">): ActivityEntry {
    const full: ActivityEntry = { id: this.nextActivity++, at: this.now() - this.state.startedAt, ...entry };
    this.state.activity.push(full);
    if (this.state.activity.length > MAX_ACTIVITY) this.state.activity.splice(0, this.state.activity.length - MAX_ACTIVITY);
    return full;
  }

  /** The run as a draft record (what is written to disk after every builder call). */
  toDraftRecord(): DraftRecord {
    return {
      v: 1,
      id: this.state.id,
      repoKey: this.state.repoKey,
      createdAt: this.input.resume?.createdAt ?? this.state.startedAt,
      updatedAt: this.now(),
      status: this.state.status === "stopped" || this.state.status === "failed" ? this.state.status : "running",
      ...(this.state.statusMessage && { statusMessage: this.state.statusMessage }),
      source: this.state.source,
      agent: this.state.agent,
      ...(this.state.instructions && { instructions: this.state.instructions }),
      draft: this.state.draft,
      ...(this.state.acpSessionId && { acpSessionId: this.state.acpSessionId }),
      ...(this.state.cost && { cost: this.state.cost }),
    };
  }

  private persist(): void {
    if (this.state.status === "finished" || !this.history) return;
    const record = this.toDraftRecord();
    try {
      saveDraftRecord(record);
    } catch (err) {
      this.deps.log?.(`[guides] could not save the draft: ${err}`);
    }
  }

  /** Run the agent until it finishes, stops, fails or is cancelled. Never throws. */
  async run(): Promise<void> {
    const { source } = this.input;
    try {
      const agent = this.deps.agent;
      this.persist();
      this.relaySession = this.deps.relay.openSession({
        listTools: () => {
          this.builderReached = true;
          return GUIDE_BUILDER_TOOLS;
        },
        callTool: (name, args) => {
          this.builderReached = true;
          return this.callBuilder(name, args);
        },
      });
      const mcpServer: McpServer = {
        name: "plannotator-guide",
        command: this.deps.mcpServer.command,
        args: this.deps.mcpServer.args,
        env: Object.entries({ ...this.deps.mcpServer.env, ...this.relaySession.env }).map(([name, value]) => ({ name, value })),
      };
      this.addActivity({
        kind: "info",
        title: `Starting ${this.input.agent.label}`,
        detail: this.state.autoApprove ? "Its permission requests are approved automatically (you opted in)." : "With your own settings: you approve what it asks about.",
      });
      this.emit();
      this.client = await AcpClient.start(this.deps.agentLaunch(source.headRoot), {
        onUpdate: (n) => this.onUpdate(n),
        requestPermission: (req, signal) => this.onPermission(req, signal),
        onStderr: (text) => this.deps.log?.(`[agent] ${text.trimEnd()}`),
      }, this.deps.clientInfo);
      if (this.cancelled) return this.stop("Cancelled before the agent started.");
      const session = await this.client.newSession(source.headRoot, [mcpServer]);
      this.state.acpSessionId = session.sessionId;
      this.sessionModes = session.modes ?? null;
      let configOptions: readonly SessionConfigOption[] = session.configOptions ?? [];
      this.latestOptions = configOptions;
      if (this.state.autoApprove) configOptions = (await this.enterPermissiveMode(session.sessionId, configOptions)) ?? configOptions;
      if (this.cancelled) return this.stop("Cancelled.");
      await this.applyChoices(session.sessionId, configOptions);
      if (this.cancelled) return this.stop("Cancelled.");
      this.state.status = "running";
      this.persist();
      this.emit();
      const prompt = buildGuidePrompt({ source, files: this.input.files, instructions: this.input.instructions, resume: !!this.input.resume });
      const response = await this.client.prompt(session.sessionId, prompt);
      await this.builderQueue;
      if (this.state.savedGuideId) return this.finish();
      if (this.cancelled || response.stopReason === "cancelled") return this.stop("Cancelled.");
      if (!this.builderReached) {
        this.addBottleneck({
          key: "no-builder",
          title: `${this.input.agent.label} never reached the guide's tools`,
          detail: this.deps.agent.note ?? `The guide is written through Plannotator's own MCP server (plannotator-guide). ${this.input.agent.label} may not accept MCP servers from an ACP client, or its settings may turn MCP servers off.`,
        });
      } else if (this.turnedDown > 0 && !this.state.autoApprove) {
        this.addBottleneck({
          key: "ended-blocked",
          title: "The run ended after requests were turned down",
          detail: "Resume it with automatic approval to let the agent's requests through.",
          action: "resumeWithApproval",
        });
      }
      const why = !this.builderReached
        ? `${this.input.agent.label} never reached the guide's tools (the plannotator-guide MCP server), so it could not write the guide.`
        : response.stopReason === "end_turn" ? "The agent ended its turn without calling guide_finish." : `The agent stopped (${response.stopReason}).`;
      return this.stop(why);
    } catch (err) {
      await this.builderQueue.catch(() => {});
      if (this.state.savedGuideId) return this.finish();
      if (this.cancelled) return this.stop("Cancelled.");
      const message = this.client ? await this.client.describeFailure(err) : err instanceof Error ? err.message : String(err);
      const needsSignIn = (err as { code?: unknown } | null)?.code === ACP_AUTH_REQUIRED_CODE || AUTH_TEXT.test(message);
      if (needsSignIn) this.state.signIn = { logins: loginCommands(this.client?.authMethods) };
      this.fail(needsSignIn ? `${this.input.agent.label} is not signed in. Sign in, then resume the guide.\n${message}` : message);
    } finally {
      this.relaySession?.dispose();
      this.relaySession = null;
      this.client?.dispose();
      this.client = null;
    }
  }

  /**
   * Only when the user opted in to automatic approval: switch the session to
   * the agent's own permissive mode (`permissiveModes` on the agent, the first
   * one it offers), so what its settings would ask about runs, and say which
   * mode in the run header. A mode that cannot be set is a note, never a stop.
   * Returns the config options after the change, or null when nothing changed.
   */
  private async enterPermissiveMode(sessionId: string, options: readonly SessionConfigOption[]): Promise<SessionConfigOption[] | null> {
    const wanted = this.deps.agent.permissiveModes ?? [];
    if (!wanted.length || !this.client) return null;
    const select = readModeSelect(options);
    const modes = this.sessionModes;
    const current = select?.current ?? modes?.currentModeId;
    if (current && wanted.includes(current)) {
      this.state.permissiveMode = current;
      return null;
    }
    const viaConfig = select ? wanted.find((id) => select.options.some((o) => o.value === id)) : undefined;
    const viaModes = !viaConfig && modes ? wanted.find((id) => modes.availableModes.some((m) => m.id === id)) : undefined;
    try {
      if (select && viaConfig) {
        const after = await this.client.setConfigOption(sessionId, select.configId, viaConfig);
        this.latestOptions = after;
        this.state.permissiveMode = viaConfig;
        this.addActivity({ kind: "info", title: `Switched ${this.input.agent.label} to ${viaConfig} for automatic approval` });
        return after;
      }
      if (viaModes) {
        await this.client.setMode(sessionId, viaModes);
        this.state.permissiveMode = viaModes;
        this.addActivity({ kind: "info", title: `Switched ${this.input.agent.label} to ${viaModes} for automatic approval` });
      }
    } catch (err) {
      this.addActivity({ kind: "info", title: `${this.input.agent.label} stayed in its own mode: ${err instanceof Error ? err.message : String(err)}` });
    }
    return null;
  }

  private async applyChoices(sessionId: string, configOptions: readonly SessionConfigOption[]): Promise<void> {
    let options = configOptions;
    const model = readModelSelect(options);
    const wantModel = this.input.agent.model?.id;
    if (model && wantModel && model.current !== wantModel) {
      if (model.options.some((o) => o.value === wantModel)) options = await this.client!.setConfigOption(sessionId, model.configId, wantModel);
      else this.addActivity({ kind: "info", title: `${this.input.agent.model?.label} is not offered; using the agent's default model` });
    }
    const effort = readEffortSelect(options);
    const wantEffort = this.input.agent.effort?.id;
    if (effort && wantEffort && effort.current !== wantEffort) {
      if (effort.options.some((o) => o.value === wantEffort)) options = await this.client!.setConfigOption(sessionId, effort.configId, wantEffort);
      else this.addActivity({ kind: "info", title: `Effort ${this.input.agent.effort?.label} is not offered for this model; using the agent's default` });
    }
    const m = readModelSelect(options);
    const e = readEffortSelect(options);
    if (m) this.state.appliedModel = m.options.find((o) => o.value === m.current)?.name ?? m.current;
    if (e) this.state.appliedEffort = e.options.find((o) => o.value === e.current)?.name ?? e.current;
  }

  private finish(): void {
    this.state.status = "finished";
    this.state.endedAt = this.now();
    const notes = [this.history ? "Saved." : "Done. Not saved: guide history is off, so this guide is kept only until VS Code closes."];
    if (this.state.diagramUnchecked) notes.push("The overview diagram was not render-checked (no Guided Review tab was open); it is checked when the guide opens.");
    this.state.statusMessage = notes.join(" ");
    if (this.history) deleteDraftRecord(this.input.repoKey, this.state.id);
    this.emit();
  }

  /** Stop the agent and everything it started at once (VS Code is closing). */
  kill(): void {
    this.cancelled = true;
    this.client?.kill();
    this.relaySession?.dispose();
  }

  private sessionModes: NewSessionResponse["modes"] | null = null;
  /** The session's config options as last reported (session/new, set_config_option, config_option_update). */
  private latestOptions: readonly SessionConfigOption[] = [];

  private fail(message: string): void {
    this.state.status = "failed";
    this.state.statusMessage = message;
    this.state.endedAt = this.now();
    this.addActivity({ kind: "error", title: "The run failed", detail: message, isError: true });
    this.persist();
    this.emit();
  }

  private stop(message: string): void {
    this.state.status = "stopped";
    this.state.statusMessage = message;
    this.state.endedAt = this.now();
    this.addActivity({ kind: "info", title: message });
    this.persist();
    this.emit();
  }

  /** Cancel the run: `session/cancel`, then stop the agent if it does not end the turn. */
  async cancel(): Promise<void> {
    if (this.cancelled || this.state.status === "finished" || this.state.status === "stopped" || this.state.status === "failed") return;
    this.cancelled = true;
    const client = this.client;
    const sessionId = this.state.acpSessionId;
    if (client && sessionId) {
      await client.cancel(sessionId);
      const ended = await Promise.race([
        new Promise<boolean>((r) => {
          const off = this.onChange((s) => {
            if (s.status === "stopped" || s.status === "finished" || s.status === "failed") {
              off();
              r(true);
            }
          });
        }),
        new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
      ]);
      if (!ended) client.dispose();
    } else client?.dispose();
  }

  /** Save a stopped draft as it is (SPEC 4.4, "Nothing is lost"). */
  async saveAsIs(): Promise<{ ok: true; guideId: string } | { ok: false; problems: string[] }> {
    const answer = await guideSaveAsIs(this.state.draft, this.hooks);
    if (!answer.ok || !answer.snapshot) return { ok: false, problems: answer.text.split("\n").filter((l) => l.trim()) };
    const guideId = this.saveGuide(answer.snapshot, answer.draft);
    this.state.draft = answer.draft;
    this.state.savedGuideId = guideId;
    this.finish();
    return { ok: true, guideId };
  }

  private saveGuide(snapshot: GuideSnapshot, draft: GuideDraft): string {
    const diagram = (snapshot.guide as { overview?: { diagram?: { source?: string } } }).overview?.diagram?.source;
    const diagramCheck = diagram === undefined ? undefined : this.diagramChecks.get(diagram) ?? "unchecked";
    if (diagramCheck === "unchecked") this.state.diagramUnchecked = true;
    const input = {
      repoKey: this.input.repoKey,
      snapshot,
      source: this.input.source,
      agent: { ...this.input.agent },
      focus: focusMap(draft),
      ...(this.state.acpSessionId && { acpSessionId: this.state.acpSessionId }),
      ...(this.state.cost && { cost: this.state.cost }),
      ...(diagramCheck && { diagramCheck }),
      now: this.now(),
    };
    if (this.history) return saveFinishedGuide(input);
    this.memoryGuide = buildFinishedGuide(input);
    return this.memoryGuide.id;
  }

  // -------------------------------------------------------------------------
  // Builder calls (from the MCP relay)
  // -------------------------------------------------------------------------

  private callBuilder(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const run = this.builderQueue.then(() => this.callBuilderNow(name, args));
    this.builderQueue = run.catch(() => {});
    return run;
  }

  private async callBuilderNow(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    if (!(GUIDE_BUILDER_TOOL_NAMES as readonly string[]).includes(name)) return { text: `Unknown tool ${name}.`, isError: true };
    if (this.state.savedGuideId) return { text: "The guide is already saved. Nothing more to do: end your turn.", isError: false };
    const before = this.state.draft;
    const answer = await runGuideBuilderTool(before, name, args, this.hooks);
    if (answer.changed) {
      this.trackMarks(before, answer.draft, name, args);
      this.state.draft = answer.draft;
      this.persist();
    }
    if (name === "guide_finish" && answer.ok && answer.snapshot) {
      try {
        this.state.status = "finishing";
        this.state.savedGuideId = this.saveGuide(answer.snapshot, answer.draft);
      } catch (err) {
        this.state.status = "running";
        const message = err instanceof Error ? err.message : String(err);
        this.addActivity({ kind: "builder", title: name, detail: message, status: "failed", isError: true });
        this.emit();
        return { text: `The guide could not be saved: ${message}`, isError: true };
      }
      this.addActivity({ kind: "builder", title: name, detail: this.history ? "saved" : "done (not saved: guide history is off)", status: "completed" });
      if (this.state.diagramUnchecked) this.addActivity({ kind: "info", title: "The overview diagram was not render-checked here; it is checked when the guide opens." });
      this.emit();
      const unchecked = this.state.diagramUnchecked ? "\nThe overview diagram could not be render-checked (no Guided Review tab is open); the reader checks it when the guide opens." : "";
      return { text: `${answer.text}${unchecked}\nThe reader opens the guide now; end your turn.`, isError: false };
    }
    this.addActivity({
      kind: "builder",
      title: name,
      detail: builderDetail(name, args, answer.draft, answer.ok, answer.text),
      status: answer.ok ? "completed" : "failed",
      isError: !answer.ok,
    });
    this.emit();
    return { text: answer.text, isError: !answer.ok };
  }

  private trackMarks(before: GuideDraft, after: GuideDraft, name: string, args: unknown): void {
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === "guide_add_chapter") {
      const added = after.chapters.find((c) => !before.chapters.some((b) => b.id === c.id));
      if (added) this.state.marks.added = [added.id];
    }
    if (name === "guide_move_file" && typeof a.file === "string") {
      const from = before.chapters.findIndex((c) => c.files.some((f) => f.file === a.file));
      if (from >= 0) this.state.marks.moved[a.file] = from + 1;
    }
  }

  // -------------------------------------------------------------------------
  // ACP updates
  // -------------------------------------------------------------------------

  private onUpdate(notification: SessionNotification): void {
    const u = notification.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        if (u.content.type !== "text") break;
        if (!this.messageEntry) this.messageEntry = this.addActivity({ kind: "message", title: "" });
        this.messageEntry.title += u.content.text;
        break;
      }
      case "tool_call": {
        this.messageEntry = null;
        if (u.kind) this.toolKinds.set(u.toolCallId, u.kind);
        if (u.title) this.toolTitles.set(u.toolCallId, u.title);
        if (BUILDER_TITLE.test(u.title ?? "")) break; // shown from the builder side, with its answer
        const entry = this.addActivity({
          kind: "tool",
          title: u.title || "Tool call",
          status: u.status ?? "pending",
          ...(u.locations?.length && { locations: this.relLocations(u.locations) }),
        });
        this.toolEntries.set(u.toolCallId, entry);
        break;
      }
      case "tool_call_update": {
        if (u.kind) this.toolKinds.set(u.toolCallId, u.kind);
        if (u.title) this.toolTitles.set(u.toolCallId, u.title);
        if (u.status === "failed") this.explainFailure(u.toolCallId, toolOutputText(u.content, u.rawOutput));
        const entry = this.toolEntries.get(u.toolCallId);
        if (!entry) break;
        if (u.title && !BUILDER_TITLE.test(u.title)) entry.title = u.title;
        if (u.status) entry.status = u.status;
        if (u.locations?.length) entry.locations = this.relLocations(u.locations);
        if (u.status === "failed") entry.isError = true;
        break;
      }
      case "plan": {
        this.messageEntry = null;
        const done = u.entries.filter((e) => e.status === "completed").length;
        const current = u.entries.find((e) => e.status === "in_progress") ?? u.entries.find((e) => e.status === "pending");
        const existing = [...this.state.activity].reverse().find((e) => e.kind === "plan");
        const title = `Plan · ${done} of ${u.entries.length} done${current ? ` · ${current.content}` : ""}`;
        if (existing && existing === this.state.activity[this.state.activity.length - 1]) existing.title = title;
        else this.addActivity({ kind: "plan", title });
        break;
      }
      case "config_option_update": {
        this.latestOptions = u.configOptions;
        return;
      }
      case "current_mode_update": {
        if (this.sessionModes) this.sessionModes = { ...this.sessionModes, currentModeId: u.currentModeId };
        return;
      }
      case "usage_update": {
        if (u.cost && typeof u.cost.amount === "number") this.state.cost = { amount: u.cost.amount, currency: u.cost.currency ?? "USD" };
        break;
      }
      default:
        return;
    }
    this.emit();
  }

  private relLocations(locations: ToolCallLocation[]): Array<{ path: string; line?: number }> {
    const root = this.input.source.headRoot;
    return locations.map((l) => {
      const rel = relative(root, l.path);
      const path = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : l.path;
      return { path, ...(typeof l.line === "number" && { line: l.line }) };
    });
  }

  /**
   * A tool call failed. When its output carries the agent's own wording for
   * a settings refusal, say so plainly; the run goes on. One notice per
   * cause, updated with each tool it blocks. (codex-acp reports a declined or
   * sandbox-failed command only as status `failed`, with nothing to tell it
   * from an ordinary error, so it is not guessed at.)
   */
  private explainFailure(toolCallId: string, output: string): void {
    const cause = blockedCause(output);
    if (!cause) return;
    const tool = this.toolTitles.get(toolCallId) ?? "a tool";
    const label = this.input.agent.label;
    const tools = [...(this.blockedTools.get(cause) ?? []), tool].filter((t, i, all) => all.indexOf(t) === i);
    this.blockedTools.set(cause, tools);
    this.addBottleneck({
      key: `blocked:${cause}`,
      title: `${label}'s settings denied ${tools.join(", ")}`,
      detail: `"${output.trim().split("\n")[0].slice(0, 200)}" A deny rule in your ${label} settings blocks it; the guide can still be written without it. Automatic approval answers only what the agent asks about, so it does not lift a deny rule.`,
    });
  }

  /** Add a notice, or update the one with the same key (one notice per cause). */
  private addBottleneck(b: Bottleneck): void {
    const at = this.state.bottlenecks.findIndex((x) => x.key === b.key);
    if (at >= 0) this.state.bottlenecks[at] = b;
    else this.state.bottlenecks.push(b);
    this.addActivity({ kind: "info", title: b.title, ...(b.detail && { detail: b.detail }), isError: true });
    this.emit();
  }

  /**
   * A permission request from the agent. Its own settings decided to ask; the
   * user decides. The builder's own tools are allowed once without a prompt;
   * with automatic approval on, the agent's allow option is picked; otherwise
   * the request waits in the run view (and a notification) with all the
   * agent's options until the user answers.
   */
  private async onPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const builder = builderAutoAllow(request);
    if (builder) return { outcome: { outcome: "selected", optionId: builder } };
    const title = request.toolCall.title ?? this.toolTitles.get(request.toolCall.toolCallId) ?? "a tool";
    if (this.state.autoApprove) {
      const allow = allowOption(request);
      if (allow) {
        this.addActivity({ kind: "permission", title: `Approved automatically: ${title}`, detail: allow.name, status: "completed" });
        this.emit();
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
    }
    const id = this.nextPermission++;
    const kind = request.toolCall.kind ?? this.toolKinds.get(request.toolCall.toolCallId);
    const pending: PendingPermission = {
      id,
      title,
      ...(kind && { kind }),
      ...(describeTarget(request) && { target: describeTarget(request) }),
      options: request.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    };
    const entry = this.addActivity({ kind: "permission", title: `Waiting for your approval: ${title}`, ...(pending.target && { detail: pending.target }), status: "pending" });
    this.state.pendingPermissions.push(pending);
    if (!this.state.autoApprove) this.state.offerAutoApprove = true;
    this.emit();
    const answer = await new Promise<RequestPermissionResponse>((resolve) => {
      this.permissionWaiters.set(id, { request, resolve });
      signal.addEventListener("abort", () => this.settlePermission(id, { outcome: { outcome: "cancelled" } }), { once: true });
      void this.deps.requestPermission?.(pending, signal).then((a) => {
        if (a) this.answerPermission(id, a);
      }, () => {});
    });
    const chosen = answer.outcome.outcome === "selected" ? request.options.find((o) => o.optionId === (answer.outcome as { optionId: string }).optionId) : undefined;
    const allowed = !!chosen && chosen.kind.startsWith("allow");
    entry.title = `${allowed ? "Allowed" : chosen ? "Turned down" : "Not answered"}: ${title}`;
    entry.status = allowed ? "completed" : "failed";
    entry.detail = chosen ? chosen.name : "Cancelled";
    if (chosen && !allowed) {
      this.turnedDown++;
      this.addBottleneck({
        key: "turned-down",
        title: `You turned down ${title}`,
        detail: `${this.input.agent.label} will try another way. Approve automatically to let its requests through for the rest of this run.`,
        action: "approveRun",
      });
    }
    this.emit();
    return answer;
  }

  /** The user answered a pending permission (from the run view or the notification). The first answer wins. */
  answerPermission(id: number, answer: PermissionAnswer): void {
    // "Approve all" holds for the run even from a notification whose request was already answered.
    if ("approve" in answer) {
      if (answer.approve === "always") this.deps.approveAlways?.();
      if (this.isRunLive()) this.approveAutomatically();
      return;
    }
    const waiter = this.permissionWaiters.get(id);
    if (!waiter) return;
    if (!waiter.request.options.some((o) => o.optionId === answer.optionId)) return;
    this.settlePermission(id, { outcome: { outcome: "selected", optionId: answer.optionId } });
  }

  /**
   * Turn automatic approval on for the rest of this run: every pending
   * request is answered with the agent's allow option, later ones too, and
   * the agent switches to its permissive mode where it has one.
   */
  approveAutomatically(): void {
    if (!this.state.autoApprove) {
      this.state.autoApprove = true;
      this.state.offerAutoApprove = false;
      this.addActivity({ kind: "info", title: "Approving the agent's requests automatically for the rest of this run" });
      const client = this.client;
      const sessionId = this.state.acpSessionId;
      if (client && sessionId) {
        void this.enterPermissiveMode(sessionId, this.latestOptions).then(() => this.emit(), () => {});
      }
    }
    for (const [id, waiter] of [...this.permissionWaiters]) {
      // A request with no allow option stays with the user ("cancelled" would abort the agent's tool).
      const allow = allowOption(waiter.request);
      if (allow) this.settlePermission(id, { outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    this.emit();
  }

  private isRunLive(): boolean {
    return this.state.status === "starting" || this.state.status === "running" || this.state.status === "finishing";
  }

  private settlePermission(id: number, response: RequestPermissionResponse): void {
    const waiter = this.permissionWaiters.get(id);
    if (!waiter) return;
    this.permissionWaiters.delete(id);
    this.state.pendingPermissions = this.state.pendingPermissions.filter((p) => p.id !== id);
    waiter.resolve(response);
  }

  /** The head file a tool location points at, absolute. */
  headPath(path: string): string {
    return isAbsolute(path) ? path : join(this.input.source.headRoot, path);
  }
}

/** The agent's allow option: "allow once" first, else "allow always". */
export function allowOption(request: RequestPermissionRequest) {
  return request.options.find((o) => o.kind === "allow_once") ?? request.options.find((o) => o.kind === "allow_always") ?? null;
}

/** What a permission request acts on: its locations, else the first string of its raw input. */
export function describeTarget(request: RequestPermissionRequest): string | undefined {
  const locations = request.toolCall.locations?.map((l) => l.path).filter(Boolean) ?? [];
  if (locations.length) return locations.slice(0, 3).join(", ");
  const raw = request.toolCall.rawInput;
  if (raw && typeof raw === "object") {
    for (const key of ["command", "cmd", "file_path", "path", "url", "pattern"]) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) return v.slice(0, 300);
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ").slice(0, 300);
    }
  }
  return undefined;
}

/** The text of a tool call's output (content blocks and raw output). */
export function toolOutputText(content: unknown, rawOutput: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const c of content as Array<{ type?: string; content?: { type?: string; text?: string } }>) {
      if (c?.type === "content" && c.content?.type === "text" && typeof c.content.text === "string") parts.push(c.content.text);
    }
  }
  if (typeof rawOutput === "string") parts.push(rawOutput);
  else if (rawOutput && typeof rawOutput === "object") {
    for (const key of ["error", "message", "stderr", "output"]) {
      const v = (rawOutput as Record<string, unknown>)[key];
      if (typeof v === "string") parts.push(v);
    }
  }
  return parts.join("\n");
}

/**
 * Whether a failed tool's output is the agent's own wording for a settings
 * refusal. Only wording the adapters write: Claude Code's deny rules
 * ("Permission to use Bash has been denied", also "… with command … has been
 * denied"). Generic errors that merely mention permissions ("cat: x:
 * Permission denied", npm EACCES, "405 Method Not Allowed", "Operation not
 * permitted") are the tool's own failures, not the agent's config.
 */
export function blockedCause(output: string): "settings" | null {
  if (!output) return null;
  if (/\bPermission to use [A-Za-z][\w.-]*(?:\([^)]*\))?(?: with [^\n]*?)? has been denied\b/.test(output)) return "settings";
  return null;
}

export const AUTH_TEXT = /auth(entication)?[_ ]required|not (logged|signed) in|please (log|sign) in|\/login/i;

/** One-line description of a builder call for the activity stream. */
export function builderDetail(name: string, args: unknown, draft: GuideDraft, ok: boolean, answer: string): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const firstLine = answer.split("\n")[0];
  const chapterNo = (ref: unknown) => {
    const i = draft.chapters.findIndex((c) => c.id === ref);
    return i >= 0 ? String(i + 1) : String(ref ?? "?");
  };
  if (!ok) {
    const target = typeof a.file === "string" ? `${a.file}${a.chapter !== undefined ? ` → ${chapterNo(a.chapter)}` : ""}: ` : "";
    return `${target}${firstLine}`;
  }
  switch (name) {
    case "guide_set_header":
      return "title and intent";
    case "guide_set_overview":
      return (a.diagram ? "overview and diagram" : "overview");
    case "guide_add_chapter": {
      const last = [...draft.chapters].reverse().find((c) => c.title === a.title);
      return `${last ? chapterNo(last.id) : draft.chapters.length} · ${String(a.title ?? "")}`;
    }
    case "guide_update_chapter":
      return `chapter ${chapterNo(a.chapter)}`;
    case "guide_move_chapter":
      return `chapter → position ${String(a.position ?? "")}`;
    case "guide_remove_chapter":
      return `removed ${String(a.chapter ?? "")}`;
    case "guide_place_file":
    case "guide_move_file":
      return `${String(a.file ?? "")} → chapter ${chapterNo(a.chapter)}`;
    case "guide_unplace_file":
      return `${String(a.file ?? "")} → not in a chapter`;
    case "guide_read":
      return answer.trim().split("\n").pop() ?? "";
    default:
      return firstLine;
  }
}

function launchReview(input: GenerationInput): GuideLaunchReview {
  const source = input.source;
  return {
    rawPatch: input.rawPatch,
    gitRef: sourceGitRef(source),
    diffType: source.kind === "pr" ? "merge-base" : "since-base",
    base: source.baseSha,
    source: snapshotSource(source),
    ...(input.instructions && { customInstructions: input.instructions }),
  };
}

/** The agent's focus hints per file, for the sidecar. */
function focusMap(draft: GuideDraft): Record<string, readonly GuideFocusRange[]> {
  const out: Record<string, readonly GuideFocusRange[]> = {};
  for (const c of draft.chapters) for (const f of c.files) if (f.focus?.length) out[f.file] = f.focus;
  return out;
}
