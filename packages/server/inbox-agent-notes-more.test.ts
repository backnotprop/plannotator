/**
 * The Inbox note for the agents whose docs verify a global rules file they
 * load by themselves (the owner, 2026-11-17: "Just add it, with the quiet
 * line"): Kiro, Windsurf / Devin, Amp, Cline (offered), Antigravity (Gemini
 * CLI's block), DeepSeek Harness, Qwen Code's own rules file, Cursor's local
 * plugin, OpenCode 2. Each tool's file and format as its docs give it; the
 * guarantees every note has (only for a found, connected agent; never a file
 * the automatic add would leave alone; markers; removal byte for byte, own
 * files deleted whole; uninstall; asked once). Fake agent CLIs in a scratch
 * home (tests/helpers/fake-agents.ts), config.json in a scratch
 * PLANNOTATOR_DATA_DIR. No Inbox is started, no real agent runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_AGENT_LABELS } from "@plannotator/core/inbox-types";
import { loadConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  addInboxNote,
  autoAddInboxNotes,
  INBOX_NOTE_BLOCK,
  inboxNoteBlockWith,
  noteCopiedByHand,
  noteStatus,
  noteTarget,
  planInboxNoteRemoval,
  readInboxAgentNotes,
  refreshInboxNotes,
  removeInboxNote,
  unsaidAutoNotes,
} from "./inbox-agent-notes";
import { connectInboxAgents, createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents("plannotator-notes-more-");
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
const env = (extra: Record<string, string> = {}): AgentEnvironment => createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...extra } });
const options = (extra: Record<string, string> = {}) => ({ dataDir, selfCommand: SELF, environment: env(extra) });
const connect = (extra: Record<string, string> = {}) => connectInboxAgents({ ...options(extra), agentTimeoutMs: 10_000, totalTimeoutMs: 20_000 });
const file = (...parts: string[]) => join(fake.home, ...parts);
const read = (path: string) => readFileSync(path, "utf8");
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

/** Kiro, Cursor's editor and Antigravity are found by their folders (their MCP file is plain JSON the connect writes). */
function editorsFound(): void {
  mkdirSync(file(".kiro"), { recursive: true });
  mkdirSync(file(".config", "Cursor"), { recursive: true });
  mkdirSync(file(".cursor"), { recursive: true });
  mkdirSync(file(".gemini", "antigravity"), { recursive: true });
}
/** DeepSeek Harness with Plannotator's plugin in a profile (its only way to the Inbox). */
function dshPlugin(): void {
  write(file(".dsh", "profiles", "main", "package.json"), JSON.stringify({ dependencies: { "@plannotator/dsh": "^1.0.0" } }));
}

const KIRO = "---\ninclusion: always\n---\n";
const DEVIN = "---\ntrigger: always_on\n---\n";
const CURSOR = "---\nalwaysApply: true\n---\n";
const PLUGIN = join(".cursor", "plugins", "local", "plannotator-inbox");

describe("written by itself, each in its tool's own file and format", () => {
  test("a new person: every connected agent gets it once, the line names each, and nothing is asked again", async () => {
    fake.install("gemini", "devin", "amp", "kiro-cli");
    editorsFound();
    dshPlugin();
    await connect();
    const added = await autoAddInboxNotes(options());
    expect(added).toEqual([
      { agent: "gemini", path: "~/.gemini/GEMINI.md" },
      { agent: "cursor", path: `~/${PLUGIN}/rules/plannotator-inbox.mdc` },
      { agent: "kiro", path: "~/.kiro/steering/plannotator-inbox.md" },
      { agent: "windsurf", path: "~/.devin/rules/plannotator-inbox.md" },
      { agent: "amp", path: "~/.config/amp/AGENTS.md" },
      { agent: "antigravity", path: "~/.gemini/GEMINI.md" },
      { agent: "dsh", path: "~/.dsh/AGENTS.md" },
    ]);
    // Front matter first, as each tool reads it (Kiro: "no blank lines or content before it").
    expect(read(file(".kiro", "steering", "plannotator-inbox.md"))).toBe(`${KIRO}${INBOX_NOTE_BLOCK}\n`);
    expect(read(file(".devin", "rules", "plannotator-inbox.md"))).toBe(`${DEVIN}${INBOX_NOTE_BLOCK}\n`);
    expect(read(file(PLUGIN, "rules", "plannotator-inbox.mdc"))).toBe(`${CURSOR}${INBOX_NOTE_BLOCK}\n`);
    expect(JSON.parse(read(file(PLUGIN, ".cursor-plugin", "plugin.json")))).toEqual({ name: "plannotator-inbox" });
    expect(read(file(".config", "amp", "AGENTS.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
    expect(read(file(".dsh", "AGENTS.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
    // Gemini CLI and Antigravity read one file: one block, recorded for both.
    expect(read(file(".gemini", "GEMINI.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
    const records = readInboxAgentNotes(dataDir).notes;
    expect(records.antigravity?.path).toBe(records.gemini?.path);
    expect(unsaidAutoNotes()).toEqual(added);
    expect(loadConfig().inboxAgentNotes?.asked).toEqual(["gemini", "cursor", "kiro", "windsurf", "amp", "antigravity", "dsh"]);
    expect(await autoAddInboxNotes(options())).toEqual([]);
  });

  test("only for a found agent that reaches the Inbox: a folder alone, or an agent not connected, gets nothing", async () => {
    editorsFound();
    // Found, but nothing connected yet (no MCP entry, no plugin).
    expect(await autoAddInboxNotes(options())).toEqual([]);
    expect(existsSync(file(".kiro", "steering"))).toBe(false);
    expect(existsSync(file(".cursor", "plugins"))).toBe(false);
    expect(existsSync(file(".gemini", "GEMINI.md"))).toBe(false);
    // DeepSeek Harness without Plannotator's plugin does not reach the Inbox.
    mkdirSync(file(".dsh", "profiles"), { recursive: true });
    expect(await autoAddInboxNotes(options())).toEqual([]);
    expect(existsSync(file(".dsh", "AGENTS.md"))).toBe(false);
  });

  test("Cline (offered by the window's question: whether a new rule starts switched on is not documented): its own file on the person's yes", () => {
    // No front matter: "Rules without front matter are always active". CLINE_DIR replaces ~/.cline.
    const e = env();
    expect(noteTarget("cline", e)).toEqual({ path: file(".cline", "rules", "plannotator-inbox.md"), create: true, reason: null });
    const moved = env({ CLINE_DIR: join(fake.root, "cline-home") });
    expect(noteTarget("cline", moved).path).toBe(join(fake.root, "cline-home", "rules", "plannotator-inbox.md"));
    expect(addInboxNote("cline", dataDir, e)).toMatchObject({ ok: true, action: "created" });
    expect(read(file(".cline", "rules", "plannotator-inbox.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
    expect(removeInboxNote("cline", dataDir, e)).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(file(".cline", "rules", "plannotator-inbox.md"))).toBe(false);
  });

  test("never a file the automatic add would leave alone: read-only, hard-linked, the note pasted by hand", async () => {
    fake.install("amp");
    dshPlugin();
    await connect();
    write(file(".config", "amp", "AGENTS.md"), "Mine.\n");
    chmodSync(file(".config", "amp", "AGENTS.md"), 0o444);
    write(file(".dsh", "AGENTS.md"), "Mine.\n\n## Plannotator Inbox\n\nPasted.\n");
    expect(await autoAddInboxNotes(options())).toEqual([]);
    chmodSync(file(".config", "amp", "AGENTS.md"), 0o644);
    expect(read(file(".config", "amp", "AGENTS.md"))).toBe("Mine.\n");
    expect(read(file(".dsh", "AGENTS.md"))).toBe("Mine.\n\n## Plannotator Inbox\n\nPasted.\n");
    // Left alone on purpose: answered, never tried again by itself.
    expect(loadConfig().inboxAgentNotes?.asked).toEqual(["amp", "dsh"]);
  });

  test("a hard-linked AGENTS.md (a dotfiles copy) is left alone", async () => {
    dshPlugin();
    await connect();
    write(join(fake.root, "dotfiles-AGENTS.md"), "Mine.\n");
    mkdirSync(file(".dsh"), { recursive: true });
    linkSync(join(fake.root, "dotfiles-AGENTS.md"), file(".dsh", "AGENTS.md"));
    expect(await autoAddInboxNotes(options())).toEqual([]);
    expect(read(join(fake.root, "dotfiles-AGENTS.md"))).toBe("Mine.\n");
  });
});

describe("Cursor: a local plugin Plannotator owns where its editor is found, else copied by hand", () => {
  test("the editor found: the plugin (manifest and an alwaysApply rule), added, refreshed and removed whole", () => {
    mkdirSync(file(".config", "Cursor"), { recursive: true });
    const e = env();
    expect(noteCopiedByHand("cursor", e)).toBe(false);
    expect(noteTarget("cursor", e)).toEqual({ path: file(PLUGIN, "rules", "plannotator-inbox.mdc"), create: true, reason: null });
    expect(addInboxNote("cursor", dataDir, e, undefined, { config: {} })).toMatchObject({ ok: true, action: "created" });
    expect(noteStatus("cursor", dataDir, e, {})).toMatchObject({ state: "added", created: true });
    // The person's rules reach it as they change, the front matter kept.
    const rules = { prompts: { inbox: { rules: "Ask me before you delete any file." } } };
    expect(refreshInboxNotes(dataDir, e, { config: rules }).map((r) => [r.agent, r.result])).toEqual([["cursor", "refreshed"]]);
    expect(read(file(PLUGIN, "rules", "plannotator-inbox.mdc"))).toBe(`${CURSOR}${inboxNoteBlockWith("Ask me before you delete any file.")}\n`);
    // Off: the rule, the manifest and the plugin's folders go; ~/.cursor/plugins/local is the person's.
    expect(removeInboxNote("cursor", dataDir, e)).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(file(PLUGIN))).toBe(false);
    expect(existsSync(file(".cursor", "plugins", "local"))).toBe(true);
  });

  test("a manifest the person changed, or their own file in the plugin's folder, stays", () => {
    mkdirSync(file(".config", "Cursor"), { recursive: true });
    const e = env();
    write(file(PLUGIN, ".cursor-plugin", "plugin.json"), '{ "name": "plannotator-inbox", "description": "mine" }\n');
    write(file(PLUGIN, "README.md"), "Mine.\n");
    addInboxNote("cursor", dataDir, e, undefined, { config: {} });
    expect(read(file(PLUGIN, ".cursor-plugin", "plugin.json"))).toBe('{ "name": "plannotator-inbox", "description": "mine" }\n');
    removeInboxNote("cursor", dataDir, e);
    expect(existsSync(file(PLUGIN, "rules"))).toBe(false);
    expect(read(file(PLUGIN, ".cursor-plugin", "plugin.json"))).toBe('{ "name": "plannotator-inbox", "description": "mine" }\n');
    expect(readdirSync(file(PLUGIN)).sort()).toEqual([".cursor-plugin", "README.md"]);
  });

  test("no editor (the CLI alone, which loads a local plugin only when told to): copied by hand, nothing written", () => {
    mkdirSync(file(".cursor"), { recursive: true });
    const e = env();
    expect(noteCopiedByHand("cursor", e)).toBe(true);
    expect(noteStatus("cursor", dataDir, e).state).toBe("manual");
    expect(addInboxNote("cursor", dataDir, e).ok).toBe(false);
    expect(existsSync(file(".cursor", "plugins"))).toBe(false);
  });

  test("uninstall removes the plugin whole, with the record gone", () => {
    mkdirSync(file(".config", "Cursor"), { recursive: true });
    const e = env();
    addInboxNote("cursor", dataDir, e, undefined, { config: {} });
    writeFileSync(join(dataDir, "inbox", "agent-notes.json"), JSON.stringify({ v: 1, notes: {} }));
    const plan = planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS, {});
    expect(plan.items.map((item) => item.describe)).toEqual([`Note for Cursor (~/${PLUGIN}/rules/plannotator-inbox.mdc, created by Plannotator: file removed if empty)`]);
    for (const item of plan.items) expect(item.apply()).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(file(PLUGIN))).toBe(false);
  });
});

describe("own files with front matter: created and deleted whole", () => {
  for (const [agent, path, header] of [
    ["kiro", [".kiro", "steering", "plannotator-inbox.md"], KIRO],
    ["windsurf", [".devin", "rules", "plannotator-inbox.md"], DEVIN],
  ] as const) {
    test(`${agent}: the front matter and the note; Off deletes the file; a file the person had there keeps their text`, () => {
      const e = env();
      const at = file(...path);
      expect(addInboxNote(agent, dataDir, e, undefined, { config: {} })).toMatchObject({ ok: true, action: "created" });
      expect(read(at)).toBe(`${header}${INBOX_NOTE_BLOCK}\n`);
      expect(addInboxNote(agent, dataDir, e, undefined, { config: {} })).toMatchObject({ ok: true, action: "unchanged" });
      expect(removeInboxNote(agent, dataDir, e)).toMatchObject({ ok: true, action: "deleted" });
      expect(existsSync(at)).toBe(false);
      // CRLF front matter left after the note goes: still only the front matter, so the file goes.
      write(at, `${header.replace(/\n/g, "\r\n")}${INBOX_NOTE_BLOCK.replace(/\n/g, "\r\n")}\r\n`);
      expect(removeInboxNote(agent, dataDir, e)).toMatchObject({ ok: true, action: "deleted" });
      // A file by that name with the person's own text: the note is appended, and removal gives it back byte for byte.
      write(at, `${header}Mine.\n`);
      expect(addInboxNote(agent, dataDir, e, undefined, { config: {} })).toMatchObject({ ok: true, action: "added" });
      expect(removeInboxNote(agent, dataDir, e)).toMatchObject({ ok: true, action: "removed" });
      expect(read(at)).toBe(`${header}Mine.\n`);
    });
  }
});

describe("Gemini CLI and Antigravity: one block in ~/.gemini/GEMINI.md", () => {
  test("recorded for both; turning one off keeps it for the other; both off removes it byte for byte", () => {
    const e = env();
    write(file(".gemini", "GEMINI.md"), "Mine.\n");
    expect(noteTarget("antigravity", e).path).toBe(file(".gemini", "GEMINI.md"));
    expect(addInboxNote("gemini", dataDir, e, undefined, { config: {} })).toMatchObject({ ok: true, action: "added" });
    expect(addInboxNote("antigravity", dataDir, e, undefined, { config: {} })).toMatchObject({ ok: true, action: "shared" });
    expect(read(file(".gemini", "GEMINI.md"))).toBe(`Mine.\n\n${INBOX_NOTE_BLOCK}\n`);
    expect(removeInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "kept-shared" });
    expect(read(file(".gemini", "GEMINI.md"))).toBe(`Mine.\n\n${INBOX_NOTE_BLOCK}\n`);
    expect(removeInboxNote("antigravity", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
    expect(read(file(".gemini", "GEMINI.md"))).toBe("Mine.\n");
  });

  test("Gemini's file named AGENTS.md (Antigravity reads that too): the same file; Gemini moved elsewhere: Antigravity's own GEMINI.md", () => {
    write(file(".gemini", "settings.json"), '{ "context": { "fileName": "AGENTS.md" } }');
    expect(noteTarget("antigravity", env()).path).toBe(file(".gemini", "AGENTS.md"));
    const moved = env({ GEMINI_CLI_HOME: join(fake.root, "gemini-home") });
    expect(noteTarget("gemini", moved).path).toBe(join(fake.root, "gemini-home", ".gemini", "GEMINI.md"));
    expect(noteTarget("antigravity", moved).path).toBe(file(".gemini", "GEMINI.md"));
  });

  test("the person said no to Gemini CLI's note: Antigravity's is not written by itself into the same file", async () => {
    fake.install("gemini");
    mkdirSync(file(".gemini", "antigravity"), { recursive: true });
    await connect();
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxAgentNotes: { offered: true, asked: ["gemini"] } }));
    expect(await autoAddInboxNotes(options())).toEqual([]);
    expect(existsSync(file(".gemini", "GEMINI.md"))).toBe(false);
    // Settings → Agents still adds it on the person's yes.
    expect(addInboxNote("antigravity", dataDir, env())).toMatchObject({ ok: true, action: "created" });
  });
});

describe("Amp and OpenCode: created only where that hides nothing", () => {
  test("Amp: ~/.config/amp/AGENTS.md, appended and removed byte for byte; not created beside an AGENT.md or CLAUDE.md", () => {
    const e = env();
    expect(noteTarget("amp", e)).toEqual({ path: file(".config", "amp", "AGENTS.md"), create: true, reason: null });
    for (const name of ["AGENT.md", "CLAUDE.md"]) {
      write(file(".config", "amp", name), "Mine.\n");
      const status = noteStatus("amp", dataDir, e);
      expect(status.state).toBe("unavailable");
      expect(addInboxNote("amp", dataDir, e).ok).toBe(false);
      expect(existsSync(file(".config", "amp", "AGENTS.md"))).toBe(false);
      rmSync(file(".config", "amp", name));
    }
  });

  test("OpenCode 2 (no CLAUDE.md fallback): AGENTS.md created only with no sign of OpenCode 1 and no ~/.claude/CLAUDE.md", () => {
    const agents = file(".config", "opencode", "AGENTS.md");
    const config = (value: unknown) => write(file(".config", "opencode", "opencode.json"), JSON.stringify(value));
    const creates = () => noteTarget("opencode", env()).create;
    // V2 only, by its config key: created, and removed whole.
    config({ plugins: [] });
    expect(noteTarget("opencode", env())).toEqual({ path: agents, create: true, reason: null });
    expect(addInboxNote("opencode", dataDir, env(), undefined, { config: {} })).toMatchObject({ ok: true, action: "created" });
    expect(removeInboxNote("opencode", dataDir, env())).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(agents)).toBe(false);
    // Both versions in one config (V1's `plugin` beside V2's `plugins`): creating it would hide CLAUDE.md from V1.
    config({ plugins: [], plugin: [] });
    expect(creates()).toBe(false);
    expect(addInboxNote("opencode", dataDir, env()).ok).toBe(false);
    expect(existsSync(agents)).toBe(false);
    // V1 only.
    config({ plugin: [] });
    expect(creates()).toBe(false);
    expect(noteStatus("opencode", dataDir, env()).state).toBe("unavailable");
    // V2 only by `opencode2` on PATH; with V1's `opencode` there too, not.
    rmSync(file(".config", "opencode", "opencode.json"));
    writeFileSync(join(fake.bin, "opencode2"), "#!/bin/sh\n");
    chmodSync(join(fake.bin, "opencode2"), 0o755);
    expect(creates()).toBe(true);
    fake.install("opencode");
    expect(creates()).toBe(false);
    rmSync(join(fake.bin, "opencode"));
    // V2 only, but the person has a ~/.claude/CLAUDE.md (or one in CLAUDE_CONFIG_DIR): not created.
    write(file(".claude", "CLAUDE.md"), "Mine.\n");
    expect(creates()).toBe(false);
    rmSync(file(".claude", "CLAUDE.md"));
    write(join(fake.root, "claude-config", "CLAUDE.md"), "Mine.\n");
    expect(noteTarget("opencode", env({ CLAUDE_CONFIG_DIR: join(fake.root, "claude-config") })).create).toBe(false);
    expect(creates()).toBe(true);
    // An AGENTS.md the person already has gets the note with either version.
    config({ plugins: [], plugin: [] });
    write(agents, "Mine.\n");
    expect(addInboxNote("opencode", dataDir, env(), undefined, { config: {} })).toMatchObject({ ok: true, action: "added" });
    expect(removeInboxNote("opencode", dataDir, env())).toMatchObject({ ok: true, action: "removed" });
    expect(read(agents)).toBe("Mine.\n");
  });

  test("Amp under XDG_CONFIG_HOME: the folder Amp's settings.json is read from", () => {
    const xdg = join(fake.root, "xdg");
    const e = env({ XDG_CONFIG_HOME: xdg });
    expect(noteTarget("amp", e).path).toBe(join(xdg, "amp", "AGENTS.md"));
    expect(addInboxNote("amp", dataDir, e, undefined, { config: {} })).toMatchObject({ ok: true, action: "created" });
    expect(read(join(xdg, "amp", "AGENTS.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
    expect(existsSync(file(".config", "amp", "AGENTS.md"))).toBe(false);
  });
});

describe("never twice, never half written, never a rule that may not load", () => {
  test("Qwen Code: the note pasted by hand into QWEN.md without markers is the note; no rules file is made by itself", async () => {
    fake.install("qwen");
    await connect();
    write(file(".qwen", "QWEN.md"), "Mine.\n\n## Plannotator Inbox\n\nPasted.\n");
    expect(await autoAddInboxNotes(options())).toEqual([]);
    expect(existsSync(file(".qwen", "rules", "plannotator-inbox.md"))).toBe(false);
    expect(read(file(".qwen", "QWEN.md"))).toBe("Mine.\n\n## Plannotator Inbox\n\nPasted.\n");
    expect(loadConfig().inboxAgentNotes?.asked).toEqual(["qwen"]);
  });

  test("Cursor: the rule file is written before the manifest, and a failed write leaves neither", () => {
    mkdirSync(file(".config", "Cursor"), { recursive: true });
    const e = env();
    // The rule file can't be written (a file where its folder goes): no manifest is made.
    write(file(PLUGIN, "rules"), "Mine.\n");
    expect(addInboxNote("cursor", dataDir, e, undefined, { config: {} }).ok).toBe(false);
    expect(existsSync(file(PLUGIN, ".cursor-plugin"))).toBe(false);
    rmSync(file(PLUGIN, "rules"));
    // The manifest can't be written: the rule file just made goes again, with its folder; no record.
    write(file(PLUGIN, ".cursor-plugin"), "Mine.\n");
    expect(addInboxNote("cursor", dataDir, e, undefined, { config: {} }).ok).toBe(false);
    expect(readdirSync(file(PLUGIN))).toEqual([".cursor-plugin"]);
    expect(readInboxAgentNotes(dataDir).notes.cursor).toBeUndefined();
  });

  test("Cursor: the switch still turns the note off once the editor is no longer found", () => {
    mkdirSync(file(".config", "Cursor"), { recursive: true });
    expect(addInboxNote("cursor", dataDir, env(), undefined, { config: {} })).toMatchObject({ ok: true, action: "created" });
    rmSync(file(".config", "Cursor"), { recursive: true });
    const e = env();
    expect(noteCopiedByHand("cursor", e)).toBe(false);
    expect(noteStatus("cursor", dataDir, e, {}).state).toBe("added");
    expect(removeInboxNote("cursor", dataDir, e)).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(file(PLUGIN))).toBe(false);
    // Then, with no editor and no plugin: copied by hand again.
    expect(noteCopiedByHand("cursor", env())).toBe(true);
  });

  test("an own file with front matter that is there but empty: the person's unless Plannotator created it", async () => {
    const at = file(".devin", "rules", "plannotator-inbox.md");
    write(at, "");
    const e = env();
    expect(addInboxNote("windsurf", dataDir, e, undefined, { config: {} }).ok).toBe(false);
    expect(read(at)).toBe("");
    // The automatic add leaves it too, and does not try again.
    fake.install("devin");
    await connect();
    expect(await autoAddInboxNotes(options())).toEqual([]);
    expect(read(at)).toBe("");
    expect(loadConfig().inboxAgentNotes?.asked).toEqual(["windsurf"]);
    // One Plannotator created and that was emptied since: the note goes back with its front matter.
    rmSync(at);
    expect(addInboxNote("windsurf", dataDir, env(), undefined, { config: {} })).toMatchObject({ ok: true, action: "created" });
    writeFileSync(at, "");
    expect(addInboxNote("windsurf", dataDir, env(), undefined, { config: {} })).toMatchObject({ ok: true });
    expect(read(at)).toBe(`${DEVIN}${INBOX_NOTE_BLOCK}\n`);
  });
});

describe("uninstall", () => {
  test("with the records gone: own files deleted whole, marked sections taken out byte for byte, the shared block once", () => {
    const e = env();
    write(file(".config", "amp", "AGENTS.md"), "Mine.");
    write(file(".gemini", "GEMINI.md"), "Mine.\r\n");
    for (const agent of ["kiro", "windsurf", "amp", "dsh", "gemini", "antigravity"] as const) {
      expect(addInboxNote(agent, dataDir, e, undefined, { config: {} })).toMatchObject({ ok: true });
    }
    writeFileSync(join(dataDir, "inbox", "agent-notes.json"), JSON.stringify({ v: 1, notes: {} }));
    const plan = planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS, {});
    expect(plan.items.map((item) => [item.agent, item.path])).toEqual([
      ["gemini", "~/.gemini/GEMINI.md"],
      ["kiro", "~/.kiro/steering/plannotator-inbox.md"],
      ["windsurf", "~/.devin/rules/plannotator-inbox.md"],
      ["amp", "~/.config/amp/AGENTS.md"],
      ["dsh", "~/.dsh/AGENTS.md"],
    ]);
    for (const item of plan.items) expect(item.apply()).toMatchObject({ ok: true });
    expect(existsSync(file(".kiro", "steering", "plannotator-inbox.md"))).toBe(false);
    expect(existsSync(file(".devin", "rules", "plannotator-inbox.md"))).toBe(false);
    expect(read(file(".config", "amp", "AGENTS.md"))).toBe("Mine.");
    expect(read(file(".gemini", "GEMINI.md"))).toBe("Mine.\r\n");
    // DSH's AGENTS.md was created for the note, and its record is gone: the marked section goes, the empty file stays.
    expect(read(file(".dsh", "AGENTS.md"))).toBe("");
  });
});
