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

test("a script attaches as kind code: served as text/plain under the sandbox CSP, its view carries the text, and a line comment on it is kept", async () => {
  const { project, dataDir } = world();
  const script = "#!/bin/sh\n# replay the failed webhook\ncurl -X POST http://localhost:4242/hooks\n";
  writeFileSync(join(project, "replay.sh"), script);
  // A source name whose bytes are not text is offered as a download, not refused.
  writeFileSync(join(project, "tool.ts"), new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
  const server = await start(dataDir);
  const client = await agent(server);
  const binary = await send(client, { project_path: project, body: "Binary.", attachments: ["tool.ts"] });
  expect(binary.attachments[0].kind).toBe("file");
  const sent = await send(client, { project_path: project, body: "The script I ran.", attachments: ["replay.sh"] });
  const attachment = sent.attachments[0] as { id: string; kind: string };
  expect(attachment.kind).toBe("code");
  const raw = await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${attachment.id}`);
  expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(raw.headers.get("content-security-policy")).toBe("sandbox");
  expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await raw.text()).toBe(script);
  const view = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${attachment.id}/view`)).json()) as { text: string; html: string | null };
  expect(view.text).toBe(script);
  expect(view.html).toBeNull();
  const annotated = await post(server, "/api/inbox/annotations", {
    attachment_id: attachment.id,
    version: "current",
    annotation: { id: "ann-code", type: "COMMENT", text: "Why localhost?", originalText: "curl -X POST http://localhost:4242/hooks", blockId: "code-L3-3", startOffset: 0, endOffset: 0, createdA: 1, inboxCode: { lineStart: 3, lineEnd: 3 } },
  });
  expect(annotated.status).toBe(200);
});

/** A PNG's signature and IHDR (2 x 3 px): enough for the sniffer and the dimension read. */
function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  return bytes;
}

test("an image in an attached Markdown file loads from the file's own folder, only when that version of the file shows it (#2228)", async () => {
  const { project, dataDir } = world();
  mkdirSync(join(project, "docs", "shots"), { recursive: true });
  writeFileSync(join(project, "docs", "shots", "before.png"), png());
  writeFileSync(join(project, "docs", "shots", "after.png"), png());
  writeFileSync(join(project, "docs", "shots", "unshown.png"), png());
  writeFileSync(join(project, "docs", "plan.md"), "# Plan\n\n![before](shots/before.png)\n");
  writeFileSync(join(project, "docs", "notes.txt"), "![before](shots/before.png)\n");
  const server = await start(dataDir);
  const client = await agent(server);
  const sent = await send(client, { project_path: project, body: "The plan.", attachments: ["docs/plan.md", "docs/notes.txt"] });
  const [markdown, text] = sent.attachments as { id: string; kind: string }[];
  expect(markdown!.kind).toBe("markdown");
  const image = (id: string, path: string, version: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${id}/markdown-image?path=${encodeURIComponent(path)}&version=${version}`, { headers });

  // Relative to docs/, the Markdown file's folder, not the project root.
  const shown = await image(markdown!.id, "shots/before.png", "current");
  expect(shown.status).toBe(200);
  expect(shown.headers.get("content-type")).toBe("image/png");
  // A file next to it that the Markdown does not show is refused.
  expect((await image(markdown!.id, "shots/unshown.png", "current")).status).toBe(403);

  // The file changes after the send: the current version shows only the new image, the sent version only the old one.
  writeFileSync(join(project, "docs", "plan.md"), "# Plan\n\n![after](shots/after.png)\n");
  expect((await image(markdown!.id, "shots/after.png", "current")).status).toBe(200);
  expect((await image(markdown!.id, "shots/before.png", "current")).status).toBe(403);
  expect((await image(markdown!.id, "shots/before.png", "sent")).status).toBe(200);
  expect((await image(markdown!.id, "shots/after.png", "sent")).status).toBe(403);

  // Only a Markdown attachment shows images this way.
  expect(text!.kind).not.toBe("markdown");
  expect((await image(text!.id, "shots/before.png", "current")).status).toBe(422);
  // Another site is refused before anything is read.
  expect((await image(markdown!.id, "shots/after.png", "current", { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
});
