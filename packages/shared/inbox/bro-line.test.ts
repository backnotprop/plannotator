/**
 * Bro mode's line in the agent tool (approval "bro-mode"): `inboxAgentTool` replaces the running Inbox's long `body`
 * text with its own short words, so the line has to survive that.
 *
 * What regresses: Bro mode off changing a byte of what an agent reads; on, the line missing from the `body` field or
 * reaching any other field or the tool's description (which is near its limit).
 */
import { describe, expect, test } from "bun:test";
import { INBOX_AGENT_FIELD_DESCRIPTIONS, INBOX_BRO_LINE, inboxAgentTool, inboxBodyWithBro, type InboxToolInfo } from "./connection";

const SERVED_BODY = "The message, markdown. The Inbox's own long words for a raw MCP client.";

function tools(body: string): InboxToolInfo[] {
  return [
    {
      name: "send_message",
      description: "Message the person.",
      inputSchema: { type: "object", properties: { body: { type: "string", description: body }, thread: { type: "string", description: "A thread name." } } },
    },
    { name: "read_thread", description: "Read a thread.", inputSchema: { type: "object", properties: { thread_id: { type: "string", description: "A thread id." } } } },
  ];
}

const agentTool = (body: string) => inboxAgentTool(tools(body))!;
const bodyOf = (tool: ReturnType<typeof agentTool>) => (tool.inputSchema.properties as Record<string, { description: string }>).body!.description;

describe("the agent tool's body field", () => {
  test("off: the agent tool's own words, unchanged, and the line nowhere", () => {
    const off = agentTool(SERVED_BODY);
    expect(bodyOf(off)).toBe(`(send_message) ${INBOX_AGENT_FIELD_DESCRIPTIONS.send_message!.body!.trim()}`);
    expect(JSON.stringify(off)).not.toContain("jargon");
  });

  test("on: the line once, right after the field's first words, and everything else as it was off", () => {
    const off = agentTool(SERVED_BODY);
    const on = agentTool(inboxBodyWithBro(SERVED_BODY));
    expect(bodyOf(on).startsWith(`(send_message) The message, markdown. ${INBOX_BRO_LINE} `)).toBe(true);
    expect(bodyOf(on).split(INBOX_BRO_LINE).length - 1).toBe(1);
    expect(bodyOf(on).replace(`${INBOX_BRO_LINE} `, "")).toBe(bodyOf(off));
    expect(on.description).toBe(off.description);
    const { body: _onBody, ...onRest } = on.inputSchema.properties as Record<string, unknown>;
    const { body: _offBody, ...offRest } = off.inputSchema.properties as Record<string, unknown>;
    expect(onRest).toEqual(offRest);
  });
});
