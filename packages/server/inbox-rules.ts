/**
 * "Rules for your agents" (Settings → Prompts; #2194): the person's own rules,
 * ADDED after the Inbox reminder at session start (connection.ts
 * `inboxReminderWithRules`). config.json `prompts.inbox.rules` for every agent,
 * `prompts.inbox.runtimes.<agent>.rules` for one (it wins). This file reads
 * what the page shows (`inboxRulesModel`) and checks a save fits
 * (`inboxRulesFitError`); inbox-prompts.ts parses and writes.
 */

import { INBOX_PROMPT_HOSTS, type InboxPromptHost, type InboxPromptsChange, type InboxPromptsSettings } from "@plannotator/core/inbox-types";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import {
  inboxReminderCustomText,
  inboxReminderFor,
  inboxReminderRulesText,
  inboxReminderWithRules,
  inboxRulesRoom,
} from "@plannotator/shared/inbox/connection";

/** The longest name a host gives the tool (Claude Code's deferred plugin tool): the room is measured with it. */
const LONGEST_TOOL_NAME = "mcp__plannotator__plannotator_inbox";

type Wakes = Record<InboxPromptHost, boolean>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The reminder an agent gets before any rules: its own or the shared text, else its default. */
function reminderOf(config: PlannotatorConfig, host: InboxPromptHost, wakes: Wakes): string {
  return inboxReminderFor(inboxReminderCustomText(config, host), LONGEST_TOOL_NAME, { wakes: wakes[host] });
}

/** The rules in config.json, per slot, as the hosts read them. */
function slots(config: PlannotatorConfig): { shared: string | null; runtimes: Record<InboxPromptHost, string | null> } {
  const inbox = record(record(config.prompts)?.inbox);
  return {
    shared: text(inbox?.rules),
    runtimes: Object.fromEntries(INBOX_PROMPT_HOSTS.map((host) => [host, text(record(record(inbox?.runtimes)?.[host])?.rules)])) as Record<InboxPromptHost, string | null>,
  };
}

/** What Settings → Prompts shows of the rules. */
export function inboxRulesModel(config: PlannotatorConfig, wakes: Wakes): NonNullable<InboxPromptsSettings["rules"]> {
  const { shared, runtimes } = slots(config);
  const room = Object.fromEntries(INBOX_PROMPT_HOSTS.map((host) => [host, inboxRulesRoom(reminderOf(config, host, wakes))])) as Record<InboxPromptHost, number>;
  // The shared rules reach every agent without its own: the tightest of those (all of them when every agent has its own).
  const reached = INBOX_PROMPT_HOSTS.filter((host) => runtimes[host] === null);
  const sharedRoom = Math.min(...(reached.length > 0 ? reached : INBOX_PROMPT_HOSTS).map((host) => room[host]));
  const dropped = INBOX_PROMPT_HOSTS.filter((host) => {
    const rules = inboxReminderRulesText(config, host);
    if (rules === null) return false;
    const reminder = reminderOf(config, host, wakes);
    return inboxReminderWithRules(reminder, rules, LONGEST_TOOL_NAME) === reminder;
  });
  return { shared, runtimes, room: { shared: sharedRoom, runtimes: room }, dropped };
}

/**
 * Null when the rules a change sets fit every agent they reach with the
 * reminder as config.json will hold it; else the refusal's words. Only rules
 * are checked: a longer reminder later shows as "not sent" on the page.
 */
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
