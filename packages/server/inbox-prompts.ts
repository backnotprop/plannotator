/**
 * Settings → Prompts (approval "inbox-prompts-page", #2194): the Inbox
 * reminder the person may replace (config.json `prompts.inbox`), and the plan,
 * review and annotate prompts shown read-only.
 *
 * The page reads config.json fresh and writes only `prompts.inbox`: one key
 * at a time, a string sets it, null deletes it, so every other key in the
 * file stays as it is. Whether a reminder is sent at all stays
 * `inboxReminder` (Settings → Agents).
 */

import { INBOX_PROMPT_HOSTS, type InboxPromptHost, type InboxPromptItem, type InboxPromptsChange, type InboxPromptsSettings } from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig, type PlannotatorConfig, type PromptConfig } from "@plannotator/shared/config";
import {
  INBOX_REMINDER_MAX_CHARS,
  INBOX_REMINDER_TEXT,
  INBOX_REMINDER_TEXT_NO_WAKE,
  inboxReminderCustomText,
} from "@plannotator/shared/inbox/connection";
import {
  DEFAULT_ANNOTATE_APPROVED_PROMPT,
  DEFAULT_ANNOTATE_APPROVED_WITH_NOTES_PROMPT,
  DEFAULT_ANNOTATE_FILE_FEEDBACK_PROMPT,
  DEFAULT_ANNOTATE_MESSAGE_FEEDBACK_PROMPT,
  DEFAULT_PLAN_ANSWERED_PROMPT,
  DEFAULT_PLAN_APPROVED_PROMPT,
  DEFAULT_PLAN_APPROVED_WITH_NOTES_PROMPT,
  DEFAULT_PLAN_AUTO_APPROVED_PROMPT,
  DEFAULT_PLAN_DENIED_PROMPT,
  DEFAULT_REVIEW_APPROVED_PROMPT,
  DEFAULT_REVIEW_APPROVED_WITH_NOTES_PROMPT,
  DEFAULT_REVIEW_DENIED_SUFFIX,
} from "@plannotator/shared/prompts";
import { InboxError } from "@plannotator/shared/inbox/schema";

type Group = InboxPromptItem["group"];

/** The 12 prompts of `prompts.plan`, `prompts.review` and `prompts.annotate`, in the order the page lists them. */
export const INBOX_OTHER_PROMPTS: readonly { group: Group; groupLabel: string; name: string; label: string; fallback: string; note?: string }[] = [
  { group: "plan", groupLabel: "Plan", name: "approved", label: "Approved", fallback: DEFAULT_PLAN_APPROVED_PROMPT, note: "OpenCode has a shorter default." },
  { group: "plan", groupLabel: "Plan", name: "approvedWithNotes", label: "Approved with notes", fallback: DEFAULT_PLAN_APPROVED_WITH_NOTES_PROMPT, note: "OpenCode has a shorter default." },
  { group: "plan", groupLabel: "Plan", name: "autoApproved", label: "Auto-approved", fallback: DEFAULT_PLAN_AUTO_APPROVED_PROMPT },
  { group: "plan", groupLabel: "Plan", name: "denied", label: "Not approved", fallback: DEFAULT_PLAN_DENIED_PROMPT },
  { group: "plan", groupLabel: "Plan", name: "answered", label: "Questions answered", fallback: DEFAULT_PLAN_ANSWERED_PROMPT },
  { group: "review", groupLabel: "Code review", name: "approved", label: "Approved", fallback: DEFAULT_REVIEW_APPROVED_PROMPT },
  { group: "review", groupLabel: "Code review", name: "approvedWithNotes", label: "Approved with notes", fallback: DEFAULT_REVIEW_APPROVED_WITH_NOTES_PROMPT },
  { group: "review", groupLabel: "Code review", name: "denied", label: "Changes requested", fallback: DEFAULT_REVIEW_DENIED_SUFFIX.replace(/^\n+/, ""), note: "Added after your feedback." },
  { group: "annotate", groupLabel: "Annotate", name: "fileFeedback", label: "Feedback on a file", fallback: DEFAULT_ANNOTATE_FILE_FEEDBACK_PROMPT },
  { group: "annotate", groupLabel: "Annotate", name: "messageFeedback", label: "Feedback on a message", fallback: DEFAULT_ANNOTATE_MESSAGE_FEEDBACK_PROMPT },
  { group: "annotate", groupLabel: "Annotate", name: "approved", label: "Approved", fallback: DEFAULT_ANNOTATE_APPROVED_PROMPT },
  { group: "annotate", groupLabel: "Annotate", name: "approvedWithNotes", label: "Approved with notes", fallback: DEFAULT_ANNOTATE_APPROVED_WITH_NOTES_PROMPT },
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function usablePrompt(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The reminder text set in config.json for the shared slot (`host` null) or one agent, as the hosts read it. */
function reminderSlot(config: PlannotatorConfig, host: InboxPromptHost | null): string | null {
  if (host === null) {
    // The shared text alone: read it as an agent with no own entry would.
    const inbox = record(record(config.prompts)?.inbox);
    return inboxReminderCustomText({ prompts: { inbox: { reminder: inbox?.reminder } } }, "-");
  }
  const own = record(record(record(record(config.prompts)?.inbox)?.runtimes)?.[host])?.reminder;
  return inboxReminderCustomText({ prompts: { inbox: { runtimes: { [host]: { reminder: own } } } } }, host);
}

/** The length of text config.json holds in a reminder slot that is over the cap (and so ignored), else null. */
function overCap(value: unknown): number | null {
  return typeof value === "string" && value.trim() !== "" && value.length > INBOX_REMINDER_MAX_CHARS ? value.length : null;
}

/**
 * What Settings → Prompts reads. `on`: whether each agent gets a reminder at
 * all; `editable`: this page may change it; `wakes`: false for an agent whose
 * reply does not come back by itself (OpenCode 1), whose default is the
 * no-wake line.
 */
export function inboxPromptsModel(
  config: PlannotatorConfig,
  on: Record<InboxPromptHost, boolean>,
  editable: boolean,
  wakes: Record<InboxPromptHost, boolean> = { "claude-code": true, pi: true, opencode: true },
): InboxPromptsSettings {
  const inbox = record(record(config.prompts)?.inbox);
  const prompts = record(config.prompts);
  const others: InboxPromptItem[] = INBOX_OTHER_PROMPTS.map((item) => {
    const section = record(prompts?.[item.group]);
    const shared = usablePrompt(section?.[item.name]);
    const runtimes = Object.entries(record(section?.runtimes) ?? {})
      .filter(([, entry]) => usablePrompt(record(entry)?.[item.name]) !== null)
      .map(([runtime]) => runtime)
      .sort();
    return {
      key: `prompts.${item.group}.${item.name}`,
      group: item.group,
      group_label: item.groupLabel,
      label: item.label,
      default: item.fallback,
      text: shared ?? item.fallback,
      custom: shared !== null || runtimes.length > 0,
      runtimes,
      note: item.note ?? null,
    };
  });
  return {
    reminder: {
      shared: reminderSlot(config, null),
      runtimes: Object.fromEntries(INBOX_PROMPT_HOSTS.map((host) => [host, reminderSlot(config, host)])) as Record<InboxPromptHost, string | null>,
      defaults: { wake: INBOX_REMINDER_TEXT, no_wake: INBOX_REMINDER_TEXT_NO_WAKE },
      max: INBOX_REMINDER_MAX_CHARS,
      on,
      editable,
      wakes,
      over: {
        shared: overCap(inbox?.reminder),
        runtimes: Object.fromEntries(
          INBOX_PROMPT_HOSTS.map((host) => [host, overCap(record(record(inbox?.runtimes)?.[host])?.reminder)]),
        ) as Record<InboxPromptHost, number | null>,
      },
    },
    others,
  };
}

/**
 * Check `{ inbox: { reminder?, runtimes?: { <agent>: { reminder? } } } }`:
 * each value a string or null, a blank string read as null, a string over
 * the cap refused (422). Nothing outside `prompts.inbox` is accepted.
 */
export function parseInboxPromptsChange(input: unknown): InboxPromptsChange {
  const fail = (message: string, field: string): never => {
    throw new InboxError("validation_error", message, { field });
  };
  const top = record(input);
  if (!top || Object.keys(top).some((key) => key !== "inbox")) fail("prompts: { inbox: { reminder?, runtimes? } }.", "prompts");
  const inbox = record(top!.inbox);
  if (!inbox || Object.keys(inbox).length === 0 || Object.keys(inbox).some((key) => key !== "reminder" && key !== "runtimes")) {
    fail("prompts.inbox: { reminder?, runtimes? }, at least one.", "prompts.inbox");
  }
  const text = (value: unknown, field: string): string | null => {
    if (value === null) return null;
    if (typeof value !== "string") return fail(`${field}: a string, or null to use the default.`, field);
    if (value.trim() === "") return null;
    if (value.length > INBOX_REMINDER_MAX_CHARS) {
      return fail(`${field}: at most ${INBOX_REMINDER_MAX_CHARS.toLocaleString("en-US")} characters (this one has ${value.length.toLocaleString("en-US")}).`, field);
    }
    return value;
  };
  const change: InboxPromptsChange = { inbox: {} };
  if ("reminder" in inbox!) change.inbox.reminder = text(inbox!.reminder, "prompts.inbox.reminder");
  if ("runtimes" in inbox!) {
    const runtimes = record(inbox!.runtimes);
    if (!runtimes || Object.keys(runtimes).length === 0) fail("prompts.inbox.runtimes: { <claude-code|pi|opencode>: { reminder } }.", "prompts.inbox.runtimes");
    change.inbox.runtimes = {};
    for (const [host, entry] of Object.entries(runtimes!)) {
      if (!(INBOX_PROMPT_HOSTS as readonly string[]).includes(host)) fail(`prompts.inbox.runtimes.${host}: not an agent (claude-code, pi, opencode).`, `prompts.inbox.runtimes.${host}`);
      const fields = record(entry);
      if (!fields || Object.keys(fields).length !== 1 || !("reminder" in fields)) {
        fail(`prompts.inbox.runtimes.${host}: { reminder }.`, `prompts.inbox.runtimes.${host}`);
      }
      change.inbox.runtimes[host as InboxPromptHost] = { reminder: text(fields!.reminder, `prompts.inbox.runtimes.${host}.reminder`) };
    }
  }
  return change;
}

/** Write a checked change into config.json (`prompts.inbox` only) and read it back. */
export function saveInboxPromptsChange(change: InboxPromptsChange): void {
  const inbox: NonNullable<PromptConfig["inbox"]> & Record<string, unknown> = {};
  // `undefined` deletes the key (saveConfig's prompts merge drops it, and an emptied entry with it).
  if ("reminder" in change.inbox) inbox.reminder = change.inbox.reminder ?? undefined;
  if (change.inbox.runtimes) {
    inbox.runtimes = {};
    for (const [host, entry] of Object.entries(change.inbox.runtimes)) {
      inbox.runtimes[host as InboxPromptHost] = { reminder: entry?.reminder ?? undefined };
    }
  }
  saveConfig({ prompts: { inbox } });
  const saved = record(record(loadConfig().prompts)?.inbox);
  const same = (stored: unknown, wanted: string | null | undefined) => (wanted === null || wanted === undefined ? stored === undefined : stored === wanted);
  const ok =
    (!("reminder" in change.inbox) || same(saved?.reminder, change.inbox.reminder)) &&
    Object.entries(change.inbox.runtimes ?? {}).every(([host, entry]) => same(record(record(saved?.runtimes)?.[host])?.reminder, entry?.reminder));
  if (!ok) {
    throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
  }
}
