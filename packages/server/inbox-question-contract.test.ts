/**
 * The question contract lines and picture choices through a real Inbox
 * (approval "inbox-decision-mode", agent contract lines): send_message keeps
 * them on the record, captures each choice's picture and the `Shows:`
 * picture as files of the thread (served by the message image route), names
 * a choice picture that will not show, and nudges, never refuses, when a
 * Stopped or Holds up question has no `Stakes:` line.
 *
 * What regresses if this fails: a picture choice never loads in the window
 * (not captured, or refused by the image route), an agent is not told its
 * picture will not show, or the nudge refuses a send / fires on a question
 * that is neither Stopped nor held up.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { inboxMessageImageRefsInOrder } from "@plannotator/shared/inbox/message-images";
import { SEND_BODY_DESCRIPTION, INBOX_CONTRACT_EXAMPLE, noStakesText } from "./inbox-mcp";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
});

function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  return bytes;
}

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-contract-")));
  roots.push(root);
  const project = join(root, "shop");
  mkdirSync(join(project, "shots"), { recursive: true });
  writeFileSync(join(project, "shots", "drawer-a.png"), png());
  writeFileSync(join(project, "shots", "drawer-b.png"), png());
  writeFileSync(join(project, "shots", "nav.png"), png());
  const dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-question-contract-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { project, server, client };
}

async function send(client: Client, args: Record<string, unknown>) {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return { text: result.content.map((part) => part.text).join("\n"), structured: result.structuredContent };
}

const BLOCK = [
  ":::question",
  "Which checkout drawer should ship?",
  "Shows: ![Both drawers](shots/nav.png)",
  "Holds up: checkout release",
  "",
  "- [ ] A · Total on top — ![Drawer A](shots/drawer-a.png) closest to today",
  "- [ ] B · Total pinned — ![Drawer B](shots/drawer-b.png)",
  "- [ ] C · Three steps — ![Drawer C](shots/drawer-c-missing.png)",
  ":::",
].join("\n");

test("choice pictures and the Shows picture are captured as files of the thread and served by the image route", async () => {
  const { project, server, client } = await world();
  expect(inboxMessageImageRefsInOrder(BLOCK)).toEqual(["shots/nav.png", "shots/drawer-a.png", "shots/drawer-b.png", "shots/drawer-c-missing.png"]);
  const { structured, text } = await send(client, { project_path: project, body: BLOCK });
  const message = server.store.message(structured.message_id)!;
  expect((message.inline_images ?? []).map((image) => image.ref)).toEqual(["shots/nav.png", "shots/drawer-a.png", "shots/drawer-b.png"]);
  const wire = server.store.questionsOf(message.id)[0]!;
  expect(wire.choices.map((c) => c.image?.src)).toEqual(["shots/drawer-a.png", "shots/drawer-b.png", "shots/drawer-c-missing.png"]);
  expect(wire.shows).toEqual({ kind: "image", label: "Both drawers", src: "shots/nav.png" });
  for (const src of ["shots/drawer-a.png", "shots/nav.png"]) {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${message.id}/image?path=${encodeURIComponent(src)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  }
  // The choice picture that will not show is named, like any other image.
  expect(structured.images_not_shown).toEqual([{ ref: "shots/drawer-c-missing.png", reason: expect.any(String), not_yet: true }]);
  expect(text).toContain("shots/drawer-c-missing.png");
});

test("a Stopped or Holds up question with no Stakes: line is nudged, never refused", async () => {
  const { project, client } = await world();
  const { text, structured } = await send(client, { project_path: project, body: BLOCK });
  expect(structured.message_id).toBeString();
  expect(structured.no_stakes).toEqual([structured.questions[0].key]);
  expect(text).toContain(noStakesText(1).trim());
  expect(text).toContain("has no `Stakes:` line");
});

test("no nudge with a Stakes: line, or on a question that is neither Stopped nor held up", async () => {
  const { project, client } = await world();
  const withStakes = await send(client, {
    project_path: project,
    body: [":::question", "Which drawer?", "Stakes: ships Thursday.", "Stopped: release waits", "- [ ] A", "- [ ] B", ":::"].join("\n"),
  });
  expect(withStakes.structured.no_stakes).toBeUndefined();
  expect(withStakes.text).not.toContain("Stakes:");
  const plain = await send(client, { project_path: project, body: [":::question", "Tabs or spaces?", "- [ ] Tabs", "- [ ] Spaces", ":::"].join("\n") });
  expect(plain.structured.no_stakes).toBeUndefined();
  expect(plain.text).not.toContain("Stakes:");
});

test("the body description teaches the lines with one example and the restraint rule; the example parses", () => {
  expect(SEND_BODY_DESCRIPTION).toContain("Most questions need none of these");
  expect(SEND_BODY_DESCRIPTION).toContain(INBOX_CONTRACT_EXAMPLE);
  expect(SEND_BODY_DESCRIPTION.split(":::question\n").length - 1).toBe(2);
  const [q] = parseInboxQuestionBlocks(INBOX_CONTRACT_EXAMPLE);
  expect(q!.parsed.stakes).toBeString();
  expect(q!.parsed.why).toBeString();
  expect(q!.parsed.choices.every((c) => c.image)).toBe(true);
  expect(q!.parsed.choices.find((c) => c.recommended)!.label).toBe("B · Total pinned with Pay");
});
