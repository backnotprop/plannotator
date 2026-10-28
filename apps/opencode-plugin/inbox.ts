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
 * instant, and never into a session that is running, except Send now (the
 * person pressed it in the Inbox; the command's `now`), which goes in at once
 * with `delivery: "steer"` while the session runs. Busy comes from the
 * session's execution events; a session that reads running with no event for
 * 20 s is checked against OpenCode itself (`session.wait` answers at once when
 * it is idle), so a lost end event cannot hold replies forever. Nothing here
 * interrupts a session: a prompt typed into the wake's turn takes it over.
 * Two OpenCode processes on one session (two servers on one database): the
 * one the person used last delivers. A tool call, a run and a prompt entering
 * the session in a process touch the session's lease in `InboxWake` there;
 * the other process defers while it is live.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveInboxTool } from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import {
  discoverInboxTools,
  InboxAgentConnection,
  inboxRegistryFileOf,
  InboxWake,
  type InboxLoadedPluginReport,
  type InboxWakeTarget,
} from "@plannotator/shared/inbox/agent-link";
import { INBOX_REMINDER_TEXT, INBOX_REMINDER_TEXT_NO_WAKE, INBOX_TOOL_NAME, inboxAgentTool } from "@plannotator/shared/inbox/connection";
import { createOpenCodeMessageId, isAskTurnActive } from "./opencode-session-bridge";
import type { V2ContextLike } from "./v2-client";

export const OPENCODE_INBOX_HOST = "opencode";

/** The plugin's package.json: beside the source (a checkout), or one level up from the built `dist/server.js`. */
function findPluginPackageJson(from: string): string | null {
  for (const candidate of [path.join(from, "package.json"), path.join(from, "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown };
      if (pkg.name === "@plannotator/opencode") return candidate;
    } catch {
      // Next.
    }
  }
  return null;
}

/** The `version` in a package.json, or null when it cannot be read (the generation folder was deleted). */
function readVersionAt(file: string | null): string | null {
  if (!file) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

const PLUGIN_PACKAGE_JSON = (() => {
  try {
    return findPluginPackageJson(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return null;
  }
})();
/** The plugin version this process loaded, read when the module was evaluated. */
const LOADED_PLUGIN_VERSION = readVersionAt(PLUGIN_PACKAGE_JSON);
/** How long a read of package.json on disk is reused: every poll asks. */
const ON_DISK_FRESH_MS = 2_000;

/**
 * What this OpenCode 2 service loaded and what is on disk now (owner approval
 * "reload-hosts"): OpenCode 2 installs a plugin into an immutable generation
 * folder, so `on_disk` is the same version, or null once that folder was
 * deleted under the running service (the install script clears the cache).
 * The Inbox then says `opencode2 reload`. Null when the version is unknown.
 */
export function openCodePluginReporter(
  file: string | null = PLUGIN_PACKAGE_JSON,
  loaded: string | null = LOADED_PLUGIN_VERSION,
  now: () => number = Date.now,
): () => InboxLoadedPluginReport | null {
  let cache: { at: number; value: string | null } | null = null;
  return () => {
    if (!loaded) return null;
    if (!cache || now() - cache.at >= ON_DISK_FRESH_MS) cache = { at: now(), value: readVersionAt(file) };
    return { version: loaded, on_disk: cache.value };
  };
}
export const OPENCODE_INBOX_AGENT_NAME = "OpenCode";
/** A session that reads running with no event for this long is checked against OpenCode. */
export const RUNNING_CROSS_CHECK_MS = 20_000;
/** A `session.wait` still pending after this means the session is running. */
const IDLE_PROBE_MS = 300;
/** Marks the wake's prompt in the session. */
const INBOX_PROMPT_SOURCE = "plannotator-inbox";
/**
 * Send now: after the run a steer row was sent into ends, how long OpenCode
 * may still take to deliver it before the wake sends it as a queued turn
 * instead (an idle session may not promote a pending steer row, #1734).
 */
export const STEER_IDLE_GRACE_MS = 3_000;
/**
 * How often a steer row still waiting is looked at: a run whose end event was
 * lost (no event for `RUNNING_CROSS_CHECK_MS`), and a session whose event
 * stream ended, are checked against OpenCode (`session.wait`). There is no
 * cap while the run goes on: OpenCode promotes a pending steer row at the
 * run's next step however long a tool call takes, and a fallback sent then
 * would reach the model as a second copy. Holding the reply while the
 * session is busy costs nothing (a queued turn would wait for idle too).
 */
export const STEER_WATCH_MS = 2_000;

/**
 * The line a fallback queued turn ends with: the steer row it stands in for
 * may still be promoted (OpenCode cannot withdraw it), and the plugin drops
 * the later copy from model requests (`dropInboxDuplicates`); this says so to
 * the model too, in case a copy gets through.
 */
export function inboxRepeatLine(id: string): string {
  return `If this same reply (${id}) already appears above, it is a repeat; answer it once.`;
}

/**
 * What a later copy that is a user message's whole content reads instead:
 * removing it could leave the request ending on an assistant message (a
 * wasted turn, or a provider error), so the message stays, as a pointer.
 */
export function inboxRepeatPointer(id: string): string {
  return `(A repeat of the Plannotator Inbox reply ${id}, which appears above: answer that reply once, and not again if you already have.)`;
}

/**
 * The texts of each reply sent twice (the steer row, then its fallback queued
 * turn), by reply id. Kept for the plugin's life: the conversation holds both
 * rows for good. Bounded; the oldest pair goes first.
 */
const duplicatePairs = new Map<string, readonly [string, string]>();
const DUPLICATE_PAIRS_MAX = 200;

/** Records a reply whose steer row and fallback queued turn may both reach the model. */
export function recordInboxDuplicate(id: string, steerText: string, fallbackText: string): void {
  duplicatePairs.delete(id);
  duplicatePairs.set(id, [steerText, fallbackText]);
  while (duplicatePairs.size > DUPLICATE_PAIRS_MAX) duplicatePairs.delete(duplicatePairs.keys().next().value as string);
}

/** Forgets every recorded pair (tests). */
export function clearInboxDuplicates(): void {
  duplicatePairs.clear();
}

interface TextPart {
  text: string;
  /** The message holds nothing else. */
  only: boolean;
  drop: () => void;
  replace: (text: string) => void;
}

function textParts(message: unknown): TextPart[] {
  if (!message || typeof message !== "object") return [];
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user") return [];
  if (typeof record.content === "string") {
    return [{ text: record.content, only: true, drop: () => undefined, replace: (text) => void (record.content = text) }];
  }
  if (!Array.isArray(record.content)) return [];
  const content = record.content as unknown[];
  return content.flatMap((part) =>
    part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
      ? [
          {
            text: (part as { text: string }).text,
            only: content.length === 1,
            drop: () => void content.splice(content.indexOf(part), 1),
            replace: (text: string) => void ((part as { text: string }).text = text),
          },
        ]
      : [],
  );
}

/**
 * Keeps one copy of a reply sent twice out of what the model reads: of the
 * steer row and its fallback queued turn, whichever comes later in the
 * request goes (the `context` hook's array, mutated in place). A later copy
 * that is its message's whole content is never removed (the request could
 * then end on an assistant message): its text becomes `inboxRepeatPointer`,
 * the same in every request, so the prompt prefix stays stable. Returns how
 * many copies it dropped or replaced.
 */
export function dropInboxDuplicates(messages: unknown[]): number {
  if (duplicatePairs.size === 0) return 0;
  let dropped = 0;
  for (const [id, [steerText, fallbackText]] of duplicatePairs) {
    let seen = false;
    for (const message of messages) {
      for (const part of textParts(message)) {
        if (part.text !== steerText && part.text !== fallbackText) continue;
        if (!seen) {
          seen = true;
          continue;
        }
        dropped++;
        if (part.only) part.replace(inboxRepeatPointer(id));
        else part.drop();
        break;
      }
    }
  }
  return dropped;
}

/** The Inbox connection for this OpenCode process, or null when the switch is off or no Inbox was found. */
export async function findInboxConnection(): Promise<InboxAgentConnection | null> {
  if (!resolveInboxTool(loadConfig(), process.env, "opencode")) return null;
  const dataDir = getPlannotatorDataDir();
  if (!existsSync(inboxRegistryFileOf(dataDir))) return null;
  const tools = await discoverInboxTools(dataDir);
  return tools ? new InboxAgentConnection({ dataDir, host: OPENCODE_INBOX_HOST, agentName: OPENCODE_INBOX_AGENT_NAME, tools }) : null;
}

/**
 * OpenCode 1: the Inbox reminder on one request's system prompt, appended to
 * the end of the LAST part, so the text before it stays byte for byte and the
 * part count never changes (#1114: OpenCode 1.18 sends one system part and
 * only merges extras when there are more than two; a part of our own would
 * leave two parts that never merge, which breaks single-system-message chat
 * templates such as Qwen3's). The no-wake wording: OpenCode 1 cannot deliver
 * a reply as a turn. Never on a title request; never twice. The caller decides
 * whether the request's agent has the tool (`openCode1AgentHasInbox`).
 *
 * "Already there": the built-in lines keep the check they always had (found
 * anywhere in the prompt); a person's own text (config.json prompts.inbox,
 * #2194) counts only as the end of the last part, where this puts it, so a
 * short text the prompt happens to contain ("Be concise.") is still added.
 */
export function addInboxReminderOpenCode1(system: string[], reminder: string = INBOX_REMINDER_TEXT_NO_WAKE): void {
  const lower = system.join("\n").toLowerCase();
  if (lower.includes("title generator") || lower.includes("generate a title")) return;
  if (inboxReminderAlreadyAdded(system, reminder)) return;
  const last = system.length - 1;
  if (last < 0) {
    system.push(reminder);
    return;
  }
  system[last] = system[last] ? `${system[last]}\n\n${reminder}` : reminder;
}

/**
 * Whether the system parts already carry this reminder. The built-in lines
 * (long, fixed): anywhere, as before #2194. Any other text: only as the whole
 * last part or its last `\n\n` block, exactly where a reminder is added.
 */
export function inboxReminderAlreadyAdded(system: readonly string[], reminder: string): boolean {
  if (reminder === INBOX_REMINDER_TEXT || reminder === INBOX_REMINDER_TEXT_NO_WAKE) return system.some((part) => part.includes(reminder));
  const last = system[system.length - 1];
  if (last === undefined) return false;
  const text = reminder.trim();
  return last.trim() === text || last.trimEnd().endsWith(`\n\n${text}`);
}

/** A name against an OpenCode tool-switch key, which may hold `*` wildcards. */
function toolKeyMatches(key: string, name: string): boolean {
  if (!key.includes("*")) return key === name;
  const pattern = key.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${pattern}$`).test(name);
}

/**
 * Whether an OpenCode 1 agent has `plannotator_inbox`: never a subagent, and
 * not an agent whose `tools` switches it off (the last key that names it
 * decides, wildcards included). An agent we know nothing about (a request we
 * could not attribute) counts as having it: the tool is registered for every
 * agent, and a stable answer keeps the system prompt the same per session.
 */
export function openCode1AgentHasInbox(agent: { mode?: unknown; tools?: unknown } | undefined): boolean {
  if (!agent) return true;
  if (agent.mode === "subagent") return false;
  const tools = agent.tools && typeof agent.tools === "object" ? (agent.tools as Record<string, unknown>) : {};
  let enabled = true;
  for (const [key, value] of Object.entries(tools)) {
    if (typeof value === "boolean" && toolKeyMatches(key, INBOX_TOOL_NAME)) enabled = value;
  }
  return enabled;
}

/** The part of OpenCode 2's tool domain the tool needs (probed: older hosts differ). */
export interface InboxToolDomainLike {
  transform?: (apply: (tools: { add?: (tool: Record<string, unknown>) => void }) => void) => Promise<unknown> | unknown;
}

/**
 * OpenCode 2: register `plannotator_inbox` and start the wake. Returns whether
 * the host's tool draft took it, which is known only where the host applies
 * the transform at once: OpenCode 2 applies it lazily, when a request builds
 * its tool list, so this usually answers false while the tool is on its way.
 * The wake is therefore never disposed here on that answer; a draft without
 * `add` disposes it when the callback finally runs.
 */
export async function registerInboxOpenCode2(
  toolDomain: InboxToolDomainLike | undefined,
  v2: V2ContextLike,
  connection: InboxAgentConnection,
  resolveRoot: (sessionID: string) => Promise<{ root: string }>,
  options: { signal?: AbortSignal; plugin?: () => InboxLoadedPluginReport | null } = {},
): Promise<boolean> {
  const transform = toolDomain?.transform;
  const spec = inboxAgentTool(connection.tools, { wakes: typeof v2.session?.prompt === "function" });
  if (typeof transform !== "function" || !spec) return false;
  const wakes = typeof v2.session?.prompt === "function" ? new OpenCode2Wakes(v2, connection, resolveRoot, options.plugin ?? openCodePluginReporter()) : null;
  // `signal` ends the wakes (their event subscription and lease timers): the plugin's lifetime otherwise.
  if (wakes && options.signal) {
    if (options.signal.aborted) wakes.dispose();
    else options.signal.addEventListener("abort", () => wakes.dispose(), { once: true });
  }
  let added = false;
  await transform((tools) => {
    if (typeof tools?.add !== "function") {
      // An older draft that cannot take a tool: nothing will ever call it, so no wake either.
      wakes?.dispose();
      return;
    }
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
  return added;
}

interface SessionState {
  running: boolean;
  lastEventAt: number;
}

/** A steer row Send now sent, waiting to be seen delivered. */
interface SteerEntry {
  sessionID: string;
  /** The row's message id. */
  id: string;
  text: string;
  grace: ReturnType<typeof setTimeout> | null;
  watch: ReturnType<typeof setInterval> | null;
  checking: boolean;
  /** true: delivered; false: the run ended without it (the queued fallback goes); "abandoned": the session was deleted or the plugin is shutting down (no fallback). */
  settle: (outcome: SteerOutcome) => void;
}

type SteerOutcome = boolean | "abandoned";

/** The wakes of the sessions this OpenCode 2 process has seen, and what its events say about them. */
class OpenCode2Wakes {
  private readonly wakes = new Map<string, InboxWake>();
  private readonly states = new Map<string, SessionState>();
  /** Session ids already looked up (root or child), so each is resolved once. */
  private readonly seen = new Set<string>();
  private readonly controller = new AbortController();
  private eventsAvailable = false;
  /** Send now: steer rows waiting for `session.inbox.delivered`, by row id. */
  private readonly steering = new Map<string, SteerEntry>();

  constructor(
    private readonly v2: V2ContextLike,
    private readonly connection: InboxAgentConnection,
    private readonly resolveRoot: (sessionID: string) => Promise<{ root: string }>,
    /** What this service loaded and what is on disk now (`plugin` on each poll). */
    private readonly pluginReport: () => InboxLoadedPluginReport | null = () => null,
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
        // No more events: a steer still waiting can no longer be seen delivered. It is not given up
        // while the run goes on (OpenCode still promotes it at the next step); its watch asks
        // OpenCode when the session is idle, and reads the session's context then (`watchSteer`).
        this.eventsAvailable = false;
      }
    })();
  }

  /**
   * Resolves true when the steer row `id` is delivered, false when its run
   * ended without it: after the grace that follows the run's end event, or,
   * once the event stream has ended, when OpenCode says the session is idle
   * and the row is not in its context. Never while the run goes on.
   */
  private awaitSteer(sessionID: string, id: string, text: string): Promise<SteerOutcome> {
    return new Promise<SteerOutcome>((resolve) => {
      const entry: SteerEntry = {
        sessionID,
        id,
        text,
        grace: null,
        watch: null,
        checking: false,
        settle: (outcome: SteerOutcome) => {
          if (this.steering.get(id) !== entry) return;
          this.steering.delete(id);
          if (entry.watch) clearInterval(entry.watch);
          if (entry.grace) clearTimeout(entry.grace);
          resolve(outcome);
        },
      };
      this.steering.set(id, entry);
      entry.watch = setInterval(() => void this.watchSteer(entry), STEER_WATCH_MS);
      // Not running any more (the run ended between the busy check and now): the grace starts at once.
      if (!this.state(sessionID).running) this.startGrace(entry);
    });
  }

  /** The run a steer row went into ended: OpenCode may still promote the row; past the grace, the queued turn goes. */
  private startGrace(entry: SteerEntry): void {
    if (!entry.grace) entry.grace = setTimeout(() => entry.settle(false), STEER_IDLE_GRACE_MS);
  }

  /** One look at a steer row still waiting (see `STEER_WATCH_MS`). */
  private async watchSteer(entry: SteerEntry): Promise<void> {
    if (entry.grace || entry.checking || this.steering.get(entry.id) !== entry) return;
    entry.checking = true;
    try {
      const state = this.state(entry.sessionID);
      if (this.eventsAvailable) {
        // A lost end event: no event for a while, and OpenCode says the session is idle.
        if (!state.running || Date.now() - state.lastEventAt < RUNNING_CROSS_CHECK_MS) return;
        state.lastEventAt = Date.now();
        if (!(await this.idleProbe(entry.sessionID))) return;
        state.running = false;
        this.startGrace(entry);
        return;
      }
      // The event stream ended: wait for idle, then read the session's context for the row.
      if (!(await this.idleProbe(entry.sessionID))) return;
      state.running = false;
      entry.settle(await this.steerInContext(entry));
    } finally {
      entry.checking = false;
    }
  }

  /** Whether the session's context holds the steer row (by its id, or a user message with its text); false when it cannot say. */
  private async steerInContext(entry: SteerEntry): Promise<boolean> {
    const context = this.v2.session?.context;
    if (typeof context !== "function") return false;
    try {
      const messages = await context({ sessionID: entry.sessionID });
      if (!Array.isArray(messages)) return false;
      return messages.some((message) => {
        if (!message || typeof message !== "object") return false;
        const record = message as { id?: unknown; type?: unknown; role?: unknown; content?: unknown };
        if (record.id === entry.id) return true;
        if (record.type !== "user" && record.role !== "user") return false;
        if (typeof record.content === "string") return record.content === entry.text;
        return Array.isArray(record.content) && record.content.some((part) => !!part && typeof part === "object" && (part as { text?: unknown }).text === entry.text);
      });
    } catch {
      return false;
    }
  }

  dispose(): void {
    // Shutting down: no fallback is sent; the reply stays undelivered and is picked up at the next start.
    for (const entry of [...this.steering.values()]) entry.settle("abandoned");
    this.controller.abort();
    for (const wake of this.wakes.values()) wake.dispose();
    this.wakes.clear();
  }

  /** Start the wake for a root session, once; later calls say the session is in use here. */
  watch(sessionID: string): void {
    // A disposed generation (OpenCode unloaded this plugin) starts no wake: its polls would report the old version.
    if (this.controller.signal.aborted) return;
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
    // A steer row Send now sent entered the model context: delivered.
    if (type === "session.inbox.delivered" && typeof data?.inboxID === "string") this.steering.get(data.inboxID)?.settle(true);
    // The steer row turned into a queued row: OpenCode will deliver it, so no fallback is sent.
    if (type === "session.inbox.delivery.changed" && typeof data?.inboxID === "string" && data.delivery === "queue") this.steering.get(data.inboxID)?.settle(true);
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
        // A steer row of this session not delivered yet: OpenCode may still promote it; past the grace, it is sent queued.
        for (const entry of this.steering.values()) if (entry.sessionID === sessionID) this.startGrace(entry);
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
        // Its steer rows are given up (their watches stop); a deleted session gets no fallback.
        for (const entry of [...this.steering.values()]) if (entry.sessionID === sessionID) entry.settle("abandoned");
        this.wakes.get(sessionID)?.dispose();
        this.wakes.delete(sessionID);
        return;
    }
  }

  /** A session ran here that this process has not seen: watch its root. */
  private discover(sessionID: string): void {
    if (this.controller.signal.aborted || this.seen.has(sessionID)) return;
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
      // Send now while a run is going (the person pressed it in the Inbox): a
      // steer joins that run at its next step. It counts as delivered only on
      // `session.inbox.delivered` for that row; when the run ends first and
      // OpenCode does not promote the row within the grace (#1734), it goes
      // in as a queued turn instead. Only while the event stream runs, which
      // is how the delivery is seen.
      ...(typeof this.v2.session?.prompt === "function"
        ? {
            // Never into this session's own "Ask this session" question (the Claude Code mod's rule).
            canSteer: () => this.eventsAvailable && !isAskTurnActive(sessionID),
            steer: async (text: string, command: { id: string }) => {
              const prompt = this.v2.session?.prompt;
              if (typeof prompt !== "function") throw new Error("this OpenCode cannot receive a prompt from a plugin");
              const id = createOpenCodeMessageId();
              const delivered = this.awaitSteer(sessionID, id, text);
              await prompt({ sessionID, id, text, delivery: "steer", metadata: { source: INBOX_PROMPT_SOURCE } });
              const outcome = await delivered;
              if (outcome === true) return;
              // Never a fallback into a deleted session or during shutdown: the reply is not delivered (the
              // wake gives its claim back), and the next start picks it up.
              if (outcome === "abandoned") throw new Error("the session was deleted or OpenCode is shutting down");
              // Not seen delivered: a queued turn instead. The steer row may still be promoted with it
              // (#1734; the plugin cannot withdraw it), so the later copy is dropped from model requests.
              const fallback = `${text}\n\n${inboxRepeatLine(command.id)}`;
              recordInboxDuplicate(command.id, text, fallback);
              await prompt({ sessionID, id: createOpenCodeMessageId(), text: fallback, delivery: "queue", metadata: { source: INBOX_PROMPT_SOURCE } });
            },
          }
        : {}),
      notify: (message) => {
        console.error(`[Plannotator] ${message}`);
      },
      // The session's folder (its `location.directory`, looked up once), so the Inbox lists it under its project.
      projectPath: () => this.directory(sessionID),
      // What this service loaded and what is on disk now: the Inbox says `opencode2 reload` when it is behind.
      plugin: () => this.pluginReport(),
    };
  }

  private readonly directories = new Map<string, Promise<string | null>>();

  private directory(sessionID: string): Promise<string | null> {
    let pending = this.directories.get(sessionID);
    if (!pending) {
      pending = (async () => {
        try {
          return (await this.v2.session?.get?.({ sessionID }))?.location?.directory ?? this.v2.location?.directory ?? null;
        } catch {
          return this.v2.location?.directory ?? null;
        }
      })();
      this.directories.set(sessionID, pending);
    }
    return pending;
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
