import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxAgentConnection, InboxWake, type InboxWakeTarget } from "./agent-link";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_OFF_POLL_FIELD, INBOX_OFF_TOOL_TEXT, type InboxReplyCommand } from "./connection";
import { setInboxSessionOff } from "./session-off";

const dirs: string[] = [];
const wakes: InboxWake[] = [];
afterEach(() => {
  for (const wake of wakes.splice(0)) wake.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REPLY: InboxReplyCommand = {
  type: "reply",
  id: "msg_01REPLY",
  thread_id: "msg_01THREAD",
  reply_to: "msg_01ASK",
  subject: "quill-docs index",
  body: "Charlie Dunn says rebuild the quill-docs index first.",
  url: "http://127.0.0.1:4100/#thread=msg_01THREAD",
};

const until = async (what: () => boolean) => {
  for (let i = 0; i < 400 && !what(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(what()).toBe(true);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dataDirOf(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-agent-link-off-"));
  dirs.push(dataDir);
  return dataDir;
}

test("a session turned off keeps polling and saying so, and its reply waits; turned on, the reply goes in once", async () => {
  const dataDir = dataDirOf();
  setInboxSessionOff(dataDir, "ses-1", true);
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  let acked = false;
  const connection = {
    dataDir,
    host: "pi",
    options: { env: {} },
    bridge: async (path: string, _session: string, body: Record<string, unknown>) => {
      sent.push({ path, body });
      if (path === INBOX_BRIDGE_EVENT_PATH && body.type === "delivered") acked = true;
      return { status: 200, text: JSON.stringify({ commands: path === INBOX_BRIDGE_POLL_PATH && !acked ? [REPLY] : [] }) };
    },
  } as unknown as InboxAgentConnection;
  const delivered: string[] = [];
  const target: InboxWakeTarget = { isBusy: () => false, deliver: async (text) => void delivered.push(text), notify: () => {} };
  const wake = new InboxWake(connection, "ses-1", target, 5);
  wakes.push(wake);
  wake.start();
  const polls = () => sent.filter((entry) => entry.path === INBOX_BRIDGE_POLL_PATH).map((entry) => entry.body);

  await until(() => polls().length > 6);
  await sleep(50);
  expect(delivered).toEqual([]);
  expect(polls().slice(1).every((body) => body[INBOX_OFF_POLL_FIELD] === true)).toBe(true);

  setInboxSessionOff(dataDir, "ses-1", false);
  await until(() => delivered.length === 1);
  expect(delivered[0]).toContain(REPLY.body);
  expect(sent.some((entry) => entry.path === INBOX_BRIDGE_EVENT_PATH && entry.body.type === "state" && entry.body[INBOX_OFF_POLL_FIELD] === false)).toBe(true);
  await sleep(100);
  expect(delivered).toHaveLength(1);
});

test("a send from a session turned off is refused with the one line and reaches no Inbox", async () => {
  const dataDir = dataDirOf();
  setInboxSessionOff(dataDir, "ses-1", true);
  const connection = new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: [], env: {} });
  expect(await connection.callTool({ action: "send_message", body: "Ready?" }, { sessionId: "ses-1", cwd: dataDir })).toEqual({ text: INBOX_OFF_TOOL_TEXT, isError: true });
});
