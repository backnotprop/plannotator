/**
 * A plannotator_inbox call whose input never arrived as fields (an agent's
 * call with broken JSON quoting: the host hands it over empty, as one
 * leftover field, or with the rest of the call inside a value).
 *
 * What regresses if this fails: the agent is told "action must be one of …"
 * for a call it sent with a right action, looks for the wrong problem and
 * sends the same broken call again (a session did, four times); or a
 * readable call with a missing or wrong action stops getting the action list.
 */
import { expect, test } from "bun:test";
import { inboxToolCall, type InboxToolInfo } from "./connection";

const tools: InboxToolInfo[] = [
  {
    name: "send_message",
    description: "Post a message.",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" }, reply_to: { type: "string" }, supersedes: { type: "array", items: { type: "string" } }, project_path: { type: "string" } },
    },
  },
  { name: "read_thread", description: "Read.", inputSchema: { type: "object", properties: { thread_id: { type: "string" } } } },
];
const filled = { project_path: "/work/notes", agent_session: "ses_1", agent_host: "claude-code", agent_name: "Claude Code" };
const errorOf = (input: unknown) => {
  const call = inboxToolCall(input, tools, filled);
  return "error" in call ? call.error : null;
};
const UNREAD = "its input could not be read as fields";

test("input that never arrived as fields says to check the quoting, with a call that reads, not that the action is wrong", () => {
  const broken = [
    {},
    // One leftover field holding the raw call.
    { INVALID_JSON: '{"action": "send_message", "body": "Which one?", "supersedes": [msg_01/q-1]}' },
    // Only fields no Inbox tool takes.
    { input: "send_message", text: "hi" },
    // No action, and the rest of the call ran into a value.
    { body: 'Which one?", "supersedes": [msg_01/q-1' },
    // The action ran into the rest of the call.
    { action: 'send_message", "body": "Which one?' },
    "send_message",
    null,
    ["send_message"],
  ];
  for (const input of broken) {
    const error = errorOf(input)!;
    expect(error).toContain(UNREAD);
    expect(error).toContain('"supersedes": ["msg_…/q-…"]');
    expect(error).toContain("action is one of send_message, read_thread");
    expect(error).not.toContain("action must be one of");
  }
  // It says what did arrive.
  expect(errorOf({})).toContain("(it arrived empty)");
  expect(errorOf({ INVALID_JSON: "x" })).toContain('(it arrived as "INVALID_JSON")');
});

test("a readable call with no action, or a wrong one, still gets the action list", () => {
  for (const input of [{ body: "Which one?" }, { action: "sendmessage", body: "Which one?" }, { action: "", body: "x" }, { action: 7, body: "x" }]) {
    const error = errorOf(input)!;
    expect(error).toContain("action must be one of send_message, read_thread");
    expect(error).not.toContain(UNREAD);
  }
});

test("a call with an action goes through unchanged, JSON in its body included", () => {
  const body = 'The config reads {"retry": 3}; which value, "a", "b"?';
  expect(inboxToolCall({ action: "send_message", body, supersedes: ["msg_01/q-1"] }, tools, filled)).toEqual({
    name: "send_message",
    arguments: { body, supersedes: ["msg_01/q-1"], project_path: "/work/notes" },
  });
});
