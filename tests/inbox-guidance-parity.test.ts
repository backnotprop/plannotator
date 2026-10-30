/**
 * Every harness gets the same Inbox guidance unless its harness truly differs
 * (the owner, 2026-10-27: "all agents should basically have same instructions
 * unless their harnesses call for different behavior"). Each surface an agent
 * reads is built here from its real source, and the core sentences are checked
 * on it verbatim. A surface that is allowed to differ is listed in EXCEPTIONS
 * with its reason, so a new difference fails until someone decides it is one.
 *
 * Surfaces and who reads them:
 *  - the `plannotator_inbox` tool: Claude Code (the mod's contract copy and
 *    bundled tool list), Pi and OpenCode 2 (the shared contract, wake form),
 *    OpenCode 1 (no wake);
 *  - the Inbox's MCP server instructions: Codex, Gemini CLI, Cursor, Grok
 *    Build run by the Inbox, the Claude app, any MCP client;
 *  - the session reminder (Claude Code's session start and compaction hook,
 *    Pi, OpenCode 2; the no-wake form on OpenCode 1);
 *  - the opt-in note (Claude Code, Codex, OpenCode, Pi, Gemini CLI, Cursor);
 *  - `plannotator inbox --help` and the `plannotator` skill (everyone);
 *  - `/plannotator-inbox`'s Inbox briefing: the copies an agent reads itself
 *    (the Claude skill without the mod, the core skill for Codex, Kiro, Vibe
 *    and the rest, OpenCode's stub without the plugin, Gemini's command,
 *    Droid's script output, run here against a stand-in CLI), and the shared
 *    INBOX_COMMAND_BRIEFING the hosts that answer the command themselves give
 *    the model unseen (the Claude Code mod, Pi, OpenCode 2; OpenCode 1 in the
 *    command's turn). Amp gives none: its plugin has no way to add context
 *    without starting a turn.
 *
 * Nothing here starts an Inbox, reads the real home or opens a browser: the
 * help is formatted against a scratch home.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  INBOX_BRIEFING_FROM_NOW_ON,
  INBOX_CHANNEL_RULE,
  INBOX_COMMAND_BRIEFING,
  INBOX_FOLLOW_THROUGH_RULE,
  INBOX_REMINDER_TEXT,
  INBOX_REMINDER_TEXT_NO_WAKE,
  INBOX_REPLY_TO_CHECK,
  INBOX_SUBAGENT_RULE,
  INBOX_TOOL_WAKE_NOTE,
  INBOX_USE_RULE,
  inboxAgentTool,
  inboxReminderText,
} from "../packages/shared/inbox/connection";
import { inboxAgentTool as modAgentTool, inboxReminderText as modReminderText } from "../apps/hook/hooks/mod/inbox-contract";
import { INBOX_DEFAULT_TOOLS } from "../apps/hook/hooks/mod/inbox-default-tools";
import { INBOX_MCP_INSTRUCTIONS } from "../packages/server/inbox-mcp";
import { INBOX_NOTE_BODY } from "../packages/server/inbox-agent-notes";
import { createAgentEnvironmentFor } from "../packages/server/inbox-agents";
import { formatInboxHelp } from "../apps/hook/server/inbox-help";
import { inboxCommandTurnText } from "../apps/opencode-plugin/cli-bridge";
import { runDroidInboxCommand } from "./helpers/droid-inbox-command";

const root = resolve(import.meta.dir, "..");
const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-guidance-parity-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** A tool entry as the model reads it: the description and every field's description. */
const entryText = (tool: { description: string; inputSchema: Record<string, unknown> } | null): string => {
  expect(tool).not.toBeNull();
  return `${tool!.description}\n${JSON.stringify(tool!.inputSchema)}`;
};

const CLAUDE_CODE_TOOL = "mcp__plannotator__plannotator_inbox";

/**
 * People type `/plannotator-inbox` expecting it to teach their agent the
 * Inbox (the owner, 2026-10-28), so every copy the agent reads carries the
 * briefing beside the address, and the hosts that answer the command
 * themselves give the model the shared one.
 */
const COMMAND_FILES = [
  "apps/skills/claude/plannotator-inbox/SKILL.md",
  "apps/skills/core/plannotator-inbox/SKILL.md",
  "apps/opencode-plugin/commands/plannotator-inbox.md",
  "apps/gemini/commands/plannotator-inbox.toml",
] as const;
const DROID_OUTPUT = "/plannotator-inbox: Droid's script output";
const INBOX_COMMANDS: Record<string, string> = {
  ...Object.fromEntries(COMMAND_FILES.map((path) => [`/plannotator-inbox: ${path}`, readFileSync(join(root, path), "utf8")])),
  [DROID_OUTPUT]: process.platform === "win32" ? "" : runDroidInboxCommand("echo 'http://127.0.0.1:61234/'").stdout,
  "/plannotator-inbox briefing: Claude Code mod, Pi, OpenCode 2": INBOX_COMMAND_BRIEFING,
  "/plannotator-inbox: OpenCode 1's command turn": inboxCommandTurnText("Plannotator Inbox: http://127.0.0.1:61234/"),
};
const inboxCommands = Object.keys(INBOX_COMMANDS);
/** The copies the person's command answers in the agent's own turn: they end by passing the address on. */
const inboxCommandTurns = inboxCommands.filter((name) => name !== "/plannotator-inbox briefing: Claude Code mod, Pi, OpenCode 2");
/** Where the agent may have no `plannotator_inbox` tool at all, so the send line names the MCP server alone. */
const MCP_ONLY_SEND = ["/plannotator-inbox: apps/gemini/commands/plannotator-inbox.toml", DROID_OUTPUT];

const SURFACES: Record<string, string> = {
  "tool: Claude Code (mod copy, bundled list)": entryText(modAgentTool(INBOX_DEFAULT_TOOLS)),
  "tool: Pi, OpenCode 2 (wake)": entryText(inboxAgentTool(INBOX_DEFAULT_TOOLS)),
  "tool: OpenCode 1 (no wake)": entryText(inboxAgentTool(INBOX_DEFAULT_TOOLS, { wakes: false })),
  "MCP instructions: Codex, Gemini, Cursor, Grok, MCP clients": INBOX_MCP_INSTRUCTIONS,
  "reminder: Claude Code (session start, compaction hook)": modReminderText(CLAUDE_CODE_TOOL),
  "reminder: Pi, OpenCode 2": inboxReminderText(),
  "reminder: OpenCode 1 (no wake)": inboxReminderText(undefined, { wakes: false }),
  "note (opt-in)": INBOX_NOTE_BODY,
  "plannotator inbox --help": formatInboxHelp({
    command: ["plannotator"],
    dataDir: join(home, ".plannotator"),
    platform: "linux",
    agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }),
  }),
  "plannotator skill": readFileSync(join(root, "apps/skills/core/plannotator/SKILL.md"), "utf8"),
  ...INBOX_COMMANDS,
};

const SENTENCES = {
  "follow through": INBOX_FOLLOW_THROUGH_RULE,
  "when to use it": INBOX_USE_RULE,
  "chat or Inbox": INBOX_CHANNEL_RULE,
  "subagent reports to its agent": INBOX_SUBAGENT_RULE,
  "reply_to check": INBOX_REPLY_TO_CHECK,
} as const;

type Sentence = keyof typeof SENTENCES;
const reminders = ["reminder: Claude Code (session start, compaction hook)", "reminder: Pi, OpenCode 2", "reminder: OpenCode 1 (no wake)"];
const prose = ["note (opt-in)", "plannotator inbox --help", "plannotator skill"];

/** Where a core sentence may be missing or reworded, and why. Anything else must carry it verbatim. */
const EXCEPTIONS: Record<Sentence, Record<string, string>> = {
  // No exceptions: every harness and every surface carries the one wording.
  "follow through": {},
  "when to use it": Object.fromEntries([
    ...reminders.map((s) => [s, "one line in the chat: words it as 'when you finish long work, or need a decision'"]),
    ...prose.map((s) => [s, "prose guide: expands it"]),
  ]),
  "chat or Inbox": Object.fromEntries([
    ...reminders.map((s) => [s, "one line in the chat: the shortened 'when the person writes here' form (checked below)"]),
    ...prose.map((s) => [s, "prose guide: expands it ('Chat or Inbox')"]),
  ]),
  "subagent reports to its agent": {
    ...Object.fromEntries(reminders.map((s) => [s, "main sessions only: no subagent gets the reminder"])),
    "note (opt-in)": "the note is read by the main agent; every tool and MCP surface carries the line",
    "plannotator skill": "in the skill's description, lowercase in parentheses (checked below)",
    ...Object.fromEntries(inboxCommands.map((s) => [s, "the person types it in their own session, never a subagent"])),
  },
  "reply_to check": {
    ...Object.fromEntries(reminders.map((s) => [s, "the post-compaction thread list carries it instead"])),
    "MCP instructions: Codex, Gemini, Cursor, Grok, MCP clients": "MCP clients read it on the reply_to and read_thread descriptions (inbox-mcp.ts)",
    "plannotator skill": "the skill defers the reply_to rules to --help",
    ...Object.fromEntries(inboxCommands.map((s) => [s, "the briefing defers the reply_to rules to --help"])),
  },
};

describe("Inbox guidance parity across harnesses", () => {
  for (const [name, sentence] of Object.entries(SENTENCES) as [Sentence, string][]) {
    test(`"${name}": verbatim on every surface but its documented exceptions`, () => {
      const missing = Object.entries(SURFACES)
        .filter(([surface, text]) => !(surface in EXCEPTIONS[name]) && !text.includes(sentence))
        .map(([surface]) => surface);
      expect(missing).toEqual([]);
      // An exception for a surface that does not exist is a stale table.
      for (const surface of Object.keys(EXCEPTIONS[name])) expect(Object.keys(SURFACES)).toContain(surface);
    });
  }

  test("the follow-through rule appears once per surface (never stated twice)", () => {
    for (const [surface, text] of Object.entries(SURFACES)) expect([surface, text.split(INBOX_FOLLOW_THROUGH_RULE).length - 1]).toEqual([surface, 1]);
  });

  test("the agent tool and the MCP instructions carry the same rules in the same order", () => {
    const rules = `${INBOX_USE_RULE} ${INBOX_CHANNEL_RULE} ${INBOX_FOLLOW_THROUGH_RULE} ${INBOX_SUBAGENT_RULE}`;
    expect(SURFACES["tool: Pi, OpenCode 2 (wake)"]).toContain(rules);
    expect(SURFACES["MCP instructions: Codex, Gemini, Cursor, Grok, MCP clients"]).toContain(rules);
  });

  test("Claude Code's tool is the one Pi and OpenCode 2 get: the mod's contract copy builds the same entry", () => {
    expect(SURFACES["tool: Claude Code (mod copy, bundled list)"]).toBe(SURFACES["tool: Pi, OpenCode 2 (wake)"]);
    expect(modReminderText(CLAUDE_CODE_TOOL)).toBe(INBOX_REMINDER_TEXT.replace("plannotator_inbox", CLAUDE_CODE_TOOL));
  });

  test("the wake and no-wake forms differ only where the harness does: how the reply comes back", () => {
    // The tool: OpenCode 1 lacks only the wake note.
    expect(SURFACES["tool: OpenCode 1 (no wake)"]).toBe(SURFACES["tool: Pi, OpenCode 2 (wake)"].replace(`\n\n${INBOX_TOOL_WAKE_NOTE}`, ""));
    // The reminder: one sentence each.
    expect(INBOX_REMINDER_TEXT_NO_WAKE).toBe(INBOX_REMINDER_TEXT.replace("Their reply comes back here.", "Call wait_for_reply when you need their answer."));
  });

  test("the reminder's shortened chat-or-Inbox sentence is the channel rule's first sentence, said in the chat", () => {
    const first = INBOX_CHANNEL_RULE.slice(0, INBOX_CHANNEL_RULE.indexOf(".") + 1);
    for (const surface of reminders) expect(SURFACES[surface]).toContain(first.replace("writes in the chat", "writes here"));
  });

  test("in the reminder, the follow-through rule follows the send, before anything about the chat", () => {
    for (const surface of reminders) {
      const text = SURFACES[surface]!;
      expect(text).toContain(`send_message and keep going. ${INBOX_FOLLOW_THROUGH_RULE}`);
      expect(text.indexOf(INBOX_FOLLOW_THROUGH_RULE)).toBeLessThan(text.indexOf("when the person writes here"));
    }
  });

  test("no surface bans progress: the follow-through rule asks for updates the person would want", () => {
    for (const [surface, text] of Object.entries(SURFACES)) expect([surface, /routine progress/i.test(text)]).toEqual([surface, false]);
  });

  test("the docs that quote the reminder quote it as agents get it", () => {
    const docs = (path: string) => readFileSync(join(root, path), "utf8");
    expect(docs("apps/marketing/src/content/docs/reference/inbox.md")).toContain(`> ${INBOX_REMINDER_TEXT}\n`);
    // The inboxReminder entry under config-only settings.
    expect(docs("docs/agent-guides/environment.md")).toContain(`("${INBOX_REMINDER_TEXT}"`);
  });

  test("MCP clients are still told to pass an idempotency_key, in its field (moved there from the server instructions)", () => {
    const field = (INBOX_DEFAULT_TOOLS.find((tool) => tool.name === "send_message")!.inputSchema.properties as Record<string, { description?: string }>).idempotency_key!;
    expect(field.description).toContain("Pass an idempotency_key so a retry never posts twice.");
  });

  test("every /plannotator-inbox copy carries the shared briefing's lines word for word (Gemini and Droid name the MCP server alone)", () => {
    const bullets = INBOX_COMMAND_BRIEFING.split("\n").filter((line) => line.startsWith("- "));
    const send = bullets.find((line) => line.startsWith("- Send with"))!;
    expect(bullets.length).toBeGreaterThan(5);
    for (const [surface, text] of Object.entries(INBOX_COMMANDS)) {
      const missing = bullets.filter((line) => !(line === send && MCP_ONLY_SEND.includes(surface)) && !text.includes(line));
      expect([surface, missing]).toEqual([surface, []]);
      expect([surface, text.includes(INBOX_BRIEFING_FROM_NOW_ON)]).toEqual([surface, true]);
    }
    for (const surface of MCP_ONLY_SEND) expect(INBOX_COMMANDS[surface]).toContain("`send_message` tool of the Inbox's MCP server");
  });

  test("the command copies still open the Inbox, and their ending starts and resumes no work", () => {
    for (const path of COMMAND_FILES) expect([path, INBOX_COMMANDS[`/plannotator-inbox: ${path}`]!.includes("plannotator inbox --open")]).toEqual([path, true]);
    expect(readFileSync(join(root, "apps/droid-plugin/commands/plannotator-inbox.js"), "utf8")).toContain('runPlannotator(["inbox", "--open"]');
    for (const surface of inboxCommandTurns) {
      expect([surface, INBOX_COMMANDS[surface]!.includes("This command starts no new work and resumes none: do anything else the person asked in the same message, otherwise stop there.")]).toEqual([surface, true]);
    }
  });

  test("the skill's description carries the subagent rule", () => {
    expect(SURFACES["plannotator skill"]).toContain(`(${INBOX_SUBAGENT_RULE.charAt(0).toLowerCase()}${INBOX_SUBAGENT_RULE.slice(1, -1)})`);
  });
});
