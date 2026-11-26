/**
 * A launched Mistral Vibe session's tool approvals, answered on its Inbox thread's permission card. The questions are
 * the shared ones (inbox-launch-permission.ts); this is Vibe's transport and terms.
 *
 * Vibe asks with `session/request_permission` on the session's `vibe-acp` (inbox-launch-vibe.ts). The request names
 * only the tool call (`toolCall.toolCallId`); what the call does comes from the `tool_call` update Vibe sent just
 * before it. Each request becomes one question from `{ mistral-vibe, perm:<Vibe session id>, "Mistral Vibe" }`:
 *
 *   bash        a command (the card: "run a command")
 *   write_file  Write, with its content
 *   edit        Edit, with its change
 *   read_file   Read
 *   any other   the tool by its own name, its input as JSON
 *
 * The answer goes back as the request's result: Allow once is Vibe's `allow_once`, Allow … for this session its
 * session option (never one that writes the person's config), Deny its `reject_once`. A Deny's reason follows as the
 * session's next turn. Vibe's modes are the person's own (`modes: false`), and the Inbox owns the process: no Approve
 * in Terminal. A turn that ended, a Stop, or a process that ended with a question still open withdraws it.
 */

import { createHash } from "node:crypto";
import {
  INBOX_PERMISSION_NO_LONGER_WAITING,
  type InboxPermissionChoice,
  type InboxPermissionEvent,
  type InboxPermissionOptions,
  type InboxPermissionQuestion,
} from "@plannotator/core/inbox-permission";
import { INBOX_VIBE_HOST, INBOX_VIBE_NAME, type InboxMessage } from "@plannotator/core/inbox-types";
import { writeLaunchNote, type LaunchHostPermissions, type LaunchPermissionContext } from "./inbox-launch-host";
import { createLaunchQuestions, openPermissionQuestions } from "./inbox-launch-permission";

export const VIBE_PERMISSION_REQUEST = "session/request_permission";

/** The thread note for a request the card cannot show, declined at once. */
export const VIBE_DECLINED_NOTE = "Vibe asked for an approval the Inbox can't show yet; declined.";

/** Vibe's terms for every card: Allow once, the session choice and Deny; no mode switch, no Terminal. */
export const VIBE_PERMISSION_TERMS: InboxPermissionOptions = { modes: false, full: false, fullPermissions: false, allowHere: true, terminal: false, note: null, handoff: null };

/** One option of a Vibe permission request. */
export interface VibePermissionOption {
  optionId: string;
  kind?: string;
  _meta?: { required_permissions?: { scope?: unknown; session_pattern?: unknown; invocation_pattern?: unknown }[] };
}

/** The `tool_call` update a request is for, as Vibe sent it (later `tool_call_update`s merged in). */
export interface VibeToolCall {
  toolCallId: string;
  title?: unknown;
  kind?: unknown;
  rawInput?: unknown;
  _meta?: { tool_name?: unknown };
}

/** The question's key for one request: the session and the tool call, hashed. */
export function vibeApprovalKey(session: string, toolCallId: string): string {
  return `vibe-${createHash("sha256").update(JSON.stringify([session, toolCallId])).digest("hex")}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Vibe's own ids for "for this session only" (vibe-acp 3.1.3). Allowed by name, never by what a name lacks: an id Vibe
 * adds later may write the person's config, and a session choice must never do that.
 */
export const VIBE_SESSION_OPTION_IDS: ReadonlySet<string> = new Set(["allow_always", "allow_session_exact", "allow_session_directory_recursive"]);

/** Vibe's option for this session only, or null when it offers none of the known ones. */
export function vibeSessionOption(options: readonly VibePermissionOption[]): VibePermissionOption | null {
  return options.find((option) => option.kind === "allow_always" && VIBE_SESSION_OPTION_IDS.has(option.optionId)) ?? null;
}

/**
 * A request as the card's event (the vocabulary of Claude Code's PermissionRequest, which the card draws), or null
 * when its tool call is unknown. The session choice is offered only in words that say what Vibe's own session
 * option grants: a command pattern, one file, or the whole tool.
 */
export function vibePermissionEvent(session: string, cwd: string | null, call: VibeToolCall | undefined, options: readonly VibePermissionOption[]): InboxPermissionEvent | null {
  if (!call) return null;
  const tool = str(call._meta?.tool_name);
  const input = isRecord(call.rawInput) ? call.rawInput : {};
  if (!tool) return null;
  const sessionOption = vibeSessionOption(options);
  const granted = sessionOption?._meta?.required_permissions ?? [];
  const rule = (toolName: string, ruleContent: string) => (sessionOption ? [{ type: "addRules", behavior: "allow", rules: [{ toolName, ruleContent }] }] : []);
  const base = { session_id: session, cwd, permission_mode: null };
  if (tool === "bash") {
    const command = str(input.command);
    if (!command?.trim()) return null;
    const pattern = granted.length === 1 && granted[0]!.scope === "command_pattern" ? str(granted[0]!.session_pattern) : null;
    return { ...base, tool_name: "Bash", tool_input: { command }, permission_suggestions: pattern ? rule("Bash", pattern) : [] };
  }
  const path = str(input.filePath);
  if (tool === "write_file" && path && typeof input.content === "string") {
    return { ...base, tool_name: "Write", tool_input: { file_path: path, content: input.content }, permission_suggestions: granted.length === 0 ? rule("Write", "") : [] };
  }
  if (tool === "edit" && path && typeof input.oldString === "string" && typeof input.newString === "string") {
    const tool_input = { file_path: path, old_string: input.oldString, new_string: input.newString, ...(input.replaceAll === true ? { replace_all: true } : {}) };
    return { ...base, tool_name: "Edit", tool_input, permission_suggestions: granted.length === 0 ? rule("Edit", "") : [] };
  }
  if (tool === "read_file" && path) {
    // Outside the folder, Vibe's session option allows that one file.
    const exact = granted.length === 1 && granted[0]!.invocation_pattern === path ? rule("Read", path) : granted.length === 0 ? rule("Read", "") : [];
    return { ...base, tool_name: "Read", tool_input: { file_path: path }, permission_suggestions: exact };
  }
  return { ...base, tool_name: tool, tool_input: input, permission_suggestions: granted.length === 0 ? rule(tool, "") : [] };
}

/** The request's result for the person's choice: Vibe's own option, or cancelled when it offered none that fits. */
export function vibeDecision(choice: InboxPermissionChoice, options: readonly VibePermissionOption[]): { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } } {
  const pick = (option: VibePermissionOption | null | undefined) => (option ? { outcome: { outcome: "selected" as const, optionId: option.optionId } } : { outcome: { outcome: "cancelled" as const } });
  if (choice === "session") return pick(vibeSessionOption(options) ?? options.find((o) => o.kind === "allow_once"));
  if (choice === "once" || choice === "auto" || choice === "full") return pick(options.find((o) => o.kind === "allow_once"));
  return pick(options.find((o) => o.kind === "reject_once"));
}

/** The process a request came on (opaque here: the host's own). */
export interface VibeTarget {
  readonly ref: string;
  readonly launchId: string;
  readonly exited: boolean;
}

interface Pending {
  key: string;
  target: VibeTarget;
  rpcId: number | string;
  options: VibePermissionOption[];
  event: InboxPermissionEvent;
  messageId: string;
  question: InboxPermissionQuestion;
}

export function createVibePermissions(
  options: LaunchPermissionContext & {
    /** Answer the request on its process; false when it could not go (the process ended). */
    respond: (target: VibeTarget, id: number | string, result: unknown) => boolean;
    /** A Deny's reason, as the session's next turn. */
    followUp: (target: VibeTarget, text: string) => void;
  },
): LaunchHostPermissions & {
  asked(target: VibeTarget, id: number | string, params: Record<string, any>, call: VibeToolCall | undefined, cwd: string): void;
  turnEnded(ref: string): void;
  processEnded(target: VibeTarget): void;
} {
  const { store } = options;
  const log = options.log ?? (() => {});
  const pending = new Map<string, Pending>();
  const questions = createLaunchQuestions({ store, name: INBOX_VIBE_NAME, displayFolder: options.displayFolder, onChange: options.onChange, log });
  const terms: InboxPermissionOptions = { ...VIBE_PERMISSION_TERMS, shownPath: options.displayFolder };
  const rootOf = (ref: string): InboxMessage | null => options.roots().find((root) => root.launch!.session_ref === ref && root.launch!.agent === INBOX_VIBE_HOST) ?? null;
  /** Each request left open is answered cancelled (Vibe's own turn waits on it), and its question withdrawn. */
  const withdrawWhere = (drop: (p: Pending) => boolean) => {
    for (const p of [...pending.values()]) {
      if (!drop(p)) continue;
      pending.delete(p.key);
      options.respond(p.target, p.rpcId, { outcome: { outcome: "cancelled" } });
      questions.withdraw(p.messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
    }
  };

  return {
    asked(target, id, params, call, cwd) {
      const offered = (Array.isArray(params.options) ? params.options : []).filter((o: unknown): o is VibePermissionOption => isRecord(o) && typeof o.optionId === "string");
      const root = rootOf(target.ref);
      const event = root ? vibePermissionEvent(target.ref, cwd, call, offered) : null;
      const key = vibeApprovalKey(target.ref, call?.toolCallId ?? String(params.toolCall?.toolCallId ?? id));
      const decline = () => options.respond(target, id, vibeDecision("deny", offered));
      if (!root || !event) {
        decline();
        log(`Inbox launch: a Vibe approval the card cannot show; declined`);
        if (root) writeLaunchNote(options, root, { author: { host: INBOX_VIBE_HOST, session: root.launch!.session ?? target.ref, name: INBOX_VIBE_NAME }, body: VIBE_DECLINED_NOTE, key: `vibe-declined-${key}` }, log);
        return;
      }
      const question = questions.questionFor(root, event, terms);
      const messageId = questions.ask(root, event, key, question);
      if (!messageId) {
        decline();
        return;
      }
      pending.set(key, { key, target, rpcId: id, options: offered, event, messageId, question });
      options.onChange();
    },

    turnEnded(ref) {
      withdrawWhere((p) => p.target.ref === ref);
    },

    processEnded(target) {
      withdrawWhere((p) => p.target === target);
    },

    /** Every second: answer each request the person decided; withdraw an open question no request is behind any more. */
    sweep(): void {
      for (const p of [...pending.values()]) {
        const done = questions.settled(p.messageId, p.event, p.question, terms);
        if (!done) continue;
        pending.delete(p.key);
        if (done.status !== "decided") {
          // Withdrawn (a newer card, a hand edit): denied, so Vibe's turn goes on without it. `cancelled` would end the turn.
          options.respond(p.target, p.rpcId, vibeDecision("deny", p.options));
          continue;
        }
        if (!options.respond(p.target, p.rpcId, vibeDecision(done.choice, p.options))) continue;
        log(`Inbox launch: Vibe approval answered ${done.choice}`);
        if (done.choice === "deny" && done.reason) options.followUp(p.target, `The person denied that in the Inbox: ${done.reason}`);
        options.onChange();
      }
      // A question with no request behind it (an earlier Inbox's, whose process ended with it): no longer waiting.
      const held = new Set([...pending.values()].map((p) => p.messageId));
      for (const root of options.roots()) {
        if (root.launch!.agent !== INBOX_VIBE_HOST) continue;
        for (const { message } of openPermissionQuestions(store, root.thread_id)) if (!held.has(message.id)) questions.withdraw(message.id, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    withdrawAll(root) {
      withdrawWhere((p) => p.target.ref === root.launch!.session_ref);
      questions.withdrawAll(root);
    },

    forget(launchId) {
      for (const p of [...pending.values()]) if (p.target.launchId === launchId) pending.delete(p.key);
    },
  };
}
