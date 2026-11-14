import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { reviewConversations, type InboxReviewAnchor } from "@plannotator/core/review-threads";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const anchor = (line: number, code: string): InboxReviewAnchor => ({ file: "src/billing.ts", side: "new", line_start: line, line_end: line, code: [code], head: "abc1234" });

async function world(options: { liveReviewCommand?: string[] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-live-review-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), ...options });
  servers.push(server);
  const client = new Client({ name: "live-review-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const bridge = (path: string, body: Record<string, unknown>) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });
  const poll = async (session: string, host: string) => {
    const response = await bridge(INBOX_BRIDGE_POLL_PATH, { session, host, waitMs: 0, project_path: project, started_at: Date.now(), busy: false, tags: true });
    return parseInboxBridgeCommands(await response.text());
  };
  const deliver = (session: string, host: string, id: string) => bridge(INBOX_BRIDGE_EVENT_PATH, { session, host, type: "delivered", id });
  const send = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/inbox/review-threads/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, project_path: project, review: { key: "branch:fix/charge", title: "fix/charge" }, ...body }) });
    const json = (await response.json()) as { thread: { id: string } | null; messages: InboxMessage[]; sent: string[]; error?: string };
    if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const read = async () => (await (await fetch(`${base}/api/inbox/review-threads?project_path=${encodeURIComponent(project)}&key=${encodeURIComponent("branch:fix/charge")}`)).json()) as { thread: { id: string } | null; messages: InboxMessage[] };
  const agentReply = async (session: string, host: string, replyTo: string, body: string) => {
    const result = (await client.callTool({ name: "send_message", arguments: { project_path: project, body, reply_to: replyTo, agent_session: session, agent_host: host } })) as { isError?: boolean; content: { text: string }[] };
    if (result.isError) throw new Error(result.content[0]!.text);
  };
  const readThread = async (threadId: string, session: string) => {
    const result = (await client.callTool({ name: "read_thread", arguments: { thread_id: threadId, agent_session: session } })) as { content: { text: string }[] };
    return result.content.map((c) => c.text).join("\n");
  };
  await poll("ses-cc", "claude-code");
  await poll("ses-pi", "pi");
  return { root, server, project, poll, deliver, send, read, agentReply, readThread };
}

test("a comment sent now to the launching agent wakes it with its lines, and its answer lands on them", async () => {
  const w = await world();
  expect((await w.read()).thread).toBeNull();
  const first = await w.send({ to: { host: "claude-code", session: "ses-cc" }, comments: [{ anchor: anchor(4, "  if (amount < 0) throw new Error();"), words: "Use RangeError here." }], idempotency_key: "k1" });
  const commentId = first.sent[0]!;
  const [command] = await w.poll("ses-cc", "claude-code");
  expect(command!.id).toBe(commentId);
  expect(command!.body).toContain("Use RangeError here.");
  expect(command!.body).toContain(`(A review comment on \`src/billing.ts\` line 4 (new side, at abc1234):\n\`\`\`\n  if (amount < 0) throw new Error();\n\`\`\`\nAnswer it with reply_to ${commentId}.)`);
  await w.deliver("ses-cc", "claude-code", commentId);

  await w.agentReply("ses-cc", "claude-code", commentId, "Done in def5678.");
  const again = await w.read();
  expect(again.thread?.id).toBe(first.thread!.id);
  const [conversation] = reviewConversations(again.messages);
  expect(conversation!.anchor.line_start).toBe(4);
  expect(conversation!.messages.map((m) => m.body)).toEqual(["Use RangeError here.", "Done in def5678."]);

  const replay = await w.send({ to: { host: "claude-code", session: "ses-cc" }, comments: [{ anchor: anchor(4, "  if (amount < 0) throw new Error();"), words: "Use RangeError here." }], idempotency_key: "k1" });
  expect(replay.messages.length).toBe(again.messages.length);
});

test("send all: one wake per agent carries every comment by its own id, and each answer threads on its comment", async () => {
  const w = await world();
  const first = await w.send({ to: { host: "claude-code", session: "ses-cc" }, comments: [{ anchor: anchor(2, "import x;"), words: "Unused?" }], idempotency_key: "k1" });
  await w.deliver("ses-cc", "claude-code", first.sent[0]!);
  const bulk = await w.send({
    comments: [
      { anchor: anchor(8, "export const retries = 3;"), words: "Why 3?" },
      { anchor: anchor(12, "await sleep(1000);"), words: "Back off instead." },
    ],
    tags: [{ host: "pi", session: "ses-pi" }],
    idempotency_key: "k2",
  });
  const [a, b, lead] = bulk.sent;
  for (const [session, host] of [["ses-cc", "claude-code"], ["ses-pi", "pi"]] as const) {
    const commands = await w.poll(session, host);
    expect(commands.map((c) => c.id)).toEqual([lead!]);
    expect(commands[0]!.body).toContain(`Comment ${a} on \`src/billing.ts\` line 8`);
    expect(commands[0]!.body).toContain(`Comment ${b} on \`src/billing.ts\` line 12`);
    expect(commands[0]!.body).toContain(`answer the review as a whole with reply_to ${lead}`);
  }
  await w.agentReply("ses-pi", "pi", b!, "Exponential, capped at 30 s.");
  const conversations = reviewConversations((await w.read()).messages);
  expect(conversations.map((c) => [c.anchor.line_start, c.messages.length])).toEqual([[2, 1], [8, 1], [12, 2]]);
});

test("the person resolves and reopens a comment; the agent reads that it is resolved", async () => {
  const w = await world();
  const sent = await w.send({ to: { host: "pi", session: "ses-pi" }, comments: [{ anchor: anchor(4, "x"), words: "Rename." }], idempotency_key: "k1" });
  const id = sent.sent[0]!;
  const resolve = (resolved: boolean) =>
    fetch(`http://127.0.0.1:${w.server.port}/api/inbox/review-threads/comments/${id}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.server.serverSession, resolved }) });
  expect((await resolve(true)).status).toBe(200);
  expect(reviewConversations((await w.read()).messages)[0]!.resolved).not.toBeNull();
  expect(await w.readThread(sent.thread!.id, "ses-pi")).toContain(`Answer it with reply_to ${id}.) The person resolved it.`);
  expect((await resolve(false)).status).toBe(200);
  expect(reviewConversations((await w.read()).messages)[0]!.resolved).toBeNull();
});

test("a malformed anchor sends nothing", async () => {
  const w = await world();
  await expect(w.send({ to: { host: "pi", session: "ses-pi" }, comments: [{ anchor: { file: "a.ts", side: "new", line_start: 5, line_end: 2, code: [] }, words: "x" }], idempotency_key: "k1" })).rejects.toThrow("line_start");
  expect((await w.read()).thread).toBeNull();
});

test("the living review opens again from its thread: the review starts in its folder on its key, and the window gets its address", async () => {
  const stubDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-live-review-stub-")));
  roots.push(stubDir);
  const stub = join(stubDir, "review-stub.ts");
  writeFileSync(
    stub,
    [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(join(stubDir, "seen.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), thread: process.env.PLANNOTATOR_REVIEW_LIVE_THREAD, key: process.env.PLANNOTATOR_REVIEW_LIVE_KEY, skip: process.env.PLANNOTATOR_SKIP_BROWSER_OPEN }));`,
      'appendFileSync(process.env.PLANNOTATOR_READY_FILE!, JSON.stringify({ url: "http://localhost:51234" }) + "\\n");',
    ].join("\n"),
  );
  const w = await world({ liveReviewCommand: [process.execPath, stub] });
  const sent = await w.send({ to: { host: "pi", session: "ses-pi" }, comments: [{ anchor: anchor(4, "x"), words: "Rename." }], idempotency_key: "k1" });
  const response = await fetch(`http://127.0.0.1:${w.server.port}/api/inbox/review-threads/${sent.thread!.id}/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.server.serverSession }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "http://localhost:51234" });
  const seen = JSON.parse(readFileSync(join(stubDir, "seen.json"), "utf8"));
  expect(seen).toEqual({ args: ["review"], cwd: w.project, thread: sent.thread!.id, key: "branch:fix/charge", skip: "1" });
});

test("Take back: a comment not yet with its agent comes back, a review sent all at once comes back whole, a delivered one stays", async () => {
  const w = await world();
  const takeBack = (id: string) =>
    fetch(`http://127.0.0.1:${w.server.port}/api/inbox/review-threads/comments/${id}/take-back`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: w.server.serverSession }) });
  const first = await w.send({ to: { host: "pi", session: "ses-pi" }, comments: [{ anchor: anchor(2, "a"), words: "One." }], idempotency_key: "k1" });
  await w.deliver("ses-pi", "pi", first.sent[0]!);
  expect((await takeBack(first.sent[0]!)).status).toBe(409);
  const bulk = await w.send({ comments: [{ anchor: anchor(4, "b"), words: "Two." }, { anchor: anchor(6, "c"), words: "Three." }], idempotency_key: "k2" });
  const sibling = bulk.sent[0]!;
  const response = await takeBack(sibling);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { taken: string[] }).taken.sort()).toEqual([...bulk.sent].sort());
  expect(reviewConversations((await w.read()).messages).map((c) => c.anchor.line_start)).toEqual([2]);
  expect((await w.poll("ses-pi", "pi")).map((c) => c.id)).not.toContain(bulk.sent[2]);
});
