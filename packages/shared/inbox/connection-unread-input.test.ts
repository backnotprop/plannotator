import { expect, test } from "bun:test";
import { inboxResultWithNote, inboxToolCall, INBOX_UNPARSED_INPUT_KEY, type InboxToolInfo } from "./connection";

const tools: InboxToolInfo[] = [
  {
    name: "send_message",
    description: "Post a message.",
    inputSchema: {
      type: "object",
      properties: { body: { type: "string" }, thread: { type: "string" }, reply_to: { type: "string" }, supersedes: { type: "array", items: { type: "string" } }, project_path: { type: "string" } },
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
    { INVALID_JSON: '{"action": "send_message", "body": "Which one?", "supersedes": [msg_01/q-1]}' },
    { input: "send_message", text: "hi" },
    { body: 'Which one?", "supersedes": [msg_01/q-1' },
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

// Claude Code's wrapper for a call whose JSON it could not parse: the model's text, cut at 2,048, and its length.
const unparsed = (raw: string, len = raw.length) => ({ [INBOX_UNPARSED_INPUT_KEY]: { raw: raw.slice(0, 2048), len } });
const MSG = "msg_01M6WCD0P8Y4P59PRG9G0PA7VG";
const BODY = ":::question\\nWhich cache do we keep?\\n\\n- [ ] Disk\\n- [ ] Memory\\n\\nRecommended: Disk\\n:::";

test("a bare id the host could not parse is quoted, the call runs, and the result says what was read", () => {
  const raw = `{"action": "send_message", "reply_to": "${MSG}", "supersedes": ${MSG}/q-41d641f8, "body": "${BODY}"}`;
  expect(() => JSON.parse(raw)).toThrow();
  const call = inboxToolCall(unparsed(raw), tools, filled);
  expect(call).toEqual({
    name: "send_message",
    arguments: { reply_to: MSG, supersedes: [`${MSG}/q-41d641f8`], body: JSON.parse(`"${BODY}"`), project_path: "/work/notes" },
    note: `Your call's JSON had an unquoted value (supersedes); it was read as ["${MSG}/q-41d641f8"]. Quote every string value.`,
  });
  expect(inboxResultWithNote("Sent.", "note" in call ? call.note : undefined)).toBe(`Sent.\n\n${"note" in call ? call.note : ""}`);
  const list = inboxToolCall(unparsed(`{"action": send_message, "reply_to": "${MSG}", "supersedes": [${MSG}/q-41d641f8, ${MSG}], "body": "x"}`), tools, filled);
  expect("arguments" in list && list.arguments.supersedes).toEqual([`${MSG}/q-41d641f8`, MSG]);
  expect(inboxToolCall(unparsed(`{"action": "read_thread", "thread_id": "${MSG}"}`), tools, filled)).toEqual({ name: "read_thread", arguments: { thread_id: MSG } });
});

test("anything else the host could not parse is refused at its spot, never with the action list", () => {
  const raw = `{"action": "send_message", "thread": sync-work, "body": "${BODY}"}`;
  const error = errorOf(unparsed(raw))!;
  expect(error).toContain(`couldn't be read at character ${raw.indexOf("sync-work")}:`);
  expect(error).toContain('"thread": sync-work ← this value needs double quotes. Fix that spot and call again.');
  expect(error).not.toContain("action must be one of");
  const quote = `{"action": "send_message", "body": "He said "ship it" today"}`;
  expect(errorOf(unparsed(quote))).toContain(`at character ${quote.indexOf("ship it")}:`);
  expect(errorOf(unparsed(quote))).toContain("a double quote inside body needs a backslash");
});

test("a call the host cut short says how long it was, how much arrived, and which field it broke in", () => {
  const long = `{"action": "send_message", "reply_to": "${MSG}", "body": "${"The cache keeps every page for a day. ".repeat(80)}\\"oops"}`;
  const error = errorOf(unparsed(long, long.length))!;
  expect(error).toContain(`this call was ${long.length} characters and only the first 2048 arrived readable; the JSON breaks inside body.`);
  expect(error).toContain("or send a shorter body and attach the rest as a file");
  const early = `{"action": "send_message", "thread": sync-work, "body": "${"x".repeat(3000)}"}`;
  expect(errorOf(unparsed(early, early.length))).toContain(`at character ${early.indexOf("sync-work")}`);
});
