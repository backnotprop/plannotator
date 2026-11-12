import { createHash } from "node:crypto";
import { INBOX_PERMISSION_NO_LONGER_WAITING, type InboxPermissionChoice, type InboxPermissionEvent, type InboxPermissionOptions, type InboxPermissionQuestion } from "@plannotator/core/inbox-permission";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { LaunchHostPermissions, LaunchPermissionContext } from "./inbox-launch-host";
import { createLaunchQuestions, openPermissionQuestions } from "./inbox-launch-permission";

export const OPENCODE = "opencode" as const;
export const OPENCODE_NAME = "OpenCode";

export const OPENCODE_PERMISSION_TERMS: InboxPermissionOptions = { modes: false, full: false, fullPermissions: false, allowHere: true, terminal: false, note: null, handoff: null };

export interface OpenCodePermissionAsked {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
}

export function openCodePermissionKey(sessionID: string, requestID: string): string {
  return `opencode-${createHash("sha256").update(JSON.stringify([sessionID, requestID])).digest("hex")}`;
}

export function openCodePermissionEvent(asked: OpenCodePermissionAsked, cwd: string | null): InboxPermissionEvent {
  const base = { session_id: asked.sessionID, cwd, permission_mode: null, permission_suggestions: [] };
  const one = asked.resources.length === 1 ? asked.resources[0]! : null;
  if (asked.action === "shell" && asked.resources.length > 0) return { ...base, tool_name: "Bash", tool_input: { command: asked.resources.join("\n") } };
  if (one !== null && (asked.action === "edit" || asked.action === "write")) return { ...base, tool_name: "Edit", tool_input: { file_path: one } };
  if (one !== null && asked.action === "read") return { ...base, tool_name: "Read", tool_input: { file_path: one } };
  if (one !== null && asked.action === "webfetch") return { ...base, tool_name: "WebFetch", tool_input: { url: one } };
  if (one !== null && asked.action === "websearch") return { ...base, tool_name: "WebSearch", tool_input: { query: one } };
  return { ...base, tool_name: asked.action, tool_input: { resources: asked.resources } };
}

export function openCodeDecision(choice: InboxPermissionChoice): "once" | "reject" {
  return choice === "deny" ? "reject" : "once";
}

export interface OpenCodeTarget {
  readonly session: string | null;
  readonly launchId: string;
  readonly folder: string;
  readonly exited: boolean;
}

interface Pending {
  key: string;
  target: OpenCodeTarget;
  requestID: string;
  event: InboxPermissionEvent;
  messageId: string;
  question: InboxPermissionQuestion;
}

export function createOpenCodePermissions(
  options: LaunchPermissionContext & {
    respond: (target: OpenCodeTarget, requestID: string, decision: "once" | "reject") => Promise<boolean>;
    tell: (target: OpenCodeTarget, text: string) => void;
  },
): LaunchHostPermissions & {
  asked(target: OpenCodeTarget, asked: OpenCodePermissionAsked): void;
  replied(requestID: string): void;
  processEnded(target: OpenCodeTarget): void;
} {
  const { store } = options;
  const log = options.log ?? (() => {});
  const pending = new Map<string, Pending>();
  const questions = createLaunchQuestions({ store, name: OPENCODE_NAME, displayFolder: options.displayFolder, onChange: options.onChange, log });
  const terms: InboxPermissionOptions = { ...OPENCODE_PERMISSION_TERMS, shownPath: options.displayFolder };
  const rootOf = (session: string): InboxMessage | null => options.roots().find((root) => root.launch!.session_ref === session && root.launch!.agent === OPENCODE) ?? null;
  const drop = (p: Pending) => {
    pending.delete(p.key);
    questions.withdraw(p.messageId, INBOX_PERMISSION_NO_LONGER_WAITING);
  };

  return {
    asked(target, asked) {
      const root = rootOf(asked.sessionID);
      if (!root) return;
      const key = openCodePermissionKey(asked.sessionID, asked.id);
      if (pending.has(key)) return;
      const event = openCodePermissionEvent(asked, target.folder);
      const question = questions.questionFor(root, event, terms);
      const messageId = questions.ask(root, event, key, question);
      if (!messageId) return;
      pending.set(key, { key, target, requestID: asked.id, event, messageId, question });
      options.onChange();
    },

    replied(requestID) {
      for (const p of [...pending.values()]) if (p.requestID === requestID) drop(p);
    },

    processEnded(target) {
      for (const p of [...pending.values()]) if (p.target === target) drop(p);
    },

    sweep(): void {
      for (const p of [...pending.values()]) {
        const done = questions.settled(p.messageId, p.event, p.question, terms);
        if (!done || done.status !== "decided") continue;
        pending.delete(p.key);
        const decision = openCodeDecision(done.choice);
        void options.respond(p.target, p.requestID, decision).then((sent) => {
          if (!sent) return;
          log(`Inbox launch: OpenCode permission ${p.requestID} answered ${decision}`);
          if (decision === "reject" && done.reason) options.tell(p.target, `The person denied that in the Inbox: ${done.reason}`);
          options.onChange();
        });
      }
      const held = new Set([...pending.values()].map((p) => p.messageId));
      for (const root of options.roots()) {
        if (root.launch!.agent !== OPENCODE) continue;
        for (const { message } of openPermissionQuestions(store, root.thread_id)) if (!held.has(message.id)) questions.withdraw(message.id, INBOX_PERMISSION_NO_LONGER_WAITING);
      }
    },

    withdrawAll(root) {
      for (const p of [...pending.values()]) if (p.target.session === root.launch!.session_ref) pending.delete(p.key);
      questions.withdrawAll(root);
    },

    forget(launchId) {
      for (const p of [...pending.values()]) if (p.target.launchId === launchId) pending.delete(p.key);
    },
  };
}
