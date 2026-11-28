/**
 * Tag an agent on another linked computer, for the sessions this Inbox wakes itself (Codex through `codex queue`,
 * Qwen over its cross-session messaging, T3 Code through `t3`, Antigravity through `agentapi`). Those wakes read what
 * waits for a session from this Inbox's store (`pendingRepliesFor`) and record each delivery there, so a wake a linked
 * computer handed one of them (inbox-far-wakes.ts, kept apart: its reply lives on that computer) was never sent.
 *
 * `farWakeStore` is the store those wakes are given: the real store, with each far wake that waits added as one more
 * item for its session, the way a tag of a reply here is. Each wake then sends it the way it sends a local tag (the same
 * claims on disk, retries, uncertain sends and T3 routing), with the command the thread's computer worded (`commandOf`).
 * Its delivery is marked on the far wake and told to the thread's computer (`delivered`); nothing is written to this
 * store. A wake taken back there reads as taken back here, so a wake that has not sent it yet never does.
 */

import { isInboxCloudSession, type InboxCloudWake } from "@plannotator/core/inbox-cloud";
import { SHIP_NOTE_WAKE_INSTRUCTION } from "@plannotator/core/inbox-pull-handoff";
import { INBOX_ANTIGRAVITY_HOST, INBOX_CODEX_HOST, INBOX_QWEN_HOST, INBOX_T3_HOST, type InboxLine, type InboxMessage, type InboxThread } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { FarWake, InboxFarWakes } from "./inbox-far-wakes";

/** The hosts whose sessions this Inbox wakes itself, each through a wake that reads the store given here. */
export const FAR_WOKEN_HOSTS: ReadonlySet<string> = new Set([INBOX_CODEX_HOST, INBOX_QWEN_HOST, INBOX_T3_HOST, INBOX_ANTIGRAVITY_HOST]);

/** A far wake as one of the store's person items: its reply's id, a waking tag for its session, never written anywhere. */
export function farWakeItem(wake: FarWake): InboxMessage {
  const delivered = wake.delivered_at && !wake.withdrawn ? { delivery: { state: "delivered" as const, at: wake.delivered_at, host: wake.host ?? "agent", session: wake.session } } : {};
  return {
    id: wake.reply_id,
    project_id: "",
    thread_id: wake.thread_id,
    reply_to: wake.command.reply_to,
    author: { kind: "person" },
    subject: wake.command.subject,
    // A swarm's ghost-thread notice keeps its own first line for a wake that words the item's body (the cloud's), as the
    // thread's computer's own cloud wake does (inbox-cloud-wake.ts `wakeItem`). Ship's note goes with its body alone there,
    // so here too.
    body: wake.command.moved && wake.command.notice && wake.command.notice !== SHIP_NOTE_WAKE_INSTRUCTION ? `${wake.command.notice}\n\n${wake.command.body}` : wake.command.body,
    created_at: wake.received_at,
    resolved_at: null,
    idempotency_key: null,
    tags: [{ host: wake.host, session: wake.session, wakes: true, ...(wake.command.handed_away ? { handed_away: true } : {}), ...delivered }],
    ...(wake.withdrawn ? { taken_back_at: wake.delivered_at } : {}),
    ...(wake.cloud_wake ? { cloud_wake: wake.cloud_wake } : {}),
  } as InboxMessage;
}

/** Whether this Inbox wakes `session` of `host` itself, through a wake given `farWakeStore` (a cloud agent's: its webhook). */
export const farWokenHere = (session: string, host: string | null): boolean => (host !== null && FAR_WOKEN_HOSTS.has(host)) || isInboxCloudSession(session);

export interface FarWakeStore {
  /** The store the self-waking hosts' wakes are given. */
  store: InboxStore;
  /** The far wake's own command for an item of it; null for an item of this store. */
  commandOf: (item: InboxMessage, session: string) => InboxReplyCommand | null;
}

export function farWakeStore(store: InboxStore, farWakes: InboxFarWakes, delivered: (wake: FarWake, session: string) => void): FarWakeStore {
  /** The far wake of `id` for `session`, only when `id` is no message of this store. */
  const farOf = (id: string, session?: string): FarWake | null => {
    if (store.message(id)) return null;
    return farWakes.find(id).find((w) => session === undefined || w.session === session) ?? null;
  };
  const waitingFor = (session: string) => farWakes.pendingFor(session).filter((w) => farWokenHere(w.session, w.host));

  const handover: InboxStore["handover"] = {
    hand: (item, session, way) => (farOf(item.id, session) ? true : store.handover.hand(item, session, way)),
    asked: (items, session) => store.handover.asked(items, session),
    giveBack: (id, session) => {
      if (!farOf(id, session)) store.handover.giveBack(id, session);
    },
    holder: (message) => store.handover.holder(message),
    handedTo: (session) => store.handover.handedTo(session),
  };

  const overrides: Partial<Record<keyof InboxStore, unknown>> = {
    handover,
    message: (id: string) => store.message(id) ?? (farWakes.find(id)[0] ? farWakeItem(farWakes.find(id)[0]!) : null),
    pendingRepliesFor: (sessions: ReadonlySet<string>, options?: { tags?: boolean }) => {
      const out = store.pendingRepliesFor(sessions, options);
      if (options?.tags !== true) return out;
      for (const session of sessions) {
        const far = waitingFor(session).map(farWakeItem);
        if (far.length > 0) out.set(session, [...(out.get(session) ?? []), ...far]);
      }
      return out;
    },
    wakingSessionsOfHost: (host: string) => {
      const out = store.wakingSessionsOfHost(host);
      if (FAR_WOKEN_HOSTS.has(host)) for (const wake of farWakes.waiting()) if (wake.host === host) out.add(wake.session);
      return out;
    },
    isOwner: (message: InboxMessage, session: string) => (farOf(message.id, session) ? false : store.isOwner(message, session)),
    deliveryIdOf: (message: InboxMessage, session: string) => farOf(message.id, session)?.command.id ?? store.deliveryIdOf(message, session),
    recordDelivery: (id: string, by: { host: string; session: string }) => {
      const far = farOf(id, by.session);
      if (!far) return store.recordDelivery(id, by);
      const done = farWakes.delivered(by.session, id);
      if (done && !far.delivered_at) delivered(done, by.session);
      return farWakeItem(done ?? far);
    },
    recordT3Wait: (id: string, wait: Parameters<InboxStore["recordT3Wait"]>[1]) => (farOf(id) ? null : store.recordT3Wait(id, wait)),
    // The cloud wake: the thread's subject and the wake's own items, the details line its computer counted, and each
    // state kept on the far wake (a run that started is that wake delivered).
    thread: (threadId: string) => {
      const real = store.thread(threadId);
      if (real) return real;
      const items = farWakes.waiting().filter((w) => w.thread_id === threadId);
      return items.length === 0 ? null : ({ id: threadId, subject: items[0]!.command.subject, thread_name: null, messages: items.map(farWakeItem) } as unknown as InboxThread);
    },
    wakeContext: (message: InboxMessage, session: string | null) => {
      const far = session === null ? null : farOf(message.id, session);
      return far ? (far.command.context ?? { messages: 0, open_questions: 0, open_actions: 0 }) : store.wakeContext(message, session);
    },
    recordCloudWake: (id: string, cloud: InboxCloudWake, session: string, host: string) => {
      const far = farOf(id, session);
      if (!far) return store.recordCloudWake(id, cloud, session, host);
      const kept = farWakes.recordCloudWake(session, id, cloud);
      if (cloud.state === "started" && !far.delivered_at) {
        const done = farWakes.delivered(session, id);
        if (done) delivered(done, session);
        return farWakeItem(done ?? kept ?? far);
      }
      return farWakeItem(kept ?? far);
    },
    subscribe: (listener: (line: InboxLine) => void) => {
      const off = store.subscribe(listener);
      // A wake a linked computer handed one of these sessions reads as a person's line that tags it.
      const offFar = farWakes.onWake((session) => {
        for (const wake of waitingFor(session)) {
          const record = farWakeItem(wake);
          listener({ v: 1, seq: 0, at: wake.received_at, kind: "message", id: record.id, record });
        }
      });
      return () => {
        off();
        offFar();
      };
    },
  };

  const wrapped = new Proxy(store, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && Object.hasOwn(overrides, prop)) return overrides[prop as keyof InboxStore];
      const value = Reflect.get(target, prop, receiver === wrapped ? target : receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    store: wrapped,
    commandOf: (item, session) => {
      const far = farOf(item.id, session);
      return far ? far.command : null;
    },
  };
}
