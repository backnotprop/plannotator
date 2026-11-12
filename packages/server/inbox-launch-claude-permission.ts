import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_PERMISSION_ALLOW_ONCE,
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
import { createLaunchQuestions, lastPermissionAnswerAt, openPermissionQuestions, type PermissionAnswer, type PermissionTarget } from "./inbox-launch-permission";
import { powerShellCommandLine } from "./inbox-launch-windows";

export const PERMISSION_HOLD_MS = 25_000;
export const PERMISSION_LEASE_MS = 60_000;
const HOST_SETTLE_MS = 5_000;
export const ANSWER_SETTLE_MS = 3_000;
const CHECK_EVERY_MS = 200;

export const CLAUDE_NAME = INBOX_HOST_NAMES["claude-code"] ?? "Claude Code";

const PERMISSION_HOOK_TIMEOUT_S = 345_600;

const shellWord = (word: string) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

export function launchPermissionHooks(self: readonly string[], platform: NodeJS.Platform = process.platform) {
  const argv = [...self, "inbox", "permission-hook"];
  const hook =
    platform === "win32"
      ? { type: "command", shell: "powershell", command: powerShellCommandLine(argv), timeout: PERMISSION_HOOK_TIMEOUT_S }
      : { type: "command", command: argv.map(shellWord).join(" "), timeout: PERMISSION_HOOK_TIMEOUT_S };
  return { PermissionRequest: [{ matcher: "*", hooks: [hook] }] };
}

export const CLAUDE_TERMINAL_ONLY = "Claude Code only accepts this approval in Terminal.";
export const CLAUDE_HANDOFF = "Approve it in Claude Code within 2 minutes.";
export const CLAUDE_HANDOFF_PLAIN = "Approve it in Claude Code, in Terminal.";

export function claudeInBypass(launch: Pick<InboxLaunchRecord, "full_permissions">, event: { permission_mode: string | null }): boolean {
  return event.permission_mode !== null ? event.permission_mode === "bypassPermissions" : launch.full_permissions === true;
}

export function claudePermissionTerms(
  launch: Pick<InboxLaunchRecord, "full_permissions">,
  event: { permission_mode: string | null },
): { full: boolean; allowHere: boolean; terminal: true; note: string | null; handoff: string } {
  return claudeInBypass(launch, event)
    ? { full: true, allowHere: false, terminal: true, note: CLAUDE_TERMINAL_ONLY, handoff: CLAUDE_HANDOFF }
    : { full: false, allowHere: true, terminal: true, note: null, handoff: CLAUDE_HANDOFF_PLAIN };
}

interface Lease {
  launchId: string;
  expires: number;
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
  const answeredAt = new Map<string, number>();
  const questions = createLaunchQuestions({ store, name: CLAUDE_NAME, displayFolder: options.displayFolder, onChange: options.onChange, log, forget: (messageId) => leases.delete(messageId) });
  const settledAt = (root: InboxMessage): number | null => {
    const at = Math.max(lastPermissionAnswerAt(store, root.thread_id) ?? 0, answeredAt.get(root.launch!.id) ?? 0);
    return at === 0 ? null : at + ANSWER_SETTLE_MS;
  };

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

  const optionsFor = (root: InboxMessage, event: InboxPermissionEvent): InboxPermissionOptions => {
    const terms = claudePermissionTerms(root.launch!, event);
    return { shownPath: options.displayFolder, fullPermissions: root.launch!.bypass_available === true && !terms.full, ...terms };
  };

  const questionFor = (root: InboxMessage, event: InboxPermissionEvent, target: PermissionTarget = {}): InboxPermissionQuestion =>
    questions.questionFor(root, event, { ...optionsFor(root, event), ...target });

  const settled = (messageId: string, event: InboxPermissionEvent, expected: InboxPermissionQuestion, answerOptions: InboxPermissionOptions): PermissionAnswer | null => {
    const done = questions.settled(messageId, event, expected, answerOptions);
    if (done?.status === "decided") leases.delete(messageId);
    return done;
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  return {
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
      const question = questionFor(root, event, questions.askedTarget(messageId, event));
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

    withdrawAll: questions.withdrawAll,

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
        if (lease.holding > 0) continue;
        const state = options.host.stateOf(root.launch!.session_ref);
        const fresh = options.host.readAt() >= lease.askedAt + HOST_SETTLE_MS;
        if (fresh && state !== null && state !== "absent" && state.status !== "waiting" && state.state !== "stopped" && state.state !== "done") {
          const offered = store.questionsOf(messageId)[0]?.choices.map((c) => c.label) ?? [];
          const terminalOnly = offered.includes(INBOX_PERMISSION_TERMINAL) && !offered.includes(INBOX_PERMISSION_ALLOW_ONCE);
          questions.withdraw(messageId, terminalOnly ? INBOX_PERMISSION_NO_LONGER_WAITING : INBOX_PERMISSION_ANSWERED_IN_TERMINAL);
          continue;
        }
        if (t < lease.expires) continue;
        questions.withdraw(messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    holds(launchId: string): boolean {
      for (const lease of leases.values()) if (lease.launchId === launchId) return true;
      return false;
    },

    settledAfter(launchId: string): number | null {
      const root = options.rootOf(launchId);
      return root ? settledAt(root) : null;
    },

    readDue(readAt: number): boolean {
      const t = now();
      return options.roots().some((root) => {
        const at = settledAt(root);
        return at !== null && readAt < at && t >= at;
      });
    },

    forget(launchId: string): void {
      answeredAt.delete(launchId);
    },
  };
}
