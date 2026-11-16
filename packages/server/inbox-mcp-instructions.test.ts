/**
 * The MCP server instructions with the person's own Inbox rules and reminder
 * configured (#3555): what regresses is an MCP session that never sees them
 * (the terminal path had them, MCP did not), or a build that busts Claude
 * Code's 2,048-character cap on server instructions.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_AGENT_RULES, INBOX_RULES_LEAD } from "@plannotator/shared/inbox/connection";
import { INBOX_MCP_INSTRUCTIONS, INBOX_MCP_INSTRUCTIONS_MAX_CHARS, inboxMcpInstructions, resolveInboxMcpReminder } from "./inbox-mcp";

const INTRO = "Plannotator Inbox: a local window where the person reads what you send and answers later; nothing blocks.";
const ATTRIBUTION = "A reply is the person's own: their words, then \"Answers to your questions\"; no tool answers or approves for them.";
const SUMMARY = "A guided review of a code change: get_guide_brief, write the guide, then submit_guide with the exact patch.";

describe("inboxMcpInstructions", () => {
  test("nothing configured: exactly the built-in instructions", () => {
    expect(inboxMcpInstructions(null)).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(INBOX_MCP_INSTRUCTIONS.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
  });

  test("rules only: the rules replace the summary lines", () => {
    const built = inboxMcpInstructions({ custom: null, rules: "Always ask before deleting." });
    expect(built.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
    expect(built).toContain(INTRO);
    expect(built).toContain(INBOX_AGENT_RULES);
    expect(built).toContain(INBOX_RULES_LEAD);
    expect(built).toContain("Always ask before deleting.");
    expect(built).toContain(ATTRIBUTION);
    expect(built).not.toContain(SUMMARY);
  });

  test("custom and rules: the person's text first, then the rules", () => {
    const built = inboxMcpInstructions({ custom: "Ping me when done.", rules: "Always ask before deleting." });
    expect(built.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
    expect(built).toContain("Ping me when done.");
    expect(built).toContain("Always ask before deleting.");
    expect(built.indexOf("Ping me when done.")).toBeLessThan(built.indexOf("Always ask before deleting."));
    expect(built).not.toContain(SUMMARY);
  });

  test("custom only: the reminder, no rules lead", () => {
    const built = inboxMcpInstructions({ custom: "Ping me when done.", rules: null });
    expect(built.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
    expect(built).toContain("Ping me when done.");
    expect(built).not.toContain(INBOX_RULES_LEAD);
    expect(built).not.toContain(SUMMARY);
  });

  test("both do not fit: the rules win the room, the reminder is dropped", () => {
    const built = inboxMcpInstructions({ custom: `CUSTOM-${"x".repeat(2000)}`, rules: "Short rule." });
    expect(built.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
    expect(built).toContain("Short rule.");
    expect(built).not.toContain("CUSTOM-");
    expect(built).not.toContain("… [truncated]");
  });

  test("rules alone do not fit: cut with a marker the model sees", () => {
    const rules = `RULE-${"r".repeat(3000)}`;
    const built = inboxMcpInstructions({ custom: null, rules });
    expect(built.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
    expect(built).toContain(INBOX_RULES_LEAD);
    expect(built).toContain(`RULE-${"r".repeat(100)}`);
    expect(built).toContain("… [truncated]");
    expect(built).not.toContain(rules);
  });

  test("a long reminder alone: cut with a marker, never dropped silently", () => {
    const built = inboxMcpInstructions({ custom: `CUSTOM-${"c".repeat(3000)}`, rules: null });
    expect(built.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
    expect(built).toContain("CUSTOM-");
    expect(built).toContain("… [truncated]");
  });

  test("rules that fit stay whole, rules past the room are cut", () => {
    const fits = inboxMcpInstructions({ custom: null, rules: "r".repeat(700) });
    expect(fits).not.toContain("… [truncated]");
    expect(fits.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
    const cut = inboxMcpInstructions({ custom: null, rules: "r".repeat(900) });
    expect(cut).toContain("… [truncated]");
    expect(cut.length).toBeLessThan(INBOX_MCP_INSTRUCTIONS_MAX_CHARS);
  });
});

describe("resolveInboxMcpReminder", () => {
  test("the shared rules and reminder govern MCP sessions", () => {
    expect(resolveInboxMcpReminder({ prompts: { inbox: { rules: "Ask first.", reminder: "Ping me." } } })).toEqual({
      custom: "Ping me.",
      rules: "Ask first.",
    });
  });

  test("a runtimes.mcp entry wins over the shared text, per field", () => {
    expect(
      resolveInboxMcpReminder({
        prompts: { inbox: { rules: "Shared rules.", reminder: "Shared reminder.", runtimes: { mcp: { rules: "MCP rules." } } } },
      }),
    ).toEqual({ custom: "Shared reminder.", rules: "MCP rules." });
  });

  test("another host's runtimes do not govern MCP", () => {
    expect(resolveInboxMcpReminder({ prompts: { inbox: { runtimes: { "claude-code": { rules: "Claude rules.", reminder: "Claude reminder." } } } } })).toBeNull();
  });

  test("blank text and no config: null, so the built-in instructions stand", () => {
    expect(resolveInboxMcpReminder({})).toBeNull();
    expect(resolveInboxMcpReminder({ prompts: { inbox: { rules: "  ", reminder: "" } } })).toBeNull();
    expect(resolveInboxMcpReminder(null)).toBeNull();
  });
});
