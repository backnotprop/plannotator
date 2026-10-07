/**
 * The OpenCode connection to the Plannotator Inbox (plan step 7): the
 * `plannotator_inbox` tool on both runtimes, and the reply wake on OpenCode 2
 * only. The logic shared with the Pi extension is
 * `packages/shared/inbox/agent-link.ts`; this file is the OpenCode side of it.
 *
 * Found or not, decided once at plugin setup: only where the inbox tool
 * switch allows it for OpenCode (`PLANNOTATOR_INBOX_TOOL` / `inboxTool`, off by
 * default: OpenCode sends every tool's full definition with each request) AND
 * `inbox/inbox.json` exists. Otherwise nothing is registered and nothing
 * polls. The tool carries the actions the Inbox's `/mcp` offers (discovery
 * bounded at 2 s) and never changes under a running OpenCode.
 *
 * OpenCode 2's wake: one `InboxWake` per root session (a subagent's call is
 * signed by, and woken in, the root session the person works in), made when
 * the session first calls the tool or first runs in this process (so a reply
 * sent while OpenCode was restarting still finds its session). A reply goes
 * in with `session.prompt({ id, text, delivery: "queue" })` once the session is
 * idle: never "steer", which would join a run that started in the same
 * instant, and never into a session that is running. Busy comes from the
 * session's execution events; a session that reads running with no event for
 * 20 s is checked against OpenCode itself (`session.wait` answers at once when
 * it is idle), so a lost end event cannot hold replies forever. Nothing here
 * interrupts a session: a prompt typed into the wake's turn takes it over.
 * Two OpenCode processes on one session (two servers on one database): the
 * one the person used last delivers. A tool call, a run and a prompt entering
 * the session in a process touch the session's lease in `InboxWake` there;
 * the other process defers while it is live.
 */

import { existsSync } from "node:fs";
import { loadConfig, resolveInboxTool } from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import {
  discoverInboxTools,
  InboxAgentConnection,
  inboxRegistryFileOf,
  InboxWake,
  type InboxWakeTarget,
} from "@plannotator/shared/inbox/agent-link";
import { inboxAgentTool } from "@plannotator/shared/inbox/connection";
import { createOpenCodeMessageId } from "./opencode-session-bridge";
import type { V2ContextLike } from "./v2-client";

export const OPENCODE_INBOX_HOST = "opencode";
export const OPENCODE_INBOX_AGENT_NAME = "OpenCode";
/** A session that reads running with no event for this long is checked against OpenCode. */
export const RUNNING_CROSS_CHECK_MS = 20_000;
/** A `session.wait` still pending after this means the session is running. */
const IDLE_PROBE_MS = 300;
/** Marks the wake's prompt in the session. */
const INBOX_PROMPT_SOURCE = "plannotator-inbox";

/** The Inbox connection for this OpenCode process, or null when the switch is off or no Inbox was found. */
export async function findInboxConnection(): Promise<InboxAgentConnection | null> {
  if (!resolveInboxTool(loadConfig(), process.env, "opencode")) return null;
  const dataDir = getPlannotatorDataDir();
  if (!existsSync(inboxRegistryFileOf(dataDir))) return null;
  const tools = await discoverInboxTools(dataDir);
  return tools ? new InboxAgentConnection({ dataDir, host: OPENCODE_INBOX_HOST, agentName: OPENCODE_INBOX_AGENT_NAME, tools }) : null;
}

/** The part of OpenCode 2's tool domain the tool needs (probed: older hosts differ). */
export interface InboxToolDomainLike {
  transform?: (apply: (tools: { add?: (tool: Record<string, unknown>) => void }) => void) => Promise<unknown> | unknown;
}

/**
 * OpenCode 2: register `plannotator_inbox` and start the wake. Returns whether
 * the host's tool draft took it.
 */
export async function registerInboxOpenCode2(
  toolDomain: InboxToolDomainLike | undefined,
  v2: V2ContextLike,
  connection: InboxAgentConnection,
  resolveRoot: (sessionID: string) => Promise<{ root: string }>,
): Promise<boolean> {
  const transform = toolDomain?.transform;
  const spec = inboxAgentTool(connection.tools, { wakes: typeof v2.session?.prompt === "function" });
  if (typeof transform !== "function" || !spec) return false;
  const wakes = typeof v2.session?.prompt === "function" ? new OpenCode2Wakes(v2, connection, resolveRoot) : null;
  let added = false;
  await transform((tools) => {
    if (typeof tools?.add !== "function") return;
    added = true;
    tools.add({
      name: spec.name,
      description: spec.description,
      input: spec.inputSchema,
      options: { codemode: false },
      // Results are always text: the promise adapter turns a rejected execute into a defect.
      execute: async (input: unknown, toolContext: { sessionID: string }) => {
        const { root } = await resolveRoot(toolContext.sessionID);
        wakes?.watch(root);
        let cwd = v2.location?.directory ?? process.cwd();
        try {
          cwd = (await v2.session?.get?.({ sessionID: toolContext.sessionID }))?.location?.directory ?? cwd;
        } catch {
          // The plugin's own folder stands.
        }
        return { content: (await connection.callTool(input, { sessionId: root, cwd, wakes: wakes !== null })).text };
      },
    });
  });
  if (!added) wakes?.dispose();
  return added;
}

interface SessionState {
  running: boolean;
  lastEventAt: number;
}

/** The wakes of the sessions this OpenCode 2 process has seen, and what its events say about them. */
class OpenCode2Wakes {
  private readonly wakes = new Map<string, InboxWake>();
  private readonly states = new Map<string, SessionState>();
  /** Session ids already looked up (root or child), so each is resolved once. */
  private readonly seen = new Set<string>();
  private readonly controller = new AbortController();
  private eventsAvailable = false;

  constructor(
    private readonly v2: V2ContextLike,
    private readonly connection: InboxAgentConnection,
    private readonly resolveRoot: (sessionID: string) => Promise<{ root: string }>,
  ) {
    const subscribe = v2.event?.subscribe;
    if (typeof subscribe !== "function") return;
    this.eventsAvailable = true;
    void (async () => {
      try {
        for await (const event of subscribe({ signal: this.controller.signal })) this.onEvent(event);
      } catch {
        // Best effort (#44788): without events, busy is read from `session.wait`.
      } finally {
        this.eventsAvailable = false;
      }
    })();
  }

  dispose(): void {
    this.controller.abort();
    for (const wake of this.wakes.values()) wake.dispose();
    this.wakes.clear();
  }

  /** Start the wake for a root session, once; later calls say the session is in use here. */
  watch(sessionID: string): void {
    this.seen.add(sessionID);
    const known = this.wakes.get(sessionID);
    if (known) {
      known.touch();
      return;
    }
    const wake = new InboxWake(this.connection, sessionID, this.target(sessionID));
    this.wakes.set(sessionID, wake);
    wake.start();
  }

  private state(sessionID: string): SessionState {
    let state = this.states.get(sessionID);
    if (!state) {
      state = { running: false, lastEventAt: Date.now() };
      this.states.set(sessionID, state);
    }
    return state;
  }

  private onEvent(event: unknown): void {
    if (!event || typeof event !== "object") return;
    const { type, data } = event as { type?: unknown; data?: Record<string, unknown> };
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null;
    if (typeof type !== "string" || !sessionID) return;
    const state = this.state(sessionID);
    state.lastEventAt = Date.now();
    switch (type) {
      case "session.execution.started":
        state.running = true;
        this.discover(sessionID);
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        state.running = false;
        return;
      case "session.inbox.enqueued":
        // A prompt is entering the session (the person, another plugin, or
        // the wake itself, which no longer waits): any reply still waiting
        // lets that turn go first, and replies follow the person to this process.
        if ((data?.item as { type?: unknown } | undefined)?.type === "user") {
          this.wakes.get(sessionID)?.onForeignPrompt();
          this.wakes.get(sessionID)?.touch();
        }
        return;
      case "session.deleted":
        this.wakes.get(sessionID)?.dispose();
        this.wakes.delete(sessionID);
        return;
    }
  }

  /** A session ran here that this process has not seen: watch its root. */
  private discover(sessionID: string): void {
    if (this.seen.has(sessionID)) return;
    this.seen.add(sessionID);
    void this.resolveRoot(sessionID).then(
      ({ root }) => this.watch(root),
      () => undefined,
    );
  }

  /** Idle now: `session.wait` answers within the probe bound. */
  private async idleProbe(sessionID: string): Promise<boolean> {
    const wait = this.v2.session?.wait;
    if (typeof wait !== "function") return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), IDLE_PROBE_MS);
    });
    try {
      return await Promise.race([wait({ sessionID }).then(() => true, () => false), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private target(sessionID: string): InboxWakeTarget {
    return {
      isBusy: async () => {
        const state = this.state(sessionID);
        if (!this.eventsAvailable) return !(await this.idleProbe(sessionID));
        if (!state.running) return false;
        // A lost end event must not hold replies forever.
        if (Date.now() - state.lastEventAt < RUNNING_CROSS_CHECK_MS) return true;
        state.lastEventAt = Date.now();
        if (!(await this.idleProbe(sessionID))) return true;
        state.running = false;
        return false;
      },
      deliver: async (text) => {
        const prompt = this.v2.session?.prompt;
        if (typeof prompt !== "function") throw new Error("this OpenCode cannot receive a prompt from a plugin");
        // "queue": the decision runs as a turn of its own once the session is
        // idle. Never "steer" (it would join a run that started this instant,
        // and an idle session promotes pending steer rows alone, #1734).
        await prompt({ sessionID, id: createOpenCodeMessageId(), text, delivery: "queue", metadata: { source: INBOX_PROMPT_SOURCE } });
      },
      notify: (message) => {
        console.error(`[Plannotator] ${message}`);
      },
    };
  }
}

/**
 * OpenCode 1 takes tool arguments as a zod shape: the agent tool's JSON
 * Schema properties, converted for the types the Inbox's tools use (string,
 * enum, integer, number, boolean, array). Bounds stay with the Inbox, which
 * validates every call; `z` is the plugin package's own `tool.schema`.
 */
export function inboxToolArgs(schema: Record<string, unknown>, z: any): Record<string, any> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const args: Record<string, any> = {};
  for (const [name, property] of Object.entries(properties)) {
    let type = zodOf(property, z);
    if (typeof property.description === "string" && property.description) type = type.describe(property.description);
    args[name] = required.has(name) ? type : type.optional();
  }
  return args;
}

function zodOf(property: Record<string, unknown>, z: any): any {
  if (Array.isArray(property.enum) && property.enum.length > 0 && property.enum.every((value) => typeof value === "string")) {
    return z.enum(property.enum);
  }
  switch (property.type) {
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(property.items && typeof property.items === "object" ? zodOf(property.items as Record<string, unknown>, z) : z.unknown());
    default:
      return z.unknown();
  }
}
