/**
 * Duck-typed adapters over the OpenCode 2 plugin context.
 *
 * The build uses the stable @opencode/plugin types, but installed V2 hosts may
 * predate native commands, agent switching or transcript notices. Nothing here
 * imports the plugin package at runtime: optional capabilities are probed so
 * older hosts retain their fallback behavior.
 */

import type { OpenCodeBridgeAgent } from "./cli-bridge";

/** The subset of the V2 session domain this plugin touches. */
export interface V2SessionDomain {
  get?: (input: { sessionID: string }) => Promise<{ location?: { directory?: string } }>;
  prompt?: (input: {
    sessionID: string;
    text: string;
    delivery?: unknown;
    /** Our own inbox/message id (`msg_…`), so its delivery event can be matched. */
    id?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  /** "Ask this session" only: answer from the session's context without a turn. */
  generate?: (input: { sessionID: string; prompt: string }) => Promise<unknown>;
  /** Stops the session's whole current execution. */
  interrupt?: (input: { sessionID: string; resume?: boolean }) => Promise<unknown>;
  /** Resolves once the session is idle (at once when it already is). */
  wait?: (input: { sessionID: string }) => Promise<unknown>;
  switchAgent?: (input: { sessionID: string; agent: string }) => Promise<unknown>;
  switchModel?: (input: {
    sessionID: string;
    model: { providerID: string; id: string; variant?: string };
  }) => Promise<unknown>;
  context?: (input: { sessionID: string }) => Promise<unknown>;
  /**
   * Put a message in the session without starting a model turn NOW.
   *
   * `resume: false` declines the immediate wake; it does not exempt the message
   * from the next promotion, which is what `delivery` governs. Widened to
   * `unknown` like `prompt`'s, because the delivery literals are the host's.
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
    delivery?: unknown;
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

/**
 * The subset of the V2 event domain this plugin touches.
 *
 * `ctx.event.subscribe()` is the public server event stream: the host filters
 * the bus to `EventManifest.ServerDefinitions`
 * (`packages/core/src/plugin/host.ts` @ anomalyco/opencode `origin/v2`
 * 27aaa9ce0e), and the session inbox events are part of that manifest
 * (`SessionEvent.Definitions`, `packages/schema/src/session-event.ts`). Both
 * plugin generations this adapter targets carry it, but it is probed like every
 * other domain.
 */
export interface V2EventDomain {
  subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>;
}

export interface V2ContextLike {
  agent?: { list?: (input?: unknown) => Promise<unknown> };
  session?: V2SessionDomain;
  command?: V2CommandDomain;
  event?: V2EventDomain;
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
  /**
   * Present only for a slash command's client on a host with
   * `session.synthetic`: shows the person that the command failed, as a
   * transcript notice that starts no model turn (`createCommandFailureNotifier`).
   */
  notifyFailure?: (input: { command: string; message: string }) => Promise<unknown>;
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
  /**
   * Release anything this client is watching on the host. Safe to call more
   * than once, and safe never to call — it only shortens the lifetime of the
   * inbox watcher `createNoticePendingTracker` may have opened.
   */
  dispose: () => void;
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
      model: normalizeAgentModel(entry.model),
    });
  }
  return agents;
}

function normalizeAgentModel(value: unknown): OpenCodeBridgeAgent["model"] {
  if (!isRecord(value)) return undefined;
  if (typeof value.providerID !== "string" || !value.providerID) return undefined;
  if (typeof value.id !== "string" || !value.id) return undefined;
  if (value.variant !== undefined && typeof value.variant !== "string") return undefined;
  return {
    providerID: value.providerID,
    id: value.id,
    ...(value.variant ? { variant: value.variant } : {}),
  };
}

/** True when this host's session domain can switch the active agent. */
export function supportsSwitchAgent(ctx: V2ContextLike): boolean {
  return typeof ctx.session?.switchAgent === "function";
}

/** True when this host can persist the model configured for a selected agent. */
export function supportsSwitchModel(ctx: V2ContextLike): boolean {
  return typeof ctx.session?.switchModel === "function";
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
      // V2 assistant messages record their writer (`Session.Message.Assistant`
      // carries `agent: Agent.ID`); /plannotator-last routes feedback to it.
      ...(typeof message.agent === "string" && message.agent ? { agent: message.agent } : {}),
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

/** The session's current agent, or undefined when the host cannot say. */
async function readSessionAgent(ctx: V2ContextLike, sessionID: string): Promise<string | undefined> {
  try {
    const session: unknown = await ctx.session?.get?.({ sessionID });
    return isRecord(session) && typeof session.agent === "string" ? session.agent : undefined;
  } catch {
    return undefined;
  }
}

/** Read the session id out of the V1-shaped `{ path: { id } }` request. */
function readSessionId(request: unknown): string | undefined {
  if (!isRecord(request) || !isRecord(request.path)) return undefined;
  return typeof request.path.id === "string" ? request.path.id : undefined;
}

/**
 * How Plannotator feedback is admitted to the session when nothing of ours is
 * already pending ahead of it.
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
 * How BOTH the session-URL notice and the feedback that follows it are admitted,
 * so OpenCode promotes them into ONE model turn (#1515).
 *
 * OpenCode 2 admits every plugin message — `session.prompt` and
 * `session.synthetic` alike — as a pending inbox row, and `resume: false` only
 * declines to wake the session NOW; it never exempts the row from a later
 * promotion. Promotion is not symmetric between the two delivery kinds
 * (`SessionInbox.promote`, `packages/core/src/session/inbox.ts` @ v2.0.2):
 *
 *  - pending steers are promoted as a BATCH ("publish(db, bus, sessionID,
 *    control === -1 ? steers : steers.slice(0, control))"), so several steer
 *    rows enter the same turn;
 *  - a queued row is promoted ONE AT A TIME (the `limit(1)` select), and only
 *    after the steers.
 *
 * A promoted synthetic becomes a user-role message (`to-llm-message.ts`) and
 * the runner then runs a full model step for it, with no "was this real user
 * input?" guard. So a queued notice sitting ahead of queued feedback is
 * promoted alone and becomes its own model turn, with the reviewer's feedback
 * stuck behind it — exactly what #1515 reports. Riding "steer" for both is what
 * makes the notice and the feedback one batch, which is the same reason
 * upstream's own transcript notices (shell results, `Session.shell`) leave the
 * host default of "steer" in place instead of queueing.
 *
 * Only used while a notice of this client's is STILL an un-promoted row. A
 * review that posted none, and one whose notice something else has already
 * promoted, both keep `FEEDBACK_DELIVERY` and its late-arrival guarantee: see
 * `NoticePendingTracker`.
 */
const CO_PROMOTED_DELIVERY = "steer";

/**
 * Event types by which a host reports that a pending inbox row LEFT the inbox.
 *
 * Two vocabularies are live at once, and this adapter has to speak both:
 *
 *  - `0.0.0-next-*` (older V2 hosts, before the inbox-event rename)
 *    publishes `session.input.promoted` with `data.inputID`
 *    (`SessionInputPromoted` in `@opencode-ai/client`'s generated types).
 *  - v2.0.x and `dev` renamed the inbox events: `session.inbox.delivered` and
 *    `session.inbox.cancelled`, both with `data.inboxID`
 *    (`packages/schema/src/session-event.ts` @ anomalyco/opencode `origin/v2`
 *    27aaa9ce0e, lines 196-223).
 *
 * `promote` publishes `InboxDelivered` for every row it consumes
 * (`SessionInbox.publish`, `packages/core/src/session/inbox.ts`), which is
 * exactly the moment our notice stops being the row ahead of the feedback.
 * Cancellation is treated the same way: the row is gone either way.
 */
const NOTICE_SETTLED_EVENT_TYPES = new Set([
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.input.promoted",
]);

/**
 * Read a settled-inbox-row event into `{ sessionID, inboxID }`, or undefined
 * for anything else on the stream. Tolerates both id spellings, because the two
 * host generations disagree on the field name.
 */
function readSettledInboxRef(
  event: unknown,
): { sessionID: string; inboxID: string } | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined;
  if (!NOTICE_SETTLED_EVENT_TYPES.has(event.type)) return undefined;
  const data = isRecord(event.data) ? event.data : undefined;
  if (!data || typeof data.sessionID !== "string") return undefined;
  const inboxID = typeof data.inboxID === "string"
    ? data.inboxID
    : typeof data.inputID === "string" ? data.inputID : undefined;
  if (!inboxID) return undefined;
  return { sessionID: data.sessionID, inboxID };
}

/**
 * Tracks whether a session-URL notice of OURS is still an un-promoted inbox row.
 *
 * This is the whole point of the type: "pending" must mean "our row is still
 * sitting in the inbox", not "we posted a notice at some point during this
 * review". The two diverge as soon as anything else wakes the session — a user
 * typing an unrelated message promotes every pending steer as one batch
 * (`SessionInbox.promote`, `packages/core/src/session/inbox.ts`), our notice
 * included. A flag that never noticed that would still claim the notice was
 * pending minutes later and steer the reviewer's feedback into the middle of
 * whatever turn is running then — the exact late-arrival case
 * `FEEDBACK_DELIVERY` exists to prevent.
 *
 * Mechanism: subscribe to the host's own event stream and clear the flag when
 * the host reports our row settled. The subscription starts BEFORE the notice
 * is posted (`posting()`), because the row can in principle be promoted between
 * admission and the moment we learn its id; ids seen in that window are
 * buffered and `admitted()` consults the buffer. `posting()` also arms the flag
 * provisionally for the duration of the host round-trip; `admitted()` and
 * `rejected()` both replace that provisional answer with the real one.
 *
 * Degradation, in order:
 *  - no `ctx.event.subscribe` or no `sessionID`: nothing is watched.
 *  - the host accepted the notice but reported no row id: nothing to match.
 *  - the stream throws, ends, or simply never delivers (upstream #44788 reports
 *    it as unreliable on some V2 nightlies).
 * In all three the flag behaves exactly as it did before this tracker existed —
 * pending until our own prompt joins it — so a host that cannot answer the
 * question is never made worse than the release that shipped the co-promotion.
 *
 * Deliberately NOT bounded by a timer instead. A TTL short enough to contain
 * the mis-steer (seconds to a couple of minutes) is far shorter than a real
 * review, so it would give up the #1515 co-promotion on every session that
 * takes longer than the timeout, trading a precise answer for a guess in both
 * directions.
 */
export interface NoticePendingTracker {
  /**
   * A notice is about to be posted: start watching and arm the flag
   * PROVISIONALLY, before the host round-trip. Idempotent.
   *
   * Arming here rather than in `admitted()` closes the window in which the
   * reviewer's feedback could be delivered while `session.synthetic` is still
   * in flight — the flag would read false and the feedback would queue behind
   * a notice that then gets promoted alone as its own model turn, which is
   * #1515. `admitted()` and `rejected()` both correct the provisional answer,
   * so nothing stays armed on a guess.
   */
  posting: () => void;
  /**
   * Record a notice the host ACCEPTED. `inboxID` is the pending row's id when
   * the host reported one (`session.synthetic` answers with the admitted row).
   */
  admitted: (inboxID: string | undefined) => void;
  /**
   * The host REFUSED the notice: nothing of ours is in the inbox, so the
   * provisional arm comes back down and the feedback keeps its late-arrival
   * queue delivery.
   */
  rejected: () => void;
  /** Is a notice of ours still believed to be an un-promoted row? */
  pending: () => boolean;
  /** Our own prompt just joined the notice's promotion; nothing is ahead now. */
  settle: () => void;
  /**
   * End the tracker. TERMINAL, unlike `settle`: a later `posting()` opens no
   * new subscription and a later `admitted()` arms nothing. Safe to call
   * repeatedly.
   */
  dispose: () => void;
}

export function createNoticePendingTracker(
  ctx: V2ContextLike,
  sessionID: string | undefined,
): NoticePendingTracker {
  let pending = false;
  let noticeID: string | undefined;
  /** Rows the host reported settled, including any seen before we knew our id. */
  const settled = new Set<string>();
  let controller: AbortController | undefined;
  /**
   * `stop()` leaves `controller` undefined, which is also the "not watching
   * yet" state `posting()` starts from, so aborting alone cannot express "never
   * again". Without this latch a `notifyUrl` that outlives `dispose()` would
   * open a fresh host subscription with no owner left to abort it — the leak
   * the caller's `finally { client.dispose() }` exists to prevent.
   */
  let disposed = false;

  const stop = () => {
    const own = controller;
    controller = undefined;
    own?.abort();
  };

  return {
    posting: () => {
      if (disposed) return;
      pending = true;
      const subscribe = ctx.event?.subscribe;
      if (controller || typeof subscribe !== "function" || !sessionID) return;
      const own = new AbortController();
      controller = own;
      void (async () => {
        try {
          for await (const event of subscribe({ signal: own.signal })) {
            const ref = readSettledInboxRef(event);
            if (!ref || ref.sessionID !== sessionID) continue;
            settled.add(ref.inboxID);
            if (noticeID !== undefined && ref.inboxID === noticeID) {
              pending = false;
              break;
            }
          }
        } catch {
          // Best effort: an unavailable stream degrades to the old flag, never
          // to an unhandled rejection inside the host's plugin runtime.
        } finally {
          if (controller === own) controller = undefined;
        }
      })();
    },
    admitted: (inboxID) => {
      // After dispose nothing is watching, so a flag raised here could never be
      // lowered again — exactly the stale "still pending" this tracker exists
      // to rule out. Stay unarmed instead.
      if (disposed) return;
      noticeID = inboxID;
      // A row the host already reported settled was never pending for us.
      pending = !(inboxID !== undefined && settled.has(inboxID));
      if (!pending) stop();
    },
    rejected: () => {
      pending = false;
      stop();
    },
    pending: () => pending,
    settle: () => {
      pending = false;
      stop();
    },
    dispose: () => {
      disposed = true;
      pending = false;
      stop();
    },
  };
}

const SESSION_URL_NOTICE_PREFIX = "Plannotator session ready: ";

/**
 * The one line a user is shown when a Plannotator session opens on OpenCode 2.
 *
 * Deliberately plain and self-contained: it is the whole notice, so it has to
 * name the product and carry the URL on its own.
 */
export function formatSessionUrlNotice(url: string): string {
  return `${SESSION_URL_NOTICE_PREFIX}${url}`;
}


/**
 * The notice a slash command posts when it fails (a refused argument, the
 * CLI's startup error): the command and the reason, which is all the person
 * needs to run it again.
 */
export function formatCommandFailureNotice(command: string, message: string): string {
  return `Plannotator /${command} failed: ${message.trim()}`;
}

/**
 * The marker that ends a failure notice's `text` (never its `description`,
 * which is what the person sees and can copy). The context filter matches
 * only text that ends with it, so a message the person TYPES or pastes, such
 * as the failure line followed by "why?", is never dropped from what the
 * model reads. In the one request where the notice is kept (see
 * `dropSessionUrlNotices`), it also tells the model there is nothing to do.
 */
const COMMAND_FAILURE_NOTICE_MARKER = "\n\n(Plannotator notice for the person; not a request.)";

/** The `text` of a failure notice: the visible line plus the marker. */
export function commandFailureNoticeText(command: string, message: string): string {
  return `${formatCommandFailureNotice(command, message)}${COMMAND_FAILURE_NOTICE_MARKER}`;
}

const COMMAND_FAILURE_NOTICE_RE = /^Plannotator \/plannotator-(?:review|annotate|last|snapshot) failed: \S[\s\S]*\n\n\(Plannotator notice for the person; not a request\.\)$/;

/** Is this model-context message one of our transcript notices (session URL or command failure)? */
function isSessionUrlNoticeMessage(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "user") return false;
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) && content.length === 1 && isRecord(content[0]) && content[0].type === "text"
      ? content[0].text
      : undefined;
  if (typeof text !== "string") return false;
  if (COMMAND_FAILURE_NOTICE_RE.test(text)) return true;
  return text.startsWith(SESSION_URL_NOTICE_PREFIX)
    && /^https?:\/\/\S+$/.test(text.slice(SESSION_URL_NOTICE_PREFIX.length));
}

/**
 * Keep our session-URL notices out of what the MODEL reads. Mutates
 * `messages` in place (the `context` hook's array) and returns how many it
 * removed. A slash command's failure notice (`formatCommandFailureNotice`) is
 * the same kind of row, for the person only, and is dropped the same way.
 *
 * The notice is for the person, who sees it as the transcript row's
 * description; the model has no use for it. But it is a pending steer
 * (`CO_PROMOTED_DELIVERY`), and steers are promoted at the next step
 * boundary. During plan review that boundary is the one right after the
 * `submit_plan` tool result, so the next model request read
 * `[…, tool result (the decision), user: "Plannotator session ready: <url>"]`
 * and a model could answer the notice instead of the decision. Seen live on
 * 2.0.22: after a denial the model replied to the URL line. The plugin's
 * session domain cannot withdraw a pending row (no inbox member, see
 * `createV2BridgeClient`), but every model request passes through the
 * `context` hook, so the notice is dropped there, from every request, which
 * also keeps the cached prompt prefix stable.
 *
 * One exception: when the notice is the only thing after the model's own last
 * reply (a notice promoted on its own at an idle boundary), dropping it would
 * send a request that ends on an assistant message. That request exists only
 * because of the notice, so the last notice is kept rather than sending a
 * malformed turn; no decision is involved in that case.
 */
export function dropSessionUrlNotices(messages: unknown[]): number {
  const notices: number[] = [];
  messages.forEach((message, index) => {
    if (isSessionUrlNoticeMessage(message)) notices.push(index);
  });
  if (notices.length === 0) return 0;

  let keep: number | undefined;
  const lastNotice = notices[notices.length - 1];
  if (lastNotice === messages.length - 1) {
    let previous = lastNotice - 1;
    while (previous >= 0 && notices.includes(previous)) previous--;
    const before = messages[previous];
    if (previous < 0 || (isRecord(before) && before.role === "assistant")) keep = lastNotice;
  }

  let removed = 0;
  for (let i = notices.length - 1; i >= 0; i--) {
    if (notices[i] === keep) continue;
    messages.splice(notices[i], 1);
    removed++;
  }
  return removed;
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
 *    `packages/tui/src/routes/session/index.tsx`), so `description` carries
 *    the URL. `text` is the same line, but the model never reads it: the
 *    plugin's `context` hook drops these notices from every model request
 *    (`dropSessionUrlNotices`), because a promoted notice landing after a
 *    plan decision read as the thing to answer.
 *  - Setting no `metadata.source` keeps it on the plain "Notice" row rather
 *    than the subagent/shell completion row.
 *
 * `delivery` is an explicit `CO_PROMOTED_DELIVERY` ("steer"), which is also the
 * host default. #1459 tried "queue" here; #1515 is what that produced, because
 * a queued row is promoted alone while steers are promoted as a batch. See
 * `CO_PROMOTED_DELIVERY` above for the promotion rules and the citations. The
 * feedback that follows rides the same delivery — but only for as long as this
 * notice is still an un-promoted row, which is what `NoticePendingTracker`
 * answers.
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
  notice?: {
    /**
     * Called before the notice is posted, so a watcher is already listening if
     * the row is promoted between admission and the moment its id is known,
     * and so the notice counts as pending for the whole host round-trip rather
     * than only after it.
     */
    posting?: () => void;
    /**
     * Called once the host has ACCEPTED a notice, so the feedback that follows
     * can be admitted with the delivery that co-promotes with it, carrying the
     * admitted row's id when the host reported one. Never called for a rejected
     * notice: nothing is then pending and the plain queue delivery is still the
     * right one.
     */
    admitted?: (inboxID: string | undefined) => void;
    /**
     * Called when the host REFUSED the notice, to undo `posting`'s provisional
     * arm. Nothing of ours is in the inbox then, so the feedback that follows
     * keeps its plain late-arrival delivery.
     */
    rejected?: () => void;
  },
): ((input: { url: string; message: string }) => Promise<unknown>) | undefined {
  const synthetic = ctx.session?.synthetic;
  if (typeof synthetic !== "function" || !sessionID) return undefined;
  return async ({ url }) => {
    const text = formatSessionUrlNotice(url);
    notice?.posting?.();
    let admitted: unknown;
    try {
      admitted = await synthetic({
        sessionID,
        text,
        description: text,
        resume: false,
        // #1515: the notice and the feedback must share one promotion.
        delivery: CO_PROMOTED_DELIVERY,
      });
    } catch (error) {
      notice?.rejected?.();
      throw error;
    }
    notice?.admitted?.(readAdmittedInboxID(admitted));
    return admitted;
  };
}

/**
 * The pending row id out of a `session.synthetic` response, when the host
 * reports one. Both generations answer with the admitted inbox row
 * (`SessionPendingSynthetic` on `0.0.0-next-*`, `SessionInboxSynthetic` on
 * v2.0.x), whose `id` is also the message id the row is promoted under
 * (`SessionInbox.promotedFromMessage` looks the message up by exactly that id).
 * Undefined for any other shape, which degrades the tracker to the old flag.
 */
function readAdmittedInboxID(response: unknown): string | undefined {
  if (!isRecord(response) || typeof response.id !== "string" || !response.id) return undefined;
  return response.id;
}

/**
 * Show the person that a slash command failed, as a transcript notice.
 *
 * Without it a failed command showed nothing at all: the reason went to
 * `app.log`, which OpenCode 2 discards (see `createSessionUrlNotifier`), so
 * `/plannotator-annotate` with a typo read as a command that did nothing.
 *
 * Same mechanism as the session-URL notice, and the same reasons: OpenCode 2's
 * plugin context has no toast surface, and `session.synthetic` with a
 * `description` is a rendered row, while `resume: false` starts no model turn
 * (a slash command never reaches the model unless it says so; the tool's
 * `plannotatorLateFailureText` is a `session.prompt` because there the agent
 * was told to wait). The row is a pending steer, promoted with whatever next
 * wakes the session, and `dropSessionUrlNotices` keeps it out of the model's
 * requests like the URL notice. The one gap is the same as the URL notice's:
 * a row promoted alone at an idle boundary stays in that one request.
 *
 * Undefined on an older host with no `synthetic`, or with no session: the
 * failure then stays in the log, as before.
 */
export function createCommandFailureNotifier(
  ctx: V2ContextLike,
  sessionID: string | undefined,
): ((input: { command: string; message: string }) => Promise<unknown>) | undefined {
  const synthetic = ctx.session?.synthetic;
  if (typeof synthetic !== "function" || !sessionID) return undefined;
  return async ({ command, message }) => {
    const description = formatCommandFailureNotice(command, message);
    const text = commandFailureNoticeText(command, message);
    return await synthetic({ sessionID, text, description, resume: false, delivery: CO_PROMOTED_DELIVERY });
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
  /**
   * Deliver feedback with `FEEDBACK_DELIVERY` ("queue") even while a notice of
   * ours is still pending. For the `plannotator` tool, whose calling session is
   * mid-turn when the notice is posted, so the notice is promoted inside that
   * turn and a steer would push a late decision into a running turn instead.
   */
  alwaysQueue?: boolean;
  /**
   * Post the session-URL notice into `notice.sessionID` instead of
   * `sessionID`, and only while `notice.open()` answers true; once it answers
   * false the URL goes to the log alone. The `plannotator` tool's launches:
   * the notice goes to the calling session while its tool call is open (see
   * `runNativeCommand`), the decision to `sessionID`. Without it every notice
   * goes to `sessionID`, which is what the slash commands need (#1515).
   */
  notice?: { sessionID: string; open: () => boolean };
  /**
   * Show a failed command in `sessionID`'s transcript (`notifyFailure`). For
   * the slash commands; a tool launch reports its failure as the tool result.
   */
  failureNotices?: boolean;
}): V2BridgeClient {
  const warn = input.warn ?? ((message: string) => console.error(message));
  const loggedUrls = new Set<string>();
  // Whether a session-URL notice of ours is still waiting in this session's
  // inbox. It is the only thing that can sit AHEAD of the reviewer's feedback,
  // and the plugin session domain exposes no way to withdraw a pending row
  // (`SessionDomain` is a fixed Pick in `packages/plugin/src/promise/session.ts`
  // with no inbox member, and the host builds that object literally with no
  // inbox member either — `packages/core/src/plugin/host.ts` @ `origin/v2`
  // 27aaa9ce0e — even though the server itself routes `session.inbox.cancel`),
  // so the feedback joins its promotion instead. The tracker is what keeps that
  // "still waiting" honest once something else promotes the row.
  const noticeSessionID = input.notice?.sessionID ?? input.sessionID;
  const notice = createNoticePendingTracker(input.ctx, noticeSessionID);
  const postNotice = createSessionUrlNotifier(input.ctx, noticeSessionID, {
    posting: notice.posting,
    admitted: notice.admitted,
    rejected: notice.rejected,
  });
  const noticeOpen = input.notice?.open;
  const notifyUrl = postNotice && noticeOpen
    // Checked synchronously at the call, before anything is posted.
    ? async (url: { url: string; message: string }) => (noticeOpen() ? postNotice(url) : undefined)
    : postNotice;
  const notifyFailure = input.failureNotices ? createCommandFailureNotifier(input.ctx, input.sessionID) : undefined;
  return {
    ...(notifyUrl && { notifyUrl }),
    ...(notifyFailure && { notifyFailure }),
    dispose: notice.dispose,
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
            // `Session.switchAgent` publishes an `agent-switched` transcript
            // row unconditionally, so skip it when the session is already on
            // that agent — upstream's own command plugin guards the same way
            // (`packages/core/src/config/plugin/command.ts`).
            if (await readSessionAgent(input.ctx, sessionID) !== agent) {
              await input.ctx.session.switchAgent({ sessionID, agent });
            }
          } catch (error) {
            warn(`[Plannotator] Could not switch the OpenCode session to "${agent}": ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const prompt = input.ctx.session?.prompt;
        if (typeof prompt !== "function") {
          throw new Error("OpenCode 2 host exposes no session.prompt; cannot deliver Plannotator feedback.");
        }
        const delivered = await prompt({
          sessionID,
          text: joinTextParts(Array.isArray(body.parts) ? body.parts : []),
          // Co-promotion only helps a notice in THIS session's inbox.
          delivery: notice.pending() && !input.alwaysQueue && sessionID === noticeSessionID
            ? CO_PROMOTED_DELIVERY
            : FEEDBACK_DELIVERY,
        });
        // Admitted: the notice is no longer the row ahead of us, so any later
        // delivery on this client is a plain late arrival again.
        notice.settle();
        return delivered;
      },
    },
  };
}
