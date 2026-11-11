/** A launched session's permission prompts as questions in its thread, whatever the agent; transport and answers are the host's (inbox-launch-claude-permission.ts). The question is authored `perm:<session id>` with no `wakes`, so the person's answer never becomes a second turn. A question whose stored body, prompt or choices are not exactly this prompt's is withdrawn, never answered. */

import { lstat, readlink, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  INBOX_PERMISSION_ASK_IN_TERMINAL,
  INBOX_PERMISSION_NO_LONGER_WAITING,
  inboxPermissionAnswer,
  inboxPermissionQuestion,
  inboxPermissionSession,
  isInboxPermissionSession,
  readInboxPermissionBody,
  type InboxPermissionChoice,
  type InboxPermissionEvent,
  type InboxPermissionOptions,
  type InboxPermissionQuestion,
} from "@plannotator/core/inbox-permission";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const FILE_CHECK_MS = 300;

export interface FileChecks {
  lstat: (path: string) => Promise<{ isSymbolicLink(): boolean }>;
  stat: (path: string) => Promise<unknown>;
  readlink: (path: string) => Promise<string>;
}

function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { error: string }> {
  return new Promise((done) => {
    const timer = setTimeout(() => done({ error: "timeout" }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        done({ value });
      },
      (cause: unknown) => {
        clearTimeout(timer);
        done({ error: (cause as { code?: unknown } | null)?.code === "ENOENT" ? "ENOENT" : "error" });
      },
    );
  });
}

export async function fileTarget(path: string, ms = FILE_CHECK_MS, fs: FileChecks = { lstat, stat, readlink }): Promise<{ exists?: boolean; linksTo?: string }> {
  const [own, through, link] = await Promise.all([within(fs.lstat(path), ms), within(fs.stat(path), ms), within(fs.readlink(path), ms)]);
  if ("error" in own) return own.error === "ENOENT" ? { exists: false } : {};
  if (!own.value.isSymbolicLink()) return { exists: true };
  const linksTo = "value" in link ? link.value : undefined;
  const exists = "value" in through ? true : through.error === "ENOENT" ? false : undefined;
  return { ...(exists === undefined ? {} : { exists }), ...(linksTo ? { linksTo } : {}) };
}

export type PermissionAnswer =
  | { status: "waiting"; message_id: string }
  | { status: "decided"; message_id: string; choice: InboxPermissionChoice; reason: string | null }
  | { status: "withdrawn"; message_id: string | null };

export function openPermissionQuestions(store: InboxStore, threadId: string): { message: InboxMessage; at: number }[] {
  const out: { message: InboxMessage; at: number }[] = [];
  for (const id of store.threadMessageIds(threadId)) {
    const message = store.message(id);
    if (!message || message.author.kind !== "agent" || !isInboxPermissionSession(message.author.session)) continue;
    if (store.questionsOf(id).some((q) => q.state === "open" || q.state === "picked")) out.push({ message, at: Date.parse(message.created_at) });
  }
  return out;
}

export function openPermissionSince(store: InboxStore, threadId: string): number | null {
  const open = openPermissionQuestions(store, threadId);
  return open.length === 0 ? null : Math.min(...open.map((q) => q.at));
}

export function lastPermissionAnswerAt(store: InboxStore, threadId: string): number | null {
  let latest: number | null = null;
  for (const id of store.threadMessageIds(threadId)) {
    const message = store.message(id);
    if (!message || message.author.kind !== "agent" || !isInboxPermissionSession(message.author.session)) continue;
    for (const question of store.questionsOf(id)) {
      const reply = question.state === "sent" && question.sent_reply_id ? store.message(question.sent_reply_id) : null;
      if (reply) latest = Math.max(latest ?? 0, Date.parse(reply.created_at));
    }
  }
  return latest;
}

export type PermissionTarget = Pick<InboxPermissionOptions, "overwrite" | "linksTo">;

export function createLaunchQuestions(options: {
  store: InboxStore;
  name: string;
  displayFolder: (path: string) => string;
  onChange: () => void;
  log: (line: string) => void;
  forget?: (messageId: string) => void;
}) {
  const { store, log } = options;

  const withdraw = (messageId: string, text: string): void => {
    options.forget?.(messageId);
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

  return {
    withdraw,

    withdrawAll(root: InboxMessage): void {
      for (const { message } of openPermissionQuestions(store, root.thread_id)) withdraw(message.id, INBOX_PERMISSION_NO_LONGER_WAITING);
    },

    questionFor(root: InboxMessage, event: InboxPermissionEvent, terms: InboxPermissionOptions): InboxPermissionQuestion {
      return inboxPermissionQuestion(event, { agent: options.name, folder: options.displayFolder(event.cwd ?? root.launch!.folder), ...terms });
    },

    async targetNow(root: InboxMessage, event: InboxPermissionEvent): Promise<PermissionTarget> {
      const path = event.tool_input.file_path ?? event.tool_input.notebook_path;
      if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(event.tool_name) || typeof path !== "string" || path === "") return {};
      const found = await fileTarget(isAbsolute(path) ? path : resolve(event.cwd ?? root.launch!.folder, path));
      return { ...(event.tool_name === "Write" ? { overwrite: found.exists } : {}), ...(found.linksTo ? { linksTo: options.displayFolder(found.linksTo) } : {}) };
    },

    askedTarget(messageId: string, event: InboxPermissionEvent): PermissionTarget {
      const read = readInboxPermissionBody(store.message(messageId)?.body ?? "");
      const kind = event.tool_name === "Write" ? read.preview?.kind : undefined;
      return { overwrite: kind === "overwrite" ? true : kind === "new" ? false : undefined, ...(read.linksTo !== null ? { linksTo: read.linksTo } : {}) };
    },

    ask(root: InboxMessage, event: InboxPermissionEvent, requestId: string, question: InboxPermissionQuestion): string | null {
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
        author: { kind: "agent", host: root.launch!.agent, session: inboxPermissionSession(event.session_id), name: options.name },
        permission: true,
        body: question.body,
        reply_to: latest,
        idempotency_key: key,
      });
      if (!sent.replayed) {
        log(`Inbox launch ${root.launch!.id}: permission question ${sent.message.id} (${event.tool_name})`);
        // The agent is blocked on this answer, so a snoozed thread wakes at once.
        store.endSnooze(root.thread_id);
      }
      options.onChange();
      return sent.message.id;
    },

    settled(messageId: string, event: InboxPermissionEvent, expected: InboxPermissionQuestion, answerOptions: InboxPermissionOptions): PermissionAnswer | null {
      const question = store.questionsOf(messageId)[0];
      if (!question || question.state === "superseded" || question.state === "closed") return { status: "withdrawn", message_id: messageId };
      // Never answer a card that is not exactly this prompt's (its detail, its prompt, its choices): the agent's own dialog decides.
      if (!asksExactly(messageId, expected)) {
        withdraw(messageId, INBOX_PERMISSION_ASK_IN_TERMINAL);
        return { status: "withdrawn", message_id: messageId };
      }
      if (question.state !== "sent") return null;
      const { choice, reason } = inboxPermissionAnswer(question.answer, event, answerOptions);
      const message = store.message(messageId);
      if (question.sent_reply_id && message?.author.kind === "agent" && message.author.host && message.author.session) {
        try {
          store.recordDelivery(question.sent_reply_id, { host: message.author.host, session: message.author.session });
        } catch {
          // Already recorded, or the reply went elsewhere: the decision stands.
        }
      }
      return { status: "decided", message_id: messageId, choice, reason };
    },
  };
}
