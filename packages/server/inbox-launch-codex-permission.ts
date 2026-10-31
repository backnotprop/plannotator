/**
 * Launch, PR 4: a launched Codex thread's approval requests answered in its
 * Inbox thread. The questions are the shared ones
 * (inbox-launch-permission.ts); this is Codex's transport and terms.
 *
 * Codex pushes them: a server request on the app-server connection
 * (inbox-launch-codex.ts) for a thread this connection is on:
 *
 *   item/commandExecution/requestApproval  a command (the card: "run a command")
 *   item/fileChange/requestApproval        a patch; its change is in the item's `item/started`
 *   item/permissions/requestApproval       more sandbox access (network, folders)
 *
 * Each becomes one question from `{ codex, perm:<thread id>, "Codex" }`, keyed by
 * the thread, item and approval id, so a request Codex sends again (after a
 * dropped connection, on `thread/resume`) is the same question. The answer
 * goes back as the request's result: Allow once is `accept`, Allow <command>
 * for this session `acceptForSession` (Codex's session cache, for that exact
 * command), Deny `decline` (the agent goes on; the person's reason follows
 * into the running turn with `turn/steer`). Codex has no modes to switch to
 * (`modes: false`). Approve in Terminal answers nothing: `codex resume <id>`
 * shows the request there.
 *
 * `serverRequest/resolved` for a request no answer of ours settled withdraws
 * the question as answered in Terminal; a turn that ended (or Stop) with it
 * still open, as no longer waiting. A request the card cannot show in full and
 * exactly (a patch of several files, a delete or a move, an unknown request)
 * is not asked: the run line says Codex waits on Terminal.
 */

import { createHash } from "node:crypto";
import {
  INBOX_PERMISSION_ANSWERED_IN_TERMINAL,
  INBOX_PERMISSION_ASK_IN_TERMINAL,
  INBOX_PERMISSION_NO_LONGER_WAITING,
  isInboxPermissionSession,
  type InboxPermissionChoice,
  type InboxPermissionEvent,
  type InboxPermissionOptions,
  type InboxPermissionQuestion,
} from "@plannotator/core/inbox-permission";
import { INBOX_CODEX_NAME, type InboxMessage } from "@plannotator/core/inbox-types";
import type { LaunchHostPermissions, LaunchPermissionContext } from "./inbox-launch-host";
import { createLaunchQuestions, openPermissionQuestions } from "./inbox-launch-permission";
import type { CodexThreadStatus } from "./inbox-launch-codex";

export const CODEX_COMMAND_APPROVAL = "item/commandExecution/requestApproval";
export const CODEX_FILE_APPROVAL = "item/fileChange/requestApproval";
export const CODEX_PERMISSIONS_APPROVAL = "item/permissions/requestApproval";
const APPROVALS = new Set([CODEX_COMMAND_APPROVAL, CODEX_FILE_APPROVAL, CODEX_PERMISSIONS_APPROVAL]);

/** The record's line after Approve in Terminal. */
export const CODEX_HANDOFF = "Approve it in Codex, in Terminal.";
/** An open question with no request behind it this long after connecting (an Inbox restart, the request gone): no longer waiting. */
const ADOPT_MS = 5_000;

/** Codex's terms for every card: no mode switch, Approve in Terminal (`codex resume` shows the request). */
export const CODEX_PERMISSION_TERMS: InboxPermissionOptions = { modes: false, full: false, fullPermissions: false, allowHere: true, terminal: true, note: null, handoff: CODEX_HANDOFF };

/**
 * The question's key for one approval request: the whole (thread, item, approval id), hashed, so two requests
 * of one item never share a card however long their ids. The store's idempotency key is `perm-<key>` (75 characters).
 */
export function codexApprovalKey(threadId: string, itemId: unknown, approvalId: unknown): string {
  const whole = JSON.stringify([threadId, itemId ?? null, approvalId ?? null]);
  return `codex-${createHash("sha256").update(whole).digest("hex")}`;
}

/** One change of a Codex patch (`FileUpdateChange`). */
export interface CodexFileChange {
  path: string;
  kind: { type: "add" | "delete" | "update"; move_path?: string | null };
  diff: string;
}

/** A unified diff's hunks as Edit changes: each hunk's removed lines and added lines (context left out). */
export function codexDiffEdits(diff: string): { old_string: string; new_string: string }[] | null {
  const hunks: { old: string[]; added: string[] }[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) hunks.push({ old: [], added: [] });
    else if (hunks.length === 0 || line.startsWith("\\")) continue;
    else if (line.startsWith("-")) hunks.at(-1)!.old.push(line.slice(1));
    else if (line.startsWith("+")) hunks.at(-1)!.added.push(line.slice(1));
  }
  const edits = hunks.filter((h) => h.old.length > 0 || h.added.length > 0).map((h) => ({ old_string: h.old.join("\n"), new_string: h.added.join("\n") }));
  return edits.length > 0 ? edits : null;
}

/**
 * A Codex approval request as the card's event (the vocabulary of Claude Code's PermissionRequest, which
 * the card draws), or null when the card cannot show it whole: a command as Bash (its reason as the
 * purpose; Codex's own session cache as the session choice, only for a command shown exactly); a patch of one
 * new file as Write, of one changed file as Edit or MultiEdit; more access as `request_permissions` with the
 * request as JSON.
 */
export function codexPermissionEvent(method: string, params: Record<string, any>, changes: readonly CodexFileChange[] | undefined): InboxPermissionEvent | null {
  const base = { session_id: String(params.threadId), cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : null, permission_mode: null };
  const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : null;
  if (method === CODEX_COMMAND_APPROVAL) {
    if ((params.kind ?? "command") !== "command" || typeof params.command !== "string" || !params.command.trim()) return null;
    // More sandbox access with the command (experimental): the card would show the command only, so Terminal decides.
    if (params.additionalPermissions !== undefined && params.additionalPermissions !== null) return null;
    const command = params.command as string;
    // Codex's session approval is for this exact command: offered only when the card's rule words show it exactly.
    const exact = !/(?::\*|\s\*)$/.test(command.trim());
    return {
      ...base,
      tool_name: "Bash",
      tool_input: { command, ...(reason ? { description: reason } : {}) },
      permission_suggestions: exact ? [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: command }] }] : [],
    };
  }
  if (method === CODEX_FILE_APPROVAL) {
    if (!changes || changes.length !== 1) return null;
    const change = changes[0]!;
    if (change.kind.type === "add") return { ...base, tool_name: "Write", tool_input: { file_path: change.path, content: change.diff }, permission_suggestions: [] };
    if (change.kind.type !== "update" || change.kind.move_path) return null;
    const edits = codexDiffEdits(change.diff);
    if (!edits) return null;
    const tool_input = edits.length === 1 ? { file_path: change.path, ...edits[0]! } : { file_path: change.path, edits };
    return { ...base, tool_name: edits.length === 1 ? "Edit" : "MultiEdit", tool_input, permission_suggestions: [] };
  }
  if (method === CODEX_PERMISSIONS_APPROVAL) {
    return { ...base, tool_name: "request_permissions", tool_input: { ...(reason ? { reason } : {}), permissions: params.permissions ?? {} }, permission_suggestions: [] };
  }
  return null;
}

/** The request's result for the person's choice; null for Approve in Terminal (no answer: Codex's own prompt decides). */
export function codexDecision(method: string, params: Record<string, any>, choice: InboxPermissionChoice): unknown | null {
  if (choice === "terminal") return null;
  const allow = choice === "once" || choice === "session" || choice === "auto" || choice === "full";
  if (method === CODEX_PERMISSIONS_APPROVAL) {
    const asked = (params.permissions ?? {}) as Record<string, unknown>;
    const granted = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== null && value !== undefined));
    return { permissions: allow ? granted : {}, scope: choice === "session" ? "session" : "turn" };
  }
  return { decision: !allow ? "decline" : choice === "session" ? "acceptForSession" : "accept" };
}

interface Pending {
  key: string;
  threadId: string;
  /** The JSON-RPC id to answer on the connection now; null once the connection dropped (until Codex sends it again). */
  rpcId: number | string | null;
  method: string;
  params: Record<string, any>;
  event: InboxPermissionEvent | null;
  messageId: string | null;
  question: InboxPermissionQuestion | null;
  answered: boolean;
}

export function createCodexPermissions(
  options: LaunchPermissionContext & {
    /** Answer the request on the connection now; false when it could not go (no connection). */
    respond: (id: number | string, result: unknown) => boolean;
    steer: (threadId: string, turnId: string, text: string) => void;
    /** A thread's status as this connection last saw it; null while not connected. */
    status: (threadId: string) => CodexThreadStatus | null;
    /** When the connection opened; null while not connected. */
    connectedAt: () => number | null;
    /** Connect again after an Inbox restart and rejoin threads that run a turn (throttled by the host). */
    rejoin: () => void;
  },
): LaunchHostPermissions & {
  asked(id: number | string, method: string, params: any): void;
  resolved(requestId: unknown): void;
  turnEnded(threadId: string): void;
  fileChange(itemId: unknown, changes: unknown): void;
  connectionLost(): void;
} {
  const { store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const pending = new Map<string, Pending>();
  const byRpc = new Map<string, string>();
  const changesByItem = new Map<string, CodexFileChange[]>();
  const questions = createLaunchQuestions({ store, name: INBOX_CODEX_NAME, displayFolder: options.displayFolder, onChange: options.onChange, log });
  const terms: InboxPermissionOptions = { ...CODEX_PERMISSION_TERMS, shownPath: options.displayFolder };

  /** The open card a request with this key wrote before (an earlier Inbox run), or null. */
  const earlierCard = (root: InboxMessage, key: string): string | null => {
    for (const { message } of openPermissionQuestions(store, root.thread_id)) {
      if (message.idempotency_key === `perm-${key}` && message.author.kind === "agent" && isInboxPermissionSession(message.author.session)) return message.id;
    }
    return null;
  };
  const rootOfThread = (threadId: string): InboxMessage | null => options.roots().find((root) => root.launch!.session_ref === threadId) ?? null;
  const drop = (p: Pending) => {
    pending.delete(p.key);
    if (p.rpcId !== null) byRpc.delete(String(p.rpcId));
  };

  return {
    asked(id, method, params) {
      if (!APPROVALS.has(method) || !params || typeof params.threadId !== "string") return;
      const root = rootOfThread(params.threadId);
      // Not a launched thread of this Inbox: another client of the daemon answers it.
      if (!root) return;
      const key = codexApprovalKey(params.threadId, params.itemId, params.approvalId);
      const known = pending.get(key);
      if (known) {
        // Sent again (a dropped connection, `thread/resume`): the same question, answered on this request's id. An
        // answer given before is sent again on it (Codex still asks, so the last one did not reach it).
        if (known.rpcId !== null) byRpc.delete(String(known.rpcId));
        known.rpcId = id;
        known.answered = false;
        byRpc.set(String(id), key);
        options.onChange();
        return;
      }
      const event = codexPermissionEvent(method, params, changesByItem.get(String(params.itemId)));
      const entry: Pending = { key, threadId: params.threadId, rpcId: id, method, params, event, messageId: null, question: null, answered: false };
      if (event) {
        const question = questions.questionFor(root, event, terms);
        entry.question = question;
        entry.messageId = questions.ask(root, event, key, question);
      } else {
        log(`Inbox launch ${root.launch!.id}: a Codex ${method} the card cannot show whole; left to Terminal`);
        // Its card from an earlier Inbox run (a patch's change is seen only in its `item/started`, never sent again):
        // it cannot be answered from here any more.
        const earlier = earlierCard(root, key);
        if (earlier) questions.withdraw(earlier, INBOX_PERMISSION_ASK_IN_TERMINAL);
      }
      pending.set(key, entry);
      byRpc.set(String(id), key);
      options.onChange();
    },

    resolved(requestId) {
      const key = byRpc.get(String(requestId));
      const p = key ? pending.get(key) : undefined;
      if (!p) return;
      drop(p);
      // Settled without our answer: the person answered in Terminal (`codex resume`).
      if (!p.answered && p.messageId) questions.withdraw(p.messageId, INBOX_PERMISSION_ANSWERED_IN_TERMINAL);
      options.onChange();
    },

    turnEnded(threadId) {
      for (const p of [...pending.values()]) {
        if (p.threadId !== threadId) continue;
        drop(p);
        if (!p.answered && p.messageId) questions.withdraw(p.messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    fileChange(itemId, changes) {
      if (typeof itemId !== "string" || !Array.isArray(changes)) return;
      changesByItem.set(itemId, changes as CodexFileChange[]);
      // Kept for the request that may follow; only the latest few.
      if (changesByItem.size > 50) changesByItem.delete(changesByItem.keys().next().value!);
    },

    connectionLost() {
      for (const p of pending.values()) p.rpcId = null;
      byRpc.clear();
    },

    /**
     * Every second: answer each request the person decided; after a restart, rejoin threads that run a turn (so
     * Codex sends their requests again), and withdraw an open question no request is behind any more.
     */
    sweep(): void {
      options.rejoin();
      for (const p of [...pending.values()]) {
        if (p.answered || !p.messageId || !p.event || !p.question || p.rpcId === null) continue;
        const done = questions.settled(p.messageId, p.event, p.question, terms);
        if (!done || done.status !== "decided") continue;
        const result = codexDecision(p.method, p.params, done.choice);
        if (result === null) {
          p.answered = true;
          continue;
        }
        // Answered only once it went: with no connection it goes on the request Codex sends again.
        if (!options.respond(p.rpcId, result)) continue;
        p.answered = true;
        log(`Inbox launch: Codex ${p.method} answered ${done.choice}`);
        if (done.choice === "deny" && done.reason && typeof p.params.turnId === "string") options.steer(p.threadId, p.params.turnId, `The person denied that in the Inbox: ${done.reason}`);
        options.onChange();
      }
      const since = options.connectedAt();
      if (since === null || now() - since < ADOPT_MS) return;
      const held = new Set([...pending.values()].map((p) => p.messageId));
      for (const root of options.roots()) {
        const ref = root.launch!.session_ref;
        if (!ref) continue;
        const status = options.status(ref);
        // Not read since connecting (nothing known), or waiting on an approval: its request may still come again.
        if (!status || (status.type === "active" && status.activeFlags?.includes("waitingOnApproval"))) continue;
        for (const { message } of openPermissionQuestions(store, root.thread_id)) if (!held.has(message.id)) questions.withdraw(message.id, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    withdrawAll(root) {
      for (const p of [...pending.values()]) if (p.threadId === root.launch!.session_ref) drop(p);
      questions.withdrawAll(root);
    },

    forget(launchId) {
      const root = options.roots().find((r) => r.launch!.id === launchId);
      if (!root) return;
      for (const p of [...pending.values()]) if (p.threadId === root.launch!.session_ref) drop(p);
    },
  };
}
