/**
 * The cloud wake (inbox-cloud-wake.ts, inbox-cloud-agents.ts) through the Inbox's real doors: Settings' routes pair
 * an agent, New message and the reply route write to it, and a local stub server stands in for the routine's webhook.
 * No outside service is ever called; every test has its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxCloudAgentView } from "@plannotator/core/inbox-cloud";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { cloudAgentsPath } from "./inbox-cloud-agents";

const KEY = "sk-ant-oat01-SECRETKEY0123456789";
const NEW_KEY = "sk-ant-oat01-NEWSECRET9876543210";
const HOOK_PATH = "/v1/claude_code/routines/trig_SECRETPATH42/fire";

interface Seen {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The routine's webhook on loopback: it records each POST and answers from `replies`, then 200 with a run link. */
function stubRoutine() {
  const seen: Seen[] = [];
  const replies: Reply[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push({ headers: Object.fromEntries(req.headers), body: (await req.json()) as Record<string, unknown> });
      const reply = replies.shift() ?? { status: 200, body: { type: "routine_fire", claude_code_session_id: "session_01X", claude_code_session_url: "https://claude.ai/code/session_01X" } };
      if (reply.delayMs) await Bun.sleep(reply.delayMs);
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { "Content-Type": "application/json", ...reply.headers } });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}${HOOK_PATH}`, seen, replies };
}

async function world(options: { gapMs?: number; timeoutMs?: number; retryMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cloud-wake-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const logs: string[] = [];
  const server = await startInboxServer({
    dataDir,
    debug: true,
    cloudWake: { gapMs: options.gapMs ?? 60_000, timeoutMs: options.timeoutMs ?? 2_000, ...(options.retryMs ? { retryMs: options.retryMs } : {}), log: (line) => logs.push(line) },
  });
  cleanups.push(() => server.stop());
  // A project, as an agent's first message makes one.
  const client = new Client({ name: "cloud-wake-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  cleanups.push(() => client.close());
  await client.callTool({ name: "send_message", arguments: { body: "Hello.", project_path: project, agent_session: "ses-pi", agent_host: "pi" } });
  /** Every answer the window got, for the leak check. */
  const answers: string[] = [];
  const call = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
    });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
  };
  const pair = async (url: string, preset = "claude-routine", name = "Nightly fixer") => {
    const answer = await call("/api/inbox/cloud-agents", { name, preset, url, key: `Bearer ${KEY}` });
    expect(answer.status).toBe(200);
    return answer.json.agent as InboxCloudAgentView;
  };
  const send = async (session: string, words: string, key = "c1") => {
    const answer = await call("/api/inbox/messages", { to: { host: "cloud", session }, body: words, idempotency_key: key });
    expect(answer.status).toBe(200);
    return answer.json as { thread_id: string; message: { id: string } };
  };
  const reply = async (messageId: string, words: string, key: string) => {
    const answer = await call(`/api/inbox/messages/${messageId}/reply`, { words, idempotency_key: key });
    expect(answer.status).toBe(200);
    return (answer.json.reply as { id: string }).id;
  };
  const thread = async (id: string) => (await call(`/api/inbox/threads/${id}`)).json.thread as InboxThread;
  const wakeOf = async (threadId: string, messageId: string) => (await thread(threadId)).messages.find((m) => m.id === messageId)?.cloud_wake ?? null;
  return { server, dataDir, logs, answers, call, pair, send, reply, thread, wakeOf };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

/** Every file under a folder, as text. */
function filesUnder(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => ({ path, text: readFileSync(path, "latin1") }));
}

describe("the cloud wake", () => {
  test("New message and a reply wake a Claude routine with the key as Bearer and { text } only; the thread says it started, with the run link", async () => {
    const hook = stubRoutine();
    const w = await world({ gapMs: 50 });
    const agent = await w.pair(hook.url);
    // Listed in New message's To, under its name, in its project.
    const to = (await w.call("/api/inbox/sessions")).json.projects as { sessions: { session: string; host: string; label?: string }[] }[];
    expect(to.flatMap((group) => group.sessions)).toContainEqual(expect.objectContaining({ session: agent.session, host: "cloud", label: "Nightly fixer" }));

    const sent = await w.send(agent.session, "Fix the flaky login test.");
    await until(() => hook.seen.length === 1);
    expect(hook.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(hook.seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(Object.keys(hook.seen[0]!.body)).toEqual(["text"]);
    const text = hook.seen[0]!.body.text as string;
    expect(text).toContain("Fix the flaky login test.");
    expect(text).toContain(`Thread id: ${sent.thread_id}`);
    await until(async () => (await w.wakeOf(sent.thread_id, sent.message.id))?.state === "started");
    const root = (await w.thread(sent.thread_id)).messages[0]!;
    expect(root.cloud_wake).toMatchObject({ state: "started", name: "Nightly fixer", run_url: "https://claude.ai/code/session_01X" });
    expect(root.delivery).toMatchObject({ host: "cloud", session: agent.session });

    await Bun.sleep(80);
    const later = await w.reply(sent.message.id, "Also the signup test.", "r1");
    await until(() => hook.seen.length === 2);
    expect(hook.seen[1]!.body.text).toContain("Also the signup test.");
    await until(async () => (await w.wakeOf(sent.thread_id, later))?.state === "started");
  });

  test("replies inside the minute are held and go together in one wake (Grok Bot: a JSON body)", async () => {
    const hook = stubRoutine();
    const w = await world({ gapMs: 600 });
    const agent = await w.pair(hook.url, "grok-bot", "Grok helper");
    const sent = await w.send(agent.session, "First.");
    await until(() => hook.seen.length === 1);
    const a = await w.reply(sent.message.id, "Second.", "r1");
    const b = await w.reply(sent.message.id, "Third.", "r2");
    await until(async () => (await w.wakeOf(sent.thread_id, b))?.state === "held");
    expect(hook.seen).toHaveLength(1);
    await until(() => hook.seen.length === 2, 3_000);
    const body = hook.seen[1]!.body as { messages: { id: string; body: string }[]; thread: { id: string }; text: string };
    expect(body.messages.map((m) => m.id)).toEqual([a, b]);
    expect(body.thread.id).toBe(sent.thread_id);
    expect(body.text).toContain("Their 2 messages, oldest first:");
    await until(async () => (await w.wakeOf(sent.thread_id, a))?.state === "started" && (await w.wakeOf(sent.thread_id, b))?.state === "started");
    await Bun.sleep(700);
    expect(hook.seen).toHaveLength(2);
  });

  test("no answer in time is uncertain and never sent again, after a restart of the sweep too", async () => {
    const hook = stubRoutine();
    hook.replies.push({ status: 200, delayMs: 600 });
    const w = await world({ gapMs: 50, timeoutMs: 150 });
    const agent = await w.pair(hook.url);
    const sent = await w.send(agent.session, "Do the thing.");
    await until(async () => (await w.wakeOf(sent.thread_id, sent.message.id))?.state === "uncertain");
    await w.server.cloudWake.sweep();
    await Bun.sleep(300);
    await w.server.cloudWake.sweep();
    expect(hook.seen).toHaveLength(1);
  });

  test("a 5xx retries on the backoff; a 429 waits for its Retry-After and says when; then it starts", async () => {
    const hook = stubRoutine();
    hook.replies.push({ status: 503 }, { status: 429, headers: { "Retry-After": "1" } });
    const w = await world({ gapMs: 50, retryMs: 100 });
    const agent = await w.pair(hook.url);
    const sent = await w.send(agent.session, "Go.");
    await until(async () => (await w.wakeOf(sent.thread_id, sent.message.id))?.state === "retrying");
    expect(await w.wakeOf(sent.thread_id, sent.message.id)).toMatchObject({ status: 503, next_at: expect.any(String) });
    await until(async () => (await w.wakeOf(sent.thread_id, sent.message.id))?.state === "rate_limited");
    const limited = (await w.wakeOf(sent.thread_id, sent.message.id))!;
    expect(Date.parse(limited.next_at!) - Date.parse(limited.at)).toBe(1000);
    expect(hook.seen).toHaveLength(2);
    await until(async () => (await w.wakeOf(sent.thread_id, sent.message.id))?.state === "started", 4_000);
    expect(hook.seen).toHaveLength(3);
  });

  test("the key and the address never appear in an API answer, an event, a log line, the debug log or any other file; Remove deletes them and stops wakes", async () => {
    const hook = stubRoutine();
    hook.replies.push({ status: 401, body: { type: "error", error: { type: "authentication_error", message: `bad token ${KEY}` } } });
    const w = await world({ gapMs: 50 });
    const events = await fetch(`http://127.0.0.1:${w.server.port}/api/inbox/events?cursor=0`);
    const reader = events.body!.getReader();
    const agent = await w.pair(hook.url);
    expect(statSync(cloudAgentsPath(w.dataDir)).mode & 0o777).toBe(0o600);
    const sent = await w.send(agent.session, "Hello.");
    await until(async () => (await w.wakeOf(sent.thread_id, sent.message.id))?.state === "key_rejected");
    const listed = (await w.call("/api/inbox/cloud-agents")).json.agents as InboxCloudAgentView[];
    expect(listed[0]).toMatchObject({ key_set: true, key_rejected_at: expect.any(String) });
    // A new key: the held item goes.
    await w.call(`/api/inbox/cloud-agents/${agent.session}/key`, { key: NEW_KEY });
    await until(() => hook.seen.length === 2);
    expect(hook.seen[1]!.headers.authorization).toBe(`Bearer ${NEW_KEY}`);
    await w.call(`/api/inbox/cloud-agents/${agent.session}/test`, {});
    await until(async () => (await w.wakeOf(sent.thread_id, sent.message.id))?.state === "started");

    // Remove: the file holds neither, the agent is no longer offered, and a reply wakes nothing.
    await w.call(`/api/inbox/cloud-agents/${agent.session}/remove`, {});
    const after = readFileSync(cloudAgentsPath(w.dataDir), "utf8");
    expect(after).not.toContain(NEW_KEY);
    expect(after).not.toContain("trig_SECRETPATH42");
    const count = hook.seen.length;
    await w.reply(sent.message.id, "Are you there?", "r9");
    await w.server.cloudWake.sweep();
    await Bun.sleep(200);
    expect(hook.seen).toHaveLength(count);
    expect((await w.call("/api/inbox/messages", { to: { host: "cloud", session: agent.session }, body: "Hi", idempotency_key: "c9" })).status).toBe(409);

    const frames: string[] = [];
    const read = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        frames.push(new TextDecoder().decode(chunk.value));
      }
    })();
    await Bun.sleep(150);
    await reader.cancel();
    await read.catch(() => {});
    // The debug log is written about every 250 ms.
    await Bun.sleep(400);
    const haystacks = [...w.answers, ...frames, ...w.logs, ...filesUnder(w.dataDir).map((file) => file.text)];
    for (const secret of [KEY, NEW_KEY, "trig_SECRETPATH42"]) {
      expect(haystacks.filter((text) => text.includes(secret))).toEqual([]);
    }
    expect(filesUnder(w.dataDir).some((file) => file.path.endsWith("debug.log"))).toBe(true);
  });
});
