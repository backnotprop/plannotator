/**
 * Replaced questions through the Inbox's real doors: a running Inbox on
 * loopback, the official MCP SDK client for the agent side (send_message's
 * `supersedes` and a `Replaces:` line), and real `fetch` for the window's
 * routes (picks, Send and the decision switch on a superseded question).
 * Every test uses its own temp data dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxQuestion, InboxThread } from "@plannotator/core/inbox-types";
import { inboxAgentTool, parseInboxToolList } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

// Nothing here may reach the real tailscale CLI: a trap fails loudly first on PATH.
let savedPath: string | undefined;
beforeEach(() => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-supersede-bin-")));
  roots.push(bin);
  writeFileSync(join(bin, "tailscale"), "#!/bin/sh\necho 'inbox-supersede.test: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(bin, "tailscale"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  process.env.PATH = savedPath;
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-supersede-")));
  roots.push(root);
  const repo = join(root, "billing-svc");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-supersede-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}`;
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { project_path: repo, agent_session: "ses_A", agent_name: "Claude Code", ...args } });
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const thread = async (id: string) => ((await (await fetch(`${base}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
  return { server, client, repo, call, post, thread, base };
}

function structured<T>(result: unknown): T {
  const value = (result as { structuredContent?: unknown }).structuredContent;
  if (!value) throw new Error(`no structuredContent: ${JSON.stringify(result)}`);
  return value as T;
}

function errorText(result: unknown): string {
  expect((result as { isError?: boolean }).isError).toBe(true);
  return (result as { content: { text: string }[] }).content[0]!.text;
}

const WORKER = [
  ":::question",
  "Which way should the worker go on a Stripe 409?",
  "",
  "Stopped: the retry worker cannot ship without this.",
  "",
  "- [ ] Retry with the same idempotency key",
  "- [ ] Fail the job and send it to the dead-letter queue",
  ":::",
  "",
  ":::question",
  "Ship the retry behind a flag?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

const QUEUE = [":::question", "How many times should the jobs queue retry a Stripe 409?", "", "- [ ] 3 times over 10 minutes", "- [ ] Once, then dead-letter", ":::"].join("\n");

type Sent = { message_id: string; thread_id: string; questions: { key: string; prompt: string }[]; superseded: string[] };

describe("send_message supersedes earlier questions", () => {
  test("the supersedes argument: the old card reads superseded by the new question, and the result names it", async () => {
    const w = await world();
    const first = structured<Sent>(await w.call("send_message", { body: WORKER }));
    const [q1] = first.questions;
    const result = await w.call("send_message", { body: QUEUE, reply_to: first.message_id, supersedes: [`${first.message_id}/${q1!.key}`] });
    const sent = structured<Sent>(result);
    expect(sent.superseded).toEqual([`${first.message_id}/${q1!.key}`]);
    expect((result as { content: { text: string }[] }).content[0]!.text).toContain("superseding 1 earlier question");
    const thread = await w.thread(first.thread_id);
    const old = thread.messages[0]!.questions![0]!;
    expect(old.state).toBe("superseded");
    expect(old.superseded_by).toEqual({ message_id: sent.message_id, key: sent.questions[0]!.key });
    expect(thread.messages[0]!.questions![1]!.state).toBe("open");
    // The subject was the first question's prompt: it follows the replacement.
    expect(thread.subject).toBe("How many times should the jobs queue retry a Stripe 409?");
  });

  test("a Replaces: line in the new block does the same, and read_thread serves the state", async () => {
    const w = await world();
    const first = structured<Sent>(await w.call("send_message", { body: WORKER }));
    const key = first.questions[1]!.key;
    const body = QUEUE.replace(":::question\n", `:::question\nReplaces: ${first.message_id}/${key}\n`);
    const sent = structured<Sent>(await w.call("send_message", { body, reply_to: first.message_id }));
    expect(sent.questions[0]!.prompt).toBe("How many times should the jobs queue retry a Stripe 409?");
    expect(sent.superseded).toEqual([`${first.message_id}/${key}`]);
    const read = structured<{ thread: InboxThread }>(await w.client.callTool({ name: "read_thread", arguments: { thread_id: first.thread_id } }));
    const states = read.thread.messages[0]!.questions!.map((q: InboxQuestion) => q.state);
    expect(states).toEqual(["open", "superseded"]);
  });

  test("an id that names no open question of the thread refuses the whole send with invalid_supersedes, listing the open keys", async () => {
    const w = await world();
    const first = structured<Sent>(await w.call("send_message", { body: WORKER }));
    const [q1, q2] = first.questions;
    const text = errorText(await w.call("send_message", { body: QUEUE, reply_to: first.message_id, supersedes: [`${first.message_id}/q-00000000`] }));
    expect(text.startsWith("invalid_supersedes:")).toBe(true);
    expect(text).toContain(`${first.message_id}/${q1!.key}`);
    expect(text).toContain(`${first.message_id}/${q2!.key}`);
    const lines = errorText(await w.call("send_message", { body: QUEUE.replace(":::question\n", ":::question\nReplaces: msg_00000000000000000000000000/q-12345678\n"), reply_to: first.message_id }));
    expect(lines.startsWith("invalid_supersedes:")).toBe(true);
    // Nothing landed.
    expect((await w.thread(first.thread_id)).messages.length).toBe(1);
  });

  test("submit_guide and the agent tool built from tools/list take supersedes", async () => {
    const w = await world();
    const tools = await w.client.listTools();
    for (const name of ["send_message", "submit_guide"]) {
      const schema = tools.tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties)).toContain("supersedes");
    }
    const agentTool = inboxAgentTool(parseInboxToolList(tools));
    expect(Object.keys((agentTool!.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("supersedes");
  });
});

describe("the window's routes refuse to answer a superseded question (422 question_superseded)", () => {
  test("picks, Send and the decision switch", async () => {
    const w = await world();
    const first = structured<Sent>(await w.call("send_message", { body: WORKER }));
    const q1 = (await w.thread(first.thread_id)).messages[0]!.questions![0]!;
    const answer = (label: string) => ({ v: 1, key: q1.key, kind: q1.kind, prompt: q1.prompt, selected: [label] });
    const picked = await w.post(`/api/inbox/messages/${first.message_id}/picks`, { questions: [{ key: q1.key, revision: 0, answer: answer("Fail the job and send it to the dead-letter queue") }] });
    expect(picked.status).toBe(200);
    await w.call("send_message", { body: QUEUE, reply_to: first.message_id, supersedes: [`${first.message_id}/${q1.key}`] });

    const repick = await w.post(`/api/inbox/messages/${first.message_id}/picks`, { questions: [{ key: q1.key, revision: 1, answer: answer("Retry with the same idempotency key") }] });
    expect(repick.status).toBe(422);
    expect(((await repick.json()) as { code: string }).code).toBe("question_superseded");

    const send = await w.post(`/api/inbox/messages/${first.message_id}/reply`, { idempotency_key: "s1", words: "Dead-letter it.", questions: [{ key: q1.key, revision: 1 }] });
    expect(send.status).toBe(422);
    const body = (await send.json()) as { code: string; superseded_by: { message_id: string; key: string | null } };
    expect(body.code).toBe("question_superseded");
    expect(body.superseded_by.key).not.toBeNull();

    const decision = await w.post(`/api/inbox/messages/${first.message_id}/decision`, { key: q1.key, recording: true });
    expect(decision.status).toBe(422);

    // The pick stays visible on the card, never sent; nothing was written.
    const after = (await w.thread(first.thread_id)).messages;
    expect(after.length).toBe(2);
    expect(after[0]!.questions![0]!.answer?.selected).toEqual(["Fail the job and send it to the dead-letter queue"]);
    expect(after[0]!.questions![0]!.state).toBe("superseded");
  });
});
