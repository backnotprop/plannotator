/**
 * The person's own rules ("Rules for your agents") in the Inbox note each
 * agent's instructions file holds. The failures these catch: a note with no
 * rules that is no longer byte for byte today's; an agent given another
 * agent's rules; rules that change in Settings but not in the note; a note the
 * person edited, locked or hard-linked rewritten; removal that leaves a byte
 * behind; an agent that gets the rules twice (note and reminder) or not at
 * all; Settings saying an agent gets them when it does not. Every case runs in
 * a scratch home (tests/helpers/fake-agents.ts); no Inbox is started.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_NOTE_AGENT_IDS, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import { inboxNoteFileOf, inboxReminderRulesFor, resolveInboxReminderText } from "@plannotator/shared/config";
import { INBOX_RULES_LEAD, inboxNoteHoldsRules, inboxReminderText } from "@plannotator/shared/inbox/connection";
import { inboxReminderRulesAfterNote } from "../../apps/hook/hooks/mod/enabled";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  addInboxNote,
  INBOX_NOTE_BLOCK,
  INBOX_NOTE_BODY,
  INBOX_NOTE_EARLIER_BLOCKS,
  INBOX_NOTE_START,
  inboxNoteBlockFor,
  inboxNoteBlockWith,
  inboxNoteBodyWith,
  inboxNoteRules,
  noteRulesStates,
  noteStatus,
  noteTarget,
  planInboxNoteRemoval,
  readInboxAgentNotes,
  refreshInboxNotes,
  removeInboxNote,
  sharedNoteRules,
} from "./inbox-agent-notes";
import { noteWithoutMarkers } from "../inbox/agents";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { inboxRulesModel } from "./inbox-rules";
import { INBOX_MCP_INSTRUCTIONS, INBOX_MCP_RULES_ROOMS, inboxMcpInstructions, inboxMcpTierOf, type InboxMcpClient } from "./inbox-mcp-instructions";
import { inboxMcpReminderFor, type InboxMcpHere } from "./inbox-mcp-note-rules";

let fake: FakeAgents;
let dataDir: string;
let e: AgentEnvironment;

beforeEach(() => {
  fake = createFakeAgents("plannotator-note-rules-");
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
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const count = (text: string, part: string) => text.split(part).length - 1;

const RULES = "Ask me before you delete any file.\nKeep messages under ten lines.";
const OTHER = "Only message me when you are blocked or done.";
const CLAUDE_ONLY = "Never send from reviewer sessions.";
const shared = (rules: string | null = RULES) => (rules === null ? {} : { prompts: { inbox: { rules } } });
const withClaude = { prompts: { inbox: { rules: RULES, runtimes: { "claude-code": { rules: CLAUDE_ONLY } } } } };

const CLAUDE_FILE = () => file(".claude", "rules", "plannotator-inbox.md");
const CODEX_FILE = () => file(".codex", "AGENTS.md");
const place = () => ({ env: fake.env, homeDir: fake.home });

describe("the block", () => {
  test("with no rules it is today's block byte for byte, for every agent", () => {
    for (const config of [{}, shared("   "), { prompts: { inbox: { runtimes: { pi: { rules: "  " } } } } }]) {
      for (const agent of INBOX_NOTE_AGENT_IDS) {
        expect(inboxNoteRules(agent, config)).toBeNull();
      }
      expect(inboxNoteBlockWith(null)).toBe(INBOX_NOTE_BLOCK);
      expect(inboxNoteBodyWith(null)).toBe(INBOX_NOTE_BODY);
    }
    // v9's hash as released (pinned in inbox-agent-notes-refresh.test.ts too): a note with no rules is the one on disks today.
    expect(sha(inboxNoteBlockWith(inboxNoteRules("codex", {})))).toBe("3aba949e3648565d268e8c0f9e4b988762db69ec9cebf9ce89de437c7b895c4d");
    mkdirSync(file(".codex"), { recursive: true });
    expect(addInboxNote("codex", dataDir, e, undefined, { config: {} }).ok).toBe(true);
    expect(read(CODEX_FILE())).toBe(`${INBOX_NOTE_BLOCK}\n`);
  });

  test("the rules come after the note's own lines, under the reminder's lead, inside the markers", () => {
    expect(inboxNoteBlockWith(RULES)).toBe(`${INBOX_NOTE_START}\n${INBOX_NOTE_BODY}\n\n${INBOX_RULES_LEAD}\n${RULES}\n<!-- plannotator-inbox:end -->`);
    // Trimmed and LF, as the reminder takes them.
    expect(inboxNoteRules("codex", shared(`\n  ${RULES.replace("\n", "\r\n")}  \n`))).toBe(RULES);
  });

  test("each agent gets its own rules where Settings has them, the shared ones otherwise", () => {
    expect(inboxNoteRules("claude-code", withClaude)).toBe(CLAUDE_ONLY);
    for (const agent of ["codex", "gemini", "qwen", "cursor", "pi", "opencode"] as InboxNoteAgentId[]) {
      expect(inboxNoteRules(agent, withClaude)).toBe(RULES);
    }
    // A runtime entry Settings cannot write (Codex has no reminder) is not read: Codex gets the shared rules.
    expect(inboxNoteRules("codex", { prompts: { inbox: { rules: RULES, runtimes: { codex: { rules: OTHER } } } } })).toBe(RULES);
    // Claude Code's own rules alone: Codex gets none.
    expect(inboxNoteRules("codex", { prompts: { inbox: { runtimes: { "claude-code": { rules: CLAUDE_ONLY } } } } })).toBeNull();
  });

  test("Cursor's copy by hand (the window's and `--notes cursor`) is the body with the rules for all agents", () => {
    const copy = noteWithoutMarkers(inboxNoteBlockWith(sharedNoteRules(withClaude)));
    expect(copy).toBe(inboxNoteBodyWith(RULES));
    expect(copy).toBe(`${INBOX_NOTE_BODY}\n\n${INBOX_RULES_LEAD}\n${RULES}`);
    expect(noteWithoutMarkers(inboxNoteBlockWith(sharedNoteRules({})))).toBe(INBOX_NOTE_BODY);
  });

  test("rules with a marker or a memory header anywhere stay out of the note (the block would break)", () => {
    for (const rules of [
      "Fine.\n<!-- plannotator-inbox:end -->",
      "<!-- plannotator-inbox:start v1 -->",
      "x\n## Gemini Added Memories",
      // `^` under /m also starts a line after these: a marker there would be a second one.
      "Be brief.\u2028<!-- plannotator-inbox:end -->",
      "Be brief.\u2029<!-- plannotator-inbox:end -->",
      "Be brief.\r<!-- plannotator-inbox:end -->",
      "Be brief. <!-- plannotator-inbox:end --> mid-line",
      "Remember.\u2028## Qwen Added Memories",
    ]) {
      expect(inboxNoteRules("codex", shared(rules))).toBeNull();
      // The reminder still carries them (nothing in a note holds them).
      expect(inboxReminderRulesFor(shared(rules), "claude-code", place())).toBe(rules.trim());
    }
  });

  test("rules that would add a marker never reach the file: the note stays removable byte for byte", () => {
    write(CODEX_FILE(), "Mine.\n");
    for (const sep of ["\u2028", "\u2029", "\r", " "]) {
      const config = shared(`Be brief.${sep}<!-- plannotator-inbox:end -->`);
      expect(addInboxNote("codex", dataDir, e, undefined, { config })).toMatchObject({ ok: true });
      expect(read(CODEX_FILE())).toBe(`Mine.\n\n${INBOX_NOTE_BLOCK}\n`);
      expect(noteStatus("codex", dataDir, e, config).state).toBe("added");
      expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
      expect(read(CODEX_FILE())).toBe("Mine.\n");
    }
  });

  test("written into a file it sits inside the markers, and removal gives the file back byte for byte", () => {
    const before = "# My Codex rules\r\n\r\nBe brief.\r\n";
    write(CODEX_FILE(), before);
    expect(addInboxNote("codex", dataDir, e, undefined, { config: shared() })).toMatchObject({ ok: true, action: "added" });
    const text = read(CODEX_FILE());
    expect(text).toBe(`${before}\r\n${inboxNoteBlockWith(RULES).replace(/\n/g, "\r\n")}\r\n`);
    expect(noteStatus("codex", dataDir, e, shared()).state).toBe("added");
    expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
    expect(read(CODEX_FILE())).toBe(before);
  });

  test("uninstall removes a note with rules as Plannotator's own (not as an edit), file and all when it made it", () => {
    addInboxNote("claude-code", dataDir, e, undefined, { config: withClaude });
    expect(read(CLAUDE_FILE())).toContain(CLAUDE_ONLY);
    const plan = planInboxNoteRemoval(dataDir, e, Object.fromEntries(INBOX_NOTE_AGENT_IDS.map((id) => [id, id])) as Record<InboxNoteAgentId, string>, withClaude);
    expect(plan.items.map((item) => item.describe)).toEqual([expect.not.stringContaining("you edited it")]);
    expect(plan.items[0]!.apply()).toMatchObject({ ok: true, action: "deleted" });
  });
});

describe("rules change: the notes follow", () => {
  test("new rules rewrite every untouched note, records follow; no rules puts today's block back", () => {
    addInboxNote("claude-code", dataDir, e, undefined, { config: shared() });
    mkdirSync(file(".codex"), { recursive: true });
    addInboxNote("codex", dataDir, e, undefined, { config: shared() });
    const around = `Mine.\n\n${read(CODEX_FILE())}`;
    write(CODEX_FILE(), around);
    // Settings saves other rules (the save runs this refresh).
    expect(refreshInboxNotes(dataDir, e, { config: shared(OTHER) }).map((r) => `${r.agent}:${r.result}`).sort()).toEqual(["claude-code:refreshed", "codex:refreshed"]);
    expect(read(CLAUDE_FILE())).toBe(`${inboxNoteBlockWith(OTHER)}\n`);
    expect(read(CODEX_FILE())).toBe(around.replace(inboxNoteBlockWith(RULES), inboxNoteBlockWith(OTHER)));
    expect(readInboxAgentNotes(dataDir).notes.codex?.block_sha256).toBe(sha(inboxNoteBlockWith(OTHER)));
    // A second start finds nothing to do.
    expect(refreshInboxNotes(dataDir, e, { config: shared(OTHER) }).map((r) => r.result)).toEqual(["current", "current"]);
    // Back to default: the block is today's again.
    refreshInboxNotes(dataDir, e, { config: {} });
    expect(read(CLAUDE_FILE())).toBe(`${INBOX_NOTE_BLOCK}\n`);
    expect(noteStatus("codex", dataDir, e, {}).state).toBe("added");
  });

  test("a note turned off gets nothing written; a removed block never comes back", () => {
    addInboxNote("claude-code", dataDir, e, undefined, { config: shared() });
    removeInboxNote("claude-code", dataDir, e);
    write(CODEX_FILE(), "Mine.\n");
    expect(refreshInboxNotes(dataDir, e, { config: shared(OTHER) })).toEqual([]);
    expect(read(CODEX_FILE())).toBe("Mine.\n");
  });

  test("config.json that cannot be read: nothing rewritten (a failed read is not \"no rules\")", () => {
    addInboxNote("claude-code", dataDir, e, undefined, { config: shared() });
    const before = read(CLAUDE_FILE());
    expect(refreshInboxNotes(dataDir, e, { config: null })).toEqual([]);
    expect(read(CLAUDE_FILE())).toBe(before);
    // The real read: config.json there but not JSON.
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    const configDir = join(fake.root, "config-data");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), '{ "prompts": { "inbox": { "rules": "half a write');
    process.env.PLANNOTATOR_DATA_DIR = configDir;
    try {
      expect(refreshInboxNotes(dataDir, e)).toEqual([]);
      expect(addInboxNote("claude-code", dataDir, e)).toMatchObject({ ok: false });
      expect(read(CLAUDE_FILE())).toBe(before);
      // Readable again (here: no rules at all): the refresh runs.
      writeFileSync(join(configDir, "config.json"), "{}");
      expect(refreshInboxNotes(dataDir, e).map((r) => r.result)).toEqual(["refreshed"]);
      expect(read(CLAUDE_FILE())).toBe(`${INBOX_NOTE_BLOCK}\n`);
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
    }
  });

  test("an edited note is left as the person wrote it, and Settings says so", () => {
    write(join(fake.bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(fake.bin, "claude"), 0o755);
    addInboxNote("claude-code", dataDir, e, undefined, { config: shared() });
    const edited = read(CLAUDE_FILE()).replace("Keep messages under ten lines.", "Keep messages under five lines.");
    write(CLAUDE_FILE(), edited);
    expect(refreshInboxNotes(dataDir, e, { config: shared(OTHER) })).toEqual([{ agent: "claude-code", path: realpathSync(CLAUDE_FILE()), result: "edited" }]);
    expect(read(CLAUDE_FILE())).toBe(edited);
    // Adding it again keeps it too (kept-edited), as for any edited note.
    expect(addInboxNote("claude-code", dataDir, e, undefined, { config: shared(OTHER) })).toMatchObject({ ok: true, action: "kept-edited" });
    expect(noteRulesStates(dataDir, e, shared(OTHER))?.["claude-code"]).toEqual({ why: "edited", fix: true });
  });

  test("a read-only or hard-linked file is left alone and reads as not updated", () => {
    write(join(fake.bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(fake.bin, "claude"), 0o755);
    addInboxNote("claude-code", dataDir, e, undefined, { config: shared() });
    const before = read(CLAUDE_FILE());
    chmodSync(CLAUDE_FILE(), 0o444);
    expect(refreshInboxNotes(dataDir, e, { config: shared(OTHER) }).map((r) => r.result)).toEqual(["read-only"]);
    expect(read(CLAUDE_FILE())).toBe(before);
    expect(noteRulesStates(dataDir, e, shared(OTHER))?.["claude-code"]).toEqual({ why: "stale", fix: true });
    chmodSync(CLAUDE_FILE(), 0o644);
    linkSync(CLAUDE_FILE(), file("dotfiles-copy.md"));
    expect(refreshInboxNotes(dataDir, e, { config: shared(OTHER) }).map((r) => r.result)).toEqual(["hard-linked"]);
    expect(read(CLAUDE_FILE())).toBe(before);
  });

  test("the auto path still skips a file that holds the note pasted without markers", () => {
    write(CODEX_FILE(), `Mine.\n\n${inboxNoteBodyWith(RULES)}\n`);
    const before = read(CODEX_FILE());
    expect(addInboxNote("codex", dataDir, e, undefined, { auto: true, config: shared() })).toMatchObject({ ok: false, skipped: true });
    expect(read(CODEX_FILE())).toBe(before);
  });

  test("an earlier version Plannotator wrote moves to this version with the rules in one write", () => {
    const v8 = INBOX_NOTE_EARLIER_BLOCKS[7]!;
    write(CODEX_FILE(), `Mine.\n\n${v8}\n`);
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "agent-notes.json"), JSON.stringify({ v: 1, notes: { codex: { path: realpathSync(CODEX_FILE()), created: false, version: 8, block_sha256: sha(v8), at: "2026-11-02T00:00:00.000Z" } } }));
    expect(refreshInboxNotes(dataDir, e, { config: shared() }).map((r) => r.result)).toEqual(["refreshed"]);
    expect(read(CODEX_FILE())).toBe(`Mine.\n\n${inboxNoteBlockWith(RULES)}\n`);
  });

  test("a record left ahead of its note (a crash between the two writes) still owns the block before", () => {
    addInboxNote("codex", dataDir, e, undefined, { config: shared() });
    // The refresh wrote the record for OTHER, then died before the note's rename.
    const notes = readInboxAgentNotes(dataDir).notes;
    writeFileSync(
      join(dataDir, "inbox", "agent-notes.json"),
      JSON.stringify({ v: 1, notes: { codex: { ...notes.codex, block_sha256: sha(inboxNoteBlockWith(OTHER)), prior_sha256: notes.codex!.block_sha256 } } }),
    );
    expect(noteStatus("codex", dataDir, e, shared(OTHER)).state).toBe("added");
    expect(refreshInboxNotes(dataDir, e, { config: shared(OTHER) }).map((r) => r.result)).toEqual(["refreshed"]);
    expect(read(CODEX_FILE())).toBe(`${inboxNoteBlockWith(OTHER)}\n`);
  });

  test("a block a newer Plannotator wrote is never rewritten by this one", () => {
    const newer = inboxNoteBlockWith(RULES).replace("start v9", "start v10");
    write(CODEX_FILE(), `${newer}\n`);
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "agent-notes.json"), JSON.stringify({ v: 1, notes: { codex: { path: realpathSync(CODEX_FILE()), created: true, version: 10, block_sha256: sha(newer), at: "2026-12-01T00:00:00.000Z" } } }));
    expect(refreshInboxNotes(dataDir, e, { config: shared(OTHER) }).map((r) => r.result)).toEqual(["edited"]);
    expect(read(CODEX_FILE())).toBe(`${newer}\n`);
  });

  test("a file two agents read carries the rules they share: Pi's own rules then go by its reminder", () => {
    mkdirSync(file(".codex"), { recursive: true });
    mkdirSync(file(".pi", "agent"), { recursive: true });
    addInboxNote("codex", dataDir, e, undefined, { config: shared() });
    symlinkSync(CODEX_FILE(), file(".pi", "agent", "AGENTS.md"));
    const config = { prompts: { inbox: { rules: RULES, runtimes: { pi: { rules: OTHER } } } } };
    expect(addInboxNote("pi", dataDir, e, undefined, { config })).toMatchObject({ ok: true });
    expect(read(CODEX_FILE())).toBe(`${inboxNoteBlockWith(RULES)}\n`);
    expect(refreshInboxNotes(dataDir, e, { config }).map((r) => r.result)).toEqual(["current", "current"]);
    expect(inboxReminderRulesFor(config, "pi", place())).toBe(OTHER);
  });
});

describe("the window's preview", () => {
  test("each agent's preview is what its file gets: a file two agents read shows the rules they share", () => {
    mkdirSync(file(".codex"), { recursive: true });
    mkdirSync(file(".pi", "agent"), { recursive: true });
    const config = { prompts: { inbox: { rules: RULES, runtimes: { pi: { rules: OTHER } } } } };
    expect(inboxNoteBlockFor("pi", dataDir, e, config)).toBe(inboxNoteBlockWith(OTHER));
    addInboxNote("codex", dataDir, e, undefined, { config });
    symlinkSync(CODEX_FILE(), file(".pi", "agent", "AGENTS.md"));
    addInboxNote("pi", dataDir, e, undefined, { config });
    expect(inboxNoteBlockFor("pi", dataDir, e, config)).toBe(read(CODEX_FILE()).trimEnd());
    expect(inboxNoteBlockFor("pi", dataDir, e, config)).toBe(inboxNoteBlockWith(RULES));
  });
});

describe("each agent gets its rules exactly once", () => {
  /** What one session of `host` reads: its note file as loaded, then its reminder. */
  const session = (host: "claude-code" | "pi" | "opencode", config: object, wakes = true) => {
    const note = inboxNoteFileOf(host, fake.env, fake.home);
    let fileText = "";
    try {
      fileText = note ? read(note) : "";
    } catch {
      // No file.
    }
    const rules = host === "claude-code" ? inboxReminderRulesAfterNote(inboxReminderRulesFor(config as never, host, { env: {}, homeDir: "/nonexistent" }), fileText || null) : inboxReminderRulesFor(config as never, host, place());
    return { fileText, reminder: resolveInboxReminderText(config as never, host, { wakes, rules }) };
  };
  const hosts = ["claude-code", "pi", "opencode"] as const;
  const noteFor = (host: (typeof hosts)[number], config: object) => {
    if (host === "opencode") write(file(".config", "opencode", "AGENTS.md"), "Mine.\n");
    if (host === "pi") mkdirSync(file(".pi", "agent"), { recursive: true });
    expect(addInboxNote(host, dataDir, e, undefined, { config }).ok).toBe(true);
  };

  for (const host of hosts) {
    test(`${host}: note with the rules → the reminder leaves them out, byte for byte today's line`, () => {
      noteFor(host, shared());
      const { fileText, reminder } = session(host, shared());
      expect(count(fileText + reminder, INBOX_RULES_LEAD)).toBe(1);
      expect(count(fileText + reminder, RULES)).toBe(1);
      expect(reminder).toBe(inboxReminderText(undefined, { wakes: true }));
    });

    test(`${host}: no note (never added, or turned off) → the reminder carries them, as before`, () => {
      expect(count(session(host, shared()).reminder, RULES)).toBe(1);
      noteFor(host, shared());
      removeInboxNote(host, dataDir, e);
      const { fileText, reminder } = session(host, shared());
      expect(count(fileText, RULES)).toBe(0);
      expect(reminder).toBe(`${inboxReminderText(undefined, { wakes: true })}\n\n${INBOX_RULES_LEAD}\n${RULES}`);
    });

    test(`${host}: a note with older rules (not updated yet) → the reminder carries the current ones`, () => {
      noteFor(host, shared(OTHER));
      const { fileText, reminder } = session(host, shared());
      expect(count(fileText + reminder, RULES)).toBe(1);
      expect(reminder.endsWith(`${INBOX_RULES_LEAD}\n${RULES}`)).toBe(true);
    });

    test(`${host}: a note edited so the rules are gone → the reminder carries them`, () => {
      noteFor(host, shared());
      const path = inboxNoteFileOf(host, fake.env, fake.home)!;
      write(path, read(path).replace(`\n\n${INBOX_RULES_LEAD}\n${RULES}`, ""));
      const { fileText, reminder } = session(host, shared());
      expect(count(fileText + reminder, RULES)).toBe(1);
    });
  }

  test("an agent's own rules: the note holds them and the reminder adds nothing", () => {
    noteFor("claude-code", withClaude);
    const { fileText, reminder } = session("claude-code", withClaude);
    expect(count(fileText + reminder, CLAUDE_ONLY)).toBe(1);
    expect(count(fileText + reminder, RULES)).toBe(0);
  });

  test("no rules: nothing read, the reminder and the note are today's", () => {
    noteFor("claude-code", {});
    const { fileText, reminder } = session("claude-code", {});
    expect(fileText).toBe(`${INBOX_NOTE_BLOCK}\n`);
    expect(reminder).toBe(inboxReminderText(undefined, { wakes: true }));
  });

  test("Codex and Gemini have no reminder: the note is their one way, with the shared rules", () => {
    mkdirSync(file(".codex"), { recursive: true });
    addInboxNote("codex", dataDir, e, undefined, { config: withClaude });
    addInboxNote("gemini", dataDir, e, undefined, { config: withClaude });
    for (const path of [CODEX_FILE(), file(".gemini", "GEMINI.md")]) {
      expect(count(read(path), RULES)).toBe(1);
      expect(read(path)).not.toContain(CLAUDE_ONLY);
    }
  });

  // Codex and Gemini CLI connected through MCP: their note, then the instructions one `initialize` on this computer's
  // `/mcp` gets (inbox.ts mcpForInitialize: inboxMcpReminderFor with `here`; inbox-mcp.ts builds them with the tier).
  const MCP_CLIENTS = { codex: { name: "codex-mcp-client", version: "0.165.0" }, gemini: { name: "gemini-cli-mcp-client", version: "0.0.1" } } as const;
  const mcpSession = (agent: keyof typeof MCP_CLIENTS, config: object, client: InboxMcpClient = MCP_CLIENTS[agent], here: InboxMcpHere | null = { dataDir, environment: () => e }) => {
    let fileText = "";
    try {
      fileText = read(noteTarget(agent, e).path!);
    } catch {
      // No file.
    }
    return { fileText, instructions: inboxMcpInstructions(inboxMcpReminderFor(config, client, here ?? undefined), inboxMcpTierOf(client)) };
  };
  const mcpNoteFor = (agent: keyof typeof MCP_CLIENTS, config: object) => {
    mkdirSync(file(agent === "codex" ? ".codex" : ".gemini"), { recursive: true });
    expect(addInboxNote(agent, dataDir, e, undefined, { config }).ok).toBe(true);
  };

  for (const agent of ["codex", "gemini"] as const) {
    test(`${agent} through MCP: note with the rules → the instructions leave them out, byte for byte the built-in ones`, () => {
      mcpNoteFor(agent, shared());
      const { fileText, instructions } = mcpSession(agent, shared());
      expect(count(fileText, RULES)).toBe(1);
      expect(count(fileText + instructions, INBOX_RULES_LEAD)).toBe(1);
      expect(count(fileText + instructions, RULES)).toBe(1);
      expect(instructions).toBe(INBOX_MCP_INSTRUCTIONS);
      // The person's reminder is not in the note: it stays in the instructions, the rules alone go.
      const withReminder = { prompts: { inbox: { rules: RULES, reminder: "Write to me in French." } } };
      mcpNoteFor(agent, withReminder);
      const both = mcpSession(agent, withReminder);
      expect(count(both.fileText + both.instructions, RULES)).toBe(1);
      expect(count(both.instructions, "Write to me in French.")).toBe(1);
    });

    test(`${agent} through MCP: no note (never added, or turned off) → the instructions carry them`, () => {
      expect(count(mcpSession(agent, shared()).instructions, RULES)).toBe(1);
      mcpNoteFor(agent, shared());
      removeInboxNote(agent, dataDir, e);
      const { fileText, instructions } = mcpSession(agent, shared());
      expect(count(fileText, RULES)).toBe(0);
      expect(instructions).toContain(`${INBOX_RULES_LEAD}\n${RULES}`);
    });

    test(`${agent} through MCP: a note with older rules → the instructions carry the current ones`, () => {
      mcpNoteFor(agent, shared(OTHER));
      const { fileText, instructions } = mcpSession(agent, shared());
      expect(count(fileText + instructions, RULES)).toBe(1);
      expect(instructions).toContain(`${INBOX_RULES_LEAD}\n${RULES}`);
    });

    test(`${agent} through MCP: a note edited so the rules are gone → the instructions carry them`, () => {
      mcpNoteFor(agent, shared());
      const path = noteTarget(agent, e).path!;
      write(path, read(path).replace(`\n\n${INBOX_RULES_LEAD}\n${RULES}`, ""));
      const { fileText, instructions } = mcpSession(agent, shared());
      expect(count(fileText + instructions, RULES)).toBe(1);
    });

    test(`${agent} through MCP: a connection that is not this computer's own /mcp (a cloud agent's door, a linked computer) → the instructions carry them`, () => {
      mcpNoteFor(agent, shared());
      // The note here says nothing about what an agent elsewhere read.
      expect(count(mcpSession(agent, shared(), MCP_CLIENTS[agent], null).instructions, RULES)).toBe(1);
    });
  }

  test("through MCP: a client the Inbox cannot tie to a note gets the rules, whatever the notes hold", () => {
    mcpNoteFor("codex", shared());
    mcpNoteFor("gemini", shared());
    for (const client of [
      { name: "Codex-MCP-Client" },
      { name: " gemini-cli-mcp-client" },
      { name: "qwen-cli-mcp-client-plannotator-inbox" },
      { name: "cursor-vscode" },
      { name: "claude-code", version: "2.1.323" },
      { name: "" },
      null,
    ]) {
      expect(count(mcpSession("codex", shared(), client).instructions, RULES)).toBe(1);
    }
  });

  test("the holds check reads the block only: the rules outside the markers do not count; CRLF and a BOM do not matter", () => {
    expect(inboxNoteHoldsRules(`${INBOX_NOTE_BLOCK}\n\n${INBOX_RULES_LEAD}\n${RULES}\n`, RULES)).toBe(false);
    expect(inboxNoteHoldsRules(`﻿Mine.\r\n\r\n${inboxNoteBlockWith(RULES).replace(/\n/g, "\r\n")}\r\n`, RULES)).toBe(true);
    expect(inboxNoteHoldsRules(`${inboxNoteBlockWith(RULES)}\n${inboxNoteBlockWith(RULES)}\n`, RULES)).toBe(false);
  });

  test("the hosts look in the very file the Inbox writes", () => {
    const env = { ...fake.env, CLAUDE_CONFIG_DIR: "~/claude-elsewhere", OPENCODE_CONFIG_DIR: "" };
    const other = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env });
    mkdirSync(file(".pi", "agent"), { recursive: true });
    write(file(".pi", "agent", "CLAUDE.md"), "Mine.\n");
    for (const agent of ["claude-code", "pi", "opencode"] as const) {
      for (const environment of [e, other]) {
        expect(inboxNoteFileOf(agent, environment.env, fake.home)).toBe(noteTarget(agent, environment).path);
      }
    }
  });
});

describe("Settings says who does not get them", () => {
  const wakes = { "claude-code": true, pi: true, opencode: true };
  const install = () => {
    write(join(fake.bin, "claude"), "#!/bin/sh\n");
    chmodSync(join(fake.bin, "claude"), 0o755);
    fake.install("codex", "gemini");
    mkdirSync(file(".cursor"), { recursive: true });
  };

  test("a note with the rules counts; no note and a reminder turned off do not; Cursor is never claimed either way", () => {
    install();
    mkdirSync(file(".codex"), { recursive: true });
    addInboxNote("codex", dataDir, e, undefined, { config: shared() });
    const notes = noteRulesStates(dataDir, e, shared())!;
    expect(notes).toEqual({ "claude-code": { why: "none", fix: true }, codex: "held", gemini: { why: "none", fix: true } });
    const on = { "claude-code": true, pi: true, opencode: true };
    expect(inboxRulesModel(shared(), wakes, { notes, on }).unsent).toEqual([{ agent: "gemini", slot: "shared", why: "none", fix: true }]);
    // Claude Code's reminder off and no note: not sent there either.
    expect(inboxRulesModel(shared(), wakes, { notes, on: { ...on, "claude-code": false } }).unsent?.map((u) => u.agent)).toEqual(["claude-code", "gemini"]);
  });

  test("an agent connected through MCP reads the rules in the MCP instructions: no line, unless they do not fit there or the reminder is off", () => {
    install();
    const notes = noteRulesStates(dataDir, e, shared())!;
    const on = { "claude-code": true, pi: true, opencode: true };
    // Codex and Gemini CLI with no note: "Not sent" while not connected through MCP, nothing for the one that is.
    expect(inboxRulesModel(shared(), wakes, { notes, on }).unsent?.map((u) => u.agent)).toEqual(["codex", "gemini"]);
    expect(inboxRulesModel(shared(), wakes, { notes, on, mcp: { gemini: true } }).unsent?.map((u) => u.agent)).toEqual(["codex"]);
    // The reminder off everywhere: the MCP instructions carry nothing of the person's, so the line is back.
    const off = { ...shared(), inboxReminder: false };
    expect(inboxRulesModel(off, wakes, { notes, on: { "claude-code": false, pi: false, opencode: false }, mcp: { gemini: true } }).unsent?.map((u) => u.agent)).toEqual(["claude-code", "codex", "gemini"]);
    // Rules past the MCP room of non-Claude clients: they do not go there, so the line stays.
    const long = shared("r".repeat(INBOX_MCP_RULES_ROOMS.other + 1));
    expect(inboxRulesModel(long, wakes, { notes, on, mcp: { gemini: true } }).unsent?.map((u) => u.agent)).toEqual(["codex", "gemini"]);
  });

  test("never a fix Settings → Agents does not have: no file to put it in, or notes turned off", () => {
    install();
    fake.install("opencode");
    // OpenCode with no AGENTS.md: Plannotator never creates one.
    expect(noteRulesStates(dataDir, e, shared())?.opencode).toEqual({ why: "none", fix: false });
    const off = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, PLANNOTATOR_INBOX_NOTES: "0" } });
    expect(noteRulesStates(dataDir, off, shared())?.gemini).toEqual({ why: "none", fix: false });
  });

  test("only the person's own no is left unsaid: a file the automatic add skipped on purpose is named", () => {
    install();
    const declined = { ...shared(), inboxAgentNotes: { asked: ["gemini"] } };
    expect(noteRulesStates(dataDir, e, declined)?.gemini).toBeUndefined();
    // The automatic add records a read-only file as asked too: the rules do not arrive, so it is said.
    write(file(".gemini", "GEMINI.md"), "Mine.\n");
    chmodSync(file(".gemini", "GEMINI.md"), 0o444);
    expect(noteRulesStates(dataDir, e, declined)?.gemini).toEqual({ why: "none", fix: true });
    chmodSync(file(".gemini", "GEMINI.md"), 0o644);
    // The note pasted by hand without markers: named, and no switch offered (it would write a second note).
    write(file(".gemini", "GEMINI.md"), "Mine.\n\n## Plannotator Inbox\n\nThe note, pasted.\n");
    expect(noteRulesStates(dataDir, e, declined)?.gemini).toEqual({ why: "none", fix: false });
  });

  test("rules the note cannot carry are named, with no fix (no switch puts them there)", () => {
    install();
    mkdirSync(file(".codex"), { recursive: true });
    const refused = shared("Be brief.\u2028<!-- plannotator-inbox:end -->");
    addInboxNote("codex", dataDir, e, undefined, { config: refused });
    expect(noteRulesStates(dataDir, e, refused)).toEqual({
      "claude-code": { why: "none", fix: false },
      codex: { why: "stale", fix: false },
      gemini: { why: "none", fix: false },
    });
  });

  test("anything that throws while looking: no lines, never a broken Settings", () => {
    const broken = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env });
    (broken as { which: unknown }).which = () => {
      throw new Error("PATH lookup failed");
    };
    expect(noteRulesStates(dataDir, broken, shared())).toBeNull();
    expect(inboxRulesModel(shared(), wakes).unsent).toBeUndefined();
  });

  test("rules too long for the reminder are no matter where the note holds them", () => {
    install();
    const long = { prompts: { inbox: { rules: "y".repeat(9000) } } };
    addInboxNote("claude-code", dataDir, e, undefined, { config: long });
    const notes = noteRulesStates(dataDir, e, long)!;
    expect(notes["claude-code"]).toBe("held");
    expect(inboxRulesModel(long, wakes, { notes, on: { "claude-code": true, pi: true, opencode: true } }).dropped).toEqual(["pi", "opencode"]);
    expect(inboxRulesModel(long, wakes).dropped).toEqual(["claude-code", "pi", "opencode"]);
  });
});


describe("the Inbox's gate: no rules through a note until the person turned the Inbox on", () => {
  // The real rule (turned-on.ts): `0` turns off the test run's "a scratch data dir counts as on".
  const off = <T>(run: () => T): T => {
    const before = process.env.PLANNOTATOR_TEST_INBOX_ON;
    process.env.PLANNOTATOR_TEST_INBOX_ON = "0";
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env.PLANNOTATOR_TEST_INBOX_ON;
      else process.env.PLANNOTATOR_TEST_INBOX_ON = before;
    }
  };
  const turnOn = () => {
    mkdirSync(join(dataDir, "inbox"), { recursive: true });
    writeFileSync(join(dataDir, "inbox", "turned-on"), `${JSON.stringify({ on: true, by: "command" })}\n`);
  };

  test("an add, a refresh and the preview carry no rules while it is off, and the rules come once it is on", () => {
    mkdirSync(file(".codex"), { recursive: true });
    off(() => {
      // `plannotator inbox --notes codex` before the Inbox was ever turned on: today's block, no rules.
      expect(addInboxNote("codex", dataDir, e, undefined, { config: shared() }).ok).toBe(true);
      expect(read(CODEX_FILE())).toBe(`${INBOX_NOTE_BLOCK}\n`);
      // A refresh with rules set writes nothing new, and the preview shows no rules.
      expect(refreshInboxNotes(dataDir, e, { config: shared() }).map((r) => r.result)).toEqual(["current"]);
      expect(read(CODEX_FILE())).toBe(`${INBOX_NOTE_BLOCK}\n`);
      expect(inboxNoteBlockFor("codex", dataDir, e, shared())).toBe(INBOX_NOTE_BLOCK);
    });
    expect(existsSync(join(dataDir, "inbox", "turned-on"))).toBe(false);
    // The person's own `plannotator inbox` writes the mark: from then on the note carries the rules, once.
    off(() => {
      turnOn();
      expect(refreshInboxNotes(dataDir, e, { config: shared() }).map((r) => r.result)).toEqual(["refreshed"]);
      expect(count(read(CODEX_FILE()), RULES)).toBe(1);
      expect(count(read(CODEX_FILE()), INBOX_RULES_LEAD)).toBe(1);
    });
  });

  test("while it is off, the MCP instructions are today's: they carry the rules even beside a note that holds them", () => {
    mkdirSync(file(".codex"), { recursive: true });
    // A note written while the Inbox was on, then the mark says off.
    expect(addInboxNote("codex", dataDir, e, undefined, { config: shared() }).ok).toBe(true);
    expect(count(read(CODEX_FILE()), RULES)).toBe(1);
    const client = { name: "codex-mcp-client", version: "0.165.0" };
    const here = { dataDir, environment: () => e };
    off(() => {
      mkdirSync(join(dataDir, "inbox"), { recursive: true });
      writeFileSync(join(dataDir, "inbox", "turned-on"), `${JSON.stringify({ on: false, by: "command" })}\n`);
      expect(inboxMcpReminderFor(shared(), client, here)).toEqual({ custom: null, rules: RULES });
      turnOn();
      expect(inboxMcpReminderFor(shared(), client, here)).toBeNull();
    });
  });
});
