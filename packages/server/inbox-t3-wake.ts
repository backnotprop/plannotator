/**
 * The T3 Code wake: the person's reply, message or tag for an agent in a T3
 * Code thread goes into that thread as a new turn, through T3's own MCP API
 * (`t3_thread_send`, queued, never steered). T3 shows it like anything the
 * person typed and runs it with whatever provider the thread uses.
 *
 * T3 runs Claude through the Agent SDK, where the Claude Code mod stands down,
 * so no Plannotator plugin polls. T3 sets T3CODE_THREAD_ID in every process an
 * agent starts, its MCP servers included, and the stdio shim sends as
 * `agent_host: "t3"` with that id (apps/hook/server/inbox-mcp-shim.ts). A
 * message wakes when this Inbox holds a T3 grant (`plannotator t3 login`,
 * packages/t3-code) whose environment has that thread.
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
 *    (`lookupTimeoutMs`): a T3 that does not answer by then is not promised.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_T3_HOST, isT3ThreadId, type InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { T3Credentials } from "@plannotator/t3-code/auth";
import type { T3Rpc } from "@plannotator/t3-code/t3-client";
import { codexQueueMessage } from "./inbox-codex-wake";

/** The T3 client loads only once a grant exists: every other CLI start skips the MCP client. */
let t3Modules: Promise<[typeof import("@plannotator/t3-code/auth"), typeof import("@plannotator/t3-code/delivery"), typeof import("@plannotator/t3-code/t3-client")]> | null = null;
const loadT3 = () => (t3Modules ??= Promise.all([import("@plannotator/t3-code/auth"), import("@plannotator/t3-code/delivery"), import("@plannotator/t3-code/t3-client")]));

const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** How long "no grant reaches this thread" is believed before asking T3 again. */
const MISS_TTL_MS = 60_000;
/** What T3 says for a thread it does not have (apps/server/src/mcp/threadAccess.ts). */
const THREAD_GONE = /thread was not found|calling thread was not found|archived/i;
/** A lookup T3 answered about the grant or the thread; anything else (a network failure, `orchestration_error`) did not reach it and is tried again. */
const T3_ANSWERED = /\b(thread_not_found|capability_denied|target_required)\b|thread was not found|different thread|\b401\b|unauthorized/i;
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
  /** The thread called an Inbox tool: it is there. */
  noteToolCall(session: string): void;
  /** A send T3Delivery refused: the window says it is saved for the agent's next read. */
  uncertain(session: string, itemId: string): boolean;
  uncertainItems(session: string): string[];
  sweep(): Promise<void>;
  stop(): void;
}

export type T3Connect = (endpoint: URL, token: () => string | undefined) => Promise<T3Rpc>;

/** The line for a thread the grant's mode does not cover, found before any send. */
export function t3NotCoveredLine(thread: string, grantMode: string, threadMode: string | null, endpoint: string): string {
  return `The saved T3 grant (${grantMode === "below-full-access" ? "below Full access" : grantMode}) cannot send into thread ${thread}${threadMode ? ` (it runs ${threadMode})` : ""}, so the Inbox does not wake it: its replies wait for the agent's next read. To wake it, run \`plannotator t3 login --url ${endpoint}\` and choose a mode that covers the thread.`;
}

interface Link {
  credentials: T3Credentials;
  rpc: T3Rpc;
}

export function createInboxT3Wake(options: {
  store: InboxStore;
  dataDir: string;
  commandOf: (item: InboxMessage, session: string) => InboxReplyCommand;
  /** How the wake reaches T3 (tests pass a scripted one). Default: T3's MCP over HTTP. */
  connect?: T3Connect;
  now?: () => number;
  log?: (line: string) => void;
  /** How long an agent's send_message waits on T3 (default 3 s). */
  lookupTimeoutMs?: number;
}): InboxT3Wake {
  const { store, dataDir } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  const connect: T3Connect = options.connect ?? (async (endpoint, token) => (await loadT3())[2].T3Client.connect(endpoint, token));
  let stopped = false;

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
  const misses = new Map<string, number>();
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
    const missed = misses.get(thread);
    if (missed !== undefined && now() - missed < MISS_TTL_MS) return null;
    let unreachable = false;
    for (const credentials of await grants()) {
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
        if (!T3_ANSWERED.test(error instanceof Error ? error.message : String(error))) unreachable = true;
      }
    }
    if (unreachable) return "unreachable";
    misses.set(thread, now());
    return null;
  };

  // ── The sessions it wakes ──
  let known: Set<string> | null = null;
  const knownSessions = (): Set<string> => (known ??= store.wakingSessionsOfHost(INBOX_T3_HOST));
  const dead = new Set<string>();
  const refused = new Set<string>();
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

  const wakesItem = (item: InboxMessage, session: string): boolean => {
    if (!store.isOwner(item, session)) return item.tags?.some((tag) => tag.session === session && tag.host === INBOX_T3_HOST && tag.wakes) ?? false;
    if (item.to) return item.to.host === INBOX_T3_HOST;
    const asked = item.reply_to ? store.message(item.reply_to) : null;
    return asked?.author.kind === "agent" && asked.author.host === INBOX_T3_HOST && asked.wakes === true;
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
  const sayOnce = (line: string) => {
    if (failuresSaid.has(line)) return;
    failuresSaid.add(line);
    log(line);
  };

  const backOff = (key: string) => {
    const wait = Math.min((retryAt.get(key)?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
    retryAt.set(key, { at: now() + wait, wait });
  };

  const deliverOne = async (link: Link, item: InboxMessage, session: string): Promise<void> => {
    const key = `${item.id}.${session}`;
    const retry = retryAt.get(key);
    if (retry && retry.at > now()) return;
    const text = codexQueueMessage(options.commandOf(item, session));
    const [, { T3Delivery, T3DeliveryRefused }, { T3Thread }] = await loadT3();
    try {
      // One request per item (the delivery folder is the thread's): a retry re-sends the first words, so a thread
      // renamed between two tries is still one T3 turn.
      await new T3Delivery(new T3Thread(link.rpc, session), link.credentials).sendFirst(text, `plannotator-inbox-${item.id}`);
      retryAt.delete(key);
      try {
        store.recordDelivery(item.id, { host: INBOX_T3_HOST, session });
      } catch {
        // Gone, or no longer this session's.
      }
    } catch (error) {
      const said = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
      const code = MODE_DENIED.exec(said)?.[1];
      if (code) {
        retryAt.delete(key);
        refused.add(key);
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
        return;
      }
      if (error instanceof T3DeliveryRefused) {
        retryAt.delete(key);
        refused.add(key);
        log(`T3 refused ${item.id} for thread ${session} (${said}); it waits in the Inbox for the agent's next read.`);
        return;
      }
      if (THREAD_GONE.test(said)) {
        retryAt.delete(key);
        dead.add(session);
        homes.delete(session);
        log(`T3 no longer has thread ${session} (${said}); the reply waits in the Inbox for the next agent.`);
        return;
      }
      backOff(key);
      // A refused grant may be a new login on another URL: ask again which grant reaches the thread.
      homes.delete(session);
      sayOnce(`T3 send failed: ${said}. Trying again later.`);
    }
  };

  let sweeping: Promise<void> | null = null;
  let again = false;
  const sweepOnce = async (): Promise<void> => {
    const sessions = knownSessions();
    if (sessions.size === 0) return;
    const pending = store.pendingRepliesFor(sessions, { tags: true });
    const pendingKeys = new Set<string>();
    /** Items this pass could send: a retry is kept only for those, so nothing that cannot go runs a timer. */
    const sendable = new Set<string>();
    for (const [session, items] of pending) {
      const work = items.filter((item) => wakesItem(item, session));
      for (const item of work) pendingKeys.add(`${item.id}.${session}`);
      if (dead.has(session)) continue;
      const todo = work.filter((item) => !refused.has(`${item.id}.${session}`));
      if (todo.length === 0) continue;
      // Every item still inside its backoff: kept, and T3 is not asked until one comes due.
      if (todo.every((item) => (retryAt.get(`${item.id}.${session}`)?.at ?? 0) > now())) {
        for (const item of todo) sendable.add(`${item.id}.${session}`);
        continue;
      }
      const link = await homeOf(session);
      if (link === "unreachable") {
        // T3 could not be asked: kept, and tried again on the send's backoff.
        for (const item of todo) {
          const key = `${item.id}.${session}`;
          sendable.add(key);
          if ((retryAt.get(key)?.at ?? 0) <= now()) backOff(key);
        }
        sayOnce(`T3 could not be reached for thread ${session}. Trying again later.`);
        continue;
      }
      if (!link) {
        sayOnce(`No T3 grant reaches thread ${session}; run \`plannotator t3 login --url <T3 MCP URL>\`. Its replies wait in the Inbox.`);
        continue;
      }
      if (!deniedNow(session, link) && !covers(link, session)) {
        sayOnce(t3NotCoveredLine(session, ceilingOf(link) ?? "its mode", threadModes.get(session) ?? null, link.credentials.endpoint.href));
      }
      for (const item of todo) {
        if (stopped) return;
        // Denied for the grant's mode, or a mode it does not cover: kept for the agent's next read, never sent under this grant.
        if (!sendsInto(session, link)) {
          refused.add(`${item.id}.${session}`);
          continue;
        }
        sendable.add(`${item.id}.${session}`);
        await deliverOne(link, item, session);
      }
    }
    for (const key of [...retryAt.keys()]) if (!sendable.has(key)) retryAt.delete(key);
    for (const key of [...refused]) if (!pendingKeys.has(key)) refused.delete(key);
    scheduleRetry();
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
      if (message.wakes !== true || message.author.host !== INBOX_T3_HOST || !message.author.session) return;
      knownSessions().add(message.author.session);
    } else {
      if (message.to?.host === INBOX_T3_HOST) knownSessions().add(message.to.session);
      for (const tag of message.tags ?? []) if (tag.host === INBOX_T3_HOST && tag.wakes) knownSessions().add(tag.session);
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
      if (!knownSessions().has(session) || misses.has(session) || denied.has(session)) return null;
      const home = homes.get(session);
      if (home && (!home.credentials.token() || !sendsInto(session, home))) return null;
      return dead.has(session) ? "dead" : "alive";
    },
    noteToolCall: (session) => {
      if (!isT3ThreadId(session) || !dead.delete(session)) return;
      // Back: what waited on a retry goes now too.
      for (const key of [...retryAt.keys()]) if (key.endsWith(`.${session}`)) retryAt.delete(key);
      void sweep();
    },
    uncertain: (session, itemId) => refused.has(`${itemId}.${session}`),
    uncertainItems: (session) => [...refused].filter((key) => key.endsWith(`.${session}`)).map((key) => key.slice(0, key.indexOf("."))),
    sweep,
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
      for (const link of links.values()) void link.then((value) => (value.rpc as { close?: () => Promise<void> }).close?.()).catch(() => {});
    },
  };
}
