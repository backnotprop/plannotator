/**
 * Run and Secret wired into a running Inbox: an agent sends a `:::run` and a `:::secret` over MCP, the person's
 * window saves the secret and presses Run, and the result comes back to the agent. What regresses: the routes not
 * reached, an agent's bare call pressing Run or saving, the saved name missing from the run's env, a value in the
 * store's files (the debug log turned on included), a read, the agent's wake text, MCP search, stderr or what the
 * agent reads, the result not reaching the thread, and an Inbox that quits mid-run leaving the agent no word. A
 * sandboxed Inbox (its own data dir, a file vault inside it, no login shell, no keychain); the command uses shell
 * builtins only.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";
import { flushInboxDebugLogs } from "./inbox-debug-log";

const SENTINEL = "TEST_ONLY_NOT_A_KEY_123";
const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
let sandbox: string | undefined;
const restores: (() => void)[] = [];

beforeEach(() => {
  // A sandboxed Inbox: the file vault in its own data dir and no login shell, never the person's keychain.
  sandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (sandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = sandbox;
});

type Json = Record<string, any>;
const BODY = [":::secret", "API_TOKEN", "The check needs it.", ":::", "", ":::run", "Say hello", "", "```sh", 'echo "hi $API_TOKEN"; exit 4', "```", ":::"].join("\n");
const AGENT = { agent_session: "ses_run", agent_host: "claude-code", agent_name: "Claude Code" };

const filesUnder = (dir: string, skip: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !join(entry.parentPath, entry.name).startsWith(skip))
    .map((entry) => join(entry.parentPath, entry.name));

test("the window saves a secret and runs the block; the agent gets the result and never the value", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-run-")));
  roots.push(root);
  const project = join(root, "site");
  mkdirSync(project);
  const dataDir = join(root, "data");
  const logged: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (logged.push(String(chunk)), true));
  restores.push(() => stderr.mockRestore());
  const server = await startInboxServer({ dataDir, binaryPath: null, debug: true });
  servers.push(server);
  const client = new Client({ name: "inbox-run-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const sent = ((await client.callTool({ name: "send_message", arguments: { ...AGENT, project_path: project, body: BODY } })) as { structuredContent: Json }).structuredContent;
  const origin = `http://127.0.0.1:${server.port}`;
  const route = (what: "run" | "secret") => `${origin}/api/inbox/messages/${sent.message_id}/${what}`;
  const windowPost = (what: "run" | "secret", body: Json) =>
    fetch(route(what), { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ ...body, serverSession: server.serverSession }) });
  const read = async () => (await (await fetch(route("run"))).json()) as Json;

  // An agent's bare call (no window): refused, nothing saved.
  const bare = await fetch(route("secret"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "API_TOKEN", value: SENTINEL }) });
  expect(bare.status).toBe(403);
  expect((await read()).secrets).toEqual([]);

  const key = Object.keys((await read()).blocks)[0]!;
  expect((await read()).blocks[key].needs).toEqual(["API_TOKEN"]);
  expect((await windowPost("secret", { name: "API_TOKEN", value: SENTINEL })).status).toBe(200);
  expect((await read()).blocks[key].needs).toEqual([]);

  const bareRun = await fetch(route("run"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, op: "start", command: 'echo "hi $API_TOKEN"; exit 4' }) });
  expect(bareRun.status).toBe(403);
  expect((await windowPost("run", { key, op: "start", command: 'echo "hi $API_TOKEN"; exit 4' })).status).toBe(200);
  let state: Json = {};
  for (let i = 0; i < 200; i++) {
    state = await read();
    if (state.runs[key] && state.runs[key].state !== "starting" && state.runs[key].state !== "running") break;
    await Bun.sleep(25);
  }
  expect(state.runs[key]).toMatchObject({ state: "failed", exit_code: 4, lines: ["hi ••••"] });

  // The result is in the thread as the person's reply; what the agent reads has the name, never the value.
  const thread = ((await client.callTool({ name: "read_thread", arguments: { thread_id: sent.thread_id } })) as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
  expect(thread).toContain("Command you asked the person to run");
  expect(thread).toContain("exited with code 4");
  expect(thread).toContain("Saved API_TOKEN");
  expect(thread).not.toContain(SENTINEL);
  expect(JSON.stringify(state)).not.toContain(SENTINEL);
  // What wakes the agent, and what it can search, never carry the value.
  const wake = await (await fetch(`${origin}${INBOX_BRIDGE_POLL_PATH}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify({ session: AGENT.agent_session, waitMs: 0 }) })).text();
  expect(wake).not.toContain(SENTINEL);
  for (const query of [SENTINEL, "API_TOKEN", "hi"]) {
    const found = JSON.stringify(await client.callTool({ name: "search", arguments: { ...AGENT, query, all_projects: true } }));
    expect(found).not.toContain(SENTINEL);
  }
  stderr.mockRestore();
  expect(logged.join("")).not.toContain(SENTINEL);
  // Only the sandbox's own vault file holds it: no store file, index, run record or log (the debug log is on) does.
  await flushInboxDebugLogs();
  expect(filesUnder(dataDir, "/nothing/").some((file) => file.endsWith("debug.log"))).toBe(true);
  for (const file of filesUnder(dataDir, join(dataDir, "inbox", "secrets") + "/")) expect([file, readFileSync(file, "utf8").includes(SENTINEL)]).toEqual([file, false]);
});

test("an Inbox that quits while a command runs stops it and tells the agent; the card says so after a restart", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-run-")));
  roots.push(root);
  const project = join(root, "site");
  mkdirSync(project);
  const dataDir = join(root, "data");
  // A builtin that waits (the sandbox's PATH holds only agent stubs): stdin is a pipe held open, so `read` never returns.
  const body = [":::run", "Wait a while", "", "```sh", "echo started; read -r line", "```", ":::"].join("\n");
  const first = await startInboxServer({ dataDir, binaryPath: null });
  servers.push(first);
  const client = new Client({ name: "inbox-run-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${first.port}/mcp`)));
  const sent = ((await client.callTool({ name: "send_message", arguments: { ...AGENT, project_path: project, body } })) as { structuredContent: Json }).structuredContent;
  await client.close();
  const origin = `http://127.0.0.1:${first.port}`;
  const route = `${origin}/api/inbox/messages/${sent.message_id}/run`;
  const key = Object.keys(((await (await fetch(route)).json()) as Json).blocks)[0]!;
  const press = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ key, op: "start", command: "echo started; read -r line", serverSession: first.serverSession }) });
  expect(press.status).toBe(200);
  let lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    lines = ((await (await fetch(route)).json()) as Json).runs[key]?.lines ?? [];
    if (lines.length) break;
    await Bun.sleep(25);
  }
  // It ran (not a run still starting, which would also read as "closed").
  expect(lines).toEqual(["started"]);
  servers.splice(servers.indexOf(first), 1);
  first.stop();
  const again = await startInboxServer({ dataDir, binaryPath: null });
  servers.push(again);
  const after = (await (await fetch(`http://127.0.0.1:${again.port}/api/inbox/messages/${sent.message_id}/run`)).json()) as Json;
  expect(after.runs[key]).toMatchObject({ state: "stopped", interrupted: "closed", lines: ["started"] });
  const notes = JSON.stringify(await (await fetch(`http://127.0.0.1:${again.port}/api/inbox/threads/${sent.thread_id}`)).json());
  expect(notes).toContain("The Inbox closed while it ran");
});

test("a phone saves a secret and runs a block: its value is in no file but the vault (device-commands.jsonl, the outbox, every other)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-run-")));
  roots.push(root);
  const project = join(root, "site");
  mkdirSync(project);
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: true });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const client = new Client({ name: "inbox-run-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  clients.push(client);
  const sent = ((await client.callTool({ name: "send_message", arguments: { ...AGENT, project_path: project, body: BODY } })) as { structuredContent: Json }).structuredContent;
  const made = (await (await fetch(`${base}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
  const paired = (await (await fetch(`${base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) })).json()) as Json;
  let n = 0;
  const door = (what: "run" | "secret", body: Json) =>
    fetch(`${base}/api/inbox/device/messages/${sent.message_id}/${what}`, { method: "POST", headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...body, idempotency_key: `k-${++n}` }) });
  expect((await door("secret", { name: "API_TOKEN", value: SENTINEL })).status).toBe(200);
  const key = Object.keys(((await (await fetch(`${base}/api/inbox/messages/${sent.message_id}/run`)).json()) as Json).blocks)[0]!;
  expect((await door("run", { key, op: "start", command: 'echo "hi $API_TOKEN"; exit 4' })).status).toBe(200);
  for (let i = 0; i < 200; i++) {
    const run = ((await (await fetch(`${base}/api/inbox/messages/${sent.message_id}/run`)).json()) as Json).runs[key];
    if (run && run.state !== "starting" && run.state !== "running") break;
    await Bun.sleep(25);
  }
  const files = filesUnder(dataDir, join(dataDir, "inbox", "secrets") + "/");
  expect(files.some((file) => file.endsWith("device-commands.jsonl"))).toBe(true);
  for (const file of files) expect([file, readFileSync(file, "utf8").includes(SENTINEL)]).toEqual([file, false]);
});
