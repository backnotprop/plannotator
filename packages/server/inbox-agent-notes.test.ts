/**
 * The Inbox note in each agent's instructions file (inbox-agent-notes.ts),
 * in a scratch home (tests/helpers/fake-agents.ts): where it goes per agent,
 * the marked block (append, idempotent, CRLF, symlink, damaged markers, the
 * person's edit), removal, and the uninstall scan.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_AGENT_LABELS } from "@plannotator/core/inbox-types";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  addInboxNote,
  INBOX_NOTE_BLOCK,
  INBOX_NOTE_END,
  INBOX_NOTE_START,
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
  expect(INBOX_NOTE_START).toBe("<!-- plannotator-inbox:start v1 · added by Plannotator. Remove it in the Inbox's Settings or with `plannotator uninstall` -->");
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
});

describe("the marked section", () => {
  test("appended after one blank line; a second add changes nothing (the file is not touched)", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, "# My rules\nBe brief.");
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "added", path: "~/.codex/AGENTS.md" });
    expect(read(path)).toBe(`# My rules\nBe brief.\n\n${INBOX_NOTE_BLOCK}\n`);
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
  write(file(".pi", "agent", "CLAUDE.md"), `Pi rules\n\n${INBOX_NOTE_BLOCK}\n`);
  const { items } = planInboxNoteRemoval(dataDir, e, INBOX_AGENT_LABELS);
  expect(items.map((item) => item.describe)).toEqual([
    "Note for Codex (~/.codex/AGENTS.md, marked section only)",
    "Note for Gemini CLI (~/.gemini/GEMINI.md, created by Plannotator: file removed if empty)",
    "Note for Pi (~/.pi/agent/CLAUDE.md, marked section only)",
  ]);
  for (const item of items) expect(item.apply().ok).toBe(true);
  expect(read(file(".codex", "AGENTS.md"))).toBe("Mine.\n");
  expect(existsSync(file(".gemini", "GEMINI.md"))).toBe(false);
  expect(read(file(".pi", "agent", "CLAUDE.md"))).toBe("Pi rules\n");
});
