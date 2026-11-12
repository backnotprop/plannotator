import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_T3_HOST, isT3ThreadId, type InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { T3Credentials } from "@plannotator/t3-code/auth";
import type { T3Rpc } from "@plannotator/t3-code/t3-client";
import { codexQueueMessage } from "./inbox-codex-wake";

let t3Modules: Promise<[typeof import("@plannotator/t3-code/auth"), typeof import("@plannotator/t3-code/delivery"), typeof import("@plannotator/t3-code/t3-client")]> | null = null;
const loadT3 = () => (t3Modules ??= Promise.all([import("@plannotator/t3-code/auth"), import("@plannotator/t3-code/delivery"), import("@plannotator/t3-code/t3-client")]));

const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;
const THREAD_GONE = /thread was not found|calling thread was not found|archived/i;
const T3_ANSWERED = /\b(thread_not_found|capability_denied|target_required)\b|thread was not found|different thread|\b401\b|unauthorized/i;
const LOOKUP_TIMEOUT_MS = 3_000;
const MODE_DENIED = /\b(capability_denied|runtime_mode_escalation_denied|interaction_mode_escalation_denied)\b/;

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
type T3RuntimeMode = (typeof RUNTIME_MODES)[number];
const runtimeModeOf = (value: unknown): T3RuntimeMode | null => (RUNTIME_MODES as readonly unknown[]).includes(value) ? (value as T3RuntimeMode) : null;
const rank = (mode: T3RuntimeMode) => RUNTIME_MODES.indexOf(mode);
type T3Ceiling = "read-only" | T3RuntimeMode | "below-full-access";

export function t3CeilingOfScope(scope: unknown): T3Ceiling | null {
  if (typeof scope !== "string") return null;
  const scopes = scope.split(/\s+/);
  if (!scopes.includes("orchestration:operate")) return "read-only";
  return scopes.includes("settings:write") ? "full-access" : "below-full-access";
}

export function t3GrantModeOf(said: string): string | null {
  if (/read-only access/i.test(said)) return "read-only";
  const mode = /parent mode ([a-z-]+)/i.exec(said)?.[1] ?? null;
  return mode && /interaction mode/i.test(said) ? `interaction mode ${mode}` : mode;
}

export function t3ModeDeniedLine(itemId: string, thread: string, code: string, mode: string | null, endpoint: string): string {
  return `T3 refused ${itemId} for thread ${thread} (${code}): the saved grant (${mode ?? "its mode"}) cannot send into that thread. It waits in the Inbox for the agent's next read. To wake it, run \`plannotator t3 login --url ${endpoint}\` and choose a mode that covers the thread.`;
}

export interface InboxT3Wake {
  wakes(host: unknown, session: unknown): Promise<boolean>;
  status(session: string): "alive" | "dead" | null;
  noteToolCall(session: string): void;
  uncertain(session: string, itemId: string): boolean;
  uncertainItems(session: string): string[];
  sweep(): Promise<void>;
  stop(): void;
}

export type T3Connect = (endpoint: URL, token: () => string | undefined) => Promise<T3Rpc>;

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
  skip?: (item: InboxMessage, session: string) => boolean;
  connect?: T3Connect;
  now?: () => number;
  log?: (line: string) => void;
  lookupTimeoutMs?: number;
}): InboxT3Wake {
  const { store, dataDir } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  const connect: T3Connect = options.connect ?? (async (endpoint, token) => (await loadT3())[2].T3Client.connect(endpoint, token));
  let stopped = false;

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
  const threadModes = new Map<string, T3RuntimeMode>();
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
  const covers = (link: Link, thread: string): boolean => {
    const ceiling = ceilingOf(link);
    if (ceiling === null) return true;
    if (ceiling === "read-only") return false;
    const mode = threadModes.get(thread);
    if (!mode) return true;
    return ceiling === "below-full-access" ? mode !== "full-access" : rank(mode) <= rank(ceiling);
  };
  const homeOf = async (thread: string): Promise<Link | null | "unreachable"> => {
    const known = homes.get(thread);
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
        if (!T3_ANSWERED.test(error instanceof Error ? error.message : String(error))) unreachable = true;
      }
    }
    if (unreachable) return "unreachable";
    misses.set(thread, now());
    return null;
  };

  let known: Set<string> | null = null;
  const knownSessions = (): Set<string> => (known ??= store.wakingSessionsOfHost(INBOX_T3_HOST));
  const dead = new Set<string>();
  const refused = new Set<string>();
  const denied = new Map<string, string>();
  const deniedNow = (session: string, link: Link): boolean => {
    const epoch = denied.get(session);
    if (epoch === undefined) return false;
    if (grantOf(link)?.epoch === epoch) return true;
    denied.delete(session);
    return false;
  };
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

  const keyOf = (item: InboxMessage, session: string) => `${store.deliveryIdOf(item, session)}.${session}`;

  const deliverOne = async (link: Link, item: InboxMessage, session: string): Promise<void> => {
    const id = store.deliveryIdOf(item, session);
    const key = `${id}.${session}`;
    const retry = retryAt.get(key);
    if (retry && retry.at > now()) return;
    const text = codexQueueMessage(options.commandOf(item, session));
    const [, { T3Delivery, T3DeliveryRefused }, { T3Thread }] = await loadT3();
    try {
      await new T3Delivery(new T3Thread(link.rpc, session), link.credentials).sendFirst(text, `plannotator-inbox-${id}`);
      retryAt.delete(key);
      try {
        store.recordDelivery(id, { host: INBOX_T3_HOST, session });
      } catch {
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
    const sendable = new Set<string>();
    for (const [session, items] of pending) {
      const work = items.filter((item) => wakesItem(item, session) && !options.skip?.(item, session));
      for (const item of work) pendingKeys.add(keyOf(item, session));
      if (dead.has(session)) continue;
      const todo = work.filter((item) => !refused.has(keyOf(item, session)));
      if (todo.length === 0) continue;
      if (todo.every((item) => (retryAt.get(keyOf(item, session))?.at ?? 0) > now())) {
        for (const item of todo) sendable.add(keyOf(item, session));
        continue;
      }
      const link = await homeOf(session);
      if (link === "unreachable") {
        for (const item of todo) {
          const key = keyOf(item, session);
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
        if (!sendsInto(session, link)) {
          refused.add(keyOf(item, session));
          continue;
        }
        sendable.add(keyOf(item, session));
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
    status: (session) => {
      if (!knownSessions().has(session) || misses.has(session) || denied.has(session)) return null;
      const home = homes.get(session);
      if (home && (!home.credentials.token() || !sendsInto(session, home))) return null;
      return dead.has(session) ? "dead" : "alive";
    },
    noteToolCall: (session) => {
      if (!isT3ThreadId(session) || !dead.delete(session)) return;
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
