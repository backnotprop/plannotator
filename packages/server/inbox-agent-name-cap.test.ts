/**
 * An agent's name is capped where the Inbox takes it (design record
 * "inbox-toasts-break-fixes": names are capped at 40 characters in the server
 * and the UI): send_message and card store at most 40, cut with "…". The name
 * is only shown and searched, so two agents whose names cut alike stay two
 * (the session owns the thread). Through the real MCP door on a scratch Inbox.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_AGENT_NAME_SHORT_MAX } from "@plannotator/core/inbox-format";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const chars = (text: string) => Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)).length;

test("a 60-character agent name is stored cut to 40 with an ellipsis; a 40-character one whole; two cut alike stay two threads", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-name-cap-")));
  roots.push(root);
  const project = join(root, "plannotator");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-name-cap-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (session: string, name: string) =>
    (
      (await client.callTool({
        name: "send_message",
        arguments: { project_path: project, agent_session: session, agent_name: name, agent_host: "claude-code", body: `From ${session}.` },
      })) as { structuredContent: { thread_id: string; message_id: string } }
    ).structuredContent;

  const long = "Claude Code (worktree agent-a0316994da8440ab5) on the laptop"; // 60 characters
  expect(chars(long)).toBe(60);
  const a = await send("ses_a", long);
  const b = await send("ses_b", `${long} two`);
  const stored = server.store.thread(a.thread_id)!.messages[0]!.author.name!;
  expect(chars(stored)).toBeLessThanOrEqual(INBOX_AGENT_NAME_SHORT_MAX);
  expect(stored.endsWith("…")).toBe(true);
  expect(long.startsWith(stored.slice(0, -1))).toBe(true);
  // Both names cut to the same 40 characters; the sessions keep the agents apart.
  expect(server.store.thread(b.thread_id)!.messages[0]!.author.name).toBe(stored);
  expect(b.thread_id).not.toBe(a.thread_id);

  const forty = "Claude Code (worktree agent-a0316994da8)";
  expect(chars(forty)).toBe(40);
  const c = await send("ses_c", forty);
  expect(server.store.thread(c.thread_id)!.messages[0]!.author.name).toBe(forty);
});
