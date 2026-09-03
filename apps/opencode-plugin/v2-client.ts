/**
 * Duck-typed adapters over the OpenCode 2 plugin context.
 *
 * The V2 plugin API is still pre-release: the published `next` and `latest`
 * dist-tags of `@opencode-ai/plugin` carry an older context shape than the
 * `beta` / `dev` nightlies. Nothing here may import the plugin package at
 * runtime or assume a domain exists: every capability is probed before use so
 * the adapter degrades to today's behavior on an older host.
 */

import type { OpenCodeBridgeAgent } from "./cli-bridge";

/** The subset of the V2 session domain this plugin touches. */
export interface V2SessionDomain {
  get?: (input: { sessionID: string }) => Promise<{ location?: { directory?: string } }>;
  prompt?: (input: { sessionID: string; text: string; delivery?: unknown }) => Promise<unknown>;
  switchAgent?: (input: { sessionID: string; agent: string }) => Promise<unknown>;
  context?: (input: { sessionID: string }) => Promise<unknown>;
  /**
   * Put a message in the session WITHOUT starting a model turn.
   *
   * Optional because it only exists on hosts whose plugin API carries it
   * (`SessionDomain` in `packages/plugin/src/promise/session.ts`); every call
   * site probes it first.
   */
  synthetic?: (input: {
    sessionID: string;
    text: string;
    description?: string;
    resume?: boolean;
  }) => Promise<unknown>;
}

/**
 * The subset of the V2 command domain this plugin touches.
 *
 * `transform` exists on every V2 host and says nothing about capability: the
 * pre-#44765 draft is `{ list, get, update, remove }`. Only the draft handed to
 * the callback can answer that, which is why nothing here treats the presence
 * of `transform` as support.
 */
export interface V2CommandDomain {
  transform?: (apply: (draft: V2CommandDraft) => void) => Promise<unknown> | unknown;
  list?: (input?: unknown) => Promise<unknown>;
  reload?: () => Promise<unknown>;
}

export interface V2ContextLike {
  agent?: { list?: (input?: unknown) => Promise<unknown> };
  session?: V2SessionDomain;
  command?: V2CommandDomain;
  location?: { directory?: string };
}

export interface V2CommandInvocation {
  sessionID: string;
  prompt?: { text?: string };
  /**
   * The admission mode OpenCode chose for the invocation. Carried for
   * completeness and deliberately NOT reused when feedback comes back: see
   * `FEEDBACK_DELIVERY`.
   */
  delivery?: unknown;
}

export interface V2CommandDefinition {
  name: string;
  description?: string;
  execute: (input: V2CommandInvocation) => Promise<void>;
}

/**
 * Post-#44765 draft. `add` is optional in the type because an older host hands
 * the callback a draft without it; every call site must probe before using it.
 */
export interface V2CommandDraft {
  add?: (definition: V2CommandDefinition) => void;
}

export interface V2CommandListEntry {
  name: string;
  description?: string;
}

/** The V1-shaped client `cli-bridge` consumes. */
export interface V2BridgeClient {
  /**
   * Present only when this host can show the session URL to the user. See
   * `createSessionUrlNotifier` and `toastPlannotatorUrl` in `cli-bridge.ts`.
   */
  notifyUrl?: (input: { url: string; message: string }) => Promise<unknown>;
  app: {
    log: (entry: { level: "info" | "error"; message: string }) => void;
    agents: () => Promise<{ data: OpenCodeBridgeAgent[] }>;
  };
  // Widened to `unknown` on purpose: these are handed to `cli-bridge`, whose
  // client interface declares the same operations with `unknown` parameters.
  session: {
    messages: (input: unknown) => Promise<{ data: unknown[] }>;
    prompt: (input: unknown) => Promise<unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/**
 * Unwrap a list response that may or may not be enveloped.
 *
 * The generated client types every `list` as `{ location, data }`, and that is
 * what the documented success shape is. Reading `.data` unconditionally throws
 * on anything else and the throw lands in a caller's catch, where it degrades
 * silently rather than loudly, so both shapes are accepted here instead.
 */
function readEntries(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (isRecord(response) && Array.isArray(response.data)) return response.data;
  return [];
}

/** Read `ctx.command.list()` into name/description pairs, envelope or not. */
export function readListPayload(response: unknown): V2CommandListEntry[] {
  const entries: V2CommandListEntry[] = [];
  for (const entry of readEntries(response)) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    entries.push({
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : undefined,
    });
  }
  return entries;
}

/** Read an agent list, envelope or bare array, without ever throwing. */
export function normalizeAgentList(response: unknown): OpenCodeBridgeAgent[] {
  const entries = readEntries(response);

  const agents: OpenCodeBridgeAgent[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.id === "string"
      ? entry.id
      : typeof entry.name === "string" ? entry.name : undefined;
    if (!name) continue;
    agents.push({
      name,
      description: typeof entry.description === "string" ? entry.description : undefined,
      mode: typeof entry.mode === "string" ? entry.mode : undefined,
      hidden: entry.hidden === true,
    });
  }
  return agents;
}

/** True when this host's session domain can switch the active agent. */
export function supportsSwitchAgent(ctx: V2ContextLike): boolean {
  return typeof ctx.session?.switchAgent === "function";
}

// There is deliberately no `supportsNativeCommands(ctx)`. `ctx.command.transform`
// exists on hosts whose draft predates PR #44765 and has no `add`, so any probe
// from the context alone reports a false positive; the draft itself is the only
// witness. See `native-commands.ts`.

/**
 * Translate `ctx.session.context()` output into the message shape
 * `getRecentAssistantMessages` reads. V2 messages are flat
 * (`{ id, type, time, content }`); V1 nested them under `info` / `parts`.
 */
export function toBridgeMessages(context: unknown): unknown[] {
  if (!Array.isArray(context)) return [];
  return context.filter(isRecord).map((message) => ({
    info: {
      id: typeof message.id === "string" ? message.id : undefined,
      role: typeof message.type === "string" ? message.type : undefined,
      time: isRecord(message.time) ? { created: message.time.created } : undefined,
    },
    parts: Array.isArray(message.content) ? message.content : [],
  }));
}

function joinTextParts(parts: unknown[]): string {
  return parts
    .filter((part): part is { type: string; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Read the session id out of the V1-shaped `{ path: { id } }` request. */
function readSessionId(request: unknown): string | undefined {
  if (!isRecord(request) || !isRecord(request.path)) return undefined;
  return typeof request.path.id === "string" ? request.path.id : undefined;
}

/**
 * How Plannotator feedback is admitted to the session.
 *
 * A command invocation carries its own delivery, but that value was chosen when
 * the user pressed enter, and a review comes back minutes later: replaying a
 * "steer" then would land the feedback in the middle of whatever turn is
 * running now. "queue" is the safe choice for a late arrival. Upstream's own
 * default is "steer" (`packages/core/src/session/prompt.ts`), so this is set
 * explicitly rather than omitted.
 */
const FEEDBACK_DELIVERY = "queue";

/**
 * The one line a user is shown when a Plannotator session opens on OpenCode 2.
 *
 * Deliberately plain and self-contained: it is the whole notice, so it has to
 * name the product and carry the URL on its own.
 */
export function formatSessionUrlNotice(url: string): string {
  return `Plannotator session ready: ${url}`;
}

/**
 * Deliver the session URL as a VISIBLE transcript notice on OpenCode 2.
 *
 * Why this exists: the V2 server-plugin context exposes no `tui` domain, so
 * `toastPlannotatorUrl` optional-chains to a no-op, and this client's
 * `app.log` is `console.error`, which OpenCode discards under both default
 * launch modes (`packages/cli/src/services/standalone.ts` spawns the service
 * with `stderr: "ignore"` unless `OPENCODE_PRINT_LOGS=1`). A remote session
 * suppresses the browser and prints its URL into that discarded stream, so the
 * user saw nothing at all and the command read as a hang.
 *
 * `session.synthetic` is the fix. Verified against anomalyco/opencode
 * `origin/v2`:
 *  - It is on the plugin's own `SessionDomain`
 *    (`packages/plugin/src/promise/session.ts`).
 *  - `resume: false` skips the wake, so nothing starts a model turn:
 *    `if (input.resume !== false && !(yield* get(sessionID)).revert) yield*
 *    execution.wake(sessionID)` (`packages/core/src/session/session.ts`).
 *    Upstream's own Plan-mode reminders use exactly this shape
 *    (`packages/core/src/plugin/plan.ts`).
 *  - A synthetic message is rendered ONLY when it carries a non-empty
 *    `description`: `reduceSessionRows` drops the row otherwise
 *    (`packages/tui/src/routes/session/rows.ts`, pinned upstream by
 *    "hides synthetic messages without descriptions"), and the live append
 *    subscriptions gate on `description?.trim()` too. What the TUI prints is
 *    the DESCRIPTION, not the text (`SessionNoticeMessageV2` in
 *    `packages/tui/src/routes/session/index.tsx`), so the URL must be in both:
 *    `description` to be seen, `text` so the next turn's history carries it.
 *  - Setting no `metadata.source` keeps it on the plain "Notice" row rather
 *    than the subagent/shell completion row.
 *
 * `delivery` is an explicit "queue", mirroring `FEEDBACK_DELIVERY` (#1459).
 * The host default resolves to "steer", and a pending steer row is promoted
 * FIRST by any wake, including spurious idle wakes observed on OpenCode 2
 * betas where `resume: false` defers the immediate wake but a later wake
 * turns the notice into its own model turn. Queue delivery keeps the notice
 * out of every steer-scoped promotion and is a no-op on well-behaved hosts.
 *
 * This does not contradict the reason feedback avoids synthetic injection.
 * Upstream #44788 is about a synthetic message not reliably reaching the MODEL
 * prompt, which is fatal for feedback and irrelevant here: the only claim this
 * makes is that the row is rendered, and the row is rendered from committed
 * message state by `reduceSessionRows`, not from the model's context.
 *
 * Returns undefined on an older host with no `synthetic`, or with no session to
 * post into, in which case the caller falls back to today's log-only behavior.
 */
export function createSessionUrlNotifier(
  ctx: V2ContextLike,
  sessionID: string | undefined,
): ((input: { url: string; message: string }) => Promise<unknown>) | undefined {
  const synthetic = ctx.session?.synthetic;
  if (typeof synthetic !== "function" || !sessionID) return undefined;
  return async ({ url }) => {
    const notice = formatSessionUrlNotice(url);
    return await synthetic({
      sessionID,
      text: notice,
      description: notice,
      resume: false,
      // #1459: never ride the "steer" default; see the delivery note above.
      delivery: FEEDBACK_DELIVERY,
    });
  };
}

/**
 * Build the V1-shaped client `handleCliCommand` and `resolveValidatedTargetAgent`
 * expect, backed by the V2 context. Delivering feedback goes through
 * `ctx.session.prompt`, the direct path, rather than a synthetic-event
 * injection, which is unreliable on some V2 nightlies (upstream #44788).
 *
 * There is deliberately no `tui` domain: the V2 server-plugin context exposes
 * none, and every toast call site in `cli-bridge` is best-effort. `notifyUrl`
 * is the replacement seam for the one message that must actually be seen.
 */
export function createV2BridgeClient(input: {
  ctx: V2ContextLike;
  getAgents: () => Promise<OpenCodeBridgeAgent[]>;
  /**
   * The session this invocation belongs to. Without it there is nowhere to post
   * a transcript notice, and the URL falls back to the log.
   */
  sessionID?: string;
  /** Best-effort warning sink; defaults to stderr. */
  warn?: (message: string) => void;
}): V2BridgeClient {
  const warn = input.warn ?? ((message: string) => console.error(message));
  const loggedUrls = new Set<string>();
  const notifyUrl = createSessionUrlNotifier(input.ctx, input.sessionID);
  return {
    ...(notifyUrl && { notifyUrl }),
    app: {
      agents: async () => ({ data: await input.getAgents() }),
      log: ({ message }) => {
        const url = /https?:\/\/\S+/.exec(message)?.[0];
        if (url && loggedUrls.has(url)) return;
        if (url) loggedUrls.add(url);
        console.error(message);
      },
    },
    session: {
      messages: async (request) => {
        const sessionID = readSessionId(request);
        if (!sessionID) return { data: [] };
        const context = await input.ctx.session?.context?.({ sessionID });
        return { data: toBridgeMessages(context) };
      },
      prompt: async (request) => {
        const sessionID = readSessionId(request);
        if (!sessionID) throw new Error("Plannotator feedback has no OpenCode session to deliver to.");
        const body = isRecord(request) && isRecord(request.body) ? request.body : {};
        const agent = typeof body.agent === "string" ? body.agent : undefined;
        if (agent && typeof input.ctx.session?.switchAgent === "function") {
          // A failed switch must never cost the reviewer their feedback: the
          // same guarantee `switchV2SessionAgent` gives the approval path.
          try {
            await input.ctx.session.switchAgent({ sessionID, agent });
          } catch (error) {
            warn(`[Plannotator] Could not switch the OpenCode session to "${agent}": ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const prompt = input.ctx.session?.prompt;
        if (typeof prompt !== "function") {
          throw new Error("OpenCode 2 host exposes no session.prompt; cannot deliver Plannotator feedback.");
        }
        return await prompt({
          sessionID,
          text: joinTextParts(Array.isArray(body.parts) ? body.parts : []),
          delivery: FEEDBACK_DELIVERY,
        });
      },
    },
  };
}
