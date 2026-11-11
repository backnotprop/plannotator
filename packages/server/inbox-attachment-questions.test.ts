/** Questions inside an attached Markdown file, end to end on a running Inbox. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_BROWSER"]) saved[name] = process.env[name];
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const PLAN = [
  "# Billing plan",
  "",
  ":::question",
  "Which database should invoices live in?",
  "",
  "- [ ] Postgres",
  "- [ ] SQLite",
  "",
  "Recommended: Postgres",
  ":::",
  "",
  ":::question",
  "Ship the retry behind a flag?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-attachment-questions-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "plan.md"), PLAN);
  const dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-attachment-questions-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { project, server, client };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

test("an attached plan's questions wait on the person, are answered on the file, and reach the agent under the file's name", async () => {
  const { project, server, client } = await world();
  const sent = await call(client, "send_message", { project_path: project, body: "The plan is attached; each question sits beside its section.", attachments: ["plan.md"], agent_session: "ses_a", agent_host: "claude-code" });
  const messageId = String(sent.structured.message_id);
  expect(sent.text).toContain("asking 2 questions with 1 attachment");
  expect(sent.structured.questions.map((q: any) => [q.prompt, q.file])).toEqual([
    ["Which database should invoices live in?", "plan.md"],
    ["Ship the retry behind a flag?", "plan.md"],
  ]);
  writeFileSync(join(project, "plan.md"), PLAN.replace("Ship the retry behind a flag?", "Something else entirely?"));

  const read = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.structured.thread_id}`)).json()) as any;
  const questions = read.thread.messages[0].questions as any[];
  expect(questions.map((q) => [q.prompt, q.attachment?.name, q.state])).toEqual([
    ["Which database should invoices live in?", "plan.md", "open"],
    ["Ship the retry behind a flag?", "plan.md", "open"],
  ]);
  const attachmentId = read.thread.messages[0].attachments[0].id;
  expect(questions.every((q) => q.attachment.id === attachmentId)).toBe(true);

  const before = await call(client, "read_thread", { thread_id: sent.structured.thread_id, agent_session: "ses_a" });
  expect(before.text).toContain("Waiting on the person (2):");
  expect(before.text).toContain(`- ${messageId}/${questions[0].key} (Q1 in your file plan.md) open: Which database should invoices live in?`);

  const db = questions[0];
  server.store.savePicks(messageId, [{ key: db.key, revision: db.revision, answer: { v: 1, key: db.key, kind: db.kind, prompt: db.prompt, selected: ["Postgres"] } }]);
  const replied = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "r1", questions: [{ key: db.key, revision: db.revision + 1 }] }),
  });
  expect(replied.status).toBe(200);

  const full = await call(client, "read_thread", { thread_id: sent.structured.thread_id, agent_session: "ses_a", format: "full" });
  const reply = (full.structured.thread.messages as any[]).find((m) => m.author.kind === "person");
  expect(reply.body).toStartWith("Answered 1 question.");
  expect(reply.body).toContain("You have 1 other question open in this thread.");
  expect(reply.body).toContain(`### Your file plan.md, attached to message ${messageId}`);
  expect(reply.body).toMatch(/#### Q1\. Which database should invoices live in\? \(line 4\)\nAnswer: Postgres/);
  const after = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.structured.thread_id}`)).json()) as any;
  expect(after.thread.messages[0].questions.map((q: any) => q.state)).toEqual(["sent", "open"]);
});
