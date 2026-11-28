/**
 * The MCP server instructions with the person's own Inbox rules and reminder
 * configured (#3555), sized to what the connecting client keeps. What
 * regresses: an MCP session that never sees them (the terminal path had them,
 * MCP did not); a rule cut mid-text (rules are sent whole or left out whole,
 * as on the terminal path); a built-in line dropped where the room allows all
 * five, or reworded; a client given more than it keeps (Claude Code cuts the
 * instructions at 4,096 characters, 2,048 before 2.1.296); settings that say
 * nothing about rules an MCP session never got. No Inbox is started: the MCP
 * handler is built and asked directly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "@plannotator/shared/config";
import { INBOX_AGENT_RULES, INBOX_REMINDER_MAX_CHARS, INBOX_RULES_LEAD } from "@plannotator/shared/inbox/connection";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import {
  INBOX_MCP_INSTRUCTIONS,
  INBOX_MCP_INSTRUCTIONS_MAX_CHARS,
  INBOX_MCP_RULES_ROOMS,
  INBOX_MCP_TIERS,
  inboxMcpInitializeClient,
  inboxMcpInstructions,
  inboxMcpSent,
  inboxMcpTierOf,
  resolveInboxMcpReminder,
  type InboxMcpClient,
  type InboxMcpTier,
} from "./inbox-mcp-instructions";
import { inboxRulesModel } from "./inbox-rules";

const BUILT_IN = INBOX_MCP_INSTRUCTIONS.split("\n");
const SUMMARY_LINES = BUILT_IN.filter((line) => line.startsWith("- "));
/** The two summary lines no tool description repeats. */
const OWN_LINES = SUMMARY_LINES.filter((line) => line.startsWith("- send_message posts") || line.startsWith("- attachments:"));
const WAKES = { "claude-code": true, pi: true, opencode: true };
/** What each tier's client keeps of the instructions (Claude Code's MCP doc); `other` has no known cut. */
const CAP: Record<InboxMcpTier, number> = { claude_code_old: 2048, claude_code: 4096, other: Number.POSITIVE_INFINITY };

const CLIENTS: Record<string, { client: InboxMcpClient; tier: InboxMcpTier }> = {
  "Claude Code 2.1.323": { client: { name: "claude-code", version: "2.1.323" }, tier: "claude_code" },
  "Claude Code 2.1.296": { client: { name: "claude-code", version: "2.1.296" }, tier: "claude_code" },
  "Claude Code 2.2.0": { client: { name: "claude-code", version: "2.2.0" }, tier: "claude_code" },
  "Claude Code 2.1.295": { client: { name: "claude-code", version: "2.1.295" }, tier: "claude_code_old" },
  "Claude Code 1.9.999": { client: { name: "claude-code", version: "1.9.999" }, tier: "claude_code_old" },
  "Claude Code, no version": { client: { name: "claude-code" }, tier: "claude_code_old" },
  "Claude Code, unreadable version": { client: { name: "claude-code", version: "dev" }, tier: "claude_code_old" },
  "Claude Code, other casing and spaces": { client: { name: "  Claude-Code ", version: "2.1.323" }, tier: "claude_code" },
  "Claude Code, written with a space": { client: { name: "Claude Code", version: "2.1.300" }, tier: "claude_code" },
  "Claude Code, written with a space, old": { client: { name: "claude code", version: "2.1.200" }, tier: "claude_code_old" },
  "Claude Desktop": { client: { name: "claude-ai", version: "0.1.0" }, tier: "claude_code_old" },
  "an unknown Claude app with a high version": { client: { name: "Claude Something", version: "9.9.9" }, tier: "claude_code_old" },
  "a name that only contains claude-code": { client: { name: "my-claude-code-wrapper", version: "2.1.323" }, tier: "claude_code_old" },
  "a blank name": { client: { name: "   ", version: "1.0.0" }, tier: "claude_code_old" },
  Codex: { client: { name: "codex-mcp-client", version: "0.130.0" }, tier: "other" },
  Cursor: { client: { name: "cursor-vscode", version: "1.0.0" }, tier: "other" },
  "a client with no name": { client: { version: "1.0.0" }, tier: "claude_code_old" },
  "no clientInfo": { client: null, tier: "claude_code_old" },
};

/** Every line that is not the person's text is a built-in line, word for word, or the rules' lead. */
function fixedLinesUnchanged(built: string, personText: string[]): void {
  const person = new Set(personText.flatMap((text) => text.split("\n")));
  for (const line of built.split("\n")) {
    if (person.has(line) || line === INBOX_RULES_LEAD) continue;
    expect([line, BUILT_IN.includes(line)]).toEqual([line, true]);
  }
}

describe("which tier a client is", () => {
  for (const [label, { client, tier }] of Object.entries(CLIENTS)) {
    test(label, () => expect(inboxMcpTierOf(client)).toBe(tier));
  }

  test("an initialize body gives its clientInfo; anything else is not an initialize", () => {
    const info = { name: "claude-code", version: "2.1.323" };
    expect(inboxMcpInitializeClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: info } })).toEqual(info);
    expect(inboxMcpInitializeClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toBeNull();
    expect(inboxMcpInitializeClient({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} })).toBeUndefined();
    expect(inboxMcpInitializeClient([{ method: "initialize" }])).toBeUndefined();
    expect(inboxMcpInitializeClient(undefined)).toBeUndefined();
  });
});

describe("inboxMcpInstructions, per tier", () => {
  test("nothing set: exactly the built-in instructions, all five summary lines, for every tier", () => {
    expect(SUMMARY_LINES).toHaveLength(5);
    expect(OWN_LINES).toHaveLength(2);
    expect(INBOX_MCP_INSTRUCTIONS.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
    for (const tier of INBOX_MCP_TIERS) {
      expect(inboxMcpInstructions(null, tier)).toBe(INBOX_MCP_INSTRUCTIONS);
      expect(inboxMcpInstructions(resolveInboxMcpReminder({ prompts: { inbox: { rules: "  ", reminder: "" } } }), tier)).toBe(INBOX_MCP_INSTRUCTIONS);
    }
  });

  test("the rooms: tightest for old Claude Code, the terminal path's cap where no cut is known", () => {
    expect(INBOX_MCP_RULES_ROOMS.claude_code_old).toBeLessThan(INBOX_MCP_RULES_ROOMS.claude_code);
    expect(INBOX_MCP_RULES_ROOMS.claude_code).toBeLessThan(INBOX_MCP_RULES_ROOMS.other);
    expect(INBOX_MCP_RULES_ROOMS.claude_code_old).toBeGreaterThan(200);
    expect(INBOX_MCP_RULES_ROOMS.other).toBe(INBOX_REMINDER_MAX_CHARS - INBOX_RULES_LEAD.length - 1);
  });

  for (const tier of INBOX_MCP_TIERS) {
    test(`${tier}: rules that fit are sent whole under the lead, after the built-in lines, before the attribution`, () => {
      const rules = "Ask before deleting any file.\nKeep messages under five lines.";
      const built = inboxMcpInstructions({ custom: null, rules }, tier);
      expect(built).toContain(`${INBOX_RULES_LEAD}\n${rules}\n`);
      expect(built.indexOf(INBOX_AGENT_RULES)).toBeLessThan(built.indexOf(INBOX_RULES_LEAD));
      expect(built.endsWith(BUILT_IN.at(-1)!)).toBe(true);
      fixedLinesUnchanged(built, [rules]);
      expect(built.length).toBeLessThan(CAP[tier]);
    });

    test(`${tier}: rules exactly the room fit; one character more and they are left out whole, never cut`, () => {
      const room = INBOX_MCP_RULES_ROOMS[tier];
      const fits = inboxMcpInstructions({ custom: null, rules: "r".repeat(room) }, tier);
      expect(fits).toContain(`${INBOX_RULES_LEAD}\n${"r".repeat(room)}\n`);
      if (CAP[tier] !== Number.POSITIVE_INFINITY) expect(fits.length).toBe(CAP[tier] - 1);
      const long = `RULE-${"r".repeat(room - 4)}`;
      expect(inboxMcpSent({ custom: null, rules: long }, tier)).toEqual({ rules: false, reminder: false });
      const built = inboxMcpInstructions({ custom: null, rules: long }, tier);
      expect(built).toBe(INBOX_MCP_INSTRUCTIONS);
      expect(built).not.toContain("[truncated]");
    });

    test(`${tier}: the reminder first, then the rules, each whole; a reminder past the room the rules leave is left out whole`, () => {
      const custom = "Ping me when you are done.";
      const rules = "Ask before deleting any file.";
      const built = inboxMcpInstructions({ custom, rules }, tier);
      expect(built).toContain(`${custom}\n\n${INBOX_RULES_LEAD}\n${rules}\n`);
      fixedLinesUnchanged(built, [custom, rules]);
      const long = `CUSTOM-${"c".repeat(INBOX_MCP_RULES_ROOMS[tier])}`;
      expect(inboxMcpSent({ custom: long, rules }, tier)).toEqual({ rules: true, reminder: false });
      expect(inboxMcpInstructions({ custom: long, rules }, tier)).not.toContain("CUSTOM-");
    });
  }

  test("a cap of 4,096 or more: all five summary lines, whatever is sent", () => {
    for (const tier of ["claude_code", "other"] as const) {
      const room = INBOX_MCP_RULES_ROOMS[tier];
      for (const reminder of [
        { custom: null, rules: "Ask first." },
        { custom: "Ping me.", rules: "Ask first." },
        { custom: "Ping me.", rules: "r".repeat(room) },
        { custom: "Ping me.", rules: "r".repeat(room + 1) },
      ]) {
        const built = inboxMcpInstructions(reminder, tier);
        for (const line of SUMMARY_LINES) expect([tier, line, built.includes(line)]).toEqual([tier, line, true]);
      }
    }
  });

  test("under 2,048: the two lines no tool repeats always stay; the other three step aside only while the person's text is sent", () => {
    const sent = inboxMcpInstructions({ custom: null, rules: "Ask first." }, "claude_code_old");
    for (const line of OWN_LINES) expect(sent).toContain(line);
    for (const line of SUMMARY_LINES.filter((line) => !OWN_LINES.includes(line))) expect(sent).not.toContain(line);
    const notSent = inboxMcpInstructions({ custom: null, rules: "r".repeat(INBOX_MCP_RULES_ROOMS.claude_code_old + 1) }, "claude_code_old");
    expect(notSent).toBe(INBOX_MCP_INSTRUCTIONS);
  });

  test("rules between the two Claude Code rooms: new Claude Code and other clients get them, old Claude Code does not", () => {
    const rules = "r".repeat(INBOX_MCP_RULES_ROOMS.claude_code_old + 1);
    expect(inboxMcpInstructions({ custom: null, rules }, "claude_code_old")).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(inboxMcpInstructions({ custom: null, rules }, "claude_code")).toContain(rules);
    expect(inboxMcpInstructions({ custom: null, rules }, "other")).toContain(rules);
    const longer = "r".repeat(INBOX_MCP_RULES_ROOMS.claude_code + 1);
    expect(inboxMcpInstructions({ custom: null, rules: longer }, "claude_code")).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(inboxMcpInstructions({ custom: null, rules: longer }, "other")).toContain(longer);
  });

  test("no tier given: the tightest, old Claude Code's", () => {
    const rules = "r".repeat(INBOX_MCP_RULES_ROOMS.claude_code_old + 1);
    expect(inboxMcpInstructions({ custom: null, rules })).toBe(INBOX_MCP_INSTRUCTIONS);
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

  test("the reminder switch off, as Settings → Agents or a shared false writes it: nothing of the person's, main's instructions byte for byte", () => {
    const text = { rules: "Ask first.", reminder: "Ping me." };
    for (const inboxReminder of [false, "false", { "claude-code": false, pi: false, opencode: false }]) {
      const config = { inboxReminder, prompts: { inbox: text } };
      expect(resolveInboxMcpReminder(config)).toBeNull();
      for (const tier of INBOX_MCP_TIERS) expect(inboxMcpInstructions(resolveInboxMcpReminder(config), tier)).toBe(INBOX_MCP_INSTRUCTIONS);
    }
  });

  test("the reminder on for any host with one, or unset: the person's text is sent", () => {
    for (const inboxReminder of [undefined, true, { "claude-code": false, pi: false }, { "claude-code": false, pi: false, opencode: true }]) {
      expect(resolveInboxMcpReminder({ inboxReminder, prompts: { inbox: { rules: "Ask first." } } })).toEqual({ custom: null, rules: "Ask first." });
    }
  });

  test("no config: null, so the built-in instructions stand", () => {
    expect(resolveInboxMcpReminder({})).toBeNull();
    expect(resolveInboxMcpReminder(null)).toBeNull();
  });
});

describe("Settings → Prompts: the room and the note for agents connected through MCP", () => {
  const ROOMS = { ...INBOX_MCP_RULES_ROOMS };
  const mcpOf = (config: object) => inboxRulesModel(config, WAKES).mcp;

  test("the count is current Claude Code's room; rules that fit everywhere: nothing left out", () => {
    expect(mcpOf({ prompts: { inbox: { rules: "Ask before deleting any file." } } })).toEqual({ room: ROOMS.claude_code, rooms: ROOMS, dropped: [], reminder_dropped: [] });
  });

  test("rules past old Claude Code's room: left out there only", () => {
    expect(mcpOf({ prompts: { inbox: { rules: "r".repeat(ROOMS.claude_code_old + 1) } } })?.dropped).toEqual(["claude_code_old"]);
  });

  test("rules past current Claude Code's room but within the terminal room: saved, sent to the terminal hosts and other MCP clients, left out for Claude Code", () => {
    const model = inboxRulesModel({ prompts: { inbox: { rules: "r".repeat(ROOMS.claude_code + 1) } } }, WAKES);
    expect(model.dropped).toEqual([]);
    expect(model.mcp?.dropped).toEqual(["claude_code_old", "claude_code"]);
  });

  test("a reminder that does not fit beside the rules is marked for the tiers it misses; one agent's own rules never count", () => {
    const model = mcpOf({ prompts: { inbox: { rules: "Ask first.", reminder: "c".repeat(ROOMS.claude_code), runtimes: { pi: { rules: "p".repeat(2000) } } } } });
    expect(model?.dropped).toEqual([]);
    expect(model?.reminder_dropped).toEqual(["claude_code_old", "claude_code"]);
  });

  test("the reminder switched off: no MCP note (nothing is sent), as the rules section says nothing of the switch on the terminal path", () => {
    const off = { "claude-code": false, pi: false, opencode: false };
    expect(mcpOf({ inboxReminder: off, prompts: { inbox: { rules: "r".repeat(ROOMS.claude_code + 1), reminder: "c".repeat(2000) } } })).toEqual({ room: ROOMS.claude_code, rooms: ROOMS, dropped: [], reminder_dropped: [] });
  });

  test("nothing set: nothing marked", () => {
    expect(mcpOf({})).toEqual({ room: ROOMS.claude_code, rooms: ROOMS, dropped: [], reminder_dropped: [] });
  });
});

describe("over MCP: each initialize is sized to its client and reads config.json again", () => {
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

  // The same wiring as the Inbox server's /mcp route (inbox.ts), with no Inbox running.
  const context = { inboxReminder: () => resolveInboxMcpReminder(loadConfig({ quiet: true })) } as unknown as InboxMcpContext;
  const instructions = async (clientInfo: InboxMcpClient): Promise<string> => {
    const body = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, ...(clientInfo ? { clientInfo } : {}) } };
    const mcp = createMcpHandler(() => createInboxMcpServer({ ...context, mcpClient: inboxMcpInitializeClient(body) }), { legacy: "stateless" });
    const response = await mcp.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    const json = text.trimStart().startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    return (JSON.parse(json) as { result: { instructions: string } }).result.instructions;
  };

  test("a config change reaches the next connection", async () => {
    const codex = { name: "codex-mcp-client", version: "0.130.0" };
    expect(await instructions(codex)).toBe(INBOX_MCP_INSTRUCTIONS);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ prompts: { inbox: { rules: "Ask before deleting any file." } } }));
    expect(await instructions(codex)).toContain(`${INBOX_RULES_LEAD}\nAsk before deleting any file.`);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ prompts: { inbox: { rules: "Never delete anything." } } }));
    const second = await instructions(codex);
    expect(second).toContain("Never delete anything.");
    expect(second).not.toContain("Ask before deleting any file.");
    writeFileSync(join(dir, "config.json"), JSON.stringify({}));
    expect(await instructions(codex)).toBe(INBOX_MCP_INSTRUCTIONS);
  });

  test("the same rules reach each client as much as it keeps", async () => {
    const rules = "r".repeat(INBOX_MCP_RULES_ROOMS.claude_code_old + 1);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ prompts: { inbox: { rules } } }));
    expect(await instructions({ name: "claude-code", version: "2.1.295" })).toBe(INBOX_MCP_INSTRUCTIONS);
    // A client that does not say who it is (the protocol needs clientInfo, so a blank name).
    expect(await instructions({ name: "", version: "1.0.0" })).toBe(INBOX_MCP_INSTRUCTIONS);
    // Claude Desktop, or any Claude app we do not know: the safe 2,048 tier.
    expect(await instructions({ name: "claude-ai", version: "0.1.0" })).toBe(INBOX_MCP_INSTRUCTIONS);
    const current = await instructions({ name: "claude-code", version: "2.1.323" });
    expect(current).toContain(rules);
    expect(current.length).toBeLessThan(4096);
    for (const line of SUMMARY_LINES) expect(current).toContain(line);
    expect(await instructions({ name: "codex-mcp-client", version: "0.130.0" })).toContain(rules);
  });
});
