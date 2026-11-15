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
 * A reply belongs to the prompt of its turn. OpenCode 1 names that prompt
 * (`parentID`). OpenCode 2 does not, so the turn is read from the order: a
 * prompt row starts a turn, and an assistant step that called no tool (or
 * failed) ends it, since a step that called a tool is always followed by
 * another. An injected row that lands while the person's own turn is still
 * running does not start a turn of its own: Plannotator's session-URL notice
 * (posted while its tool call is open) and OpenCode 2's Plan-mode reminder
 * (re-added after a compaction) are stored after the person's prompt.
 */

import { readMessageAgent } from "./message-agent";

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

type HostPart = { type?: unknown; text?: unknown; synthetic?: unknown };
type HostMessage = {
  info?: {
    id?: unknown;
    role?: unknown;
    parentID?: unknown;
    error?: unknown;
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
  const injectedPrompts = new Map<string, boolean>();
  let turnRunning = false;
  let turnInjected = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as HostMessage | undefined;
    const info = msg?.info;
    const parts = (Array.isArray(msg?.parts) ? msg.parts : []) as HostPart[];
    if (info?.role === "user" || info?.role === "synthetic") {
      const injected = isInjectedPrompt(info.role, parts);
      if (typeof info.id === "string") injectedPrompts.set(info.id, injected);
      // An injected row inside the person's running turn stays part of it.
      if (!(injected && turnRunning && !turnInjected)) turnInjected = injected;
      turnRunning = true;
      continue;
    }
    if (info?.role !== "assistant") continue;
    if (info.error !== undefined || !parts.some((part) => part?.type === "tool")) turnRunning = false;

    const textParts = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
      .map((part) => part.text as string);
    if (textParts.length === 0) continue;
    const agent = readMessageAgent(info);
    const created = typeof info.time?.created === "number" ? info.time.created : undefined;
    const parentInjected = typeof info.parentID === "string" ? injectedPrompts.get(info.parentID) : undefined;
    replies.push({
      message: {
        messageId: typeof info.id === "string" ? info.id : `opencode-${i}`,
        text: textParts.join("\n"),
        timestamp: created ? new Date(created).toISOString() : undefined,
        ...(agent && { agent }),
      },
      injected: parentInjected ?? turnInjected,
    });
  }

  replies.reverse();
  const opens = replies.find((reply) => !reply.injected) ?? replies[0];
  if (!opens) return [];
  return [opens, ...replies.filter((reply) => reply !== opens)]
    .slice(0, Math.max(0, limit))
    .map((reply) => reply.message);
}
