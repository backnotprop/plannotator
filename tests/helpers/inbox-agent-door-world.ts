import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxCloudAgentView } from "../../packages/core/inbox-cloud";
import type { InboxThread } from "../../packages/core/inbox-types";
import { decodeInboxAgentPairing } from "../../packages/shared/inbox/agent-pairing";
import { startInboxServer } from "../../packages/server/inbox";

export const DOOR_KEY = "xai-SECRETKEY0123456789";

export type DoorResult = { content: { text: string }[]; structuredContent?: Record<string, any>; isError?: boolean };

export function doorCleanups() {
  const cleanups: (() => void | Promise<void>)[] = [];
  return {
    push: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup),
    run: async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    },
  };
}

export function stubRoutine(cleanups: ReturnType<typeof doorCleanups>, status = 200) {
  const seen: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true }, { status });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/hook`, seen };
}

export async function doorWorld(cleanups: ReturnType<typeof doorCleanups>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-agent-door-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "secret.png"), "not for the cloud");
  const dataDir = join(root, "data");
  const relayBefore = process.env.PLANNOTATOR_RELAY_URL;
  process.env.PLANNOTATOR_RELAY_URL = "http://127.0.0.1:9";
  cleanups.push(() => {
    if (relayBefore === undefined) delete process.env.PLANNOTATOR_RELAY_URL;
    else process.env.PLANNOTATOR_RELAY_URL = relayBefore;
  });
  const logs: string[] = [];
  const start = () => startInboxServer({ dataDir, debug: true, phones: true, cloudWake: { gapMs: 50, timeoutMs: 2_000, log: (line) => logs.push(line) } });
  let server = await start();
  cleanups.push(() => server.stop());
  let base = `http://127.0.0.1:${server.port}`;
  const mcp = new Client({ name: "agent-door-test", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  cleanups.push(() => mcp.close());
  const localSend = async (args: Record<string, unknown>) =>
    ((await mcp.callTool({ name: "send_message", arguments: { agent_session: "ses-pi", agent_host: "pi", ...args } })) as DoorResult).structuredContent! as { message_id: string; thread_id: string };
  const local = await localSend({ body: "Private plan: the zebra launch.", thread: "launch plan", project_path: project, idempotency_key: "k1" });
  const answers: string[] = [];
  const call = async (path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
    });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, json: JSON.parse(text) as Record<string, any> };
  };
  const pair = async (preset = "grok-bot", name = "Nightly fixer", status = 200) => {
    const hook = stubRoutine(cleanups, status);
    const answer = await fetch(`${base}/api/inbox/cloud-agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, name, preset, url: hook.url, key: DOOR_KEY }),
    });
    expect(answer.status).toBe(200);
    const text = await answer.text();
    answers.push(text);
    const json = JSON.parse(text) as { agent: InboxCloudAgentView; pairing: string };
    const pairing = decodeInboxAgentPairing(json.pairing)!;
    expect(pairing).not.toBeNull();
    return { agent: json.agent, pairing, string: json.pairing, hook };
  };
  const door = async (token: string, tool: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api/inbox/agent/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({ tool, arguments: args }),
    });
    const text = await response.text();
    answers.push(text);
    const json = (response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as { result?: DoorResult; code?: string };
    return { status: response.status, code: json.code, result: json.result, error: json.result?.isError ? json.result.content[0]!.text : null };
  };
  const thread = async (id: string) => (await call(`/api/inbox/threads/${id}`)).json.thread as InboxThread;
  const restart = async () => {
    await server.stop();
    server = await start();
    base = `http://127.0.0.1:${server.port}`;
  };
  return {
    root,
    get base() {
      return base;
    },
    dataDir,
    project,
    logs,
    answers,
    call,
    pair,
    door,
    thread,
    localSend,
    restart,
    local,
  };
}

export const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

export function filesUnder(dir: string) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => ({ path, text: readFileSync(path, "latin1") }));
}
