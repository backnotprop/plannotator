/**
 * `plannotator inbox reminder --agent <id>`: the Inbox reminder for an agent
 * that reaches the Inbox through its MCP server (INBOX_HOOK_REMINDER_HOSTS),
 * printed for that agent's own hook at session start and after a compaction
 * where the agent has such an event. The same text the Claude Code mod, Pi and
 * OpenCode send (`resolveInboxReminderText`: the person's own line or
 * INBOX_REMINDER_TEXT, with INBOX_RULES_LEAD and the person's rules), under the
 * same gate: the agent's `inboxReminder` switch (on by default), the Inbox has
 * run here (`inbox/inbox.json`), and the agent reaches the Inbox (its record in
 * `inbox/agents.json`: an MCP entry Plannotator added or found).
 *
 * Fast and quiet: it reads three small files, never starts the Inbox, never
 * opens a connection, and prints nothing (exit 0) when the reminder is off or
 * anything fails, so an agent's session start never shows an error from it.
 *
 * Each agent's hook expects its own output (the docs, 2026-11-17):
 *  - Qwen Code, Kiro, Amp (our plugin reads it): the text on stdout.
 *  - Gemini CLI: JSON only, `hookSpecificOutput.additionalContext`.
 *  - Codex: `hookSpecificOutput.additionalContext`, added as developer context.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_MCP_WAKING_HOSTS } from "@plannotator/core/inbox-types";
import {
  isInboxHookReminderHost,
  loadConfig,
  resolveInboxReminder,
  resolveInboxReminderText,
  type InboxHookReminderHost,
  type PlannotatorConfig,
} from "../config";

/**
 * The name these agents know the Inbox by: its MCP server, `plannotator-inbox`
 * (INBOX_MCP_SERVER_NAME in packages/server/inbox-agents.ts). It stands where
 * the reminder names `plannotator_inbox`, as the mod puts its full tool name
 * there: "send it with plannotator-inbox send_message".
 */
export const INBOX_HOOK_REMINDER_TOOL_NAME = "plannotator-inbox";

/** How each hook host's hook reads the command's stdout. */
export const INBOX_HOOK_REMINDER_FORMATS: Readonly<Record<InboxHookReminderHost, "plain" | "additional-context">> = {
  qwen: "plain",
  gemini: "additional-context",
  amp: "plain",
  kiro: "plain",
  codex: "additional-context",
};

/**
 * Whether the reminder says a reply comes back into the session by itself (the wake line) or to read the thread
 * later (the no-wake line). Only an agent the Inbox can wake through its MCP connection (INBOX_MCP_WAKING_HOSTS)
 * and only when `canWake` says the Inbox really can now:
 *  - Qwen Code: Plannotator holds its trusted-sender token (`qwenCanWake` in packages/server/inbox-qwen-trust.ts,
 *    the check the Inbox's wake makes, read from disk).
 *  - Codex: the Inbox wakes it only through a Codex CLI with `codex queue`, which takes running `codex --version`
 *    to know (the Inbox's probe, up to 10 s): too slow for a session start, so the hook never claims it and gives
 *    the no-wake line. send_message's result says per call when a reply does come back.
 * Gemini CLI, Amp and Kiro are never woken.
 */
export function inboxHookReminderWakes(agent: InboxHookReminderHost, canWake: (agent: InboxHookReminderHost) => boolean = () => false): boolean {
  if (agent === "codex" || !INBOX_MCP_WAKING_HOSTS.includes(agent)) return false;
  try {
    return canWake(agent) === true;
  } catch {
    return false;
  }
}

/** The agent's record in `inbox/agents.json` says it reaches the Inbox through MCP (added or found, not removed since). */
export function inboxAgentReachedByRecord(dataDir: string, agent: string): boolean {
  try {
    const file = JSON.parse(readFileSync(join(dataDir, "inbox", "agents.json"), "utf8")) as { v?: unknown; agents?: Record<string, unknown> };
    if (file?.v !== 1 || !file.agents || typeof file.agents !== "object") return false;
    const record = file.agents[agent] as { state?: unknown; reach?: unknown; removed_outside_at?: unknown } | undefined;
    return !!record && record.reach === "mcp" && (record.state === "added" || record.state === "found") && record.removed_outside_at === undefined;
  } catch {
    return false;
  }
}

/** config.json is missing, empty, or a JSON object (what loadConfig reads); not a file it would read as `{}` after a failure. */
function configReadable(path: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }
  if (raw.trim() === "") return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export interface InboxHookReminderOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Whether the Inbox can wake this agent now (inboxHookReminderWakes). Absent: it cannot. */
  canWake?: (agent: InboxHookReminderHost) => boolean;
}

/**
 * The reminder text for `agent`, or null when it gets none. `config`: the
 * parsed config.json (read here when absent). The single place a hook host's
 * text is made, so a change to how hosts pick their rules applies to all of them.
 */
export function inboxHookReminderText(
  agent: InboxHookReminderHost,
  options: InboxHookReminderOptions & { config?: PlannotatorConfig },
): string | null {
  if (!existsSync(join(options.dataDir, "inbox", "inbox.json"))) return null;
  if (!inboxAgentReachedByRecord(options.dataDir, agent)) return null;
  // A config.json that is there but unreadable may hold the person's "off": nothing is said then.
  if (!options.config && !configReadable(join(options.dataDir, "config.json"))) return null;
  const config = options.config ?? loadConfig({ quiet: true });
  if (!resolveInboxReminder(config, options.env ?? process.env, agent)) return null;
  const text = resolveInboxReminderText(config, agent, { toolName: INBOX_HOOK_REMINDER_TOOL_NAME, wakes: inboxHookReminderWakes(agent, options.canWake) });
  return text.trim() ? text : null;
}

/** What the command prints for `agent` (the bytes its hook reads), or "" for nothing. */
export function inboxHookReminderOutput(agent: InboxHookReminderHost, text: string | null): string {
  if (text === null) return "";
  if (INBOX_HOOK_REMINDER_FORMATS[agent] === "plain") return `${text}\n`;
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`;
}

/** `--agent <id>` / `--agent=<id>` from the command's arguments: a hook host, or null. */
export function inboxHookReminderAgentArg(args: readonly string[]): InboxHookReminderHost | null {
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--agent") value = args[i + 1];
    else if (arg.startsWith("--agent=")) value = arg.slice("--agent=".length);
  }
  return value && isInboxHookReminderHost(value) ? value : null;
}

/** The whole command: what to print for these arguments (never throws; "" on any failure). */
export function runInboxHookReminder(args: readonly string[], options: InboxHookReminderOptions): string {
  try {
    const agent = inboxHookReminderAgentArg(args);
    if (!agent) return "";
    return inboxHookReminderOutput(agent, inboxHookReminderText(agent, options));
  } catch {
    return "";
  }
}
