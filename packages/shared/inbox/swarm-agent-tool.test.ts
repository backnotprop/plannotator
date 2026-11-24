/**
 * Swarm mode as every connection carries it. The failures these guard: the swarm block missing from what an agent
 * receives for a swarm thread's first message (or naming the reader as one of the others, or riding a plain thread);
 * the contract's copies of the swarm words drifting from swarm-words.ts (the contract imports nothing); a hosted
 * Inbox's 429 for `swarm` reaching the agent as an error; a look classed as a write (it would wait at the relay); and
 * the bundled agent tool losing the action or passing Claude Code's 2,048 characters.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_DEFAULT_TOOLS } from "../../../apps/hook/hooks/mod/inbox-default-tools";
import { isInboxAgentWrite } from "./agent-relay-client";
import { INBOX_AGENT_ACTION_LEADS, INBOX_AGENT_FIELD_DESCRIPTIONS, INBOX_SWARM_BUSY_RESULT_TEXT, inboxAgentTool, inboxToolResultText, mcpAnswerOfResponse } from "./connection";
import { INBOX_SWARM_ACTION_LINE, INBOX_SWARM_BUSY_TEXT, INBOX_SWARM_FIELD_DESCRIPTIONS, inboxSwarmStartBlock } from "./swarm-words";
import { inboxBodyForAgent } from "./uploads";

const ROOT = {
  id: "msg_01K7SWARMROOT000000000000",
  thread_id: "msg_01K7SWARMROOT000000000000",
  body: "Split the retry work between you.",
  swarm: true as const,
  to: { host: "claude-code", session: "ses_cc" },
  tags: [
    { host: "pi", session: "ses_pi" },
    { host: "codex", session: "ses_cx" },
  ],
};

describe("the swarm block", () => {
  test("each agent a swarm root goes to reads it after the words, naming the others and not itself", () => {
    const forPi = inboxBodyForAgent(ROOT, [], null, "ses_pi");
    expect(forPi).toBe(`${ROOT.body}\n\n${inboxSwarmStartBlock(ROOT.thread_id, ["Claude Code", "Codex"])}`);
    expect(inboxBodyForAgent(ROOT, [], null, "ses_cc")).toBe(`${ROOT.body}\n\n${inboxSwarmStartBlock(ROOT.thread_id, ["Pi", "Codex"])}`);
  });

  test("with no reader known it names every agent of the root; a plain root and a reply carry none", () => {
    expect(inboxBodyForAgent(ROOT)).toBe(`${ROOT.body}\n\n${inboxSwarmStartBlock(ROOT.thread_id, ["Claude Code", "Pi", "Codex"])}`);
    const { swarm: _off, ...plain } = ROOT;
    expect(inboxBodyForAgent(plain, [], null, "ses_pi")).toBe(ROOT.body);
    expect(inboxBodyForAgent({ ...ROOT, id: "msg_01K7SWARMREPLY00000000000" }, [], null, "ses_pi")).toBe(ROOT.body);
  });
});

describe("the swarm action on every connection", () => {
  test("the contract's copies are swarm-words.ts's words exactly", () => {
    expect(INBOX_AGENT_ACTION_LEADS.swarm).toBe(INBOX_SWARM_ACTION_LINE);
    expect(INBOX_AGENT_FIELD_DESCRIPTIONS.swarm).toEqual(INBOX_SWARM_FIELD_DESCRIPTIONS);
    expect(INBOX_SWARM_BUSY_RESULT_TEXT).toBe(INBOX_SWARM_BUSY_TEXT);
  });

  test("a 429 for swarm is a plain result with the busy words; for any other action it is not", () => {
    const answer = mcpAnswerOfResponse(429, "Too Many Requests", "swarm");
    expect(answer?.error).toBeUndefined();
    expect(inboxToolResultText(answer?.result)).toEqual({ text: INBOX_SWARM_BUSY_TEXT, isError: false });
    expect(mcpAnswerOfResponse(429, "Too Many Requests", "send_message")).toBeNull();
  });

  test("only a call with a line is a write", () => {
    expect(isInboxAgentWrite("swarm", { thread_id: "msg_1", doing: "Writing tests" })).toBe(true);
    expect(isInboxAgentWrite("swarm", { thread_id: "msg_1" })).toBe(false);
    expect(isInboxAgentWrite("swarm", { thread_id: "msg_1", doing: " " })).toBe(false);
  });

  test("the bundled agent tool has the action and its doing field, inside Claude Code's 2,048 characters", () => {
    const spec = inboxAgentTool(INBOX_DEFAULT_TOOLS)!;
    const properties = spec.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(properties.action!.enum).toContain("swarm");
    expect(properties.doing!.description).toBe(`(swarm) ${INBOX_SWARM_FIELD_DESCRIPTIONS.doing}`);
    expect(spec.description.length).toBeLessThan(2_048);
  });
});
