/**
 * The Inbox's note that a session's questions moved to another thread (resolve_message's `moved_to`), as the link
 * Pi, Oh My Pi, OpenCode, Cline, DSH, OpenClaw and `plannotator inbox connection` share (agent-link.ts `InboxWake`)
 * puts it into the session. Pi vendors this file (tests/parity/vendor-parity.test.ts), and Pi's and OpenCode's
 * targets hand the text on as it is. The failures this guards: the note going in under the person's reply wrapper
 * ("This is a user reply … answer in the same thread", which would bring the archived thread back to the person),
 * or the notice line missing or not right under the first line.
 * A stand-in connection hands out the note: no Inbox, no server, no agent.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxAgentConnection, InboxWake, type InboxWakeTarget } from "./agent-link";
import { INBOX_BRIDGE_POLL_PATH, INBOX_MOVED_WAKE_INSTRUCTION, INBOX_WAKE_INSTRUCTION, type InboxReplyCommand } from "./connection";

const dirs: string[] = [];
const wakes: InboxWake[] = [];
afterEach(() => {
  for (const wake of wakes.splice(0)) wake.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOTE =
  'Your questions in "Retry policy" (msg_01THREAD) were moved to another thread by Claude Code: "Morning brief" (msg_01BRIEF). Don\'t wait on them here. The person answers there, and Claude Code gets the answer.';
const MOVED: InboxReplyCommand = {
  type: "reply",
  id: "msg_01NOTE",
  thread_id: "msg_01THREAD",
  reply_to: "msg_01THREAD",
  subject: "Retry policy",
  body: NOTE,
  url: "http://127.0.0.1:4100/#thread=msg_01THREAD",
  moved: true,
};

test("the shared link puts the moved note in as the Inbox's notice, never under the reply wrapper", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-agent-link-moved-"));
  dirs.push(dataDir);
  const connection = {
    dataDir,
    host: "pi",
    options: { env: {} },
    bridge: async (path: string) => ({ status: 200, text: JSON.stringify({ commands: path === INBOX_BRIDGE_POLL_PATH ? [MOVED] : [] }) }),
  } as unknown as InboxAgentConnection;
  const delivered: string[] = [];
  const target: InboxWakeTarget = { isBusy: () => false, deliver: async (text) => void delivered.push(text), notify: () => {} };
  const wake = new InboxWake(connection, "ses-sub", target, 5);
  wakes.push(wake);
  wake.start();
  for (let i = 0; i < 400 && delivered.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.split("\n")).toEqual(["Plannotator Inbox: Retry policy (msg_01NOTE)", INBOX_MOVED_WAKE_INSTRUCTION, "", NOTE, "", "[thread msg_01THREAD]"]);
  expect(delivered[0]).not.toContain(INBOX_WAKE_INSTRUCTION);
});
