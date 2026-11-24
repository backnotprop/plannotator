/**
 * Swarm mode: every word an agent reads about it, in one place (the owner's to approve; PR "Swarm mode, slice 1").
 * The `swarm` action's line and field descriptions, its result, and the block a swarm's first message carries.
 */

import type { InboxSwarmMember } from "@plannotator/core/inbox-swarm";
import { inboxSwarmAlsoWords, inboxSwarmStateWords } from "@plannotator/core/inbox-swarm";

/** The agent tool's line for the action (INBOX_AGENT_ACTION_LEADS.swarm) and the MCP tool's description. */
export const INBOX_SWARM_ACTION_LINE = "See what each agent in a swarm thread is doing, and say what you are doing (doing).";

export const INBOX_SWARM_FIELD_DESCRIPTIONS = {
  thread_id: "The swarm thread (or any message in it).",
  doing: "One line on what you are doing now; every agent in the thread and the person see it. Leave it out to only look.",
} as const;

/** A hosted Inbox that refused the call for rate (HTTP 429): a plain result, never an error. */
export const INBOX_SWARM_BUSY_TEXT = "swarm_busy: Not saved just now: too many calls. Nothing is wrong; try again in a minute.";

/** What a swarm thread's first message carries after its words, for each agent it goes to. */
export function inboxSwarmStartBlock(threadId: string, others: readonly string[]): string {
  const with_ = others.length === 0 ? "to other agents" : `to you and to ${others.length === 1 ? others[0] : `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}`}`;
  return [
    "[Swarm]",
    `The person sent this ${with_} together, as a swarm: each of you sees what the others are doing. Say what you are doing in one line with your Inbox swarm action (thread_id ${threadId}, doing) when you start and when it changes; call it without doing to see the others.`,
    "[/Swarm]",
  ].join("\n");
}

const isoTime = (iso: string) => iso.replace(/\.\d+Z$/, "Z");

/** The `swarm` action's result: a first line, then one line per agent; `me` marks the caller. */
export function inboxSwarmResultText(input: { thread_id: string; on: boolean; members: readonly InboxSwarmMember[]; me: string | null; saved?: string | null; now?: Date }): string {
  const lines: string[] = [];
  if (input.saved) lines.push(`Saved. The others see: "${input.saved}".`);
  const n = input.members.length;
  lines.push(`Swarm in thread ${input.thread_id} (${input.on ? "on" : "off: the person turned it off"}), ${n} agent${n === 1 ? "" : "s"}:`);
  for (const m of input.members) {
    const state = inboxSwarmStateWords(m, isoTime, "waiting on the person");
    const parts = [`- ${m.name}${m.session === input.me ? " (you)" : ""}${m.where ? `, ${m.where}` : ""}: ${state || "connected"}.`];
    if (m.doing) parts.push(`Doing: ${m.doing.text}.`);
    if (m.file) parts.push(`File: ${m.file.path}${m.also.length > 0 ? ` (${inboxSwarmAlsoWords(m.also)})` : ""}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
