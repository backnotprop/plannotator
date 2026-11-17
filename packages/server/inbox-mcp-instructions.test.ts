/**
 * The MCP server instructions with the person's own Inbox rules and reminder
 * configured (#3555). What regresses: an MCP session that never sees them (the
 * terminal path had them, MCP did not); a rule cut mid-text (rules are sent
 * whole or left out whole, as on the terminal path); a built-in line dropped
 * or reworded to make room; settings that say nothing about rules an MCP
 * session never got; or a build that busts Claude Code's 2,048-character cap
 * on server instructions. No Inbox is started: the MCP handler is built and
 * asked directly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "@plannotator/shared/config";
import { INBOX_AGENT_RULES, inboxRulesRoom, INBOX_RULES_LEAD } from "@plannotator/shared/inbox/connection";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import {
  INBOX_MCP_INSTRUCTIONS,
  INBOX_MCP_INSTRUCTIONS_MAX_CHARS,
  INBOX_MCP_RULES_ROOM,
  inboxMcpInstructions,
  inboxMcpSent,
  resolveInboxMcpReminder,
} from "./inbox-mcp-instructions";
import { inboxRulesModel } from "./inbox-rules";

const BUILT_IN = INBOX_MCP_INSTRUCTIONS.split("\n");
/** The two summary lines no tool description repeats. */
const OWN_LINES = BUILT_IN.filter((line) => line.startsWith("- send_message posts") || line.startsWith("- attachments:"));
const WAKES = { "claude-code": true, pi: true, opencode: true };

/** Every line that is not the person's text is a built-in line, word for word, or the rules' lead. */
function fixedLinesUnchanged(built: string, personText: string[]): void {
  const person = new Set(personText.flatMap((text) => text.split("\n")));
  for (const line of built.split("\n")) {
    if (person.has(line) || line === INBOX_RULES_LEAD) continue;
    expect([line, BUILT_IN.includes(line)]).toEqual([line, true]);
  }
}

describe("inboxMcpInstructions", () => {
  test("nothing set: exactly the built-in instructions, all five summary lines in them", () => {
    expect(inboxMcpInstructions(null)).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(inboxMcpInstructions(resolveInboxMcpReminder({ prompts: { inbox: { rules: "  ", reminder: "" } } }))).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(BUILT_IN.filter((line) => line.startsWith("- "))).toHaveLength(5);
    expect(OWN_LINES).toHaveLength(2);
    expect(INBOX_MCP_INSTRUCTIONS.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
  });

  test("rules that fit: whole, under the rules lead, after the built-in lines and before the attribution", () => {
    const rules = "Ask before deleting any file.\nKeep messages under five lines.";
    const built = inboxMcpInstructions({ custom: null, rules });
    expect(built).toContain(`${INBOX_RULES_LEAD}\n${rules}\n`);
    expect(built.indexOf(INBOX_AGENT_RULES)).toBeLessThan(built.indexOf(INBOX_RULES_LEAD));
    for (const line of OWN_LINES) expect(built).toContain(line);
    expect(built.endsWith(BUILT_IN.at(-1)!)).toBe(true);
    fixedLinesUnchanged(built, [rules]);
    expect(built.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
  });

  test("rules exactly the room fit; one character more and they are left out whole, never cut", () => {
    const fits = inboxMcpInstructions({ custom: null, rules: "r".repeat(INBOX_MCP_RULES_ROOM) });
    expect(fits).toContain("r".repeat(INBOX_MCP_RULES_ROOM));
    expect(fits.length).toBe(INBOX_MCP_INSTRUCTIONS_MAX_CHARS - 1);
    const long = `RULE-${"r".repeat(INBOX_MCP_RULES_ROOM - 4)}`;
    expect(inboxMcpSent({ custom: null, rules: long })).toEqual({ rules: false, reminder: false });
    const built = inboxMcpInstructions({ custom: null, rules: long });
    expect(built).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(built).not.toContain("RULE-");
    expect(built).not.toContain("[truncated]");
  });

  test("the reminder comes first, then the rules, each whole", () => {
    const custom = "Ping me when you are done.";
    const rules = "Ask before deleting any file.";
    const built = inboxMcpInstructions({ custom, rules });
    expect(built).toContain(`${custom}\n\n${INBOX_RULES_LEAD}\n${rules}\n`);
    for (const line of OWN_LINES) expect(built).toContain(line);
    fixedLinesUnchanged(built, [custom, rules]);
  });

  test("the rules win the room: a reminder that does not fit beside them is left out whole", () => {
    const custom = `CUSTOM-${"c".repeat(INBOX_MCP_RULES_ROOM)}`;
    const rules = "Ask before deleting any file.";
    expect(inboxMcpSent({ custom, rules })).toEqual({ rules: true, reminder: false });
    const built = inboxMcpInstructions({ custom, rules });
    expect(built).toContain(`${INBOX_RULES_LEAD}\n${rules}`);
    expect(built).not.toContain("CUSTOM-");
    for (const line of OWN_LINES) expect(built).toContain(line);
  });

  test("rules too long, a short reminder: the reminder alone, with no rules lead", () => {
    const built = inboxMcpInstructions({ custom: "Ping me when you are done.", rules: "r".repeat(INBOX_MCP_RULES_ROOM + 1) });
    expect(built).toContain("Ping me when you are done.");
    expect(built).not.toContain(INBOX_RULES_LEAD);
    for (const line of OWN_LINES) expect(built).toContain(line);
  });

  test("the room is far smaller than the terminal path's", () => {
    expect(INBOX_MCP_RULES_ROOM).toBeGreaterThan(200);
    expect(INBOX_MCP_RULES_ROOM * 10).toBeLessThan(inboxRulesRoom("Plannotator Inbox is on."));
  });
});

describe("which rules an MCP session follows", () => {
  test("the shared rules and reminder (Settings' All agents)", () => {
    expect(resolveInboxMcpReminder({ prompts: { inbox: { rules: " Ask first. ", reminder: "Ping me." } } })).toEqual({ custom: "Ping me.", rules: "Ask first." });
  });

  test("never one agent's own rules or reminder, an `mcp` entry written by hand included", () => {
    const runtimes = { "claude-code": { rules: "Claude rules.", reminder: "Claude reminder." }, mcp: { rules: "MCP rules.", reminder: "MCP reminder." } };
    expect(resolveInboxMcpReminder({ prompts: { inbox: { runtimes } } })).toBeNull();
    expect(resolveInboxMcpReminder({ prompts: { inbox: { rules: "Shared rules.", runtimes } } })).toEqual({ custom: null, rules: "Shared rules." });
  });

  test("no config: null, so the built-in instructions stand", () => {
    expect(resolveInboxMcpReminder({})).toBeNull();
    expect(resolveInboxMcpReminder(null)).toBeNull();
  });
});

describe("Settings → Prompts: the room and the note for agents connected through MCP", () => {
  test("rules that fit: the room, nothing left out", () => {
    const model = inboxRulesModel({ prompts: { inbox: { rules: "Ask before deleting any file." } } }, WAKES);
    expect(model.mcp).toEqual({ room: INBOX_MCP_RULES_ROOM, dropped: false, reminder_dropped: false });
  });

  test("rules past the MCP room but within the terminal room: saved and sent to the terminal hosts, marked left out for MCP", () => {
    const rules = "r".repeat(INBOX_MCP_RULES_ROOM + 1);
    const model = inboxRulesModel({ prompts: { inbox: { rules } } }, WAKES);
    expect(model.dropped).toEqual([]);
    expect(model.room.shared).toBeGreaterThan(rules.length);
    expect(model.mcp).toEqual({ room: INBOX_MCP_RULES_ROOM, dropped: true, reminder_dropped: false });
  });

  test("a reminder that does not fit beside the rules is marked left out; one agent's own rules never are", () => {
    const model = inboxRulesModel(
      { prompts: { inbox: { rules: "Ask first.", reminder: "c".repeat(INBOX_MCP_RULES_ROOM), runtimes: { pi: { rules: "p".repeat(2000) } } } } },
      WAKES,
    );
    expect(model.mcp).toEqual({ room: INBOX_MCP_RULES_ROOM, dropped: false, reminder_dropped: true });
  });

  test("nothing set: nothing marked", () => {
    expect(inboxRulesModel({}, WAKES).mcp).toEqual({ room: INBOX_MCP_RULES_ROOM, dropped: false, reminder_dropped: false });
  });
});

describe("a change in config.json reaches the next MCP connection", () => {
  let dir: string;
  let priorDataDir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pn-mcp-instructions-"));
    priorDataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dir;
  });
  afterEach(() => {
    if (priorDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = priorDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("each initialize reads config.json again, as the Inbox wires it", async () => {
    // The same wiring as the Inbox server's MCP context (inbox.ts), with no Inbox running.
    const context = { inboxReminder: () => resolveInboxMcpReminder(loadConfig({ quiet: true })) } as unknown as InboxMcpContext;
    const mcp = createMcpHandler(() => createInboxMcpServer(context), { legacy: "stateless" });
    const instructions = async (): Promise<string> => {
      const response = await mcp.fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
        }),
      );
      const text = await response.text();
      const json = text.trimStart().startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
      return (JSON.parse(json) as { result: { instructions: string } }).result.instructions;
    };
    expect(await instructions()).toBe(INBOX_MCP_INSTRUCTIONS);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ prompts: { inbox: { rules: "Ask before deleting any file." } } }));
    const first = await instructions();
    expect(first).toContain(`${INBOX_RULES_LEAD}\nAsk before deleting any file.`);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ prompts: { inbox: { rules: "Never delete anything." } } }));
    const second = await instructions();
    expect(second).toContain("Never delete anything.");
    expect(second).not.toContain("Ask before deleting any file.");
    writeFileSync(join(dir, "config.json"), JSON.stringify({}));
    expect(await instructions()).toBe(INBOX_MCP_INSTRUCTIONS);
  });
});
