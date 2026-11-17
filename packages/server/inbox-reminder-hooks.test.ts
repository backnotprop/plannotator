/**
 * The Inbox reminder hooks Plannotator writes into Gemini CLI's, Kiro's and
 * Codex's own hook config (inbox-reminder-hooks.ts). What can regress: a byte
 * of the person's config changed, a second copy of our hook, our hook back
 * after the person took it out, a hook for an agent that is off or not
 * reached, a write into a read-only or hard-linked file, a removal that does
 * not give the file back, and the Codex approval line said more than once.
 * Fake agent CLIs in a scratch home (tests/helpers/fake-agents.ts); config.json
 * in a scratch PLANNOTATOR_DATA_DIR. No Inbox is started.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INBOX_CODEX_HOOK_HINT } from "@plannotator/core/inbox-types";
import { notesAddedParts } from "../inbox/agents";
import { createFakeAgents, type FakeAgentBin, type FakeAgents } from "../../tests/helpers/fake-agents";
import { autoAddInboxNotes, markAutoNotesSaid, markCodexHookReview, unsaidAutoNotes } from "./inbox-agent-notes";
import { connectInboxAgents, createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import {
  inboxReminderHookCommand,
  inboxReminderHookPath,
  INBOX_REMINDER_HOOK_NAME,
  planInboxReminderHookRemoval,
  readInboxReminderHooks,
  removeRecordedInboxReminderHook,
  syncInboxReminderHooks,
  type InboxReminderHookAgent,
} from "./inbox-reminder-hooks";

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents("plannotator-reminder-hooks-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

const SELF = ["/opt/plannotator/bin/plannotator"];
const environment = (): AgentEnvironment => createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env });
const options = () => ({ dataDir, selfCommand: SELF, environment: environment() });
const sync = () => syncInboxReminderHooks(options());
const where = (agent: InboxReminderHookAgent) => inboxReminderHookPath(agent, environment());
const command = (agent: InboxReminderHookAgent) => inboxReminderHookCommand(SELF, agent, "linux");
const read = (file: string) => readFileSync(file, "utf8");
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
/** Installed here and reaching the Inbox through MCP (its record, as a connecting run writes it). */
function reached(...agents: InboxReminderHookAgent[]): void {
  fake.install(...agents.map((agent): FakeAgentBin => (agent === "kiro" ? "kiro-cli" : agent)));
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  writeFileSync(join(dataDir, "inbox", "agents.json"), JSON.stringify({ v: 1, agents: Object.fromEntries(agents.map((agent) => [agent, { reach: "mcp", state: "added" }])) }));
}
const config = (value: unknown) => writeFileSync(join(dataDir, "config.json"), JSON.stringify(value));

const CODEX_MINE =
  '{\n    "hooks": {\n        "SessionStart": [\n            { "matcher": "startup", "hooks": [ { "type": "command", "command": "my-start.sh" } ] }\n        ],\n        "Stop": [ { "hooks": [ { "type": "command", "command": "my-stop.sh" } ] } ]\n    }\n}\n';
const GEMINI_MINE = '{\n  // my settings\n  "theme": "dark",\n  "hooks": {\n    "BeforeTool": []\n  }\n}\n';

test("Codex: our SessionStart entry is added after the person's, once; every other byte stays; removal gives the file back", () => {
  reached("codex");
  put(where("codex"), CODEX_MINE);
  expect(sync()).toEqual(["codex"]);
  const written = read(where("codex"));
  const parsed = JSON.parse(written) as { hooks: Record<string, unknown[]> };
  expect(parsed.hooks.SessionStart).toEqual([
    { matcher: "startup", hooks: [{ type: "command", command: "my-start.sh" }] },
    // No matcher: every source, `compact` included. Seconds.
    { hooks: [{ type: "command", command: command("codex"), timeout: 10 }] },
  ]);
  expect(parsed.hooks.Stop).toEqual(JSON.parse(CODEX_MINE).hooks.Stop);
  expect(written.startsWith(CODEX_MINE.slice(0, CODEX_MINE.indexOf("}\n        ],") + 1))).toBe(true);
  // Idempotent: nothing more by itself.
  expect(sync()).toEqual([]);
  expect(read(where("codex"))).toBe(written);
  // Plannotator never writes Codex's approval of the hook.
  expect(existsSync(join(dirname(where("codex")), "config.toml"))).toBe(false);
  expect(removeRecordedInboxReminderHook("codex", options())).toBeNull();
  expect(read(where("codex"))).toBe(CODEX_MINE);
  expect(readInboxReminderHooks(dataDir).hooks.codex).toBeUndefined();
});

test("Gemini CLI: comments and the person's keys stay, and an empty file comes back empty, byte for byte", () => {
  reached("gemini");
  put(where("gemini"), GEMINI_MINE);
  expect(sync()).toEqual(["gemini"]);
  const written = read(where("gemini"));
  expect(written).toContain("// my settings");
  const parsed = JSON.parse(written.replace(/\/\/.*$/gm, "")) as { theme: string; hooks: Record<string, unknown> };
  expect(parsed.theme).toBe("dark");
  expect(parsed.hooks.BeforeTool).toEqual([]);
  // Milliseconds, every source.
  expect(parsed.hooks.SessionStart).toEqual([{ matcher: "*", hooks: [{ name: INBOX_REMINDER_HOOK_NAME, type: "command", command: command("gemini"), timeout: 10000 }] }]);
  expect(removeRecordedInboxReminderHook("gemini", options())).toBeNull();
  expect(read(where("gemini"))).toBe(GEMINI_MINE);

  // An empty settings.json: given back empty.
  put(where("gemini"), "");
  expect(sync()).toEqual(["gemini"]);
  expect(JSON.parse(read(where("gemini"))).hooks.SessionStart).toHaveLength(1);
  expect(removeRecordedInboxReminderHook("gemini", options())).toBeNull();
  expect(read(where("gemini"))).toBe("");
});

test("Gemini CLI with no settings.json: created holding ours alone, and deleted with it", () => {
  reached("gemini");
  expect(sync()).toEqual(["gemini"]);
  expect(readInboxReminderHooks(dataDir).hooks.gemini?.created).toBe(true);
  expect(removeRecordedInboxReminderHook("gemini", options())).toBeNull();
  expect(existsSync(where("gemini"))).toBe(false);
});

test("Kiro: a file of our own with SessionStart and PostCompact; one that is not ours is left alone; removal deletes ours", () => {
  reached("kiro");
  expect(sync()).toEqual(["kiro"]);
  const ours = JSON.parse(read(where("kiro"))) as { version: string; hooks: { name: string; trigger: string; action: unknown; timeout: number; enabled: boolean }[] };
  expect(ours.version).toBe("v1");
  expect(ours.hooks.map((hook) => hook.trigger)).toEqual(["SessionStart", "PostCompact"]);
  for (const hook of ours.hooks) expect(hook).toEqual({ name: INBOX_REMINDER_HOOK_NAME, trigger: hook.trigger, action: { type: "command", command: command("kiro") }, timeout: 10, enabled: true });
  expect(sync()).toEqual([]);
  expect(removeRecordedInboxReminderHook("kiro", options())).toBeNull();
  expect(existsSync(where("kiro"))).toBe(false);
  // A file of the person's at our name: never overwritten, the reason kept.
  const theirs = '{"version":"v1","hooks":[{"name":"mine","trigger":"SessionStart","action":{"type":"command","command":"mine.sh"}}]}\n';
  put(where("kiro"), theirs);
  expect(sync()).toEqual([]);
  expect(read(where("kiro"))).toBe(theirs);
  expect(readInboxReminderHooks(dataDir).failures?.kiro).toContain("is not Plannotator's");
});

test("taken out by the person: noted, and never written again by itself", () => {
  reached("codex");
  put(where("codex"), CODEX_MINE);
  expect(sync()).toEqual(["codex"]);
  put(where("codex"), CODEX_MINE);
  expect(sync()).toEqual([]);
  expect(readInboxReminderHooks(dataDir).hooks.codex?.removed_outside_at).toBeString();
  expect(sync()).toEqual([]);
  expect(read(where("codex"))).toBe(CODEX_MINE);
  // A copy already there that Plannotator did not record is the person's: not recorded, so never removed by Settings.
  const fresh = join(fake.root, "data2");
  mkdirSync(join(fresh, "inbox"), { recursive: true });
  writeFileSync(join(fresh, "inbox", "agents.json"), read(join(dataDir, "inbox", "agents.json")));
  const theirs = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: command("codex") }] }] } });
  put(where("codex"), theirs);
  expect(syncInboxReminderHooks({ ...options(), dataDir: fresh })).toEqual([]);
  expect(readInboxReminderHooks(fresh).hooks.codex).toBeUndefined();
  expect(read(where("codex"))).toBe(theirs);
});

test("only for an agent installed here, reaching the Inbox, with its reminder on", () => {
  // Reached by its record, but not installed.
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  writeFileSync(join(dataDir, "inbox", "agents.json"), JSON.stringify({ v: 1, agents: { gemini: { reach: "mcp", state: "added" } } }));
  expect(sync()).toEqual([]);
  // Installed, but not reaching the Inbox.
  fake.install("codex");
  expect(sync()).toEqual([]);
  expect(existsSync(where("codex"))).toBe(false);
  // Reached, but its reminder is off.
  reached("codex", "gemini");
  config({ inboxReminder: { codex: false } });
  expect(sync()).toEqual(["gemini"]);
  expect(existsSync(where("codex"))).toBe(false);
});

test("a read-only or hard-linked file is never written; an entry shared with the person's own hook is never cut", () => {
  reached("codex", "gemini");
  put(where("codex"), CODEX_MINE);
  chmodSync(where("codex"), 0o444);
  put(where("gemini"), GEMINI_MINE);
  linkSync(where("gemini"), join(fake.root, "gemini-link.json"));
  expect(sync()).toEqual([]);
  expect(read(where("codex"))).toBe(CODEX_MINE);
  expect(read(where("gemini"))).toBe(GEMINI_MINE);
  const failures = readInboxReminderHooks(dataDir).failures ?? {};
  expect(failures.codex).toContain("read-only");
  expect(failures.gemini).toContain("hard links");

  chmodSync(where("codex"), 0o644);
  expect(sync()).toEqual(["codex"]);
  expect(readInboxReminderHooks(dataDir).failures?.codex).toBeUndefined();
  // The person put their own hook into our entry: it stays, and so does ours, with the reason.
  const parsed = JSON.parse(read(where("codex"))) as { hooks: { SessionStart: { hooks: unknown[] }[] } };
  parsed.hooks.SessionStart[1]!.hooks.push({ type: "command", command: "also-mine.sh" });
  const shared = JSON.stringify(parsed, null, 2);
  put(where("codex"), shared);
  expect(removeRecordedInboxReminderHook("codex", options())).toContain("another hook beside Plannotator's");
  expect(read(where("codex"))).toBe(shared);
});

test("plannotator uninstall: lists each of ours, recorded or found where it goes, and takes it out", () => {
  reached("codex", "gemini", "kiro");
  put(where("codex"), CODEX_MINE);
  expect(sync()).toEqual(["gemini", "kiro", "codex"]);
  const items = planInboxReminderHookRemoval(dataDir, environment());
  expect(items.map((item) => item.agent)).toEqual(["gemini", "kiro", "codex"]);
  for (const item of items) expect(item.apply()).toBeNull();
  expect(read(where("codex"))).toBe(CODEX_MINE);
  expect(existsSync(where("gemini"))).toBe(false);
  expect(existsSync(where("kiro"))).toBe(false);
  expect(readInboxReminderHooks(dataDir).hooks).toEqual({});
  expect(planInboxReminderHookRemoval(dataDir, environment())).toEqual([]);
});

test("the Codex approval line: said with the Codex note's line, once; never for another agent", async () => {
  fake.install("codex", "gemini");
  await connectInboxAgents({ ...options(), agentTimeoutMs: 10_000, totalTimeoutMs: 20_000 });
  await autoAddInboxNotes(options());
  const added = sync();
  expect(added).toContain("codex");
  expect(markCodexHookReview()).toBe(true);
  expect(notesAddedParts(unsaidAutoNotes()).hint).toBe(INBOX_CODEX_HOOK_HINT);
  // Said: never again.
  markAutoNotesSaid();
  expect(markCodexHookReview()).toBe(false);
  expect(unsaidAutoNotes()).toEqual([]);
  expect(notesAddedParts([{ agent: "gemini", path: "~/.gemini/GEMINI.md" }]).hint).toBeNull();
  expect(notesAddedParts([{ agent: "codex", path: "~/.codex/AGENTS.md" }]).hint).toBeNull();
});
