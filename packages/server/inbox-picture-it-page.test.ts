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

const page = (head: string) => `<!doctype html><html><head>${head}</head><body><h1>Retries</h1></body></html>`;

async function world(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-picture-it-page-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
  const dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-picture-it-page-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const send = async (attachments: string[]) => {
    const result = (await client.callTool({ name: "send_message", arguments: { project_path: project, body: "Here is the page.", attachments, agent_session: "ses_a", agent_host: "claude-code" } })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
    if (result.isError) throw new Error(result.content[0]!.text);
    const read = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${result.structuredContent.thread_id}`)).json()) as any;
    return read.thread.messages[0];
  };
  return { send };
}

test("an attached page with the picture-it meta marks the message with that attachment and its title", async () => {
  const w = await world({
    "notes.md": "# Notes\n",
    "picture-it-retries.html": page('<meta charset="utf-8"><meta content="picture-it" name="plannotator-page"><title>  How retries\n wait  </title>'),
  });
  const message = await w.send(["notes.md", "picture-it-retries.html"]);
  const html = message.attachments.find((a: any) => a.name === "picture-it-retries.html");
  expect(message.picture_it).toEqual({ attachment_id: html.id, title: "How retries wait" });
});

test("a page with no title is named by its file; a page without the meta, or another meta's word, marks nothing", async () => {
  const w = await world({
    "untitled.html": page('<meta name="plannotator-page" content="picture-it">'),
    "plain.html": page('<meta name="plannotator-theme" content="host"><title>Plain</title>'),
    "near.html": page('<meta name="plannotator-page" content="picture-it-later"><title>Near</title>'),
    "in-body.html": '<html><head><title>Body</title></head><body><meta name="plannotator-page" content="picture-it"></body></html>',
  });
  expect((await w.send(["untitled.html"])).picture_it).toMatchObject({ title: "untitled.html" });
  for (const name of ["plain.html", "near.html", "in-body.html"]) expect((await w.send([name])).picture_it).toBeUndefined();
});
