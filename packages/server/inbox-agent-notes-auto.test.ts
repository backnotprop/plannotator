import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { addInboxNote, autoAddInboxNotes, INBOX_NOTE_BLOCK, INBOX_NOTE_START, markAutoNotesSaid, markNotesAsked, removeInboxNote, unsaidAutoNotes } from "./inbox-agent-notes";
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
  expect(loadConfig().inboxAgentNotes?.asked).toEqual(["claude-code", "codex", "gemini"]);
  expect(unsaidAutoNotes()).toEqual(added);
  expect(await autoAddInboxNotes(options())).toEqual([]);
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
  mkdirSync(file(".codex"), { recursive: true });
  const damaged = "<!-- plannotator-inbox:start v8 -->\n<!-- plannotator-inbox:start v8 -->\n";
  writeFileSync(file(".codex", "AGENTS.md"), damaged);
  expect(await autoAddInboxNotes(options())).toEqual([]);
  expect(read(file(".codex", "AGENTS.md"))).toBe(damaged);
  expect(loadConfig().inboxAgentNotes?.asked ?? []).toEqual([]);
});

test("a read-only file (no owner write bit) is left alone, its mode too, and never tried again by itself", async () => {
  fake.install("codex");
  await connect();
  const path = file(".codex", "AGENTS.md");
  writeFileSync(path, "Mine.\n");
  chmodSync(path, 0o444);
  try {
    expect(await autoAddInboxNotes(options())).toEqual([]);
    expect(read(path)).toBe("Mine.\n");
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(loadConfig().inboxAgentNotes?.asked).toEqual(["codex"]);
    chmodSync(path, 0o644);
    expect(await autoAddInboxNotes(options())).toEqual([]);
    expect(read(path)).toBe("Mine.\n");
  } finally {
    chmodSync(path, 0o644);
  }
});

test("a file with other hard links (a dotfiles copy) is left alone: the link kept, both copies as they were", async () => {
  fake.install("gemini");
  await connect();
  const path = file(".gemini", "GEMINI.md");
  mkdirSync(file("dotfiles"), { recursive: true });
  writeFileSync(path, "# Mine\n");
  linkSync(path, file("dotfiles", "GEMINI.md"));
  expect(await autoAddInboxNotes(options())).toEqual([]);
  expect(statSync(path).nlink).toBe(2);
  expect(statSync(path).ino).toBe(statSync(file("dotfiles", "GEMINI.md")).ino);
  expect(read(file("dotfiles", "GEMINI.md"))).toBe("# Mine\n");
  expect(loadConfig().inboxAgentNotes?.asked).toEqual(["gemini"]);
});

test("the note already pasted by hand without markers is not added a second time", async () => {
  fake.install("codex");
  await connect();
  const path = file(".codex", "AGENTS.md");
  const pasted = "# Mine\n\n## Plannotator Inbox\n\nThe person keeps a Plannotator Inbox on this computer.\n";
  writeFileSync(path, pasted);
  expect(await autoAddInboxNotes(options())).toEqual([]);
  expect(read(path)).toBe(pasted);
  expect(loadConfig().inboxAgentNotes?.asked).toEqual(["codex"]);
});

test("a file changed between the read and the write (a memory Gemini saved): not clobbered, left unasked, written next time with the change kept", async () => {
  fake.install("gemini");
  await connect();
  const path = file(".gemini", "GEMINI.md");
  writeFileSync(path, "# Mine\n\n## Gemini Added Memories\n- Likes tea.\n");
  const change = addInboxNote("gemini", dataDir, environment(), new Date(), { auto: true, beforeWrite: (target) => appendFileSync(target, "- Saved meanwhile.\n") });
  expect(change).toMatchObject({ ok: false });
  expect((change as { skipped?: true }).skipped).toBeUndefined();
  expect(read(path)).toBe("# Mine\n\n## Gemini Added Memories\n- Likes tea.\n- Saved meanwhile.\n");
  expect(await autoAddInboxNotes(options())).toEqual([{ agent: "gemini", path: "~/.gemini/GEMINI.md" }]);
  expect(read(path)).toBe(`# Mine\n\n${INBOX_NOTE_BLOCK}\n\n## Gemini Added Memories\n- Likes tea.\n- Saved meanwhile.\n`);
  expect(read(path)).toContain(INBOX_NOTE_START);
});

test("a file created between the read and the write is not replaced", async () => {
  fake.install("gemini");
  await connect();
  const path = file(".gemini", "GEMINI.md");
  const change = addInboxNote("gemini", dataDir, environment(), new Date(), { auto: true, beforeWrite: (target) => writeFileSync(target, "Theirs.\n") });
  expect(change).toMatchObject({ ok: false });
  expect(read(path)).toBe("Theirs.\n");
});

test("the window marks said only the notes its line showed: one written after its read is said next time", async () => {
  fake.install("codex");
  await connect();
  const [codex] = await autoAddInboxNotes(options());
  fake.install("codex", "gemini");
  await connect();
  await autoAddInboxNotes(options());
  markAutoNotesSaid([codex!]);
  expect(unsaidAutoNotes()).toEqual([{ agent: "gemini", path: "~/.gemini/GEMINI.md" }]);
});
