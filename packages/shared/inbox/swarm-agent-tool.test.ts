/**
 * Swarm mode as every connection carries it. The failures these guard: the `/swarm` skill's text cut from, or a block
 * added after it in, what an agent receives for the message that carries it; the contract's copies of the swarm words drifting from swarm-words.ts (the contract imports nothing); a hosted
 * Inbox's 429 for `swarm` reaching the agent as an error; a look classed as a write (it would wait at the relay); and
 * the bundled agent tool losing the action or passing Claude Code's 2,048 characters.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_DEFAULT_TOOLS } from "../../../apps/hook/hooks/mod/inbox-default-tools";
import { isInboxAgentWrite } from "./agent-relay-client";
import { INBOX_AGENT_ACTION_LEADS, INBOX_AGENT_FIELD_DESCRIPTIONS, INBOX_SWARM_BUSY_RESULT_TEXT, inboxAgentTool, inboxToolResultText, mcpAnswerOfResponse } from "./connection";
import { INBOX_SWARM_ACTION_LINE, INBOX_SWARM_BUSY_TEXT, INBOX_SWARM_FIELD_DESCRIPTIONS } from "./swarm-words";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { composeInboxSkillsBlock } from "@plannotator/core/inbox-skills-compose";
import { INBOX_MESSAGE_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import { SWARM_SKILL, swarmSkill } from "@plannotator/core/swarm-skill";
import { inboxBodyForAgent } from "./uploads";

describe("the /swarm skill reaches each agent in the message itself", () => {
  test("what an agent receives is the person's words with the skill's text, whole, and nothing added after it", () => {
    const ref = { name: SWARM_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true };
    const text = swarmSkill(ref.name, { agents: ["Claude Code (billing)", "Pi (billing)"] })!.body;
    const block = composeInboxSkillsBlock([ref], new Map([[ref.name, { content: text, truncated: false, dir: "", path: "" }]]), INBOX_MESSAGE_SKILL_AUDIENCE);
    const body = `Split the retry work between you.\n\n${block}`;
    const message = { id: "msg_01K7SWARMROOT000000000000", thread_id: "msg_01K7SWARMROOT000000000000", body };
    expect(inboxBodyForAgent(message)).toBe(body);
    expect(inboxBodyForAgent(message)).toContain(text.trim());
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
