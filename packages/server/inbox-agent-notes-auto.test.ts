/**
 * The note written by itself (autoAddInboxNotes in inbox-agent-notes.ts;
 * approval "inbox-agent-note-auto", which superseded the one-time dialog):
 * for every connected agent proven to load it, once per agent; never for Qwen
 * Code (offered) or Cursor (copied by hand); never for an agent already asked
 * (an old dialog's Not now, a 0.28.18 config), one turned off, or with
 * PLANNOTATOR_INBOX_NOTES=0; and what the window's line says. Fake agent CLIs
 * in a scratch home (tests/helpers/fake-agents.ts); config.json lives in a
 * scratch PLANNOTATOR_DATA_DIR. No Inbox is started.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { autoAddInboxNotes, INBOX_NOTE_BLOCK, markAutoNotesSaid, markNotesAsked, removeInboxNote, unsaidAutoNotes } from "./inbox-agent-notes";
import { connectInboxAgents, createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents("plannotator-notes-auto-");
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
const environment = (extra: Record<string, string> = {}): AgentEnvironment => createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...extra } });
const options = (extra: Record<string, string> = {}) => ({ dataDir, selfCommand: SELF, environment: environment(extra) });
const connect = (extra: Record<string, string> = {}) => connectInboxAgents({ ...options(extra), agentTimeoutMs: 10_000, totalTimeoutMs: 20_000 });
const file = (...parts: string[]) => join(fake.home, ...parts);
const read = (path: string) => readFileSync(path, "utf8");
function claudePlugin(): void {
  mkdirSync(file(".claude"), { recursive: true });
  writeFileSync(file(".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "plannotator@plannotator": true } }));
}

test("a new person: every connected agent proven to load the note gets it, once; the window has one line to say", async () => {
  fake.install("codex", "gemini");
  claudePlugin();
  mkdirSync(file(".codex"), { recursive: true });
  writeFileSync(file(".codex", "AGENTS.md"), "Mine.\n");
  await connect();
  const added = await autoAddInboxNotes(options());
  expect(added).toEqual([
    { agent: "claude-code", path: "~/.claude/rules/plannotator-inbox.md" },
    { agent: "codex", path: "~/.codex/AGENTS.md" },
    { agent: "gemini", path: "~/.gemini/GEMINI.md" },
  ]);
  expect(read(file(".claude", "rules", "plannotator-inbox.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
  expect(read(file(".codex", "AGENTS.md"))).toBe(`Mine.\n\n${INBOX_NOTE_BLOCK}\n`);
  expect(read(file(".gemini", "GEMINI.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
  // Each one is answered: never written again by itself.
  expect(loadConfig().inboxAgentNotes?.asked).toEqual(["claude-code", "codex", "gemini"]);
  expect(unsaidAutoNotes()).toEqual(added);
  expect(await autoAddInboxNotes(options())).toEqual([]);
  // Said: the line is gone, the record of who was asked stays.
  markAutoNotesSaid();
  expect(unsaidAutoNotes()).toEqual([]);
  expect(loadConfig().inboxAgentNotes?.asked).toEqual(["claude-code", "codex", "gemini"]);
});

test("an agent that connects later gets its note then, and the line lists it with the ones not said yet", async () => {
  fake.install("codex");
  await connect();
  expect(await autoAddInboxNotes(options())).toEqual([{ agent: "codex", path: "~/.codex/AGENTS.md" }]);
  fake.install("codex", "gemini");
  await connect();
  expect(await autoAddInboxNotes(options())).toEqual([{ agent: "gemini", path: "~/.gemini/GEMINI.md" }]);
  expect(unsaidAutoNotes().map((note) => note.agent)).toEqual(["codex", "gemini"]);
});

test("Qwen Code (not proven) and Cursor (copied by hand) are never written by themselves", async () => {
  fake.install("qwen", "cursor-agent");
  await connect();
  expect(await autoAddInboxNotes(options())).toEqual([]);
  expect(existsSync(file(".qwen", "QWEN.md"))).toBe(false);
  // Still not asked: the window's question offers them.
  expect(loadConfig().inboxAgentNotes?.asked ?? []).toEqual([]);
});

test("an agent not connected to the Inbox gets nothing, even when found", async () => {
  mkdirSync(file(".gemini"), { recursive: true });
  expect(await autoAddInboxNotes(options())).toEqual([]);
  expect(existsSync(file(".gemini", "GEMINI.md"))).toBe(false);
});

test("someone who answered the old dialog with Not now or Don't add a note keeps their answer; another agent is still written", async () => {
  fake.install("codex", "gemini");
  await connect();
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxAgentNotes: { offered: true, asked: ["codex"] } }));
  expect(await autoAddInboxNotes(options())).toEqual([{ agent: "gemini", path: "~/.gemini/GEMINI.md" }]);
  expect(existsSync(file(".codex", "AGENTS.md"))).toBe(false);
});

test("a config from 0.28.18 (asked once, about every agent then, no list): those agents count as answered", async () => {
  fake.install("codex");
  await connect();
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxAgentNotes: { offered: true } }));
  expect(await autoAddInboxNotes(options())).toEqual([]);
  expect(existsSync(file(".codex", "AGENTS.md"))).toBe(false);
});

test("a note turned off in Settings → Agents, or removed by hand, stays off", async () => {
  fake.install("codex");
  await connect();
  await autoAddInboxNotes(options());
  // Settings' switch off: removes it and records the agent as answered (inbox.ts saveAgent).
  expect(removeInboxNote("codex", dataDir, environment())).toMatchObject({ ok: true, action: "deleted" });
  await markNotesAsked(["codex"], options());
  expect(await autoAddInboxNotes(options())).toEqual([]);
  expect(existsSync(file(".codex", "AGENTS.md"))).toBe(false);
});

test("PLANNOTATOR_INBOX_NOTES=0: nothing is written and nobody is marked asked", async () => {
  fake.install("codex");
  claudePlugin();
  await connect();
  expect(await autoAddInboxNotes(options({ PLANNOTATOR_INBOX_NOTES: "0" }))).toEqual([]);
  expect(existsSync(file(".codex", "AGENTS.md"))).toBe(false);
  expect(existsSync(file(".claude", "rules", "plannotator-inbox.md"))).toBe(false);
  expect(loadConfig().inboxAgentNotes).toBeUndefined();
});

test("a note that cannot be written is left unasked (tried again next time) and not said", async () => {
  fake.install("codex");
  await connect();
  // A damaged section: two start markers.
  mkdirSync(file(".codex"), { recursive: true });
  const damaged = "<!-- plannotator-inbox:start v8 -->\n<!-- plannotator-inbox:start v8 -->\n";
  writeFileSync(file(".codex", "AGENTS.md"), damaged);
  expect(await autoAddInboxNotes(options())).toEqual([]);
  expect(read(file(".codex", "AGENTS.md"))).toBe(damaged);
  expect(loadConfig().inboxAgentNotes?.asked ?? []).toEqual([]);
});
