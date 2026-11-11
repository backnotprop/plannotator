import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_RECENT_SEARCHES_FILE } from "./inbox-search";

type Json = Record<string, any>;

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(extra: Parameters<typeof startInboxServer>[0] = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-search-route-")));
  roots.push(root);
  const api = join(root, "api");
  mkdirSync(api, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, phones: false, ...extra });
  servers.push(server);
  const client = new Client({ name: "inbox-search-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  let n = 0;
  const send = async (subject: string, body: string) => {
    n += 1;
    const sent = (await client.callTool({
      name: "send_message",
      arguments: { project_path: api, agent_session: "ses_search", agent_name: "Claude Code", thread: `t${n}`, subject, body },
    })) as { structuredContent: { thread_id: string } };
    return sent.structuredContent.thread_id;
  };
  const base = `http://127.0.0.1:${server.port}`;
  const get = async (query: string) => {
    const response = await fetch(`${base}/api/inbox/search?${query}`);
    return { status: response.status, body: (await response.json()) as Json };
  };
  const searchSettled = async (query: string) => {
    for (let i = 0; i < 200; i++) {
      const answer = await get(query);
      if (answer.status !== 200 || !answer.body.indexing) return answer;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the index never finished");
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/inbox/search/recent`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { root, server, base, send, get, searchSettled, post, project: () => server.store.listProjects()[0]!.id };
}

describe("GET /api/inbox/search", () => {
  test("answers groups, totals, terms and marks; validates its parameters", async () => {
    const w = await setup();
    const relay = await w.send("Relay: rate limit on mailbox creation", "The relay brakes one thing: creating a mailbox, 20 a minute per IP.");
    await w.send("Retry storm", "Every phone reconnected at once after the deploy; under the rate limit now.");
    const { status, body } = await w.searchSettled("q=rate%20lim");
    expect(status).toBe(200);
    expect(body).toMatchObject({ q: "rate lim", terms: ["rate", "lim"], indexing: false, recent: null, serverSession: w.server.serverSession });
    expect(body.totals).toEqual({ threads: 1, messages: 1, files: 0, projects: 0 });
    expect(body.groups.threads[0]).toMatchObject({ type: "thread", id: relay, thread_id: relay, section: "new", archived: false });
    const thread = body.groups.threads[0];
    expect(thread.title_marks.map(([a, l]: [number, number]) => thread.title.slice(a, a + l))).toEqual(["rate", "lim"]);
    expect(typeof body.took_ms).toBe("number");
    expect((await w.get("q=x&status=soon")).status).toBe(422);
    expect((await w.get("q=x&from=them")).status).toBe(422);
    expect((await w.get("q=x&limit=500")).status).toBe(422);
    expect((await w.get("q=x&project=bogus")).status).toBe(422);
    expect((await w.get("q=x&project=prj_01M4V7JERHR0Y3XQERK1MR604E")).status).toBe(404);
    expect((await fetch(`${w.base}/api/inbox/search`, { method: "POST" })).status).toBe(405);
    const scoped = await w.get(`q=rate&project=${w.project()}&status=new`);
    expect(scoped.body.totals.threads).toBe(1);
  });

  test("rows in a thread carry its subject and name; there is no decisions group", async () => {
    const w = await setup();
    const sent = (await (clients.at(-1)!).callTool({
      name: "send_message",
      arguments: {
        project_path: join(w.root, "api"),
        agent_session: "ses_search",
        agent_name: "Claude Code",
        thread: "nightly-deploy",
        subject: "Nightly deploy fails on the second retry",
        body: ":::question\nPin the CDN cache key to the build id?\n\n- [ ] Yes\n- [ ] No\n:::",
      },
    })) as { structuredContent: { thread_id: string; message_id: string; questions: { key: string; kind: string; prompt: string }[] } };
    const { thread_id: threadId, message_id: messageId, questions } = sent.structuredContent;
    const q = questions[0]!;
    const windowPost = (path: string, body: Json) =>
      fetch(`${w.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, serverSession: w.server.serverSession }) });
    const answer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] };
    expect((await windowPost(`/api/inbox/messages/${messageId}/picks`, { questions: [{ key: q.key, revision: 0, answer }] })).status).toBe(200);
    expect((await windowPost(`/api/inbox/messages/${messageId}/reply`, { idempotency_key: "k", questions: [{ key: q.key, revision: 1 }] })).status).toBe(200);

    const { body } = await w.searchSettled("q=cdn%20cache%20key");
    expect(body.groups.messages[0]).toMatchObject({ type: "message", id: messageId, thread_id: threadId, title: "Nightly deploy fails on the second retry", thread_name: "nightly-deploy" });
    expect(Object.keys(body.groups).sort()).toEqual(["files", "messages", "projects", "threads"]);
    expect(Object.keys(body.totals).sort()).toEqual(["files", "messages", "projects", "threads"]);

    expect((await windowPost(`/api/inbox/threads/${threadId}/delete`, {})).status).toBe(200);
    const after = await w.searchSettled("q=cdn%20cache%20key");
    expect(after.body.groups.messages).toEqual([]);
  });

  test("the first search builds in slices: indexing answers carry the thread count, other routes keep answering, and a later search finds a message sent after the build", async () => {
    // Slow slices: every thread is a slice and each yield waits 30 ms, so the build of 60 threads outlasts the route's wait.
    let clock = 0;
    const w = await setup({ searchIndex: { sliceMs: 1, now: () => (clock += 1), yieldNow: () => new Promise((r) => setTimeout(r, 30)) } });
    for (let i = 0; i < 60; i++) await w.send(`Thread ${i}`, `Notes number ${i} about the relay.`);
    const first = await w.get("q=relay");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ indexing: true, threads: 60, groups: null, totals: null });
    const started = performance.now();
    expect((await fetch(`${w.base}/api/inbox/health`)).status).toBe(200);
    expect((await fetch(`${w.base}/api/inbox/threads`)).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(w.server.search.ready()).toBe(false);
    const settled = await w.searchSettled("q=relay");
    expect(settled.body.totals.messages).toBe(60);
    const stats = w.server.search.lastBuildStats()!;
    expect(stats.slices).toBeGreaterThan(5);
    const late = await w.send("Late arrival", "Sent after the index was built.");
    const found = await w.get("q=late%20arrival");
    expect(found.body.groups.threads.map((t: Json) => t.id)).toEqual([late]);
  }, 30_000);

  test("another site or another localhost port is refused before anything is searched; the window's own page is answered", async () => {
    const w = await setup();
    await w.send("Relay rate limit", "The relay allows 20 mailbox creates a minute.");
    await w.searchSettled("q=relay");
    const path = `${w.base}/api/inbox/search?q=relay`;
    const searchedBefore = w.server.search.lastBuildStats();
    for (const headers of [
      { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" },
      { "Sec-Fetch-Site": "cross-site" },
      // Another localhost port is the same site: a page there must not time our searches either.
      { "Sec-Fetch-Site": "same-site", Origin: "http://localhost:5173" },
      { Origin: "https://evil.example" },
      { Origin: "null" },
    ] as Record<string, string>[]) {
      const response = await fetch(path, { headers });
      expect([JSON.stringify(headers), response.status, ((await response.json()) as Json).code]).toEqual([JSON.stringify(headers), 403, "cross_origin"]);
    }
    expect((await fetch(`${w.base}/api/inbox/search/recent`, { method: "POST", headers: { "Sec-Fetch-Site": "same-site", "Content-Type": "application/json" }, body: JSON.stringify({ q: "x" }) })).status).toBe(403);
    const own = await fetch(path, { headers: { "Sec-Fetch-Site": "same-origin", Origin: w.base } });
    expect(own.status).toBe(200);
    expect(((await own.json()) as Json).totals.threads).toBe(1);
    expect((await fetch(path, { headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
    expect((await fetch(path, { headers: { "Sec-Fetch-Site": "none" } })).status).toBe(200);
    expect((await fetch(path)).status).toBe(200);
    expect(w.server.search.lastBuildStats()).toBe(searchedBefore);
  });

  test("many searches at once agree", async () => {
    const w = await setup();
    for (let i = 0; i < 30; i++) await w.send(`Deploy ${i}`, `The deploy number ${i} went out.`);
    await w.searchSettled("q=deploy");
    const answers = await Promise.all(Array.from({ length: 20 }, () => w.get("q=deploy&group=messages&limit=50")));
    for (const answer of answers) expect(answer.body.groups.messages.map((m: Json) => m.id)).toEqual(answers[0]!.body.groups.messages.map((m: Json) => m.id));
    expect(answers[0]!.body.groups.messages).toHaveLength(30);
  });
});

describe("recent searches", () => {
  test("written only when the window posts them: the last 6, newest first, once each; Clear; a GET writes nothing", async () => {
    const w = await setup();
    await w.send("Relay", "notes");
    const file = join(w.server.store.dir, INBOX_RECENT_SEARCHES_FILE);
    await w.searchSettled("q=relay");
    expect(existsSync(file)).toBe(false);
    for (const q of ["one", "two", "three", "four", "five", "six", "seven", "TWO"]) {
      const response = await w.post({ q, serverSession: w.server.serverSession });
      expect(response.status).toBe(200);
    }
    const empty = await w.get("q=");
    expect(empty.body.recent_searches).toEqual(["TWO", "seven", "six", "five", "four", "three"]);
    expect(empty.body.groups).toBeNull();
    expect(Array.isArray(empty.body.recent)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).searches).toHaveLength(6);
    const cleared = await w.post({ clear: true, serverSession: w.server.serverSession });
    expect(((await cleared.json()) as Json).recent_searches).toEqual([]);
    expect((await w.get("q=")).body.recent_searches).toEqual([]);
  });

  test("the same-origin and serverSession guards; a body with nothing to save is refused", async () => {
    const w = await setup();
    expect((await w.post({ q: "x" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await w.post({ q: "x", serverSession: "another" })).status).toBe(409);
    expect((await w.post({ serverSession: w.server.serverSession })).status).toBe(422);
    expect((await fetch(`${w.base}/api/inbox/search/recent`)).status).toBe(405);
    expect((await w.get("q=")).body.recent_searches).toEqual([]);
  });
});
