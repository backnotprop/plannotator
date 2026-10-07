/**
 * Plannotator Inbox attachments, proved through the server's real doors: a
 * running Inbox on loopback, the MCP SDK client over streamable HTTP for the
 * agent, and real `fetch` for the window. Every test has its own temp data dir.
 * The browser side (the pane, the viewers, the chip) is proved in
 * tests/e2e/inbox-attachments.spec.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-att-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(join(project, "docs"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "docs", "plan.md"), "# Plan\n\nRetry three times.\n");
  return { root, project, dataDir: join(root, "data") };
}

async function start(dataDir: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-attachments-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function send(client: Client, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

function post(server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("annotations ride a Send without picks; a sent annotation is closed; the reply carries the feedback after the words", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "The plan, for a look.", attachments: ["docs/plan.md"], agent_session: "ses_A" });
  const attachmentId = sent.attachments[0].id as string;
  const saved = await post(server, "/api/inbox/annotations", {
    attachment_id: attachmentId,
    version: "current",
    annotation: { id: "ann-1", type: "COMMENT", text: "Why three?", originalText: "Retry three times.", blockId: "block-1", startOffset: 0, endOffset: 0, createdA: 1 },
  });
  expect(saved.status).toBe(200);
  const reply = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, {
    idempotency_key: "k1",
    words: "One note.",
    feedback: "# Feedback on the attached files\n\n## docs/plan.md\n\nWhy three?",
    annotation_ids: ["ann-1"],
  });
  expect(reply.status).toBe(200);
  const body = ((await reply.json()) as { reply: { body: string } }).reply.body;
  expect(body.indexOf("One note.")).toBeLessThan(body.indexOf("Feedback on the attached files"));
  // Sent: no longer pending, and closed to edits.
  const model = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as { annotations: unknown[] };
  expect(model.annotations).toHaveLength(0);
  const again = await post(server, "/api/inbox/annotations", { attachment_id: attachmentId, version: "current", annotation: { id: "ann-1", text: "edit" } });
  expect(again.status).toBe(409);
  // An annotation the thread does not hold cannot ride a Send.
  const stray = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "k2", feedback: "x", annotation_ids: ["nope"] });
  expect(stray.status).toBe(404);
});

test("the annotation and delete routes refuse another site and a stale tab", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "The plan.", attachments: ["docs/plan.md"] });
  const crossSite = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" };
  expect((await post(server, `/api/inbox/threads/${sent.thread_id}/delete`, {}, crossSite)).status).toBe(403);
  expect((await post(server, `/api/inbox/projects/${sent.project.id}/delete`, {}, crossSite)).status).toBe(403);
  expect((await post(server, "/api/inbox/annotations", { attachment_id: sent.attachments[0].id, version: "current", annotation: { id: "a" } }, crossSite)).status).toBe(403);
  expect((await post(server, `/api/inbox/threads/${sent.thread_id}/delete`, { serverSession: "an-older-inbox" })).status).toBe(409);
  // A version that is not this attachment's is refused.
  const wrong = await post(server, "/api/inbox/annotations", { attachment_id: sent.attachments[0].id, version: "0".repeat(64), annotation: { id: "a" } });
  expect(wrong.status).toBe(422);
  expect(readdirSync(join(dataDir, "inbox", "blobs"))).toHaveLength(1);
});

test("a deleted thread's seq is never handed out again, even after a restart", async () => {
  const { project, dataDir } = world();
  let server = await start(dataDir);
  let client = await agent(server);
  await send(client, { project_path: project, body: "First thread.", agent_session: "ses_A" });
  const last = await send(client, { project_path: project, body: "Second thread.", attachments: ["docs/plan.md"], agent_session: "ses_B" });
  const highest = last.cursor as number;
  expect((await post(server, `/api/inbox/threads/${last.thread_id}/delete`, {})).status).toBe(200);
  expect(readdirSync(join(dataDir, "inbox", "blobs"))).toHaveLength(0);
  await client.close();
  server.stop();
  servers.splice(servers.indexOf(server), 1);
  server = await start(dataDir);
  client = await agent(server);
  const next = await send(client, { project_path: project, body: "After the restart.", agent_session: "ses_C" });
  expect(next.cursor).toBeGreaterThan(highest);
});
