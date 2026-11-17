/**
 * `plannotator inbox reminder --agent <id>` (reminder-hook.ts): what each hook
 * host's hook reads. Checked against the shared sources (inboxReminderText,
 * inboxReminderWithRules), never a copy of the prose. What can regress: the
 * text in the wrong format for an agent (Gemini CLI reads JSON only), a reminder
 * for an agent turned off, not set up or not reaching the Inbox, the wrong
 * wording for an agent whose reply never comes back, the person's rules lost,
 * and anything but silence on a failure. Every file is in a scratch data dir.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_HOOK_REMINDER_HOSTS, type PlannotatorConfig } from "../config";
import { inboxReminderText, inboxReminderWithRules } from "./connection";
import { INBOX_HOOK_REMINDER_TOOL_NAME, inboxHookReminderText, runInboxHookReminder } from "./reminder-hook";

let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-reminder-hook-"));
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

/** The Inbox has run here, and each agent named has an MCP record. */
function setUp(records: Record<string, Record<string, unknown>> = Object.fromEntries(INBOX_HOOK_REMINDER_HOSTS.map((agent) => [agent, { reach: "mcp", state: "added" }]))): void {
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ port: 1, pid: 1 }));
  writeFileSync(join(dataDir, "inbox", "agents.json"), JSON.stringify({ v: 1, agents: records }));
}
const config = (value: PlannotatorConfig) => writeFileSync(join(dataDir, "config.json"), JSON.stringify(value));
const run = (agent: string, env: NodeJS.ProcessEnv = {}) => runInboxHookReminder(["--agent", agent], { dataDir, env });
const WAKE = inboxReminderText(INBOX_HOOK_REMINDER_TOOL_NAME);
const NO_WAKE = inboxReminderText(INBOX_HOOK_REMINDER_TOOL_NAME, { wakes: false });

test("on: each agent gets the shared reminder in the form its hook reads, with the wording for whether its reply comes back", () => {
  setUp();
  // Codex and Gemini CLI: one JSON object, the text as SessionStart's additionalContext.
  for (const [agent, text] of [["codex", WAKE], ["gemini", NO_WAKE]] as const) {
    const out = run(agent);
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
  }
  // Qwen Code, Kiro, Amp: the text itself.
  expect(run("qwen")).toBe(`${WAKE}\n`);
  expect(run("kiro")).toBe(`${NO_WAKE}\n`);
  expect(run("amp")).toBe(`${NO_WAKE}\n`);
  // `--agent=<id>` reads the same.
  expect(runInboxHookReminder(["--agent=qwen"], { dataDir, env: {} })).toBe(`${WAKE}\n`);
  // The name the agent knows the Inbox by stands where the tool is named.
  expect(WAKE).toContain(`${INBOX_HOOK_REMINDER_TOOL_NAME} send_message`);
});

test("the person's rules: under the shared lead, an agent's own winning over the ones for all agents; their own reminder text too", () => {
  setUp();
  config({ prompts: { inbox: { rules: "Keep it short.\nUse plannotator_inbox for decisions.", runtimes: { kiro: { rules: "Only for Kiro." }, codex: { reminder: "My own Codex line." } } } } });
  expect(run("qwen")).toBe(`${inboxReminderWithRules(WAKE, "Keep it short.\nUse plannotator_inbox for decisions.", INBOX_HOOK_REMINDER_TOOL_NAME)}\n`);
  expect(run("qwen")).toContain(`Use ${INBOX_HOOK_REMINDER_TOOL_NAME} for decisions.`);
  expect(run("kiro")).toBe(`${inboxReminderWithRules(NO_WAKE, "Only for Kiro.")}\n`);
  expect(JSON.parse(run("codex")).hookSpecificOutput.additionalContext).toBe(inboxReminderWithRules("My own Codex line.", "Keep it short.\nUse plannotator_inbox for decisions.", INBOX_HOOK_REMINDER_TOOL_NAME));
});

test("off: an agent's switch, or the one for every agent, prints nothing; the Inbox tool's setting does not apply to them", () => {
  setUp();
  config({ inboxReminder: { codex: false } });
  expect(run("codex")).toBe("");
  expect(run("gemini")).not.toBe("");
  config({ inboxReminder: false });
  for (const agent of INBOX_HOOK_REMINDER_HOSTS) expect(run(agent)).toBe("");
  config({});
  expect(run("qwen", { PLANNOTATOR_INBOX_TOOL: "0" })).toBe(`${WAKE}\n`);
});

test("not set up: no Inbox here, no record, a record that is not MCP or was removed outside, prints nothing", () => {
  expect(run("codex")).toBe("");
  setUp({ gemini: { reach: "cli", state: "added" }, kiro: { reach: "mcp", state: "added", removed_outside_at: "2026-11-17T00:00:00.000Z" }, amp: { reach: "mcp", state: "failed" } });
  for (const agent of INBOX_HOOK_REMINDER_HOSTS) expect(run(agent)).toBe("");
  expect(inboxHookReminderText("qwen", { dataDir, config: {} })).toBeNull();
});

test("failure: damaged records, a data dir that is a file, an unknown or missing agent, all print nothing and never throw", () => {
  setUp();
  writeFileSync(join(dataDir, "inbox", "agents.json"), "{ not json");
  expect(run("codex")).toBe("");
  const file = join(dataDir, "a-file");
  writeFileSync(file, "x");
  expect(runInboxHookReminder(["--agent", "codex"], { dataDir: file, env: {} })).toBe("");
  setUp();
  for (const args of [[], ["--agent"], ["--agent", "cursor"], ["--agent", "claude-code"]]) expect(runInboxHookReminder(args, { dataDir, env: {} })).toBe("");
});
