/**
 * The assistant replies `/plannotator-last` and the tool's `last` offer, for
 * OpenCode 1 (embedded runtime and CLI bridge) and OpenCode 2 alike.
 *
 * The one that opens is the newest reply to a prompt the person wrote, not the
 * newest reply overall (#3312): a plugin that wakes the session with an
 * injected prompt (a background task, a memory extraction) gets a short status
 * reply that would otherwise open instead. An injected prompt is an OpenCode 2
 * `synthetic` row, or an OpenCode 1 user message whose parts are all synthetic.
 *
 * A reply belongs to the prompt of its turn. OpenCode 1's `parentID` is
 * trusted only when it names a prompt the person wrote: OpenCode 1 parents the
 * rest of a turn on the injected rows it adds inside it (the "Continue…" row
 * after an auto-compaction, the "Summarize the task tool output…" row of a
 * subtask command). Otherwise the turn is read from the order: a prompt row
 * starts a turn, and an assistant step ends it unless it called a tool the
 * host runs (a provider-hosted tool such as web search is not followed by
 * another step) or stopped at the output limit; a failed step always ends it.
 * An injected row stored after a step or a compaction of the person's running
 * turn stays part of it: Plannotator's session-URL notice (posted while its
 * tool call is open) and OpenCode's continuation rows. Right after the prompt
 * only OpenCode 2's Plan-mode reminder does (matched by its text): any other
 * injected row there means the prompt got no reply. Compaction rows and their
 * summary do not change the turn; a summary opens only when nothing else can.
 */

import { readMessageAgent } from "./message-agent";
import { isOpenCode2PlanReminder } from "./plan-reminder";

export interface RecentAssistantMessage {
  messageId: string;
  text: string;
  timestamp?: string;
  /**
   * The agent that wrote the message (#1612). Plugin-side only: it decides who
   * answers the feedback and is never sent to the CLI.
   */
  agent?: string;
}

type HostPart = {
  type?: unknown;
  text?: unknown;
  synthetic?: unknown;
  provider?: { executed?: unknown };
  metadata?: { providerExecuted?: unknown };
};
type HostMessage = {
  info?: {
    id?: unknown;
    role?: unknown;
    parentID?: unknown;
    error?: unknown;
    finish?: unknown;
    summary?: unknown;
    time?: { created?: unknown };
    agent?: unknown;
  };
  parts?: unknown;
};

function isInjectedPrompt(role: unknown, parts: HostPart[]): boolean {
  if (role === "synthetic") return true;
  return parts.length > 0
    && parts.every((part) => part?.synthetic === true || part?.type === "synthetic");
}

/** A tool the host runs. A provider-hosted one (V2 `provider.executed`, V1 `metadata.providerExecuted`) gets no step after it. */
function callsHostTool(parts: HostPart[]): boolean {
  return parts.some((part) => part?.type === "tool"
    && part.provider?.executed !== true
    && part.metadata?.providerExecuted !== true);
}

function isPlanReminder(parts: HostPart[]): boolean {
  return parts.some((part) => typeof part?.text === "string" && isOpenCode2PlanReminder(part.text));
}

/**
 * Newest first, except that the reply that opens is always first. Replies to
 * injected prompts open only when there is no other.
 */
export function pickRecentAssistantMessages(
  messages: readonly unknown[] | undefined,
  limit = 25,
): RecentAssistantMessage[] {
  if (!messages) return [];

  const replies: Array<{ message: RecentAssistantMessage; injected: boolean }> = [];
  const personPrompts = new Set<string>();
  let turnRunning = false;
  let turnInjected = false;
  // Something ran since the turn's prompt (a step, a compaction).
  let turnStarted = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as HostMessage | undefined;
    const info = msg?.info;
    const parts = (Array.isArray(msg?.parts) ? msg.parts : []) as HostPart[];
    const isCompaction = info?.role === "compaction"
      || (info?.role === "user" && parts.some((part) => part?.type === "compaction"));
    if (isCompaction) {
      turnStarted = true;
      continue;
    }
    if (info?.role === "user" || info?.role === "synthetic") {
      const injected = isInjectedPrompt(info.role, parts);
      if (!injected && typeof info.id === "string") personPrompts.add(info.id);
      const staysInTurn = injected && turnRunning && !turnInjected
        && (turnStarted || isPlanReminder(parts));
      if (!staysInTurn) {
        turnInjected = injected;
        turnStarted = false;
      }
      turnRunning = true;
      continue;
    }
    if (info?.role !== "assistant") continue;
    turnStarted = true;
    const summary = info.summary === true;
    if (!summary && (info.error !== undefined || (!callsHostTool(parts) && info.finish !== "length"))) {
      turnRunning = false;
    }

    const textParts = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
      .map((part) => part.text as string);
    if (textParts.length === 0) continue;
    const agent = readMessageAgent(info);
    const created = typeof info.time?.created === "number" ? info.time.created : undefined;
    const parentIsPerson = typeof info.parentID === "string" && personPrompts.has(info.parentID);
    replies.push({
      message: {
        messageId: typeof info.id === "string" ? info.id : `opencode-${i}`,
        text: textParts.join("\n"),
        timestamp: created ? new Date(created).toISOString() : undefined,
        ...(agent && { agent }),
      },
      injected: summary || (!parentIsPerson && turnInjected),
    });
  }

  replies.reverse();
  const opens = replies.find((reply) => !reply.injected) ?? replies[0];
  if (!opens) return [];
  return [opens, ...replies.filter((reply) => reply !== opens)]
    .slice(0, Math.max(0, limit))
    .map((reply) => reply.message);
}
