/**
 * Launch, PR 2: Claude Code's permission prompts answered in the launch
 * thread (PLAN "Permission hook"): Claude Code's transport and terms. The
 * questions themselves are the shared ones (inbox-launch-permission.ts). A
 * launched session's settings file runs `plannotator inbox permission-hook`
 * on every PermissionRequest (apps/hook/server/inbox-permission-hook.ts). The
 * hook long-polls
 *
 *   POST /api/inbox/launch/<id>/permission  { key, request_id, event, message_id? }
 *
 * Connection-guarded like the bridge (this machine, no browser, the Inbox
 * token), and the launch's own key, checked against `launch/<id>/settings.json`.
 *
 * The first call writes the question into the launch thread. Each call is
 * held up to 25 s and answers `waiting` (call again with the message id),
 * `decided` (`choice`: once, session, deny, auto or full, and the reason; the
 * hook builds the decision from its own event, and honours full only when its
 * own launch allows it; the call records the delivery) or `withdrawn` (say
 * nothing; Claude Code's own dialog stays).
 *
 * A lease withdraws a question no hook holds any more: each call renews it
 * for 60 s, and a held call keeps it. When it runs out (the hook timed out,
 * crashed, or Claude Code ended it because the person answered in Terminal),
 * a one-line follow-up from the same identity supersedes the question,
 * "No longer waiting.". With no call held, a host read made since the
 * question that says the session went on (not waiting, not stopped)
 * withdraws it at once as "Answered in Terminal.". Stop and Delete withdraw
 * at once. An Inbox restart forgets the leases: each open question gets a
 * fresh one, and the hook, retrying every 2 s, renews it. A question the host
 * takes no allow for (Approve in Terminal) is never withdrawn as answered in
 * Terminal: its dialog shows only after the hook ends, and may block the call
 * by itself, so "No longer waiting." is all that is known.
 *
 * The card states the person's answer, never what Claude did with it: the run
 * line says that ("waiting on a permission prompt" once a host read made after
 * the answer settled still shows the session on its dialog). A read made
 * before then still shows the prompt just answered, and counts for nothing
 * (`settledAfter`).
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_PERMISSION_ANSWERED_IN_TERMINAL,
  INBOX_PERMISSION_NO_LONGER_WAITING,
  INBOX_PERMISSION_TERMINAL,
  isInboxPermissionSession,
  readInboxPermissionEvent,
  type InboxPermissionEvent,
  type InboxPermissionOptions,
  type InboxPermissionQuestion,
} from "@plannotator/core/inbox-permission";
import { INBOX_HOST_NAMES, type InboxLaunchRecord, type InboxMessage } from "@plannotator/core/inbox-types";
import type { LaunchPermissionContext } from "./inbox-launch-host";
import { createLaunchQuestions, openPermissionQuestions, type PermissionAnswer, type PermissionTarget } from "./inbox-launch-permission";

export const PERMISSION_HOLD_MS = 25_000;
export const PERMISSION_LEASE_MS = 60_000;
/** A host read this long after the question was asked can say the session went on without it. */
const HOST_SETTLE_MS = 5_000;
/** After an answer, a host read this much later says where the session is (earlier reads still show the prompt). */
export const ANSWER_SETTLE_MS = 3_000;
const CHECK_EVERY_MS = 200;

/** Claude Code's name: To's row, a refusal, its questions' author. */
export const CLAUDE_NAME = INBOX_HOST_NAMES["claude-code"] ?? "Claude Code";

/** Claude Code's hook timeout for the permission hook: four days, as the plugin's ExitPlanMode hook. */
const PERMISSION_HOOK_TIMEOUT_S = 345_600;

/** One shell word: single-quoted. */
const shellWord = (word: string) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The per-launch PermissionRequest hook: every tool (ExitPlanMode passes straight through to plan review). */
export function launchPermissionHooks(self: readonly string[]) {
  const command = [...self, "inbox", "permission-hook"].map(shellWord).join(" ");
  return { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command, timeout: PERMISSION_HOOK_TIMEOUT_S }] }] };
}

/**
 * Claude Code 2.1.314 takes a PermissionRequest hook's allow only when the ask
 * lets hooks allow it. Its own safety checks (removing the working folder, for
 * one) do not: it awaits the hooks, ignores an allow, takes a deny, and only
 * then shows its own dialog, which blocks the call by itself after about 2
 * minutes. The hook's input does not mark such a check, but it carries the
 * session's `permission_mode`, and in bypass mode only such checks reach the
 * hook (one limit: a `permissions.ask` rule of the person's own, if Claude asks
 * it in bypass mode, gets the same card although a hook could allow it). So a
 * session in bypass mode is offered Deny, or Approve in Terminal: the hook says
 * nothing, Claude's own dialog comes up, and the person approves it there.
 */
export const CLAUDE_TERMINAL_ONLY = "Claude Code only accepts this approval in Terminal.";
/** After Approve in Terminal: Claude's dialog waits about 2 minutes, then blocks the call. */
export const CLAUDE_HANDOFF = "Approve it in Claude Code within 2 minutes.";

/** Whether the session runs in bypass mode: its hook input's `permission_mode`; the launch record only when the input has none. */
export function claudeInBypass(launch: Pick<InboxLaunchRecord, "full_permissions">, event: { permission_mode: string | null }): boolean {
  return event.permission_mode !== null ? event.permission_mode === "bypassPermissions" : launch.full_permissions === true;
}

/** What a permission card may offer: in bypass mode no mode switch, and no allow from here (Deny, or Approve in Terminal). */
export function claudePermissionTerms(
  launch: Pick<InboxLaunchRecord, "full_permissions">,
  event: { permission_mode: string | null },
): { full: boolean; allowHere: boolean; note: string | null; handoff: string | null } {
  return claudeInBypass(launch, event)
    ? { full: true, allowHere: false, note: CLAUDE_TERMINAL_ONLY, handoff: CLAUDE_HANDOFF }
    : { full: false, allowHere: true, note: null, handoff: null };
}

interface Lease {
  launchId: string;
  /** When no held call renews it any more, it runs out at this time. */
  expires: number;
  /** Calls held open now: the lease does not run out while one is. */
  holding: number;
  askedAt: number;
}

export function createLaunchPermissions(options: LaunchPermissionContext & { holdMs?: number; leaseMs?: number }) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const holdMs = options.holdMs ?? PERMISSION_HOLD_MS;
  const leaseMs = options.leaseMs ?? PERMISSION_LEASE_MS;
  const leases = new Map<string, Lease>();
  /** The latest answer handed to a hook, per launch. */
  const answeredAt = new Map<string, number>();
  const questions = createLaunchQuestions({ store, name: CLAUDE_NAME, displayFolder: options.displayFolder, onChange: options.onChange, log, forget: (messageId) => leases.delete(messageId) });

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

  /**
   * How a launch's questions read paths, and whether Full permissions is a choice: only in a launch whose
   * person recorded Claude Code's bypass consent (`bypass_available`, so it started with
   * --allow-dangerously-skip-permissions). Claude ignores a switch to bypass without it; an older launch has no flag.
   */
  const optionsFor = (root: InboxMessage, event: InboxPermissionEvent): InboxPermissionOptions => {
    // The host's terms: in bypass mode (as its hook input says) no allow from here, and no mode switch.
    const terms = claudePermissionTerms(root.launch!, event);
    return { shownPath: options.displayFolder, fullPermissions: root.launch!.bypass_available === true && !terms.full, ...terms };
  };

  /** The question this prompt asks in a launch's thread. */
  const questionFor = (root: InboxMessage, event: InboxPermissionEvent, target: PermissionTarget = {}): InboxPermissionQuestion =>
    questions.questionFor(root, event, { ...optionsFor(root, event), ...target });

  /** Where the question stands: decided (the delivery recorded), withdrawn, or still waiting (null). */
  const settled = (messageId: string, event: InboxPermissionEvent, expected: InboxPermissionQuestion, answerOptions: InboxPermissionOptions): PermissionAnswer | null => {
    const done = questions.settled(messageId, event, expected, answerOptions);
    if (done?.status === "decided") leases.delete(messageId);
    return done;
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
      const answerOptions = optionsFor(root, event);
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
        const asked = questions.ask(root, event, requestId, questionFor(root, event, await questions.targetNow(root, event)));
        if (!asked) return json({ status: "withdrawn", message_id: null } satisfies PermissionAnswer);
        messageId = asked;
      }
      // The question as asked: a Write's file may have appeared since (or a link changed), and the card keeps the words it was asked with.
      const question = questionFor(root, event, questions.askedTarget(messageId, event));
      /** A decision: a host read before it settles still shows this prompt. */
      const answered = (answer: PermissionAnswer) => {
        if (answer.status === "decided") answeredAt.set(launchId, now());
        return json(answer);
      };
      const done = settled(messageId, event, question, answerOptions);
      if (done) return answered(done);
      const lease = leases.get(messageId) ?? { launchId, expires: 0, holding: 0, askedAt: Date.parse(store.message(messageId)!.created_at) };
      leases.set(messageId, lease);
      lease.holding += 1;
      const deadline = now() + holdMs;
      try {
        while (now() < deadline && !req.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, CHECK_EVERY_MS));
          const answer = settled(messageId, event, question, answerOptions);
          if (answer) return answered(answer);
        }
      } finally {
        lease.holding -= 1;
        lease.expires = now() + leaseMs;
      }
      return json({ status: "waiting", message_id: messageId } satisfies PermissionAnswer);
    },

    /** Stop or Delete: every open question of this launch is withdrawn at once. */
    withdrawAll: questions.withdrawAll,

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
        // Claude Code went on without our answer (a host read since the question): the person answered in Terminal,
        // unless the host takes no allow from here (its dialog may have blocked the call by itself: not known).
        if (fresh && state !== null && state !== "absent" && state.status !== "waiting" && state.state !== "stopped" && state.state !== "done") {
          const terminalOnly = store.questionsOf(messageId)[0]?.choices.some((c) => c.label === INBOX_PERMISSION_TERMINAL) === true;
          questions.withdraw(messageId, terminalOnly ? INBOX_PERMISSION_NO_LONGER_WAITING : INBOX_PERMISSION_ANSWERED_IN_TERMINAL);
          continue;
        }
        if (t < lease.expires) continue;
        questions.withdraw(messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    /** Whether a lease is held for a launch now (the host's view is worth reading). */
    holds(launchId: string): boolean {
      for (const lease of leases.values()) if (lease.launchId === launchId) return true;
      return false;
    },

    /** A host read made before this still shows the launch's last answered prompt (it counts for nothing), or null. */
    settledAfter(launchId: string): number | null {
      const at = answeredAt.get(launchId);
      return at === undefined ? null : at + ANSWER_SETTLE_MS;
    },

    /** Whether a launch's answer has settled since the last host read (one more read says where the session is). */
    readDue(readAt: number): boolean {
      const t = now();
      for (const at of answeredAt.values()) if (readAt < at + ANSWER_SETTLE_MS && t >= at + ANSWER_SETTLE_MS) return true;
      return false;
    },

    /** A deleted launch: nothing kept for it. */
    forget(launchId: string): void {
      answeredAt.delete(launchId);
    },
  };
}
