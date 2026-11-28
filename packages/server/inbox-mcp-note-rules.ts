/**
 * The person's rules once for an agent connected through MCP (#3598). The
 * Inbox writes them into the note in Codex's and Gemini CLI's instructions
 * file, and the MCP instructions (#3567) carry them too: an agent whose note
 * holds them would read them twice. So, for one `initialize` on this
 * computer's `/mcp`, the instructions leave the rules out only when all of
 * these hold: the client names itself as an agent whose note the Inbox writes
 * (`clientInfo.name`, exact: inboxMcpNoteAgentOf); the Inbox is turned on here
 * (turned-on.ts, the note's own gate); and that agent's file holds the note
 * with exactly the rules the instructions would carry (inboxNoteHoldsAgentRules,
 * the check Claude Code's, Pi's and OpenCode's reminders make). Anything else,
 * or anything that throws, sends them as before: twice is better than never.
 * The person's reminder is never left out.
 */
import { INBOX_CODEX_MCP_CLIENT, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { isInboxTurnedOn } from "@plannotator/shared/inbox/turned-on";
import { inboxNoteHoldsAgentRules } from "./inbox-agent-notes";
import type { AgentEnvironment } from "./inbox-agents";
import { resolveInboxMcpReminder, type InboxMcpClient, type InboxMcpReminder } from "./inbox-mcp-instructions";

/** Gemini CLI's MCP client name (`initialize`'s `clientInfo.name`; its own `new Client({ name })`, read in Gemini CLI 0.43.0). */
export const INBOX_GEMINI_MCP_CLIENT = "gemini-cli-mcp-client";

/**
 * The agent whose note a client reads, by its exact `clientInfo.name`, or
 * null. Only agents whose note is written by itself and proven to be loaded
 * (INBOX_NOTE_AUTO_AGENT_IDS) and that connect through MCP: Codex and Gemini
 * CLI. Not Qwen Code (its note is not proven to be loaded), Cursor (its copy
 * is by hand, unseen), Claude Code (`claude-code` is also T3 Code's Claude
 * through the Agent SDK, which is not proven to load the note), nor any name
 * not known here.
 */
export function inboxMcpNoteAgentOf(client: InboxMcpClient): InboxNoteAgentId | null {
  const name = client && typeof client === "object" ? client.name : undefined;
  if (name === INBOX_CODEX_MCP_CLIENT) return "codex";
  if (name === INBOX_GEMINI_MCP_CLIENT) return "gemini";
  return null;
}

/** This computer's Inbox, for a connection to its own `/mcp`: its data dir and the agents' environment it writes the notes with. */
export interface InboxMcpHere {
  dataDir: string;
  environment: () => AgentEnvironment;
}

/**
 * The person's text for one `initialize`, as resolveInboxMcpReminder reads it,
 * less the rules when the client's agent has them in its note here. `here`:
 * only the Inbox's own `/mcp` route passes it (inbox.ts, a connection from
 * this computer); without it (a cloud agent's door, a send from a linked
 * computer) nothing can be told, and the rules stay.
 */
export function inboxMcpReminderFor(config: unknown, client: InboxMcpClient, here?: InboxMcpHere): InboxMcpReminder | null {
  const reminder = resolveInboxMcpReminder(config);
  if (!here || reminder?.rules == null) return reminder;
  const agent = inboxMcpNoteAgentOf(client);
  if (agent === null) return reminder;
  try {
    // The note compared with the very rules these instructions would carry.
    if (!isInboxTurnedOn(here.dataDir) || !inboxNoteHoldsAgentRules(agent, here.environment(), { prompts: { inbox: { rules: reminder.rules } } })) return reminder;
  } catch {
    return reminder;
  }
  return reminder.custom === null ? null : { custom: reminder.custom, rules: null };
}
