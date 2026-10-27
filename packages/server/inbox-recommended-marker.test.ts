/**
 * send_message on a question that writes its recommendation into a choice
 * label (`- [ ] Foo (Recommended)`) instead of a `Recommended:` line: sent as
 * always, and the result nudges the agent toward the line, never refuses. A
 * running Inbox on loopback (a temp data dir), an agent over MCP.
 *
 * What regresses if this fails: the agent never learns the grammar and keeps
 * writing markers (on a pick-one question with two marked choices the card
 * shows no recommendation), or the nudge fires on a correct block.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { recommendedInLabelText } from "./inbox-mcp";
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-rec-marker-")));
  roots.push(root);
  const project = join(root, "app");
  mkdirSync(project);
  const dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-rec-marker-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { project, server, client };
}

async function send(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

const ask = (...lines: string[]) => [":::question", "Should a broken config block uninstall?", "", ...lines, ":::"].join("\n");

test("a marked label is sent, read as the recommendation, and nudged", async () => {
  const { project, server, client } = await world();
  const { text, structured } = await send(client, {
    project_path: project,
    body: ask("- [ ] Only block on ours (Recommended) — a stray file stays a warning", "- [ ] Block on any — strictest"),
  });
  expect(structured.recommended_in_label).toEqual([structured.questions[0].key]);
  expect(text).toContain(recommendedInLabelText(1).trim());
  const thread = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${structured.thread_id}`)).json()) as any;
  const wire = thread.thread.messages[0].questions[0];
  expect(wire.choices.map((c: any) => [c.label, c.recommended])).toEqual([
    ["Only block on ours", true],
    ["Block on any", false],
  ]);
});

test("two marked choices on a pick-one question: no recommendation, still nudged", async () => {
  const { project, client } = await world();
  const { structured } = await send(client, { project_path: project, body: ask("- [ ] Ours only (recommended)", "- [ ] Any (recommended)") });
  expect(structured.recommended_in_label).toEqual([structured.questions[0].key]);
});

test("a marker beside a Recommended: line is nudged too (agreeing or not), and leaves the label", async () => {
  const { project, server, client } = await world();
  for (const line of ["Recommended: Ours only", "Recommended: Any"]) {
    const { text, structured } = await send(client, { project_path: project, body: ask("- [ ] Ours only (Recommended)", "- [ ] Any", "", line) });
    expect(structured.recommended_in_label).toEqual([structured.questions[0].key]);
    expect(text).toContain(recommendedInLabelText(1).trim());
    const thread = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${structured.thread_id}`)).json()) as any;
    const labels = thread.thread.messages.at(-1).questions[0].choices.map((c: any) => c.label);
    expect(labels).toEqual(["Ours only", "Any"]);
  }
});

test("a leading marker is read and nudged", async () => {
  const { project, client } = await world();
  const { structured } = await send(client, { project_path: project, body: ask("- [ ] [Recommended] Ours only", "- [ ] Any") });
  expect(structured.recommended_in_label).toEqual([structured.questions[0].key]);
});

test("no nudge with a Recommended: line, or with no recommendation at all", async () => {
  const { project, client } = await world();
  const withLine = await send(client, { project_path: project, body: ask("- [ ] Ours only", "- [ ] Any", "", "Recommended: Ours only") });
  expect(withLine.structured.recommended_in_label).toBeUndefined();
  expect(withLine.text).not.toContain("Recommended: <label>");
  const none = await send(client, { project_path: project, body: ask("- [ ] Ours only", "- [ ] Any") });
  expect(none.structured.recommended_in_label).toBeUndefined();
});
