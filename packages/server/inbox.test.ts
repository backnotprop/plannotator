/**
 * The Plannotator Inbox server, proved through its real doors: a running
 * server on loopback, real `fetch` / raw TCP requests, and the official MCP
 * SDK client over streamable HTTP. Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { questionKey, type QuestionAnswer } from "@plannotator/core/question-block";
import type { InboxQuestion } from "@plannotator/core/inbox-types";
import { inboxStatus, readInboxRegistry } from "@plannotator/shared/inbox/registry";
import { INBOX_SERVER_SESSION_MISMATCH_ERROR } from "@plannotator/core/server-session";
import { INBOX_MCP_INSTRUCTIONS, INBOX_MCP_TOOLS } from "./inbox-mcp";
import { INBOX_FORBIDDEN_PORT, startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-server-")));
  roots.push(root);
  return root;
}

/** A temp git repository to stand for the agent's project. */
function gitProject(root: string, name = "api"): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return dir;
}

async function start(dataDir: string, options: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, ...options });
  servers.push(server);
  return server;
}

async function mcpClient(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

/** A raw HTTP/1.1 request, so the Host and Origin headers are exactly what the test sends. */
function raw(port: number, lines: string[], body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0), text: data }));
    const headers = [...lines, `Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", ""].join("\r\n");
    socket.write(headers + body);
  });
}

async function post(server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const QUESTION_MESSAGE = [
  "The retry worker needs a call before it ships.",
  "",
  ":::question",
  "Which way should the worker go on a Stripe 409?",
  "",
  "Stopped: the retry worker cannot ship without this.",
  "Holds up: the retry worker; the 409 branch",
  "",
  "- [ ] Retry with the same idempotency key — the worker already sends one",
  "- [ ] Fail the job and alert",
  "",
  "Recommended: Retry with the same idempotency key",
  ":::",
  "",
  ":::question-text",
  "Anything else the worker should log?",
  ":::",
].join("\n");

function structured<T = Record<string, unknown>>(result: unknown): T {
  const value = (result as { structuredContent?: unknown }).structuredContent;
  if (!value) throw new Error(`no structuredContent: ${JSON.stringify(result)}`);
  return value as T;
}

function answerFor(q: InboxQuestion, selected: string[], extra: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected, ...extra };
}

describe("startup, registry and health", () => {
  test("binds 127.0.0.1 only, ignoring PLANNOTATOR_REMOTE and PLANNOTATOR_PORT, and writes an owner-only registry", async () => {
    const dataDir = join(tempRoot(), "data");
    const saved = { remote: process.env.PLANNOTATOR_REMOTE, port: process.env.PLANNOTATOR_PORT };
    let server: InboxServer;
    try {
      process.env.PLANNOTATOR_REMOTE = "1";
      process.env.PLANNOTATOR_PORT = String(INBOX_FORBIDDEN_PORT);
      server = await start(dataDir);
    } finally {
      if (saved.remote === undefined) delete process.env.PLANNOTATOR_REMOTE;
      else process.env.PLANNOTATOR_REMOTE = saved.remote;
      if (saved.port === undefined) delete process.env.PLANNOTATOR_PORT;
      else process.env.PLANNOTATOR_PORT = saved.port;
    }
    expect(server.port).not.toBe(INBOX_FORBIDDEN_PORT);

    const registryPath = join(dataDir, "inbox", "inbox.json");
    expect(statSync(registryPath).mode & 0o777).toBe(0o600);
    const entry = readInboxRegistry(dataDir)!;
    expect(entry).toMatchObject({ v: 1, pid: process.pid, port: server.port, url: `http://localhost:${server.port}/`, serverSession: server.serverSession, token: server.token });

    const health = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).json();
    expect(health).toMatchObject({ ok: true, app: "plannotator-inbox", serverSession: server.serverSession, pid: process.pid, update: null });
    expect((await inboxStatus(dataDir)).state).toBe("running");

    // Remote mode would have bound 0.0.0.0: no non-loopback address reaches it.
    const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (external) {
      const reached = await new Promise<boolean>((resolve) => {
        const socket = connect(server.port, external.address);
        socket.on("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.on("error", () => resolve(false));
      });
      expect(reached).toBe(false);
    }
  });

  test("a restart takes the last port, rotates the token and the serverSession; a stale tab gets 409", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const project = gitProject(root);
    const first = await start(dataDir);
    const client = await mcpClient(first);
    const sent = structured<{ message_id: string }>(
      await client.callTool({ name: "send_message", arguments: { body: QUESTION_MESSAGE, project_path: project } }),
    );
    const { thread } = await (await fetch(`http://127.0.0.1:${first.port}/api/inbox/threads/${sent.message_id}`)).json();
    const question = thread.messages[0].questions[0] as InboxQuestion;
    const firstSession = first.serverSession;
    first.stop();
    servers.splice(servers.indexOf(first), 1);
    expect((await inboxStatus(dataDir)).state).toBe("stopped");

    const second = await start(dataDir);
    expect(second.port).toBe(first.port);
    expect(second.portChanged).toBe(false);
    expect(second.token).not.toBe(first.token);
    expect(second.serverSession).not.toBe(firstSession);
    expect(readInboxRegistry(dataDir)!.token).toBe(second.token);

    // The store came back: the thread is there under the new process.
    expect((await fetch(`http://127.0.0.1:${second.port}/api/inbox/threads/${sent.message_id}`)).status).toBe(200);

    // A tab still holding the first nonce cannot pick on the new Inbox.
    const stale = await post(second, `/api/inbox/messages/${sent.message_id}/picks`, {
      serverSession: firstSession,
      questions: [{ key: question.key, revision: 0, answer: answerFor(question, ["Fail the job and alert"]) }],
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("session_mismatch");
    const unchanged = await (await fetch(`http://127.0.0.1:${second.port}/api/inbox/threads/${sent.message_id}`)).json();
    expect(unchanged.thread.messages[0].questions[0].revision).toBe(0);

    // The window shows the refusal's `error` as it is: every route family says
    // Inbox, never the review wording plan, annotate and code review keep.
    const routes = [
      `/api/inbox/threads/${sent.thread_id}/seen`, // inbox.ts
      `/api/inbox/messages/${sent.message_id}/guide/reviewed`, // inbox-guides.ts
      `/api/inbox/threads/${sent.thread_id}/message`, // inbox-sessions.ts
      "/api/inbox/annotations", // inbox-attachments.ts
      "/api/inbox/settings",
    ];
    for (const route of routes) {
      const refused = await post(second, route, { serverSession: firstSession });
      expect(refused.status).toBe(409);
      const body = await refused.json();
      expect(body.code).toBe("session_mismatch");
      expect(body.error).toBe(INBOX_SERVER_SESSION_MISMATCH_ERROR);
      expect(body.error).not.toContain("review");
    }
  });

  test("when the last port is taken by something else, it falls back to a random port and says so once", async () => {
    const dataDir = join(tempRoot(), "data");
    const first = await start(dataDir);
    const port = first.port;
    first.stop();
    servers.splice(servers.indexOf(first), 1);
    const squatter = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("not the inbox") });
    try {
      const second = await start(dataDir);
      expect(second.port).not.toBe(port);
      expect(second.portChanged).toBe(true);
      const list = await (await fetch(`http://127.0.0.1:${second.port}/api/inbox/threads`)).json();
      expect(typeof list.notice).toBe("string");
    } finally {
      squatter.stop(true);
    }
  });

  test("restart to update: the health tick compares the binary on disk with the running version", async () => {
    const root = tempRoot();
    const binary = join(root, "plannotator");
    const runs = join(root, "runs");
    writeFileSync(binary, `#!/bin/sh\necho run >> '${runs}'\necho 'plannotator 1.0.0'\n`);
    chmodSync(binary, 0o755);
    const server = await start(join(root, "data"), { version: "1.0.0", binaryPath: binary, healthTickMs: 50 });
    const health = () => fetch(`http://127.0.0.1:${server.port}/api/inbox/health`).then((r) => r.json());
    await Bun.sleep(300);
    expect((await health()).update).toBeNull();
    // Several ticks went by: an unchanged binary was run once, not every tick.
    expect(readFileSync(runs, "utf8").trim().split("\n")).toHaveLength(1);

    // install.sh renames a new binary over the running one.
    const next = join(root, "plannotator.new");
    writeFileSync(next, "#!/bin/sh\necho 'plannotator 1.1.0'\n");
    chmodSync(next, 0o755);
    renameSync(next, binary);
    const deadline = Date.now() + 5000;
    let update = null;
    while (Date.now() < deadline && !update) {
      update = (await health()).update;
      await Bun.sleep(50);
    }
    expect(update).toEqual({ available: true, version: "1.1.0" });
  });
});

describe("security refusals, by real requests", () => {
  test("a foreign Host is refused on every route; loopback names pass", async () => {
    const server = await start(join(tempRoot(), "data"));
    for (const path of ["/", "/api/inbox/health", "/api/inbox/projects", "/api/inbox/events", "/mcp"]) {
      const refused = await raw(server.port, [`GET ${path} HTTP/1.1`, "Host: evil.example"]);
      expect(refused.status).toBe(403);
      expect(refused.text).toContain("host_not_allowed");
    }
    const mcpRefused = await raw(
      server.port,
      ["POST /mcp HTTP/1.1", `Host: rebind.attacker.test:${server.port}`, "Content-Type: application/json", "Accept: application/json, text/event-stream"],
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    expect(mcpRefused.status).toBe(403);
    for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`, `[::1]:${server.port}`]) {
      expect((await raw(server.port, ["GET /api/inbox/health HTTP/1.1", `Host: ${host}`])).status).toBe(200);
    }
  });

  test("/mcp refuses any request that carries an Origin, its own included", async () => {
    const server = await start(join(tempRoot(), "data"));
    for (const origin of ["https://evil.example", `http://localhost:${server.port}`, "null"]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Origin: origin },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe("origin_not_allowed");
    }
  });

  test("cross-site POSTs are refused before anything is written; same-origin and no-Origin pass", async () => {
    const root = tempRoot();
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    const sent = structured<{ message_id: string }>(
      await client.callTool({ name: "send_message", arguments: { body: "Plain note", project_path: gitProject(root) } }),
    );
    const path = `/api/inbox/messages/${sent.message_id}/resolve`;
    for (const [headers, status] of [
      [{ Origin: "https://evil.example" }, 403],
      [{ Origin: "null" }, 403],
      [{ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, 403],
    ] as const) {
      const response = await post(server, path, { resolved: true }, headers);
      expect(response.status).toBe(status);
      expect((await response.json()).code).toBe("cross_origin");
    }
    const thread = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.message_id}`)).json();
    expect(thread.thread.resolved_at).toBeNull();
    expect((await post(server, path, { resolved: true }, { Origin: `http://127.0.0.1:${server.port}` })).status).toBe(200);
    expect((await post(server, path, { resolved: false })).status).toBe(200);
  });

  test("the connection route takes the registry token, a loopback Host naming this port, and no Origin", async () => {
    const dataDir = join(tempRoot(), "data");
    let stopped = false;
    const server = await start(dataDir, { onStopRequested: () => (stopped = true) });
    const stop = (headers: string[]) => raw(server.port, ["POST /api/inbox/control/stop HTTP/1.1", ...headers]);
    expect((await stop([`Host: 127.0.0.1:${server.port}`])).status).toBe(401);
    expect((await stop([`Host: 127.0.0.1:${server.port}`, "Authorization: Bearer wrong"])).status).toBe(401);
    expect((await stop([`Host: 127.0.0.1:${server.port + 1}`, `Authorization: Bearer ${server.token}`])).status).toBe(403);
    expect((await stop([`Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${server.token}`, `Origin: http://127.0.0.1:${server.port}`])).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).status).toBe(200);

    const ok = await stop([`Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${readInboxRegistry(dataDir)!.token}`]);
    expect(ok.status).toBe(200);
    await Bun.sleep(300);
    expect(stopped).toBe(true);
    expect((await inboxStatus(dataDir)).state).toBe("stopped");
  });

  test("the window ships its CSP (no framing, no other origin) and no CORS anywhere", async () => {
    const server = await start(join(tempRoot(), "data"), { htmlContent: "<!doctype html><div data-window-sentinel></div>" });
    const page = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { Origin: "https://evil.example" } });
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(page.headers.get("access-control-allow-origin")).toBeNull();
    // A sentinel string: the embedded window is what `/` serves.
    expect(await page.text()).toContain("data-window-sentinel");
    const api = await fetch(`http://127.0.0.1:${server.port}/api/inbox/projects`, { headers: { Origin: "https://evil.example" } });
    expect(api.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("an HTTP/1.0 request with no Host (allowed by the guard) is answered, not a 500", async () => {
    const server = await start(join(tempRoot(), "data"));
    const health = await raw(server.port, ["GET /api/inbox/health HTTP/1.0"]);
    expect(health.status).toBe(200);
    expect(health.text).toContain("plannotator-inbox");
    expect((await raw(server.port, ["GET /nowhere HTTP/1.0"])).status).toBe(404);
  });
});

describe("questions end to end: MCP send, window picks and Send, agent reads", () => {
  test("send_message with question blocks, pick, Send, wait_for_reply returns the answer", async () => {
    const root = tempRoot();
    const project = gitProject(root);
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);

    expect(client.getInstructions()).toBe(INBOX_MCP_INSTRUCTIONS);
    expect(INBOX_MCP_INSTRUCTIONS.length).toBeLessThan(2048);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...INBOX_MCP_TOOLS].sort());
    // Claude Code hands a model an MCP description up to its first 2,048
    // characters ("… [truncated]" after). The question guide is longer than
    // that by itself, so what must survive the cut is pinned: the syntax and
    // the rules on what to ask, through "Ask only what you cannot decide alone".
    const sendDescription = tools.tools.find((t) => t.name === "send_message")!.description!;
    const reachesModel = sendDescription.slice(0, 2048 - "… [truncated]".length);
    expect(reachesModel).toContain(":::question-text");
    expect(reachesModel).toContain("Do not ask rhetorical questions or questions the codebase answers.");
    // The guided-review tools reach the model whole, their worked example pointer included.
    for (const name of ["get_guide_brief", "submit_guide"]) {
      expect(tools.tools.find((t) => t.name === name)!.description!.length).toBeLessThan(2048);
    }

    const sendResult = await client.callTool({
      name: "send_message",
      arguments: { body: QUESTION_MESSAGE, project_path: join(project, "src"), idempotency_key: "k-1", agent_session: "ses_test", agent_name: "Claude Code" },
    });
    const sent = structured<{ message_id: string; thread_id: string; project: { root: string; name: string }; questions: { key: string }[] }>(sendResult);
    // The project is the repository, not the subfolder the agent stood in.
    expect(sent.project.root).toBe(project);
    expect(sent.project.name).toBe("api");
    expect(sent.questions.map((q) => q.key)).toEqual([
      questionKey("single", "Which way should the worker go on a Stripe 409?"),
      questionKey("text", "Anything else the worker should log?"),
    ]);

    // Idempotent on the key: the same send answers the same message.
    const again = structured<{ message_id: string; replayed: boolean }>(
      await client.callTool({ name: "send_message", arguments: { body: QUESTION_MESSAGE, project_path: project, idempotency_key: "k-1" } }),
    );
    expect(again).toMatchObject({ message_id: sent.message_id, replayed: true });

    // The window's list model shows one row, a thread, stopped on the person.
    const list = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads`)).json();
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]).toMatchObject({ name: "api", threads: 1, unread: 1 });
    const rows = list.sections.flatMap((s: { threads: unknown[] }) => s.threads);
    expect(rows).toHaveLength(1);
    expect(list.sections.find((s: { id: string }) => s.id === "stopped").threads[0]).toMatchObject({
      section: "stopped",
      project: { name: "api" },
      waiting_on_person: true,
      questions: { open: 2, picked: 0, stopped: true, holds_up: ["the retry worker", "the 409 branch"], prompt: "Which way should the worker go on a Stripe 409?" },
    });

    const threadBody = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}`)).json();
    const [single, text] = threadBody.thread.messages[0].questions as InboxQuestion[];
    expect(single).toMatchObject({ state: "open", revision: 0, recommendation: "Retry with the same idempotency key", stopped: "the retry worker cannot ship without this.", asked_by_agent_id: "ses_test" });

    // A pick is saved at once; the agent can read it but it is not sent.
    const pick = await post(server, `/api/inbox/messages/${sent.message_id}/picks`, {
      serverSession: list.serverSession,
      questions: [{ key: single.key, revision: 0, answer: answerFor(single, ["Retry with the same idempotency key"]) }],
    });
    expect(pick.status).toBe(200);
    const picked = (await pick.json()).questions as InboxQuestion[];
    expect(picked[0]).toMatchObject({ state: "picked", revision: 1, picked_by: { id: "person", name: null } });

    // A stale revision is refused and changes nothing.
    const conflict = await post(server, `/api/inbox/messages/${sent.message_id}/picks`, {
      questions: [{ key: single.key, revision: 0, answer: answerFor(single, ["Fail the job and alert"]) }],
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("question_revision_conflict");
    // A label that is not a choice is refused.
    const badLabel = await post(server, `/api/inbox/messages/${sent.message_id}/picks`, {
      questions: [{ key: single.key, revision: 1, answer: answerFor(single, ["Nope"]) }],
    });
    expect(badLabel.status).toBe(422);

    // The agent waits while the person writes their Send.
    const waiting = client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.thread_id, timeout_seconds: 20 } });
    await Bun.sleep(200);
    const sendBody = {
      idempotency_key: "send-1",
      words: "Go ahead.",
      questions: [
        { key: single.key, revision: 1 },
        { key: text.key, revision: 0, answer: answerFor(text, [], { text: "Log the Stripe request id." }) },
      ],
    };
    const send = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, sendBody);
    expect(send.status).toBe(200);
    const sendJson = await send.json();
    expect(sendJson.replayed).toBe(false);
    expect(sendJson.questions.map((q: InboxQuestion) => q.state)).toEqual(["sent", "sent"]);
    expect(sendJson.reply.body).toContain("## Answers to your questions");
    expect(sendJson.reply.body).toContain("Answer: Retry with the same idempotency key (your recommendation)");

    const reply = structured<{ status: string; reply: { body: string; message_id: string }; questions: InboxQuestion[] }>(await waiting);
    expect(reply.status).toBe("replied");
    expect(reply.reply.message_id).toBe(sendJson.reply.id);
    expect(reply.reply.body).toContain("Go ahead.");
    expect(reply.reply.body).toContain("> Log the Stripe request id.");
    expect(reply.questions.every((q) => q.state === "sent" && q.sent_reply_id === sendJson.reply.id)).toBe(true);

    // Send is idempotent on its key: a retry writes nothing new.
    const retry = await (await post(server, `/api/inbox/messages/${sent.message_id}/reply`, sendBody)).json();
    expect(retry).toMatchObject({ replayed: true, reply: { id: sendJson.reply.id } });
    const after = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}`)).json();
    expect(after.thread.messages).toHaveLength(2);

    // read_thread, from the agent's side; then the agent resolves the thread.
    const read = structured<{ thread: { messages: { author: { kind: string } }[] } }>(
      await client.callTool({ name: "read_thread", arguments: { thread_id: sent.thread_id } }),
    );
    expect(read.thread.messages.map((m) => m.author.kind)).toEqual(["agent", "person"]);
    const mine = structured<{ threads: { thread_id: string }[] }>(
      await client.callTool({ name: "read_thread", arguments: { project_path: project, agent_session: "ses_test" } }),
    );
    expect(mine.threads.map((t) => t.thread_id)).toEqual([sent.thread_id]);
    const others = structured<{ threads: unknown[] }>(
      await client.callTool({ name: "read_thread", arguments: { project_path: project, agent_session: "ses_other" } }),
    );
    expect(others.threads).toHaveLength(0);

    const resolved = structured<{ thread: { resolved_at: string | null } }>(
      await client.callTool({ name: "resolve_message", arguments: { message_id: sendJson.reply.id } }),
    );
    expect(resolved.thread.resolved_at).not.toBeNull();
    const closed = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${sent.thread_id}`)).json();
    expect(closed.thread.messages[0].questions.map((q: InboxQuestion) => q.state)).toEqual(["closed", "closed"]);
    const late = await post(server, `/api/inbox/messages/${sent.message_id}/reply`, { idempotency_key: "late", words: "one more" });
    expect(late.status).toBe(409);
    expect((await late.json()).code).toBe("thread_resolved");
  });

  test("wait_for_reply on a thread already resolved answers at once instead of holding the call", async () => {
    const root = tempRoot();
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    const sent = structured<{ thread_id: string }>(
      await client.callTool({ name: "send_message", arguments: { body: "Never mind", project_path: gitProject(root) } }),
    );
    await client.callTool({ name: "resolve_message", arguments: { message_id: sent.thread_id } });
    const started = Date.now();
    const result = structured<{ status: string }>(await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.thread_id } }));
    expect(result.status).toBe("resolved");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a refusal reads as isError with <snake_code>: <message>", async () => {
    const server = await start(join(tempRoot(), "data"));
    const client = await mcpClient(server);
    const result = await client.callTool({ name: "send_message", arguments: { body: "hi", project_path: "relative/path" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^validation_error: project_path/);
    const missing = await client.callTool({ name: "read_thread", arguments: { thread_id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" } });
    expect((missing.content as { text: string }[])[0]!.text).toMatch(/^thread_not_found: /);
  });

  test("the event stream replays from a cursor, then streams live", async () => {
    const root = tempRoot();
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    const project = gitProject(root);
    await client.callTool({ name: "send_message", arguments: { body: "first", project_path: project } });
    const cursor = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/projects`)).json()).cursor as number;
    await client.callTool({ name: "send_message", arguments: { body: "second", project_path: project } });

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=${cursor}`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const seen: { seq: number; kind: string; message?: { body: string } }[] = [];
    const collect = async (until: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!until() && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = text.indexOf("\n\n")) !== -1) {
          const block = text.slice(0, split);
          text = text.slice(split + 2);
          if (!block.includes("event: record")) continue;
          seen.push(JSON.parse(block.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
        }
      }
    };
    await collect(() => seen.some((e) => e.message?.body === "second"));
    expect(seen.every((e) => e.seq > cursor)).toBe(true);
    expect(seen.some((e) => e.message?.body === "first")).toBe(false);

    await client.callTool({ name: "send_message", arguments: { body: "third", project_path: project } });
    await collect(() => seen.some((e) => e.message?.body === "third"));
    expect(seen.map((e) => e.message?.body).filter(Boolean)).toEqual(["second", "third"]);
    const seqs = seen.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    controller.abort();
  });

  test("wait_for_reply with nothing arriving returns { status: waiting, cursor } within 45-55 s", async () => {
    const root = tempRoot();
    const server = await start(join(root, "data"));
    const client = await mcpClient(server);
    const sent = structured<{ thread_id: string }>(
      await client.callTool({ name: "send_message", arguments: { body: "Anyone there?", project_path: gitProject(root) } }),
    );
    const started = Date.now();
    const result = structured<{ status: string; cursor: number }>(
      await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.thread_id } }, { timeout: 70_000 }),
    );
    const elapsed = Date.now() - started;
    expect(result.status).toBe("waiting");
    expect(typeof result.cursor).toBe("number");
    expect(elapsed).toBeGreaterThanOrEqual(45_000);
    expect(elapsed).toBeLessThan(55_000);
  }, 70_000);
});

describe("the window's routes: settings, restart, favicon", () => {
  test("settings answer the stdio entry with this CLI's path, the port, the knob and the store on disk", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    const previousEnv = process.env.PLANNOTATOR_INBOX_TOOL;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    delete process.env.PLANNOTATOR_INBOX_TOOL;
    try {
      const server = await start(dataDir, { selfCommand: ["/opt/tools dir/plannotator"] });
      const client = await mcpClient(server);
      const sent = structured<{ thread_id: string }>(
        await client.callTool({ name: "send_message", arguments: { body: QUESTION_MESSAGE, project_path: gitProject(root) } }),
      );
      const settings = await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json();
      expect(settings.mcp_command).toEqual(["/opt/tools dir/plannotator", "inbox", "mcp"]);
      expect(settings.mcp_url).toBe(`http://127.0.0.1:${server.port}/mcp`);
      expect(settings.port).toBe(server.port);
      // Nothing set: the defaults, on for the Claude Code mod, off on Pi and OpenCode.
      expect(settings.inbox_tool).toEqual({ hosts: { "claude-code": true, pi: false, opencode: false }, env: null });
      const project = settings.store.projects[0];
      expect(project.name).toBe("api");
      expect(project.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([sent.thread_id]);
      // Sizes are read from the files themselves.
      const folder = join(dataDir, "inbox", "projects", readdirSync(join(dataDir, "inbox", "projects"))[0]!);
      const onDisk = ["project.json", "messages.jsonl", "questions.jsonl"].reduce((n, f) => n + statSync(join(folder, f)).size, 0);
      expect(project.bytes).toBe(onDisk);
      expect(settings.store.bytes).toBe(onDisk);
      expect(project.threads[0].bytes).toBe(onDisk - statSync(join(folder, "project.json")).size);
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
      if (previousEnv !== undefined) process.env.PLANNOTATOR_INBOX_TOOL = previousEnv;
    }
  });

  test("the knob saves per host into config.json, behind the same-origin and serverSession guards", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    try {
      const server = await start(dataDir);
      const cross = await post(server, "/api/inbox/settings", { inbox_tool: { pi: true } }, { Origin: "https://evil.example" });
      expect(cross.status).toBe(403);
      expect((await cross.json()).code).toBe("cross_origin");
      const stale = await post(server, "/api/inbox/settings", { serverSession: "not-this-one", inbox_tool: { pi: true } });
      expect(stale.status).toBe(409);
      const bad = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, inbox_tool: { cursor: true } });
      expect(bad.status).toBe(422);
      expect(existsSync(join(dataDir, "config.json"))).toBe(false);

      const saved = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, inbox_tool: { pi: true } });
      expect(saved.status).toBe(200);
      expect((await saved.json()).inbox_tool.hosts).toEqual({ "claude-code": true, pi: true, opencode: false });
      await post(server, "/api/inbox/settings", { serverSession: server.serverSession, inbox_tool: { "claude-code": false } });
      // Each host keeps its own choice; an unset host keeps its default.
      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxTool).toEqual({ pi: true, "claude-code": false });
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
    }
  });

  test("notifications save into config.json (so they survive a port change), field by field, refusing what is not a setting", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    try {
      const server = await start(dataDir);
      const read = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()).notifications;
      // Nothing set: on, never asked.
      expect(await read()).toEqual({ enabled: true, dismissed: false, allowed_origin: null });
      for (const bad of [{ sections: ["stopped"] }, { enabled: "yes" }, { allowed_origin: "http://localhost:1/path" }, { volume: 3 }]) {
        const refused = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, notifications: bad });
        expect(refused.status).toBe(422);
      }
      expect(existsSync(join(dataDir, "config.json"))).toBe(false);
      const origin = `http://localhost:${server.port}`;
      const saved = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, notifications: { dismissed: true } });
      expect((await saved.json()).notifications.dismissed).toBe(true);
      await post(server, "/api/inbox/settings", { serverSession: server.serverSession, notifications: { enabled: false, allowed_origin: origin } });
      expect(await read()).toEqual({ enabled: false, dismissed: true, allowed_origin: origin });
      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxNotifications).toEqual({
        dismissed: true,
        enabled: false,
        allowedOrigin: origin,
      });
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
    }
  });

  test("the two writing routes refuse a foreign Host before anything is written or stopped", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    try {
      let handedOver = false;
      const server = await start(dataDir, { onRestartRequested: () => (handedOver = true) });
      for (const [path, body] of [
        ["/api/inbox/settings", { serverSession: server.serverSession, inbox_tool: { pi: true } }],
        ["/api/inbox/restart", { serverSession: server.serverSession }],
      ] as const) {
        // A DNS-rebinding page: its own name for this port, a matching Origin, the right serverSession.
        const refused = await raw(
          server.port,
          [`POST ${path} HTTP/1.1`, `Host: rebind.attacker.test:${server.port}`, `Origin: http://rebind.attacker.test:${server.port}`, "Content-Type: application/json"],
          JSON.stringify(body),
        );
        expect(refused.status).toBe(403);
        expect(refused.text).toContain("host_not_allowed");
      }
      await Bun.sleep(200);
      expect(existsSync(join(dataDir, "config.json"))).toBe(false);
      expect(handedOver).toBe(false);
      expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
    }
  });

  test("Restart stops this server and hands over to the caller; refused cross-site and when no caller can restart", async () => {
    const root = tempRoot();
    const plain = await start(join(root, "plain"));
    const unavailable = await post(plain, "/api/inbox/restart", { serverSession: plain.serverSession });
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json()).code).toBe("restart_unavailable");

    let handedOver = false;
    const server = await start(join(root, "data"), { onRestartRequested: () => (handedOver = true) });
    expect((await post(server, "/api/inbox/restart", { serverSession: server.serverSession }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(server, "/api/inbox/restart", { serverSession: "stale" })).status).toBe(409);
    expect(handedOver).toBe(false);
    const ok = await post(server, "/api/inbox/restart", { serverSession: server.serverSession });
    expect(ok.status).toBe(200);
    await Bun.sleep(300);
    expect(handedOver).toBe(true);
    // This server no longer listens, so the registry reads stopped and the caller can start the new binary.
    await expect(fetch(`http://127.0.0.1:${server.port}/api/inbox/health`)).rejects.toThrow();
  });

  test("the favicon is served for the window's link", async () => {
    const dataDir = join(tempRoot(), "data");
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    // The favicon style is read from config.json: the temp one, never the real one.
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    try {
      const server = await start(dataDir);
      const icon = await fetch(`http://127.0.0.1:${server.port}/favicon.png`);
      expect(icon.status).toBe(200);
      expect(icon.headers.get("content-type")).toMatch(/^image\//);
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
    }
  });
});
