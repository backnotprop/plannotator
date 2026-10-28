/**
 * `plannotator inbox` as real processes: `--background` starts a detached
 * Inbox (no browser), the registry tells running from stopped (a dead pid, a
 * port answering for another Inbox, a live pid with no answer), a restart
 * takes the last port and rotates the token, `plannotator inbox mcp` is driven
 * by the official MCP SDK's stdio client and starts a stopped Inbox itself, a
 * person's `plannotator inbox` opens the browser, and uninstall --purge stops
 * a running Inbox before deleting its data. Every process gets a temp HOME and
 * data dir.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { INBOX_HOST_NAMES, type InboxQuestion } from "@plannotator/core/inbox-types";
import { inboxStatus, isPidAlive, readInboxRegistry, writeInboxRegistry } from "@plannotator/shared/inbox/registry";
import { startInboxServer } from "@plannotator/server/inbox";
import { INBOX_DEFAULT_SERVED_TOOLS } from "@plannotator/server/inbox-mcp";
import { GUIDE_BRIEF_EXAMPLE } from "../../../packages/server/inbox-guides";
import { runPlannotatorUninstall } from "@plannotator/server/uninstall";
import { INBOX_MAX_REQUEST_BYTES } from "@plannotator/shared/inbox/connection";
import { INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { INBOX_AGENT_NAME, INBOX_HOST } from "../hooks/mod/inbox";
import { OPENCODE_INBOX_AGENT_NAME, OPENCODE_INBOX_HOST } from "../../opencode-plugin/inbox";
import { fillInboxToolArguments, inboxCallHostSession, inboxHostSessionFromEnv, inboxQwenShimContext, INBOX_SESSION_HOST_NAMES, runInboxMcpShim } from "./inbox-mcp-shim";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, mustSignalInbox, signalProvenInbox, stopProvenInboxes } from "../../../tests/helpers/inbox-process";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];
/** Each Inbox a test started, with its sandbox: killed after only when still provably that Inbox. */
const started: { entry: InboxEntry; root: string }[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; these tests never read the pages.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await stopProvenInboxes(started.splice(0), { signal: "SIGKILL" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Remember the Inbox the sandbox's registry names now, for the teardown. */
function track(box: Sandbox): void {
  const entry = inboxEntryOf(box.dataDir);
  if (entry) started.push({ entry, root: box.root });
}

interface Sandbox {
  root: string;
  home: string;
  dataDir: string;
  browserMarker: string;
  env: Record<string, string>;
}

function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-cli-")));
  roots.push(root);
  const home = join(root, "home");
  const dataDir = join(home, ".plannotator");
  mkdirSync(home, { recursive: true });
  const browserMarker = join(root, "browser-opened");
  const browser = join(root, "fake-browser.sh");
  writeFileSync(browser, `#!/bin/sh\necho "$1" >> '${browserMarker}'\n`);
  chmodSync(browser, 0o755);
  return {
    root,
    home,
    dataDir,
    browserMarker,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      // Both are ignored by the Inbox: local only, never 19432.
      PLANNOTATOR_REMOTE: "1",
      PLANNOTATOR_PORT: "19432",
      PLANNOTATOR_BROWSER: browser,
      BROWSER: browser,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      // A person's `plannotator inbox` runs the agents' own CLIs from PATH;
      // these tests never do (inbox-connect-cli.test.ts proves it with fakes).
      PLANNOTATOR_INBOX_CONNECT: "0",
    },
  };
}

function gitProject(box: Sandbox): string {
  const dir = join(box.root, "projects", "billing");
  mkdirSync(join(dir, "worker"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: box.env });
  return dir;
}

async function cli(box: Sandbox, args: string[], cwd = box.root): Promise<{ code: number; stdout: string; stderr: string; pid: number }> {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], { cwd, env: box.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr, pid: proc.pid };
}

async function background(box: Sandbox) {
  const result = await cli(box, ["inbox", "--background"]);
  const registry = readInboxRegistry(box.dataDir);
  track(box);
  return { ...result, registry };
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (isPidAlive(pid) && Date.now() < deadline) await Bun.sleep(25);
}

describe("plannotator inbox --background", () => {
  test("starts a detached, loopback-only Inbox without a browser and without a sessions/ entry", async () => {
    const box = sandbox();
    const first = await background(box);
    expect(first.code).toBe(0);
    const registry = first.registry!;
    expect(first.stdout.trim()).toBe(registry.url);
    expect(registry.port).not.toBe(19432);
    expect(registry.pid).not.toBe(first.pid);
    // The starter has exited; the Inbox it started lives on.
    expect(isPidAlive(registry.pid)).toBe(true);
    expect((await inboxStatus(box.dataDir)).state).toBe("running");
    const health = await (await fetch(`http://127.0.0.1:${registry.port}/api/inbox/health`)).json();
    expect(health).toMatchObject({ app: "plannotator-inbox", pid: registry.pid, serverSession: registry.serverSession });
    expect(existsSync(box.browserMarker)).toBe(false);
    const sessions = join(box.dataDir, "sessions");
    expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([]);

    // A second start finds it and starts nothing.
    const second = await background(box);
    expect(second.code).toBe(0);
    expect(second.stdout.trim()).toBe(registry.url);
    expect(second.registry!.pid).toBe(registry.pid);
    expect(second.registry!.token).toBe(registry.token);
  }, 60_000);

  test("two starters at once make one Inbox", async () => {
    const box = sandbox();
    const [a, b] = await Promise.all([background(box), background(box)]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout.trim()).toBe(b.stdout.trim());
    const live = readInboxRegistry(box.dataDir)!;
    expect(isPidAlive(live.pid)).toBe(true);
    // Every detached Inbox writes its ready line to inbox/inbox.log: one start, one line.
    const log = readFileSync(join(box.dataDir, "inbox", "inbox.log"), "utf8");
    expect(log.split("\n").filter((line) => line.startsWith("Plannotator Inbox: "))).toEqual([`Plannotator Inbox: ${live.url}`]);
  }, 60_000);

  test("a killed Inbox reads as stopped; the next start takes the last port and rotates token and serverSession", async () => {
    const box = sandbox();
    const first = (await background(box)).registry!;
    await mustSignalInbox(first, box.root, "SIGKILL");
    await waitDead(first.pid);
    const stopped = await inboxStatus(box.dataDir);
    expect(stopped).toMatchObject({ state: "stopped", reason: "dead_pid" });
    // The registry stays after exit, so agents still find the Inbox.
    expect(readInboxRegistry(box.dataDir)!.pid).toBe(first.pid);

    const restarted = await background(box);
    expect(restarted.code).toBe(0);
    const second = restarted.registry!;
    expect(second.pid).not.toBe(first.pid);
    expect(second.port).toBe(first.port);
    expect(second.token).not.toBe(first.token);
    expect(second.serverSession).not.toBe(first.serverSession);
  }, 60_000);

  test("a port answering for a different Inbox reads as stopped; the restart moves to a new port", async () => {
    const box = sandbox();
    const first = (await background(box)).registry!;
    await mustSignalInbox(first, box.root, "SIGKILL");
    await waitDead(first.pid);
    // Another Inbox (another data dir) now holds that port.
    const otherDir = join(box.root, "other-data");
    writeInboxRegistry(otherDir, { ...first, pid: 1, serverSession: "x".repeat(32) });
    const other = await startInboxServer({ dataDir: otherDir });
    cleanups.push(() => other.stop());
    expect(other.port).toBe(first.port);
    expect(await inboxStatus(box.dataDir)).toMatchObject({ state: "stopped", reason: "other_session" });

    const restarted = await background(box);
    expect(restarted.code).toBe(0);
    expect(restarted.registry!.port).not.toBe(first.port);
    expect(restarted.registry!.serverSession).not.toBe(other.serverSession);
  }, 60_000);

  test("a busy Inbox (paused: the port takes the request, no answer) is waited for, never replaced by a second writer", async () => {
    const box = sandbox();
    const first = (await background(box)).registry!;
    await mustSignalInbox(first, box.root, "SIGSTOP");
    let resumed = false;
    try {
      expect(await inboxStatus(box.dataDir, 500)).toMatchObject({ state: "busy" });
      const starting = background(box);
      await Bun.sleep(3000);
      await mustSignalInbox(first, box.root, "SIGCONT");
      resumed = true;
      const again = await starting;
      expect(again.code).toBe(0);
      expect(again.stdout.trim()).toBe(first.url);
      expect(again.registry!.pid).toBe(first.pid);
      expect(again.registry!.token).toBe(first.token);
      // One Inbox ever started on this store: one ready line in its log.
      const log = readFileSync(join(box.dataDir, "inbox", "inbox.log"), "utf8");
      expect(log.split("\n").filter((line) => line.startsWith("Plannotator Inbox: "))).toHaveLength(1);
    } finally {
      if (!resumed) await signalProvenInbox(first, box.root, "SIGCONT");
    }
  }, 60_000);

  test("a live pid with nothing on the port reads as stopped", async () => {
    const box = sandbox();
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const deadPort = probe.port as number;
    probe.stop(true);
    writeInboxRegistry(box.dataDir, {
      v: 1,
      pid: process.pid,
      port: deadPort,
      url: `http://localhost:${deadPort}/`,
      version: "dev",
      token: "t".repeat(64),
      serverSession: "s".repeat(32),
      startedAt: new Date().toISOString(),
    });
    expect(await inboxStatus(box.dataDir)).toMatchObject({ state: "stopped", reason: "no_answer" });
    const started = await background(box);
    expect(started.code).toBe(0);
    expect(started.registry!.pid).not.toBe(process.pid);
  }, 60_000);
});

describe("plannotator inbox mcp (the stdio shim)", () => {
  test("starts a stopped Inbox with no browser tab, fills project_path and the session, and carries the answer back", async () => {
    const box = sandbox();
    const project = gitProject(box);
    // An Inbox ran here once and stopped: the registry is stale.
    const old = (await background(box)).registry!;
    await mustSignalInbox(old, box.root, "SIGKILL");
    await waitDead(old.pid);

    const client = new Client({ name: "shim-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", entry, "inbox", "mcp"],
      cwd: join(project, "worker"),
      env: box.env,
      stderr: "pipe",
    });
    await client.connect(transport);
    cleanups.push(() => client.close());

    const registry = readInboxRegistry(box.dataDir)!;
    track(box);
    expect(registry.pid).not.toBe(old.pid);
    expect((await inboxStatus(box.dataDir)).state).toBe("running");
    expect(existsSync(box.browserMarker)).toBe(false);

    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...INBOX_DEFAULT_SERVED_TOOLS].sort());
    const sent = (
      await client.callTool({
        name: "send_message",
        arguments: { body: ":::question\nShip the worker today?\n\n- [ ] Yes\n- [ ] No\n\nRecommended: Yes\n:::", idempotency_key: "ship-1" },
      })
    ).structuredContent as { message_id: string; thread_id: string; project: { root: string } };
    // The shim filled project_path from its working folder: the repository.
    expect(sent.project.root).toBe(project);

    // The thread is the shim session's own: asked_by "me" finds it.
    const mine = (await client.callTool({ name: "read_thread", arguments: {} })).structuredContent as { threads: { thread_id: string }[] };
    expect(mine.threads.map((t) => t.thread_id)).toEqual([sent.thread_id]);

    // The person answers in the window's API (picked, then Send).
    const base = `http://127.0.0.1:${registry.port}`;
    const { thread } = await (await fetch(`${base}/api/inbox/threads/${sent.thread_id}`)).json();
    const question = thread.messages[0].questions[0] as InboxQuestion;
    expect(question.asked_by_agent_id).toMatch(/^ses_[0-9A-Z]{26}$/);
    const waiting = client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.thread_id, timeout_seconds: 30 } });
    const answer = { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: ["Yes"] };
    const pick = await fetch(`${base}/api/inbox/messages/${sent.message_id}/picks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: [{ key: question.key, revision: 0, answer }] }),
    });
    expect(pick.status).toBe(200);
    const send = await fetch(`${base}/api/inbox/messages/${sent.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "send-1", questions: [{ key: question.key, revision: 1 }] }),
    });
    expect(send.status).toBe(200);
    const reply = (await waiting).structuredContent as { status: string; reply: { body: string } };
    expect(reply.status).toBe("replied");
    expect(reply.reply.body).toContain("Answer: Yes (your recommendation)");

    // submit_guide is routed like send_message: no project_path, and it lands in the same project
    // and session (an MCP-only agent has no other way to name them).
    const guided = await client.callTool({ name: "submit_guide", arguments: { ...GUIDE_BRIEF_EXAMPLE, idempotency_key: "guide-1" } });
    expect(guided.isError).toBeFalsy();
    const guide = guided.structuredContent as { thread_id: string; project: { root: string } };
    expect(guide.project.root).toBe(project);
    const mineNow = (await client.callTool({ name: "read_thread", arguments: {} })).structuredContent as { threads: { thread_id: string }[] };
    expect(mineNow.threads.map((t) => t.thread_id)).toContain(guide.thread_id);
  }, 90_000);
});

describe("plannotator inbox mcp inside an agent session", () => {
  const CLAUDE_SESSION = "0f3c2a51-7d4e-4b8a-9e21-5c6d7e8f9a0b";
  const CODEX_THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5c";

  async function shim(box: Sandbox, cwd: string, extraEnv: Record<string, string>): Promise<Client> {
    const client = new Client({ name: "shim-session", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({ command: process.execPath, args: ["run", entry, "inbox", "mcp"], cwd, env: { ...box.env, ...extraEnv }, stderr: "pipe" }),
    );
    cleanups.push(() => client.close());
    return client;
  }

  async function author(port: number, threadId: string, index: number) {
    const { thread } = await (await fetch(`http://127.0.0.1:${port}/api/inbox/threads/${threadId}`)).json();
    return thread.messages[index].author as { kind: string; host: string | null; session: string | null; name: string | null };
  }

  test("the names it fills are the ones each host's own plannotator_inbox tool sends", () => {
    expect(INBOX_SESSION_HOST_NAMES[INBOX_HOST]).toBe(INBOX_AGENT_NAME);
    expect(INBOX_SESSION_HOST_NAMES[OPENCODE_INBOX_HOST]).toBe(OPENCODE_INBOX_AGENT_NAME);
    // Pi's constants, read from source: apps/pi-extension/inbox.ts imports its generated/ folder, which exists only after vendor.sh.
    const piSource = readFileSync(resolve(import.meta.dir, "../../pi-extension/inbox.ts"), "utf8");
    const piHost = /export const PI_INBOX_HOST = "([^"]+)";/.exec(piSource)?.[1];
    const piName = /export const PI_INBOX_AGENT_NAME = "([^"]+)";/.exec(piSource)?.[1];
    expect(piHost).toBe("pi");
    expect(piName).toBeDefined();
    expect(INBOX_SESSION_HOST_NAMES[piHost!]).toBe(piName!);
    // Codex and Qwen Code have no plannotator_inbox tool: the Inbox wakes them itself (`codex queue`, Qwen's
    // cross-session messaging), and the shim sends as their session.
    // Grok Build: a session the Inbox runs itself (inbox-acp-runner.ts), named as its messages are (core INBOX_HOST_NAMES).
    expect(Object.keys(INBOX_SESSION_HOST_NAMES).sort()).toEqual(["claude-code", "codex", "grok", "opencode", "pi", "qwen"]);
    expect(INBOX_SESSION_HOST_NAMES.codex).toBe("Codex");
    expect(INBOX_SESSION_HOST_NAMES.grok).toBe(INBOX_HOST_NAMES.grok);
    expect(INBOX_SESSION_HOST_NAMES.qwen).toBe("Qwen Code");
    // A Qwen session in the tag is a Qwen session id, never anything else.
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: "qwen:8e016be8-5b48-4c13-ad22-1f5326ae64ac" })).toEqual({ host: "qwen", session: "8e016be8-5b48-4c13-ad22-1f5326ae64ac", name: "Qwen Code" });
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: "qwen:ses_01ABC" })).toBeNull();
  });

  test("the session tag is read strictly; anything malformed is ignored", () => {
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}` })).toEqual({ host: "claude-code", session: CLAUDE_SESSION, name: "Claude Code" });
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: "opencode:ses_01ABC" })).toEqual({ host: "opencode", session: "ses_01ABC", name: "OpenCode" });
    expect(inboxHostSessionFromEnv({ PI_SESSION_ID: "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b" })).toEqual({
      host: "pi",
      session: "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b",
      name: "Pi",
    });
    // The Plannotator tag wins over Pi's own variable.
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}`, PI_SESSION_ID: "abc" })?.host).toBe("claude-code");
    for (const tag of [
      "",
      "claude-code",
      "claude-code:",
      ":abc",
      "codex:abc",
      "Claude-Code:abc",
      "claude-code:a b",
      "claude-code:../x",
      "claude-code:a/b",
      "claude-code:-abc",
      "claude-code:abc\n",
      "claude-code:a:b",
      `claude-code:${"a".repeat(129)}`,
      "__proto__:abc",
      "constructor:abc",
      "toString:abc",
    ]) {
      expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: tag })).toBeNull();
    }
    // Codex sets CODEX_THREAD_ID in the commands its shell runs: a thread id (a UUID), nothing else.
    expect(inboxHostSessionFromEnv({ CODEX_THREAD_ID: CODEX_THREAD })).toEqual({ host: "codex", session: CODEX_THREAD, name: "Codex" });
    expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: `codex:${CODEX_THREAD}` })).toEqual({ host: "codex", session: CODEX_THREAD, name: "Codex" });
    for (const bad of ["", "abc", `${CODEX_THREAD} `, "--yolo", "ses_01ABC"]) expect(inboxHostSessionFromEnv({ CODEX_THREAD_ID: bad })).toBeNull();
    expect(inboxHostSessionFromEnv({ PI_SESSION_ID: "pi-1", CODEX_THREAD_ID: CODEX_THREAD })?.host).toBe("pi");
    expect(inboxHostSessionFromEnv({ PI_SESSION_ID: "" })).toBeNull();
    expect(inboxHostSessionFromEnv({ PI_SESSION_ID: "a;b" })).toBeNull();
    expect(inboxHostSessionFromEnv({})).toBeNull();
  });

  test("a call from Codex is its thread's: the thread id from _meta, host codex, whatever the environment says", () => {
    const meta = { threadId: CODEX_THREAD, "x-codex-turn-metadata": { turn_started_at_unix_ms: 1 } };
    const fill = (name: string, args: Record<string, unknown>, callMeta: unknown, clientName?: string | null) =>
      fillInboxToolArguments(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: callMeta as Record<string, unknown> } },
        "/work",
        "ses_OWN",
        { host: "claude-code", session: CLAUDE_SESSION, name: "Claude Code" },
        clientName,
      ).params!;
    expect(fill("send_message", { body: "hi" }, meta).arguments).toEqual({ body: "hi", project_path: "/work", agent_session: CODEX_THREAD, agent_host: "codex", agent_name: "Codex" });
    // The _meta stays on the call: the Inbox reads the turn from it.
    expect(fill("send_message", { body: "hi" }, meta)._meta).toEqual(meta);
    expect(fill("read_thread", {}, meta).arguments).toEqual({ project_path: "/work", agent_session: CODEX_THREAD });
    // Codex's client name alone is enough (a call without turn metadata).
    expect(fill("wait_for_reply", {}, { threadId: CODEX_THREAD }, "codex-mcp-client").arguments).toEqual({ project_path: "/work", agent_session: CODEX_THREAD });
    // Not from Codex, or no thread id: the environment's session, as before.
    expect(fill("send_message", { body: "hi" }, { threadId: CODEX_THREAD }).arguments).toMatchObject({ agent_session: CLAUDE_SESSION, agent_host: "claude-code" });
    expect(fill("send_message", { body: "hi" }, { threadId: "nope", "x-codex-turn-metadata": {} }).arguments).toMatchObject({ agent_session: CLAUDE_SESSION });
    // The agent's own session stands.
    expect(fill("send_message", { body: "hi", agent_session: "mine" }, meta).arguments).toEqual({ body: "hi", project_path: "/work", agent_session: "mine" });
  });

  test("host and name are filled only on the tools that record an author, and only when the agent left them out", () => {
    const hostSession = { host: "claude-code", session: CLAUDE_SESSION, name: "Claude Code" };
    const call = (name: string, args: Record<string, unknown>) =>
      fillInboxToolArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "/work", "ses_OWN", hostSession).params!
        .arguments as Record<string, unknown>;
    expect(call("send_message", { body: "hi" })).toEqual({ body: "hi", project_path: "/work", agent_session: CLAUDE_SESSION, agent_host: "claude-code", agent_name: "Claude Code" });
    // read_thread and wait_for_reply have strict schemas without agent_host.
    expect(call("read_thread", {})).toEqual({ project_path: "/work", agent_session: CLAUDE_SESSION });
    expect(call("wait_for_reply", {})).toEqual({ project_path: "/work", agent_session: CLAUDE_SESSION });
    // search takes the project only (strict, no session), and nothing when it searches every project.
    expect(call("search", { query: "retry" })).toEqual({ query: "retry", project_path: "/work" });
    expect(call("search", { query: "retry", all_projects: true })).toEqual({ query: "retry", all_projects: true });
    // The agent's own choices stand.
    expect(call("send_message", { body: "hi", agent_session: "mine" })).toEqual({ body: "hi", project_path: "/work", agent_session: "mine" });
    // An agent that names another host is not this session: it gets the shim's own id, so a reply to it never wakes the session.
    expect(call("send_message", { body: "hi", agent_host: "codex" })).toEqual({ body: "hi", project_path: "/work", agent_session: "ses_OWN", agent_host: "codex" });
    expect(call("send_message", { body: "hi", agent_host: "claude-code" })).toEqual({
      body: "hi",
      project_path: "/work",
      agent_session: CLAUDE_SESSION,
      agent_host: "claude-code",
      agent_name: "Claude Code",
    });
    expect(call("read_thread", { agent_host: "codex" })).toEqual({ project_path: "/work", agent_session: "ses_OWN", agent_host: "codex" });
    // Without a host session, the shim's own id.
    expect(
      fillInboxToolArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "hi" } } }, "/work", "ses_OWN", null).params!
        .arguments,
    ).toEqual({ body: "hi", project_path: "/work", agent_session: "ses_OWN" });
    expect(call("send_message", { body: "hi", agent_name: "Helper" })).toMatchObject({ agent_host: "claude-code", agent_name: "Helper" });
    // A Claude Code session's calls never claim to wake (its connection says so itself).
    expect(fillInboxToolArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: {} } }, "/work", "ses_OWN", hostSession).params!._meta).toBeUndefined();
  });

  test("a session the Inbox runs (Grok Build, PLANNOTATOR_SESSION_TAG set by the runner) sends as that session, marked as woken by its replies", () => {
    const run = "run_01HZY3T5R4M2Q8W9X6V7B1N0KP";
    const hostSession = inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: `grok:${run}` });
    expect(hostSession).toEqual({ host: "grok", session: run, name: "Grok Build" });
    const filled = fillInboxToolArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "hi" } } }, "/work", "ses_OWN", hostSession).params!;
    expect(filled.arguments).toEqual({ body: "hi", project_path: "/work", agent_session: run, agent_host: "grok", agent_name: "Grok Build" });
    expect(filled._meta).toEqual({ "ai.plannotator/inbox-wakes": true });
    // An agent that names another host is not that session, and claims nothing.
    const other = fillInboxToolArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "hi", agent_host: "codex" } } }, "/work", "ses_OWN", hostSession).params!;
    expect(other._meta).toBeUndefined();
  });

  test("a command a Claude Code session runs sends as that session: the tool's author, its thread, and the reply wakes it", async () => {
    const box = sandbox();
    const project = gitProject(box);
    const registry = (await background(box)).registry!;
    const tag = { PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}` };

    const first = await shim(box, project, tag);
    const sent = (await first.callTool({ name: "send_message", arguments: { body: "Ship the worker today?", idempotency_key: "tag-1" } })).structuredContent as {
      message_id: string;
      thread_id: string;
    };
    expect(await author(registry.port, sent.thread_id, 0)).toEqual({ kind: "agent", host: "claude-code", session: CLAUDE_SESSION, name: "Claude Code" });

    // The mod's plannotator_inbox tool fills exactly these (apps/hook/hooks/mod/inbox.ts): its message joins the
    // same default thread with a byte-identical author, so the store reads both as one session.
    const viaTool = await fetch(`http://127.0.0.1:${registry.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { body: "From the tool.", project_path: project, agent_session: CLAUDE_SESSION, agent_host: INBOX_HOST, agent_name: INBOX_AGENT_NAME },
        },
      }),
    });
    expect(viaTool.status).toBe(200);
    expect(await viaTool.text()).toContain(sent.thread_id);

    // A second process with the same tag (another command of the same session) joins the same thread.
    const second = await shim(box, join(project, "worker"), tag);
    const again = (await second.callTool({ name: "send_message", arguments: { body: "And the migration?", idempotency_key: "tag-2" } })).structuredContent as {
      message_id: string;
      thread_id: string;
    };
    expect(again.thread_id).toBe(sent.thread_id);
    const authors = await Promise.all([0, 1, 2].map((i) => author(registry.port, sent.thread_id, i)));
    expect(authors[1]).toEqual(authors[0]);
    expect(authors[2]).toEqual(authors[0]);
    const mine = (await second.callTool({ name: "read_thread", arguments: {} })).structuredContent as { threads: { thread_id: string }[] };
    expect(mine.threads.map((t) => t.thread_id)).toEqual([sent.thread_id]);

    // The person replies; the session's wake (the bridge poll for that session id) gets it, another session's does not.
    const reply = await fetch(`http://127.0.0.1:${registry.port}/api/inbox/messages/${again.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "person-1", words: "Ship it." }),
    });
    expect(reply.status).toBe(200);
    const replyId = ((await reply.json()) as { reply: { id: string } }).reply.id;
    const poll = async (session: string) => {
      const response = await fetch(`http://127.0.0.1:${registry.port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${registry.token}` },
        body: JSON.stringify({ session, host: "claude-code", waitMs: 0 }),
      });
      expect(response.status).toBe(200);
      return parseInboxBridgeCommands(await response.text());
    };
    const commands = await poll(CLAUDE_SESSION);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "reply", id: replyId, reply_to: again.message_id, thread_id: sent.thread_id });
    expect(await poll("another-session")).toEqual([]);
  }, 90_000);

  test("the shim inside a Claude Code session whose bridge polls now is told the reply arrives by itself; without the poll, to wait_for_reply", async () => {
    const box = sandbox();
    const project = gitProject(box);
    const registry = (await background(box)).registry!;
    const client = await shim(box, project, { PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}` });
    const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content[0]!.text);

    // No bridge poll for that session yet: nothing will hand it the reply, so it must ask.
    const before = textOf(await client.callTool({ name: "send_message", arguments: { body: "Before the poll.", idempotency_key: "wake-0" } }));
    expect(before).toContain("reply won't arrive in this session by itself");

    // The mod's wake polls the bridge as that session (held open, as the mod's long poll is).
    const controller = new AbortController();
    const held = fetch(`http://127.0.0.1:${registry.port}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${registry.token}` },
      body: JSON.stringify({ session: CLAUDE_SESSION, host: "claude-code", waitMs: 20_000 }),
      signal: controller.signal,
    }).catch(() => undefined);
    cleanups.push(() => {
      controller.abort();
      return held.then(() => undefined);
    });
    await Bun.sleep(300);

    const after = textOf(await client.callTool({ name: "send_message", arguments: { body: "After the poll.", idempotency_key: "wake-1" } }));
    expect(after).toContain("The person's reply arrives in this session by itself");
    expect(after).not.toContain("wait_for_reply with this thread_id");
  }, 90_000);

  test("an explicit agent_session wins; a malformed tag is ignored (one fresh id per process); Pi's PI_SESSION_ID is that session", async () => {
    const box = sandbox();
    const project = gitProject(box);
    const registry = (await background(box)).registry!;

    const tagged = await shim(box, project, { PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}` });
    const explicit = (await tagged.callTool({ name: "send_message", arguments: { body: "Mine.", agent_session: "my-own-session", idempotency_key: "own-1" } }))
      .structuredContent as { thread_id: string };
    expect(await author(registry.port, explicit.thread_id, 0)).toEqual({ kind: "agent", host: null, session: "my-own-session", name: null });

    const malformed = await shim(box, project, { PLANNOTATOR_SESSION_TAG: "claude-code:../../etc" });
    const fresh = (await malformed.callTool({ name: "send_message", arguments: { body: "Who am I?", idempotency_key: "bad-1" } })).structuredContent as {
      thread_id: string;
    };
    const freshAuthor = await author(registry.port, fresh.thread_id, 0);
    expect(freshAuthor.session).toMatch(/^ses_[0-9A-Z]{26}$/);
    expect(freshAuthor.host).toBeNull();
    expect(fresh.thread_id).not.toBe(explicit.thread_id);

    const piSession = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
    const pi = await shim(box, project, { PI_SESSION_ID: piSession });
    const fromPi = (await pi.callTool({ name: "send_message", arguments: { body: "From Pi's bash.", idempotency_key: "pi-1" } })).structuredContent as { thread_id: string };
    expect(await author(registry.port, fromPi.thread_id, 0)).toEqual({ kind: "agent", host: "pi", session: piSession, name: "Pi" });

    // Codex: its MCP client (codex-mcp-client) names the thread on every call; the shim sends as that thread.
    const codex = new Client({ name: "codex-mcp-client", version: "0.160.0" });
    await codex.connect(new StdioClientTransport({ command: process.execPath, args: ["run", entry, "inbox", "mcp"], cwd: project, env: box.env, stderr: "pipe" }));
    cleanups.push(() => codex.close());
    const fromCodex = (
      await codex.callTool({ name: "send_message", arguments: { body: "From a Codex thread.", idempotency_key: "codex-1" }, _meta: { threadId: CODEX_THREAD } })
    ).structuredContent as { thread_id: string };
    expect(await author(registry.port, fromCodex.thread_id, 0)).toEqual({ kind: "agent", host: "codex", session: CODEX_THREAD, name: "Codex" });
  }, 90_000);
});

describe("plannotator inbox mcp inside a Qwen Code session", () => {
  const CLAUDE_SESSION = "0f3c2a51-7d4e-4b8a-9e21-5c6d7e8f9a0b";
  const QWEN_A = "8e016be8-5b48-4c13-ad22-1f5326ae64ac";
  const QWEN_B = "3c9d1f20-7a4b-4e6c-9d8e-0a1b2c3d4e5f";
  const QWEN_STALE = "11111111-2222-4333-8444-555555555555";
  const claude = { host: "claude-code", session: CLAUDE_SESSION, name: "Claude Code" };
  const qwen = (session: string) => ({ host: "qwen", session, name: "Qwen Code" });
  /** The name a Qwen Code session's MCP client gives (`qwen-cli-mcp-client-<server name>`, Qwen 0.26). */
  const QWEN_CLIENT = "qwen-cli-mcp-client-plannotator-inbox";

  /** A Qwen home with the registry record Qwen writes for a session (cross-session protocol, schema 1). */
  function qwenHomeWith(pid: number, sessionId: string, extra: Record<string, unknown> = {}): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-qwen-home-")));
    roots.push(root);
    writeRecord(root, pid, sessionId, extra);
    return root;
  }
  function writeRecord(home: string, pid: number, sessionId: string, extra: Record<string, unknown> = {}, name = `${pid}.json`): void {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", name), JSON.stringify({ schemaVersion: 1, pid, sessionId, cwd: "/work", kind: "tui", startedAt: 1, ...extra }));
  }

  test("Qwen's session variable is the session for a command Qwen's shell runs; another host's variable comes first; a malformed one is ignored", () => {
    expect(inboxHostSessionFromEnv({ QWEN_CODE_SESSION_ID: QWEN_A })).toEqual(qwen(QWEN_A));
    expect(inboxHostSessionFromEnv({ QWEN_CODE_SESSION_ID: QWEN_A, PLANNOTATOR_SESSION_TAG: `claude-code:${CLAUDE_SESSION}` })).toEqual(claude);
    for (const bad of ["", "abc", "../../etc", `${QWEN_A} `, "--yolo"]) expect(inboxHostSessionFromEnv({ QWEN_CODE_SESSION_ID: bad })).toBeNull();
  });

  test("a call from Qwen is the session Qwen's registry has for the shim's parent now: /clear and /resume move it; without a record, the variable", () => {
    const pid = 41337;
    const home = qwenHomeWith(pid, QWEN_A);
    const context = inboxQwenShimContext({ QWEN_HOME: home, QWEN_CODE_SESSION_ID: QWEN_STALE }, "/nowhere", "/work", pid);
    expect(context).toEqual({ home, parentPid: pid, envSession: QWEN_STALE });
    const env = inboxHostSessionFromEnv({ QWEN_CODE_SESSION_ID: QWEN_STALE });
    expect(inboxCallHostSession(env, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_A));
    // /clear: Qwen patches the record under the same pid; the next call reads the new id.
    writeRecord(home, pid, QWEN_B);
    expect(inboxCallHostSession(env, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_B));
    // A record that is not usable is never guessed from: the variable Qwen started the shim with.
    for (const bad of [{ pid: pid + 1 }, { sessionId: "../x" }, { schemaVersion: 2 }]) {
      writeRecord(home, pid, QWEN_B, bad);
      expect(inboxCallHostSession(env, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_STALE));
    }
    // A `kind` of the wrong shape is only that field: Qwen reads the record as a terminal session's, and so does the shim.
    writeRecord(home, pid, QWEN_B, { kind: "NOT A KIND" });
    expect(inboxCallHostSession(env, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_B));
    rmSync(join(home, "sessions"), { recursive: true });
    expect(inboxCallHostSession(env, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_STALE));
    // A process hosting several sessions (`<pid>-<8 hex>.json`): one record is that session; two, only the call can say.
    writeRecord(home, pid, QWEN_A, {}, `${pid}-0a1b2c3d.json`);
    expect(inboxCallHostSession(env, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_A));
    writeRecord(home, pid, QWEN_B, {}, `${pid}-ffffffff.json`);
    expect(inboxCallHostSession(env, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_STALE));
    // A daemon-run session names itself on the call: that wins.
    const meta = { "qwen-code/invocation": { version: 1, sessionId: QWEN_B, promptId: "p1" } };
    expect(inboxCallHostSession(env, context, meta, QWEN_CLIENT)).toEqual(qwen(QWEN_B));
  });

  test("Qwen's client with no registry record (cross-session messaging off, bare mode, `qwen -p`): the variable Qwen started the shim with", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-qwen-home-")));
    roots.push(home);
    const context = inboxQwenShimContext({ QWEN_HOME: home, QWEN_CODE_SESSION_ID: QWEN_A }, "/nowhere", "/work", 61234);
    const env = inboxHostSessionFromEnv({ QWEN_CODE_SESSION_ID: QWEN_A });
    expect(inboxCallHostSession(env, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_A));
    // Qwen's older one-shot client name counts too; another client whose name only starts alike does not.
    expect(inboxCallHostSession(env, context, undefined, "qwen-code-mcp-client")).toEqual(qwen(QWEN_A));
    expect(inboxCallHostSession(env, context, undefined, "qwen-cli-mcp-client-")).toBeNull();
    expect(inboxCallHostSession(claude, context, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_A));
  });

  test("Qwen's client wins over another host's variable; the variable alone does not, nor when another client named itself", () => {
    const pid = 51234;
    const home = qwenHomeWith(pid, QWEN_A);
    const withRecord = inboxQwenShimContext({ QWEN_HOME: home, QWEN_CODE_SESSION_ID: QWEN_STALE }, "/nowhere", "/work", pid);
    const noRecord = inboxQwenShimContext({ QWEN_HOME: home, QWEN_CODE_SESSION_ID: QWEN_STALE }, "/nowhere", "/work", pid + 7);
    expect(inboxCallHostSession(claude, withRecord, undefined, QWEN_CLIENT)).toEqual(qwen(QWEN_A));
    // The parent is a Qwen process (its record is there), whatever the client called itself.
    expect(inboxCallHostSession(claude, withRecord, undefined, "some-client")).toEqual(qwen(QWEN_A));
    // A variable inherited by another client's process (no record for the parent): not Qwen's.
    expect(inboxCallHostSession(qwen(QWEN_STALE), noRecord, undefined, "cursor-vscode")).toBeNull();
    expect(inboxCallHostSession(claude, noRecord, undefined, "cursor-vscode")).toEqual(claude);
    // No client name yet and no record: the environment's own order (another host first).
    expect(inboxCallHostSession(claude, noRecord, undefined, null)).toEqual(claude);
    expect(inboxCallHostSession(qwen(QWEN_STALE), noRecord, undefined, null)).toEqual(qwen(QWEN_STALE));
    // Not in Qwen at all: unchanged.
    const none = inboxQwenShimContext({}, "/nowhere", "/work", pid + 7);
    expect(inboxCallHostSession(claude, none, undefined, "codex-mcp-client")).toEqual(claude);
    expect(inboxCallHostSession(null, none, undefined, null)).toBeNull();
  });

  test("the shim Qwen starts sends as Qwen's current session: the author follows a /clear between two calls", async () => {
    const box = sandbox();
    const project = gitProject(box);
    const registry = (await background(box)).registry!;
    // The shim's parent is this test process (the transport spawns it directly), so Qwen's record is keyed by our pid.
    const home = qwenHomeWith(process.pid, QWEN_A);
    const client = new Client({ name: QWEN_CLIENT, version: "0.26.2" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["run", entry, "inbox", "mcp"],
        cwd: project,
        env: { ...box.env, QWEN_HOME: home, QWEN_CODE_SESSION_ID: QWEN_STALE },
        stderr: "pipe",
      }),
    );
    cleanups.push(() => client.close());
    const author = async (threadId: string, index: number) => {
      const { thread } = await (await fetch(`http://127.0.0.1:${registry.port}/api/inbox/threads/${threadId}`)).json();
      return thread.messages[index].author as { kind: string; host: string | null; session: string | null; name: string | null };
    };
    const first = (await client.callTool({ name: "send_message", arguments: { body: "Before /clear.", idempotency_key: "qwen-1" } })).structuredContent as { thread_id: string };
    expect(await author(first.thread_id, 0)).toEqual({ kind: "agent", host: "qwen", session: QWEN_A, name: "Qwen Code" });
    writeRecord(home, process.pid, QWEN_B);
    const second = (await client.callTool({ name: "send_message", arguments: { body: "After /clear.", idempotency_key: "qwen-2" } })).structuredContent as { thread_id: string };
    expect(await author(second.thread_id, 0)).toEqual({ kind: "agent", host: "qwen", session: QWEN_B, name: "Qwen Code" });
    // A new session starts its own thread.
    expect(second.thread_id).not.toBe(first.thread_id);
  }, 90_000);
});

describe("plannotator inbox mcp: large messages", () => {
  test("a send_message past 4 MiB through the stdio shim lands whole, quickly", async () => {
    const box = sandbox();
    const project = gitProject(box);
    const client = new Client({ name: "shim-large", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", entry, "inbox", "mcp"],
      cwd: project,
      env: box.env,
      stderr: "pipe",
    });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const registry = readInboxRegistry(box.dataDir)!;
    track(box);

    // Past 4 MiB (the MCP SDK's default request bound), with multi-byte text so
    // stdin chunks split characters.
    const line = "The worker drains the queue — résumé ✓ 测试\n";
    const body = line.repeat(Math.ceil((4 * 1024 * 1024) / Buffer.byteLength(line)) + 1);
    expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024);
    const sent = await client.callTool({ name: "send_message", arguments: { body, idempotency_key: "large-1" } }, { timeout: 30_000 });
    expect(sent.isError).toBeFalsy();
    const { thread_id } = sent.structuredContent as { thread_id: string };
    const { thread } = await (await fetch(`http://127.0.0.1:${registry.port}/api/inbox/threads/${thread_id}`)).json();
    expect(thread.messages[0].body).toBe(body);
  }, 90_000);

  test("a message over the Inbox's request bound is refused at once, with an error naming the bound", async () => {
    const box = sandbox();
    const project = gitProject(box);
    const client = new Client({ name: "shim-too-large", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", entry, "inbox", "mcp"],
      cwd: project,
      env: box.env,
      stderr: "pipe",
    });
    await client.connect(transport);
    cleanups.push(() => client.close());
    track(box);

    const started = Date.now();
    const refused = await client
      .callTool({ name: "send_message", arguments: { body: "x".repeat(INBOX_MAX_REQUEST_BYTES), idempotency_key: "huge-1" } }, { timeout: 30_000 })
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(refused?.message).toContain(`at most ${INBOX_MAX_REQUEST_BYTES} bytes`);
    expect(Date.now() - started).toBeLessThan(20_000);
    // The shim is still serving.
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  }, 90_000);

  test("an HTTP refusal from the Inbox answers the request that caused it, never with id null", async () => {
    // The MCP SDK's own refusals (413, 400, 406) carry `id: null`; Bun's 413 has no body at all.
    const answers = [
      () => Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "Payload Too Large: Request body must not exceed 4194304 bytes" }, id: null }, { status: 413 }),
      () => new Response(null, { status: 413 }),
    ];
    for (const answer of answers) {
      const fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
      cleanups.push(() => fake.stop(true));
      const lines: string[] = [];
      const request = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "send_message", arguments: { body: "hi" } } });
      await runInboxMcpShim({
        dataDir: sandbox().dataDir,
        cwd: tmpdir(),
        ensureRunning: async () => ({ v: 1, pid: process.pid, port: fake.port, url: "", version: "test", token: "t", serverSession: "s", startedAt: "" }) as never,
        input: new Blob([`${request}\n`]).stream(),
        write: (line) => lines.push(line),
      });
      expect(lines).toHaveLength(1);
      const reply = JSON.parse(lines[0]!) as { id: unknown; error?: { message: string } };
      expect(reply.id).toBe(7);
      expect(reply.error?.message).toMatch(/Payload Too Large|at most \d+ bytes/);
    }
  });
});

describe("plannotator inbox (a person)", () => {
  test("opens the browser on the Inbox it starts, and on the one already running", async () => {
    const box = sandbox();
    const proc = Bun.spawn([process.execPath, "run", entry, "inbox"], { cwd: box.root, env: box.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    cleanups.push(() => proc.kill("SIGKILL"));
    const deadline = Date.now() + 20_000;
    while (!existsSync(box.browserMarker) && Date.now() < deadline) await Bun.sleep(50);
    const registry = readInboxRegistry(box.dataDir)!;
    expect(registry.pid).toBe(proc.pid);
    expect(readFileSync(box.browserMarker, "utf8").trim()).toBe(registry.url);

    rmSync(box.browserMarker);
    const again = await cli(box, ["inbox"]);
    expect(again.code).toBe(0);
    expect(readFileSync(box.browserMarker, "utf8").trim()).toBe(registry.url);
    expect(readInboxRegistry(box.dataDir)!.pid).toBe(proc.pid);

    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
  }, 60_000);
});

/** The URL the fake browser got: --open never waits for the browser, so it may land a moment after the command exits. */
async function browserOpened(box: Sandbox): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(box.browserMarker) && Date.now() < deadline) await Bun.sleep(25);
  return existsSync(box.browserMarker) ? readFileSync(box.browserMarker, "utf8").trim() : "";
}

describe("plannotator inbox --open (the /plannotator-inbox commands)", () => {
  test("starts a stopped Inbox detached, opens the browser on it, prints the URL and returns", async () => {
    const box = sandbox();
    const opened = await cli(box, ["inbox", "--open"]);
    track(box);
    expect(opened.code).toBe(0);
    const registry = readInboxRegistry(box.dataDir)!;
    expect(opened.stdout).toBe(`${registry.url}\n`);
    // Detached: the command exited and the Inbox it started lives on.
    expect(registry.pid).not.toBe(opened.pid);
    expect(isPidAlive(registry.pid)).toBe(true);
    expect(await browserOpened(box)).toBe(registry.url);

    // Running already: opens the same Inbox again and starts nothing.
    rmSync(box.browserMarker);
    const again = await cli(box, ["inbox", "--open"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe(`${registry.url}\n`);
    expect(await browserOpened(box)).toBe(registry.url);
    expect(readInboxRegistry(box.dataDir)!.pid).toBe(registry.pid);
  }, 60_000);

  // A browser the opener starts can keep the opener's output open for as long
  // as it runs (xdg-open starting a fresh Firefox): --open must not wait for it.
  test("returns at once when the browser it starts keeps running", async () => {
    const box = sandbox();
    await background(box);
    const registry = readInboxRegistry(box.dataDir)!;
    const lingering = join(box.root, "lingering-browser.sh");
    writeFileSync(lingering, `#!/bin/sh\necho "$1" >> '${box.browserMarker}'\nsleep 5 &\nexit 0\n`);
    chmodSync(lingering, 0o755);
    box.env.PLANNOTATOR_BROWSER = lingering;
    box.env.BROWSER = lingering;
    const startedAt = Date.now();
    const opened = await cli(box, ["inbox", "--open"]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(opened.code).toBe(0);
    expect(opened.stdout).toBe(`${registry.url}\n`);
    expect(await browserOpened(box)).toBe(registry.url);
  }, 60_000);

  test("over SSH with no browser set, runs no opener on the remote host and says how to reach the Inbox", async () => {
    const box = sandbox();
    await background(box);
    const registry = readInboxRegistry(box.dataDir)!;
    // Stand-ins for the system openers, first on PATH: neither may run.
    const bin = join(box.root, "openers");
    mkdirSync(bin);
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "$1" >> '${box.browserMarker}'\n`);
      chmodSync(join(bin, name), 0o755);
    }
    box.env.PATH = `${bin}:${box.env.PATH}`;
    delete box.env.PLANNOTATOR_BROWSER;
    delete box.env.BROWSER;
    box.env.PLANNOTATOR_REMOTE = "1";
    const opened = await cli(box, ["inbox", "--open"]);
    expect(opened.code).toBe(0);
    expect(opened.stdout).toBe(`${registry.url}\n`);
    expect(opened.stderr).toContain(`ssh -L ${registry.port}:127.0.0.1:${registry.port}`);
    expect(opened.stderr).toContain("--tailscale");
    expect(existsSync(box.browserMarker)).toBe(false);
  }, 60_000);

  test("refuses --background and --no-open beside it, starting nothing", async () => {
    const box = sandbox();
    for (const other of ["--background", "--no-open"]) {
      const result = await cli(box, ["inbox", "--open", other]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(other);
    }
    expect(readInboxRegistry(box.dataDir)).toBeNull();
    expect(existsSync(box.browserMarker)).toBe(false);
  }, 30_000);
});

describe("uninstall --purge and the Inbox", () => {
  test("--dry-run lists the inbox data and the running Inbox it would stop", async () => {
    const box = sandbox();
    const registry = (await background(box)).registry!;
    const result = await cli(box, ["uninstall", "--purge", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(join(box.dataDir, "inbox"));
    expect(result.stdout).toContain(`Stop the running Plannotator Inbox (pid ${registry.pid})`);
    expect(isPidAlive(registry.pid)).toBe(true);
  }, 60_000);

  test("purge stops the running Inbox first, then removes inbox/", async () => {
    const box = sandbox();
    const registry = (await background(box)).registry!;
    const result = await runPlannotatorUninstall(
      { purge: true, dryRun: false },
      {
        platform: process.platform,
        homeDir: box.home,
        tempDir: tmpdir(),
        dataDir: box.dataDir,
        execPath: join(box.root, "not-the-real-plannotator"),
        env: {},
        which: () => null,
        runCommand: async () => ({ exitCode: 0, timedOut: false }),
        scheduleWindowsSelfDelete: async () => true,
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.removed).toContain(`Stopped the running Plannotator Inbox (pid ${registry.pid})`);
    await waitDead(registry.pid);
    expect(isPidAlive(registry.pid)).toBe(false);
    expect(existsSync(join(box.dataDir, "inbox"))).toBe(false);
  }, 60_000);

  test.skipIf(process.platform === "win32")("purge of a copied data dir removes the copy and leaves the original's Inbox and both its tailnet mappings up", async () => {
    const original = sandbox();
    const registry = (await background(original)).registry!;
    // The two mappings a record can name: "Reach from my tailnet" (8443 → the door) and "Over your tailnet" (the window's port → its proxy).
    const DOOR = 47_001;
    const WINDOW_HTTPS = 10_443;
    const PROXY = 47_002;
    const mappings = {
      tailnet: { https_port: 8443, door_port: DOOR },
      tailscale: { url: `https://box.example.ts.net:${WINDOW_HTTPS}/`, error: null, https_port: WINDOW_HTTPS, proxy_port: PROXY },
    };

    // A fake `tailscale` first on PATH (never the real one): it logs every call and reports both mappings as live.
    const bin = join(original.root, "fake-bin");
    mkdirSync(bin, { recursive: true });
    const log = join(bin, "tailscale.log");
    const statusFile = join(bin, "serve-status.json");
    writeFileSync(
      statusFile,
      JSON.stringify({
        TCP: { "8443": { HTTPS: true }, [String(WINDOW_HTTPS)]: { HTTPS: true } },
        Web: {
          "box.example.ts.net:8443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${DOOR}` } } },
          [`box.example.ts.net:${WINDOW_HTTPS}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${PROXY}` } } },
        },
      }),
    );
    writeFileSync(join(bin, "tailscale"), `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1 $2" = "serve status" ]; then cat '${statusFile}'; fi\nexit 0\n`);
    chmodSync(join(bin, "tailscale"), 0o755);
    const offs = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((call) => call.includes("off")) : []);
    const purge = (box: Sandbox) =>
      runPlannotatorUninstall(
        { purge: true, dryRun: false },
        {
          platform: process.platform,
          homeDir: box.home,
          tempDir: tmpdir(),
          dataDir: box.dataDir,
          execPath: join(box.root, "not-the-real-plannotator"),
          env: {},
          which: () => null,
          runCommand: async () => ({ exitCode: 0, timedOut: false }),
          scheduleWindowsSelfDelete: async () => true,
        },
      );

    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? "/usr/bin:/bin"}`;
    try {
      expect(Bun.which("tailscale", { PATH: process.env.PATH })).toBe(join(bin, "tailscale"));

      const copy = sandbox();
      mkdirSync(join(copy.dataDir, "inbox"), { recursive: true });
      const record = JSON.parse(readFileSync(join(original.dataDir, "inbox", "inbox.json"), "utf8"));
      writeFileSync(join(copy.dataDir, "inbox", "inbox.json"), JSON.stringify({ ...record, ...mappings }));
      const result = await purge(copy);
      expect(result.errors).toEqual([]);
      expect(existsSync(join(copy.dataDir, "inbox"))).toBe(false);
      // Neither mapping is taken down: both are the running original's.
      expect(offs()).toEqual([]);
      await Bun.sleep(300);
      expect(isPidAlive(registry.pid)).toBe(true);
      expect((await inboxStatus(original.dataDir)).state).toBe("running");

      // The same record left by an Inbox that has exited (a crash): purge takes both mappings down,
      // so the fake answers what the take-downs read and the check above is not empty by accident.
      const crashed = sandbox();
      const gone = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      await gone.exited;
      writeInboxRegistry(crashed.dataDir, { ...readInboxRegistry(original.dataDir)!, pid: gone.pid, port: 1, ...mappings });
      expect((await purge(crashed)).errors).toEqual([]);
      expect(offs().sort()).toEqual([`serve --https=${WINDOW_HTTPS} off`, "serve --https=8443 off"].sort());
    } finally {
      process.env.PATH = path;
    }
  }, 60_000);
});
