/**
 * Run and Secret wired into a running Inbox: an agent sends a `:::run` and a `:::secret` over MCP, the person's
 * window saves the secret and presses Run, and the result comes back to the agent. What regresses: the routes not
 * reached, an agent's bare call pressing Run or saving, the saved name missing from the run's env, a value in the
 * store's files, a read or what the agent reads, and the result not reaching the thread. A sandboxed Inbox (its
 * own data dir, a file vault inside it, no login shell, no keychain); the command uses shell builtins only.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";

const SENTINEL = "TEST_ONLY_NOT_A_KEY_123";
const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
let sandbox: string | undefined;

beforeEach(() => {
  // A sandboxed Inbox: the file vault in its own data dir and no login shell, never the person's keychain.
  sandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (sandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = sandbox;
});

type Json = Record<string, any>;
const BODY = [":::secret", "API_TOKEN", "The check needs it.", ":::", "", ":::run", "Say hello", "", "```sh", 'echo "hi $API_TOKEN"; exit 4', "```", ":::"].join("\n");

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
  const server = await startInboxServer({ dataDir, binaryPath: null });
  servers.push(server);
  const client = new Client({ name: "inbox-run-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const sent = ((await client.callTool({ name: "send_message", arguments: { project_path: project, body: BODY } })) as { structuredContent: Json }).structuredContent;
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
  // Only the sandbox's own vault file holds it: no store file, index or log does.
  for (const file of filesUnder(dataDir, join(dataDir, "inbox", "secrets") + "/")) expect([file, readFileSync(file, "utf8").includes(SENTINEL)]).toEqual([file, false]);
});
