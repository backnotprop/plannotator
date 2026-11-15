/**
 * A launched Codex thread's approval requests, answered on its Inbox thread's permission card. The questions are the
 * shared ones (inbox-launch-permission.ts); this is Codex's transport and terms. The mapping is PR #2407's.
 *
 * Codex sends them as server requests on the thread's `codex app-server` (inbox-launch-codex.ts):
 *
 *   item/commandExecution/requestApproval  a command (the card: "run a command")
 *   item/fileChange/requestApproval        a patch; its change is in the item's `item/started`
 *   item/permissions/requestApproval       more sandbox access (network, folders)
 *
 * Each becomes one question from `{ codex, perm:<thread id>, "Codex" }`, keyed by the thread, item and approval id.
 * The answer goes back as the request's result: Allow once is `accept`, Allow <command> for this session
 * `acceptForSession` (Codex's session cache, for that exact command), Deny `decline` (the agent goes on; the person's
 * reason follows into the running turn with `turn/steer`). Codex has no modes to switch to (`modes: false`), and the
 * Inbox owns the process, so no other Codex can take the request: no Approve in Terminal.
 *
 * A turn that ended, a Stop, or a process that ended with a question still open withdraws it as no longer waiting,
 * and so does a question an earlier Inbox run asked (its process ended with that Inbox). A request the card cannot
 * show whole (a patch of several files, a delete or a move) is declined at once, with a note in the thread.
 */

import { createHash } from "node:crypto";
import {
  INBOX_PERMISSION_NO_LONGER_WAITING,
  type InboxPermissionChoice,
  type InboxPermissionEvent,
  type InboxPermissionOptions,
  type InboxPermissionQuestion,
} from "@plannotator/core/inbox-permission";
import { INBOX_CODEX_HOST, INBOX_CODEX_NAME, type InboxMessage } from "@plannotator/core/inbox-types";
import { writeLaunchNote, type LaunchHostPermissions, type LaunchPermissionContext } from "./inbox-launch-host";
import { createLaunchQuestions, openPermissionQuestions } from "./inbox-launch-permission";

export const CODEX_COMMAND_APPROVAL = "item/commandExecution/requestApproval";
export const CODEX_FILE_APPROVAL = "item/fileChange/requestApproval";
export const CODEX_PERMISSIONS_APPROVAL = "item/permissions/requestApproval";
export const CODEX_APPROVALS: ReadonlySet<string> = new Set([CODEX_COMMAND_APPROVAL, CODEX_FILE_APPROVAL, CODEX_PERMISSIONS_APPROVAL]);

/** The thread note for a request the card cannot show whole, declined at once. */
export const CODEX_DECLINED_NOTE = "Codex asked for an approval the Inbox can't show yet; declined.";

/** Codex's terms for every card: Allow once, the session choice and Deny; no mode switch, no Terminal. */
export const CODEX_PERMISSION_TERMS: InboxPermissionOptions = { modes: false, full: false, fullPermissions: false, allowHere: true, terminal: false, note: null, handoff: null };

/**
 * The question's key for one approval request: the whole (thread, item, approval id), hashed, so two requests of one
 * item never share a card however long their ids.
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
 * A Codex approval request as the card's event (the vocabulary of Claude Code's PermissionRequest, which the card
 * draws), or null when the card cannot show it whole: a command as Bash (its reason as the purpose; Codex's own
 * session cache as the session choice, only for a command shown exactly); a patch of one new file as Write, of one
 * changed file as Edit or MultiEdit; more access as `request_permissions` with the request as JSON.
 */
export function codexPermissionEvent(method: string, params: Record<string, any>, changes: readonly CodexFileChange[] | undefined): InboxPermissionEvent | null {
  const base = { session_id: String(params.threadId), cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : null, permission_mode: null };
  const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : null;
  if (method === CODEX_COMMAND_APPROVAL) {
    const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
    if ((params.kind ?? "command") !== "command" || typeof command !== "string" || !command.trim()) return null;
    // More sandbox access with the command: the card would show the command only.
    if (params.additionalPermissions !== undefined && params.additionalPermissions !== null) return null;
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
    if (change.kind?.type === "add") return { ...base, tool_name: "Write", tool_input: { file_path: change.path, content: change.diff }, permission_suggestions: [] };
    if (change.kind?.type !== "update" || change.kind.move_path) return null;
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

/** The request's result for the person's choice. */
export function codexDecision(method: string, params: Record<string, any>, choice: InboxPermissionChoice): unknown {
  const allow = choice === "once" || choice === "session" || choice === "auto" || choice === "full";
  if (method === CODEX_PERMISSIONS_APPROVAL) {
    const asked = (params.permissions ?? {}) as Record<string, unknown>;
    const granted = Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== null && value !== undefined));
    return { permissions: allow ? granted : {}, scope: choice === "session" ? "session" : "turn" };
  }
  return { decision: !allow ? "decline" : choice === "session" ? "acceptForSession" : "accept" };
}

/** The process a request came on (opaque here: the host's own). */
export interface CodexTarget {
  readonly thread: string;
  readonly launchId: string;
  readonly exited: boolean;
}

interface Pending {
  key: string;
  target: CodexTarget;
  rpcId: number | string;
  method: string;
  params: Record<string, any>;
  event: InboxPermissionEvent;
  messageId: string;
  question: InboxPermissionQuestion;
}

export function createCodexPermissions(
  options: LaunchPermissionContext & {
    /** Answer the request on its process; false when it could not go (the process ended). */
    respond: (target: CodexTarget, id: number | string, result: unknown) => boolean;
    steer: (target: CodexTarget, turnId: string, text: string) => void;
    /** An app-server of this Inbox runs the thread now. */
    running: (thread: string) => boolean;
  },
): LaunchHostPermissions & {
  asked(target: CodexTarget, id: number | string, method: string, params: Record<string, any>): void;
  turnEnded(thread: string): void;
  fileChange(itemId: unknown, changes: unknown): void;
  processEnded(target: CodexTarget): void;
} {
  const { store } = options;
  const log = options.log ?? (() => {});
  const pending = new Map<string, Pending>();
  const changesByItem = new Map<string, CodexFileChange[]>();
  const questions = createLaunchQuestions({ store, name: INBOX_CODEX_NAME, displayFolder: options.displayFolder, onChange: options.onChange, log });
  const terms: InboxPermissionOptions = { ...CODEX_PERMISSION_TERMS, shownPath: options.displayFolder };
  const rootOfThread = (thread: string): InboxMessage | null => options.roots().find((root) => root.launch!.session_ref === thread && root.launch!.agent === INBOX_CODEX_HOST) ?? null;
  const withdrawWhere = (keep: (p: Pending) => boolean) => {
    for (const p of [...pending.values()]) {
      if (keep(p)) continue;
      pending.delete(p.key);
      questions.withdraw(p.messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
    }
  };

  return {
    asked(target, id, method, params) {
      const root = rootOfThread(target.thread);
      const event = root ? codexPermissionEvent(method, params, changesByItem.get(String(params.itemId))) : null;
      if (!root || !event) {
        // Not a launched thread of this Inbox, or not one the card can show whole: declined at once, and said.
        options.respond(target, id, codexDecision(method, params, "deny"));
        log(`Inbox launch: a Codex ${method} the card cannot show whole; declined`);
        if (root) writeLaunchNote(options, root, { author: { host: INBOX_CODEX_HOST, session: target.thread, name: INBOX_CODEX_NAME }, body: CODEX_DECLINED_NOTE, key: `codex-declined-${codexApprovalKey(target.thread, params.itemId, params.approvalId)}` }, log);
        return;
      }
      const key = codexApprovalKey(target.thread, params.itemId, params.approvalId);
      const question = questions.questionFor(root, event, terms);
      const messageId = questions.ask(root, event, key, question);
      if (!messageId) {
        options.respond(target, id, codexDecision(method, params, "deny"));
        return;
      }
      pending.set(key, { key, target, rpcId: id, method, params, event, messageId, question });
      options.onChange();
    },

    turnEnded(thread) {
      withdrawWhere((p) => p.target.thread !== thread);
    },

    processEnded(target) {
      withdrawWhere((p) => p.target !== target);
    },

    fileChange(itemId, changes) {
      if (typeof itemId !== "string" || !Array.isArray(changes)) return;
      changesByItem.set(itemId, changes as CodexFileChange[]);
      // Kept for the request that may follow; only the latest few.
      if (changesByItem.size > 50) changesByItem.delete(changesByItem.keys().next().value!);
    },

    /** Every second: answer each request the person decided; withdraw an open question no request is behind any more. */
    sweep(): void {
      for (const p of [...pending.values()]) {
        const done = questions.settled(p.messageId, p.event, p.question, terms);
        if (!done || done.status !== "decided") continue;
        pending.delete(p.key);
        if (!options.respond(p.target, p.rpcId, codexDecision(p.method, p.params, done.choice))) continue;
        log(`Inbox launch: Codex ${p.method} answered ${done.choice}`);
        if (done.choice === "deny" && done.reason && typeof p.params.turnId === "string") options.steer(p.target, p.params.turnId, `The person denied that in the Inbox: ${done.reason}`);
        options.onChange();
      }
      // A question with no request behind it (an earlier Inbox's, whose process ended with it): no longer waiting.
      const held = new Set([...pending.values()].map((p) => p.messageId));
      for (const root of options.roots()) {
        if (root.launch!.agent !== INBOX_CODEX_HOST) continue;
        for (const { message } of openPermissionQuestions(store, root.thread_id)) if (!held.has(message.id)) questions.withdraw(message.id, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    withdrawAll(root) {
      for (const p of [...pending.values()]) {
        if (p.target.thread !== root.launch!.session_ref) continue;
        pending.delete(p.key);
        // Codex stops waiting with the process; the request is declined so a running turn does not hang meanwhile.
        options.respond(p.target, p.rpcId, codexDecision(p.method, p.params, "deny"));
      }
      questions.withdrawAll(root);
    },

    forget(launchId) {
      for (const p of [...pending.values()]) if (p.target.launchId === launchId) pending.delete(p.key);
    },
  };
}
