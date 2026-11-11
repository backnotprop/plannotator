/**
 * The cloud wake: the person's message or reply to a paired cloud agent
 * (inbox-cloud-agents.ts) is POSTed to its webhook, the key as
 * `Authorization: Bearer`, the body per preset (@plannotator/core/inbox-cloud).
 *
 * The rules (design "pair-cloud-agent", section 4):
 *  - at most one wake per thread per minute (INBOX_CLOUD_WAKE_GAP_MS); replies
 *    inside that minute are `held` and go together in the next wake;
 *  - each item's state is written on the message itself before the POST
 *    (`sending`) and after it, so every window shows one line and a wake that
 *    may have gone is never sent twice: a `sending` found at start, or no
 *    answer in time, is `uncertain` and never sent again;
 *  - only a 200 is `started` (Other: any 2xx), recorded as the delivery;
 *  - a 5xx or no connection retries on the Codex wake's backoff (30 s,
 *    doubling to 10 min); a 429 waits for its Retry-After; a refused key
 *    (401, 403) waits for a new key; any other answer is `failed`;
 *  - Remove: what still waits for the agent is `unpaired`, never sent.
 *
 * The agent is live in its project while it stays paired (`pinCloud`), so New
 * message's To lists it under its name.
 */

import { homedir } from "node:os";
import {
  INBOX_CLOUD_WAKE_GAP_MS,
  inboxCloudAnswer,
  inboxCloudHostOf,
  inboxCloudWakeBody,
  inboxCloudWakeSettled,
  isInboxCloudSession,
  type InboxCloudWake,
  type InboxCloudWakeItem,
} from "@plannotator/core/inbox-cloud";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import { postCloudWebhook } from "./inbox-cloud-post";

const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** States a wake left behind that a POST went out under: they start the thread's minute. */
const POSTED = new Set(["started", "uncertain", "sending"]);

export interface InboxCloudWaker {
  /** `alive` for a paired agent's session, `dead` for a cloud session no longer paired, null for anything else. */
  status(session: string): "alive" | "dead" | null;
  /** Agents were paired, re-keyed or removed: pin the live ones, settle a removed agent's items, look again. */
  agentsChanged(agents: readonly InboxCloudAgent[]): void;
  sweep(): Promise<void>;
  stop(): void;
}

export function createInboxCloudWake(options: {
  store: InboxStore;
  agents: InboxCloudAgents;
  /** The live sessions' pin (inbox-sessions.ts `pinCloud`). */
  pin: (session: string, root: string | null, name: string, host?: string) => void;
  threadUrl: (threadId: string) => string;
  now?: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  gapMs?: number;
  /** The first retry's wait (default 30 s, doubling to 10 min). */
  retryMs?: number;
  log?: (line: string) => void;
}): InboxCloudWaker {
  const { store, agents } = options;
  const now = options.now ?? Date.now;
  const gap = options.gapMs ?? INBOX_CLOUD_WAKE_GAP_MS;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  let stopped = false;
  let first = true;
  /** The agents pinned live, by session, with their names (a removed agent's items are settled under it). */
  const pinned = new Map<string, string>();
  /** Each thread's last POST (ms), learned from its messages once, then kept. */
  const lastWake = new Map<string, number>();
  /** Each thread's retry wait, doubling while its wakes fail. */
  const backoff = new Map<string, number>();
  /** An agent at its hourly limit: no wake before this (ms). */
  const limitedUntil = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextDue: number | null = null;

  const iso = (ms: number) => new Date(ms).toISOString();

  const pinAll = (list: readonly InboxCloudAgent[]) => {
    const seen = new Set<string>();
    for (const agent of list) {
      seen.add(agent.session);
      const project = agent.project_id ? store.project(store.canonicalProjectId(agent.project_id)) : null;
      options.pin(agent.session, project?.root ?? homedir(), agent.name, inboxCloudHostOf(agent.preset));
      pinned.set(agent.session, agent.name);
    }
    for (const session of [...pinned.keys()]) {
      if (seen.has(session)) continue;
      options.pin(session, null, "");
      pinned.delete(session);
    }
  };

  /** Write an item's state, unless it already says this (the time of a repeat is not news). */
  const setWake = (item: InboxMessage, session: string, wake: InboxCloudWake) => {
    const before = store.message(item.id)?.cloud_wake;
    if (before && before.state === wake.state && before.next_at === wake.next_at && before.run_url === wake.run_url && before.status === wake.status) return;
    try {
      store.recordCloudWake(item.id, wake, session, inboxCloudHostOf(agents.agent(session)?.preset ?? wake.preset ?? "other"));
    } catch {
      // Deleted meanwhile.
    }
  };

  const lastWakeOf = (threadId: string): number => {
    const known = lastWake.get(threadId);
    if (known !== undefined) return known;
    let latest = 0;
    for (const message of store.thread(threadId)?.messages ?? []) {
      const wake = message.cloud_wake;
      if (wake && POSTED.has(wake.state)) latest = Math.max(latest, Date.parse(wake.at) || 0);
    }
    lastWake.set(threadId, latest);
    return latest;
  };

  const schedule = (due: number) => {
    if (stopped) return;
    if (nextDue !== null && nextDue <= due && timer) return;
    if (timer) clearTimeout(timer);
    nextDue = due;
    timer = setTimeout(() => {
      timer = null;
      nextDue = null;
      void sweep();
    }, Math.max(0, due - now()) + 10);
    (timer as { unref?: () => void }).unref?.();
  };

  const wakeItem = (item: InboxMessage): InboxCloudWakeItem => ({ id: item.id, at: item.created_at, body: item.body, files: item.attachments?.length ?? 0 });

  /** One wake for a thread's waiting items. Answers when to look again (a retry, a limit), or null. */
  const wakeThread = async (agent: InboxCloudAgent, threadId: string, items: InboxMessage[]): Promise<number | null> => {
    const thread = store.thread(threadId);
    if (!thread) return null;
    const at = now();
    lastWake.set(threadId, at);
    for (const item of items) setWake(item, agent.session, { state: "sending", name: agent.name, preset: agent.preset, at: iso(at) });
    const context = store.wakeContext(items[items.length - 1]!, agent.session);
    const body = inboxCloudWakeBody(agent.preset, {
      name: agent.name,
      thread: { id: threadId, subject: thread.thread_name || thread.subject || "", url: options.threadUrl(threadId) },
      items: items.map(wakeItem),
      open: { questions: context.open_questions, actions: context.open_actions },
    });
    const sent = await postCloudWebhook(agent, body, { fetch: options.fetch, timeoutMs: options.timeoutMs });
    const done = now();
    const settle = (wake: Omit<InboxCloudWake, "name" | "at">) => {
      for (const item of items) setWake(item, agent.session, { ...wake, name: agent.name, preset: agent.preset, at: iso(done) } as InboxCloudWake);
    };
    const retryLater = (status?: number): number => {
      const wait = Math.min((backoff.get(threadId) ?? (options.retryMs ?? RETRY_FIRST_MS) / 2) * 2, RETRY_MAX_MS);
      backoff.set(threadId, wait);
      // A failed try started nothing: the minute is not spent.
      lastWake.set(threadId, 0);
      settle({ state: "retrying", next_at: iso(done + wait), ...(status ? { status } : {}) });
      log(`Could not wake the cloud agent "${agent.name}"${status ? ` (it answered ${status})` : " (no connection)"}. Trying again later.`);
      return done + wait;
    };
    if (sent.kind === "timeout") {
      settle({ state: "uncertain" });
      log(`The cloud agent "${agent.name}" did not answer in time; that wake is not sent again.`);
      return null;
    }
    if (sent.kind === "unreachable") return retryLater();
    const answer = inboxCloudAnswer(agent.preset, sent.status, sent.retryAfter, sent.body, done);
    switch (answer.kind) {
      case "started":
        backoff.delete(threadId);
        settle({ state: "started", ...(answer.run_url ? { run_url: answer.run_url } : {}) });
        return null;
      case "retry":
        return retryLater(answer.status);
      case "rate_limited":
        lastWake.set(threadId, 0);
        limitedUntil.set(agent.session, done + answer.wait_ms);
        settle({ state: "rate_limited", next_at: iso(done + answer.wait_ms) });
        log(`The cloud agent "${agent.name}" is at its hourly limit; the next wake waits.`);
        return done + answer.wait_ms;
      case "key_rejected":
        lastWake.set(threadId, 0);
        settle({ state: "key_rejected", status: answer.status });
        agents.markKeyRejected(agent.session);
        log(`The cloud agent "${agent.name}" refused its key. Paste the new key in Settings → Devices.`);
        return null;
      case "failed":
        settle({ state: "failed", status: answer.status });
        log(`Could not wake the cloud agent "${agent.name}" (it answered ${answer.status}).`);
        return null;
    }
  };

  const sweepOnce = async (): Promise<void> => {
    const list = agents.list();
    const sessions = new Set(list.map((agent) => agent.session));
    if (sessions.size === 0) return;
    const pending = store.pendingRepliesFor(sessions, { tags: true });
    const startPass = first;
    first = false;
    for (const [session, all] of pending) {
      const agent = agents.agent(session);
      if (!agent) continue;
      // Found `sending` at a start: it may have gone, so it never goes again.
      if (startPass) for (const item of all) if (item.cloud_wake?.state === "sending") setWake(item, session, { ...item.cloud_wake, state: "uncertain" });
      const open = all.filter((item) => !inboxCloudWakeSettled(store.message(item.id)?.cloud_wake));
      const byThread = new Map<string, InboxMessage[]>();
      for (const item of open) (byThread.get(item.thread_id) ?? byThread.set(item.thread_id, []).get(item.thread_id)!).push(item);
      for (const [threadId, items] of byThread) {
        if (stopped) return;
        // A refused key: nothing goes until a new one is pasted (said once, on each item).
        if (agent.key_rejected_at) {
          for (const item of items) if (item.cloud_wake?.state !== "key_rejected") setWake(item, session, { state: "key_rejected", name: agent.name, preset: agent.preset, at: iso(now()) });
          continue;
        }
        const t = now();
        const retryAt = Math.max(0, ...items.map((item) => (item.cloud_wake?.state === "retrying" || item.cloud_wake?.state === "rate_limited" ? Date.parse(item.cloud_wake.next_at ?? "") || 0 : 0)));
        const due = Math.max(lastWakeOf(threadId) + gap, limitedUntil.get(session) ?? 0, retryAt);
        if (t < due) {
          for (const item of items) {
            const state = item.cloud_wake?.state;
            if (state === "retrying" || state === "rate_limited") continue;
            setWake(item, session, { state: "held", name: agent.name, preset: agent.preset, at: iso(t), next_at: iso(due) });
          }
          schedule(due);
          continue;
        }
        const lookAt = await wakeThread(agent, threadId, items);
        if (lookAt !== null) schedule(lookAt);
      }
    }
  };

  let sweeping: Promise<void> | null = null;
  let again = false;
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
        log(`the cloud wake could not run: ${error instanceof Error ? error.name : "error"}`);
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  };

  let queued = false;
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message") return;
    const message = line.record as InboxMessage;
    if (message.author.kind !== "person") return;
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      void sweep();
    }, 0);
  });

  pinAll(agents.list());
  void sweep();

  return {
    status: (session) => (!isInboxCloudSession(session) ? null : agents.agent(session) ? "alive" : "dead"),
    agentsChanged: (list) => {
      const paired = new Set(list.map((agent) => agent.session));
      // Removed: what waited for it is never sent.
      const gone = new Set([...pinned.keys()].filter((session) => !paired.has(session)));
      if (gone.size > 0) {
        for (const [session, items] of store.pendingRepliesFor(gone, { tags: true })) {
          for (const item of items) {
            if (inboxCloudWakeSettled(item.cloud_wake)) continue;
            setWake(item, session, { state: "unpaired", name: pinned.get(session) ?? "the cloud agent", at: iso(now()) });
          }
        }
      }
      pinAll(list);
      // A new key: the refused items go again, under the minute's rule.
      for (const agent of list) if (!agent.key_rejected_at) limitedUntil.delete(agent.session);
      void sweep();
    },
    sweep,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    },
  };
}

