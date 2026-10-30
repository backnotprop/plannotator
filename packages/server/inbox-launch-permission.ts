/**
 * Launch, PR 2: Claude Code's permission prompts answered in the launch
 * thread (PLAN "Permission hook"). A launched session's settings file runs
 * `plannotator inbox permission-hook` on every PermissionRequest
 * (apps/hook/server/inbox-permission-hook.ts). The hook long-polls
 *
 *   POST /api/inbox/launch/<id>/permission  { key, request_id, event, message_id? }
 *
 * Connection-guarded like the bridge (this machine, no browser, the Inbox
 * token), and the launch's own key, checked against `launch/<id>/settings.json`.
 *
 * The first call writes the question into the launch thread, a reply to its
 * latest message, authored `{ claude-code, perm:<session id>, Claude Code }`
 * and without `wakes`: the person's answer is addressed to `perm:…`, which no
 * poll claims, so it never becomes a second turn. Each call is held up to
 * 25 s and answers `waiting` (call again with the message id), `decided`
 * (`choice`: once, session or deny, and the reason; the hook builds the
 * decision from its own event, and the call records the delivery) or
 * `withdrawn` (say nothing; Claude Code's own dialog stays). A question whose
 * stored body, prompt or choices are not exactly this prompt's is withdrawn,
 * never answered; one whose detail cannot be shown in full and exactly (too
 * long, or a path or link holding a line break or a control) is never asked.
 *
 * A lease withdraws a question no hook holds any more: each call renews it
 * for 60 s, and a held call keeps it. When it runs out (the hook timed out,
 * crashed, or Claude Code ended it because the person answered in Terminal),
 * a one-line follow-up from the same identity supersedes the question,
 * "No longer waiting.". With no call held, a host read made since the
 * question that says the session went on (not waiting, not stopped)
 * withdraws it at once as "Answered in Terminal.". Stop and Delete withdraw
 * at once. An Inbox restart forgets the leases: each open question gets a
 * fresh one, and the hook, retrying every 2 s, renews it.
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_PERMISSION_ANSWERED_IN_TERMINAL,
  INBOX_PERMISSION_ASK_IN_TERMINAL,
  INBOX_PERMISSION_NO_LONGER_WAITING,
  inboxPermissionAnswer,
  inboxPermissionQuestion,
  inboxPermissionSession,
  isInboxPermissionSession,
  readInboxPermissionEvent,
  type InboxPermissionChoice,
  type InboxPermissionEvent,
  type InboxPermissionQuestion,
} from "@plannotator/core/inbox-permission";
import type { InboxRunHostState } from "@plannotator/core/inbox-run-line";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const PERMISSION_HOLD_MS = 25_000;
export const PERMISSION_LEASE_MS = 60_000;
/** A host read this long after the question was asked can say the session went on without it. */
const HOST_SETTLE_MS = 5_000;
const CHECK_EVERY_MS = 200;

const HOST = "claude-code";
const AGENT_NAME = "Claude Code";

export type PermissionAnswer =
  | { status: "waiting"; message_id: string }
  | { status: "decided"; message_id: string; choice: InboxPermissionChoice; reason: string | null }
  | { status: "withdrawn"; message_id: string | null };

interface Lease {
  launchId: string;
  /** When no held call renews it any more, it runs out at this time. */
  expires: number;
  /** Calls held open now: the lease does not run out while one is. */
  holding: number;
  askedAt: number;
}

/** A launched thread's open permission questions (open or picked, not sent): message and when it was asked. */
export function openPermissionQuestions(store: InboxStore, threadId: string): { message: InboxMessage; at: number }[] {
  const out: { message: InboxMessage; at: number }[] = [];
  for (const id of store.threadMessageIds(threadId)) {
    const message = store.message(id);
    if (!message || message.author.kind !== "agent" || !isInboxPermissionSession(message.author.session)) continue;
    if (store.questionsOf(id).some((q) => q.state === "open" || q.state === "picked")) out.push({ message, at: Date.parse(message.created_at) });
  }
  return out;
}

export function createLaunchPermissions(options: {
  store: InboxStore;
  /** `<dataDir>/inbox/launch/<id>`. */
  launchDir: (launchId: string) => string;
  /** The launched root of an id that is not deleted, or null. */
  rootOf: (launchId: string) => InboxMessage | null;
  /** Every launched root that is not deleted. */
  roots: () => InboxMessage[];
  /** A folder as the person reads it (`~/…`). */
  displayFolder: (path: string) => string;
  /** The host's last word on a session (`claude agents --json --all`) and when it was read. */
  host: { stateOf: (ref: string | null) => InboxRunHostState | null; readAt: () => number };
  onChange: () => void;
  now?: () => number;
  log?: (line: string) => void;
  holdMs?: number;
  leaseMs?: number;
}) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const holdMs = options.holdMs ?? PERMISSION_HOLD_MS;
  const leaseMs = options.leaseMs ?? PERMISSION_LEASE_MS;
  const leases = new Map<string, Lease>();

  /** The key in the launch's settings file; null when there is no such file. */
  const keyOf = (launchId: string): string | null => {
    try {
      const settings = JSON.parse(readFileSync(join(options.launchDir(launchId), "settings.json"), "utf8")) as { env?: Record<string, unknown> };
      const key = settings.env?.PLANNOTATOR_LAUNCH_KEY;
      return typeof key === "string" && key.length >= 32 ? key : null;
    } catch {
      return null;
    }
  };
  const keyMatches = (launchId: string, given: unknown): boolean => {
    const expected = keyOf(launchId);
    if (!expected || typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** Withdraw one question: a follow-up from the same identity supersedes it. Nothing when it is no longer open. */
  const withdraw = (messageId: string, text: string): void => {
    leases.delete(messageId);
    const message = store.message(messageId);
    if (!message || message.author.kind !== "agent") return;
    if (!store.questionsOf(messageId).some((q) => q.state === "open" || q.state === "picked")) return;
    try {
      store.sendMessage({
        project_id: message.project_id,
        author: message.author,
        permission: true,
        body: text,
        reply_to: messageId,
        supersedes: [messageId],
        idempotency_key: `perm-withdraw-${messageId}`,
      });
      log(`Inbox launch: permission question ${messageId} withdrawn (${text})`);
    } catch (error) {
      log(`Inbox launch: could not withdraw ${messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    options.onChange();
  };

  /** The question this prompt asks in a launch's thread. */
  const questionFor = (root: InboxMessage, event: InboxPermissionEvent): InboxPermissionQuestion =>
    inboxPermissionQuestion(event, { agent: AGENT_NAME, folder: options.displayFolder(event.cwd ?? root.launch!.folder), shownPath: options.displayFolder });

  /**
   * Whether the stored question is exactly the one this prompt asks: the body
   * as written (the detail and the folder over the card), one question, its
   * prompt, and its choices the expected labels in order.
   */
  const asksExactly = (messageId: string, expected: InboxPermissionQuestion): boolean => {
    const questions = store.questionsOf(messageId);
    const stored = questions[0]?.choices.map((choice) => choice.label) ?? [];
    return (
      expected.askable &&
      store.message(messageId)?.body === expected.body &&
      questions.length === 1 &&
      questions[0]!.prompt === expected.prompt &&
      stored.length === expected.choices.length &&
      stored.every((label, i) => label === expected.choices[i])
    );
  };

  /** Where the question stands: decided (the delivery recorded), withdrawn, or still waiting (null). */
  const settled = (messageId: string, event: InboxPermissionEvent, expected: InboxPermissionQuestion): PermissionAnswer | null => {
    const question = store.questionsOf(messageId)[0];
    if (!question || question.state === "superseded" || question.state === "closed") return { status: "withdrawn", message_id: messageId };
    // Never answer a card that is not exactly this prompt's (its detail, its prompt, its three choices): Claude Code's own dialog decides.
    if (!asksExactly(messageId, expected)) {
      withdraw(messageId, INBOX_PERMISSION_ASK_IN_TERMINAL);
      return { status: "withdrawn", message_id: messageId };
    }
    if (question.state !== "sent") return null;
    const { choice, reason } = inboxPermissionAnswer(question.answer, event, options.displayFolder);
    const message = store.message(messageId);
    if (question.sent_reply_id && message?.author.kind === "agent" && message.author.session) {
      try {
        store.recordDelivery(question.sent_reply_id, { host: HOST, session: message.author.session });
      } catch {
        // Already recorded, or the reply went elsewhere: the decision stands.
      }
    }
    leases.delete(messageId);
    return { status: "decided", message_id: messageId, choice, reason };
  };

  /** The question's id, or null when this prompt is not asked here (its detail cannot be shown in full and exactly). */
  const ask = (root: InboxMessage, event: InboxPermissionEvent, requestId: string, question: InboxPermissionQuestion): string | null => {
    // The same request again (its answer was lost on the way): the question it already wrote.
    const key = `perm-${requestId}`;
    for (const id of store.threadMessageIds(root.thread_id)) {
      const earlier = store.message(id);
      if (earlier?.idempotency_key === key && earlier.author.kind === "agent" && isInboxPermissionSession(earlier.author.session)) return earlier.id;
    }
    if (!question.askable) {
      log(`Inbox launch ${root.launch!.id}: a ${event.tool_name} prompt that cannot be shown in full and exactly; left to Terminal`);
      return null;
    }
    const latest = store.threadMessageIds(root.thread_id).at(-1) ?? root.id;
    const sent = store.sendMessage({
      project_id: root.project_id,
      author: { kind: "agent", host: HOST, session: inboxPermissionSession(event.session_id), name: AGENT_NAME },
      permission: true,
      body: question.body,
      reply_to: latest,
      idempotency_key: key,
    });
    if (!sent.replayed) log(`Inbox launch ${root.launch!.id}: permission question ${sent.message.id} (${event.tool_name})`);
    options.onChange();
    return sent.message.id;
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  return {
    /** The hook's long poll (the connection guard already passed). */
    async handle(req: Request, launchId: string): Promise<Response> {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || !keyMatches(launchId, body.key)) return json({ error: "Not this launch's key.", code: "wrong_key" }, 403);
      const root = options.rootOf(launchId);
      if (!root) return json({ error: "That session was deleted.", code: "launch_gone" }, 410);
      const event = readInboxPermissionEvent(body.event);
      if (!event) return json({ error: "event: Claude Code's PermissionRequest input.", code: "validation_error" }, 400);
      const requestId = typeof body.request_id === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(body.request_id) ? body.request_id : null;
      const question = questionFor(root, event);
      let messageId: string;
      if (typeof body.message_id === "string") {
        const message = store.message(body.message_id);
        // Only a question of this launch's thread, from a permission identity.
        if (!message || message.thread_id !== root.thread_id || message.author.kind !== "agent" || !isInboxPermissionSession(message.author.session)) {
          return json({ error: "No such permission question in this launch.", code: "message_not_found" }, 404);
        }
        messageId = message.id;
      } else {
        if (!requestId) return json({ error: "request_id: 8 to 80 letters, digits, - or _.", code: "validation_error" }, 400);
        const asked = ask(root, event, requestId, question);
        if (!asked) return json({ status: "withdrawn", message_id: null } satisfies PermissionAnswer);
        messageId = asked;
      }
      const done = settled(messageId, event, question);
      if (done) return json(done);
      const lease = leases.get(messageId) ?? { launchId, expires: 0, holding: 0, askedAt: Date.parse(store.message(messageId)!.created_at) };
      leases.set(messageId, lease);
      lease.holding += 1;
      const deadline = now() + holdMs;
      try {
        while (now() < deadline && !req.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, CHECK_EVERY_MS));
          const answer = settled(messageId, event, question);
          if (answer) return json(answer);
        }
      } finally {
        lease.holding -= 1;
        lease.expires = now() + leaseMs;
      }
      return json({ status: "waiting", message_id: messageId } satisfies PermissionAnswer);
    },

    /** When the oldest open permission question of a launched thread was asked, or null (the run line's waiting_answer). */
    openSince(root: InboxMessage): number | null {
      const open = openPermissionQuestions(store, root.thread_id);
      return open.length === 0 ? null : Math.min(...open.map((q) => q.at));
    },

    /** Stop or Delete: every open question of this launch is withdrawn at once. */
    withdrawAll(root: InboxMessage): void {
      for (const { message } of openPermissionQuestions(store, root.thread_id)) withdraw(message.id, INBOX_PERMISSION_NO_LONGER_WAITING);
    },

    /**
     * Every second: an open question no lease covers (an Inbox restart) gets a
     * fresh one; a lease that ran out withdraws its question; a session the
     * host says went on without the hook's answer withdraws it as answered in
     * Terminal.
     */
    sweep(): void {
      const t = now();
      for (const root of options.roots()) {
        for (const { message, at } of openPermissionQuestions(store, root.thread_id)) {
          if (!leases.has(message.id)) leases.set(message.id, { launchId: root.launch!.id, expires: t + leaseMs, holding: 0, askedAt: at });
        }
      }
      for (const [messageId, lease] of leases) {
        const root = options.rootOf(lease.launchId);
        if (!root) {
          leases.delete(messageId);
          continue;
        }
        if (!store.questionsOf(messageId).some((q) => q.state === "open" || q.state === "picked")) {
          leases.delete(messageId);
          continue;
        }
        // A held call is the hook, alive and waiting: never withdrawn under it.
        if (lease.holding > 0) continue;
        const state = options.host.stateOf(root.launch!.session_ref);
        const fresh = options.host.readAt() >= lease.askedAt + HOST_SETTLE_MS;
        // Claude Code went on without our answer (a host read since the question): the person answered in Terminal.
        if (fresh && state !== null && state !== "absent" && state.status !== "waiting" && state.state !== "stopped" && state.state !== "done") {
          withdraw(messageId, INBOX_PERMISSION_ANSWERED_IN_TERMINAL);
          continue;
        }
        if (t < lease.expires) continue;
        withdraw(messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    /** Whether a lease is held for a launch now (the host's view is worth reading). */
    holds(launchId: string): boolean {
      for (const lease of leases.values()) if (lease.launchId === launchId) return true;
      return false;
    },
  };
}

export type LaunchPermissions = ReturnType<typeof createLaunchPermissions>;
