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
 *  - a send T3 denies for the grant's mode (`capability_denied`: a Read only
 *    grant; `runtime_mode_escalation_denied` or
 *    `interaction_mode_escalation_denied`: the thread runs in a mode above the
 *    grant's) is never retried either, and that thread is not offered as
 *    woken under that grant until a new `plannotator t3 login`;
 *  - any other failure is tried again later (30 s, doubling to 10 min). With
 *    no grant that reaches the thread, nothing is retried on a timer: the
 *    reply waits for the next look.
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
/** A lookup T3 answered (a tool error, a refused grant); anything else did not reach it and is tried again. */
const T3_ANSWERED = /^T3 t3_thread_read:|\b401\b|unauthorized/i;
/** What T3 answers when the grant's mode does not cover the thread (its OrchestratorMcpFailure codes). */
const MODE_DENIED = /\b(capability_denied|runtime_mode_escalation_denied|interaction_mode_escalation_denied)\b/;

/**
 * The grant's mode as T3's denial words it: "approved for read-only access",
 * "… is broader than parent mode auto." (the parent is the grant here).
 */
export function t3GrantModeOf(said: string): string | null {
  if (/read-only access/i.test(said)) return "read-only";
  return /parent mode ([a-z-]+)/i.exec(said)?.[1] ?? null;
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
  /** The grant whose environment has the thread; null when none does; "unreachable" when T3 could not be asked. */
  const homeOf = async (thread: string): Promise<Link | null | "unreachable"> => {
    const known = homes.get(thread);
    if (known) return known;
    const missed = misses.get(thread);
    if (missed !== undefined && now() - missed < MISS_TTL_MS) return null;
    let unreachable = false;
    for (const credentials of await grants()) {
      try {
        const link = await linkOf(credentials);
        await new (await loadT3())[2].T3Thread(link.rpc, thread).read({ limit: 1 });
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
    let current: string | undefined;
    try {
      current = link.credentials.read()?.epoch;
    } catch {
      current = undefined;
    }
    if (current === epoch) return true;
    denied.delete(session);
    return false;
  };

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
        try {
          const epoch = link.credentials.read()?.epoch;
          if (epoch) denied.set(session, epoch);
        } catch {
          // An unreadable grant: the next lookup finds out.
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
      for (const item of todo) {
        if (stopped) return;
        // Denied for the grant's mode: kept for the agent's next read, never sent again under this grant.
        if (deniedNow(session, link)) {
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
      const home = await homeOf(session);
      return home !== null && home !== "unreachable" && !deniedNow(session, home);
    },
    // No grant reaches the thread (logged out, a lapsed grant): nothing wakes it, so the MCP presence rules apply.
    status: (session) => (!knownSessions().has(session) || misses.has(session) || denied.has(session) ? null : dead.has(session) ? "dead" : "alive"),
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
