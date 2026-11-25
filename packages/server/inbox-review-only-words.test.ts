/**
 * What agents are told for a person who uses the Inbox for code review only (config.json `inboxReviewOnly`, with Code
 * review on), against the full Inbox. No Inbox runs.
 *
 * What regresses: the agent tool's lead keeping the full Inbox's rules (questions, finished work, "be proactive") for a
 * code-review-only person, or losing them for a full-Inbox person; the mod's copy of the builder saying something else
 * than the shared one; the mod reading the setting differently from the other hosts; a session-start reminder still
 * sent while code review only (Claude Code, Pi, OpenCode); the MCP server's instructions (Codex, Gemini, any MCP
 * client) keeping the full rules, or the person's own reminder riding them; the setting taking effect without Code
 * review on.
 */
import { describe, expect, test } from "bun:test";
import { resolveInboxReminder, resolveInboxReviewOnly, type PlannotatorConfig } from "@plannotator/shared/config";
import { INBOX_AGENT_RULES, INBOX_REVIEW_ONLY_RULE, INBOX_USE_RULE, inboxAgentTool } from "@plannotator/shared/inbox/connection";
import { inboxAgentTool as modAgentTool } from "../../apps/hook/hooks/mod/inbox-contract";
import { INBOX_DEFAULT_TOOLS } from "../../apps/hook/hooks/mod/inbox-default-tools";
import { resolveInboxReminderEnabled, resolveInboxReviewOnlyEnabled } from "../../apps/hook/hooks/mod/enabled";
import { INBOX_MCP_INSTRUCTIONS, inboxMcpInstructions } from "./inbox-mcp-instructions";

const FULL_LEAD =
  "The Plannotator Inbox on this machine: message the person, get their answer later; nothing blocks. Use it for a decision only they can make (a :::question block; go on with other work), finished long work (a short summary with its pictures inline, files in `attachments`), or when they ask. One thread per work stream, unless the person says otherwise. A decision in the Inbox stays there: when the person writes in the chat, say what waits and link its thread, but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar). Ask in the chat only about something new they raised there that needs no pictures or files, or when they ask. Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination. If another agent started you, report to it instead. Set `action` to a tool below, with its fields.";

const REVIEW_ONLY_LEAD =
  "The Plannotator Inbox on this machine: message the person, get their answer later; nothing blocks. The person uses it for code review only: use it for a review they ask you for, and to answer them in a review's thread; anything else, ask in the chat. If another agent started you, report to it instead. Set `action` to a tool below, with its fields.";

const tools = INBOX_DEFAULT_TOOLS.map((tool) => ({ ...tool }));
const lead = (description: string) => description.split("\n", 1)[0];

describe("the agent tool's description", () => {
  test("full Inbox: the lead as before, every rule", () => {
    for (const build of [inboxAgentTool, modAgentTool]) {
      expect(lead(build(tools)!.description)).toBe(FULL_LEAD);
      expect(lead(build(tools, { reviewOnly: false })!.description)).toBe(FULL_LEAD);
    }
  });

  test("code review only: the one sentence in place of the rules that ask for other traffic; nothing else changes", () => {
    for (const build of [inboxAgentTool, modAgentTool]) {
      const full = build(tools)!;
      const only = build(tools, { reviewOnly: true })!;
      expect(lead(only.description)).toBe(REVIEW_ONLY_LEAD);
      expect(only.description).not.toContain("proactiv");
      expect(only.description).not.toContain(INBOX_USE_RULE);
      // The action lines, the wake note and the schema are the full Inbox's.
      expect(only.description.slice(lead(only.description).length)).toBe(full.description.slice(lead(full.description).length));
      expect(only.inputSchema).toEqual(full.inputSchema);
    }
    // OpenCode 1 (no wake) too.
    expect(lead(inboxAgentTool(tools, { wakes: false, reviewOnly: true })!.description)).toBe(REVIEW_ONLY_LEAD);
  });

  test("the sentence is one constant, the same in the mod's copy", () => {
    expect(REVIEW_ONLY_LEAD).toContain(INBOX_REVIEW_ONLY_RULE);
    expect(lead(modAgentTool(tools, { reviewOnly: true })!.description)).toBe(lead(inboxAgentTool(tools, { reviewOnly: true })!.description));
  });
});

describe("the setting, as each host reads it at session start", () => {
  const configs: PlannotatorConfig[] = [
    {},
    { inboxReviewOnly: true },
    { inboxCodeReview: true },
    { inboxReviewOnly: true, inboxCodeReview: true },
    { inboxReviewOnly: false, inboxCodeReview: true },
    { inboxReviewOnly: true, inboxCodeReview: false },
  ];

  test("on only with Code review on; the mod reads it as the shared resolver does", () => {
    expect(configs.map(resolveInboxReviewOnly)).toEqual([false, false, false, true, false, false]);
    for (const config of configs) expect(resolveInboxReviewOnlyEnabled(JSON.stringify(config))).toBe(resolveInboxReviewOnly(config));
    expect(resolveInboxReviewOnlyEnabled(null)).toBe(false);
    expect(resolveInboxReviewOnlyEnabled("{not json")).toBe(false);
  });

  test("no session-start reminder while code review only, for Claude Code, Pi and OpenCode; the full Inbox keeps it", () => {
    const only: PlannotatorConfig = { inboxTool: true, inboxReviewOnly: true, inboxCodeReview: true };
    const full: PlannotatorConfig = { inboxTool: true, inboxReviewOnly: false, inboxCodeReview: true };
    for (const host of ["claude-code", "pi", "opencode"] as const) {
      expect(resolveInboxReminder(only, {}, host)).toBe(false);
      expect(resolveInboxReminder(full, {}, host)).toBe(true);
      // The person's own "reminder on" does not bring it back.
      expect(resolveInboxReminder({ ...only, inboxReminder: true }, {}, host)).toBe(false);
    }
    expect(resolveInboxReminderEnabled(undefined, JSON.stringify(only))).toBe(false);
    expect(resolveInboxReminderEnabled(undefined, JSON.stringify({ ...only, inboxReminder: true }))).toBe(false);
    expect(resolveInboxReminderEnabled(undefined, JSON.stringify(full))).toBe(true);
  });
});

describe("the MCP server's instructions", () => {
  test("full Inbox: as before", () => {
    expect(inboxMcpInstructions(null)).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(inboxMcpInstructions(null, "claude_code", false)).toBe(INBOX_MCP_INSTRUCTIONS);
  });

  test("code review only: the review-only rule in the full rules' place, and none of the person's reminder or rules", () => {
    const reminder = { custom: "Send me everything you finish.", rules: "Always post a summary." };
    for (const tier of ["claude_code_old", "claude_code", "other"] as const) {
      const only = inboxMcpInstructions(reminder, tier, true);
      expect(only).toContain(INBOX_REVIEW_ONLY_RULE);
      expect(only).not.toContain(INBOX_AGENT_RULES);
      expect(only).not.toContain("proactiv");
      expect(only).not.toContain(reminder.custom);
      expect(only).not.toContain(reminder.rules);
      expect(only).toBe(INBOX_MCP_INSTRUCTIONS.replace(INBOX_AGENT_RULES, `${INBOX_REVIEW_ONLY_RULE} If another agent started you, report to it instead.`));
    }
  });
});
