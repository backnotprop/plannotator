/**
 * An older agent's `Decision:` line in a question block, through the Inbox's
 * real doors (a running Inbox on loopback, the official MCP client, real
 * `fetch`). Decisions were removed (2026-10): the window draws a card with
 * core's `{ decisionLines: false }`, while a question record an older Inbox
 * stored was parsed with the default. The failure this catches: a
 * `Decision:` line right under a plain-bullet choice folded into that
 * choice's label on one side only ("SQLite Decision: when answered" against
 * a stored "SQLite"), so the pick the window sends is refused with 422 and
 * the question cannot be answered.
 */
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseQuestionBlock } from "@plannotator/core/question-block";
import type { InboxQuestion } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const INNER = ["Which database should the ledger use?", "- Postgres", "- SQLite", "Decision: when answered"].join("\n");
const BODY = `:::question\n${INNER}\n:::`;

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: unknown) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("a question an older Inbox stored (default parse) takes the label the window draws; picks and Send are accepted", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-legacy-line-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const first = await startInboxServer({ dataDir });
  servers.push(first);
  const client = new Client({ name: "inbox-legacy-line-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${first.port}/mcp`)));
  clients.push(client);
  const sent = (await client.callTool({
    name: "send_message",
    arguments: { project_path: project, agent_session: "ses_old", agent_name: "Claude Code", body: BODY },
  })) as { structuredContent: { thread_id: string; message_id: string } };
  const { thread_id: threadId, message_id: messageId } = sent.structuredContent;

  // Rewrite the question as an older Inbox stored it: parsed with the default (decision lines read), with
  // the decision fields it wrote. One more snapshot line, as the store appends.
  const record = first.store.questionRecordsOf(first.store.message(messageId)!.project_id)[0]!;
  const byDefault = parseQuestionBlock("question", INNER)!;
  expect(byDefault.decisionOnAnswer).toBe(true);
  const folder = join(first.store.dir, "projects", first.store.project(record.project_id)!.key);
  const seq = first.store.cursor() + 1;
  const old = {
    ...record,
    parsed: {
      ...record.parsed,
      context: byDefault.context.trim() || null,
      choices: byDefault.choices.map((c) => ({ label: c.label, description: c.description ?? null, recommended: c.recommended, settled: c.settled })),
      aliases: byDefault.choices.map((c) => (c.aliases?.length ? [...c.aliases] : null)),
    },
    decision_on_answer: true,
    decision_id: null,
  };
  appendFileSync(join(folder, "questions.jsonl"), `${JSON.stringify({ v: 1, seq, at: new Date().toISOString(), kind: "question", id: record.id, record: old })}\n`);
  first.stop();
  servers.splice(servers.indexOf(first), 1);
  expect(readFileSync(join(folder, "questions.jsonl"), "utf8")).toContain('"decision_on_answer":true');

  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const thread = (await (await fetch(url(server, `/api/inbox/threads/${threadId}`))).json()) as { thread: { messages: { questions?: InboxQuestion[] }[] } };
  const question = thread.thread.messages[0]!.questions![0]!;
  expect(question.choices.map((c) => c.label)).toEqual(["Postgres", "SQLite"]);

  // What the window draws (ui Viewer, questionDecisionLines={false}) and so sends.
  const window = parseQuestionBlock("question", INNER, { decisionLines: false })!;
  expect(window.key).toBe(question.key);
  const label = window.choices[1]!.label;
  expect(label).toBe("SQLite");
  const picked = await post(server, `/api/inbox/messages/${messageId}/picks`, {
    serverSession: server.serverSession,
    questions: [{ key: question.key, revision: question.revision, answer: { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: [label] } }],
  });
  expect(picked.status).toBe(200);
  const reply = await post(server, `/api/inbox/messages/${messageId}/reply`, {
    serverSession: server.serverSession,
    idempotency_key: "k-legacy",
    words: "SQLite for now.",
    questions: [{ key: question.key, revision: question.revision + 1 }],
  });
  expect(reply.status).toBe(200);
  expect(((await reply.json()) as { questions: InboxQuestion[] }).questions[0]).toMatchObject({ state: "sent", answer: { selected: ["SQLite"] } });
});

test("a new message with the line right under its bullets stores the clean labels, and the line as context", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-legacy-line-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-legacy-line-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const sent = (await client.callTool({
    name: "send_message",
    arguments: { project_path: project, agent_session: "ses_new", agent_name: "Claude Code", body: BODY },
  })) as { structuredContent: { message_id: string } };
  const question = server.store.questionsOf(sent.structuredContent.message_id)[0]!;
  expect(question.choices.map((c) => c.label)).toEqual(["Postgres", "SQLite"]);
  expect(question.context).toBe("Decision: when answered");
  expect(question).not.toHaveProperty("decision_on_answer");
});
