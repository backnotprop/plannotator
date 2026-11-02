/**
 * Launch: a launched session's permission prompts as questions in its thread,
 * whatever the agent (PLAN "Permission hook"). How a prompt reaches the Inbox
 * and how the answer goes back is the host's (Claude Code's hook, key and
 * leases: inbox-launch-claude-permission.ts); this file writes the question,
 * reads the answer and withdraws it.
 *
 * A question is written into the launch thread, a reply to its latest
 * message, authored `{ <launch.agent>, perm:<session id>, <agent name> }` and
 * without `wakes`: the person's answer is addressed to `perm:…`, which no poll
 * claims, so it never becomes a second turn. A question whose stored body,
 * prompt or choices are not exactly this prompt's is withdrawn, never
 * answered; one whose detail cannot be shown in full and exactly (too long,
 * or a path or link holding a line break or a control) is never asked. A
 * withdrawal is a one-line follow-up from the same identity that supersedes
 * the question.
 */

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

/** How long the Inbox looks at a file's path before it asks (an unreachable network path never freezes it). */
export const FILE_CHECK_MS = 300;

/** The file checks `fileTarget` makes: node's, or a test's. */
export interface FileChecks {
  lstat: (path: string) => Promise<{ isSymbolicLink(): boolean }>;
  stat: (path: string) => Promise<unknown>;
  readlink: (path: string) => Promise<string>;
}

/** A promise's value or its error code, or `timeout` after `ms` (the call itself is left to finish on its own). */
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

/**
 * What a file tool's path is now, read without blocking the Inbox: whether the file exists (the write
 * goes through a link to where it points), and where it points when the path is a symbolic link.
 * Anything not known in `ms` (an unreachable network path, an error) is left unknown: "Write a file".
 */
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

/** When the oldest open permission question of a launched thread was asked, or null (the run line's waiting_answer). */
export function openPermissionSince(store: InboxStore, threadId: string): number | null {
  const open = openPermissionQuestions(store, threadId);
  return open.length === 0 ? null : Math.min(...open.map((q) => q.at));
}

/** What the Inbox found at a file tool's path: a Write's file exists, does not, or is not known; where a link points. */
export type PermissionTarget = Pick<InboxPermissionOptions, "overwrite" | "linksTo">;

/**
 * One host's questions. `name` is its agent's name (the question's words and author); the author's host is
 * the launch's `agent`. `forget` runs first whenever a question is withdrawn (the host drops what it holds for it).
 */
export function createLaunchQuestions(options: {
  store: InboxStore;
  name: string;
  displayFolder: (path: string) => string;
  onChange: () => void;
  log: (line: string) => void;
  forget?: (messageId: string) => void;
}) {
  const { store, log } = options;

  /** Withdraw one question: a follow-up from the same identity supersedes it. Nothing when it is no longer open. */
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

  return {
    withdraw,

    /** Stop, Delete, launch off: every open question of the launch is withdrawn now. */
    withdrawAll(root: InboxMessage): void {
      for (const { message } of openPermissionQuestions(store, root.thread_id)) withdraw(message.id, INBOX_PERMISSION_NO_LONGER_WAITING);
    },

    /** The question this prompt asks in a launch's thread, with the host's terms and what is at its file (`options`). */
    questionFor(root: InboxMessage, event: InboxPermissionEvent, terms: InboxPermissionOptions): InboxPermissionQuestion {
      return inboxPermissionQuestion(event, { agent: options.name, folder: options.displayFolder(event.cwd ?? root.launch!.folder), ...terms });
    },

    /** A file tool's path now (the card says "overwrite" or "create", and where a link points); nothing when it cannot tell. */
    async targetNow(root: InboxMessage, event: InboxPermissionEvent): Promise<PermissionTarget> {
      const path = event.tool_input.file_path ?? event.tool_input.notebook_path;
      if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(event.tool_name) || typeof path !== "string" || path === "") return {};
      const found = await fileTarget(isAbsolute(path) ? path : resolve(event.cwd ?? root.launch!.folder, path));
      return { ...(event.tool_name === "Write" ? { overwrite: found.exists } : {}), ...(found.linksTo ? { linksTo: options.displayFolder(found.linksTo) } : {}) };
    },

    /** What a stored question said about its file when it was asked: the question is rebuilt with the same words. */
    askedTarget(messageId: string, event: InboxPermissionEvent): PermissionTarget {
      const read = readInboxPermissionBody(store.message(messageId)?.body ?? "");
      const kind = event.tool_name === "Write" ? read.preview?.kind : undefined;
      return { overwrite: kind === "overwrite" ? true : kind === "new" ? false : undefined, ...(read.linksTo !== null ? { linksTo: read.linksTo } : {}) };
    },

    /** The question's id, or null when this prompt is not asked here (its detail cannot be shown in full and exactly). */
    ask(root: InboxMessage, event: InboxPermissionEvent, requestId: string, question: InboxPermissionQuestion): string | null {
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
        author: { kind: "agent", host: root.launch!.agent, session: inboxPermissionSession(event.session_id), name: options.name },
        permission: true,
        body: question.body,
        reply_to: latest,
        idempotency_key: key,
      });
      if (!sent.replayed) log(`Inbox launch ${root.launch!.id}: permission question ${sent.message.id} (${event.tool_name})`);
      options.onChange();
      return sent.message.id;
    },

    /**
     * Where the question stands: withdrawn, decided (the person's choice, the delivery recorded to its
     * `perm:` author), or still waiting (null). A question that is not exactly `expected` is withdrawn.
     */
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
