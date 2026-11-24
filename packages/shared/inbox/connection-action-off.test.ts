/**
 * A call to an action the Inbox does not list (`inboxToolCall`, in the shared connection and its byte copy in the
 * Claude Code mod). What regresses: an Inbox that lists `capability` (so it has every action, and the switch was off
 * when this session's tools were listed) telling the agent to update Plannotator; the answer claiming the switch is
 * off now, when the person may have turned it on since (a session's list is made once, at its start); an older Inbox
 * (no `capability`) no longer told to update.
 */
import { expect, test } from "bun:test";
import { inboxToolCall, type InboxToolInfo } from "./connection";
import { inboxToolCall as modToolCall } from "../../../apps/hook/hooks/mod/inbox-contract";

const tool = (name: string): InboxToolInfo => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
const filled = { project_path: "/work/api", agent_session: "ses_1", agent_host: "claude-code", agent_name: "Claude Code" };
const errorOf = (action: string, tools: InboxToolInfo[], call: typeof inboxToolCall = inboxToolCall) => {
  const made = call({ action }, tools, filled);
  return "error" in made ? made.error : null;
};

test("an Inbox with the capability action: what works if it was turned on since, and that the capability action turns it on", () => {
  const tools = [tool("send_message"), tool("capability")];
  for (const call of [inboxToolCall, modToolCall as typeof inboxToolCall]) {
    const routine = errorOf("routine", tools, call)!;
    expect(routine).toStartWith("Invalid plannotator_inbox call: action must be one of send_message, capability (this session's tools were listed while Routines were off");
    expect(routine).toContain("`plannotator routine --help`");
    expect(routine).toContain("the capability action turns them on when the person asks");
    expect(routine).not.toContain("update Plannotator");
    expect(errorOf("card", tools, call)).toContain("`plannotator card --help`");
    expect(errorOf("steps", tools, call)).toContain("`plannotator inbox steps <thread> --json '<list>'`");
  }
});

test("an older Inbox, without the capability action, is still to be updated for it", () => {
  expect(errorOf("routine", [tool("send_message")])).toBe("Invalid plannotator_inbox call: action must be one of send_message (this Plannotator Inbox has no routine; update Plannotator for it).");
  expect(errorOf("capability", [tool("send_message")])).toContain("(this Plannotator Inbox has no capability; update Plannotator for it)");
});
