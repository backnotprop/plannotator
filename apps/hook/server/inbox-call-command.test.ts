/**
 * `plannotator inbox call …` (approval "inbox-scripting-command") as real
 * processes against a real sandbox Inbox: the Inbox runs in this test process
 * so its store's clock can be set back (`storeNow`, what Tidy's ages need), and
 * every call is the CLI, finding it through the data dir's `inbox.json`.
 *
 * What can regress: a script writing as another agent, a script's writes not
 * counting for the Tidy that asked for them, a double post on a rerun, a
 * failure a script reads as a result, and a result cut short in a pipe. Every
 * process gets a temp HOME and data dir, and a PATH of agent stubs
 * (tests/helpers/agent-cli-guard.ts): no real agent CLI ever runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxMessage, InboxThread, InboxTidyPlan, InboxTidyRun } from "@plannotator/core/inbox-types";
import { INBOX_TIDY_INSTRUCTION } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { attachedImagesNotInBodyText } from "@plannotator/shared/inbox/attached-images";
import { questionOpenersWithTextText } from "@plannotator/shared/inbox/question-openers";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import { codexRolloutDayFolders } from "@plannotator/server/inbox-codex-wake";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { createFakeAgents, type FakeAgents } from "../../../tests/helpers/fake-agents";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { INBOX_CALL_ACTIONS, INBOX_CALL_USAGE } from "./cli";
import { type CallCommandDeps, inboxCallerOf, parseCallCommand, runInboxCallCommand } from "./inbox-call-command";

const entry = resolve(import.meta.dir, "index.ts");
const HOUR = 60 * 60_000;
const CODEX_THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const QWEN_SESSION = "11111111-2222-4333-8444-555555555555";
const T3_THREAD = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

let stubs: string[] = [];
const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const fakes: FakeAgents[] = [];
const detached: { entry: InboxEntry; root: string }[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; these tests never read the pages.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  // Throws when a fake CLI outlived the test.
  for (const fake of fakes.splice(0)) fake.remove();
  await stopProvenInboxes(detached.splice(0), { signal: "SIGKILL" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// After the cleanup hooks: a stub's failure stops the hooks registered behind it.
const agents = stubbedAgentClis();

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-call-")));
  roots.push(root);
  const dataDir = join(root, "home", ".plannotator");
  const project = join(root, "code", "billing");
  mkdirSync(project, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  // The Board and thread steps are things the person turns on: on here, so every action the command takes is served.
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxBoard: true, inboxSteps: true }));
  const env: Record<string, string> = {
    ...agents.env,
    HOME: join(root, "home"),
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { root, dataDir, project, env };
}
type Box = ReturnType<typeof sandbox>;

/** A sandbox with an Inbox running; what a test writes while `clock.behind` is set reads as that much older. */
async function world() {
  const box = sandbox();
  const clock = { behind: 0 };
  // This Inbox runs in the test's process: named here, so a run the preload missed still has no agents, on PATH or in /Applications.
  const agentsHome = join(box.dataDir, "agents-home");
  const server = await startInboxServer({
    dataDir: box.dataDir,
    binaryPath: null,
    board: true,
    steps: true,
    storeNow: () => new Date(Date.now() - clock.behind),
    agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: agentsHome, env: { HOME: agentsHome, PATH: "" } }),
    codexWake: { extraClis: [] },
  });
  servers.push(server);
  const client = new Client({ name: "inbox-call-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { ...box, clock, server, client };
}
type World = Awaited<ReturnType<typeof world>>;

async function cli(box: Box, args: string[], options: { env?: Record<string, string>; stdin?: string | Uint8Array; cwd?: string } = {}) {
  const proc = Bun.spawn([process.execPath, "run", entry, "inbox", "call", ...args], {
    cwd: options.cwd ?? box.project,
    env: { ...box.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

const tool = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
};
const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const post = (server: InboxServer, path: string, body: Record<string, unknown>) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
const bridge = (server: InboxServer, path: string, body: unknown) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });
const threadOf = async (server: InboxServer, id: string) => ((await (await fetch(`${base(server)}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
const planOf = async (server: InboxServer, query = "") => (await (await fetch(`${base(server)}/api/inbox/tidy${query}`)).json()) as InboxTidyPlan;
const runOf = async (server: InboxServer) => (await planOf(server)).run!;

/** A connection's poll for `session`: live for the next 30 s; the commands it hands out. */
async function poll(server: InboxServer, session: string, project: string, host = "claude-code") {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host, project_path: project, waitMs: 0, busy: false, idle_since: Date.now() - HOUR });
  return parseInboxBridgeCommands(await response.text());
}
/** The session's Tidy wake, handed out and delivered. */
async function wakeOf(server: InboxServer, session: string, project: string, host = "claude-code") {
  const [command] = await poll(server, session, project, host);
  await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session, host, type: "delivered", id: command!.id });
  return command!;
}
/** The exact value the wake gives the session, as an agent reads it. */
const sessionValueIn = (body: string) => /`--session ([^`]+)`/.exec(body)?.[1];

const block = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
const action = (order: string) => [":::action", order, "", "Why it matters.", ":::"].join("\n");

describe("what a script gets", () => {
  test("a refused call leaves stdout empty and says the tool's code on stderr; a good one prints one JSON value", async () => {
    const box = await world();
    const sent = await cli(box, ["send_message", '{"body":"Starting the ledger lane.","subject":"Ledger","thread":"Ledger"}'], { env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses-a" } });
    expect(sent.code).toBe(0);
    expect(sent.stderr).toBe("");
    const message = JSON.parse(sent.stdout);
    expect(message.message_id).toBe((await threadOf(box.server, message.thread_id)).messages[0]!.id);

    const refused = await cli(box, ["read_thread", '{"thread_id":"msg_nope"}']);
    expect(refused).toMatchObject({ code: 1, stdout: "" });
    expect(refused.stderr).toStartWith("thread_not_found: ");
    // A field the tool's schema does not take is refused by the MCP layer, in plain words.
    const unknown = await cli(box, ["resolve_message", '{"message_id":"x","nope":1}']);
    expect(unknown).toMatchObject({ code: 1, stdout: "" });
    expect(unknown.stderr).toStartWith("invalid_arguments: ");
  });

  test("snooze_thread from a script: it snoozes, says until when as JSON, and until: null ends it", async () => {
    const box = await world();
    const sent = JSON.parse((await cli(box, ["send_message", '{"body":"News.","subject":"Ledger"}'], { env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses_call" } })).stdout);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const snoozed = await cli(box, ["snooze_thread", JSON.stringify({ thread_id: sent.thread_id, until })]);
    expect(snoozed.code).toBe(0);
    expect(JSON.parse(snoozed.stdout).snoozed.until).toBe(until);
    expect(box.server.store.snoozes().map((s) => s.thread_id)).toEqual([sent.thread_id]);
    const ended = await cli(box, ["snooze_thread", JSON.stringify({ thread_id: sent.thread_id, until: null })]);
    expect(JSON.parse(ended.stdout)).toEqual({ thread_id: sent.thread_id, snoozed: null, ended: `Thread ${sent.thread_id}: snooze ended.` });
    expect(box.server.store.snoozes()).toEqual([]);
  });

  // Review of #2567, finding 2: with thread steps off an agent reads no word of them, so the error's list leaves out
  // `steps` (as the usage does); the action itself still goes through (the Inbox answers steps_off while off).
  test("an unknown action's list never names steps; steps itself is an action", () => {
    const unknown = parseCallCommand(["blorp"]);
    expect(unknown).toMatchObject({ ok: false, code: "unknown_action" });
    expect((unknown as { error: string }).error).toContain("send_message");
    expect((unknown as { error: string }).error).not.toMatch(/\bsteps\b/);
    expect(parseCallCommand(["steps", "{}"])).toMatchObject({ ok: true, action: "steps" });
  });

  test("bad JSON, a non-object, an unknown action, wait_for_reply and a named identity are usage errors, sent nowhere", async () => {
    const box = sandbox();
    for (const [args, code] of [
      [["read_thread", "{nope"], "invalid_json"],
      [["read_thread", "[1]"], "invalid_json"],
      [["read_thread", "-"], "invalid_json"],
      [["blorp"], "unknown_action"],
      [["wait_for_reply", "{}"], "unknown_action"],
      [["read_thread", '{"agent_session":"someone-else"}'], "invalid_arguments"],
      [["send_message", '{"body":"x","agent_host":"codex"}'], "invalid_arguments"],
    ] as const) {
      const result = await cli(box, [...args], { stdin: "" });
      expect(result).toMatchObject({ code: 2, stdout: "" });
      expect(result.stderr).toStartWith(`${code}: `);
    }
    // None of these reached for an Inbox, so none started one.
    expect(existsSync(join(box.dataDir, "inbox", "inbox.json"))).toBe(false);
  });

  test("an Inbox started without the test sandbox still reaches only a stub", async () => {
    const box = sandbox();
    const { PLANNOTATOR_TEST_SANDBOX: _sandbox, ...env } = box.env;
    const sent = await cli({ ...box, env }, ["send_message", '{"body":"From a Codex thread."}'], { env: { CODEX_THREAD_ID: CODEX_THREAD } });
    const inbox = inboxEntryOf(box.dataDir);
    if (inbox) detached.push({ entry: inbox, root: box.root });
    expect(sent.code).toBe(0);
    expect(agents.takeCalls()).toEqual(["codex --version"]);
  }, 30_000);

  test("a stopped Inbox starts in the background with no browser, as `inbox mcp` does", async () => {
    const box = sandbox();
    const marker = join(box.root, "browser-opened");
    const browser = join(box.root, "fake-browser.sh");
    writeFileSync(browser, `#!/bin/sh\necho "$1" >> '${marker}'\n`);
    chmodSync(browser, 0o755);
    const first = await cli(box, ["read_thread", "{}"], { env: { PLANNOTATOR_BROWSER: browser } });
    const inbox = inboxEntryOf(box.dataDir);
    if (inbox) detached.push({ entry: inbox, root: box.root });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ threads: [], total: 0 });
    expect(inbox).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  test("an Inbox that cannot start or answer is a clear failure with nothing on stdout", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CallCommandDeps = { cwd: "/", env: {}, ensureRunning: () => Promise.reject(new Error("the start timed out")), out: (text) => void out.push(text), err: (text) => void err.push(text) };
    expect(await runInboxCallCommand(["read_thread", "{}"], deps)).toBe(1);
    expect(err.join("")).toStartWith("inbox_not_running: ");
    const entry = { port: 9 } as Awaited<ReturnType<CallCommandDeps["ensureRunning"]>>;
    err.length = 0;
    expect(await runInboxCallCommand(["read_thread", "{}"], { ...deps, ensureRunning: async () => entry, timeoutMs: 1000 })).toBe(1);
    expect(err.join("")).toStartWith("inbox_no_answer: ");
    expect(out).toEqual([]);
  });

  test("- reads the JSON from stdin, a PowerShell BOM and all, and a long result reaches a pipe whole", async () => {
    const box = await world();
    const body = "é".repeat(2_000_000);
    const sent = await cli(box, ["send_message", "-"], {
      env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses-a" },
      stdin: `﻿${JSON.stringify({ body, subject: "Long", thread: "Long" })}`,
    });
    expect(sent.code).toBe(0);
    const { thread_id } = JSON.parse(sent.stdout);
    const read = await cli(box, ["read_thread", JSON.stringify({ thread_id, format: "full" })]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout).thread.messages[0].body).toBe(body);
  });

  test("a relative project_path and relative attachments mean where the script runs, even in a reply", async () => {
    const box = await world();
    const sub = join(box.project, "reports");
    mkdirSync(sub);
    writeFileSync(join(sub, "notes.md"), "# Notes\n");
    const first = await tool(box.client, "send_message", { body: "Starting.", subject: "Reports", thread: "Reports", project_path: box.project, agent_session: "ses-a", agent_host: "claude-code" });
    const reply = await cli(box, ["send_message", JSON.stringify({ reply_to: first.message_id, body: "Here.", attachments: ["notes.md"] })], { cwd: sub, env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses-a" } });
    expect(reply.code).toBe(0);
    expect(JSON.parse(reply.stdout).attachments[0].name).toBe("notes.md");
    const listed = await cli(box, ["read_thread", JSON.stringify({ project_path: ".." })], { cwd: sub });
    expect(JSON.parse(listed.stdout).project.root).toBe(box.project);
  });

  test("a picture attached but not shown in the body: sent, stdout still one JSON value, the advice on stderr", async () => {
    const box = await world();
    writeFileSync(join(box.project, "look.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const sent = await cli(box, ["send_message", JSON.stringify({ body: "The new look.", thread: "Look", attachments: ["look.png"] })]);
    expect(sent.code).toBe(0);
    expect(JSON.parse(sent.stdout).attached_images_not_in_body).toEqual(["look.png"]);
    expect(sent.stderr).toBe(`${attachedImagesNotInBodyText(1).trim()}\n`);
    const shown = await cli(box, ["send_message", JSON.stringify({ body: "The new look: ![look](look.png)", thread: "Look", attachments: ["look.png"] })]);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toBe("");
  });

  test("a question opener with text after its name: sent, stdout still one JSON value, the warning on stderr", async () => {
    const box = await world();
    const sent = await cli(box, ["send_message", JSON.stringify({ body: "Pick:\n:::question {#bar}\nWhich bar?\n- [ ] Top\n:::", thread: "Bars" })]);
    expect(sent.code).toBe(0);
    expect(JSON.parse(sent.stdout).question_openers_with_text).toEqual([{ line: 2, directive: ":::question" }]);
    expect(sent.stderr).toBe(`${questionOpenersWithTextText([{ line: 2, directive: ":::question" }]).trim()}\n`);
  });

  test("inside an agent Ask AI started the Inbox is off: nothing is started or sent", async () => {
    const box = sandbox();
    const result = await cli(box, ["read_thread", "{}"], { env: { PLANNOTATOR_ASK_AI_CHILD: "1" } });
    expect(result).toMatchObject({ code: 1, stdout: "" });
    expect(result.stderr).toStartWith("inbox_off: ");
    expect(existsSync(join(box.dataDir, "inbox", "inbox.json"))).toBe(false);
  });

  test("every action the command takes is one a real Inbox serves", async () => {
    const box = await world();
    const { tools } = await box.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining([...INBOX_CALL_ACTIONS]));
  });
});

describe("who is calling", () => {
  const HOSTS: { name: string; host: string; session: string; agentName: string; env: Record<string, string>; flag?: string }[] = [
    { name: "Claude Code", host: "claude-code", session: "ses-claude", agentName: "Claude Code", env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses-claude", CLAUDECODE: "1" } },
    { name: "Pi", host: "pi", session: "ses-pi", agentName: "Pi", env: { PI_SESSION_ID: "ses-pi" } },
    { name: "Codex", host: "codex", session: CODEX_THREAD, agentName: "Codex", env: { CODEX_THREAD_ID: CODEX_THREAD } },
    { name: "Qwen Code", host: "qwen", session: QWEN_SESSION, agentName: "Qwen Code", env: { QWEN_CODE_SESSION_ID: QWEN_SESSION, QWEN_CODE: "1" } },
    // DeepSeek Harness sets DSH_SESSION_ID (and DSH_SHELL) in every model shell.
    { name: "DeepSeek Harness", host: "dsh", session: "session-0b9c8e4e", agentName: "DeepSeek Harness", env: { DSH_SHELL: "1", DSH_SESSION_ID: "session-0b9c8e4e" } },
    // T3 Code runs Claude through the Agent SDK (the mod is off there): the thread, beside Claude's own marker.
    { name: "T3 Code", host: "t3", session: T3_THREAD, agentName: "T3 Code", env: { T3CODE_THREAD_ID: T3_THREAD, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" } },
    // OpenCode names no session in its shell: only the value its Tidy gives it says who it is.
    { name: "OpenCode", host: "opencode", session: "ses_opencode1", agentName: "OpenCode", env: { OPENCODE: "1" }, flag: "opencode:ses_opencode1" },
  ];

  for (const { name, host, session, agentName, env, flag } of HOSTS) {
    test(`${name}: a script's message is the session's own, as its tool writes it`, async () => {
      const box = await world();
      const byTool = await tool(box.client, "send_message", { body: "From the tool.", subject: name, project_path: box.project, agent_session: session, agent_host: host, agent_name: agentName });
      const byScript = await cli(box, [...(flag ? ["--session", flag] : []), "send_message", JSON.stringify({ reply_to: byTool.message_id, body: "From a script." })], { env });
      expect(byScript.code).toBe(0);
      const [first, second] = (await threadOf(box.server, byTool.thread_id)).messages;
      expect(second!.author).toEqual(first!.author);
      // Its default thread too: no reply_to, no name, and it joins the session's open thread.
      const joined = await cli(box, [...(flag ? ["--session", flag] : []), "send_message", '{"body":"Same thread."}'], { env });
      expect(JSON.parse(joined.stdout).thread_id).toBe(byTool.thread_id);
      // "Your" threads and cards are this session's.
      const listed = await cli(box, [...(flag ? ["--session", flag] : []), "read_thread", "{}"], { env });
      expect(JSON.parse(listed.stdout).threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([byTool.thread_id]);
    });
  }

  test("with no session anywhere it is a raw MCP client: nobody's message, and lists read everyone's", async () => {
    const box = await world();
    const theirs = await tool(box.client, "send_message", { body: "Theirs.", subject: "Theirs", thread: "Theirs", project_path: box.project, agent_session: "ses-other", agent_host: "claude-code" });
    await tool(box.client, "card", { op: "create", title: "Their card", project_path: box.project, agent_session: "ses-other", agent_host: "claude-code" });
    expect(JSON.parse((await cli(box, ["read_thread", "{}"])).stdout).threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([theirs.thread_id]);
    expect(JSON.parse((await cli(box, ["card", '{"op":"list"}'])).stdout).total).toBe(1);
    const reply = await cli(box, ["send_message", JSON.stringify({ reply_to: theirs.message_id, body: "A person's script." })]);
    const message = (await threadOf(box.server, theirs.thread_id)).messages.find((m) => m.id === JSON.parse(reply.stdout).message_id)!;
    expect(message.author).toMatchObject({ kind: "agent", host: null, session: null });
  });

  test("an MCP-only agent is its session with the bare value; a bare session has no host to claim", async () => {
    const box = await world();
    const mine = await tool(box.client, "send_message", { body: "Mine.", subject: "Mine", thread: "Mine", project_path: box.project, agent_session: "ses_mcponly", agent_name: "Some Client" });
    await tool(box.client, "send_message", { body: "Another's.", subject: "Other", thread: "Other", project_path: box.project, agent_session: "ses_other" });
    const listed = await cli(box, ["--session", "ses_mcponly", "read_thread", "{}"]);
    expect(JSON.parse(listed.stdout).threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([mine.thread_id]);
  });

  test("a card's owner is the session, so `your cards` means this agent's and another's stays out", async () => {
    const box = await world();
    await tool(box.client, "send_message", { body: "Lane.", subject: "Lane", thread: "Lane", project_path: box.project, agent_session: "ses-a", agent_host: "claude-code" });
    await tool(box.client, "card", { op: "create", title: "Other lane", project_path: box.project, agent_session: "ses-b", agent_host: "claude-code" });
    const env = { PLANNOTATOR_SESSION_TAG: "claude-code:ses-a" };
    const made = await cli(box, ["card", '{"op":"create","title":"My lane","column":"in_progress"}'], { env });
    expect(JSON.parse(made.stdout).card.agent).toMatchObject({ host: "claude-code", session: "ses-a", name: "Claude Code" });
    const mine = JSON.parse((await cli(box, ["card", '{"op":"list"}'], { env })).stdout);
    expect(mine.cards.map((c: { title: string }) => c.title)).toEqual(["My lane"]);
  });

  // Twelve CLI starts in a row and no waiting between them: about 4.5 s alone, so the default 5 s fails under load.
  test("an agent started from another agent's shell never writes as that agent", async () => {
    const box = await world();
    const seen = await tool(box.client, "send_message", { body: "Outer.", subject: "Outer", thread: "Outer", project_path: box.project, agent_session: "ses-outer", agent_host: "claude-code" });
    const count = async () => (await threadOf(box.server, seen.thread_id)).messages.length;
    const send = JSON.stringify({ reply_to: seen.message_id, body: "Whose is this?" });
    for (const env of [
      { PLANNOTATOR_SESSION_TAG: "claude-code:ses-outer", CODEX_THREAD_ID: CODEX_THREAD },
      { PLANNOTATOR_SESSION_TAG: "claude-code:ses-outer", OPENCODE: "1" },
      { PI_SESSION_ID: "ses-pi", QWEN_CODE_SESSION_ID: QWEN_SESSION },
      { CODEX_THREAD_ID: CODEX_THREAD, CLAUDECODE: "1" },
      { CODEX_THREAD_ID: CODEX_THREAD, OMPCODE: "1" },
      { PI_SESSION_ID: "ses-pi", CLAUDECODE: "1" },
      { PLANNOTATOR_SESSION_TAG: "claude-code:ses-outer", QWEN_CODE: "1" },
      // Claude Code or Pi started from a DeepSeek Harness shell: DSH_* is inherited.
      { DSH_SHELL: "1", DSH_SESSION_ID: "session-outer", CLAUDECODE: "1" },
      { DSH_SHELL: "1", DSH_SESSION_ID: "session-outer", PI_SESSION_ID: "ses-pi" },
    ]) {
      const refused = await cli(box, ["send_message", send], { env });
      expect(refused).toMatchObject({ code: 1, stdout: "" });
      expect(refused.stderr).toStartWith("session_ambiguous: ");
    }
    // A value this shell contradicts: a wake that went stale, or a script another agent left behind.
    const stale = await cli(box, ["--session", "claude-code:ses-other", "send_message", send], { env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses-outer" } });
    expect(stale).toMatchObject({ code: 1, stdout: "" });
    expect(stale.stderr).toStartWith("session_mismatch: ");
    expect(await count()).toBe(1);
    // The agent's own value settles it: Codex inside Claude Code.
    const settled = await cli(box, ["--session", `codex:${CODEX_THREAD}`, "send_message", send], { env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses-outer", CODEX_THREAD_ID: CODEX_THREAD } });
    expect(settled.code).toBe(0);
    expect((await threadOf(box.server, seen.thread_id)).messages.at(-1)!.author).toMatchObject({ host: "codex", session: CODEX_THREAD });
    // OpenCode inside Claude Code: its shell names only the outer session, and its Tidy says who it is.
    const nested = await cli(box, ["--session", "opencode:ses_nested", "read_thread", "{}"], { env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses-outer", OPENCODE: "1" } });
    expect(nested.code).toBe(0);
  }, 30_000);

  test("the rules alone: what each shell and value resolve to", () => {
    const caller = (flag: string | null, env: Record<string, string>) => {
      const answer = inboxCallerOf(flag, env);
      return answer.ok ? answer.caller : answer.code;
    };
    expect(caller(null, {})).toBeNull();
    expect(caller(null, { OPENCODE: "1", GEMINI_CLI: "1" })).toBeNull();
    // A host's marker beside its own session is its own shell, not a nested agent.
    expect(caller(null, { PLANNOTATOR_SESSION_TAG: "claude-code:s", CLAUDECODE: "1" })).toEqual({ host: "claude-code", session: "s", name: "Claude Code" });
    expect(caller(null, { QWEN_CODE_SESSION_ID: QWEN_SESSION, QWEN_CODE: "1" })).toEqual({ host: "qwen", session: QWEN_SESSION, name: "Qwen Code" });
    expect(caller(null, { PI_SESSION_ID: "s", OMPCODE: "1" })).toEqual({ host: "pi", session: "s", name: "Pi" });
    expect(caller(null, { CLAUDECODE: "1" })).toBeNull();
    // DeepSeek Harness: its marker beside its own session is its own shell; DSH_SHELL alone names no session.
    expect(caller(null, { DSH_SHELL: "1", DSH_SESSION_ID: "session-s" })).toEqual({ host: "dsh", session: "session-s", name: "DeepSeek Harness" });
    expect(caller(null, { DSH_SHELL: "1" })).toBeNull();
    expect(caller(null, { DSH_SHELL: "1", DSH_SESSION_ID: "session-s", GEMINI_CLI: "1" })).toBe("session_ambiguous");
    // The person's own terminal in DSH Web (DSH_SESSION_ID, no DSH_SHELL): no DSH session, so whoever runs there is themselves.
    expect(caller(null, { DSH_SESSION_ID: "session-s" })).toBeNull();
    expect(caller(null, { DSH_SESSION_ID: "session-s", PI_SESSION_ID: "ses-pi" })).toEqual({ host: "pi", session: "ses-pi", name: "Pi" });
    expect(caller(null, { DSH_SESSION_ID: "session-s", PLANNOTATOR_SESSION_TAG: "claude-code:s", CLAUDECODE: "1" })).toEqual({ host: "claude-code", session: "s", name: "Claude Code" });
    expect(caller(null, { DSH_SESSION_ID: "session-s", CODEX_THREAD_ID: CODEX_THREAD })).toEqual({ host: "codex", session: CODEX_THREAD, name: "Codex" });
    // A subagent's model shell: the session Plannotator's plugin names (its parent).
    const sub = { DSH_SHELL: "1", DSH_SESSION_ID: "session-child", DSH_PLANNOTATOR_SESSION_ID: "session-parent", DSH_PLANNOTATOR_SESSION_FOR: "session-child" };
    expect(caller(null, sub)).toEqual({ host: "dsh", session: "session-parent", name: "DeepSeek Harness" });
    expect(caller(null, { ...sub, DSH_PLANNOTATOR_SESSION_FOR: "session-other" })).toEqual({ host: "dsh", session: "session-child", name: "DeepSeek Harness" });
    // A mismatch names the variable the session came from, so unsetting it changes something.
    const mismatch = inboxCallerOf("dsh:session-mine", sub);
    expect(mismatch.ok ? null : mismatch.message).toContain("from DSH_PLANNOTATOR_SESSION_ID");
    expect(mismatch.ok ? null : mismatch.message).not.toContain("from DSH_SESSION_ID");
    const plain = inboxCallerOf("dsh:session-mine", { DSH_SHELL: "1", DSH_SESSION_ID: "session-child" });
    expect(plain.ok ? null : plain.message).toContain("from DSH_SESSION_ID");
    // T3 Code: its thread beside Claude's own CLAUDECODE is the thread (T3 runs Claude, and the mod is off there).
    const t3 = { host: "t3", session: T3_THREAD, name: "T3 Code" };
    expect(caller(null, { T3CODE_THREAD_ID: T3_THREAD, CLAUDECODE: "1" })).toEqual(t3);
    expect(caller(null, { T3CODE_THREAD_ID: T3_THREAD })).toEqual(t3);
    // Anything else beside it is ambiguous: a Codex started in a T3 shell is the caller, not the thread; a tag can be
    // inherited from a Claude Code that started T3; a DSH model shell or another agent is its own.
    for (const other of [
      { CODEX_THREAD_ID: CODEX_THREAD },
      { PLANNOTATOR_SESSION_TAG: "claude-code:s" },
      { DSH_SHELL: "1" },
      { DSH_SHELL: "1", DSH_SESSION_ID: "session-s" },
      { GEMINI_CLI: "1" },
    ]) {
      expect(caller(null, { T3CODE_THREAD_ID: T3_THREAD, CLAUDECODE: "1", ...other })).toBe("session_ambiguous");
    }
    expect(caller(null, { T3CODE_THREAD_ID: T3_THREAD, CODEX_THREAD_ID: CODEX_THREAD })).toBe("session_ambiguous");
    // The wake's own value settles it.
    expect(caller(`t3:${T3_THREAD}`, { T3CODE_THREAD_ID: T3_THREAD, CODEX_THREAD_ID: CODEX_THREAD, CLAUDECODE: "1" })).toEqual(t3);
    // A thread T3 made through MCP, a delegated or a forked one is not a UUID: no T3 session, never a guess.
    for (const id of [`mcp:${T3_THREAD}`, "thread:mcp:abc:1", `${T3_THREAD}:fork`, "not-a-uuid"]) {
      expect(caller(null, { T3CODE_THREAD_ID: id, CLAUDECODE: "1" })).toBeNull();
    }
    expect(caller("t3:not-a-uuid", {})).toBe("invalid_session");
    // A malformed variable is no session, as in the shim.
    expect(caller(null, { PLANNOTATOR_SESSION_TAG: "cursor:ses", CODEX_THREAD_ID: "not-a-uuid" })).toBeNull();
    // One session named twice is one session.
    expect(caller(null, { PLANNOTATOR_SESSION_TAG: `codex:${CODEX_THREAD}`, CODEX_THREAD_ID: CODEX_THREAD })).toEqual({ host: "codex", session: CODEX_THREAD, name: "Codex" });
    // Agrees with the shell.
    expect(caller("claude-code:s", { PLANNOTATOR_SESSION_TAG: "claude-code:s" })).toEqual({ host: "claude-code", session: "s", name: "Claude Code" });
    expect(caller("claude-code:s", { PLANNOTATOR_SESSION_TAG: "opencode:s" })).toBe("session_mismatch");
    expect(caller("cursor:ses_x", {})).toEqual({ host: "cursor", session: "ses_x", name: "Cursor" });
    expect(caller("ses_x", {})).toEqual({ session: "ses_x" });
    // Not a value a wake could have given.
    for (const bad of ["a b", "claude-code:", ":x", "$(rm -rf /)", "codex:not-a-uuid", "qwen:ses_x"]) expect(caller(bad, {})).toBe("invalid_session");
  });

  test("--session is parsed anywhere and only once", () => {
    expect(parseCallCommand(["card", '{"op":"list"}', "--session", "pi:s"])).toEqual({ ok: true, action: "card", json: '{"op":"list"}', stdin: false, session: "pi:s" });
    expect(parseCallCommand(["--session"])).toMatchObject({ ok: false, code: "invalid_session" });
    expect(parseCallCommand(["--session", "a", "--session", "b", "card"])).toMatchObject({ ok: false, code: "invalid_session" });
    expect(parseCallCommand(["card", "{}", "{}"])).toMatchObject({ ok: false, code: "usage" });
    expect(parseCallCommand(["card", "--json"])).toMatchObject({ ok: false, code: "usage" });
    // zsh does not split `cmd $S`: the one word says what to do about it.
    expect(parseCallCommand(["--session ses_x", "card"])).toMatchObject({ ok: false, code: "usage", error: expect.stringContaining("separate words") });
  });

  test("a read with no session settles nothing for the thread's owner; one that names the owner's session does; a raw MCP client's settles only its own", async () => {
    const box = await world();
    const { client, server, project } = box;
    await poll(server, "ses-a", project);
    const answer = async (messageId: string, subject: string) =>
      ((await (await post(server, `/api/inbox/messages/${messageId}/reply`, { words: `${subject} yes.`, idempotency_key: subject })).json()) as { reply: { id: string } }).reply.id;
    const replied = async (subject: string, session: string | null = "ses-a") => {
      const asked = await tool(client, "send_message", { body: `${subject}?`, subject, thread: subject, project_path: project, ...(session ? { agent_session: session, agent_host: "claude-code" } : {}) });
      return { thread: asked.thread_id as string, reply: await answer(asked.message_id, subject) };
    };
    const scripted = await replied("Scripted");
    const raw = await replied("Raw");
    const named = await replied("Named");
    // A raw MCP client that names no session, sending and reading: the reply to it is its own to settle.
    const own = await replied("Own", null);
    const checked = async (thread: string) => (await threadOf(server, thread)).messages[0]!.agent_checked_seq ?? null;

    for (const json of [{ thread_id: scripted.thread }, { thread_id: scripted.thread, format: "full" }]) {
      const read = await cli(box, ["read_thread", JSON.stringify(json)]);
      expect(read.code).toBe(0);
      expect(read.stdout).toContain("Scripted yes.");
    }
    // A script's read with no session is a peek, even of a reply to a message sent with none.
    expect((await cli(box, ["read_thread", JSON.stringify({ thread_id: own.thread, format: "full" })])).code).toBe(0);
    expect(await checked(own.thread)).toBeNull();
    // A raw MCP client's read with no session is not a peek: it settles the reply to its own message...
    await tool(client, "read_thread", { thread_id: own.thread });
    expect(await checked(own.thread)).not.toBeNull();
    // ...but not one owed to ses-a, whose connection takes it (only a reply's recipient settles it).
    await tool(client, "read_thread", { thread_id: raw.thread });
    expect((await cli(box, ["--session", "claude-code:ses-a", "read_thread", JSON.stringify({ thread_id: named.thread })])).code).toBe(0);

    const handedOut = (await poll(server, "ses-a", project)).map((command) => command.id);
    expect(handedOut).toContain(scripted.reply);
    expect(handedOut).toContain(raw.reply);
    expect(handedOut).not.toContain(named.reply);
  });

  test("a list with no session is what a raw MCP client gets, and is never an empty one that hides the project", async () => {
    const box = await world();
    const { client, project } = box;
    await tool(client, "send_message", { body: "Still there?", subject: "Listed", thread: "Listed", project_path: project, agent_session: "ses-a", agent_host: "claude-code" });
    const above = dirname(project);

    const listed = await cli(box, ["read_thread", "{}"], { cwd: above });
    expect(listed.code).toBe(0);
    const raw = await tool(client, "read_thread", { project_path: above });
    expect(raw.projects_inside).toEqual([expect.objectContaining({ root: project })]);
    expect(JSON.parse(listed.stdout).projects_inside).toEqual(raw.projects_inside);
  });
});

/** The agent's tidy, as one script: the command on PATH, its output read with nothing but grep. */
const TIDY_SCRIPT = String.raw`#!/bin/bash
set -euo pipefail
call() { plannotator inbox call --session "$SESSION" "$@"; }

for card in $(call card '{"op":"list"}' | grep -o '"id":"crd_[0-9A-Z]*"' | cut -d'"' -f4); do
  call card "{\"op\":\"move\",\"card_id\":\"$card\",\"column\":\"in_review\",\"you\":\"Look at the lane\"}" > /dev/null
done
call send_message "{\"reply_to\":\"$ACTION\",\"done\":[\"$ACTION\"],\"body\":\"Saw the deploy go green.\",\"idempotency_key\":\"tidy-done\"}" > /dev/null
call send_message "{\"reply_to\":\"$QUESTION\",\"supersedes\":[\"$QUESTION\"],\"body\":\"The ledger moved, so this no longer applies.\",\"idempotency_key\":\"tidy-withdraw\"}" > /dev/null
call send_message - < "$ANSWER_JSON" | grep -o '"replayed":[a-z]*'
`;

/** The script's world: a `plannotator` on PATH that is this CLI, and the script. */
function scriptOf(box: Box) {
  const bin = join(box.root, "bin");
  mkdirSync(bin);
  const plannotator = join(bin, "plannotator");
  writeFileSync(plannotator, `#!/bin/sh\nexec '${process.execPath}' run '${entry}' "$@"\n`);
  chmodSync(plannotator, 0o755);
  const script = join(box.root, "tidy.sh");
  writeFileSync(script, TIDY_SCRIPT);
  return async (env: Record<string, string>) => {
    const proc = Bun.spawn(["/bin/bash", script], { cwd: box.project, env: { ...box.env, PATH: `${bin}${delimiter}${box.env.PATH}`, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  };
}

describe("a Tidy run from one script", () => {
  async function seed(box: World) {
    const { client, project, clock, server } = box;
    const agent = (session: string, args: Record<string, unknown>) => tool(client, "send_message", { project_path: project, agent_session: session, agent_host: "claude-code", ...args });
    clock.behind = 3 * 24 * HOUR;
    await poll(server, "ses-a", project);
    await poll(server, "ses-b", project);
    const question = await agent("ses-a", { subject: "Ledger", thread: "Ledger", body: block("Backfill the ledger first?") });
    const deploy = await agent("ses-a", { subject: "Deploy", thread: "Deploy", body: action("Approve the deploy") });
    const words = await agent("ses-a", { subject: "Webhooks", thread: "Webhooks", body: "Webhooks are done; screenshots next." });
    await tool(client, "card", { op: "create", title: "Ledger lane", column: "in_progress", thread_id: question.thread_id, project_path: project, agent_session: "ses-a", agent_host: "claude-code" });
    await tool(client, "card", { op: "create", title: "Docs lane", column: "in_progress", project_path: project, agent_session: "ses-a", agent_host: "claude-code" });
    const others = await agent("ses-b", { subject: "Refunds", thread: "Refunds", body: block("Move refunds now?") });
    await tool(client, "card", { op: "create", title: "Refunds lane", column: "in_progress", project_path: project, agent_session: "ses-b", agent_host: "claude-code" });
    clock.behind = 2 * HOUR;
    expect((await post(server, `/api/inbox/messages/${words.message_id}/reply`, { words: "Still waiting on those screenshots.", idempotency_key: "r1" })).status).toBe(200);
    for (const command of await poll(server, "ses-a", project)) await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "delivered", id: command.id });
    clock.behind = 0;
    await poll(server, "ses-a", project);
    await poll(server, "ses-b", project);
    return { question, deploy, words, others };
  }

  test("the list's Tidy: one script lists cards, moves several, marks an item done and answers threads; a rerun posts nothing twice", async () => {
    const box = await world();
    const { server, project } = box;
    const { question, deploy, words, others } = await seed(box);
    const run = async () => (await runOf(server)).agents;

    const started = await post(server, "/api/inbox/tidy", { sessions: ["ses-a", "ses-b"], idempotency_key: "t1" });
    expect(started.status).toBe(200);
    const wake = await wakeOf(server, "ses-a", project);
    await wakeOf(server, "ses-b", project);
    // A write counts once it is after the delivery (a later clock tick).
    await Bun.sleep(5);

    const lastPerson = (await threadOf(server, words.thread_id)).messages.filter((m) => m.author.kind === "person" && !m.tidy).at(-1)!;
    const answerJson = join(box.root, "answer.json");
    writeFileSync(answerJson, JSON.stringify({ reply_to: lastPerson.id, body: "Screenshots are attached to the card.", idempotency_key: "tidy-answer" }));
    const script = scriptOf(box);
    // The session comes from the wake alone: this shell names none, as OpenCode's does not.
    const env = { SESSION: sessionValueIn(wake.body)!, ACTION: deploy.message_id, QUESTION: question.message_id, ANSWER_JSON: answerJson };
    expect(env.SESSION).toBe("claude-code:ses-a");
    const first = await script(env);
    expect(first).toMatchObject({ code: 0, stdout: '"replayed":false\n' });

    // The Inbox's state: its cards moved and only its cards, the item done, the question withdrawn, the words answered.
    const cards = JSON.parse((await cli(box, ["card", '{"op":"list","asked_by":"anyone"}'])).stdout).cards as { title: string; column: string; heard_by: { session: string } }[];
    expect(Object.fromEntries(cards.map((c) => [c.title, c.column]))).toEqual({ "Ledger lane": "in_review", "Docs lane": "in_review", "Refunds lane": "in_progress" });
    const deployThread = await threadOf(server, deploy.thread_id);
    expect(deployThread.messages[0]!.questions![0]!.action_result).toMatchObject({ by: "agent" });
    const ledger = await threadOf(server, question.thread_id);
    expect(ledger.messages[0]!.questions![0]!.state).toBe("superseded");
    const webhooks = await threadOf(server, words.thread_id);
    const answer = webhooks.messages.filter((m) => !m.tidy).at(-1) as InboxMessage;
    expect(answer.body).toBe("Screenshots are attached to the card.");
    expect(answer.author).toMatchObject({ host: "claude-code", session: "ses-a", name: "Claude Code" });
    // The wake of a session its connection reaches stays the connection's to deliver: the script read no Tidy text.
    expect(first.stderr).not.toContain(INBOX_TIDY_INSTRUCTION);

    // Tidy's progress: ses-a tidied, in the three threads it was asked about; ses-b, which wrote nothing, not.
    const byScript = Object.fromEntries((await run()).map((a) => [a.session, [a.state, a.updated]]));
    expect(byScript).toEqual({ "ses-a": ["tidied", 3], "ses-b": ["delivered", 0] });
    expect((await threadOf(server, others.thread_id)).messages.every((m) => m.author.session !== "ses-a")).toBe(true);

    // A rerun: nothing posts twice, and the cards stay where they are.
    const counts = async () => Promise.all([question, deploy, words].map(async ({ thread_id }) => (await threadOf(server, thread_id)).messages.length));
    const before = await counts();
    const again = await script(env);
    expect(again).toMatchObject({ code: 0, stdout: '"replayed":true\n' });
    expect(await counts()).toEqual(before);
    expect((await run()).find((a) => a.session === "ses-a")!.updated).toBe(3);
  }, 120_000);

  for (const [name, stale] of [
    ["Claude Code", { PLANNOTATOR_SESSION_TAG: "claude-code:ses-old" }],
    ["Qwen Code", { QWEN_CODE_SESSION_ID: QWEN_SESSION }],
  ] as const) {
    test(`a ${name} shell older than its session: refused with no route into the old session, and the way out counts for the Tidy`, async () => {
      const box = await world();
      const { server, project } = box;
      const { words } = await seed(box);
      expect((await post(server, "/api/inbox/tidy", { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
      const wake = await wakeOf(server, "ses-a", project);
      await Bun.sleep(5);
      const value = sessionValueIn(wake.body)!;
      const send = (key: string) => JSON.stringify({ reply_to: words.message_id, body: "Screenshots are on the card.", idempotency_key: key });
      const authors = async () => (await threadOf(server, words.thread_id)).messages.filter((m) => m.author.kind === "agent").map((m) => m.author.session);
      const before = await authors();

      const refused = await cli(box, ["--session", value, "send_message", send("k1")], { env: stale });
      expect(refused).toMatchObject({ code: 1, stdout: "" });
      expect(refused.stderr).toStartWith("session_mismatch: ");
      // It names the variable to clear, the way out that writes as the Tidy's session.
      expect(refused.stderr).toContain(Object.keys(stale)[0]!);
      expect(refused.stderr).not.toContain("Leave --session out");
      expect(await authors()).toEqual(before);
      expect((await runOf(server)).agents[0]).toMatchObject({ state: "delivered" });

      // A new shell, or that variable unset: the same call is the session the Tidy asked, and it counts.
      const unset = await cli(box, ["--session", value, "send_message", send("k2")]);
      expect(unset.code).toBe(0);
      expect((await authors()).at(-1)).toBe("ses-a");
      expect((await runOf(server)).agents[0]).toMatchObject({ state: "tidied", updated: 1 });
    });
  }

  test("the worked examples in --help run as written", async () => {
    const box = await world();
    const { client, server, project } = box;
    const asker = { project_path: project, agent_session: "ses-a", agent_host: "claude-code" };
    const question = await tool(client, "send_message", { ...asker, body: block("Ship the ledger?"), subject: "Ledger", thread: "Ledger" });
    const item = await tool(client, "send_message", { ...asker, body: action("Approve the deploy"), reply_to: question.message_id });
    const made = await tool(client, "card", { ...asker, op: "create", title: "Ledger lane", column: "in_progress" });
    const real = (json: string) => json.replaceAll("msg_1", question.message_id).replaceAll("msg_2", item.message_id).replaceAll("crd_1", made.card.id);
    const examples = [...INBOX_CALL_USAGE.matchAll(/plannotator inbox call (\w+) '(.+)'$/gm)].map(([, name, json]) => [name!, real(json!)] as const);
    expect(examples.map(([name]) => name)).toEqual(["card", "card", "send_message"]);
    for (const [name, json] of examples) expect(await cli(box, [name, json], { env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses-a" } })).toMatchObject({ code: 0, stderr: "" });
    const [withdrawn, done] = (await threadOf(server, question.thread_id)).messages;
    expect(withdrawn!.questions![0]!.state).toBe("superseded");
    expect(done!.questions![0]!.action_result).toMatchObject({ by: "agent" });
    const cards = JSON.parse((await cli(box, ["card", '{"op":"list","asked_by":"anyone","include_resolved":true}'])).stdout).cards as { column: string }[];
    expect(cards.map((c) => c.column)).toEqual(["done"]);
  });

  test("the Board's Tidy: a script that only moves cards counts as tidied, for that session", async () => {
    const box = await world();
    const { server, project, client, clock } = box;
    clock.behind = 3 * 24 * HOUR;
    await poll(server, "ses_oc1", project, "opencode");
    await poll(server, "ses-b", project);
    await tool(client, "send_message", { project_path: project, agent_session: "ses_oc1", agent_host: "opencode", subject: "Lane", thread: "Lane", body: "Starting." });
    await tool(client, "card", { op: "create", title: "Lane", column: "in_progress", project_path: project, agent_session: "ses_oc1", agent_host: "opencode" });
    await tool(client, "send_message", { project_path: project, agent_session: "ses-b", agent_host: "claude-code", subject: "Other", thread: "Other", body: "Starting." });
    await tool(client, "card", { op: "create", title: "Other", column: "in_progress", project_path: project, agent_session: "ses-b", agent_host: "claude-code" });
    clock.behind = 0;
    await poll(server, "ses_oc1", project, "opencode");
    await poll(server, "ses-b", project);
    const asked = await planOf(server, "?surface=board");
    expect(asked.agents.map((a) => a.session).sort()).toEqual(["ses-b", "ses_oc1"]);
    expect((await post(server, "/api/inbox/tidy", { sessions: ["ses_oc1", "ses-b"], idempotency_key: "t1", surface: "board" })).status).toBe(200);
    const wake = await wakeOf(server, "ses_oc1", project, "opencode");
    await wakeOf(server, "ses-b", project);
    await Bun.sleep(5);

    // OpenCode's shell marks itself and names no session.
    const env = { OPENCODE: "1" };
    const session = sessionValueIn(wake.body)!;
    expect(session).toBe("opencode:ses_oc1");
    const mine = JSON.parse((await cli(box, ["--session", session, "card", '{"op":"list"}'], { env })).stdout);
    expect(mine.cards.map((c: { title: string }) => c.title)).toEqual(["Lane"]);
    const moved = await cli(box, ["--session", session, "card", JSON.stringify({ op: "move", card_id: mine.cards[0].id, column: "in_review", you: "Pick a name" })], { env });
    expect(moved.code).toBe(0);
    expect(JSON.parse(moved.stdout).card.heard_by).toMatchObject({ host: "opencode", session: "ses_oc1" });
    expect(Object.fromEntries((await runOf(server)).agents.map((a) => [a.session, a.state]))).toEqual({ ses_oc1: "tidied", "ses-b": "delivered" });
  }, 60_000);

  test("an MCP-only agent: the text reaches the script's reader on stderr, once, and the value makes its writes count", async () => {
    const box = await world();
    const { server, client, project, clock } = box;
    clock.behind = 3 * HOUR;
    const asked = await tool(client, "send_message", { project_path: project, agent_session: "ses_mcp", agent_host: "cursor", subject: "Keys", thread: "Keys", body: block("Rebind keys?") });
    clock.behind = 0;
    await tool(client, "read_thread", { thread_id: asked.thread_id, agent_session: "ses_mcp" });
    expect((await post(server, "/api/inbox/tidy", { sessions: ["ses_mcp"], idempotency_key: "t1" })).status).toBe(200);

    const first = await cli(box, ["--session", "cursor:ses_mcp", "read_thread", JSON.stringify({ thread_id: asked.thread_id })]);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain(INBOX_TIDY_INSTRUCTION);
    expect(sessionValueIn(first.stderr)).toBe("cursor:ses_mcp");
    expect(JSON.parse(first.stdout).tidy.text).toContain(INBOX_TIDY_INSTRUCTION);
    await Bun.sleep(5);

    const reply = await cli(box, ["--session", "cursor:ses_mcp", "send_message", JSON.stringify({ reply_to: asked.message_id, body: "No longer applies.", idempotency_key: "k1" })]);
    expect(reply.code).toBe(0);
    expect(reply.stderr).toBe("");
    expect((await runOf(server)).agents).toEqual([expect.objectContaining({ session: "ses_mcp", state: "tidied", updated: 1 })]);
  });
});

describe("a Codex thread's script and the reply wake (#2573)", () => {
  /**
   * The Inbox runs with a fake `codex` (tests/helpers/fake-agents.ts) and its
   * own scratch CODEX_HOME, where the thread's rollout says what started it.
   * The thread never called the Inbox tool: only `plannotator inbox call` from
   * its shell (CODEX_THREAD_ID), as an agent that did not find the MCP tools.
   */
  type Rollout = { source: unknown; originator: string };
  /** The thread's rollout, in the day folder its UUIDv7 id names (`created`), or a later one (a thread resumed months on). */
  function writeRollout(codexHome: string, rollout: Rollout, where: "created" | "later" = "created") {
    const day = join(codexHome, "sessions", where === "created" ? codexRolloutDayFolders(CODEX_THREAD)[0]! : join("2026", "11", "03"));
    mkdirSync(day, { recursive: true });
    const meta = { timestamp: "2026-11-03T10:00:00.000Z", type: "session_meta", payload: { id: CODEX_THREAD, timestamp: "2026-11-03T10:00:00.000Z", cwd: "/tmp", cli_version: "0.166.0", ...rollout } };
    writeFileSync(join(day, `rollout-2026-11-03T10-00-00-${CODEX_THREAD}.jsonl`), `${JSON.stringify(meta)}\n`);
  }
  async function codexWorld(rollout: Rollout | null, options: { where?: "created" | "later"; env?: (root: string) => Record<string, string>; now?: () => number } = {}) {
    const box = sandbox();
    const fake = createFakeAgents("plannotator-inbox-call-codex-");
    fakes.push(fake);
    fake.install("codex");
    if (rollout) writeRollout(fake.env.CODEX_HOME!, rollout, options.where);
    const server = await startInboxServer({
      dataDir: box.dataDir,
      binaryPath: null,
      agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...options.env?.(fake.root) } }),
      codexWake: { extraClis: [], ...(options.now ? { now: options.now } : {}) },
    });
    servers.push(server);
    return { ...box, fake, server };
  }
  type CodexWorld = Awaited<ReturnType<typeof codexWorld>>;
  const queues = (fake: FakeAgents) => fake.calls().filter((call) => call.name === "codex" && call.args[0] === "queue");
  /** A send from the thread's shell, and whether the message it stored wakes. */
  async function scriptSends(w: CodexWorld, body: string) {
    const sent = await cli(w, ["send_message", JSON.stringify({ body })], { env: { CODEX_THREAD_ID: CODEX_THREAD } });
    expect(sent.code).toBe(0);
    const { message_id, thread_id } = JSON.parse(sent.stdout) as { message_id: string; thread_id: string };
    const message = (await threadOf(w.server, thread_id)).messages.find((m) => m.id === message_id)!;
    return { message_id, thread_id, message, wakes: message.wakes === true };
  }
  const answer = (w: CodexWorld, messageId: string, words: string) => post(w.server, `/api/inbox/messages/${messageId}/reply`, { idempotency_key: `k-${messageId}`, words });

  const interactive: [string, Rollout, "created" | "later"][] = [
    ["the TUI", { source: "cli", originator: "codex-tui" }, "created"],
    ["the Codex app, resumed months after it was made", { source: "vscode", originator: "Codex Desktop" }, "later"],
  ];
  for (const [name, rollout, where] of interactive) {
    test(`a thread of ${name}: its script's message wakes, and the person's reply goes in through codex queue`, async () => {
      const w = await codexWorld(rollout, { where });
      const sent = await scriptSends(w, "Ship the worker today?");
      expect(sent.message.author).toMatchObject({ kind: "agent", host: "codex", session: CODEX_THREAD });
      expect(sent.wakes).toBe(true);

      expect((await answer(w, sent.message_id, "Yes, ship it.")).status).toBe(200);
      await w.server.codexWake.sweep();
      const calls = queues(w.fake);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[1]).toBe(`--thread=${CODEX_THREAD}`);
      expect(calls[0]!.args[2]).toContain("Yes, ship it.");
    });
  }

  const never: [string, Rollout | null][] = [
    ["a codex exec run", { source: "exec", originator: "codex_exec" }],
    ["a codex exec run whose source reads cli", { source: "cli", originator: "codex_exec" }],
    ["a subagent", { source: { subagent: "review" }, originator: "codex-tui" }],
    ["a thread with no rollout", null],
  ];
  for (const [name, rollout] of never) {
    test(`${name} is never woken from its script: nothing is queued for the reply`, async () => {
      const w = await codexWorld(rollout);
      const sent = await scriptSends(w, "One turn only.");
      expect(sent.wakes).toBe(false);
      expect((await answer(w, sent.message_id, "Yes.")).status).toBe(200);
      await w.server.codexWake.sweep();
      expect(queues(w.fake)).toEqual([]);
    });
  }

  test("a rollout not found is not looked for on every send; one written since is found once that wait is over", async () => {
    const clock = { ahead: 0 };
    const w = await codexWorld(null, { now: () => Date.now() + clock.ahead });
    expect((await scriptSends(w, "Before Codex wrote its rollout.")).wakes).toBe(false);
    writeRollout(w.fake.env.CODEX_HOME!, { source: "cli", originator: "codex-tui" });
    expect((await scriptSends(w, "Within the minute.")).wakes).toBe(false);
    clock.ahead = 61_000;
    const later = await scriptSends(w, "A minute on.");
    expect(later.wakes).toBe(true);
    expect((await answer(w, later.message_id, "Got it.")).status).toBe(200);
    await w.server.codexWake.sweep();
    expect(queues(w.fake).map((call) => call.args[2])).toEqual([expect.stringContaining("Got it.")]);
  });

  test("a thread codex queue said it does not know: its script no longer wakes it, whatever its rollout says", async () => {
    const w = await codexWorld({ source: "cli", originator: "codex-tui" }, { env: (root) => ({ FAKE_CODEX_UNKNOWN_FILE: join(root, "unknown") }) });
    writeFileSync(join(w.fake.root, "unknown"), CODEX_THREAD);
    const first = await scriptSends(w, "Ship it?");
    expect(first.wakes).toBe(true);
    expect((await answer(w, first.message_id, "Yes.")).status).toBe(200);
    await w.server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    expect(w.server.codexWake.status(CODEX_THREAD)).toBe("dead");

    // Its shell's call says it is there (off `dead`), not that Codex knows it again: still no wake.
    const again = await scriptSends(w, "Still there?");
    expect(again.wakes).toBe(false);
    expect((await answer(w, again.message_id, "Yes, still.")).status).toBe(200);
    await w.server.codexWake.sweep();
    expect(queues(w.fake).some((call) => call.args[2]!.includes("Yes, still."))).toBe(false);
  });
});
