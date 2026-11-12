import { existsSync } from "node:fs";
import { loadConfig, resolveInboxTool } from "../../packages/shared/config";
import { getPlannotatorDataDir } from "../../packages/shared/data-dir";
import { discoverInboxTools, InboxAgentConnection, InboxDeliverLater, inboxRegistryFileOf, InboxWake, type InboxWakeTarget } from "../../packages/shared/inbox/agent-link";
import { inboxAgentTool, type InboxReplyCommand, type InboxToolInfo } from "../../packages/shared/inbox/connection";

export const CLINE_INBOX_HOST = "cline";
export const CLINE_INBOX_AGENT_NAME = "Cline";

export const CLINE_DELIVERY_WAIT_MS = 15_000;

export const CLINE_DISCOVER_TIMEOUT_MS = 750;

export const CLINE_TOOL_TIMEOUT_MS = 120_000;

export interface ClineSetupContext {
  session?: { sessionId?: string };
  cwd?: string;
  workspaceInfo?: { rootPath?: string };
  client?: { name?: string };
  emitEvent?: (name: string, payload?: unknown) => void;
  onDispose?: (cleanup: () => void | Promise<void>) => void;
  logger?: { log?: (message: string, ...args: unknown[]) => void; warn?: (message: string, ...args: unknown[]) => void };
}

export interface ClineToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown, context?: unknown) => Promise<string>;
  timeoutMs: number;
  retryable: false;
  maxRetries: 0;
}

export interface ClinePluginApi {
  registerTool?: (tool: ClineToolDefinition) => void;
}

export interface ClineRunContext {
  snapshot?: { agentId?: string };
}

interface WaitingPrompt {
  done: () => void;
  later: (why: string) => void;
  rearm: () => void;
}

export interface ClineInboxDeps {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  discover?: (dataDir: string) => Promise<InboxToolInfo[] | null>;
  tickMs?: number;
  version?: string | null;
  deliveryWaitMs?: number;
}

function say(ctx: ClineSetupContext, message: string): void {
  try {
    (ctx.logger?.warn ?? ctx.logger?.log)?.(`plannotator: ${message}`);
  } catch {
  }
}

export class ClineInboxSession {
  readonly wake: InboxWake;
  private readonly runs = new Set<string>();
  private readonly waiting: WaitingPrompt[] = [];
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

  private put(text: string): Promise<void> {
    const emit = this.ctx.emitEvent;
    if (this.disposed || typeof emit !== "function") return Promise.reject(new Error("this Cline session cannot take a prompt from a plugin"));
    const waitMs = this.deps.deliveryWaitMs ?? CLINE_DELIVERY_WAIT_MS;
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: Error) => {
        clearTimeout(timer);
        const at = this.waiting.indexOf(entry);
        if (at < 0) return;
        this.waiting.splice(at, 1);
        if (error) reject(error);
        else resolve();
      };
      const entry: WaitingPrompt = {
        done: () => settle(),
        later: (why) => settle(new InboxDeliverLater(why)),
        rearm: () => {
          clearTimeout(timer);
          timer = setTimeout(() => entry.later("no Cline run took it"), waitMs);
          (timer as { unref?: () => void }).unref?.();
        },
      };
      this.waiting.push(entry);
      entry.rearm();
      try {
        emit("queue_message", { prompt: text });
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  start(): void {
    this.wake.start();
  }

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
    if (this.runs.delete(key) || (key !== "run" && this.runs.delete("run"))) return;
    for (const entry of this.waiting) entry.rearm();
  }

  touch(): void {
    this.wake.touch();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wake.dispose();
    for (const entry of [...this.waiting]) entry.later("the Cline session closed before a run took it");
  }
}

export async function setupClineInbox(api: ClinePluginApi, ctx: ClineSetupContext, deps: ClineInboxDeps = {}): Promise<ClineInboxSession | null> {
  const sessionId = ctx.session?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return null;
  const env = deps.env ?? process.env;
  if (!resolveInboxTool(loadConfig(), env, CLINE_INBOX_HOST)) return null;
  const dataDir = deps.dataDir ?? getPlannotatorDataDir();
  if (!existsSync(inboxRegistryFileOf(dataDir))) return null;
  const tools = await (deps.discover ?? ((dir) => discoverInboxTools(dir, { timeoutMs: CLINE_DISCOVER_TIMEOUT_MS })))(dataDir).catch(() => null);
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
