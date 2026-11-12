import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveInboxTool } from "../../packages/shared/config";
import { getPlannotatorDataDir } from "../../packages/shared/data-dir";
import {
  discoverInboxTools,
  InboxAgentConnection,
  InboxDeliverLater,
  inboxRegistryFileOf,
  InboxWake,
  type InboxWakeTarget,
} from "../../packages/shared/inbox/agent-link";
import { inboxAgentTool, type InboxReplyCommand, type InboxToolInfo } from "../../packages/shared/inbox/connection";
import { createUserMessage, sessionCwd, type DshContext, type DshUserMessage } from "./plan-review";

export const DSH_INBOX_HOST = "dsh";
export const DSH_INBOX_AGENT_NAME = "DeepSeek Harness";

export const DSH_NO_WAKE_PROFILES: readonly string[] = ["headless", "sdk", "sdk-minimal", "acp"];

export interface DshInboxAgent {
  readonly id: string;
  readonly status?: "idle" | "running" | string;
  readonly session?: {
    header?: { id?: string; cwd?: string; parentSession?: string; origin?: string; delegationDepth?: number };
  };
  readonly inbox?: { readonly nextTurn?: readonly unknown[]; readonly nextStep?: readonly unknown[] };
  followup?(message: DshUserMessage): void;
  steer?(message: DshUserMessage): void;
}

export interface DshShellEnvService {
  register(contributor: {
    name: string;
    variables: Record<string, { description: string }>;
    resolve(execution: { agent?: DshInboxAgent }): Record<string, string>;
  }): unknown;
}

export const DSH_ROOT_SESSION_ENV = "DSH_PLANNOTATOR_SESSION_ID";

export const DSH_ROOT_FOR_ENV = "DSH_PLANNOTATOR_SESSION_FOR";

export const DSH_DELIVERY_CHECK_MS = 15_000;

export interface DshAgentsService {
  get(id: string): DshInboxAgent | undefined;
  list?(): DshInboxAgent[];
}

export interface DshToolsService {
  register(definition: DshToolDefinition): unknown;
}

export interface DshToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): { type: "text"; text: string }[] };
  execute(args: unknown, exec: { agent?: DshInboxAgent; signal?: AbortSignal }): Promise<unknown>;
}

export interface DshInboxContext extends Pick<DshContext, "get" | "effect" | "logger"> {
  on(event: string, listener: (payload: any) => unknown): unknown;
  inject?(deps: string[], callback: (ctx: DshInboxContext) => unknown): unknown;
}

export interface DshInboxDeps {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  discover?: (dataDir: string) => Promise<InboxToolInfo[] | null>;
  tickMs?: number;
  version?: string | null;
  unloadSignal?: AbortSignal;
  deliveryCheckMs?: number;
}

export interface DshInbox {
  readonly connection: InboxAgentConnection;
  readonly wakes: ReadonlyMap<string, InboxWake>;
  dispose(): void;
}

function warnOf(ctx: DshInboxContext) {
  return (format: string, ...args: unknown[]) => {
    try {
      ctx.logger?.warn?.(format, ...args);
    } catch {
    }
  };
}

function service<T>(ctx: DshInboxContext, name: string): T | undefined {
  try {
    return (ctx.get?.(name) as T | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

export function agentsServiceOf(ctx: DshInboxContext): DshAgentsService | undefined {
  const agents = service<DshAgentsService>(ctx, "agents");
  return agents && typeof agents.get === "function" ? agents : undefined;
}

function isSubagent(agent: DshInboxAgent): boolean {
  const header = agent.session?.header;
  return header?.origin === "subagent" || (typeof header?.delegationDepth === "number" && header.delegationDepth > 0);
}

export function rootAgentOf(agents: DshAgentsService, agent: DshInboxAgent): DshInboxAgent {
  let current = agent;
  for (let hops = 0; hops < 16 && isSubagent(current); hops++) {
    const parent = current.session?.header?.parentSession;
    const above = typeof parent === "string" ? agents.get(parent) : undefined;
    if (!above) break;
    current = above;
  }
  return current;
}

function readPluginVersion(): string | null {
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (const candidate of [join(here, "package.json"), join(here, "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "@plannotator/dsh" && typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
    }
  }
  return null;
}

function queued(agent: DshInboxAgent, id: string): boolean {
  try {
    return [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some((item) => (item as { id?: unknown } | null)?.id === id);
  } catch {
    return false;
  }
}

function titleOf(ctx: DshInboxContext, agent: DshInboxAgent | undefined): string | null {
  if (!agent) return null;
  const titles = service<{ get?(session: unknown): { title?: unknown; source?: { kind?: unknown } } | undefined }>(ctx, "sessionTitle");
  if (typeof titles?.get !== "function") return null;
  try {
    const snapshot = titles.get(agent.session);
    if (!snapshot) return "";
    if (snapshot.source?.kind === "fallback") return "";
    return typeof snapshot.title === "string" ? snapshot.title : null;
  } catch {
    return null;
  }
}

export async function setupDshInbox(ctx: DshInboxContext, deps: DshInboxDeps = {}): Promise<DshInbox | null> {
  const warn = warnOf(ctx);
  const env = deps.env ?? process.env;
  const profile = service<{ name?: unknown }>(ctx, "profileContext");
  if (typeof profile?.name === "string" && DSH_NO_WAKE_PROFILES.includes(profile.name)) return null;
  if (!resolveInboxTool(loadConfig(), env, DSH_INBOX_HOST)) return null;
  const dataDir = deps.dataDir ?? getPlannotatorDataDir();
  if (!existsSync(inboxRegistryFileOf(dataDir))) return null;
  const agents = agentsServiceOf(ctx);
  if (!agents || typeof ctx.on !== "function") {
    warn("plannotator: this DSH has no agents service; the Plannotator Inbox connection is off");
    return null;
  }
  const tools = await (deps.discover ?? ((dir) => discoverInboxTools(dir)))(dataDir).catch(() => null);
  if (!tools || deps.unloadSignal?.aborted) return null;
  const connection = new InboxAgentConnection({ dataDir, host: DSH_INBOX_HOST, agentName: DSH_INBOX_AGENT_NAME, tools });
  const version = deps.version === undefined ? readPluginVersion() : deps.version;
  const wakes = new Map<string, InboxWake>();
  const ours = new Set<string>();
  let disposed = false;

  const agentOf = (sessionId: string): DshInboxAgent | undefined => {
    try {
      return agents.get(sessionId);
    } catch {
      return undefined;
    }
  };

  const waiting = new Map<string, { sessionId: string; end: (error?: Error) => void; discarded: () => void; dropped: () => boolean }>();
  const checkMs = deps.deliveryCheckMs ?? DSH_DELIVERY_CHECK_MS;

  const send = (sessionId: string, text: string, how: "followup" | "steer"): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const agent = agentOf(sessionId);
      const put = agent?.[how];
      if (!agent || typeof put !== "function") {
        reject(new Error(agent ? `this DSH has no agent.${how}` : "the session is not live in this DSH"));
        return;
      }
      const message = createUserMessage(text);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dropped = false;
      const end = (error?: Error) => {
        if (!waiting.delete(message.id)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const isQueued = () => {
        const live = agentOf(sessionId);
        return !!live && queued(live, message.id);
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(look, checkMs);
        (timer as { unref?: () => void }).unref?.();
      };
      function look() {
        if (!waiting.has(message.id)) return;
        if (isQueued()) {
          dropped = false;
          arm();
          return;
        }
        const live = dropped ? agentOf(sessionId) : undefined;
        if (live && live.status !== "idle") {
          arm();
          return;
        }
        end(dropped ? new Error("it was taken out of the session's queue in DeepSeek Harness before a turn read it") : undefined);
      }
      const discarded = () => {
        if (!waiting.has(message.id) || isQueued()) return;
        dropped = true;
        arm();
      };
      waiting.set(message.id, { sessionId, end, discarded, dropped: () => dropped });
      ours.add(message.id);
      arm();
      try {
        put.call(agent, message);
      } catch (error) {
        ours.delete(message.id);
        end(error instanceof Error ? error : new Error(String(error)));
      }
    });

  const target = (sessionId: string): InboxWakeTarget => ({
    isBusy: () => {
      const agent = agentOf(sessionId);
      if (!agent || agent.status !== "idle") return true;
      return (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0;
    },
    deliver: (text: string, _command: InboxReplyCommand) => send(sessionId, text, "followup"),
    steer: (text: string, _command: InboxReplyCommand) => send(sessionId, text, "steer"),
    canSteer: () => typeof agentOf(sessionId)?.steer === "function",
    notify: (message: string) => warn("plannotator: %s", message),
    projectPath: () => sessionCwd(ctx as DshContext, agentOf(sessionId) as never) ?? null,
    label: () => titleOf(ctx, agentOf(sessionId)),
    pluginVersion: () => version ?? null,
  });

  const watch = (agent: DshInboxAgent | undefined): InboxWake | null => {
    if (disposed || !agent || typeof agent.id !== "string" || isSubagent(agent)) return null;
    const known = wakes.get(agent.id);
    if (known) return known;
    const wake = new InboxWake(connection, agent.id, target(agent.id), deps.tickMs);
    wakes.set(agent.id, wake);
    wake.start();
    return wake;
  };

  const forget = (agent: DshInboxAgent | undefined) => {
    if (!agent || typeof agent.id !== "string") return;
    wakes.get(agent.id)?.dispose();
    wakes.delete(agent.id);
  };

  ctx.on("agent/created", (payload: { agent?: DshInboxAgent }) => {
    watch(payload?.agent);
    return undefined;
  });
  ctx.on("agent/disposed", (payload: { agent?: DshInboxAgent }) => {
    forget(payload?.agent);
    for (const entry of [...waiting.values()]) {
      if (entry.sessionId !== payload?.agent?.id) continue;
      entry.end(entry.dropped() ? new InboxDeliverLater("the session closed before a turn read it") : undefined);
    }
  });
  ctx.on("agent/inbox/claimed", (payload: { message?: { id?: unknown } }) => {
    const id = payload?.message?.id;
    if (typeof id === "string") waiting.get(id)?.end();
  });
  ctx.on("agent/inbox/discarded", (payload: { message?: { id?: unknown } }) => {
    const id = payload?.message?.id;
    const entry = typeof id === "string" ? waiting.get(id) : undefined;
    if (entry) queueMicrotask(entry.discarded);
  });
  ctx.on("agent/inbox/inserted", (payload: { agent?: DshInboxAgent; message?: { id?: unknown; source?: { kind?: unknown } } }) => {
    const id = payload?.message?.id;
    if (typeof id === "string" && ours.delete(id)) return;
    const wake = payload?.agent ? wakes.get(payload.agent.id) : undefined;
    wake?.onForeignPrompt();
    if (payload?.message?.source?.kind === "user") wake?.touch();
  });
  try {
    for (const agent of agents.list?.() ?? []) watch(agent);
  } catch {
  }

  const toolsService = service<DshToolsService>(ctx, "tools");
  const spec = inboxAgentTool(connection.tools);
  if (spec && typeof toolsService?.register === "function") {
    try {
      toolsService.register({
        name: spec.name,
        description: spec.description,
        parameters: spec.inputSchema as Record<string, unknown>,
        output: {
          schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          render: (_args, value) => [{ type: "text", text: String((value as { text?: unknown } | null)?.text ?? "") }],
        },
        async execute(args, exec) {
          const caller = exec?.agent;
          const root = caller ? rootAgentOf(agents, caller) : undefined;
          if (!root || typeof root.id !== "string") throw new Error("plannotator_inbox: no DSH session made this call.");
          const wake = watch(root);
          wake?.touch();
          const cwd = sessionCwd(ctx as DshContext, root as never) ?? process.cwd();
          const result = await connection.callTool(args, { sessionId: root.id, cwd, wakes: wake !== null });
          if (result.isError) throw new Error(result.text);
          return { text: result.text };
        },
      });
    } catch (error) {
      warn("plannotator: could not register plannotator_inbox (%s); replies still wake this DSH's sessions", error instanceof Error ? error.message : String(error));
    }
  } else if (spec) {
    warn("plannotator: this DSH has no tools service; plannotator_inbox is not registered");
  }

  let unregisterShellEnv: (() => void) | null = null;
  const registerShellEnv = (shellEnv: DshShellEnvService | undefined) => {
    if (disposed || typeof shellEnv?.register !== "function") return;
    try {
      const undo = shellEnv.register({
        name: "plannotator-inbox",
        variables: {
          [DSH_ROOT_SESSION_ENV]: { description: "The top-level session this shell works for (a subagent's parent); Plannotator's inbox commands send as it." },
          [DSH_ROOT_FOR_ENV]: { description: "The session DSH_PLANNOTATOR_SESSION_ID was set for (this shell's DSH_SESSION_ID)." },
        },
        resolve: (execution): Record<string, string> => {
          const agent = execution?.agent;
          const root = agent ? rootAgentOf(agents, agent) : undefined;
          const own = agent?.session?.header?.id ?? agent?.id;
          return root && typeof root.id === "string" && typeof own === "string" ? { [DSH_ROOT_SESSION_ENV]: root.id, [DSH_ROOT_FOR_ENV]: own } : {};
        },
      });
      if (typeof undo === "function") unregisterShellEnv = undo as () => void;
    } catch (error) {
      warn("plannotator: could not add %s to DSH's shells (%s)", DSH_ROOT_SESSION_ENV, error instanceof Error ? error.message : String(error));
    }
  };
  const shellEnv = service<DshShellEnvService>(ctx, "shellEnv");
  if (shellEnv) registerShellEnv(shellEnv);
  else if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["shellEnv"], (child) => registerShellEnv(service<DshShellEnvService>(child, "shellEnv")));
    } catch {
    }
  }

  return {
    connection,
    wakes,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const wake of wakes.values()) wake.dispose();
      wakes.clear();
      for (const entry of [...waiting.values()]) entry.end(new InboxDeliverLater("the plugin unloaded before a turn read it"));
      try {
        unregisterShellEnv?.();
      } catch {
      }
    },
  };
}
