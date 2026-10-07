/**
 * The Inbox's row model, proved through its real doors (owner ruling
 * 2026-10-07: "a row is a thread"): a running Inbox on loopback, the
 * official MCP SDK client over streamable HTTP for the agent side, and real
 * `fetch` for the window's list. Every test uses its own temp data dir.
 *
 *  - routing: an agent session's messages land in one thread; `thread`
 *    splits or joins by name; resolved means done; reply_to wins;
 *  - the list: one row per thread with its project label, placed in the
 *    approved sections, with and without the project filter;
 *  - a store written by step 1 replays, lists and routes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxListSection, InboxQuestion } from "@plannotator/core/inbox-types";
import { parseInboxLine } from "@plannotator/shared/inbox/schema";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-threads-")));
  roots.push(root);
  return root;
}

function gitProject(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return dir;
}

async function start(dataDir: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return server;
}

async function mcpClient(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-threads-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function post(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

type Sent = { message_id: string; thread_id: string; new_thread: boolean; thread_name: string | null; replayed: boolean };

function structured<T>(result: unknown): T {
  const value = (result as { structuredContent?: unknown }).structuredContent;
  if (!value) throw new Error(`no structuredContent: ${JSON.stringify(result)}`);
  return value as T;
}

function errorText(result: unknown): string {
  expect((result as { isError?: boolean }).isError).toBe(true);
  return ((result as { content: { text: string }[] }).content[0]!).text;
}

interface ListModel {
  projects: { id: string; name: string; threads: number; unread: number }[];
  project: string | null;
  sections: InboxListSection[];
}

async function list(server: InboxServer, project?: string): Promise<ListModel> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads${project ? `?project=${project}` : ""}`);
  expect(res.status).toBe(200);
  return res.json();
}

/** Section id → the subjects in it, in order: what the person sees. */
function placed(model: ListModel): Record<string, string[]> {
  return Object.fromEntries(model.sections.map((s) => [s.id, s.threads.map((t) => t.subject ?? t.thread_id)]));
}

function rowsOf(model: ListModel): InboxListRow[] {
  return model.sections.flatMap((s) => s.threads);
}

describe("send_message routing: a row is a thread", () => {
  test("a session's sends share a thread; `thread` splits and joins by name; resolved starts anew; reply_to wins", async () => {
    const root = tempRoot();
    const repo = gitProject(root, "api");
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    const send = async (args: Record<string, unknown>) =>
      structured<Sent>(await client.callTool({ name: "send_message", arguments: { project_path: repo, ...args } }));

    // Two sends from one session: one thread, which keeps its first subject.
    const a1 = await send({ body: "Starting the retry worker.", subject: "Retry worker", agent_session: "ses_A" });
    const a2 = await send({ body: "Half way there.", subject: "Ignored subject", agent_session: "ses_A" });
    expect(a1.new_thread).toBe(true);
    expect(a2).toMatchObject({ thread_id: a1.thread_id, new_thread: false, thread_name: null });

    // A third from the same session, named "b": a second thread.
    const a3 = await send({ body: "Separately: the docs.", subject: "Docs", thread: "b", agent_session: "ses_A" });
    expect(a3.thread_id).not.toBe(a1.thread_id);
    expect(a3).toMatchObject({ new_thread: true, thread_name: "b" });

    // Another session naming "b" (any case, extra spaces) joins it.
    const b1 = await send({ body: "I can take the docs.", thread: "  B ", agent_session: "ses_B" });
    expect(b1).toMatchObject({ thread_id: a3.thread_id, new_thread: false, thread_name: "b" });
    // ...while its own unnamed message starts its own default thread.
    const b2 = await send({ body: "My own work.", subject: "B's work", agent_session: "ses_B" });
    expect(b2.new_thread).toBe(true);
    expect([a1.thread_id, a3.thread_id]).not.toContain(b2.thread_id);
    // And ses_A's next unnamed message is back in its default thread.
    expect((await send({ body: "Done with the worker.", agent_session: "ses_A" })).thread_id).toBe(a1.thread_id);

    // The thread holds every message, with its first subject.
    const thread = structured<{ thread: { subject: string; thread_name: string | null; messages: { body: string }[] } }>(
      await client.callTool({ name: "read_thread", arguments: { thread_id: a1.thread_id } }),
    ).thread;
    expect(thread.subject).toBe("Retry worker");
    expect(thread.messages.map((m) => m.body)).toEqual(["Starting the retry worker.", "Half way there.", "Done with the worker."]);
    const named = structured<{ thread: { thread_name: string; messages: unknown[] } }>(
      await client.callTool({ name: "read_thread", arguments: { thread_id: a3.thread_id } }),
    ).thread;
    expect(named).toMatchObject({ thread_name: "b" });
    expect(named.messages).toHaveLength(2);

    // Resolved = done: the session's next message starts a new thread, and stays in it.
    await client.callTool({ name: "resolve_message", arguments: { message_id: a2.message_id } });
    const a5 = await send({ body: "Something new came up.", subject: "Follow-up", agent_session: "ses_A" });
    expect(a5.new_thread).toBe(true);
    expect(a5.thread_id).not.toBe(a1.thread_id);
    expect((await send({ body: "More on it.", agent_session: "ses_A" })).thread_id).toBe(a5.thread_id);
    // Same for a named thread: resolved, the name starts a new thread under it.
    await client.callTool({ name: "resolve_message", arguments: { message_id: a3.thread_id } });
    const b3 = await send({ body: "Docs, round two.", thread: "b", agent_session: "ses_B" });
    expect(b3).toMatchObject({ new_thread: true, thread_name: "b" });
    expect(b3.thread_id).not.toBe(a3.thread_id);
    expect((await send({ body: "Docs, more.", thread: "B", agent_session: "ses_A" })).thread_id).toBe(b3.thread_id);

    // reply_to wins over the session and the name: the reply lands in the
    // replied-to thread (resolved or not), never in ses_B's or in "b".
    const reply = await send({ body: "One more note on the worker.", reply_to: a2.message_id, thread: "b", agent_session: "ses_B" });
    expect(reply).toMatchObject({ thread_id: a1.thread_id, new_thread: false });
    const replied = structured<{ thread: { messages: { id: string; reply_to: string | null }[] } }>(
      await client.callTool({ name: "read_thread", arguments: { thread_id: a1.thread_id } }),
    ).thread.messages.at(-1)!;
    expect(replied).toMatchObject({ id: reply.message_id, reply_to: a2.message_id });

    // No session: nothing to join, each message is its own thread (step 1's behaviour).
    const anon1 = structured<Sent>(await client.callTool({ name: "send_message", arguments: { body: "anon one", project_path: repo } }));
    const anon2 = structured<Sent>(await client.callTool({ name: "send_message", arguments: { body: "anon two", project_path: repo } }));
    expect(anon1.thread_id).not.toBe(anon2.thread_id);

    // An idempotent retry answers the first message, even after its thread was resolved.
    const keyed = await send({ body: "Keyed.", agent_session: "ses_C", idempotency_key: "k-1" });
    await client.callTool({ name: "resolve_message", arguments: { message_id: keyed.message_id } });
    expect(await send({ body: "Keyed.", agent_session: "ses_C", idempotency_key: "k-1" })).toMatchObject({
      message_id: keyed.message_id,
      thread_id: keyed.thread_id,
      replayed: true,
    });

    // Thread names are validated.
    for (const bad of ["   ", "x".repeat(121), "two\nlines", "tab\there"]) {
      const result = await client.callTool({ name: "send_message", arguments: { body: "x", project_path: repo, thread: bad, agent_session: "ses_A" } });
      expect(errorText(result)).toMatch(/^validation_error: thread: /);
    }
    expect((await send({ body: "ok", thread: "x".repeat(120), agent_session: "ses_A" })).new_thread).toBe(true);

    // read_thread lists the threads a session sent in: started, joined or replied in.
    const mine = structured<{ threads: InboxListRow[] }>(
      await client.callTool({ name: "read_thread", arguments: { project_path: repo, agent_session: "ses_B", include_resolved: true } }),
    ).threads;
    expect(new Set(mine.map((t) => t.thread_id))).toEqual(new Set([a3.thread_id, b2.thread_id, b3.thread_id, a1.thread_id]));
    expect(mine.every((t) => t.project.name === "api" && typeof t.section === "string")).toBe(true);
  });
});

const STOPPED = [":::question", "Ship the worker with retries?", "", "Stopped: the worker cannot ship without this.", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
const HOLDS = [":::question", "Which queue for the exports?", "", "Holds up: the export job; the nightly report", "", "- [ ] Main", "- [ ] Bulk", ":::"].join("\n");
const PLAIN_Q = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

describe("the list: per-thread sections across projects", () => {
  test("threads in every state land in their sections; the project filter keeps the sections", async () => {
    const root = tempRoot();
    const api = gitProject(root, "api");
    const web = gitProject(root, "web");
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    // A few ms apart, so "oldest first" and "newest first" have distinct times to order by.
    const send = async (repo: string, session: string, body: string, subject: string) => {
      await Bun.sleep(3);
      return structured<Sent>(await client.callTool({ name: "send_message", arguments: { project_path: repo, agent_session: session, body, subject } }));
    };
    const questionsOf = async (messageId: string, threadId: string): Promise<InboxQuestion[]> => {
      const { thread } = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}`)).json();
      return thread.messages.find((m: { id: string }) => m.id === messageId).questions;
    };
    const pick = async (sent: Sent) => {
      const [q] = await questionsOf(sent.message_id, sent.thread_id);
      const res = await post(server, `/api/inbox/messages/${sent.message_id}/picks`, {
        questions: [{ key: q!.key, revision: q!.revision, answer: { v: 1, key: q!.key, kind: q!.kind, prompt: q!.prompt, selected: ["Yes"] } }],
      });
      expect(res.status).toBe(200);
      return q!;
    };

    const stopped = await send(api, "s1", STOPPED, "Stopped worker");
    const holding = await send(api, "s2", HOLDS, "Export queue");
    const waitingOld = await send(web, "s3", PLAIN_Q("Use the new header?"), "Header");
    const waitingNew = await send(api, "s4", PLAIN_Q("Rename the flag?"), "Flag name");
    const sentRow = await send(web, "s5", PLAIN_Q("Merge the web PR?"), "Web PR");
    const news = await send(api, "s6", "The nightly build is green.", "Nightly build");
    const answered = await send(web, "s7", PLAIN_Q("Bump the SDK?"), "SDK bump");
    const done = await send(web, "s8", "All finished here.", "Finished");

    // The person's actions: Send on one thread, a pick (not sent) on another, resolve a third.
    const q = await pick(sentRow);
    const reply = await post(server, `/api/inbox/messages/${sentRow.message_id}/reply`, { idempotency_key: "r1", words: "Yes, merge.", questions: [{ key: q.key, revision: q.revision + 1 }] });
    expect(reply.status).toBe(200);
    await pick(answered);
    await post(server, `/api/inbox/messages/${done.message_id}/resolve`, { resolved: true });

    const all = await list(server);
    expect(all.sections.map((s) => [s.id, s.label])).toEqual([
      ["stopped", "Stopped on you"],
      ["holding", "Holding up work"],
      ["waiting", "Waiting on you"],
      ["sent", "Sent"],
      ["new", "New since you looked"],
      ["quiet", "Quiet"],
    ]);
    expect(placed(all)).toEqual({
      stopped: ["Stopped worker"],
      holding: ["Export queue"],
      waiting: ["Header", "Flag name"], // oldest waiting first
      sent: ["Web PR"],
      new: ["SDK bump", "Nightly build"], // newest first
      quiet: ["Finished"],
    });
    // One row per thread, each with its project as a label.
    const rows = rowsOf(all);
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.thread_id)).size).toBe(8);
    const byThread = new Map(rows.map((r) => [r.thread_id, r]));
    expect(byThread.get(stopped.thread_id)).toMatchObject({ project: { name: "api" }, unread: true, questions: { stopped: true } });
    expect(byThread.get(holding.thread_id)).toMatchObject({ questions: { holds_up: ["the export job", "the nightly report"] } });
    expect(byThread.get(waitingOld.thread_id)).toMatchObject({ project: { name: "web" } });
    expect(byThread.get(waitingNew.thread_id)?.project.name).toBe("api");
    expect(byThread.get(sentRow.thread_id)).toMatchObject({ unread: false, sent: { checked_at: null } });
    expect(byThread.get(answered.thread_id)).toMatchObject({ answered_not_sent: true, unread: true });
    expect(byThread.get(news.thread_id)).toMatchObject({ unseen: 1, unread: true });
    expect(byThread.get(done.thread_id)).toMatchObject({ unread: false });
    expect(all.projects.map((p) => [p.name, p.threads, p.unread])).toEqual([
      ["api", 4, 4],
      ["web", 4, 2],
    ]);

    // The filter keeps every section and drops the other project's rows.
    const apiId = all.projects.find((p) => p.name === "api")!.id;
    const webId = all.projects.find((p) => p.name === "web")!.id;
    const apiOnly = await list(server, apiId);
    expect(apiOnly.project).toBe(apiId);
    expect(placed(apiOnly)).toEqual({ stopped: ["Stopped worker"], holding: ["Export queue"], waiting: ["Flag name"], sent: [], new: ["Nightly build"], quiet: [] });
    expect(placed(await list(server, webId))).toEqual({ stopped: [], holding: [], waiting: ["Header"], sent: ["Web PR"], new: ["SDK bump"], quiet: ["Finished"] });
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads?project=nope`)).status).toBe(422);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads?project=prj_01ARZ3NDEKTSV4RRFFQ69G5FAV`)).status).toBe(404);

    // The agent reads the reply: Sent moves to Quiet.
    const got = structured<{ status: string }>(await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sentRow.thread_id, timeout_seconds: 5 } }));
    expect(got.status).toBe("replied");
    // The person opens the news: it leaves "New since you looked"...
    const seen = await post(server, `/api/inbox/threads/${news.thread_id}/seen`, {});
    expect(seen.status).toBe(200);
    expect((await seen.json()).thread.section).toBe("quiet");
    expect(placed(await list(server))).toMatchObject({ sent: [], new: ["SDK bump"], quiet: ["Web PR", "Finished", "Nightly build"] });
    // ...until the same agent session writes again into that thread.
    expect((await send(api, "s6", "And the deploy is out.", "ignored")).thread_id).toBe(news.thread_id);
    expect(placed(await list(server, apiId)).new).toEqual(["Nightly build"]);

    // A stale tab's seen is refused like any other window write.
    const stale = await post(server, `/api/inbox/threads/${news.thread_id}/seen`, { serverSession: "not-this-one" });
    expect(stale.status).toBe(409);
  });
});

describe("routing edges, through the real doors", () => {
  test("look-alike names are one thread; bidi controls and invisible-only names are refused; a key reused with another name is refused", async () => {
    const root = tempRoot();
    const repo = gitProject(root, "api");
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    const call = (args: Record<string, unknown>) => client.callTool({ name: "send_message", arguments: { project_path: repo, ...args } });
    const first = structured<Sent>(await call({ body: "Auth work.", thread: "auth", agent_session: "ses_A" }));
    expect(first.new_thread).toBe(true);
    // A zero-width space or joiner, a BOM, full-width letters, other case:
    // they draw (or read) as "auth", so they are "auth".
    for (const spelling of ["auth​", "​au‍th", "﻿auth", "ａｕｔｈ", "AUTH"]) {
      expect(structured<Sent>(await call({ body: `as ${JSON.stringify(spelling)}`, thread: spelling, agent_session: "ses_B" }))).toMatchObject({
        thread_id: first.thread_id,
        new_thread: false,
        thread_name: "auth",
      });
    }
    // Nothing visible, or text that reorders itself on screen: refused.
    for (const bad of ["​", "​‌⁠", "‮htua", "auth⁦x⁩", "a‏b"]) {
      expect(errorText(await call({ body: "x", thread: bad, agent_session: "ses_A" }))).toMatch(/^validation_error: thread: /);
    }
    // An idempotent retry is the same call: another thread name with the key is a different message.
    const keyed = structured<Sent>(await call({ body: "Keyed.", thread: "auth", idempotency_key: "k-auth", agent_session: "ses_A" }));
    expect(errorText(await call({ body: "Keyed.", thread: "billing", idempotency_key: "k-auth", agent_session: "ses_A" }))).toMatch(
      /^idempotency_key_reused: /,
    );
    expect(errorText(await call({ body: "Keyed.", idempotency_key: "k-auth", agent_session: "ses_A" }))).toMatch(/^idempotency_key_reused: /);
    expect(structured<Sent>(await call({ body: "Keyed.", thread: " AUTH ", idempotency_key: "k-auth", agent_session: "ses_A" }))).toMatchObject({
      message_id: keyed.message_id,
      replayed: true,
    });
  });

  test("a name joins its newest OPEN thread: one the person reopened, after a later one was resolved", async () => {
    const root = tempRoot();
    const repo = gitProject(root, "api");
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    const send = async (body: string) =>
      structured<Sent>(await client.callTool({ name: "send_message", arguments: { project_path: repo, body, thread: "x", agent_session: "ses_A" } }));
    const t1 = await send("one");
    expect((await post(server, `/api/inbox/messages/${t1.message_id}/resolve`, { resolved: true })).status).toBe(200);
    const t2 = await send("two");
    expect(t2.new_thread).toBe(true);
    expect((await post(server, `/api/inbox/messages/${t2.message_id}/resolve`, { resolved: true })).status).toBe(200);
    expect((await post(server, `/api/inbox/messages/${t1.message_id}/resolve`, { resolved: false })).status).toBe(200);
    expect(await send("three")).toMatchObject({ thread_id: t1.thread_id, new_thread: false });
  });

  test("sessions racing on one name, and one session's parallel sends, each land in ONE thread, and stay so after a restart", async () => {
    const root = tempRoot();
    const repo = gitProject(root, "api");
    const dataDir = join(root, "data");
    let server = await start(dataDir);
    // Two separate MCP connections, like two agents.
    const [c1, c2] = [await mcpClient(server), await mcpClient(server)];
    const sendVia = (client: Client, args: Record<string, unknown>) =>
      client.callTool({ name: "send_message", arguments: { project_path: repo, ...args } }).then((r) => structured<Sent>(r));
    const raced = await Promise.all(
      Array.from({ length: 12 }, (_, i) => sendVia(i % 2 ? c1 : c2, { body: `race ${i}`, thread: i % 3 ? "Race" : "race ", agent_session: `ses_${i % 4}` })),
    );
    expect(new Set(raced.map((r) => r.thread_id)).size).toBe(1);
    expect(raced.filter((r) => r.new_thread)).toHaveLength(1);
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => sendVia(i % 2 ? c1 : c2, { body: `burst ${i}`, agent_session: "ses_P" })));
    expect(new Set(burst.map((r) => r.thread_id)).size).toBe(1);
    expect(burst.filter((r) => r.new_thread)).toHaveLength(1);

    const before = await list(server);
    expect(rowsOf(before)).toHaveLength(2);
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    server = await start(dataDir);
    expect((await list(server)).sections).toEqual(before.sections);
  });

  test("wait_for_reply in a shared thread: another session writing after the reply does not hide it; a returned reply checks only itself", async () => {
    const root = tempRoot();
    const repo = gitProject(root, "api");
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    const send = async (args: Record<string, unknown>) =>
      structured<Sent>(await client.callTool({ name: "send_message", arguments: { project_path: repo, ...args } }));
    const wait = async (args: Record<string, unknown>) =>
      structured<{ status: string; cursor: number; reply?: { body: string } }>(
        await client.callTool({ name: "wait_for_reply", arguments: { timeout_seconds: 1, ...args } }),
      );

    // ses_A asks in "shared"; the person answers; ses_B then writes in the same thread.
    const asked = await send({ body: PLAIN_Q("Use the new schema?"), thread: "shared", agent_session: "ses_A" });
    expect((await post(server, `/api/inbox/messages/${asked.message_id}/reply`, { idempotency_key: "r-shared", words: "Yes, the new one." })).status).toBe(200);
    await send({ body: "I am on the migration.", thread: "shared", agent_session: "ses_B" });
    // ses_A still gets the answer at once: the threshold is ITS last message, not ses_B's.
    expect(await wait({ thread_id: asked.thread_id, agent_session: "ses_A" })).toMatchObject({
      status: "replied",
      reply: { body: expect.stringContaining("Yes, the new one.") },
    });

    // Two replies before the agent looks: the first one returned leaves the row in Sent.
    const q = await send({ body: "Ready to merge?", agent_session: "ses_C" });
    for (const [key, words] of [["r1", "First thought."], ["r2", "Second thought."]]) {
      expect((await post(server, `/api/inbox/messages/${q.message_id}/reply`, { idempotency_key: key, words })).status).toBe(200);
    }
    const rowOf = async () => rowsOf(await list(server)).find((r) => r.thread_id === q.thread_id)!;
    expect(await rowOf()).toMatchObject({ section: "sent", sent: { checked_at: null } });
    const got1 = await wait({ thread_id: q.thread_id, agent_session: "ses_C" });
    expect(got1.reply?.body).toContain("First thought.");
    expect(await rowOf()).toMatchObject({ section: "sent", sent: { checked_at: null } });
    const got2 = await wait({ thread_id: q.thread_id, agent_session: "ses_C", cursor: got1.cursor });
    expect(got2.reply?.body).toContain("Second thought.");
    expect((await rowOf()).section).toBe("quiet");
  });

  test("/seen: a look with nothing new writes nothing; the window guards refuse before anything is written", async () => {
    const root = tempRoot();
    const repo = gitProject(root, "api");
    const dataDir = join(root, "data");
    const server = await start(dataDir);
    const client = await mcpClient(server);
    const sent = structured<Sent>(
      await client.callTool({ name: "send_message", arguments: { project_path: repo, body: "Build is green.", agent_session: "ses_A" } }),
    );
    const lineCount = () =>
      readdirSync(join(dataDir, "inbox", "projects"))
        .map((key) => readFileSync(join(dataDir, "inbox", "projects", key, "messages.jsonl"), "utf8").split("\n").filter(Boolean).length)
        .reduce((a, b) => a + b, 0);
    const seenPath = `/api/inbox/threads/${sent.thread_id}/seen`;

    // The first look writes once.
    const start0 = lineCount();
    expect((await post(server, seenPath, {})).status).toBe(200);
    expect(lineCount()).toBe(start0 + 1);
    await send(client, repo, "More news.");
    const afterNews = lineCount();
    // Refused: a cross-site page, a foreign Host (DNS rebinding), a stale tab. Nothing is written.
    const crossSite = await fetch(`http://127.0.0.1:${server.port}${seenPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json()).code).toBe("cross_origin");
    const rebound = await rawPost(server.port, seenPath, [`Host: rebind.attacker.test:${server.port}`], "{}");
    expect(rebound.status).toBe(403);
    expect(rebound.text).toContain("host_not_allowed");
    expect((await post(server, seenPath, { serverSession: "stale" })).status).toBe(409);
    expect(lineCount()).toBe(afterNews);
    expect(placed(await list(server)).new).toEqual(["Build is green."]);

    // A second look writes once; a third, with nothing new, writes nothing.
    expect((await post(server, seenPath, {})).status).toBe(200);
    expect(lineCount()).toBe(afterNews + 1);
    expect((await post(server, seenPath, {})).status).toBe(200);
    expect(lineCount()).toBe(afterNews + 1);
    // The person's own reply is a look: opening the thread after it writes nothing.
    expect((await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "p1", words: "Thanks." })).status).toBe(200);
    const afterReply = lineCount();
    expect((await post(server, seenPath, {})).status).toBe(200);
    expect(lineCount()).toBe(afterReply);

    expect((await post(server, "/api/inbox/threads/msg_01ARZ3NDEKTSV4RRFFQ69G5FAV/seen", {})).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${server.port}${seenPath}`)).status).toBe(405);
  });
});

/** A raw HTTP/1.1 POST, so the Host header is exactly what the test sends. */
function rawPost(port: number, path: string, headers: string[], body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), text: data }));
    const head = [`POST ${path} HTTP/1.1`, ...headers, "Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", ""];
    socket.write(head.join("\r\n") + body);
  });
}

async function send(client: Client, repo: string, body: string, session = "ses_A"): Promise<Sent> {
  return structured<Sent>(await client.callTool({ name: "send_message", arguments: { project_path: repo, body, agent_session: session } }));
}

describe("a store written by step 1", () => {
  const FIXTURE = join(import.meta.dir, "..", "..", "tests", "test-fixtures", "inbox-step1");

  test("replays unchanged, lists one row per thread in its section, and routes the session's next message", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    cpSync(FIXTURE, dataDir, { recursive: true });
    const records = readdirSync(join(dataDir, "inbox", "projects")).flatMap((key) =>
      readFileSync(join(dataDir, "inbox", "projects", key, "messages.jsonl"), "utf8")
        .split("\n")
        .map((line) => parseInboxLine(line))
        .filter((line) => line !== null && line.kind === "message"),
    );
    // Step 1 put every root-less send in its own thread: two roots from ses_old1 in api.
    const roots1 = records.filter((l) => l!.record.id === (l!.record as { thread_id: string }).thread_id);
    expect(new Set(roots1.map((l) => l!.id)).size).toBe(3);

    let server = await start(dataDir);
    const model = await list(server);
    const rows = rowsOf(model);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.thread_name === null)).toBe(true);
    expect(placed(model)).toEqual({
      stopped: [],
      holding: [],
      waiting: [],
      sent: ["Stripe 409"], // the person's Send is the last message, never read by the agent
      new: ["Second thought, separate in step 1."],
      quiet: ["Web build is green."], // resolved
    });
    // Every stored message reads back as it was written.
    for (const line of records) {
      const { thread } = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${(line!.record as { thread_id: string }).thread_id}`)).json();
      const read = thread.messages.find((m: { id: string }) => m.id === line!.id);
      const { resolved_at: _r, ...unchanged } = line!.record as unknown as Record<string, unknown>;
      expect(read).toMatchObject(unchanged);
    }
    const webId = model.projects.find((p) => p.name === "web")!.id;
    expect(placed(await list(server, webId))).toMatchObject({ quiet: ["Web build is green."], new: [], sent: [] });

    // ses_old1's next unnamed message joins its newest open thread (step 1's m2).
    const second = rows.find((r) => r.subject === "Second thought, separate in step 1.")!;
    const joined = server.store.sendMessage({
      project_id: second.project_id,
      author: { kind: "agent", host: "claude-code", session: "ses_old1", name: null },
      body: "Picking it back up.",
    });
    expect(joined.message.thread_id).toBe(second.thread_id);

    // A restart replays the mixed old/new log to the same list.
    const before = await list(server);
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    server = await start(dataDir);
    const after = await list(server);
    expect(after.sections).toEqual(before.sections);
  });
});
