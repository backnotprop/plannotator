/**
 * A call to an action the Inbox does not list (`inboxToolCall`, in the shared connection and its byte copy in the
 * Claude Code mod). What regresses: an Inbox that lists `capability` (so it has every action, and the switch is just
 * off) telling the agent to update Plannotator; an older Inbox (no `capability`) no longer told to update.
 */
import { expect, test } from "bun:test";
import { inboxToolCall, type InboxToolInfo } from "./connection";

const tool = (name: string): InboxToolInfo => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
const filled = { project_path: "/work/api", agent_session: "ses_1", agent_host: "claude-code", agent_name: "Claude Code" };
const errorOf = (action: string, tools: InboxToolInfo[]) => {
  const call = inboxToolCall({ action }, tools, filled);
  return "error" in call ? call.error : null;
};

test("an Inbox with the capability action: the action's capability is off, and the capability action turns it on", () => {
  const tools = [tool("send_message"), tool("capability")];
  expect(errorOf("routine", tools)).toBe("Invalid plannotator_inbox call: action must be one of send_message, capability (Routines are off in this Plannotator Inbox; the capability action turns them on when the person asks).");
  expect(errorOf("card", tools)).toContain("(the Board is off in this Plannotator Inbox; the capability action turns it on when the person asks)");
  expect(errorOf("steps", tools)).toContain("(the Checklist is off in this Plannotator Inbox;");
});

test("an older Inbox, without the capability action, is still to be updated for it", () => {
  expect(errorOf("routine", [tool("send_message")])).toBe("Invalid plannotator_inbox call: action must be one of send_message (this Plannotator Inbox has no routine; update Plannotator for it).");
  expect(errorOf("capability", [tool("send_message")])).toContain("(this Plannotator Inbox has no capability; update Plannotator for it)");
});
