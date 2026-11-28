/**
 * The Inbox MCP server's instructions (`initialize`), and the person's own
 * Inbox rules and reminder in them (#3555), sized to what the connecting
 * client keeps (its `initialize` `clientInfo`). Pure, so Settings → Prompts
 * (inbox-rules.ts) reads the same rooms and the same fit as the server.
 */
import type { InboxMcpTier } from "@plannotator/core/inbox-types";
import { configuredInboxReminder, INBOX_REMINDER_HOSTS, type PlannotatorConfig } from "@plannotator/shared/config";
import { INBOX_AGENT_RULES, INBOX_REMINDER_MAX_CHARS, inboxReminderCustomText, inboxReminderRulesText, INBOX_RULES_LEAD } from "@plannotator/shared/inbox/connection";

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

/** Claude Code's cap on server instructions before 2.1.296: the built-in instructions alone stay under it, never at it, so every client reads them whole. */
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
 *
 * The reminder switch (`inboxReminder`, Settings → Agents) governs it as it
 * governs the terminal path, where the rules ride on the reminder: switched
 * off, nothing of the person's is sent and the instructions are the built-in
 * ones. A boolean switches every host, MCP included; the per-host form
 * (what Settings → Agents writes) has no MCP entry, so MCP goes off when
 * the reminder is off for every host that has one (`INBOX_REMINDER_HOSTS`).
 */
export function resolveInboxMcpReminder(config: unknown): InboxMcpReminder | null {
  if (!inboxMcpReminderOn(config)) return null;
  const inbox = (config as { prompts?: { inbox?: { reminder?: unknown; rules?: unknown } } } | null)?.prompts?.inbox;
  const shared = inbox && typeof inbox === "object" && !Array.isArray(inbox) ? { prompts: { inbox: { reminder: inbox.reminder, rules: inbox.rules } } } : null;
  const custom = inboxReminderCustomText(shared, "mcp")?.trim() ?? null;
  const rules = inboxReminderRulesText(shared, "mcp");
  return custom === null && rules === null ? null : { custom, rules };
}

/** Whether the reminder switch lets the person's text reach MCP sessions: on unless it is off for every reminder host. */
export function inboxMcpReminderOn(config: unknown): boolean {
  const record = config && typeof config === "object" && !Array.isArray(config) ? (config as PlannotatorConfig) : {};
  return INBOX_REMINDER_HOSTS.some((host) => configuredInboxReminder(record, host) !== false);
}

/**
 * How much a client keeps of the server instructions, from its `initialize`
 * `clientInfo`:
 * - `claude_code`: Claude Code 2.1.296 or later, which keeps 4,096 characters
 *   (code.claude.com/docs/en/mcp: "Server instructions, and the description
 *   of a tool that loads upfront: 4,096 characters"). T3 Code's Claude
 *   threads are this: T3 runs Claude through the Agent SDK, which starts the
 *   person's own Claude Code, and Claude Code names itself `claude-code` with
 *   its version.
 * - `claude_code_old`: Claude Code before 2.1.296 ("Before v2.1.296, the
 *   shorter limit was 2,048 characters"), any other client whose name
 *   contains "claude" (Claude Desktop, Claude apps whose names we do not
 *   know, Claude Code without a readable version), and any client that does
 *   not say who it is: the cap that was true for every Claude Code.
 * - `other`: every other client that names itself (Codex's
 *   `codex-mcp-client`, Cursor, Gemini, Qwen …). None documents a cut that we
 *   know of (Codex's MCP doc: "Keep the first 512 characters
 *   self-contained", no maximum), so they get the terminal path's cap on
 *   the person's text (INBOX_REMINDER_MAX_CHARS).
 */
export type { InboxMcpTier };

/** The tiers, tightest room first. */
export const INBOX_MCP_TIERS: readonly InboxMcpTier[] = ["claude_code_old", "claude_code", "other"];

/** An `initialize` request's `clientInfo`, as it arrived (anything else reads as unknown). */
export type InboxMcpClient = { name?: unknown; version?: unknown } | null | undefined;

/**
 * A POST body that is an `initialize` request: its `clientInfo` (null when it
 * has none), so the Inbox builds that connection's server for the client.
 * Anything else (a tool call, a batch, nothing): undefined.
 */
export function inboxMcpInitializeClient(body: unknown): InboxMcpClient | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body) || (body as { method?: unknown }).method !== "initialize") return undefined;
  const info = (body as { params?: { clientInfo?: unknown } }).params?.clientInfo;
  return info && typeof info === "object" && !Array.isArray(info) ? (info as InboxMcpClient) : null;
}

/** The first Claude Code version that keeps 4,096 characters. */
const CLAUDE_CODE_4096 = [2, 1, 296] as const;

/**
 * The tier, forgiving on the safe side: the name is trimmed and compared
 * without case; any name with "claude" in it is the Claude family, and only
 * Claude Code itself (`claude-code`, also written with a space or an
 * underscore) with a readable version of 2.1.296 or later gets 4,096.
 */
export function inboxMcpTierOf(client: InboxMcpClient): InboxMcpTier {
  const raw = client && typeof client === "object" ? client.name : undefined;
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (name === "") return "claude_code_old";
  if (!name.includes("claude")) return "other";
  if (name.replace(/[\s_-]+/g, "-") !== "claude-code") return "claude_code_old";
  const version = typeof client!.version === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(client!.version.trim()) : null;
  if (!version) return "claude_code_old";
  const parts = version.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== CLAUDE_CODE_4096[i]) return parts[i]! > CLAUDE_CODE_4096[i] ? "claude_code" : "claude_code_old";
  }
  return "claude_code";
}

/**
 * The built-in summary lines a tier keeps beside the person's text: all five
 * wherever the room allows (4,096 and more); under 2,048 only the two no tool
 * repeats, or the rules would get no room at all.
 */
const linesFor = (tier: InboxMcpTier): readonly string[] =>
  tier === "claude_code_old" ? INBOX_MCP_INSTRUCTIONS_OWN_LINES : [...INBOX_MCP_INSTRUCTIONS_OWN_LINES, ...INBOX_MCP_INSTRUCTIONS_REPEATED_LINES];

/** The instructions with the person's text after the tier's summary lines (the text alone, without its separators). */
function withPersonText(block: string, tier: InboxMcpTier): string {
  return [INBOX_MCP_INSTRUCTIONS_INTRO, "", INBOX_AGENT_RULES, "", ...linesFor(tier), "", block, "", INBOX_MCP_INSTRUCTIONS_ATTRIBUTION].join("\n");
}

const rulesBlock = (rules: string) => `${INBOX_RULES_LEAD}\n${rules}`;

/** The most characters the person's text (reminder, rules and the rules' lead) may take in a tier, the result staying under its cap. */
const PERSON_ROOM: Record<InboxMcpTier, number> = {
  claude_code_old: 2048 - 1 - withPersonText("", "claude_code_old").length,
  claude_code: 4096 - 1 - withPersonText("", "claude_code").length,
  // No known cut: the terminal path's own cap on the person's text, so whatever Settings lets the person save fits whole.
  other: INBOX_REMINDER_MAX_CHARS,
};

/**
 * The most characters the person's rules may hold and still reach an MCP
 * session of each tier (Settings → Prompts shows them). Computed from the
 * built-in text, so a longer built-in line shrinks them here, not in prose.
 */
export const INBOX_MCP_RULES_ROOMS: Readonly<Record<InboxMcpTier, number>> = {
  claude_code_old: Math.max(0, PERSON_ROOM.claude_code_old - INBOX_RULES_LEAD.length - 1),
  claude_code: Math.max(0, PERSON_ROOM.claude_code - INBOX_RULES_LEAD.length - 1),
  other: Math.max(0, PERSON_ROOM.other - INBOX_RULES_LEAD.length - 1),
};

/** What of the person's text an MCP session gets: each is sent whole or left out whole, never cut. */
export interface InboxMcpSent {
  rules: boolean;
  reminder: boolean;
}

/**
 * Which of the person's texts fit a tier: the rules first (they are what the
 * person wrote for agents, and the lead says they win), then the reminder in
 * the room the rules leave. A text that does not fit is left out whole, as on
 * the terminal path; Settings → Prompts says so.
 */
export function inboxMcpSent(reminder: InboxMcpReminder | null, tier: InboxMcpTier = "claude_code_old"): InboxMcpSent {
  const rules = reminder?.rules != null && reminder.rules.length <= INBOX_MCP_RULES_ROOMS[tier];
  const left = PERSON_ROOM[tier] - (rules ? rulesBlock(reminder!.rules!).length + 2 : 0);
  const custom = reminder?.custom != null && reminder.custom.length <= left;
  return { rules, reminder: custom };
}

/**
 * The server instructions for a session of a tier. With nothing of the
 * person's that fits, exactly INBOX_MCP_INSTRUCTIONS. Otherwise the person's
 * reminder, then INBOX_RULES_LEAD and their rules (the terminal path's order),
 * after the summary lines and before the attribution: all five lines where the
 * cap is 4,096 or more, only the two no tool repeats under 2,048. No fixed
 * line is new or reworded, nothing is ever cut, and the result stays under the
 * tier's cap.
 */
export function inboxMcpInstructions(reminder: InboxMcpReminder | null, tier: InboxMcpTier = "claude_code_old"): string {
  const sent = inboxMcpSent(reminder, tier);
  const parts = [...(sent.reminder ? [reminder!.custom!] : []), ...(sent.rules ? [rulesBlock(reminder!.rules!)] : [])];
  return parts.length === 0 ? INBOX_MCP_INSTRUCTIONS : withPersonText(parts.join("\n\n"), tier);
}
