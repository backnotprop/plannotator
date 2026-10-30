/**
 * The Plannotator Inbox server, proved through its real doors: a running
 * server on loopback, real `fetch` / raw TCP requests, and the official MCP
 * SDK client over streamable HTTP. Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { questionKey, type QuestionAnswer } from "@plannotator/core/question-block";
import type { InboxQuestion } from "@plannotator/core/inbox-types";
import { inboxStatus, readInboxRegistry } from "@plannotator/shared/inbox/registry";
import { INBOX_SERVER_SESSION_MISMATCH_ERROR } from "@plannotator/core/server-session";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { INBOX_AGENT_FIELD_DESCRIPTIONS, INBOX_REF_LINK_RULE, inboxAgentTool, parseInboxToolList } from "@plannotator/shared/inbox/connection";
import { INBOX_DEFAULT_SERVED_TOOLS, INBOX_MCP_INSTRUCTIONS, INBOX_SERVED_TOOLS, INBOX_STOP_EXAMPLE, SEND_BODY_DESCRIPTION } from "./inbox-mcp";
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
    // Wait for the first probe itself, not a fixed window: macOS assesses a
    // freshly written executable on its first exec (about 90 ms here, far
    // more when the machine is busy), so the probe can start after 300 ms.
    const started = Date.now() + 5000;
    while (Date.now() < started && !existsSync(runs)) await Bun.sleep(10);
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
    expect(update).toMatchObject({ available: true, state: "ready", version: "1.1.0" });
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

  test("the stop route refuses a stop that names another data dir (a copied record) and takes its own under another spelling", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    let stopped = false;
    const server = await start(dataDir, { onStopRequested: () => (stopped = true) });
    const token = readInboxRegistry(dataDir)!.token;
    const stop = (body: unknown) => post(server, "/api/inbox/control/stop", body, { Authorization: `Bearer ${token}` });
    // A copy of this data dir: its inbox.json names this Inbox, its own folder is another.
    const copy = join(root, "copy");
    mkdirSync(join(copy, "inbox"), { recursive: true });
    writeFileSync(join(copy, "inbox", "inbox.json"), readFileSync(join(dataDir, "inbox", "inbox.json")));
    const refused = await stop({ data_dir: copy });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("not_ours");
    await Bun.sleep(300);
    expect(stopped).toBe(false);
    expect((await inboxStatus(dataDir)).state).toBe("running");

    // The same folder through a symlink is this Inbox's: it stops.
    const link = join(root, "link");
    symlinkSync(dataDir, link);
    expect((await stop({ data_dir: link })).status).toBe(200);
    await Bun.sleep(300);
    expect(stopped).toBe(true);
  });

  test("the stop route never refuses on a folder it cannot read: a data dir that does not exist, or this one moved", async () => {
    const root = tempRoot();
    const stopVia = async (dataDir: string, named: () => string, before?: () => void) => {
      let stopped = false;
      const server = await start(dataDir, { onStopRequested: () => (stopped = true) });
      const token = readInboxRegistry(dataDir)!.token;
      before?.();
      const response = await post(server, "/api/inbox/control/stop", { data_dir: named() }, { Authorization: `Bearer ${token}` });
      await Bun.sleep(300);
      return { status: response.status, stopped };
    };
    // The caller names a folder that is not there.
    expect(await stopVia(join(root, "a"), () => join(root, "nowhere"))).toEqual({ status: 200, stopped: true });
    // The data dir was renamed under the running Inbox: its own folder is gone, the caller names the new one.
    const moved = join(root, "moved");
    expect(await stopVia(join(root, "b"), () => moved, () => renameSync(join(root, "b"), moved))).toEqual({ status: 200, stopped: true });
  });

  test("the window ships its CSP (no framing, no other origin) and no CORS anywhere", async () => {
    const server = await start(join(tempRoot(), "data"), { htmlContent: "<!doctype html><div data-window-sentinel></div>" });
    const page = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { Origin: "https://evil.example" } });
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'self'");
    // Graphviz attachments compile WebAssembly; eval stays off.
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toMatch(/'unsafe-eval'/);
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

describe("send_message's body teaches the Inbox-only Stopped / Holds up lines", () => {
  test("its example reads as a stopped question that holds up two pieces of work", () => {
    expect(SEND_BODY_DESCRIPTION).toContain(INBOX_STOP_EXAMPLE);
    const [question, ...rest] = parseInboxQuestionBlocks(INBOX_STOP_EXAMPLE);
    expect(rest).toEqual([]);
    expect(question!.prompt).toBe("Which database password should I use for staging?");
    expect(question!.stopped).toBe("can't run the migration without it");
    expect(question!.holds_up).toEqual(["staging deploy", "release notes"]);
    expect(question!.parsed.choices.map((choice) => choice.label)).toEqual(['The one in 1Password "staging-db"', "Make a new one"]);
  });

  test("it states the bare-negative rule the parser applies", () => {
    expect(SEND_BODY_DESCRIPTION).toContain("never write `Stopped: no`");
    for (const value of ["no", "none", "n/a", "-"]) {
      expect(SEND_BODY_DESCRIPTION).toContain(`\`${value}\``);
      const [question] = parseInboxQuestionBlocks(`:::question\nWhich one?\n\nStopped: ${value}\nHolds up: ${value}\n\n- [ ] A\n- [ ] B\n:::`);
      expect(question!.stopped).toBeNull();
      expect(question!.holds_up).toEqual([]);
    }
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
    // The Board is off by default: no card tool.
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...INBOX_DEFAULT_SERVED_TOOLS].sort());
    // Claude Code hands a model an MCP description up to its first 2,048
    // characters ("… [truncated]" after). The question guide is longer than
    // that by itself, so what must survive the cut is pinned: the syntax, the
    // context rules (what to give a reader who switches in cold, images and
    // linked files), the rules on what to ask, and the `- [x]` settled rule
    // whole.
    const sendDescription = tools.tools.find((t) => t.name === "send_message")!.description!;
    const reachesModel = sendDescription.slice(0, 2048 - "… [truncated]".length);
    expect(reachesModel).toContain(":::question-text");
    expect(reachesModel).toContain("does not know what you know");
    expect(reachesModel).toContain("without opening anything else");
    expect(reachesModel).toContain("no jargon");
    expect(reachesModel).toContain("`![alt](path)`");
    expect(reachesModel).toContain("`[the mock](mock.html)`");
    expect(reachesModel).toContain("Do not ask rhetorical questions or questions the codebase answers.");
    expect(reachesModel).toContain("or drop the block and state the decision in prose.");
    // The guided-review tools reach the model whole, their worked example pointer included.
    for (const name of ["get_guide_brief", "submit_guide"]) {
      expect(tools.tools.find((t) => t.name === name)!.description!.length).toBeLessThan(2048);
    }
    // The Inbox-only `Stopped:` / `Holds up:` lines ride send_message's `body`
    // field (a field description reaches the model whole).
    const bodySchema = (tools.tools.find((t) => t.name === "send_message")!.inputSchema.properties as Record<string, { description?: string }>).body!;
    expect(bodySchema.description).toBe(SEND_BODY_DESCRIPTION);
    // The `plannotator_inbox` tool words `body` shortly (Pi and OpenCode send it with every request): a
    // question block the store reads, the Inbox-only lines, and `plannotator inbox --help` for the rest.
    const agentTool = inboxAgentTool(parseInboxToolList({ tools: tools.tools }))!;
    const agentBody = (agentTool.inputSchema.properties as Record<string, { description: string }>).body!.description;
    expect(agentBody).toContain(INBOX_AGENT_FIELD_DESCRIPTIONS.send_message!.body!);
    for (const part of [":::question-multi", ":::question-text", "never add an Other choice", "`Stopped: <why>`", "never `Stopped: no`", "`Holds up: <work>`", "Recommended:"]) expect(agentBody).toContain(part);
    const [example] = parseInboxQuestionBlocks(agentBody);
    expect(example).toMatchObject({ stopped: null, holds_up: ["sync release"] });
    expect(example!.parsed.choices.map((choice) => choice.recommended)).toEqual([true, false]);
    expect(agentTool.description).toContain("plannotator inbox --help");
    expect(agentTool.description.length).toBeLessThan(2048);
    // Where a ref links (a bare #104 meant for another repo once linked into the thread's project):
    // in both `body` descriptions, which reach the model whole; the capped texts above stay as they were.
    const refRule = INBOX_REF_LINK_RULE;
    expect(bodySchema.description).toContain(refRule);
    expect(agentBody).toContain(refRule);
    expect(INBOX_MCP_INSTRUCTIONS).not.toContain(refRule);

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

  test("the theme saves into config.json `theme`, the value plan review reads, keeping the palettes", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    try {
      // A choice plan review already made: dark mode and a palette per half.
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ theme: { mode: "dark", light: "adwaita", dark: "tokyo-night" } }));
      const server = await start(dataDir);
      const read = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()).theme;
      expect(await read()).toEqual({ mode: "dark", light: "adwaita", dark: "tokyo-night" });
      for (const bad of [{ mode: "sepia" }, { light: "../x" }, { accent: "red" }, {}, "light"]) {
        const refused = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, theme: bad });
        expect(refused.status).toBe(422);
      }
      const cross = await post(server, "/api/inbox/settings", { theme: { mode: "light" } }, { Origin: "https://evil.example" });
      expect(cross.status).toBe(403);
      expect(await read()).toEqual({ mode: "dark", light: "adwaita", dark: "tokyo-night" });

      const saved = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, theme: { mode: "light" } });
      expect(saved.status).toBe(200);
      expect((await saved.json()).theme).toEqual({ mode: "light", light: "adwaita", dark: "tokyo-night" });
      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).theme).toEqual({ mode: "light", light: "adwaita", dark: "tokyo-night" });
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
    }
  });

  test("the text size saves into config.json `inboxTextSize`: 12 to 15, 14 unless chosen, anything else refused", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    try {
      mkdirSync(dataDir, { recursive: true });
      // A value no build ever wrote reads as the default, not as itself.
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTextSize: 40, theme: { mode: "dark" } }));
      const server = await start(dataDir);
      const read = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()).text_size;
      const onDisk = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { inboxTextSize?: unknown; theme?: unknown };
      expect(await read()).toBe(14);
      for (const bad of [11, 16, 13.5, "13", null, true, { size: 13 }]) {
        const refused = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, text_size: bad });
        expect(refused.status).toBe(422);
        expect((await refused.json()).code).toBe("validation_error");
      }
      // A refused part saves nothing, the valid parts beside it included.
      const mixed = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, theme: { mode: "light" }, text_size: 9 });
      expect(mixed.status).toBe(422);
      expect(onDisk().theme).toEqual({ mode: "dark" });
      const cross = await post(server, "/api/inbox/settings", { text_size: 12 }, { Origin: "https://evil.example" });
      expect(cross.status).toBe(403);
      const stale = await post(server, "/api/inbox/settings", { serverSession: "not-this-one", text_size: 12 });
      expect(stale.status).toBe(409);
      expect(onDisk().inboxTextSize).toBe(40);

      for (const size of [12, 15, 13]) {
        const saved = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, text_size: size });
        expect(saved.status).toBe(200);
        expect((await saved.json()).text_size).toBe(size);
        expect(onDisk().inboxTextSize).toBe(size);
        expect(await read()).toBe(size);
      }
      // Another setting's save keeps the size and answers it.
      const other = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, theme: { mode: "light" } });
      expect((await other.json()).text_size).toBe(13);
      expect(onDisk().inboxTextSize).toBe(13);
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous;
    }
  });

  test("the guided review's diff layout saves into config.json `diffOptions.diffStyle`, shared with code review", async () => {
    const root = tempRoot();
    const dataDir = join(root, "data");
    const previous = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    try {
      mkdirSync(dataDir, { recursive: true });
      // Code review's other diff options are already there; a style no build writes reads as never chosen.
      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ diffOptions: { diffStyle: "sideways", overflow: "wrap", fontSize: "13" } }));
      const server = await start(dataDir);
      const read = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()).diff_style;
      const onDisk = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as { diffOptions?: Record<string, unknown>; theme?: unknown };
      expect(await read()).toBeNull();
      for (const bad of ["", "Split", "both", 1, null, true, { style: "split" }]) {
        const refused = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, diff_style: bad });
        expect(refused.status).toBe(422);
        expect((await refused.json()).field).toBe("diff_style");
      }
      // A refused part saves nothing, the valid parts beside it included.
      const mixed = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, theme: { mode: "light" }, diff_style: "both" });
      expect(mixed.status).toBe(422);
      expect(onDisk().theme).toBeUndefined();
      // Another site's page and a stale tab write nothing.
      const cross = await post(server, "/api/inbox/settings", { diff_style: "unified" }, { Origin: "https://evil.example" });
      expect(cross.status).toBe(403);
      expect((await cross.json()).code).toBe("cross_origin");
      const crossSite = await post(server, "/api/inbox/settings", { diff_style: "unified" }, { "Sec-Fetch-Site": "same-site" });
      expect(crossSite.status).toBe(403);
      const stale = await post(server, "/api/inbox/settings", { serverSession: "not-this-one", diff_style: "unified" });
      expect(stale.status).toBe(409);
      expect(onDisk().diffOptions?.diffStyle).toBe("sideways");

      for (const style of ["unified", "split", "unified"]) {
        const saved = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, diff_style: style });
        expect(saved.status).toBe(200);
        expect((await saved.json()).diff_style).toBe(style);
        expect(onDisk().diffOptions).toEqual({ diffStyle: style, overflow: "wrap", fontSize: "13" });
        expect(await read()).toBe(style);
      }
      // Another setting's save keeps the layout and answers it.
      const other = await post(server, "/api/inbox/settings", { serverSession: server.serverSession, text_size: 13 });
      expect((await other.json()).diff_style).toBe("unified");
      expect(onDisk().diffOptions?.diffStyle).toBe("unified");
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
