/**
 * The DeepSeek Harness (DSH) connection to the Plannotator Inbox: the
 * `plannotator_inbox` tool and the reply wake. The logic shared with Pi and
 * OpenCode 2 is `packages/shared/inbox/agent-link.ts`; this file is the DSH
 * side of it, over the DSH services the plugin is handed (`ctx.agents`,
 * `ctx.tools`, the agent events). Every service is looked up with
 * `ctx.get(...)` and checked before use: one that is missing (an older or
 * trimmed DSH) leaves that part out, never throws.
 *
 * Decided once at plugin load, as Pi decides at extension load: only where the
 * Inbox tool switch allows it for DSH (`PLANNOTATOR_INBOX_TOOL` / `inboxTool`
 * with its `dsh` key, off by default: DSH sends every tool's definition with
 * each request) AND `inbox/inbox.json` exists (the person ran the Inbox once),
 * and never in the `headless`, `sdk`, `sdk-minimal` or `acp` profiles, whose
 * client did not ask for turns of ours. Otherwise nothing is registered and
 * nothing polls.
 *
 * The wake: one `InboxWake` per live top-level session (a subagent's call is
 * signed by, and woken in, the session it works for), made for the sessions
 * live at load and on `agent/created`, disposed on `agent/disposed` and when
 * the plugin unloads. A reply waits until the session is idle (`agent.status`
 * idle, nothing queued in its inbox) for two ticks, then goes in as
 * `agent.followup(message)`, a turn of its own. Send now (the command's `now`)
 * goes in at once: `agent.steer(message)`, which a running turn reads at its
 * next step. Nothing here cancels a turn. One DSH process serves many
 * sessions; two processes on one session (Web and Desktop) share it through
 * the lease in `InboxWake`: what the person types (`agent/inbox/inserted`
 * with a user source that is not ours) and a tool call touch it.
 *
 * Every connection goes out to the Inbox on 127.0.0.1; Plannotator never
 * connects into DSH.
 *
 * DSH runs its plugins in its own process, so DSH and every other plugin can
 * read what this one holds. So this keeps only what the wake needs (the data
 * folder, the host and the tool list): the Inbox key is read from
 * `inbox/inbox.json` for each request and dropped after it (see
 * `InboxAgentConnection.bridge`), and it never goes into a plugin config row,
 * a log line, a tool result or a message to the session.
 */

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

/** The profiles whose client did not ask for turns of ours: one job, or a program driving DSH over stdio. */
export const DSH_NO_WAKE_PROFILES: readonly string[] = ["headless", "sdk", "sdk-minimal", "acp"];

/** The subset of a DSH Agent the Inbox connection reads (`@deepseek-ai/dsh-agent` runtime types). */
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

/** `ctx.shellEnv` (ShellEnvRegistry): `DSH_*` variables a plugin adds to each model shell call. */
export interface DshShellEnvService {
  register(contributor: {
    name: string;
    variables: Record<string, { description: string }>;
    resolve(execution: { agent?: DshInboxAgent }): Record<string, string>;
  }): unknown;
}

/** The variable Plannotator's contributor sets: the top-level session a shell works for (the shim reads it). */
export const DSH_ROOT_SESSION_ENV = "DSH_PLANNOTATOR_SESSION_ID";

/** Set beside it: the shell's own session (DSH_SESSION_ID) the root was worked out for; the shim trusts the root only when they match. */
export const DSH_ROOT_FOR_ENV = "DSH_PLANNOTATOR_SESSION_FOR";

/** How long a reply put into a session waits to be taken by a turn before it is looked at again (Pi's watchdog). */
export const DSH_DELIVERY_CHECK_MS = 15_000;

/** `ctx.agents` (AgentsService): the live agents of this process. */
export interface DshAgentsService {
  get(id: string): DshInboxAgent | undefined;
  list?(): DshInboxAgent[];
}

/** `ctx.tools` (ToolsService): only `register`, with the raw JSON Schema DSH accepts. */
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

/** The Cordis context as the Inbox connection uses it: listeners for the agent events, and services by name. */
export interface DshInboxContext extends Pick<DshContext, "get" | "effect" | "logger"> {
  on(event: string, listener: (payload: any) => unknown): unknown;
  /** Cordis: run `callback` in a child context once every named service is active, again when one is replaced. */
  inject?(deps: string[], callback: (ctx: DshInboxContext) => unknown): unknown;
}

export interface DshInboxDeps {
  env?: NodeJS.ProcessEnv;
  /** Plannotator's data dir (default: PLANNOTATOR_DATA_DIR, else ~/.plannotator). */
  dataDir?: string;
  /** The Inbox tools to carry (default: the running Inbox's `tools/list`, bounded at 2 s). */
  discover?: (dataDir: string) => Promise<InboxToolInfo[] | null>;
  /** The wake's tick (tests). */
  tickMs?: number;
  /** The plugin's version, for each poll's `plugin` (default: this package's package.json). */
  version?: string | null;
  /** Aborted when the plugin unloads: a setup still discovering then starts nothing. */
  unloadSignal?: AbortSignal;
  /** How often a reply not yet taken by a turn is looked at again (default DSH_DELIVERY_CHECK_MS; tests). */
  deliveryCheckMs?: number;
}

/** What `setupDshInbox` started, for the plugin's unload and the tests. */
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
      // Logging is best-effort.
    }
  };
}

/** A DSH service by name, or undefined when the context has no `get` or the service is absent or throws. */
function service<T>(ctx: DshInboxContext, name: string): T | undefined {
  try {
    return (ctx.get?.(name) as T | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/** `ctx.agents`, when it is there and can look an agent up. */
export function agentsServiceOf(ctx: DshInboxContext): DshAgentsService | undefined {
  const agents = service<DshAgentsService>(ctx, "agents");
  return agents && typeof agents.get === "function" ? agents : undefined;
}

/** A subagent's session (DSH marks it in the header). */
function isSubagent(agent: DshInboxAgent): boolean {
  const header = agent.session?.header;
  return header?.origin === "subagent" || (typeof header?.delegationDepth === "number" && header.delegationDepth > 0);
}

/** The top-level session an agent works for: itself, or the live session above a subagent. */
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

/** This package's version: package.json beside the source, or one level up from the built `dist/index.js`. */
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
      // Next.
    }
  }
  return null;
}

/** Whether message `id` still waits in the agent's queue (`inbox.nextTurn` or `inbox.nextStep`). */
function queued(agent: DshInboxAgent, id: string): boolean {
  try {
    return [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some((item) => (item as { id?: unknown } | null)?.id === id);
  } catch {
    return false;
  }
}

/** The session title DSH keeps (`ctx.sessionTitle`): a generated or renamed one; "" for the built-in fallback; null when it cannot tell. */
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

/**
 * Start the Inbox connection for this DSH process, or return null (the switch
 * is off, the Inbox never ran here, a profile that takes no turns of ours, or
 * DSH has no agents service). The tool is registered once the Inbox's tools
 * are known (bounded at 2 s); the wakes start at once.
 */
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
  /** The messages this connection put into a session: never the person's typing. */
  const ours = new Set<string>();
  let disposed = false;

  const agentOf = (sessionId: string): DshInboxAgent | undefined => {
    try {
      return agents.get(sessionId);
    } catch {
      return undefined;
    }
  };

  /** Replies put into a session and not yet taken by a turn, by DSH message id. */
  const waiting = new Map<string, { sessionId: string; end: (error?: Error) => void; discarded: () => void; dropped: () => boolean }>();
  const checkMs = deps.deliveryCheckMs ?? DSH_DELIVERY_CHECK_MS;

  /**
   * Put the wake text into the session, and settle once a turn takes it, as
   * Pi waits for its `message_start`: `agent/inbox/claimed` delivers it.
   * `agent/inbox/discarded` is looked at after a microtask, since DSH's queue
   * edit (replace) and queue steer (remove, then steer) discard the message
   * and put the same id straight back: back in the queue, it waits on. Really
   * gone, it is dropped: the session closing next (DSH clears a ready
   * session's queue, discarding each item, before `agent/disposed`) gives it
   * back to the Inbox to deliver when the session resumes; otherwise the
   * person took it out, and at the next look it fails. Looked at again every
   * `checkMs`: still queued (a long tool call holds a steer), it waits on;
   * gone with no word (a DSH without the claimed event), it was taken.
   */
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
        // Dropped while the session is still registered and not idle: it may be closing slowly (its queue cleared,
        // `agent/disposed` still to come), so wait for the close or for idle before calling it the person's removal.
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
    // Busy: a turn runs, something waits in its inbox, or the session is not live here (it cannot take a turn now).
    isBusy: () => {
      const agent = agentOf(sessionId);
      if (!agent || agent.status !== "idle") return true;
      return (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0;
    },
    deliver: (text: string, _command: InboxReplyCommand) => send(sessionId, text, "followup"),
    // Send now while a turn runs: steering, which the running turn reads at its next step.
    steer: (text: string, _command: InboxReplyCommand) => send(sessionId, text, "steer"),
    canSteer: () => typeof agentOf(sessionId)?.steer === "function",
    notify: (message: string) => warn("plannotator: %s", message),
    projectPath: () => sessionCwd(ctx as DshContext, agentOf(sessionId) as never) ?? null,
    label: () => titleOf(ctx, agentOf(sessionId)),
    pluginVersion: () => version ?? null,
  });

  /** The wake of a top-level session, made once; null for a subagent or after unload. */
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
    // A ready session closing clears its queue first (DSH's `cancel({ kind: 'disposed' }, { keepInbox: !ready })`,
    // each item discarded): the person did not remove those, so they go back to the Inbox and wait for the
    // session's next wake (it resumes). One still queued was kept by DSH (a session not ready yet): it stays in
    // the session's saved queue, which DSH takes on resume.
    for (const entry of [...waiting.values()]) {
      if (entry.sessionId !== payload?.agent?.id) continue;
      entry.end(entry.dropped() ? new InboxDeliverLater("the session closed before a turn read it") : undefined);
    }
  });
  // A turn took the reply: delivered.
  ctx.on("agent/inbox/claimed", (payload: { message?: { id?: unknown } }) => {
    const id = payload?.message?.id;
    if (typeof id === "string") waiting.get(id)?.end();
  });
  // Out of the queue: looked at once DSH's own call is done (an edit or a queue steer puts the same id back).
  ctx.on("agent/inbox/discarded", (payload: { message?: { id?: unknown } }) => {
    const id = payload?.message?.id;
    const entry = typeof id === "string" ? waiting.get(id) : undefined;
    if (entry) queueMicrotask(entry.discarded);
  });
  // Someone else's prompt entering a session: its turn goes first, and the person's typing moves the lease here.
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
    // No list: the sessions are watched as they are created or call the tool.
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

  // A subagent's shell names its own session in DSH_SESSION_ID; the tool signs as the session it works for.
  // So `plannotator inbox call` in that shell does too, through this variable (the shim prefers it).
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
          // DSH_SESSION_ID is the agent's session header id (shell-env's collect).
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
    // Not active yet: register once it is (Cordis disposes that registration with this context).
    try {
      ctx.inject(["shellEnv"], (child) => registerShellEnv(service<DshShellEnvService>(child, "shellEnv")));
    } catch {
      // No shellEnv: a subagent's shell sends as the subagent.
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
      // Not taken by a turn yet. The plugin unloading may be DSH quitting, which then closes each ready session and
      // clears its queue, so a reply waiting there is not counted as delivered: it goes back to the Inbox, and the
      // next wake of the session delivers it (a plugin-only reload may deliver it a second time; never zero).
      for (const entry of [...waiting.values()]) entry.end(new InboxDeliverLater("the plugin unloaded before a turn read it"));
      try {
        unregisterShellEnv?.();
      } catch {
        // Cordis disposes it with the plugin anyway.
      }
    },
  };
}
