/**
 * send_message with a question opener that has text after its name
 * (`:::question {#bar}`; the owner, 2026-11-02: the person saw a question
 * they could not answer and the result said only `questions: []`). A running
 * Inbox on loopback (a temp data dir), an agent over MCP.
 *
 * What regresses if this fails: the warning stops reaching the agent at the
 * moment it sends (a new message or a reply_to), or it turns into friction
 * (the send refused, or the message the person reads changed), or it nags a
 * message whose blocks opened.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-question-openers-")));
  roots.push(root);
  const project = join(root, "app");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-question-openers-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { project, server, client };
}

async function send(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

const warning = (line: number, directive: string) =>
  `Line ${line} starts with \`${directive}\` but has text after it, so the person sees it as plain text and can't answer it. Put \`${directive}\` alone on its line and send the question again.`;

test("an opener with text after its name: sent as written, and the result warns with its line, once per opener", async () => {
  const { project, server, client } = await world();
  const body = [":::question {#bar}", "Which bar?", "- [ ] Top", "- [ ] Bottom", ":::", "", ":::question-multi foo", "Which checks?", "- [ ] Lint", ":::"].join("\n");
  const { text, structured } = await send(client, { project_path: project, body, thread: "Bars" });
  expect(text).toStartWith("Sent to the Plannotator Inbox");
  // Each warning on a line of its own.
  expect(text.split("\n")).toContain(warning(1, ":::question"));
  expect(text.split("\n")).toContain(warning(7, ":::question-multi"));
  expect(structured.questions).toEqual([]);
  expect(structured.question_openers_with_text).toEqual([
    { line: 1, directive: ":::question" },
    { line: 7, directive: ":::question-multi" },
  ]);
  // The person's message is the one the agent sent.
  const thread = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${structured.thread_id}`)).json()) as any;
  expect(thread.thread.messages).toHaveLength(1);
  expect(thread.thread.messages[0].body).toBe(body);

  // A reply_to carries it too, by its own body's lines.
  const reply = await send(client, { project_path: project, reply_to: structured.message_id, body: "Asking again:\n\n:::question-text {#why}\nWhy?\n:::" });
  expect(reply.text.split("\n")).toContain(warning(3, ":::question-text"));
  expect(reply.structured.question_openers_with_text).toEqual([{ line: 3, directive: ":::question-text" }]);
});

test("a correct block, or an example in a code fence: no warning", async () => {
  const { project, client } = await world();
  const body = ["Not `:::question {#x}` but:", "", "```", ":::question {#x}", "```", "", ":::question", "Which bar?", "- [ ] Top", "- [ ] Bottom", ":::"].join("\n");
  const { text, structured } = await send(client, { project_path: project, body, thread: "Bars" });
  expect(structured.questions).toHaveLength(1);
  expect(structured.question_openers_with_text).toBeUndefined();
  expect(text).not.toContain("has text after it");
});
