import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_AGENT_LABELS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  addInboxNote,
  INBOX_NOTE_BLOCK,
  INBOX_NOTE_EARLIER_BLOCKS,
  INBOX_NOTE_END,
  INBOX_NOTE_START,
  INBOX_NOTE_VERSION,
  inboxNotesDisabled,
  noteStatus,
  noteTarget,
  planInboxNoteRemoval,
  readInboxAgentNotes,
  refreshInboxNotes,
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
  expect(INBOX_NOTE_START).toBe("<!-- plannotator-inbox:start v9 · added by Plannotator. Remove it in the Inbox's Settings or with `plannotator uninstall` -->");
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

  test("Codex: an empty or whitespace-only AGENTS.override.md is skipped, as Codex skips it, so the note goes in AGENTS.md and the override stays empty", () => {
    // Codex reads the first of the two that holds text once trimmed: writing into an empty override
    // would make it read only that file from then on, hiding the person's AGENTS.md.
    write(file(".codex", "AGENTS.md"), "My rules.\n");
    for (const empty of ["", "\n\n", " \t\r\n", "\u00a0\u2003\n"]) {
      write(file(".codex", "AGENTS.override.md"), empty);
      expect(noteTarget("codex", e)).toEqual({ path: file(".codex", "AGENTS.md"), create: false, reason: null });
    }
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "added", path: "~/.codex/AGENTS.md" });
    expect(read(file(".codex", "AGENTS.md"))).toBe(`My rules.\n\n${INBOX_NOTE_BLOCK}\n`);
    expect(read(file(".codex", "AGENTS.override.md"))).toBe("\u00a0\u2003\n");
    expect(noteStatus("codex", dataDir, e)).toMatchObject({ state: "added", path: "~/.codex/AGENTS.md" });
    // A BOM is text to Codex (Rust's trim keeps it): that override is read, so the note goes there.
    writeFileSync(file(".codex", "AGENTS.override.md"), Buffer.from([0xef, 0xbb, 0xbf, 0x0a]));
    expect(noteTarget("codex", e).path).toBe(file(".codex", "AGENTS.override.md"));
    rmSync(file(".codex", "AGENTS.override.md"));
    mkdirSync(file(".codex", "AGENTS.override.md"));
    expect(noteTarget("codex", e).path).toBe(file(".codex", "AGENTS.md"));
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

describe("above a Gemini CLI or Qwen Code memory section", () => {
  // Their memory tools add a remembered fact at the end of `## Gemini Added Memories` / `## Qwen Added
  // Memories`, which runs to the next `\n## `: after that section, the note's own heading would be that
  // next heading, and the fact would land inside the note's markers.
  const MEMORIES = "## Gemini Added Memories\n- likes tabs\n";

  function geminiRemembers(text: string, fact: string): string {
    const header = "## Gemini Added Memories";
    const at = text.indexOf(header);
    const start = at + header.length;
    let end = text.indexOf("\n## ", start);
    if (end === -1) end = text.length;
    const before = text.substring(0, start).trimEnd();
    const section = `${text.substring(start, end).trimEnd()}\n- ${fact}`;
    return `${before}\n${section.trimStart()}\n${text.substring(end)}`.trimEnd() + "\n";
  }

  test("a new note goes on the lines above the section, and a fact remembered after it stays outside the markers", () => {
    const path = file(".gemini", "GEMINI.md");
    write(path, `# Mine\n\n${MEMORIES}`);
    expect(addInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "added" });
    expect(read(path)).toBe(`# Mine\n\n${INBOX_NOTE_BLOCK}\n\n${MEMORIES}`);
    write(path, geminiRemembers(read(path), "uses bun"));
    expect(read(path)).toBe(`# Mine\n\n${INBOX_NOTE_BLOCK}\n\n## Gemini Added Memories\n- likes tabs\n- uses bun\n`);
    expect(noteStatus("gemini", dataDir, e).state).toBe("added");
    expect(removeInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
    expect(read(path)).toBe("# Mine\n\n## Gemini Added Memories\n- likes tabs\n- uses bun\n");
  });

  test("a file that starts with the section: the note first", () => {
    const path = file(".gemini", "GEMINI.md");
    write(path, MEMORIES);
    expect(addInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "added" });
    expect(read(path)).toBe(`${INBOX_NOTE_BLOCK}\n${MEMORIES}`);
  });

  test("every shape around the section (CRLF, blank lines, the header first, last, or mid-line) comes back byte for byte, with or without the record", () => {
    const path = file(".gemini", "GEMINI.md");
    const cases = [
      MEMORIES,
      MEMORIES.replace(/\n/g, "\r\n"),
      `\n${MEMORIES}`,
      `\n\n${MEMORIES}`,
      `# Mine\n${MEMORIES}`,
      `# Mine\n\n${MEMORIES}`,
      `# Mine\r\n\r\n${MEMORIES.replace(/\n/g, "\r\n")}`,
      `# Mine\n\n\n${MEMORIES}## Later\nmore`,
      `# Mine\n${MEMORIES.trimEnd()}`,
      `see: ${MEMORIES}`,
      `  \n${MEMORIES}`,
    ];
    for (const before of cases) {
      write(path, before);
      expect(addInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "added" });
      const after = read(path);
      expect(after.indexOf(INBOX_NOTE_END)).toBeLessThan(after.indexOf("## Gemini Added Memories"));
      expect(addInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "unchanged" });
      expect(removeInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true });
      expect(JSON.stringify(read(path))).toBe(JSON.stringify(before));
      addInboxNote("gemini", dataDir, e);
      rmSync(join(dataDir, "inbox", "agent-notes.json"), { force: true });
      for (const item of planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS).items) expect(item.apply()).toMatchObject({ ok: true });
      expect(JSON.stringify(read(path))).toBe(JSON.stringify(before));
    }
  });

  test("Qwen Code's section the same way", () => {
    const path = file(".qwen", "QWEN.md");
    write(path, "Mine.\n\n## Qwen Added Memories\n- a fact\n");
    expect(addInboxNote("qwen", dataDir, e)).toMatchObject({ ok: true, action: "added" });
    expect(read(path)).toBe(`Mine.\n\n${INBOX_NOTE_BLOCK}\n\n## Qwen Added Memories\n- a fact\n`);
  });

  test("an untouched note left after the section (an earlier Plannotator) moves above it at the next add, and at the next start; an edited one never moves", () => {
    const path = file(".gemini", "GEMINI.md");
    write(path, `# Mine\n\n${MEMORIES}`);
    write(path, `# Mine\n\n${MEMORIES}\n${INBOX_NOTE_BLOCK}\n`);
    expect(addInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "updated" });
    expect(read(path)).toBe(`# Mine\n\n${INBOX_NOTE_BLOCK}\n\n${MEMORIES}`);

    write(path, `# Mine\n\n${MEMORIES}\n${INBOX_NOTE_BLOCK}\n`);
    expect(refreshInboxNotes(dataDir, e)).toEqual([{ agent: "gemini", path: realpathSync(path), result: "moved" }]);
    expect(read(path)).toBe(`# Mine\n\n${INBOX_NOTE_BLOCK}\n\n${MEMORIES}`);
    expect(refreshInboxNotes(dataDir, e)).toEqual([{ agent: "gemini", path: realpathSync(path), result: "current" }]);

    const v7 = INBOX_NOTE_EARLIER_BLOCKS[6]!;
    write(path, `# Mine\n\n${MEMORIES}\n${v7}\n`);
    const notesFile = join(dataDir, "inbox", "agent-notes.json");
    const records = JSON.parse(read(notesFile));
    records.notes.gemini = { ...records.notes.gemini, version: 7, block_sha256: createHash("sha256").update(v7).digest("hex") };
    writeFileSync(notesFile, JSON.stringify(records));
    expect(refreshInboxNotes(dataDir, e)).toEqual([{ agent: "gemini", path: realpathSync(path), result: "refreshed" }]);
    expect(read(path)).toBe(`# Mine\n\n${INBOX_NOTE_BLOCK}\n\n${MEMORIES}`);
    expect(readInboxAgentNotes(dataDir).notes.gemini?.version).toBe(INBOX_NOTE_VERSION);

    const edited = INBOX_NOTE_BLOCK.replace("\n## Plannotator Inbox", "\n- a fact\n## Plannotator Inbox");
    write(path, `# Mine\n\n${MEMORIES}\n${edited}\n`);
    expect(refreshInboxNotes(dataDir, e)).toEqual([{ agent: "gemini", path: realpathSync(path), result: "edited" }]);
    expect(addInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true, action: "kept-edited" });
    expect(read(path)).toBe(`# Mine\n\n${MEMORIES}\n${edited}\n`);
  });

  test("with PLANNOTATOR_INBOX_NOTES=0 the start moves nothing", () => {
    const path = file(".gemini", "GEMINI.md");
    write(path, `${MEMORIES}`);
    addInboxNote("gemini", dataDir, e);
    write(path, `${MEMORIES}\n${INBOX_NOTE_BLOCK}\n`);
    const off = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, PLANNOTATOR_INBOX_NOTES: "0" } });
    expect(refreshInboxNotes(dataDir, off)).toEqual([]);
    expect(read(path)).toBe(`${MEMORIES}\n${INBOX_NOTE_BLOCK}\n`);
  });
});

describe("the marked section", () => {
  test("appended after one blank line; a second add changes nothing (the file is not touched)", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, "# My rules\nBe brief.");
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "added", path: "~/.codex/AGENTS.md" });
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
        expect(addInboxNote(agent, dataDir, e)).toMatchObject({ ok: true, action: "unchanged" });
        expect(removeInboxNote(agent, dataDir, e)).toMatchObject({ ok: true });
        expect([agent, JSON.stringify(read(path))]).toEqual([agent, JSON.stringify(before)]);
      }
    }
    const override = file(".codex", "AGENTS.override.md");
    for (const before of ["abc", "a\r\nb", "x\n"]) {
      write(override, before);
      addInboxNote("codex", dataDir, e);
      expect(read(override)).toContain(INBOX_NOTE_START);
      removeInboxNote("codex", dataDir, e);
      expect(JSON.stringify(read(override))).toBe(JSON.stringify(before));
    }
    rmSync(override);
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
