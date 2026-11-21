/**
 * An agent's name is stored whole where the Inbox takes it: only a toast cuts
 * it (shortAgentName) when it shows it. Through 0.28.61 send_message stored at
 * most 40 characters, so a long name stayed cut in rows and search for good.
 * Through the real MCP door on a scratch Inbox.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a long agent name is stored whole, only trimmed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-name-cap-")));
  roots.push(root);
  const project = join(root, "plannotator");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-name-cap-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const long = `Claude Code (worktree agent-a0316994da8440ab5) on the laptop ${"x".repeat(200)} tailword`;
  const sent = (
    (await client.callTool({
      name: "send_message",
      arguments: { project_path: project, agent_session: "ses_a", agent_name: `  ${long}  `, agent_host: "claude-code", body: "From ses_a." },
    })) as { structuredContent: { thread_id: string } }
  ).structuredContent;
  expect(server.store.thread(sent.thread_id)!.messages[0]!.author.name).toBe(long);
});
