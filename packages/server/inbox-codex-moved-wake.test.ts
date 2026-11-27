/**
 * The Inbox's note that a session's questions moved to another thread (resolve_message's `moved_to`), as the wakes
 * the Inbox itself hands to an agent (Codex, T3 Code, Qwen and Antigravity all queue `codexQueueMessage`) word it.
 * The failure this guards: the note going in under the person's reply wrapper ("This is a user reply … answer in
 * the same thread", which would bring the archived thread back to the person), or the notice line missing or not
 * right under the first line. Pure text: no Inbox, no server, no agent.
 */
import { expect, test } from "bun:test";
import { INBOX_MOVED_WAKE_INSTRUCTION, INBOX_WAKE_INSTRUCTION, type InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { codexQueueMessage } from "./inbox-codex-wake";

const NOTE =
  'Your questions in "Retry policy" (msg_01THREAD) were moved to another thread by Claude Code: "Morning brief" (msg_01BRIEF). Don\'t wait on them here. The person answers there, and Claude Code gets the answer.';

test("the wakes the Inbox hands itself queue the moved note as the Inbox's notice, never under the reply wrapper", () => {
  const command: InboxReplyCommand = { type: "reply", id: "msg_01NOTE", thread_id: "msg_01THREAD", reply_to: "msg_01THREAD", subject: "Retry policy", body: NOTE, url: "u", moved: true };
  const text = codexQueueMessage(command);
  expect(text.split("\n")).toEqual(["Plannotator Inbox: Retry policy (msg_01NOTE)", INBOX_MOVED_WAKE_INSTRUCTION, "", NOTE, "", "[thread msg_01THREAD]"]);
  expect(text).not.toContain(INBOX_WAKE_INSTRUCTION.split(":")[0]!);
});
