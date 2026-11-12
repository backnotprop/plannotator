/**
 * The agent door (inbox-agent-door.ts): a paired cloud agent through the Inbox's real routes on loopback, its webhook
 * a local stub. Every test has its own temp data dir; nothing outside this computer is called.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxCloudAgentView } from "@plannotator/core/inbox-cloud";
import type { InboxThread } from "@plannotator/core/inbox-types";
import { decodeInboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import { sha256Hex } from "@plannotator/shared/inbox/devices";
import { runInboxCallCommand } from "../../apps/hook/server/inbox-call-command";
import { startInboxServer } from "./inbox";
import { cloudAgentsPath } from "./inbox-cloud-agents";
import { INBOX_AGENT_ATTACHMENTS_MAX_BYTES } from "./inbox-agent-door";

const KEY = "xai-SECRETKEY0123456789";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function stubRoutine() {
  const seen: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.push((await req.json()) as Record<string, unknown>);
      return Response.json({ ok: true });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/hook`, seen };
}

type Result = { content: { text: string }[]; structuredContent?: Record<string, any>; isError?: boolean };

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-agent-door-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "secret.png"), "not for the cloud");
  const dataDir = join(root, "data");
  // A phone's pairing makes a relay mailbox: never the real relay from a test.
  const relayBefore = process.env.PLANNOTATOR_RELAY_URL;
  process.env.PLANNOTATOR_RELAY_URL = "http://127.0.0.1:9";
  cleanups.push(() => {
    if (relayBefore === undefined) delete process.env.PLANNOTATOR_RELAY_URL;
    else process.env.PLANNOTATOR_RELAY_URL = relayBefore;
  });
  const logs: string[] = [];
  const server = await startInboxServer({ dataDir, debug: true, phones: true, cloudWake: { gapMs: 50, timeoutMs: 2_000, log: (line) => logs.push(line) } });
  cleanups.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const mcp = new Client({ name: "agent-door-test", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  cleanups.push(() => mcp.close());
  /** A local agent's thread in the same project, which the cloud agent must never reach. */
  const local = (await mcp.callTool({
    name: "send_message",
    arguments: { body: "Private plan: the zebra launch.", thread: "launch plan", project_path: project, agent_session: "ses-pi", agent_host: "pi", idempotency_key: "k1" },
  })) as Result;
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
  const pair = async (preset = "grok-bot", name = "Nightly fixer") => {
    const hook = stubRoutine();
    const answer = await fetch(`${base}/api/inbox/cloud-agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, name, preset, url: hook.url, key: KEY }),
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
    const json = (response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as { result?: Result; code?: string };
    return { status: response.status, code: json.code, result: json.result, error: json.result?.isError ? json.result.content[0]!.text : null };
  };
  const thread = async (id: string) => (await call(`/api/inbox/threads/${id}`)).json.thread as InboxThread;
  return { server, base, dataDir, project, logs, answers, call, pair, door, thread, local: local.structuredContent! as { message_id: string; thread_id: string } };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

function filesUnder(dir: string) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => ({ path, text: readFileSync(path, "latin1") }));
}

describe("the agent door", () => {
  test("pairing mints an agent device (token hash, 0600 secret); it posts as itself, the reply wakes it, and Remove refuses it at once and deletes its secret and key", async () => {
    const w = await world();
    const { agent, pairing, hook } = await w.pair();
    const devices = readFileSync(join(w.dataDir, "inbox", "devices.jsonl"), "utf8");
    expect(devices).toContain(sha256Hex(pairing.token));
    expect(devices).not.toContain(pairing.token);
    expect(JSON.parse(devices.trim().split("\n").at(-1)!).record).toMatchObject({ id: pairing.device_id, platform: "agent", carriage: false, revoked_at: null });
    const secretFile = join(w.dataDir, "inbox", "device-secrets", pairing.device_id);
    expect(readFileSync(secretFile, "utf8")).toBe(pairing.secret);
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    // Not a phone: the window's device list leaves it out.
    expect((await w.call("/api/inbox/devices")).json.devices).toEqual([]);

    const sent = await w.door(pairing.token, "send_message", { body: "Found the flaky test. Fix it now?", idempotency_key: "s1" });
    expect(sent.error).toBeNull();
    const threadId = sent.result!.structuredContent!.thread_id as string;
    const posted = (await w.thread(threadId)).messages[0]!;
    expect(posted.author).toEqual({ kind: "agent", host: "cloud-grok", session: agent.session, name: "Nightly fixer" });

    await w.call(`/api/inbox/messages/${posted.id}/reply`, { words: "Yes, fix it.", idempotency_key: "r1" });
    await until(() => hook.seen.length === 1);
    expect(String(hook.seen[0]!.text)).toContain("Yes, fix it.");
    const read = await w.door(pairing.token, "read_thread", { thread_id: threadId });
    expect(read.result!.content[0]!.text).toContain("Yes, fix it.");

    await w.call(`/api/inbox/cloud-agents/${agent.session}/remove`, {});
    const refused = await w.door(pairing.token, "read_thread", { thread_id: threadId });
    expect([refused.status, refused.code]).toEqual([401, "device_revoked"]);
    expect(() => statSync(secretFile)).toThrow();
    expect(readFileSync(cloudAgentsPath(w.dataDir), "utf8")).not.toContain(KEY);
    // Its old messages stay.
    expect((await w.thread(threadId)).messages.map((m) => m.body)).toContain("Found the flaky test. Fix it now?");
  });

  test("an agent token opens no route but its own tools, and a phone's or a stranger's token does not open the agent door", async () => {
    const w = await world();
    const { pairing } = await w.pair();
    const { local } = w;
    // Every non-agent route class through the phone's door: list, a thread, picks, answers, approve, drafts, files, launch, the stream.
    for (const [method, route] of [
      ["GET", "threads"],
      ["GET", `threads/${local.thread_id}`],
      ["POST", `messages/${local.message_id}/picks`],
      ["POST", `messages/${local.message_id}/reply`],
      ["POST", `messages/${local.message_id}/ack`],
      ["GET", `threads/${local.thread_id}/draft`],
      ["GET", `messages/${local.message_id}/image?path=secret.png`],
      ["POST", "uploads"],
      ["POST", "launch/x/stop"],
      ["GET", "events"],
      ["GET", "search?q=zebra"],
      ["POST", "revoke"],
    ] as const) {
      const response = await fetch(`${w.base}/api/inbox/device/${route}`, {
        method,
        headers: { Authorization: `Bearer ${pairing.token}`, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ idempotency_key: route }) } : {}),
      });
      expect([route, response.status, ((await response.json()) as { code: string }).code]).toEqual([route, 403, "agent_not_accepted_here"]);
    }
    // The tools that answer, approve, launch, change settings or reach the person's files are not open to it.
    for (const tool of ["snooze_thread", "thread_pulls", "submit_guide", "get_guide_brief", "card", "steps", "messages/x/picks", "approve"]) {
      const answer = await w.door(pairing.token, tool, {});
      expect([tool, answer.error?.split(":")[0]]).toEqual([tool, "tool_not_allowed"]);
    }
    expect((await w.door(pairing.token, "read_thread", { thread_id: local.thread_id }, { Origin: "https://evil.example" })).code).toBe("origin_not_allowed");
    expect((await w.door(pairing.token, "read_thread", { thread_id: local.thread_id }, { "X-Forwarded-For": "100.64.0.9" })).status).toBe(403);
    expect((await w.door(pairing.token, "read_thread", { thread_id: local.thread_id }, { Host: "inbox.tailnet.example" })).status).toBe(403);
    expect((await w.door("tok_" + "x".repeat(43), "read_thread", {})).code).toBe("device_token_invalid");

    // A phone, paired the phone way, cannot use the agent door.
    const offer = await w.call("/api/inbox/pairing", {});
    const secret = /secret=([^&]+)/.exec(offer.json.link as string)![1]!;
    const phone = await fetch(`${w.base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret, name: "iPhone", platform: "ios" }) });
    const { token: phoneToken } = (await phone.json()) as { token: string };
    expect((await w.door(phoneToken, "read_thread", {})).code).toBe("device_not_an_agent");
  });

  test("it reads and writes only threads it started, was sent or was tagged in: by id, by search, by reply_to, by thread name", async () => {
    const w = await world();
    const { agent, pairing } = await w.pair();
    const { local } = w;
    const own = await w.door(pairing.token, "send_message", { body: "My own thread about the zebra fix.", idempotency_key: "o1" });
    const ownThread = own.result!.structuredContent!.thread_id as string;

    expect((await w.door(pairing.token, "read_thread", { thread_id: local.thread_id })).error).toBe(`thread_not_found: No thread ${local.thread_id}.`);
    expect((await w.door(pairing.token, "read_thread", { message_id: local.message_id })).error).toStartWith("message_not_found:");
    expect((await w.door(pairing.token, "read_thread", { thread_id: ownThread, expand: [local.message_id] })).error).toStartWith("message_not_found:");
    const list = await w.door(pairing.token, "read_thread", {});
    expect((list.result!.structuredContent!.threads as { thread_id: string }[]).map((t) => t.thread_id)).toEqual([ownThread]);
    expect((await w.door(pairing.token, "read_thread", { asked_by: "anyone" })).error).toStartWith("validation_error:");
    const found = await w.door(pairing.token, "search", { query: "zebra" });
    expect(found.result!.structuredContent!.total).toBe(1);
    expect((found.result!.structuredContent!.results as { thread_id: string }[])[0]!.thread_id).toBe(ownThread);
    expect(JSON.stringify(found.result)).not.toContain("Private plan");

    const count = (await w.thread(local.thread_id)).messages.length;
    expect((await w.door(pairing.token, "send_message", { body: "Psst.", reply_to: local.message_id })).error).toStartWith("message_not_found:");
    expect((await w.door(pairing.token, "send_message", { body: "Psst.", thread: "launch plan" })).error).toStartWith("thread_name_taken:");
    expect((await w.door(pairing.token, "send_message", { body: "Private plan: the zebra launch.", idempotency_key: "k1" })).result!.structuredContent!.thread_id).not.toBe(local.thread_id);
    expect((await w.door(pairing.token, "resolve_message", { message_id: local.message_id })).error).toStartWith("message_not_found:");
    expect((await w.thread(local.thread_id)).messages).toHaveLength(count);
    expect((await w.thread(local.thread_id)).resolved_at).toBeNull();

    // Tagged in the local agent's thread: now it may read it.
    await w.call(`/api/inbox/messages/${local.message_id}/reply`, { words: "@Nightly fixer have a look.", idempotency_key: "t1", tags: [{ session: agent.session }] });
    expect((await w.door(pairing.token, "read_thread", { thread_id: local.thread_id })).result!.content[0]!.text).toContain("have a look");
    // Sent a New message: that thread too.
    const sentTo = await w.call("/api/inbox/messages", { to: { session: agent.session }, body: "Please check the logs.", idempotency_key: "n1" });
    expect((await w.door(pairing.token, "read_thread", { thread_id: sentTo.json.thread_id })).error).toBeNull();
    // It resolves through its own message only.
    expect((await w.door(pairing.token, "resolve_message", { message_id: sentTo.json.message.id })).error).toStartWith("not_your_message:");
    expect((await w.door(pairing.token, "resolve_message", { message_id: own.result!.structuredContent!.message_id })).error).toBeNull();
  });

  test("it cannot set its identity or project; a path is refused and uploaded bytes are attached", async () => {
    const w = await world();
    const { agent, pairing } = await w.pair("claude-routine", "Fixer");
    for (const [field, code] of [
      ["agent_session", "identity_forced"],
      ["agent_name", "identity_forced"],
      ["agent_host", "identity_forced"],
      ["project_path", "project_forced"],
      ["_meta", "validation_error"],
    ] as const) {
      expect((await w.door(pairing.token, "send_message", { body: "Hi", [field]: field === "project_path" ? "/" : "ses-pi" })).error).toStartWith(`${code}:`);
    }
    const before = filesUnder(join(w.dataDir, "inbox")).length;
    expect((await w.door(pairing.token, "send_message", { body: "See this.", attachments: [join(w.project, "secret.png")] })).error).toStartWith("attachment_path_refused:");
    expect((await w.door(pairing.token, "send_message", { body: "See this.", attachments: ["../../../etc/hosts"] })).error).toStartWith("attachment_path_refused:");
    expect((await w.door(pairing.token, "send_message", { body: "See ![it](secret.png)" })).error).toStartWith("image_path_refused:");
    expect((await w.door(pairing.token, "send_message", { body: "Big.", attachments: [{ name: "big.bin", data: Buffer.alloc(INBOX_AGENT_ATTACHMENTS_MAX_BYTES + 1).toString("base64") }] })).error).toStartWith("attachments_too_large:");
    expect(filesUnder(join(w.dataDir, "inbox")).length).toBe(before);

    const sent = await w.door(pairing.token, "send_message", { body: "The notes.", attachments: [{ name: "notes.md", data: Buffer.from("# From the cloud\n").toString("base64") }] });
    expect(sent.error).toBeNull();
    const message = (await w.thread(sent.result!.structuredContent!.thread_id as string)).messages[0]!;
    expect(message.author).toMatchObject({ host: "cloud-claude", session: agent.session, name: "Fixer" });
    expect(message.attachments!.map((a) => [a.name, a.size])).toEqual([["notes.md", 17]]);
    expect(readFileSync(message.attachments![0]!.path, "utf8")).toBe("# From the cloud\n");
  });

  test("the pairing's token and secret and the webhook key never appear in another API answer, an event, a log line or a file; plannotator inbox call uses the door with PLANNOTATOR_PAIRING", async () => {
    const w = await world();
    const events = await fetch(`${w.base}/api/inbox/events?cursor=0`);
    const reader = events.body!.getReader();
    const { pairing, string } = await w.pair();
    const pairAnswer = w.answers.length;

    const cwd = mkdtempSync(join(tmpdir(), "plannotator-routine-"));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    writeFileSync(join(cwd, "report.txt"), "all green");
    let stdout = "";
    let stderr = "";
    const run = (argv: string[], env: Record<string, string | undefined>) =>
      runInboxCallCommand(argv, { cwd, env, ensureRunning: () => Promise.reject(new Error("not used")), out: (text) => void (stdout += text), err: (text) => void (stderr += text) });
    const env = { PLANNOTATOR_PAIRING: string, PLANNOTATOR_PAIRING_DOOR: w.base };
    expect(await run(["send_message", JSON.stringify({ body: "Done: the build is green.", attachments: ["report.txt"], idempotency_key: "c1" })], env)).toBe(0);
    const sent = JSON.parse(stdout) as { thread_id: string };
    expect((await w.thread(sent.thread_id)).messages[0]!.attachments!.map((a) => a.name)).toEqual(["report.txt"]);
    expect(await run(["read_thread", JSON.stringify({ thread_id: w.local.thread_id })], env)).toBe(1);
    expect(stderr).toContain("thread_not_found");
    expect(await run(["read_thread", "{}"], { PLANNOTATOR_PAIRING: string, PLANNOTATOR_PAIRING_DOOR: "https://relay.example" })).toBe(2);
    expect(stderr).toContain("pairing_door_needed");

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
    await Bun.sleep(400);
    // Where each one belongs: the secret in its own 0600 file, the key in cloud-agents.json, the token nowhere.
    const files = filesUnder(w.dataDir).filter((file) => !file.path.endsWith(join("device-secrets", pairing.device_id)) && file.path !== cloudAgentsPath(w.dataDir));
    expect(w.answers[pairAnswer - 1]).toContain(string);
    const haystacks = [...w.answers.filter((_, i) => i !== pairAnswer - 1), ...frames, ...w.logs, stdout, stderr, ...files.map((file) => file.text)];
    for (const secret of [pairing.token, pairing.secret, string, KEY]) {
      expect(haystacks.filter((text) => text.includes(secret)).map((text) => text.slice(0, 80))).toEqual([]);
    }
    expect(readFileSync(cloudAgentsPath(w.dataDir), "utf8")).not.toContain(pairing.token);
    expect(files.some((file) => file.path.endsWith("debug.log"))).toBe(true);
  });
});
