/**
 * The Inbox note in each agent's instructions file (inbox-agent-notes.ts),
 * in a scratch home (tests/helpers/fake-agents.ts): where it goes per agent,
 * the marked block (append, idempotent, CRLF, symlink, damaged markers, the
 * person's edit), removal, and the uninstall scan.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_AGENT_LABELS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  addInboxNote,
  INBOX_NOTE_BLOCK,
  INBOX_NOTE_END,
  INBOX_NOTE_START,
  INBOX_NOTE_VERSION,
  inboxNotesDisabled,
  noteStatus,
  noteTarget,
  planInboxNoteRemoval,
  readInboxAgentNotes,
  removeInboxNote,
} from "./inbox-agent-notes";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";

let fake: FakeAgents;
let dataDir: string;
let e: AgentEnvironment;

beforeEach(() => {
  fake = createFakeAgents("plannotator-notes-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  e = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env });
});
afterEach(() => fake.remove());

const file = (...parts: string[]) => join(fake.home, ...parts);
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");

test("the block: markers on their own lines around the note", () => {
  expect(INBOX_NOTE_BLOCK.startsWith(`${INBOX_NOTE_START}\n## Plannotator Inbox\n`)).toBe(true);
  expect(INBOX_NOTE_BLOCK.endsWith(`\n${INBOX_NOTE_END}`)).toBe(true);
  expect(INBOX_NOTE_START).toBe("<!-- plannotator-inbox:start v4 · added by Plannotator. Remove it in the Inbox's Settings or with `plannotator uninstall` -->");
});

describe("where each agent's note goes", () => {
  test("Claude Code: its own rules file, created", () => {
    expect(noteTarget("claude-code", e)).toEqual({ path: file(".claude", "rules", "plannotator-inbox.md"), create: true, reason: null });
    expect(addInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: true, action: "created" });
    expect(read(file(".claude", "rules", "plannotator-inbox.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
  });

  test("Codex: AGENTS.override.md when it exists, else AGENTS.md", () => {
    expect(noteTarget("codex", e).path).toBe(file(".codex", "AGENTS.md"));
    write(file(".codex", "AGENTS.override.md"), "# mine\n");
    expect(noteTarget("codex", e)).toEqual({ path: file(".codex", "AGENTS.override.md"), create: false, reason: null });
  });

  test("OpenCode: only an AGENTS.md that already exists; never created", () => {
    const status = noteStatus("opencode", dataDir, e);
    expect(status.state).toBe("unavailable");
    expect(status.reason).toContain("OpenCode 1");
    const refused = addInboxNote("opencode", dataDir, e);
    expect(refused.ok).toBe(false);
    expect(existsSync(file(".config", "opencode", "AGENTS.md"))).toBe(false);
    write(file(".config", "opencode", "AGENTS.md"), "Be brief.\n");
    expect(addInboxNote("opencode", dataDir, e)).toMatchObject({ ok: true, action: "added" });
    expect(read(file(".config", "opencode", "AGENTS.md"))).toBe(`Be brief.\n\n${INBOX_NOTE_BLOCK}\n`);
  });

  test("Pi: the one file Pi reads (the first that exists), AGENTS.md only when none does", () => {
    expect(noteTarget("pi", e)).toMatchObject({ path: file(".pi", "agent", "AGENTS.md"), create: true });
    write(file(".pi", "agent", "CLAUDE.md"), "x\n");
    expect(noteTarget("pi", e)).toMatchObject({ path: file(".pi", "agent", "CLAUDE.md"), create: false });
    write(file(".pi", "agent", "AGENTS.md"), "y\n");
    expect(noteTarget("pi", e).path).toBe(file(".pi", "agent", "AGENTS.md"));
  });

  test("Gemini: its context.fileName, GEMINI.md by default", () => {
    expect(noteTarget("gemini", e).path).toBe(file(".gemini", "GEMINI.md"));
    write(file(".gemini", "settings.json"), '{ // mine\n "context": { "fileName": ["AGENTS.md", "GEMINI.md"] } }');
    expect(noteTarget("gemini", e).path).toBe(file(".gemini", "AGENTS.md"));
  });

  test("Qwen Code: its context.fileName, QWEN.md by default, in $QWEN_HOME (the folder itself)", () => {
    expect(noteTarget("qwen", e)).toEqual({ path: file(".qwen", "QWEN.md"), create: true, reason: null });
    write(file(".qwen", "settings.json"), '{ // mine\n "context": { "fileName": "CONTEXT.md" } }');
    expect(noteTarget("qwen", e).path).toBe(file(".qwen", "CONTEXT.md"));
    // A name with a folder in it is not a file name: the default.
    write(file(".qwen", "settings.json"), '{ "context": { "fileName": ["../escape.md"] } }');
    expect(noteTarget("qwen", e).path).toBe(file(".qwen", "QWEN.md"));
    // QWEN_HOME replaces ~/.qwen (Gemini's GEMINI_CLI_HOME is a parent folder; Qwen's is not).
    const home = join(fake.root, "qwen-home");
    const moved = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, QWEN_HOME: home } });
    write(join(home, "settings.json"), '{ "context": { "fileName": ["AGENTS.md", "QWEN.md"] } }');
    expect(noteTarget("qwen", moved).path).toBe(join(home, "AGENTS.md"));
    expect(addInboxNote("qwen", dataDir, moved)).toMatchObject({ ok: true, action: "created" });
    expect(read(join(home, "AGENTS.md"))).toBe(`${INBOX_NOTE_BLOCK}\n`);
    expect(existsSync(file(".qwen", "AGENTS.md"))).toBe(false);
    expect(removeInboxNote("qwen", dataDir, moved)).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
  });
});

describe("the marked section", () => {
  test("appended after one blank line; a second add changes nothing (the file is not touched)", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, "# My rules\nBe brief.");
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "added", path: "~/.codex/AGENTS.md" });
    // The file ended without a line break, so the block ends it the same way (removal reads that).
    expect(read(path)).toBe(`# My rules\nBe brief.\n\n${INBOX_NOTE_BLOCK}`);
    const mtime = statSync(path).mtimeMs;
    Bun.sleepSync(20);
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "unchanged" });
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(noteStatus("codex", dataDir, e).state).toBe("added");
  });

  test("CRLF stays CRLF, and removal gives back the file as it was", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, "# Rules\r\nBe brief.\r\n");
    addInboxNote("codex", dataDir, e);
    const text = read(path);
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
    expect(read(path)).toBe("# Rules\r\nBe brief.\r\n");
    expect(readInboxAgentNotes(dataDir).notes.codex).toBeUndefined();
  });

  test("a mostly-CRLF file that ends in a lone LF comes back byte for byte after add then remove", () => {
    const path = file(".codex", "AGENTS.md");
    for (const before of ["a\r\nb\r\nc\n", "a\nb\nc\r\n", "a\r\n\r\n"]) {
      write(path, before);
      expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true });
      expect(read(path)).toContain(INBOX_NOTE_START);
      expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
      expect(JSON.stringify(read(path))).toBe(JSON.stringify(before));
    }
  });

  test("Codex: a note in AGENTS.md is still on after AGENTS.override.md appears, and Off removes it from both files", () => {
    const agents = file(".codex", "AGENTS.md");
    const override = file(".codex", "AGENTS.override.md");
    write(agents, "Mine.\n");
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "added" });
    // The person adds an override later, and copies the section into it.
    write(override, `Override.\n\n${INBOX_NOTE_BLOCK}\n`);
    expect(noteStatus("codex", dataDir, e).state).toBe("added");
    write(override, "Override.\n");
    const status = noteStatus("codex", dataDir, e);
    expect(status.state).toBe("added");
    expect(status.reason).toContain("~/.codex/AGENTS.md");
    expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
    expect(read(agents)).toBe("Mine.\n");
    expect(read(override)).toBe("Override.\n");
    expect(noteStatus("codex", dataDir, e).state).toBe("absent");
    // With the copy in both: both go.
    write(agents, "Mine.\n");
    addInboxNote("codex", dataDir, e);
    write(agents, `Mine.\n\n${INBOX_NOTE_BLOCK}\n`);
    expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true });
    expect(read(agents)).toBe("Mine.\n");
    expect(read(override)).toBe("Override.\n");
  });

  test("no final newline and empty files (LF and CRLF) come back byte for byte, for every note file, with or without the record", () => {
    const cases = ["abc", "a\r\nb", "a\nb\n\nc", "", "\n", "\r\n", "\r\n\r\n", "# Rules\r\nBe brief.\r\n", "x\n", " ", "\t", "  \n\t", "  \r\n\t", "\r\n ", " \n", "\t\r\n"];
    const targets: [InboxNoteAgentId, string][] = [
      ["codex", file(".codex", "AGENTS.md")],
      ["gemini", file(".gemini", "GEMINI.md")],
      ["qwen", file(".qwen", "QWEN.md")],
      ["pi", file(".pi", "agent", "AGENTS.md")],
      ["opencode", file(".config", "opencode", "AGENTS.md")],
    ];
    for (const [agent, path] of targets) {
      for (const before of cases) {
        write(path, before);
        expect(addInboxNote(agent, dataDir, e)).toMatchObject({ ok: true });
        expect(read(path)).toContain(INBOX_NOTE_START);
        // A second add changes nothing.
        expect(addInboxNote(agent, dataDir, e)).toMatchObject({ ok: true, action: "unchanged" });
        expect(removeInboxNote(agent, dataDir, e)).toMatchObject({ ok: true });
        expect([agent, JSON.stringify(read(path))]).toEqual([agent, JSON.stringify(before)]);
      }
    }
    // Codex's override file too.
    const override = file(".codex", "AGENTS.override.md");
    for (const before of ["abc", "a\r\nb", ""]) {
      write(override, before);
      addInboxNote("codex", dataDir, e);
      expect(read(override)).toContain(INBOX_NOTE_START);
      removeInboxNote("codex", dataDir, e);
      expect(JSON.stringify(read(override))).toBe(JSON.stringify(before));
    }
    rmSync(override);
    // Uninstall with the record gone reads the same from the file alone.
    const agents = file(".codex", "AGENTS.md");
    for (const before of ["abc", "a\r\nb", "", "x\n"]) {
      write(agents, before);
      addInboxNote("codex", dataDir, e);
      rmSync(join(dataDir, "inbox", "agent-notes.json"), { force: true });
      for (const item of planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS).items) expect(item.apply()).toMatchObject({ ok: true });
      expect(JSON.stringify(read(agents))).toBe(JSON.stringify(before));
    }
  });

  test("a whitespace-only file without a final line break: the start marker begins its own line, a re-add and Off both work, and the file comes back byte for byte", () => {
    const path = file(".codex", "AGENTS.md");
    for (const before of [" ", "\t", "  \n\t", "  \r\n\t", "\r\n\r\n "]) {
      write(path, before);
      expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "added" });
      // Never glued to the person's last line: the section reads as one, not damaged.
      expect(read(path).split(/\r?\n/)).toContain(INBOX_NOTE_START);
      expect(noteStatus("codex", dataDir, e).state).toBe("added");
      expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "unchanged" });
      expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
      expect(JSON.stringify(read(path))).toBe(JSON.stringify(before));
      expect(noteStatus("codex", dataDir, e).state).toBe("absent");
    }
  });

  test("a symlinked file (dotfiles) is written at its target and stays a link", () => {
    const real = join(fake.root, "dotfiles", "GEMINI.md");
    write(real, "Mine.\n");
    mkdirSync(file(".gemini"), { recursive: true });
    symlinkSync(real, file(".gemini", "GEMINI.md"));
    expect(addInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "added" });
    expect(lstatSync(file(".gemini", "GEMINI.md")).isSymbolicLink()).toBe(true);
    expect(read(real)).toContain(INBOX_NOTE_START);
    expect(noteStatus("gemini", dataDir, e).target).toBe(real);
  });

  test("damaged markers (one, several, out of order): nothing is written", () => {
    const path = file(".codex", "AGENTS.md");
    for (const broken of [`x\n${INBOX_NOTE_START}\n`, `${INBOX_NOTE_END}\n${INBOX_NOTE_START}\n`, `${INBOX_NOTE_BLOCK}\n${INBOX_NOTE_BLOCK}\n`]) {
      write(path, broken);
      const result = addInboxNote("codex", dataDir, e);
      expect(result.ok).toBe(false);
      expect(read(path)).toBe(broken);
      expect(noteStatus("codex", dataDir, e).state).toBe("damaged");
      expect(removeInboxNote("codex", dataDir, e).ok).toBe(false);
    }
  });

  test("the person's edit is theirs: never overwritten, still removed when they turn it off", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, "Mine.\n");
    addInboxNote("codex", dataDir, e);
    const edited = read(path).replace("Then keep working.", "Then keep working, and ping me twice.");
    writeFileSync(path, edited);
    expect(noteStatus("codex", dataDir, e).state).toBe("edited");
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "kept-edited" });
    expect(read(path)).toBe(edited);
    removeInboxNote("codex", dataDir, e);
    expect(read(path)).toBe("Mine.\n");
  });

  test("an older note version Plannotator wrote is brought up to date; the person's text around it is kept", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, "Mine.\n");
    addInboxNote("codex", dataDir, e);
    const old = "<!-- plannotator-inbox:start v0 -->\nold note\n<!-- plannotator-inbox:end -->";
    writeFileSync(path, `Mine.\n\n${old}\nAfter.\n`);
    const notes = readInboxAgentNotes(dataDir);
    notes.notes.codex!.block_sha256 = new Bun.CryptoHasher("sha256").update(old).digest("hex");
    writeFileSync(join(dataDir, "inbox", "agent-notes.json"), JSON.stringify(notes));
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "updated" });
    expect(read(path)).toBe(`Mine.\n\n${INBOX_NOTE_BLOCK}\nAfter.\n`);
  });

  // The v1 block exactly as 0.28.x wrote it, frozen on purpose: these are the bytes on users' disks today.
  const V1_BLOCK = [
    "<!-- plannotator-inbox:start v1 · added by Plannotator. Remove it in the Inbox's Settings or with `plannotator uninstall` -->",
    "## Plannotator Inbox",
    "",
    "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
    "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` when the person isn't here to answer in this chat: to ask a decision only they can make (as a `:::question` block), or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
    "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`. When they are here, ask in this chat instead.",
    "<!-- plannotator-inbox:end -->",
  ].join("\n");
  const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  /** agent-notes.json as 0.28.x left it: one v1 record for `agent`, naming the file's resolved path. */
  const v1Record = (agent: string, path: string) => {
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    const record = { path: realpathSync(path), created: true, version: 1, block_sha256: sha(V1_BLOCK), at: "2026-10-01T00:00:00.000Z" };
    writeFileSync(join(dataDir, "inbox", "agent-notes.json"), JSON.stringify({ v: 1, notes: { [agent]: record } }));
  };

  test("updating from v1: an untouched v1 note (with its record) is still on, and re-adding it writes this version in place, every other byte kept", () => {
    const path = file(".claude", "rules", "plannotator-inbox.md");
    write(path, `${V1_BLOCK}\n`);
    v1Record("claude-code", path);
    expect(noteStatus("claude-code", dataDir, e).state).toBe("added");
    expect(addInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: true, action: "updated" });
    expect(read(path)).toBe(`${INBOX_NOTE_BLOCK}\n`);
    expect(readInboxAgentNotes(dataDir).notes["claude-code"]).toMatchObject({ version: INBOX_NOTE_VERSION, block_sha256: sha(INBOX_NOTE_BLOCK), created: true });
    // Switching it off afterwards still deletes the file the note was all of.
    expect(removeInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(path)).toBe(false);
  });

  test("updating from v1 with agent-notes.json lost: the v1 block still reads as Plannotator's, is updated in place, and uninstall does not call it edited", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, `# Mine\n\n${V1_BLOCK}\nAfter.\n`);
    expect(noteStatus("codex", dataDir, e).state).toBe("added");
    const plan = planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS);
    expect(plan.items.map((item) => item.describe).join("\n")).not.toContain("you edited it");
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "updated" });
    expect(read(path)).toBe(`# Mine\n\n${INBOX_NOTE_BLOCK}\nAfter.\n`);
  });

  test("updating a v1 note in a file two agents share (Pi's AGENTS.md a link to Codex's): the other agent's note stays on, not 'edited'", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, `Shared.\n\n${V1_BLOCK}\n`);
    mkdirSync(file(".pi", "agent"), { recursive: true });
    symlinkSync(path, file(".pi", "agent", "AGENTS.md"));
    const record = { path: realpathSync(path), created: false, version: 1, block_sha256: sha(V1_BLOCK), at: "2026-10-01T00:00:00.000Z" };
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "agent-notes.json"), JSON.stringify({ v: 1, notes: { codex: record, pi: record } }));
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "updated" });
    expect(read(path)).toBe(`Shared.\n\n${INBOX_NOTE_BLOCK}\n`);
    expect(noteStatus("pi", dataDir, e).state).toBe("added");
    expect(readInboxAgentNotes(dataDir).notes.pi).toMatchObject({ version: INBOX_NOTE_VERSION, block_sha256: sha(INBOX_NOTE_BLOCK) });
    // And Off for both gives the file back as the person had it.
    expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "kept-shared" });
    expect(removeInboxNote("pi", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
    expect(read(path)).toBe("Shared.\n");
  });

  test("a v1 note the person edited stays theirs after the update: never rewritten", () => {
    const path = file(".codex", "AGENTS.md");
    const edited = V1_BLOCK.replace("Then keep working.", "Then keep working. Never at night.");
    write(path, `${edited}\n`);
    v1Record("codex", path);
    expect(noteStatus("codex", dataDir, e).state).toBe("edited");
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "kept-edited" });
    expect(read(path)).toBe(`${edited}\n`);
    // With the record lost too.
    rmSync(join(dataDir, "inbox", "agent-notes.json"));
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "kept-edited" });
    expect(read(path)).toBe(`${edited}\n`);
  });

  test("a file Plannotator created is deleted when the note was all it held", () => {
    addInboxNote("gemini", dataDir, e);
    expect(removeInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(file(".gemini", "GEMINI.md"))).toBe(false);
  });

  test("a file the person had is never deleted, even when only the note is left", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, "");
    addInboxNote("codex", dataDir, e);
    removeInboxNote("codex", dataDir, e);
    expect(existsSync(path)).toBe(true);
  });

  test("not a regular file, or not UTF-8: refused", () => {
    mkdirSync(file(".codex", "AGENTS.md"), { recursive: true });
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: false });
    write(file(".gemini", "GEMINI.md"), "");
    writeFileSync(file(".gemini", "GEMINI.md"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    expect(noteStatus("gemini", dataDir, e)).toMatchObject({ state: "refused", reason: "it is not UTF-8 text" });
  });
});

test("uninstall: every recorded note, plus a file with our markers whose record is gone", () => {
  write(file(".codex", "AGENTS.md"), "Mine.\n");
  addInboxNote("codex", dataDir, e);
  addInboxNote("gemini", dataDir, e);
  // Qwen's note whose record is gone: found by its markers in the file Qwen reads.
  write(file(".qwen", "QWEN.md"), `Qwen rules\n\n${INBOX_NOTE_BLOCK}\n`);
  write(file(".pi", "agent", "CLAUDE.md"), `Pi rules\n\n${INBOX_NOTE_BLOCK}\n`);
  const { items } = planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS);
  expect(items.map((item) => item.describe)).toEqual([
    "Note for Codex (~/.codex/AGENTS.md, marked section only)",
    "Note for Gemini CLI (~/.gemini/GEMINI.md, created by Plannotator: file removed if empty)",
    "Note for Qwen Code (~/.qwen/QWEN.md, marked section only)",
    "Note for Pi (~/.pi/agent/CLAUDE.md, marked section only)",
  ]);
  for (const item of items) expect(item.apply().ok).toBe(true);
  expect(read(file(".codex", "AGENTS.md"))).toBe("Mine.\n");
  expect(read(file(".qwen", "QWEN.md"))).toBe("Qwen rules\n");
  expect(existsSync(file(".gemini", "GEMINI.md"))).toBe(false);
  expect(read(file(".pi", "agent", "CLAUDE.md"))).toBe("Pi rules\n");
});

describe("review follow-ups", () => {
  test("a symlinked parent folder (~/.claude -> dotfiles): the record names the resolved file, and off deletes the file the note created", () => {
    const dotfiles = join(fake.root, "dotfiles", "claude");
    mkdirSync(dotfiles, { recursive: true });
    symlinkSync(dotfiles, file(".claude"));
    expect(addInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: true, action: "created" });
    expect(readInboxAgentNotes(dataDir).notes["claude-code"]?.path).toBe(join(dotfiles, "rules", "plannotator-inbox.md"));
    expect(removeInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: true, action: "deleted" });
    expect(existsSync(join(dotfiles, "rules", "plannotator-inbox.md"))).toBe(false);
  });

  test("mixed line endings: the dominant one for the new lines, every other byte kept, and a re-add does not touch the file", () => {
    const path = file(".codex", "AGENTS.md");
    const before = "# Rules\r\nOne.\r\nTwo.\nThree.\r\n";
    write(path, before);
    addInboxNote("codex", dataDir, e);
    const after = read(path);
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(`\r\n${INBOX_NOTE_BLOCK.replace(/\n/g, "\r\n")}\r\n`);
    const mtime = statSync(path).mtimeMs;
    Bun.sleepSync(20);
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "unchanged" });
    expect(statSync(path).mtimeMs).toBe(mtime);
    removeInboxNote("codex", dataDir, e);
    expect(read(path)).toBe(before);
  });

  test("a UTF-8 BOM is kept through add and remove", () => {
    const path = file(".codex", "AGENTS.md");
    mkdirSync(file(".codex"), { recursive: true });
    writeFileSync(path, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("Mine.\n")]));
    addInboxNote("codex", dataDir, e);
    expect([...readFileSync(path).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    removeInboxNote("codex", dataDir, e);
    expect(readFileSync(path)).toEqual(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("Mine.\n")]));
  });

  test("a file over 1 MiB is refused", () => {
    write(file(".codex", "AGENTS.md"), "x".repeat(1024 * 1024 + 1));
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: false });
    expect(noteStatus("codex", dataDir, e)).toMatchObject({ state: "refused", reason: "it is larger than 1 MiB" });
  });

  test("one file shared by two agents (Pi's AGENTS.md is a link to Codex's): one section, kept while either has it on", () => {
    write(file(".codex", "AGENTS.md"), "Shared.\n");
    mkdirSync(file(".pi", "agent"), { recursive: true });
    symlinkSync(file(".codex", "AGENTS.md"), file(".pi", "agent", "AGENTS.md"));
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "added" });
    expect(addInboxNote("pi", dataDir, e)).toMatchObject({ ok: true, action: "shared" });
    expect(read(file(".codex", "AGENTS.md")).split(INBOX_NOTE_START)).toHaveLength(2);
    expect(noteStatus("pi", dataDir, e).shared_with).toEqual(["codex"]);
    expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "kept-shared" });
    expect(read(file(".codex", "AGENTS.md"))).toContain(INBOX_NOTE_START);
    expect(removeInboxNote("pi", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
    expect(read(file(".codex", "AGENTS.md"))).toBe("Shared.\n");
  });

  test("uninstall names a damaged section it left", () => {
    write(file(".codex", "AGENTS.md"), `Mine.\n${INBOX_NOTE_START}\nno end\n`);
    const plan = planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS);
    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual(["the Plannotator section in ~/.codex/AGENTS.md is damaged, so uninstall left it; fix or delete it by hand"]);
  });

  test("with agent-notes.json lost, uninstall still deletes Claude Code's own rules file when the note is all it holds", () => {
    write(file(".claude", "rules", "plannotator-inbox.md"), `${INBOX_NOTE_BLOCK}\n`);
    const plan = planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS);
    expect(plan.items.map((item) => item.describe)).toEqual(["Note for Claude Code (~/.claude/rules/plannotator-inbox.md, created by Plannotator: file removed if empty)"]);
    plan.items[0]!.apply();
    expect(existsSync(file(".claude", "rules", "plannotator-inbox.md"))).toBe(false);
  });

  test("OpenCode never creates its AGENTS.md: the status is unavailable, not 'would create'", () => {
    expect(noteStatus("opencode", dataDir, e)).toMatchObject({ state: "unavailable", create: false });
  });

  test("PLANNOTATOR_INBOX_NOTES=0 turns notes off", () => {
    expect(inboxNotesDisabled({ PLANNOTATOR_INBOX_NOTES: "0" })).toBe(true);
    expect(inboxNotesDisabled({})).toBe(false);
  });
});

test("Cursor keeps its rules in the app: its note is copied by hand, with no file, nothing written and no record", () => {
  const status = noteStatus("cursor", dataDir, e);
  expect(status).toMatchObject({ agent: "cursor", path: null, target: null, state: "manual", create: false, created: false, shared_with: [] });
  expect(status.reason).toBe("Cursor keeps its rules in the app: copy the note into Customize → Rules yourself. Plannotator can't see, update or remove that copy.");
  expect(noteTarget("cursor", e).path).toBeNull();
  expect(existsSync(file(".cursor"))).toBe(false);
  expect(readInboxAgentNotes(dataDir).notes.cursor).toBeUndefined();
});
