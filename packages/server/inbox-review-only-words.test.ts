/**
 * What agents are told for a person who uses the Inbox for code review only (config.json `inboxReviewOnly: true`),
 * against the full Inbox: only the mode's difference is asserted, never a copy of the unchanged words. No Inbox runs.
 *
 * What regresses: the agent tool's lead keeping the full Inbox's rules (questions, finished work, "be proactive") for a
 * code-review-only person, or anything else of the tool changing for either; the Board's `card`, the Checklist's
 * `steps` or the Board line reaching a code-review-only agent; the mod's copy of the resolver or the builder saying
 * something else than the shared one; a host building the tool without the one resolver (`inboxAgentWords`), or
 * reading the setting itself; a session-start reminder while code review only; the MCP instructions keeping the full
 * rules or the person's own reminder; `--help` disagreeing with the sentence, naming `--review`, or growing by more
 * than the one line.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveInboxReminder, type PlannotatorConfig } from "@plannotator/shared/config";
import {
  INBOX_AGENT_RULES,
  INBOX_HELP_REVIEW_ONLY_LINE,
  INBOX_REVIEW_ONLY_RULE,
  INBOX_SUBAGENT_RULE,
  INBOX_TOOL_BOARD_OFF_NOTE,
  INBOX_TOOL_LEAD,
  inboxAgentTool,
  inboxAgentWords,
} from "@plannotator/shared/inbox/connection";
import { inboxAgentTool as modAgentTool } from "../../apps/hook/hooks/mod/inbox-contract";
import { INBOX_DEFAULT_TOOLS } from "../../apps/hook/hooks/mod/inbox-default-tools";
import { inboxAgentWordsOf, resolveInboxReminderEnabled } from "../../apps/hook/hooks/mod/enabled";
import { INBOX_COMMAND_USAGE } from "../../apps/hook/server/cli";
import { formatInboxHelp } from "../../apps/hook/server/inbox-help";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { INBOX_MCP_INSTRUCTIONS, inboxMcpInstructions } from "./inbox-mcp-instructions";

const root = resolve(import.meta.dir, "../..");
const tools = INBOX_DEFAULT_TOOLS.map((tool) => ({ ...tool }));
/** The tools an Inbox lists with the Board and the Checklist on. */
const withBoard = [
  ...tools,
  { name: "card", description: "A Board card.", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
  { name: "steps", description: "Your steps.", inputSchema: { type: "object", properties: { list: { type: "string" } } } },
];
const FULL = inboxAgentWords({});
const ONLY = inboxAgentWords({ inboxReviewOnly: true });
const lead = (description: string) => description.split("\n", 1)[0];

describe("the one resolver", () => {
  test("code review only is `inboxReviewOnly: true` alone; anything else is the full Inbox", () => {
    const configs: unknown[] = [null, undefined, {}, { inboxReviewOnly: false }, { inboxReviewOnly: "true" }, { inboxCodeReview: true }, { inboxReviewOnly: true }, { inboxReviewOnly: true, inboxCodeReview: false }];
    expect(configs.map((c) => inboxAgentWords(c as PlannotatorConfig).reviewOnly)).toEqual([false, false, false, false, false, false, true, true]);
  });

  test("the mod reads config.json's text as the shared resolver reads the config", () => {
    for (const config of [{}, { inboxReviewOnly: true }, { inboxReviewOnly: false }, { inboxReviewOnly: true, inboxCodeReview: false }]) {
      const mod = inboxAgentWordsOf(JSON.stringify(config));
      const shared = inboxAgentWords(config);
      const { reveal: _r, action: _a, ...modData } = mod;
      const { reveal: _r2, action: _a2, ...sharedData } = shared;
      expect(modData).toEqual(sharedData);
      for (const id of ["board", "steps", "routines", "snooze", "priority", "personal_agents", "bro", "code_review", "review_welcome", "tab_icon"]) expect(mod.reveal(id)).toBe(shared.reveal(id));
      for (const name of ["card", "steps", "send_message", "submit_guide", "routine"]) expect(mod.action(name)).toBe(shared.action(name));
      expect(modAgentTool(withBoard, { words: mod })).toEqual(inboxAgentTool(withBoard, { words: shared }));
    }
    expect(inboxAgentWordsOf(null).reviewOnly).toBe(false);
    expect(inboxAgentWordsOf("{not json").reviewOnly).toBe(false);
  });

  test("while code review only, no dialog offers a full-Inbox feature; the welcome and the rest still may", () => {
    for (const id of ["board", "steps", "routines", "snooze", "priority", "personal_agents", "bro"]) expect([id, ONLY.reveal(id), FULL.reveal(id)]).toEqual([id, false, true]);
    for (const id of ["review_welcome", "tab_icon", "theme_chooser", "star"]) expect([id, ONLY.reveal(id)]).toEqual([id, true]);
  });
});

describe("the agent tool's description", () => {
  test("full Inbox: as without the resolver, every host the same", () => {
    expect(inboxAgentTool(withBoard, { words: FULL })).toEqual(inboxAgentTool(withBoard));
    expect(lead(inboxAgentTool(tools, { words: FULL })!.description)).toBe(INBOX_TOOL_LEAD);
  });

  test("code review only: the one sentence in place of the rules that ask for other traffic; the rest as the full Inbox's", () => {
    for (const build of [inboxAgentTool, modAgentTool]) {
      const full = build(tools, { words: FULL })!;
      const only = build(tools, { words: ONLY })!;
      expect(lead(only.description)).toBe(INBOX_TOOL_LEAD.replace(INBOX_AGENT_RULES, `${INBOX_REVIEW_ONLY_RULE} ${INBOX_SUBAGENT_RULE}`));
      expect(only.description).not.toContain("proactiv");
      // The mode's only other difference: no Board line (the Board has no place in it).
      expect(only.description.slice(lead(only.description).length)).toBe(full.description.slice(lead(full.description).length).replace(`\n${INBOX_TOOL_BOARD_OFF_NOTE}`, ""));
      expect(only.inputSchema).toEqual(full.inputSchema);
    }
    // OpenCode 1 (no wake) too.
    expect(lead(inboxAgentTool(tools, { wakes: false, words: ONLY })!.description)).toBe(lead(inboxAgentTool(tools, { words: ONLY })!.description));
  });

  test("code review only: no `card` or `steps` action, even listed by an Inbox whose Board and Checklist are on", () => {
    const full = inboxAgentTool(withBoard, { words: FULL })!;
    const only = inboxAgentTool(withBoard, { words: ONLY })!;
    const actions = (spec: typeof full) => (spec.inputSchema.properties as { action: { enum: string[] } }).action.enum;
    expect(actions(full)).toEqual(expect.arrayContaining(["card", "steps"]));
    expect(actions(only)).not.toContain("card");
    expect(actions(only)).not.toContain("steps");
    expect(only.description).not.toMatch(/^- (card|steps):/m);
    expect(only.description).not.toContain(INBOX_TOOL_BOARD_OFF_NOTE);
  });
});

describe("every host builds its words through the one resolver", () => {
  const listed = (pattern: string) =>
    new TextDecoder()
      .decode(Bun.spawnSync(["git", "grep", "-l", "-F", pattern, "--", "apps", "packages"], { cwd: root }).stdout)
      .split("\n")
      .filter((file) => file && !/\.test\.tsx?$/.test(file) && !file.includes("/generated/"));

  test("each call that builds the agent tool passes this computer's words", () => {
    const files = listed("inboxAgentTool(");
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const lines = readFileSync(join(root, file), "utf8").split("\n");
      for (const line of lines) {
        if (!line.includes("inboxAgentTool(") || /function inboxAgentTool\(/.test(line) || /^\s*(\*|\/\/)/.test(line)) continue;
        expect([file, line.includes("words:")]).toEqual([file, true]);
      }
    }
  });

  test("no host reads the setting itself (the mod's copy of the resolver apart)", () => {
    const readers = listed("inboxReviewOnly").filter((file) => /^apps\/(cline-plugin|dsh-plugin|openclaw-plugin|opencode-plugin|pi-extension|hook\/hooks\/mod)\//.test(file) && file !== "apps/hook/hooks/mod/inbox-contract.ts");
    expect(readers).toEqual([]);
  });
});

describe("the session-start reminder", () => {
  test("none while code review only, for Claude Code, Pi and OpenCode, whatever the person's own switch; the full Inbox keeps it", () => {
    const only: PlannotatorConfig = { inboxTool: true, inboxReviewOnly: true };
    const full: PlannotatorConfig = { inboxTool: true, inboxReviewOnly: false };
    for (const host of ["claude-code", "pi", "opencode"] as const) {
      expect(resolveInboxReminder(only, {}, host)).toBe(false);
      expect(resolveInboxReminder({ ...only, inboxReminder: true }, {}, host)).toBe(false);
      expect(resolveInboxReminder(full, {}, host)).toBe(true);
    }
    expect(resolveInboxReminderEnabled(undefined, JSON.stringify({ ...only, inboxReminder: true }))).toBe(false);
    expect(resolveInboxReminderEnabled(undefined, JSON.stringify(full))).toBe(true);
  });
});

describe("the MCP server's instructions", () => {
  test("full Inbox: as before", () => {
    expect(inboxMcpInstructions(null, "claude_code", FULL)).toBe(INBOX_MCP_INSTRUCTIONS);
  });

  test("code review only: the mode's rules in the full rules' place, and none of the person's reminder or rules", () => {
    const reminder = { custom: "Send me everything you finish.", rules: "Always post a summary." };
    for (const tier of ["claude_code_old", "claude_code", "other"] as const) {
      const only = inboxMcpInstructions(reminder, tier, ONLY);
      expect(only).toBe(INBOX_MCP_INSTRUCTIONS.replace(INBOX_AGENT_RULES, `${INBOX_REVIEW_ONLY_RULE} ${INBOX_SUBAGENT_RULE}`));
      expect(only).not.toContain(reminder.custom);
      expect(only).not.toContain(reminder.rules);
    }
  });
});

describe("plannotator inbox --help", () => {
  const home = mkdtempSync(join(tmpdir(), "plannotator-review-only-help-"));
  const help = (words: typeof FULL, extra: { board?: boolean; steps?: boolean } = {}) =>
    formatInboxHelp({
      command: ["plannotator"],
      dataDir: join(home, ".plannotator"),
      platform: "linux",
      agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }),
      codeReview: true,
      ...extra,
      words,
    });

  test("code review only: the approved line right under \"When to use it\", and nothing else changes", () => {
    expect(help(ONLY)).toBe(help(FULL).replace("## When to use it\n\n", `## When to use it\n\n${INBOX_HELP_REVIEW_ONLY_LINE}\n\n`));
    // It says what the tool's sentence says.
    expect(INBOX_HELP_REVIEW_ONLY_LINE.slice(INBOX_HELP_REVIEW_ONLY_LINE.indexOf(":"))).toBe(INBOX_REVIEW_ONLY_RULE.slice(INBOX_REVIEW_ONLY_RULE.indexOf(":")));
  });

  test("code review only: no cards or steps in the guide, even with the Board and the Checklist on", () => {
    const only = help(ONLY, { board: true, steps: true });
    expect(only).toBe(help(ONLY));
    expect(only).not.toMatch(/^### (card|steps)$/m);
  });

  test("its size: the mode adds one line and no more; the usage names no `--review`", () => {
    expect(help(ONLY).length).toBe(help(FULL).length + INBOX_HELP_REVIEW_ONLY_LINE.length + 2);
    expect(INBOX_COMMAND_USAGE).not.toContain("--review");
  });
});
