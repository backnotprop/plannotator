/**
 * A question choice longer than 200 characters is picked through the
 * server's real doors (the owner's 0.28.17 report: the window's pick answered
 * `422 "<the first 200 characters>" is not one of the question's choices`).
 * The window's picks route and a paired phone's door both take the whole
 * label, and the reply carries it. A running server on loopback, real
 * `fetch`, an agent over MCP, a temp data dir per test.
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

type Json = Record<string, any>;

const LONG =
  "Spike first. Find out what the sign-in grants (a Claude subscription paying for turns the platform runs?) and whether Anthropic allows it for a third-party product; the placeholder stays off the product until both answers are in";
const ASK = [":::question", "Which way first?", "", `- [ ] ${LONG} — keeps it reversible`, "- [ ] Ship the placeholder now", ":::"].join("\n");

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-long-choice-")));
  roots.push(root);
  const project = join(root, "platform");
  mkdirSync(project);
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, phones: true });
  servers.push(server);
  const client = new Client({ name: "inbox-long-choice-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const result = (await client.callTool({ name: "send_message", arguments: { project_path: project, body: ASK } })) as { isError?: boolean; content: { text: string }[]; structuredContent: Json };
  if (result.isError) throw new Error(result.content[0]!.text);
  const sent = result.structuredContent;
  const origin = `http://127.0.0.1:${server.port}`;
  const thread = (await (await fetch(`${origin}/api/inbox/threads/${sent.thread_id}`)).json()) as Json;
  const q = thread.thread.messages[0].questions[0] as Json;
  return { server, origin, sent, q };
}

const pickOf = (q: Json, label: string) => ({ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] } });

test("the window picks a long choice by its whole label, and the Send carries it", async () => {
  const { server, origin, sent, q } = await setup();
  expect(q.choices[0].label).toBe(LONG);
  const post = (path: string, body: Json) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, serverSession: server.serverSession }) });
  const picked = await post(`/api/inbox/messages/${sent.message_id}/picks`, { questions: [pickOf(q, LONG)] });
  expect(picked.status).toBe(200);
  expect(((await picked.json()) as Json).questions[0]).toMatchObject({ state: "picked", answer: { selected: [LONG] } });
  const reply = await post(`/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "send-1", questions: [{ key: q.key, revision: 1 }] });
  expect(reply.status).toBe(200);
  expect(((await reply.json()) as Json).reply.body).toContain(LONG);
});

test("a paired phone picks the same long choice through its door", async () => {
  const { origin, sent, q } = await setup();
  const made = (await (await fetch(`${origin}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
  const paired = (await (
    await fetch(`${origin}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) })
  ).json()) as Json;
  const picked = await fetch(`${origin}/api/inbox/device/messages/${sent.message_id}/picks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ idempotency_key: "phone-pick-1", questions: [pickOf(q, LONG)] }),
  });
  expect(picked.status).toBe(200);
  expect(((await picked.json()) as Json).questions[0]).toMatchObject({ state: "picked", answer: { selected: [LONG] } });
});
