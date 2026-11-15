/**
 * The T3 Code wake: the person's reply, message or tag for an agent in a T3
 * Code thread goes into that thread as a new turn. T3 shows it like anything
 * the person typed and runs it with whatever provider the thread uses. One
 * owner per reply, tried in this order:
 *
 *  1. the Claude Code mod, while it polls as the thread (`skip`,
 *     `createT3ModOwner`): it puts the reply in as a turn of the running
 *     session. A T3 here that stops takes that Claude with it: the wake looks
 *     again within seconds (`T3Local.onceStopped`);
 *  2. T3 on this machine (`local`, inbox-t3-local.ts): `t3 thread send`, no
 *     sign-in. Its claim folder (`inbox/t3-send/`) is made before the call: a
 *     call that ran out of time keeps it, and the reply is saved for the
 *     agent's next read, never sent again by any way. A call T3 refused
 *     outright (closed, no such thread, another failure) gives it up;
 *  3. a saved grant, through T3's MCP API (`t3_thread_send`, queued, never
 *     steered): a T3 on another machine, or one this machine's command does
 *     not reach;
 *  4. none: the reply waits and says why (`t3_wait`). A closed T3 here is
 *     looked for every few seconds and the reply goes in once it runs.
 *
 * T3 sets T3CODE_THREAD_ID in every process its Claude starts, its MCP
 * servers included (a Codex thread in T3 is the Codex wake's, through the same
 * `t3` command: inbox-codex-wake.ts), and the stdio shim sends as
 * `agent_host: "t3"` with that id (apps/hook/server/inbox-mcp-shim.ts). A
 * message wakes when T3 here has that thread (`t3 thread show`), or when this
 * Inbox holds a T3 grant (`plannotator t3 login`, packages/t3-code) whose
 * environment has it. With a grant:
 *
 *  - T3 takes a send idempotently (`clientRequestId`, kept on disk by
 *    T3Delivery), so an item is delivered as soon as T3 accepted it: T3 owns
 *    the turn from there, and a send cut short is sent again under the same id;
 *  - a thread T3 no longer has is ended, and alive again when it next calls
 *    the Inbox; a send T3Delivery refuses (an uncertain send from before a new
 *    login) is never retried: the agent sees it when it reads the thread;
 *  - a grant sends only into a thread whose mode it covers. Its mode comes
 *    from the scope T3 granted (Read only has no `orchestration:operate`; Full
 *    access alone has `settings:write`) and from what T3 says when it denies a
 *    send; the thread's mode from `t3_thread_read`. A thread the grant cannot
 *    send into is not offered as woken, so its agent is told to read later;
 *  - a send T3 denies for the grant's mode (`capability_denied`: a Read only
 *    grant, so no thread under it wakes; `runtime_mode_escalation_denied` or
 *    `interaction_mode_escalation_denied`: the thread runs in a mode above the
 *    grant's) is never retried either, and the grant's mode is kept until a
 *    new `plannotator t3 login`;
 *  - any other failure is tried again later (30 s, doubling to 10 min). With
 *    no grant that reaches the thread, nothing is retried on a timer: the
 *    reply waits for the next look. A T3 error on the lookup that is not an
 *    answer about the grant or the thread (`orchestration_error`) is a failure
 *    to reach T3, kept on the backoff;
 *  - on an agent's send_message, the lookup gets a few seconds
 *    (`lookupTimeoutMs`): a T3 that does not answer by then is not promised;
 *  - what holds a reply the thread owns (no sign-in saved, one T3 refused,
 *    a mode that does not cover the thread, T3 not answering) is written on
 *    the reply (`t3_wait`), so every window that shows the thread, a linked
 *    machine's included, says it. Saved grants whose T3 does not have the
 *    thread write nothing: no sign-in here fixes that.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_T3_HOST, isT3ThreadId, type InboxMessage, type InboxT3Status, type InboxT3WaitReason } from "@plannotator/core/inbox-types";
import { inboxClaimDirs } from "@plannotator/shared/inbox/claims";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { T3Credentials } from "@plannotator/t3-code/auth";
import type { T3Rpc } from "@plannotator/t3-code/t3-client";
import { codexQueueMessage } from "./inbox-codex-wake";
import { createT3Claims, INBOX_T3_READ_BACK_AFTER_MS, type T3Local, type T3Route, type T3Try, tryThroughT3 } from "./inbox-t3-local";

/** The T3 client loads only once a grant exists: every other CLI start skips the MCP client. */
let t3Modules: Promise<[typeof import("@plannotator/t3-code/auth"), typeof import("@plannotator/t3-code/delivery"), typeof import("@plannotator/t3-code/t3-client")]> | null = null;
const loadT3 = () => (t3Modules ??= Promise.all([import("@plannotator/t3-code/auth"), import("@plannotator/t3-code/delivery"), import("@plannotator/t3-code/t3-client")]));

const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** How long "no grant reaches this thread" is believed before asking T3 again, while the saved grants stay the same. */
const MISS_TTL_MS = 60_000;
/** While a reply waits on a grant (none reaches its thread, or none covers its mode), how often a new login is looked for. */
const GRANT_CHECK_MS = 15_000;
/** What T3 says for a thread it does not have (apps/server/src/mcp/threadAccess.ts: "Thread <id> was not found."). */
const THREAD_GONE = /\bthread_not_found\b|thread was not found|calling thread was not found|archived/i;
/** A lookup T3 answered about the grant or the thread; anything else (a network failure, `orchestration_error`) did not reach it and is tried again. */
const T3_ANSWERED = /\b(thread_not_found|capability_denied|target_required)\b|thread was not found|different thread|\b401\b|unauthorized/i;
/** T3 refused the saved grant itself: lapsed (a sign-in lasts 30 days) or revoked. */
const GRANT_REFUSED = /\b401\b|unauthorized/i;
/** How long an agent's send_message waits on T3 to learn whether its thread wakes. */
const LOOKUP_TIMEOUT_MS = 3_000;
/** What T3 answers when the grant's mode does not cover the thread (its OrchestratorMcpFailure codes). */
const MODE_DENIED = /\b(capability_denied|runtime_mode_escalation_denied|interaction_mode_escalation_denied)\b/;

/** T3's runtime modes, narrowest first (T3's delegatedTaskModes.ts). */
const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
type T3RuntimeMode = (typeof RUNTIME_MODES)[number];
const runtimeModeOf = (value: unknown): T3RuntimeMode | null => (RUNTIME_MODES as readonly unknown[]).includes(value) ? (value as T3RuntimeMode) : null;
const rank = (mode: T3RuntimeMode) => RUNTIME_MODES.indexOf(mode);
/** What a grant may send into: Read only nothing, a runtime mode up to it, or (scope only) anything below Full access. */
type T3Ceiling = "read-only" | T3RuntimeMode | "below-full-access";

/**
 * The grant's mode as its OAuth scope says it (T3's `mcpClientScopes`): Read
 * only has no `orchestration:operate`, Full access alone has `settings:write`.
 * Null when the grant has no scope saved.
 */
export function t3CeilingOfScope(scope: unknown): T3Ceiling | null {
  if (typeof scope !== "string") return null;
  const scopes = scope.split(/\s+/);
  if (!scopes.includes("orchestration:operate")) return "read-only";
  return scopes.includes("settings:write") ? "full-access" : "below-full-access";
}

/**
 * The grant's mode as T3's denial words it: "approved for read-only access",
 * "Child runtime mode … is broader than parent mode auto." (the parent is the
 * grant here); an interaction mode is named as one.
 */
export function t3GrantModeOf(said: string): string | null {
  if (/read-only access/i.test(said)) return "read-only";
  const mode = /parent mode ([a-z-]+)/i.exec(said)?.[1] ?? null;
  return mode && /interaction mode/i.test(said) ? `interaction mode ${mode}` : mode;
}

/** The log line for a send T3 denied for the grant's mode. */
export function t3ModeDeniedLine(itemId: string, thread: string, code: string, mode: string | null, endpoint: string): string {
  return `T3 refused ${itemId} for thread ${thread} (${code}): the saved grant (${mode ?? "its mode"}) cannot send into that thread. It waits in the Inbox for the agent's next read. To wake it, run \`plannotator t3 login --url ${endpoint}\` and choose a mode that covers the thread.`;
}

export interface InboxT3Wake {
  /** Whether a message from this host and session wakes it: a T3 thread a saved grant reaches. */
  wakes(host: unknown, session: unknown): Promise<boolean>;
  /** `alive` (a T3 thread the Inbox wakes), `dead` (T3 no longer has it), null (not a T3 thread, or one no saved grant reaches). */
  status(session: string): "alive" | "dead" | null;
  /** The saved sign-ins for Settings: none, one that can send, only Read only ones, or ones T3 refused (401). */
  signIn(): Promise<InboxT3Status["sign_in"]>;
  /** T3 said it no longer has the thread, promised or not, and the thread has not called the Inbox since. */
  gone(session: string): boolean;
  /** The thread called an Inbox tool: it is there. */
  noteToolCall(session: string): void;
  /** A send T3Delivery refused, or one `t3 thread send` may have put in: the window says it is saved for the agent's next read. */
  uncertain(session: string, itemId: string): boolean;
  uncertainItems(session: string): string[];
  /** Whether the wake holds this item for the thread now (a sweep works on it, or a `t3 thread send` claim is on disk): the bridge never hands it to the mod. */
  holds(session: string, item: InboxMessage): boolean;
  sweep(): Promise<void>;
  stop(): void;
}

export type T3Connect = (endpoint: URL, token: () => string | undefined) => Promise<T3Rpc>;

/** The line for a thread the grant's mode does not cover, found before any send. */
export function t3NotCoveredLine(thread: string, grantMode: string, threadMode: string | null, endpoint: string): string {
  return `The saved T3 grant (${grantMode === "below-full-access" ? "below Full access" : grantMode}) cannot send into thread ${thread}${threadMode ? ` (it runs ${threadMode})` : ""}, so the Inbox does not wake it: its replies wait for the agent's next read. To wake it, run \`plannotator t3 login --url ${endpoint}\` and choose a mode that covers the thread.`;
}

/**
 * Whether the Claude Code mod is the one to deliver a reply to a T3 thread (the T3 wake's `skip`, inbox.ts): while
 * it polls as the thread, and for an item its claim folder holds. A T3 here that is not running took its Claude
 * with it, so then only a poll held open right now counts, not one that ended within the live window: the reply
 * reads as waiting for T3 at once. Nor does that ended poll count once T3 runs again: the mod is back only with a
 * poll held open, so a T3 reopened within the window gets the reply at once. `resweep` asks for the wake to look
 * again after that many ms.
 */
export function createT3ModOwner(options: {
  local?: T3Local;
  holdsPoll: (session: string) => boolean;
  polledLately: (session: string) => boolean;
  claimed: (item: InboxMessage, session: string) => boolean;
  resweep: (ms: number) => void;
  liveMs: number;
  probeMs: number;
}): (item: InboxMessage, session: string) => boolean {
  /** Threads whose mod was seen gone with T3: their last poll no longer counts, until one is held open again. */
  const lost = new Set<string>();
  return (item, session) => {
    const closed = options.local?.installed() === true && !options.local.running();
    const held = options.holdsPoll(session);
    const lately = options.polledLately(session);
    if (held || !lately) lost.delete(session);
    else if (closed) lost.add(session);
    if (held || (lately && !lost.has(session))) {
      // Looked at again once the poll would be stale: a Claude T3 stopped leaves its replies to the T3 wake. With T3
      // here closed, a poll still open is one whose end is on its way: looked at again in a moment.
      options.resweep(closed ? options.probeMs : options.liveMs + 1_000);
      return true;
    }
    return options.claimed(item, session);
  };
}

interface Link {
  credentials: T3Credentials;
  rpc: T3Rpc;
}

export function createInboxT3Wake(options: {
  store: InboxStore;
  dataDir: string;
  commandOf: (item: InboxMessage, session: string) => InboxReplyCommand;
  /** An item not to hand at all (a steps-only Tidy wake once steps are off: the server withdraws it). */
  skip?: (item: InboxMessage, session: string) => boolean;
  /** How the wake reaches T3 (tests pass a scripted one). Default: T3's MCP over HTTP. */
  connect?: T3Connect;
  /** T3 on this machine, tried before any grant (inbox-t3-local.ts). */
  local?: T3Local;
  now?: () => number;
  log?: (line: string) => void;
  /** Each reply that went into a T3 thread, and each that starts to wait (the debug log's `t3_route` line). */
  route?: (route: T3Route) => void;
  /** How long an agent's send_message waits on T3 (default 3 s). */
  lookupTimeoutMs?: number;
  /** How often a new login is looked for while a reply waits on one (default 15 s). */
  grantCheckMs?: number;
}): InboxT3Wake {
  const { store, dataDir } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  const connect: T3Connect = options.connect ?? (async (endpoint, token) => (await loadT3())[2].T3Client.connect(endpoint, token));
  const { local } = options;
  const routed = (route: T3Route["route"], item: InboxMessage, reason?: string) =>
    options.route?.({ route, agent: "claude", thread: item.thread_id, reply: item.id, ...(reason ? { reason } : {}) });
  let stopped = false;
  const stopping = new AbortController();

  // ── The grants, and which one reaches a thread ──
  const grants = async (): Promise<T3Credentials[]> => {
    const root = join(dataDir, "t3-code");
    const found: T3Credentials[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((name) => existsSync(join(root, name, "oauth.json")));
    } catch {
      return found;
    }
    if (names.length === 0) return found;
    const [{ T3Credentials }] = await loadT3();
    for (const name of names) {
      const path = join(root, name, "oauth.json");
      try {
        const credentials = new T3Credentials(dataDir, new URL((JSON.parse(readFileSync(path, "utf8")) as { endpoint: string }).endpoint));
        if (credentials.token()) found.push(credentials);
      } catch {
        // Not a grant this build reads.
      }
    }
    return found;
  };
  const epochOf = (credentials: T3Credentials): string | undefined => {
    try {
      return credentials.read()?.epoch;
    } catch {
      return undefined;
    }
  };
  /** The saved grants as a value: each login and logout changes it. */
  const markOf = (found: T3Credentials[]): string => found.map((credentials) => `${credentials.endpoint.href} ${epochOf(credentials) ?? ""}`).sort().join("\n");
  const links = new Map<string, Promise<Link>>();
  const linkOf = (credentials: T3Credentials): Promise<Link> => {
    const key = credentials.endpoint.href;
    let link = links.get(key);
    if (!link) {
      link = connect(credentials.endpoint, credentials.token).then((rpc) => ({ credentials, rpc }));
      link.catch(() => links.delete(key));
      links.set(key, link);
    }
    return link;
  };
  const homes = new Map<string, Link>();
  /** When no grant reached the thread, and the grants then: a new login asks again at once. `lapsed`: T3 refused a saved grant (401). */
  const misses = new Map<string, { at: number; grants: string; lapsed: boolean }>();
  /** Each thread's runtime mode, as T3 last said it. */
  const threadModes = new Map<string, T3RuntimeMode>();
  /** The grant's mode T3 named in a denial, per endpoint, with that grant's epoch: a new login clears it. */
  const learned = new Map<string, { epoch: string; ceiling: T3Ceiling }>();
  const grantOf = (link: Link) => {
    try {
      return link.credentials.read();
    } catch {
      return undefined;
    }
  };
  const ceilingOf = (link: Link): T3Ceiling | null => {
    const grant = grantOf(link);
    const known = learned.get(link.credentials.endpoint.href);
    if (known && known.epoch === grant?.epoch) return known.ceiling;
    return t3CeilingOfScope((grant?.tokens as { scope?: unknown } | undefined)?.scope);
  };
  /** Whether the grant's mode covers the thread's, as far as either is known. */
  const covers = (link: Link, thread: string): boolean => {
    const ceiling = ceilingOf(link);
    if (ceiling === null) return true;
    if (ceiling === "read-only") return false;
    const mode = threadModes.get(thread);
    if (!mode) return true;
    return ceiling === "below-full-access" ? mode !== "full-access" : rank(mode) <= rank(ceiling);
  };
  /** The grant whose environment has the thread; null when none does; "unreachable" when T3 could not be asked. */
  const homeOf = async (thread: string): Promise<Link | null | "unreachable"> => {
    const known = homes.get(thread);
    // Logged out, or the grant lapsed: asked again (and found by no grant).
    if (known && known.credentials.token()) return known;
    homes.delete(thread);
    const found = await grants();
    const mark = markOf(found);
    const missed = misses.get(thread);
    if (missed && missed.grants === mark && now() - missed.at < MISS_TTL_MS) return null;
    let unreachable = false;
    let lapsed = false;
    for (const credentials of found) {
      try {
        const link = await linkOf(credentials);
        const read = await new (await loadT3())[2].T3Thread(link.rpc, thread).read({ limit: 1 });
        const mode = runtimeModeOf((read.thread as { runtimeMode?: unknown }).runtimeMode);
        if (mode) threadModes.set(thread, mode);
        homes.set(thread, link);
        misses.delete(thread);
        return link;
      } catch (error) {
        // Not this environment's thread or a refused grant is an answer; a network failure is not.
        const said = error instanceof Error ? error.message : String(error);
        if (!T3_ANSWERED.test(said)) unreachable = true;
        else if (GRANT_REFUSED.test(said)) lapsed = true;
      }
    }
    if (unreachable) return "unreachable";
    misses.set(thread, { at: now(), grants: mark, lapsed });
    return null;
  };

  // ── The sessions it wakes ──
  let known: Set<string> | null = null;
  const knownSessions = (): Set<string> => (known ??= store.wakingSessionsOfHost(INBOX_T3_HOST));
  /**
   * The threads a sweep looks at: those, and every T3 thread that wrote though nothing was promised then (no
   * grant yet, a lapsed one, T3 not answering): a reply to it goes in once a grant reaches it.
   */
  let swept: Set<string> | null = null;
  const sweptSessions = (): Set<string> =>
    (swept ??= new Set([...knownSessions(), ...[...store.agentSessionsOfHost(INBOX_T3_HOST)].filter(isT3ThreadId)]));
  const dead = new Set<string>();
  /**
   * Items kept without a send, for the agent's next read: under the grant (endpoint and epoch) whose mode did not
   * cover the thread, until another login; or for good (null), a send T3Delivery refused.
   */
  const refused = new Map<string, { endpoint: string; epoch: string } | null>();
  const refuseUnder = (key: string, link: Link) => {
    const epoch = grantOf(link)?.epoch;
    refused.set(key, epoch ? { endpoint: link.credentials.endpoint.href, epoch } : null);
  };
  /** Threads T3 denied a send into for the grant's mode, with that grant's epoch: a new login clears it. */
  const denied = new Map<string, string>();
  const deniedNow = (session: string, link: Link): boolean => {
    const epoch = denied.get(session);
    if (epoch === undefined) return false;
    if (grantOf(link)?.epoch === epoch) return true;
    denied.delete(session);
    return false;
  };
  /** Whether a reply to the thread can go in under this grant. */
  const sendsInto = (session: string, link: Link): boolean => !deniedNow(session, link) && covers(link, session);

  // ── T3 on this machine ──
  /** Threads `t3 thread show` or a send found here. */
  const localHas = new Set<string>();
  /** Threads T3 here said it does not have: the next ways are tried without asking it again, until the thread calls in. */
  const localGone = new Set<string>();
  /** The claim on each `t3 thread send`, on disk (inbox-t3-local.ts): the one record of a send that may have gone, across restarts. */
  const claims = createT3Claims(join(store.dir, "t3-send"), now);
  /** Items whose send may have gone, until the thread read back says (`checking`): saved, in the window. */
  const checking = new Set<string>();
  /** The messages a sweep works on now, by thread: from the moment it picks them, the bridge hands none to the mod. */
  const working = new Map<string, Set<string>>();
  /** Whether a closed T3 here is looked for (`T3Local.onceRunning`). */
  let localAwaited = false;
  const awaitLocal = () => {
    if (!local || localAwaited) return;
    localAwaited = true;
    local.onceRunning(() => {
      localAwaited = false;
      // Back: what waited on a retry goes now too.
      retryAt.clear();
      void sweep();
    });
  };
  /**
   * Whether a running T3 here is watched for stopping (`T3Local.onceStopped`): while the mod has a reply, a T3 that
   * quits takes that Claude with it, and the reply should say it waits for T3 within seconds, not once the poll is stale.
   */
  let stopAwaited = false;
  const awaitStopped = () => {
    if (!local || stopAwaited) return;
    stopAwaited = true;
    local.onceStopped(() => {
      stopAwaited = false;
      void sweep();
    });
  };

  const wakesItem = (item: InboxMessage, session: string): boolean => {
    if (!store.isOwner(item, session)) return item.tags?.some((tag) => tag.session === session && tag.host === INBOX_T3_HOST && tag.wakes) ?? false;
    if (item.to) return item.to.host === INBOX_T3_HOST;
    const asked = item.reply_to ? store.message(item.reply_to) : null;
    return asked?.author.kind === "agent" && asked.author.host === INBOX_T3_HOST && isT3ThreadId(asked.author.session);
  };

  const retryAt = new Map<string, { at: number; wait: number }>();
  const failuresSaid = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (retryAt.size === 0 || stopped) return;
    const next = Math.min(...[...retryAt.values()].map((retry) => retry.at));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void sweep();
    }, Math.max(0, next - now()) + 10);
    (retryTimer as { unref?: () => void }).unref?.();
  };
  // `plannotator t3 login` runs in another process and tells the Inbox nothing: while a reply waits on a grant,
  // the saved grants are read again on this timer, and a change sweeps.
  let grantTimer: ReturnType<typeof setTimeout> | null = null;
  const watchGrants = (mark: string | null) => {
    if (grantTimer) clearTimeout(grantTimer);
    grantTimer = null;
    if (mark === null || stopped) return;
    grantTimer = setTimeout(() => {
      grantTimer = null;
      void grants().then((found) => (markOf(found) === mark ? watchGrants(mark) : void sweep()), () => watchGrants(mark));
    }, options.grantCheckMs ?? GRANT_CHECK_MS);
    (grantTimer as { unref?: () => void }).unref?.();
  };
  const sayOnce = (line: string) => {
    if (failuresSaid.has(line)) return;
    failuresSaid.add(line);
    log(line);
  };

  const backOff = (key: string) => {
    const wait = Math.min((retryAt.get(key)?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
    retryAt.set(key, { at: now() + wait, wait });
  };

  const keyOf = (item: InboxMessage, session: string) => `${store.deliveryIdOf(item, session)}.${session}`;
  // An item id has no dot; a T3 thread id may, and may end in another thread's id (a native id that does).
  const itemOfKey = (key: string) => key.slice(0, key.indexOf("."));
  const sessionOfKey = (key: string) => key.slice(key.indexOf(".") + 1);

  /** Whether another way took the item since this sweep picked it (the mod's claim folder, a delivery). */
  const takenElsewhere = (item: InboxMessage, session: string): boolean => {
    const fresh = store.message(item.id);
    if (!fresh || fresh.taken_back_at) return true;
    if (store.isOwner(fresh, session) ? !!fresh.delivery : !!fresh.tags?.some((tag) => tag.session === session && tag.delivery)) return true;
    return inboxClaimDirs(store.dir, store.deliveryIdOf(fresh, session), session).some((dir) => existsSync(dir));
  };
  /** A retry soon after a send that may have gone: the thread is read back then. */
  const checkSoon = (key: string) => {
    const wait = Math.min(Math.max((retryAt.get(key)?.wait ?? 0) * 2, INBOX_T3_READ_BACK_AFTER_MS), RETRY_MAX_MS);
    retryAt.set(key, { at: now() + wait, wait });
  };

  /** One item through `t3 thread send` (`tryThroughT3`): the claim, the send, and the read-back of one that may have gone. */
  const tryLocal = async (item: InboxMessage, session: string): Promise<T3Try | "held"> => {
    const id = store.deliveryIdOf(item, session);
    const key = `${id}.${session}`;
    // Picked before anything waited; asked again now, just before the claim.
    if (!claims.has(id, session) && takenElsewhere(item, session)) return "held";
    const command = options.commandOf(item, session);
    const tried = await tryThroughT3({ local: local!, claims, itemId: id, session, t3Thread: session, marker: command.id, text: codexQueueMessage(command), now, signal: stopping.signal, log });
    if (tried === "delivered") {
      claims.drop(id, session);
      checking.delete(key);
      retryAt.delete(key);
      localHas.add(session);
      try {
        store.recordDelivery(id, { host: INBOX_T3_HOST, session });
      } catch {
        // Gone, or no longer this session's.
      }
      routed("t3_send", item);
    } else if (tried === "checking") {
      checking.add(key);
      checkSoon(key);
      if (!local!.running()) awaitLocal();
    } else {
      checking.delete(key);
      if (tried === "gone") {
        localHas.delete(session);
        localGone.add(session);
      }
    }
    return tried;
  };

  /** What the item's wait reads after a try: a reason, null (nothing holds it), undefined (as it was). */
  const deliverOne = async (link: Link, item: InboxMessage, session: string): Promise<InboxT3WaitReason | null | undefined> => {
    const id = store.deliveryIdOf(item, session);
    const key = `${id}.${session}`;
    const retry = retryAt.get(key);
    if (retry && retry.at > now()) return undefined;
    const text = codexQueueMessage(options.commandOf(item, session));
    const [, { T3Delivery, T3DeliveryRefused }, { T3Thread }] = await loadT3();
    if (id === item.id && !store.handover.hand(item, session, "t3")) return null;
    let delivery: InstanceType<typeof T3Delivery> | null = null;
    try {
      // One request per item (the delivery folder is the thread's): a retry re-sends the first words, so a thread
      // renamed between two tries is still one T3 turn.
      delivery = new T3Delivery(new T3Thread(link.rpc, session), link.credentials);
      await delivery.sendFirst(text, `plannotator-inbox-${id}`);
      retryAt.delete(key);
      try {
        store.recordDelivery(id, { host: INBOX_T3_HOST, session });
      } catch {
        // Gone, or no longer this session's.
      }
      routed("grant", item);
      return null;
    } catch (error) {
      const said = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
      const code = MODE_DENIED.exec(said)?.[1];
      if (code || error instanceof T3DeliveryRefused || THREAD_GONE.test(said)) store.handover.giveBack(id, session);
      if (code) {
        retryAt.delete(key);
        refuseUnder(key, link);
        // T3 took nothing: a login whose mode covers the thread sends it then, as a new request.
        delivery?.denied(`plannotator-inbox-${id}`);
        const epoch = grantOf(link)?.epoch;
        if (epoch) {
          denied.set(session, epoch);
          // The grant's mode, for every thread under it: Read only sends nowhere, a runtime mode only up to it.
          const mode = t3GrantModeOf(said);
          const ceiling: T3Ceiling | null = mode === "read-only" ? "read-only" : code === "runtime_mode_escalation_denied" ? runtimeModeOf(mode) : null;
          if (ceiling) learned.set(link.credentials.endpoint.href, { epoch, ceiling });
          const threadMode = runtimeModeOf(/runtime mode ([a-z-]+) is broader/i.exec(said)?.[1]);
          if (threadMode) threadModes.set(session, threadMode);
        }
        sayOnce(t3ModeDeniedLine(item.id, session, code, t3GrantModeOf(said), link.credentials.endpoint.href));
        return "access";
      }
      if (error instanceof T3DeliveryRefused) {
        retryAt.delete(key);
        refused.set(key, null);
        log(`T3 refused ${item.id} for thread ${session} (${said}); it waits in the Inbox for the agent's next read.`);
        return null;
      }
      if (THREAD_GONE.test(said)) {
        retryAt.delete(key);
        dead.add(session);
        homes.delete(session);
        log(`T3 no longer has thread ${session} (${said}); the reply waits in the Inbox for the next agent.`);
        return null;
      }
      backOff(key);
      // A refused grant may be a new login on another URL: ask again which grant reaches the thread.
      homes.delete(session);
      sayOnce(`T3 send failed: ${said}. Trying again later.`);
      return undefined;
    }
  };

  let sweeping: Promise<void> | null = null;
  let again = false;
  const sweepOnce = async (): Promise<void> => {
    const sessions = sweptSessions();
    if (sessions.size === 0) return watchGrants(null);
    const pending = store.pendingRepliesFor(sessions, { tags: true });
    const found = pending.size > 0 ? await grants() : [];
    const mark = markOf(found);
    // Kept under a grant that is no longer the endpoint's (a new login, a logout): looked at again.
    const epochs = new Map(found.map((credentials) => [credentials.endpoint.href, epochOf(credentials)]));
    for (const [key, under] of [...refused]) if (under && epochs.get(under.endpoint) !== under.epoch) refused.delete(key);
    let noGrant = false;
    const pendingKeys = new Set<string>();
    /** Items this pass could send: a retry is kept only for those, so nothing that cannot go runs a timer. */
    const sendable = new Set<string>();
    /** Why each reply the thread owns waits, as this pass found it (`t3_wait`); one it did not look at keeps its own. */
    const waits = new Map<string, InboxT3WaitReason | null>();
    const waitOf = (item: InboxMessage, session: string, wait: InboxT3WaitReason | null | undefined) => {
      if (wait !== undefined && store.isOwner(item, session) && store.deliveryIdOf(item, session) === item.id) waits.set(item.id, wait);
    };
    const recordWaits = () => {
      for (const [id, wait] of waits) {
        const before = store.message(id);
        if (wait && before && before.t3_wait !== wait) routed("waiting", before, wait);
        try {
          store.recordT3Wait(id, wait);
        } catch {
          // Gone meanwhile.
        }
      }
    };
    for (const [session, items] of pending) {
      const held = items.filter((item) => wakesItem(item, session) && claims.has(store.deliveryIdOf(item, session), session));
      const skipped = items.filter((item) => !held.includes(item) && wakesItem(item, session) && options.skip?.(item, session));
      const work = items.filter((item) => !held.includes(item) && !skipped.includes(item) && wakesItem(item, session));
      // Not the wake's to send (its connection delivers it, or it is withdrawn): nothing here holds it.
      for (const item of items) if (!work.includes(item) && !held.includes(item)) waitOf(item, session, null);
      // The mod's to deliver while T3 here runs: looked at again as soon as T3 stops.
      if (skipped.length > 0 && local?.installed() && local.running()) awaitStopped();
      for (const item of [...held, ...work]) pendingKeys.add(keyOf(item, session));
      for (const item of held) {
        // A send that may have gone: this wake's alone, saved in the window until the thread is read back.
        checking.add(keyOf(item, session));
        sendable.add(keyOf(item, session));
        waitOf(item, session, null);
      }
      if (dead.has(session)) {
        for (const item of work) waitOf(item, session, null);
        continue;
      }
      for (const item of work) {
        const key = keyOf(item, session);
        if (refused.has(key)) waitOf(item, session, refused.get(key) ? "access" : null);
      }
      let todo = [...held, ...work.filter((item) => !refused.has(keyOf(item, session)))];
      if (todo.length === 0) continue;
      // Picked: from here no poll of the bridge hands these to the mod (a first send may start the thread's
      // Claude, whose mod then polls), and each is handed over at once, before anything waits.
      const picked = new Set(todo.map((item) => item.id));
      working.set(session, picked);
      const handed = new Set<string>();
      for (const item of todo) if (store.deliveryIdOf(item, session) === item.id && store.handover.hand(item, session, "t3")) handed.add(item.id);
      /** Items a way took up this pass (delivered, kept to read back, or given to a grant's send): the rest are handed back. */
      const taken = new Set<string>(held.map((item) => item.id));
      try {
      // T3 here, closed: nothing to try on it until it runs again, looked for every few seconds.
      const localClosed = local?.installed() === true && !local.running();
      if (localClosed) awaitLocal();
      // Every item still inside its backoff: kept, and T3 is not asked until one comes due.
      if (todo.every((item) => (retryAt.get(keyOf(item, session))?.at ?? 0) > now())) {
        for (const item of todo) sendable.add(keyOf(item, session));
        continue;
      }
      // What T3 here said of the items it did not take: none of them sent, so a grant may.
      let localSaid: "closed" | "gone" | "failed" | null = localClosed ? "closed" : null;
      const isHeld = (item: InboxMessage) => held.includes(item);
      if (local?.installed() && (!localClosed || held.length > 0) && !localGone.has(session)) {
        const rest: InboxMessage[] = [];
        let stop = false;
        for (const item of todo) {
          if (stopped) return recordWaits();
          const key = keyOf(item, session);
          sendable.add(key);
          // In order: once one does not go, the later ones wait for it (a held one is never anyone else's).
          if (stop || (retryAt.get(key)?.at ?? 0) > now()) {
            stop = true;
            if (!isHeld(item) && localSaid !== null) rest.push(item);
            continue;
          }
          const tried = await tryLocal(item, session);
          if (tried === "held") continue;
          if (tried === "delivered" || tried === "checking") {
            taken.add(item.id);
            waitOf(item, session, null);
            if (tried === "checking") stop = true;
            continue;
          }
          // Not sent, and known not to be: a grant may send it.
          stop = true;
          localSaid = tried === "retry" ? "failed" : tried;
          rest.push(item);
        }
        todo = rest;
        if (todo.length === 0) continue;
      } else todo = todo.filter((item) => !isHeld(item));
      if (todo.length === 0) continue;
      const link = await homeOf(session);
      if (link === "unreachable" || (!link && localSaid === "closed")) {
        // T3 could not be asked: kept, and tried again on the send's backoff, or as soon as T3 here runs.
        if (!link && localClosed) {
          for (const item of todo) {
            sendable.add(keyOf(item, session));
            waitOf(item, session, "closed");
          }
          continue;
        }
        for (const item of todo) {
          const key = keyOf(item, session);
          sendable.add(key);
          if ((retryAt.get(key)?.at ?? 0) <= now()) backOff(key);
          waitOf(item, session, "closed");
        }
        sayOnce(`T3 could not be reached for thread ${session}. Trying again later.`);
        continue;
      }
      if (!link && localSaid === "gone") {
        // T3 here does not have the thread, and no grant reaches one that does.
        dead.add(session);
        homes.delete(session);
        for (const item of todo) waitOf(item, session, null);
        sayOnce(`T3 no longer has thread ${session}; the reply waits in the Inbox for the next agent.`);
        continue;
      }
      if (!link && localSaid === "failed") {
        // T3 here answered with another failure, and no grant reaches the thread: tried again on the backoff.
        for (const item of todo) {
          sendable.add(keyOf(item, session));
          backOff(keyOf(item, session));
          waitOf(item, session, null);
        }
        continue;
      }
      if (!link) {
        noGrant = true;
        // Saved grants that T3 answered "not this environment's thread" say nothing the person can act on here.
        const wait = found.length === 0 ? "sign_in" : misses.get(session)?.lapsed ? "sign_in_again" : null;
        for (const item of todo) waitOf(item, session, wait);
        sayOnce(`No T3 grant reaches thread ${session}; run \`plannotator t3 login --url <T3 MCP URL>\`. Its replies wait in the Inbox.`);
        continue;
      }
      if (!deniedNow(session, link) && !covers(link, session)) {
        sayOnce(t3NotCoveredLine(session, ceilingOf(link) ?? "its mode", threadModes.get(session) ?? null, link.credentials.endpoint.href));
      }
      for (const item of todo) {
        if (stopped) return recordWaits();
        if (takenElsewhere(item, session)) continue;
        // Denied for the grant's mode, or a mode it does not cover: kept for the agent's next read, never sent under this grant.
        if (!sendsInto(session, link)) {
          refuseUnder(keyOf(item, session), link);
          waitOf(item, session, "access");
          continue;
        }
        sendable.add(keyOf(item, session));
        taken.add(item.id);
        waitOf(item, session, await deliverOne(link, item, session));
      }
      } finally {
        working.delete(session);
        // Not taken up this pass: back to the Inbox, so the line reads as it waits and the mod may take it.
        for (const id of handed) if (!taken.has(id)) store.handover.giveBack(id, session);
      }
    }
    recordWaits();
    for (const key of [...retryAt.keys()]) if (!sendable.has(key)) retryAt.delete(key);
    for (const key of [...refused.keys()]) if (!pendingKeys.has(key)) refused.delete(key);
    // A claim whose item no longer waits (delivered, read, deleted) is done with.
    for (const key of claims.keys()) if (!pendingKeys.has(key)) claims.drop(itemOfKey(key), sessionOfKey(key));
    for (const key of [...checking]) if (!pendingKeys.has(key)) checking.delete(key);
    scheduleRetry();
    watchGrants(noGrant || [...refused.values()].some((under) => under !== null) ? mark : null);
  };
  const sweep = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = (async () => {
      try {
        do {
          again = false;
          await sweepOnce();
        } while (again && !stopped);
      } catch (error) {
        log(`the T3 wake could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  };

  let sweepQueued = false;
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message") return;
    const message = line.record as InboxMessage;
    if (message.author.kind === "agent") {
      if (message.author.host !== INBOX_T3_HOST || !isT3ThreadId(message.author.session)) return;
      sweptSessions().add(message.author.session);
      if (message.wakes === true) knownSessions().add(message.author.session);
    } else {
      const add = (session: string) => (knownSessions().add(session), sweptSessions().add(session));
      if (message.to?.host === INBOX_T3_HOST) add(message.to.session);
      for (const tag of message.tags ?? []) if (tag.host === INBOX_T3_HOST && tag.wakes) add(tag.session);
    }
    if (sweepQueued) return;
    sweepQueued = true;
    setTimeout(() => {
      sweepQueued = false;
      void sweep();
    }, 0);
  });
  void sweep();

  return {
    wakes: async (host, session) => {
      if (host !== INBOX_T3_HOST || !isT3ThreadId(session)) return false;
      // An agent waits on this: a T3 that has not answered in a few seconds is not promised (the lookup goes on).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"unreachable">((resolve) => {
        timer = setTimeout(() => resolve("unreachable"), options.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS);
      });
      if (local?.running()) {
        const shown = local.has(session).then((has) => (has && localHas.add(session), has));
        shown.catch(() => {});
        if ((await Promise.race([shown, late])) === true) {
          clearTimeout(timer);
          return true;
        }
      }
      const looked = homeOf(session);
      looked.catch(() => {});
      const home = await Promise.race([looked, late]).finally(() => clearTimeout(timer));
      if (home === null || home === "unreachable") return false;
      if (!deniedNow(session, home) && !covers(home, session)) {
        sayOnce(t3NotCoveredLine(session, ceilingOf(home) ?? "its mode", threadModes.get(session) ?? null, home.credentials.endpoint.href));
        return false;
      }
      return sendsInto(session, home);
    },
    // No grant reaches the thread (logged out, a lapsed grant) or can send into it: nothing wakes it, so the MCP presence rules apply.
    status: (session) => {
      if (!knownSessions().has(session)) return null;
      if (localHas.has(session)) return dead.has(session) ? "dead" : "alive";
      if (misses.has(session) || denied.has(session)) return null;
      const home = homes.get(session);
      if (home && (!home.credentials.token() || !sendsInto(session, home))) return null;
      return dead.has(session) ? "dead" : "alive";
    },
    signIn: async () => {
      const found = await grants();
      if (found.length === 0) return "none";
      const mark = markOf(found);
      if ([...misses.values()].some((miss) => miss.lapsed && miss.grants === mark)) return "ran_out";
      const readOnly = found.every((credentials) => {
        try {
          return t3CeilingOfScope((credentials.read()?.tokens as { scope?: unknown } | undefined)?.scope) === "read-only";
        } catch {
          return false;
        }
      });
      return readOnly ? "read_only" : "ok";
    },
    gone: (session) => dead.has(session),
    noteToolCall: (session) => {
      if (!isT3ThreadId(session)) return;
      localGone.delete(session);
      if (!dead.delete(session)) return;
      // Back: what waited on a retry goes now too.
      for (const key of [...retryAt.keys()]) if (sessionOfKey(key) === session) retryAt.delete(key);
      void sweep();
    },
    uncertain: (session, itemId) => refused.has(`${itemId}.${session}`) || checking.has(`${itemId}.${session}`),
    uncertainItems: (session) => [...new Set([...refused.keys(), ...checking])].filter((key) => sessionOfKey(key) === session).map(itemOfKey),
    holds: (session, item) => working.get(session)?.has(item.id) === true || claims.has(store.deliveryIdOf(item, session), session),
    sweep,
    stop: () => {
      stopped = true;
      stopping.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (grantTimer) clearTimeout(grantTimer);
      unsubscribe();
      for (const link of links.values()) void link.then((value) => (value.rpc as { close?: () => Promise<void> }).close?.()).catch(() => {});
    },
  };
}
