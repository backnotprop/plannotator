import { INBOX_PROMPT_HOSTS, type InboxPromptHost, type InboxPromptsChange, type InboxPromptsSettings } from "@plannotator/core/inbox-types";
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

export function inboxRulesModel(config: PlannotatorConfig, wakes: Wakes): NonNullable<InboxPromptsSettings["rules"]> {
  const { shared, runtimes } = slots(config);
  const room = Object.fromEntries(INBOX_PROMPT_HOSTS.map((host) => [host, inboxRulesRoom(reminderOf(config, host, wakes))])) as Record<InboxPromptHost, number>;
  const reached = INBOX_PROMPT_HOSTS.filter((host) => runtimes[host] === null);
  const sharedRoom = Math.min(...(reached.length > 0 ? reached : INBOX_PROMPT_HOSTS).map((host) => room[host]));
  const dropped = INBOX_PROMPT_HOSTS.filter((host) => {
    const rules = inboxReminderRulesText(config, host);
    if (rules === null) return false;
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
  return { shared, runtimes, room: { shared: sharedRoom, runtimes: room }, dropped, mcp };
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
