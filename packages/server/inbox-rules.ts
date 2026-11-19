import { INBOX_NOTE_AGENT_IDS, INBOX_PROMPT_HOSTS, type InboxNoteAgentId, type InboxPromptHost, type InboxPromptsChange, type InboxPromptsSettings, type InboxRulesUnsent } from "@plannotator/core/inbox-types";
import type { InboxNoteRulesState } from "./inbox-agent-notes";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import {
  inboxReminderCustomText,
  inboxReminderFor,
  inboxReminderRulesText,
  inboxReminderWithRules,
  inboxRulesRoom,
} from "@plannotator/shared/inbox/connection";
import { INBOX_MCP_RULES_ROOMS, INBOX_MCP_TIERS, inboxMcpSent, resolveInboxMcpReminder } from "./inbox-mcp-instructions";

const LONGEST_TOOL_NAME = "mcp__plannotator__plannotator_inbox";

type Wakes = Record<InboxPromptHost, boolean>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function reminderOf(config: PlannotatorConfig, host: InboxPromptHost, wakes: Wakes): string {
  return inboxReminderFor(inboxReminderCustomText(config, host), LONGEST_TOOL_NAME, { wakes: wakes[host] });
}

function slots(config: PlannotatorConfig): { shared: string | null; runtimes: Record<InboxPromptHost, string | null> } {
  const inbox = record(record(config.prompts)?.inbox);
  return {
    shared: text(inbox?.rules),
    runtimes: Object.fromEntries(INBOX_PROMPT_HOSTS.map((host) => [host, text(record(record(inbox?.runtimes)?.[host])?.rules)])) as Record<InboxPromptHost, string | null>,
  };
}

/**
 * How the rules reach each agent (inbox.ts): whose note holds them now (noteRulesStates), whose
 * reminder is on, and who is connected through MCP. Without it (a caller that has neither) the model is the reminder's alone.
 */
export interface InboxRulesDelivery {
  notes: Partial<Record<InboxNoteAgentId, InboxNoteRulesState>>;
  on: Record<InboxPromptHost, boolean>;
  /** The note agents connected to the Inbox through MCP (inbox/agents.json): the MCP instructions carry them the shared rules. */
  mcp?: Partial<Record<InboxNoteAgentId, boolean>>;
}

export function inboxRulesModel(config: PlannotatorConfig, wakes: Wakes, delivery?: InboxRulesDelivery): NonNullable<InboxPromptsSettings["rules"]> {
  const { shared, runtimes } = slots(config);
  const room = Object.fromEntries(INBOX_PROMPT_HOSTS.map((host) => [host, inboxRulesRoom(reminderOf(config, host, wakes))])) as Record<InboxPromptHost, number>;
  const reached = INBOX_PROMPT_HOSTS.filter((host) => runtimes[host] === null);
  const sharedRoom = Math.min(...(reached.length > 0 ? reached : INBOX_PROMPT_HOSTS).map((host) => room[host]));
  // An agent whose note holds its rules gets them there: its reminder leaves them out, so their length is no matter.
  const dropped = INBOX_PROMPT_HOSTS.filter((host) => {
    const rules = inboxReminderRulesText(config, host);
    if (rules === null || delivery?.notes[host] === "held") return false;
    const reminder = reminderOf(config, host, wakes);
    return inboxReminderWithRules(reminder, rules, LONGEST_TOOL_NAME) === reminder;
  });
  // Agents over MCP: the shared text only, in the server instructions' smaller room (inbox-mcp-instructions.ts).
  const mcpText = resolveInboxMcpReminder(config);
  const sent = INBOX_MCP_TIERS.map((tier) => [tier, inboxMcpSent(mcpText, tier)] as const);
  const mcp = {
    room: INBOX_MCP_RULES_ROOMS.claude_code,
    rooms: { ...INBOX_MCP_RULES_ROOMS },
    dropped: mcpText?.rules != null ? sent.filter(([, fit]) => !fit.rules).map(([tier]) => tier) : [],
    reminder_dropped: mcpText?.custom != null ? sent.filter(([, fit]) => !fit.reminder).map(([tier]) => tier) : [],
  };
  if (!delivery) return { shared, runtimes, room: { shared: sharedRoom, runtimes: room }, dropped, mcp };
  // The note agents other than Claude Code, Pi and OpenCode are MCP clients of the `other` room (Codex, Gemini CLI,
  // Qwen Code): connected through MCP, they read the shared rules in the server instructions whenever they fit there.
  const mcpCarries = mcpText?.rules != null && inboxMcpSent(mcpText, "other").rules;
  const unsent: InboxRulesUnsent[] = [];
  for (const agent of INBOX_NOTE_AGENT_IDS) {
    const state = delivery.notes[agent];
    if (state === undefined || state === "held") continue;
    const host = (INBOX_PROMPT_HOSTS as readonly string[]).includes(agent) ? (agent as InboxPromptHost) : null;
    // Claude Code, Pi and OpenCode get them by the reminder while it is on.
    if (host && delivery.on[host]) continue;
    if (!host && mcpCarries && delivery.mcp?.[agent]) continue;
    unsent.push({ agent, slot: host && runtimes[host] !== null ? host : "shared", why: state.why, fix: state.fix });
  }
  return { shared, runtimes, room: { shared: sharedRoom, runtimes: room }, dropped, mcp, unsent };
}

export function inboxRulesFitError(change: InboxPromptsChange, config: PlannotatorConfig, wakes: Wakes): { field: string; message: string } | null {
  const rules = inboxRulesModel(config, wakes);
  const check = (value: string | null | undefined, max: number, field: string) =>
    typeof value === "string" && value.trim().length > max
      ? { field, message: `${field}: at most ${max.toLocaleString("en-US")} characters with the reminder it follows (this one has ${value.trim().length.toLocaleString("en-US")}).` }
      : null;
  const shared = check(change.inbox?.rules, rules.room.shared, "prompts.inbox.rules");
  if (shared) return shared;
  for (const host of INBOX_PROMPT_HOSTS) {
    const own = check(change.inbox?.runtimes?.[host]?.rules, rules.room.runtimes[host], `prompts.inbox.runtimes.${host}.rules`);
    if (own) return own;
  }
  return null;
}
