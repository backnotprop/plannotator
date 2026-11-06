/**
 * The Cline connection to the Plannotator Inbox: the `plannotator_inbox` tool
 * and the reply wake, for one Cline session. The logic shared with Pi,
 * OpenCode 2 and DeepSeek Harness is `packages/shared/inbox/agent-link.ts`;
 * this file is the Cline side of it, over what a Cline plugin is handed: the
 * setup context (`ctx.session.sessionId`, `ctx.cwd`, `ctx.emitEvent`,
 * `ctx.onDispose`), `api.registerTool`, and the `beforeRun` / `afterRun` hooks.
 *
 * Cline runs each plugin in a worker thread, one per session (the CLI, its
 * hub, Kanban, the desktop app and the VS Code extension's new bundle; the
 * extension's older "Legacy" bundle loads no plugins). So one setup is one
 * session, and the hooks the plugin object carries belong to that session.
 * Cline also calls `setup` without a session (to read what the plugin
 * registers): that one starts nothing.
 *
 * Decided at each setup: only where the Inbox tool switch allows it for Cline
 * (`PLANNOTATOR_INBOX_TOOL` / `inboxTool` with its `cline` key, off by
 * default: Cline sends every tool's definition with each request) AND
 * `inbox/inbox.json` exists (the person ran the Inbox once). Otherwise nothing
 * is registered and nothing polls.
 *
 * The wake: one `InboxWake` for the session. Busy while a run is going
 * (`beforeRun` to `afterRun`, counted by agent so a subagent's run never
 * reads as the end of its parent's) or while a prompt of ours waits to start.
 * A reply waits until the session is idle for two ticks, then goes in as
 * `ctx.emitEvent("queue_message", { prompt })`, which starts a turn in an idle
 * session (tested against the Cline CLI: a turn starts within ~50 ms). It is
 * delivered once the next run starts, or after CLINE_DELIVERY_WAIT_MS: it is
 * then in Cline's own queue. No Send now: nothing here goes into a running
 * turn, and nothing cancels one.
 *
 * Cline stops a plugin's worker after 30 minutes with no call from Cline
 * (`CLINE_PLUGIN_IDLE_TIMEOUT_MS`), running `onDispose` first: the wake stops,
 * and the session leaves the Inbox's live sessions. The person's next prompt
 * calls `beforeRun`, which starts a fresh worker and runs `setup` again for
 * the same session id: the wake is back, and a reply sent meanwhile goes in
 * once that turn ends. Events from the plugin do not count as calls, so the
 * plugin cannot keep itself alive.
 *
 * Every connection goes out to the Inbox on 127.0.0.1; Plannotator never
 * connects into Cline. The Inbox key is read from `inbox/inbox.json` for each
 * request (`InboxAgentConnection.bridge`) and never kept here.
 */

import { existsSync } from "node:fs";
import { loadConfig, resolveInboxTool } from "../../packages/shared/config";
import { getPlannotatorDataDir } from "../../packages/shared/data-dir";
import { discoverInboxTools, InboxAgentConnection, inboxRegistryFileOf, InboxWake, type InboxWakeTarget } from "../../packages/shared/inbox/agent-link";
import { inboxAgentTool, type InboxReplyCommand, type InboxToolInfo } from "../../packages/shared/inbox/connection";

export const CLINE_INBOX_HOST = "cline";
export const CLINE_INBOX_AGENT_NAME = "Cline";

/** How long a reply put into the session waits for its turn to start before it counts as taken (it is in Cline's queue). */
export const CLINE_DELIVERY_WAIT_MS = 15_000;

/** A tool call can start a stopped Inbox (up to 30 s) and then wait for its answer. */
export const CLINE_TOOL_TIMEOUT_MS = 120_000;

/** The parts of Cline's `PluginSetupContext` the connection reads. */
export interface ClineSetupContext {
  session?: { sessionId?: string };
  cwd?: string;
  workspaceInfo?: { rootPath?: string };
  client?: { name?: string };
  emitEvent?: (name: string, payload?: unknown) => void;
  onDispose?: (cleanup: () => void | Promise<void>) => void;
  logger?: { log?: (message: string, ...args: unknown[]) => void; warn?: (message: string, ...args: unknown[]) => void };
}

/** A tool as Cline's `api.registerTool` takes it (`AgentTool`). */
export interface ClineToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown, context?: unknown) => Promise<string>;
  timeoutMs: number;
  /** Never retried by Cline: a retried send would send twice. */
  retryable: false;
  maxRetries: 0;
}

export interface ClinePluginApi {
  registerTool?: (tool: ClineToolDefinition) => void;
}

/** What a run hook is given: the runtime snapshot (`agentId` names the agent whose run it is). */
export interface ClineRunContext {
  snapshot?: { agentId?: string };
}

export interface ClineInboxDeps {
  env?: NodeJS.ProcessEnv;
  /** Plannotator's data dir (default: PLANNOTATOR_DATA_DIR, else ~/.plannotator). */
  dataDir?: string;
  /** The Inbox tools to carry (default: the running Inbox's `tools/list`, bounded at 2 s). */
  discover?: (dataDir: string) => Promise<InboxToolInfo[] | null>;
  /** The wake's tick (tests). */
  tickMs?: number;
  /** The plugin's version, for each poll's `plugin`. */
  version?: string | null;
  /** How long a reply put in waits for its turn to start (default CLINE_DELIVERY_WAIT_MS; tests). */
  deliveryWaitMs?: number;
}

function say(ctx: ClineSetupContext, message: string): void {
  try {
    (ctx.logger?.warn ?? ctx.logger?.log)?.(`plannotator: ${message}`);
  } catch {
    // Logging is best-effort.
  }
}

/**
 * One Cline session's Inbox connection: the wake, and what the plugin's hooks
 * tell it. Made by `setupClineInbox`, stopped by `dispose` (the session ended,
 * or Cline stopped the worker).
 */
export class ClineInboxSession {
  readonly wake: InboxWake;
  /** The runs going now, by agent id. */
  private readonly runs = new Set<string>();
  /** Prompts of ours put into the session whose run has not started, oldest first. */
  private readonly waiting: Array<{ done: () => void }> = [];
  private disposed = false;

  constructor(
    readonly connection: InboxAgentConnection,
    readonly sessionId: string,
    private readonly ctx: ClineSetupContext,
    private readonly deps: { tickMs?: number; version?: string | null; deliveryWaitMs?: number },
  ) {
    this.wake = new InboxWake(connection, sessionId, this.target(), deps.tickMs);
  }

  private target(): InboxWakeTarget {
    return {
      isBusy: () => this.runs.size > 0 || this.waiting.length > 0,
      deliver: (text: string, _command: InboxReplyCommand) => this.put(text),
      notify: (message: string) => say(this.ctx, message),
      projectPath: () => this.ctx.cwd ?? this.ctx.workspaceInfo?.rootPath ?? null,
      pluginVersion: () => this.deps.version ?? null,
    };
  }

  /** Put the wake text into the session as a prompt; settled when its run starts, or after the wait (it is queued in Cline). */
  private put(text: string): Promise<void> {
    const emit = this.ctx.emitEvent;
    if (this.disposed || typeof emit !== "function") return Promise.reject(new Error("this Cline session cannot take a prompt from a plugin"));
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry = {
        done: () => {
          clearTimeout(timer);
          const at = this.waiting.indexOf(entry);
          if (at >= 0) this.waiting.splice(at, 1);
          resolve();
        },
      };
      this.waiting.push(entry);
      timer = setTimeout(entry.done, this.deps.deliveryWaitMs ?? CLINE_DELIVERY_WAIT_MS);
      (timer as { unref?: () => void }).unref?.();
      try {
        emit("queue_message", { prompt: text });
      } catch (error) {
        clearTimeout(timer);
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  start(): void {
    this.wake.start();
  }

  /** A run starts. The first run while ours waits is ours; any other is the person's (their typing moves the lease here). */
  beforeRun(context: ClineRunContext | undefined): void {
    const fresh = this.runs.size === 0;
    this.runs.add(context?.snapshot?.agentId ?? "run");
    if (!fresh) return;
    const ours = this.waiting[0];
    if (ours) {
      ours.done();
      return;
    }
    this.wake.onForeignPrompt();
    this.wake.touch();
  }

  afterRun(context: ClineRunContext | undefined): void {
    const key = context?.snapshot?.agentId ?? "run";
    if (!this.runs.delete(key) && key !== "run") this.runs.delete("run");
  }

  /** The model called the tool in this session: replies land in this process from now on. */
  touch(): void {
    this.wake.touch();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wake.dispose();
    // Whatever waits for its run is in Cline's queue already.
    for (const entry of [...this.waiting]) entry.done();
  }
}

/**
 * Start the Inbox connection for the session Cline set the plugin up for, or
 * return null: no session (Cline reading what the plugin registers), the
 * switch is off, or no Inbox ever ran here. The tool is registered once the
 * Inbox's tools are known (bounded at 2 s, inside Cline's 4 s setup limit).
 */
export async function setupClineInbox(api: ClinePluginApi, ctx: ClineSetupContext, deps: ClineInboxDeps = {}): Promise<ClineInboxSession | null> {
  const sessionId = ctx.session?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return null;
  const env = deps.env ?? process.env;
  if (!resolveInboxTool(loadConfig(), env, CLINE_INBOX_HOST)) return null;
  const dataDir = deps.dataDir ?? getPlannotatorDataDir();
  if (!existsSync(inboxRegistryFileOf(dataDir))) return null;
  const tools = await (deps.discover ?? ((dir) => discoverInboxTools(dir)))(dataDir).catch(() => null);
  if (!tools) return null;
  const connection = new InboxAgentConnection({ dataDir, host: CLINE_INBOX_HOST, agentName: CLINE_INBOX_AGENT_NAME, tools });
  const session = new ClineInboxSession(connection, sessionId, ctx, deps);

  const spec = inboxAgentTool(connection.tools);
  if (spec && typeof api.registerTool === "function") {
    try {
      api.registerTool({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        timeoutMs: CLINE_TOOL_TIMEOUT_MS,
        retryable: false,
        maxRetries: 0,
        async execute(input) {
          session.touch();
          const cwd = ctx.cwd ?? ctx.workspaceInfo?.rootPath ?? process.cwd();
          const result = await connection.callTool(input, { sessionId, cwd, wakes: true });
          if (result.isError) throw new Error(result.text);
          return result.text;
        },
      });
    } catch (error) {
      say(ctx, `could not register plannotator_inbox (${error instanceof Error ? error.message : String(error)}); replies still wake this session`);
    }
  }

  ctx.onDispose?.(() => session.dispose());
  session.start();
  return session;
}
