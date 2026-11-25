/**
 * The Inbox note in agents' instructions files while the person uses the Inbox for code review only
 * (inbox-review-only.ts): out while code review only, back with the full Inbox. Only the note's own marked section is
 * ever touched (removeInboxNote, addInboxNote: the same as Settings → Agents' switch). A section the person edited is
 * theirs: left as it is, and not put back either.
 */
import { INBOX_NOTE_AGENT_IDS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { addInboxNote, noteHolderIds, noteStatus, removeInboxNote } from "./inbox-agent-notes";
import { agentSpec, type AgentEnvironment } from "./inbox-agents";

/** Takes the note out of every agent's file that has it as Plannotator wrote it; returns those agents. */
export function hideInboxNotesForReviewOnly(dataDir: string, e: AgentEnvironment): InboxNoteAgentId[] {
  const out: InboxNoteAgentId[] = [];
  for (const agent of noteHolderIds({ dataDir, environment: e })) {
    if (agent === "cursor" || noteStatus(agent, dataDir, e).state === "edited") continue;
    const change = removeInboxNote(agent, dataDir, e);
    if (change.ok && change.action !== "unchanged") out.push(agent);
  }
  return out;
}

/** Puts the note back for the agents code review only took it from (each one still on this computer). */
export function restoreInboxNotesAfterReviewOnly(agents: readonly string[], dataDir: string, e: AgentEnvironment): void {
  for (const id of agents) {
    if (!(INBOX_NOTE_AGENT_IDS as readonly string[]).includes(id) || id === "cursor") continue;
    const agent = id as InboxNoteAgentId;
    if (agentSpec(agent).detect(e)) addInboxNote(agent, dataDir, e);
  }
}
