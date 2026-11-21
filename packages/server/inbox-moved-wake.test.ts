/**
 * The note that tells a sub-agent its questions moved (resolve_message's `moved_to`), through the Inbox's real
 * doors: a running Inbox (temp data dir, loopback), the agents over the official MCP client, the wake over the
 * bridge. The failures this guards: another session's read of the archived thread swallowing the note before the
 * sub-agent's wake takes it, and the note arriving in the reply wrapper, whose "answer in the same thread" would
 * bring the archived thread back to the person.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_MOVED_WAKE_INSTRUCTION,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ASK = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-moved-wake-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-moved-wake-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const call = async (name: string, session: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { project_path: project, agent_session: session, agent_name: "Claude Code", agent_host: "claude-code", ...args } })) as {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
    };
  return { server, call };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const bridge = (server: InboxServer, path: string, body: unknown) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });

async function poll(server: InboxServer, session: string) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, waitMs: 0 });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

test("the orchestrator's reads leave the note for the sub-agent's wake, which words it as a notice with nothing to answer", async () => {
  const { server, call } = await setup();
  const old = (await call("send_message", "ses_sub", { subject: "Retry policy", body: ASK("Retry failed charges?") })).structuredContent;
  const brief = (await call("send_message", "ses_orch", { subject: "Morning brief", body: ASK("Retry failed charges?") })).structuredContent;
  const resolved = await call("resolve_message", "ses_orch", { message_id: old.thread_id, moved_to: brief.thread_id });
  expect(resolved.isError).toBeFalsy();
  // The orchestrator reads the thread it archived, both ways.
  await call("read_thread", "ses_orch", { thread_id: old.thread_id });
  await call("read_thread", "ses_orch", { thread_id: old.thread_id, format: "full" });
  expect(await poll(server, "ses_orch")).toEqual([]);
  const [command, ...more] = await poll(server, "ses_sub");
  expect(more).toEqual([]);
  expect(command).toMatchObject({ type: "reply", thread_id: old.thread_id, moved: true });
  expect(command).not.toHaveProperty("name_thread");
  const lines = inboxWakeText(command!).split("\n");
  expect(lines[1]).toBe(INBOX_MOVED_WAKE_INSTRUCTION);
  expect(lines.at(-1)).toBe(`[thread ${old.thread_id}]`);
  expect(inboxWakeText(command!)).not.toContain("send_message");
  // Delivered once: never handed again.
  expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses_sub", host: "claude-code", type: "delivered", id: command!.id })).status).toBe(200);
  expect(await poll(server, "ses_sub")).toEqual([]);
});
