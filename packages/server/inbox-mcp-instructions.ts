/**
 * The Inbox MCP server's instructions (`initialize`), and the person's own
 * Inbox rules and reminder in them (#3555). Pure, so Settings → Prompts
 * (inbox-rules.ts) reads the same room and the same fit as the server.
 */
import { INBOX_AGENT_RULES, inboxReminderCustomText, inboxReminderRulesText, INBOX_RULES_LEAD } from "@plannotator/shared/inbox/connection";

/**
 * Under Claude Code's 2,048-character cap on server instructions. Room for
 * INBOX_THREAD_RULE (in INBOX_AGENT_RULES) came from the attachments line's
 * examples, which the field's own description gives. Room for the pictures
 * clause of INBOX_USE_RULE and the attachments line's "pictures go in the
 * body" (2026-11-02) came from the first line's "without blocking your
 * session" and the result line's "with your work".
 */
const INBOX_MCP_INSTRUCTIONS_INTRO =
  "Plannotator Inbox: a local window where the person reads what you send and answers later; nothing blocks.";

/**
 * The two summary lines only these instructions carry ("an id from the
 * Inbox, never from memory"; "pictures go in the body"): always sent, the
 * person's own rules or not.
 */
const INBOX_MCP_INSTRUCTIONS_OWN_LINES = [
  "- send_message posts markdown. With no reply_to or thread, a message starts a new thread; to add to a thread, reply_to its latest message (an id from the Inbox, never from memory) or use the same `thread` name. Question syntax: send_message's description.",
  "- attachments: files to open beside the thread (link one: `[the mock](mock.html)`); pictures go in the body, `![alt](path)`.",
];

/**
 * The three summary lines the tools say in full themselves (send_message's
 * result, read_thread's, search's and resolve_message's descriptions,
 * get_guide_brief's and submit_guide's): they make the room for the person's
 * own rules and reminder, and are sent whenever none of that text is.
 */
const INBOX_MCP_INSTRUCTIONS_REPEATED_LINES = [
  "- send_message's result says whether the reply arrives in this session by itself. When it does not, go on and read the thread later.",
  "- read_thread reads one thread (thread_id); without an id it lists yours (asked_by \"anyone\": all), and `unread` marks a thread the person wrote in. search finds older messages by words. resolve_message archives the thread, only when nothing in it is left for the person to read or answer.",
  "- A guided review of a code change: get_guide_brief, write the guide, then submit_guide with the exact patch.",
];

const INBOX_MCP_INSTRUCTIONS_ATTRIBUTION =
  "A reply is the person's own: their words, then \"Answers to your questions\"; no tool answers or approves for them.";

export const INBOX_MCP_INSTRUCTIONS = [
  INBOX_MCP_INSTRUCTIONS_INTRO,
  "",
  INBOX_AGENT_RULES,
  "",
  ...INBOX_MCP_INSTRUCTIONS_OWN_LINES,
  ...INBOX_MCP_INSTRUCTIONS_REPEATED_LINES,
  "",
  INBOX_MCP_INSTRUCTIONS_ATTRIBUTION,
].join("\n");

/** Claude Code's cap on server instructions: the built instructions stay under it, never at it. */
export const INBOX_MCP_INSTRUCTIONS_MAX_CHARS = 2048;

/** The person's own Inbox rules and reminder for an MCP session, or null when neither is configured. */
export interface InboxMcpReminder {
  custom: string | null;
  rules: string | null;
}

/**
 * The person's own Inbox rules and reminder for an MCP session, from
 * config.json: the shared ones only (`prompts.inbox.rules`,
 * `prompts.inbox.reminder`, Settings → Prompts' "All agents"). The
 * instructions go out at `initialize`, before a session says which agent it
 * is (`agent_host` rides on tool calls), and the agents that connect this way
 * (T3 Code, Codex, Gemini, Cursor, any MCP client) have no slot of their own;
 * a T3 Code thread that runs Claude is a T3 thread, not Claude Code. So the
 * Claude Code, Pi and OpenCode rules never govern an MCP session. Null when
 * neither is set: the built-in instructions then stand unchanged. The text is
 * the person's own, trimmed and otherwise verbatim: the terminal path renames
 * `plannotator_inbox` in it to the host's tool name, but an MCP session has
 * no single tool name to rename to.
 */
export function resolveInboxMcpReminder(config: unknown): InboxMcpReminder | null {
  const inbox = (config as { prompts?: { inbox?: { reminder?: unknown; rules?: unknown } } } | null)?.prompts?.inbox;
  const shared = inbox && typeof inbox === "object" && !Array.isArray(inbox) ? { prompts: { inbox: { reminder: inbox.reminder, rules: inbox.rules } } } : null;
  const custom = inboxReminderCustomText(shared, "mcp")?.trim() ?? null;
  const rules = inboxReminderRulesText(shared, "mcp");
  return custom === null && rules === null ? null : { custom, rules };
}

/** The instructions with the person's text in place of the repeated lines (the text alone, without its separators). */
function withPersonText(block: string): string {
  return [
    INBOX_MCP_INSTRUCTIONS_INTRO,
    "",
    INBOX_AGENT_RULES,
    "",
    ...INBOX_MCP_INSTRUCTIONS_OWN_LINES,
    "",
    block,
    "",
    INBOX_MCP_INSTRUCTIONS_ATTRIBUTION,
  ].join("\n");
}

/** The most characters the person's text (reminder, rules and the rules' lead) may take, the result staying under the cap. */
const INBOX_MCP_PERSON_ROOM = INBOX_MCP_INSTRUCTIONS_MAX_CHARS - 1 - withPersonText("").length;

const rulesBlock = (rules: string) => `${INBOX_RULES_LEAD}\n${rules}`;

/**
 * The most characters the person's rules may hold and still reach an MCP
 * session (Settings → Prompts shows it). Much less than the terminal path's
 * room (`inboxRulesRoom`): Claude Code cuts server instructions at 2,048
 * characters and the built-in ones take most of them.
 */
export const INBOX_MCP_RULES_ROOM = Math.max(0, INBOX_MCP_PERSON_ROOM - INBOX_RULES_LEAD.length - 1);

/** What of the person's text an MCP session gets: each is sent whole or left out whole, never cut. */
export interface InboxMcpSent {
  rules: boolean;
  reminder: boolean;
}

/**
 * Which of the person's texts fit: the rules first (they are what the person
 * wrote for agents, and the lead says they win), then the reminder in the
 * room the rules leave. A text that does not fit is left out whole, as on the
 * terminal path; Settings → Prompts says so.
 */
export function inboxMcpSent(reminder: InboxMcpReminder | null): InboxMcpSent {
  const rules = reminder?.rules != null && reminder.rules.length <= INBOX_MCP_RULES_ROOM;
  const left = INBOX_MCP_PERSON_ROOM - (rules ? rulesBlock(reminder!.rules!).length + 2 : 0);
  const custom = reminder?.custom != null && reminder.custom.length <= left;
  return { rules, reminder: custom };
}

/**
 * The server instructions for a session. With nothing of the person's that
 * fits, exactly INBOX_MCP_INSTRUCTIONS. Otherwise the same text with the
 * person's reminder, then INBOX_RULES_LEAD and their rules (the terminal
 * path's order), in place of the three summary lines the tools repeat; every
 * other line stays, word for word, the attribution after the person's text.
 * Nothing is ever cut, and the result is always under the 2,048 cap.
 */
export function inboxMcpInstructions(reminder: InboxMcpReminder | null): string {
  const sent = inboxMcpSent(reminder);
  const parts = [...(sent.reminder ? [reminder!.custom!] : []), ...(sent.rules ? [rulesBlock(reminder!.rules!)] : [])];
  return parts.length === 0 ? INBOX_MCP_INSTRUCTIONS : withPersonText(parts.join("\n\n"));
}
