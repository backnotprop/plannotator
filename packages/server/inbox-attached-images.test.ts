/** send_message with pictures in `attachments` that the body does not show, on a running Inbox with an agent over MCP. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { attachedImagesNotInBodyText } from "@plannotator/shared/inbox/attached-images";
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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-attached-images-")));
  roots.push(root);
  const project = join(root, "app");
  mkdirSync(join(project, "shots"), { recursive: true });
  for (const name of ["a.png", "b.png"]) writeFileSync(join(project, "shots", name), PNG);
  writeFileSync(join(project, "plan.md"), "# Plan\n");
  const dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-attached-images-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { project, server, client };
}

async function send(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

test("attached pictures the body does not show: sent as written, and the result advises the next message", async () => {
  const { project, server, client } = await world();
  const body = "Two looks for the step: the light one and the dark one.";
  const { text, structured } = await send(client, { project_path: project, body, attachments: ["shots/a.png", "shots/b.png", "plan.md"] });
  expect(text).toStartWith("Sent to the Plannotator Inbox");
  expect(text).toContain(attachedImagesNotInBodyText(2).trim());
  expect(structured.attached_images_not_in_body).toEqual(["shots/a.png", "shots/b.png"]);
  const thread = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${structured.thread_id}`)).json()) as any;
  const message = thread.thread.messages[0];
  expect(message.body).toBe(body);
  expect(message.attachments.map((a: any) => a.name)).toEqual(["a.png", "b.png", "plan.md"]);
  expect(thread.thread.messages).toHaveLength(1);
});

test("pictures shown in the body, or only non-picture attachments: no advice", async () => {
  const { project, client } = await world();
  const inPlace = await send(client, {
    project_path: project,
    body: ["The light one: ![light](shots/a.png)", "", ":::question", "Which look?", "- [ ] A · Light — ![A](shots/a.png) light", "- [ ] B · Dark — ![B](shots/b.png) dark", ":::"].join("\n"),
    attachments: ["shots/a.png", "shots/b.png"],
  });
  expect(inPlace.structured.attached_images_not_in_body).toBeUndefined();
  expect(inPlace.text).not.toContain("attached but not shown");

  const files = await send(client, { project_path: project, body: "The plan is attached.", attachments: ["plan.md"], thread: "files only" });
  expect(files.structured.attached_images_not_in_body).toBeUndefined();
  expect(files.text).not.toContain("attached but not shown");
});
