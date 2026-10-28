/**
 * The ACP runner (inbox-acp-runner.ts) against a real Inbox and the FAKE ACP
 * agent (tests/helpers/fake-acp-agent.ts), never a real agent. The fake is
 * started as Grok Build would be, and calls the real `plannotator inbox mcp`
 * (the CLI from source) the runner hands it, so its answers land through the
 * Inbox's own MCP tools. Every test has its own temp data dir.
 *
 * Spec "Inbox replies as real turns for Cursor and Grok", step 1, tests 1 to 9,
 * plus the review's: one process for turns that start together, Stop reaching
 * only its own turn, an agent crash, and a tailnet guest.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InboxRunStatus } from "@plannotator/core/inbox-acp";
import type { InboxListSection, InboxMessage, InboxThread } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";

type InboxListModel = { sections: InboxListSection[] };
import { INBOX_NEW_THREAD_INSTRUCTION, INBOX_WAKE_INSTRUCTION } from "@plannotator/shared/inbox/connection";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { removeStubbedHtml, stubHookDistHtml } from "../../tests/helpers/hook-dist-stub";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";

const FAKE_AGENT = resolve(import.meta.dir, "..", "..", "tests", "helpers", "fake-acp-agent.ts");
const CLI = resolve(import.meta.dir, "..", "..", "apps", "hook", "server", "index.ts");
const SECRET = "sk-test-SECRET-7f3a9c";

let stubs: string[] = [];
beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => removeStubbedHtml(stubs));

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];
/** The hanging agents' and stubborn grandchildren's pids: killed after each test whatever it asserted, so a failing test never leaves one running. */
const hangPids = new Set<number>();
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  for (const pid of hangPids) {
    try {
      process.kill(pid, "SIGKILL"); // inbox-guard: own child (a test's hanging fake agent, never an Inbox)
    } catch {
      // Already gone.
    }
  }
  hangPids.clear();
  for (const restore of restoreEnv.splice(0)) restore();
  // The agents' process groups get SIGTERM, then SIGKILL after 3 s.
  await Bun.sleep(100);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Step = Record<string, unknown>;

interface World {
  server: InboxServer;
  dataDir: string;
  project: string;
  projectId: string;
  log: () => Record<string, unknown>[];
  base: string;
  restart: () => Promise<InboxServer>;
}

const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "owner@example.com";
const GUEST = "guest@example.com";

/** Tailscale as a scripted CLI (inbox-tailscale.test.ts's): this machine's owner, and serve on and off. */
const fakeTailscale: TailscaleRunner = (() => {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") {
      return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER, DisplayName: "Owner" } } }));
    }
    if (args[1] === "status") {
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(serve.size === 0 ? "{}" : JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
})();

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0); // inbox-guard: own child (the fake agent and its grandchild, never an Inbox)
    return true;
  } catch {
    return false;
  }
};

async function world(
  script: { turns?: Step[][]; steps?: Step[]; loadSessionError?: string; [k: string]: unknown },
  opts: { tailnet?: boolean; setAsideDelayMs?: number; launch?: { command: string; args: string[]; env?: Record<string, string> }; startTimeoutMs?: number; env?: Record<string, string> } = {},
): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-acp-runner-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const scriptPath = join(root, "script.json");
  const logPath = join(root, "fake.log");
  writeFileSync(scriptPath, JSON.stringify({ loadSession: true, closeSession: true, steps: [], ...script }));
  if (opts.tailnet) {
    // The tailnet's owner and allowed logins are read from config.json in the data dir (loadConfig reads the env's).
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscaleAllow: [GUEST] }));
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  }
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_TEST_SANDBOX: process.env.PLANNOTATOR_TEST_SANDBOX,
    ...opts.env,
  };
  const make = () =>
    startInboxServer({
      dataDir,
      selfCommand: [process.execPath, "run", CLI],
      agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env }),
      acpRunner: {
        launches: { grok: opts.launch ?? { command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath } } },
        stopGraceMs: 1500,
        ...(opts.startTimeoutMs !== undefined ? { startTimeoutMs: opts.startTimeoutMs } : {}),
      },
      ...(opts.tailnet ? { tailscale: fakeTailscale, publishTailnet: true, phones: false } : {}),
      ...(opts.setAsideDelayMs !== undefined ? { setAsideDelayMs: opts.setAsideDelayMs } : {}),
    });
  const server = await make();
  servers.push(server);
  const projectId = server.store.ensureProject({ name: "billing", root: project }).id;
  const w: World = {
    server,
    dataDir,
    project,
    projectId,
    base: `http://127.0.0.1:${server.port}`,
    log: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    restart: async () => {
      w.server.stop();
      servers.splice(servers.indexOf(w.server), 1);
      await Bun.sleep(200);
      const next = await make();
      servers.push(next);
      w.server = next;
      w.base = `http://127.0.0.1:${next.port}`;
      return next;
    },
  };
  return w;
}

async function until<T>(read: () => T | Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const post = (w: World, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${w.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: w.server.serverSession, ...body }) });

async function startRun(w: World, body = "Please check why the invoice totals are off.") {
  const res = await post(w, "/api/inbox/acp/start", { agent: "grok", project_id: w.projectId, body, idempotency_key: `k-${Math.random()}` });
  expect(res.status).toBe(200);
  return (await res.json()) as { thread_id: string; run: { key: string } };
}

const status = async (w: World, key: string) => ((await (await fetch(`${w.base}/api/inbox/acp/${key}`)).json()) as { run: InboxRunStatus }).run;
const thread = (w: World, id: string): InboxThread => w.server.store.thread(id)!;
const agentMessages = (w: World, id: string, key: string) => thread(w, id).messages.filter((m) => m.author.kind === "agent" && m.author.session === key);
const ended = (w: World, key: string, turns: number) => until(async () => {
  const run = await status(w, key);
  return run.state === "idle" && run.turns.length >= turns && run.turns.at(-1)!.ended_at ? run : null;
}, `turn ${turns} to end`);

function reply(w: World, to: InboxMessage, words: string) {
  return post(w, `/api/inbox/messages/${to.id}/reply`, { idempotency_key: `r-${Math.random()}`, words });
}

/**
 * An agent that hangs in `initialize`: it reads stdin and never answers, ignores SIGTERM and stdin's end
 * (as a Grok updating itself, or waiting on a sign-in, may), and writes its pid and the identity variables
 * it was started with to `out` (each start overwrites it).
 */
function hangingAgent(dir: string): { launch: { command: string; args: string[]; env: Record<string, string> }; read: () => { pid: number; env: Record<string, string | null> } | null } {
  const out = join(dir, "hang.json");
  const source = [
    'const names = ["PLANNOTATOR_SESSION_TAG", "PI_SESSION_ID", "CODEX_THREAD_ID", "CLAUDECODE", "KEEP_ME"];',
    "require('node:fs').writeFileSync(process.env.HANG_OUT, JSON.stringify({ pid: process.pid, env: Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])) }));",
    "process.on('SIGTERM', () => {});",
    "process.stdin.on('data', () => {});",
    "process.stdin.on('end', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return {
    launch: { command: process.execPath, args: ["-e", source], env: { HANG_OUT: out } },
    read: () => {
      if (!existsSync(out)) return null;
      const read = JSON.parse(readFileSync(out, "utf8")) as { pid: number; env: Record<string, string | null> };
      hangPids.add(read.pid);
      return read;
    },
  };
}

/** The fake agent's stubborn grandchild (it ignores SIGTERM), killed after the test whatever it asserted. */
async function stubbornOf(w: World): Promise<number> {
  const pid = await until(() => w.log().find((e) => e.event === "stubborn")?.pid as number | undefined, "the stubborn grandchild");
  hangPids.add(pid);
  return pid;
}

/** The fake answers with the Inbox's own send_message (asking permission first, as Grok does), then says a word. */
const answersInInbox = (body: string): Step[] => [
  { mcp: { name: "send_message", server: "plannotator-inbox", ask: true, args: { body, reply_to: "$REPLY_TO" } } },
  { say: "done" },
];

describe("the ACP runner", () => {
  test("1, 5: compose starts a session; the agent answers through the real `plannotator inbox mcp`, its Inbox tool allowed with no card", async () => {
    const w = await world({ turns: [answersInInbox("The totals skip refunds; I will fix the query.")] });
    const started = await startRun(w);
    const key = started.run.key;
    expect(key).toMatch(/^run_/);
    const run = await ended(w, key, 1);
    expect(run.turn!.outcome).toBe("done");
    expect(run.turn!.answered).toBe("inbox");
    expect(run.permission).toBeNull();
    const [answer] = agentMessages(w, started.thread_id, key);
    expect(answer!.body).toBe("The totals skip refunds; I will fix the query.");
    expect(answer!.author).toMatchObject({ host: "grok", session: key, name: "Grok Build" });
    expect(answer!.wakes).toBe(true);
    // The root was delivered as the turn's prompt: the new-thread wake, the person's words.
    expect(w.server.store.message(started.thread_id)!.delivery?.session).toBe(key);
    const log = w.log();
    const prompt = log.find((e) => e.event === "prompt")!;
    expect(prompt.text).toContain(INBOX_NEW_THREAD_INSTRUCTION);
    expect(prompt.text).toContain("Please check why the invoice totals are off.");
    expect(log.find((e) => e.event === "newSession")).toMatchObject({ cwd: w.project, mcpServers: [{ name: "plannotator-inbox" }] });
    // The Inbox tool: allowed once, automatically.
    expect(log.find((e) => e.event === "mcpPermission")).toMatchObject({ title: "plannotator-inbox__send_message", outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(log.some((e) => e.event === "closeSession")).toBe(true);
    // The session table: 0600, the agent's own session id kept.
    const table = join(w.dataDir, "inbox", "acp", "sessions.json");
    expect(statSync(table).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(table, "utf8")).sessions[0]).toMatchObject({ key, agent: "grok", acp_session_id: run.acp_session_id, cwd: w.project });
    expect(run.resume_command).toContain(`grok -r ${run.acp_session_id}`);
  }, 60_000);

  test("2, 3: a reply loads the stored session and is the prompt; a turn with no Inbox message posts its final text", async () => {
    const w = await world({ turns: [answersInInbox("First answer."), [{ tool: { title: "Read src/invoice.ts" } }, { say: "Thinking aloud. " }, { tool: { title: "Edit src/invoice.ts" } }, { say: "Fixed: refunds are subtracted now." }]] });
    const started = await startRun(w);
    const key = started.run.key;
    const first = await ended(w, key, 1);
    const [answer] = agentMessages(w, started.thread_id, key);
    expect((await reply(w, answer!, "Go ahead and fix it.")).status).toBe(200);
    const second = await ended(w, key, 2);
    expect(second.turn!.outcome).toBe("done");
    expect(second.turn!.answered).toBe("final_text");
    const log = w.log();
    expect(log.find((e) => e.event === "loadSession")).toMatchObject({ sessionId: first.acp_session_id, cwd: w.project });
    const prompts = log.filter((e) => e.event === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.text).toContain(INBOX_WAKE_INSTRUCTION);
    expect(prompts[1]!.text).toContain("Go ahead and fix it.");
    // The final text: only what came after the last tool, as Grok Build's own message.
    const posted = agentMessages(w, started.thread_id, key).at(-1)!;
    expect(posted.body).toBe("Fixed: refunds are subtracted now.");
    expect(posted.reply_to).toBe(second.turn!.replies[0]!);
    expect(second.activity.tools.map((t) => t.title)).toEqual(["Read src/invoice.ts", "Edit src/invoice.ts"]);
  }, 60_000);

  test("4: a permission is a card, the thread is in Stopped on you, the answer goes back as given; Stop answers cancelled", async () => {
    const w = await world({
      turns: [
        [{ permission: { title: "Run `rm -rf build`" } }, { say: "Cleaned." }],
        [{ permission: { title: "Run `make deploy`" } }, { say: "never" }],
      ],
    });
    const started = await startRun(w);
    const key = started.run.key;
    const waiting = await until(async () => (await status(w, key)).permission, "the permission");
    expect(waiting.title).toBe("Run `rm -rf build`");
    expect(waiting.options.map((o) => o.id)).toEqual(["allow-once", "allow-always", "reject-once"]);
    expect((await status(w, key)).state).toBe("permission");
    const list = (await (await fetch(`${w.base}/api/inbox/threads?archived=exclude`)).json()) as InboxListModel;
    const row = list.sections.flatMap((s) => s.threads).find((r) => r.thread_id === started.thread_id)!;
    expect(row.section).toBe("stopped");
    expect(row.run).toMatchObject({ key, state: "permission", permission_title: "Run `rm -rf build`" });
    // A stale request id is refused; the real one goes back as given.
    expect((await post(w, `/api/inbox/acp/${key}/permission`, { permission_id: "prm_nope", option_id: "allow-once" })).status).toBe(409);
    expect((await post(w, `/api/inbox/acp/${key}/permission`, { permission_id: waiting.id, option_id: "allow-always" })).status).toBe(200);
    const first = await ended(w, key, 1);
    expect(first.turn!.answered).toBe("final_text");
    expect(w.log().find((e) => e.event === "permission")).toMatchObject({ outcome: { outcome: "selected", optionId: "allow-always" } });
    // The second turn waits on a permission until Stop.
    const [answer] = agentMessages(w, started.thread_id, key);
    await reply(w, answer!, "Deploy it.");
    await until(async () => (await status(w, key)).permission?.title === "Run `make deploy`", "the second permission");
    expect((await post(w, `/api/inbox/acp/${key}/stop`, {})).status).toBe(200);
    const stopped = await ended(w, key, 2);
    expect(stopped.turn!.outcome).toBe("stopped");
    // A stopped turn's last words are not posted as its answer.
    expect(stopped.turn!.answered).toBe("none");
    expect(agentMessages(w, started.thread_id, key)).toHaveLength(1);
    const outcomes = w.log().filter((e) => e.event === "permission").map((e) => e.outcome);
    expect(outcomes.at(-1)).toEqual({ outcome: "cancelled" });
    expect(w.log().some((e) => e.event === "cancel")).toBe(true);
  }, 60_000);

  test("6: the Inbox stops: no agent process is left; the next start reads the turn as interrupted and sends nothing again", async () => {
    const w = await world({ turns: [[{ spawnStubborn: true }, { sleep: 60_000 }]] });
    const started = await startRun(w);
    const key = started.run.key;
    const stubborn = await stubbornOf(w);
    const agentPid = await until(() => w.server.runner.pids()[0], "the agent's pid");
    await w.restart();
    await until(() => !alive(agentPid) && !alive(stubborn), "the agent and its grandchild to be gone", 10_000);
    const run = await status(w, key);
    expect(run.turn!.outcome).toBe("interrupted");
    expect(w.server.store.pendingReplies(key)).toHaveLength(0);
    await Bun.sleep(300);
    expect(w.log().filter((e) => e.event === "prompt")).toHaveLength(1);
  }, 60_000);

  test("10: two idle sessions get a reply in the same tick: one agent process runs both turns, and none is left after the Inbox stops", async () => {
    const w = await world({ steps: [{ sleep: 300 }, { say: "answer" }] });
    const a = await startRun(w, "Session A, please.");
    const b = await startRun(w, "Session B, please.");
    await ended(w, a.run.key, 1);
    await ended(w, b.run.key, 1);
    // Both sessions are idle and the process is gone (a restart): the next two turns start together.
    await w.restart();
    const before = w.log().filter((e) => e.event === "initialize").length;
    const answerA = agentMessages(w, a.thread_id, a.run.key)[0]!;
    const answerB = agentMessages(w, b.thread_id, b.run.key)[0]!;
    // Written in one synchronous tick, as two Sends the event loop handles back to back.
    w.server.store.sendReply(answerA.id, { idempotency_key: "r-a", words: "And again for A." });
    w.server.store.sendReply(answerB.id, { idempotency_key: "r-b", words: "And again for B." });
    const doneA = await ended(w, a.run.key, 2);
    const doneB = await ended(w, b.run.key, 2);
    expect(doneA.turn!.outcome).toBe("done");
    expect(doneB.turn!.outcome).toBe("done");
    const inits = w.log().filter((e) => e.event === "initialize").slice(before);
    expect(inits).toHaveLength(1);
    const prompts = w.log().filter((e) => e.event === "prompt").slice(-2);
    expect(new Set(prompts.map((e) => e.pid))).toEqual(new Set([inits[0]!.pid]));
    expect(agentMessages(w, a.thread_id, a.run.key)).toHaveLength(2);
    expect(agentMessages(w, b.thread_id, b.run.key)).toHaveLength(2);
    const pid = inits[0]!.pid as number;
    w.server.stop();
    servers.splice(servers.indexOf(w.server), 1);
    await until(() => !alive(pid), "the agent to be gone after stop", 6_000);
    // Every process the runner ever started is gone.
    for (const e of w.log().filter((e) => e.event === "initialize")) expect(alive(e.pid as number)).toBe(false);
  }, 60_000);

  test("11: Stop on one of two turns running at once stops only that one, even past the grace; the other runs on and answers", async () => {
    // One long step: the agent does not end A's turn within the 1.5 s grace, so Stop gives up on it,
    // and must not kill the process B's turn runs on.
    const w = await world({ turns: [[{ sleep: 4000 }, { say: "finished" }]] });
    const a = await startRun(w, "Session A, please.");
    const b = await startRun(w, "Session B, please.");
    await until(async () => (await status(w, a.run.key)).state === "working" && (await status(w, b.run.key)).state === "working", "both turns working");
    expect(w.server.runner.pids()).toHaveLength(1);
    const pid = w.server.runner.pids()[0]!;
    expect((await post(w, `/api/inbox/acp/${a.run.key}/stop`, {})).status).toBe(200);
    const stoppedA = await ended(w, a.run.key, 1);
    expect(stoppedA.turn!.outcome).toBe("stopped");
    // B's turn still runs on the same process.
    expect((await status(w, b.run.key)).state).toBe("working");
    expect(alive(pid)).toBe(true);
    const doneB = await ended(w, b.run.key, 1);
    expect(doneB.turn!.outcome).toBe("done");
    expect(doneB.turn!.answered).toBe("final_text");
    expect(agentMessages(w, b.thread_id, b.run.key).map((m) => m.body)).toContain("finished");
    expect(agentMessages(w, a.thread_id, a.run.key)).toHaveLength(0);
    // Only A's session was cancelled.
    expect(w.log().filter((e) => e.event === "cancel")).toHaveLength(1);
  }, 60_000);

  test("15: a start that hangs in initialize (ignoring SIGTERM and stdin's end): Stop ends the turn and kills it, the next start is not stuck behind it, and the Inbox's stop kills a start at once", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-acp-hang-")));
    roots.push(dir);
    const hang = hangingAgent(dir);
    const w = await world({}, { launch: hang.launch });
    const a = await startRun(w, "Session A, please.");
    const first = await until(() => hang.read(), "the hanging agent to start");
    expect((await status(w, a.run.key)).state).toBe("starting");
    expect((await post(w, `/api/inbox/acp/${a.run.key}/stop`, {})).status).toBe(200);
    // Past the 1.5 s grace: the turn ends as stopped, nothing sent, and the process group gets SIGTERM, then SIGKILL.
    const stopped = await ended(w, a.run.key, 1);
    expect(stopped.turn!.outcome).toBe("stopped");
    await until(() => !alive(first.pid), "the hung agent to be gone", 10_000);
    // A later session starts its own process: it does not wait on the hung start.
    const b = await startRun(w, "Session B, please.");
    const second = await until(() => {
      const read = hang.read();
      return read && read.pid !== first.pid ? read : null;
    }, "a new agent process");
    expect((await status(w, b.run.key)).state).toBe("starting");
    // The Inbox's own stop kills a process still starting, at once (SIGKILL: it ignores SIGTERM).
    w.server.stop();
    servers.splice(servers.indexOf(w.server), 1);
    await until(() => !alive(second.pid), "the starting agent to be killed with the Inbox", 2_000);
  }, 60_000);

  test("16: an agent that never answers initialize fails the turn after the start timeout, in plain words, and is killed", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-acp-hang-")));
    roots.push(dir);
    const hang = hangingAgent(dir);
    const w = await world({}, { launch: hang.launch, startTimeoutMs: 2000 });
    const started = await startRun(w);
    const agent = await until(() => hang.read(), "the hanging agent to start");
    const run = await ended(w, started.run.key, 1);
    expect(run.turn!.outcome).toBe("failed");
    expect(run.turn!.error).toBe("Grok Build did not answer within 2 s of starting, so nothing was sent. Try again.");
    expect(w.server.store.pendingReplies(started.run.key).map((m) => m.id)).toContain(started.thread_id);
    await until(() => !alive(agent.pid), "the hung agent to be gone", 10_000);
  }, 60_000);

  test("17: the agent never starts as another session: the session tag, Pi's session, Codex's thread and Claude Code's marker are dropped from its environment", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-acp-hang-")));
    roots.push(dir);
    const hang = hangingAgent(dir);
    const w = await world(
      {},
      {
        launch: hang.launch,
        // An Inbox started from a Codex shell inside Claude Code, say: every identity is in its environment.
        env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses_x", PI_SESSION_ID: "pi_session_1", CODEX_THREAD_ID: "019a0000-0000-7000-8000-000000000000", CLAUDECODE: "1", KEEP_ME: "yes" },
      },
    );
    await startRun(w);
    const started = await until(() => hang.read(), "the agent to start");
    expect(started.env).toEqual({ PLANNOTATOR_SESSION_TAG: null, PI_SESSION_ID: null, CODEX_THREAD_ID: null, CLAUDECODE: null, KEEP_ME: "yes" });
  }, 60_000);

  test("18: the agent exits or crashes by itself: what it started (a grandchild that ignores SIGTERM) is killed with its group", async () => {
    for (const code of [1, 0]) {
      const w = await world({ turns: [[{ spawnStubborn: true }, { exit: code }]] });
      const started = await startRun(w);
      const stubborn = await stubbornOf(w);
      const run = await ended(w, started.run.key, 1);
      expect(run.turn!.outcome).toBe("failed");
      // SIGTERM to the group as the agent exits, SIGKILL 3 s later: nothing it started outlives it.
      await until(() => !alive(stubborn), `the grandchild to be gone after exit ${code}`, 8_000);
    }
  }, 60_000);

  test("19: the Inbox stops inside a stopped agent's grace: what it started is killed now, not left behind when the SIGKILL timer never fires", async () => {
    const w = await world({ turns: [[{ spawnStubborn: true }, { sleep: 60_000 }]] });
    const started = await startRun(w);
    const stubborn = await stubbornOf(w);
    await until(async () => (await status(w, started.run.key)).state === "working", "the turn working");
    expect((await post(w, `/api/inbox/acp/${started.run.key}/stop`, {})).status).toBe(200);
    // Past Stop's 1.5 s grace the process is disposed: SIGTERM to its group, SIGKILL due 3 s later.
    const run = await ended(w, started.run.key, 1);
    expect(run.turn!.outcome).toBe("stopped");
    expect(alive(stubborn)).toBe(true);
    // The Inbox stops inside that grace: the grandchild is killed at once, well before the timer would.
    w.server.stop();
    servers.splice(servers.indexOf(w.server), 1);
    await until(() => !alive(stubborn), "the grandchild to be killed with the Inbox", 1_500);
  }, 60_000);

  test("12: the agent crashes mid-turn: the turn fails in plain words, nothing is sent again, and the next reply starts a new process", async () => {
    const w = await world({ turns: [[{ say: "Looking at it" }, { exit: 3 }], [{ say: "back again" }]] });
    const started = await startRun(w);
    const key = started.run.key;
    const failed = await ended(w, key, 1);
    expect(failed.turn!.outcome).toBe("failed");
    expect(failed.turn!.error).toBe("Grok Build stopped while it ran.");
    // The message reached the agent before it crashed: never sent again.
    expect(w.server.store.pendingReplies(key)).toHaveLength(0);
    expect(w.server.runner.pids()).toHaveLength(0);
    const first = w.log().find((e) => e.event === "initialize")!.pid as number;
    expect(alive(first)).toBe(false);
    // The person writes again: a new process loads the session (its first prompt, so turn 1's script again exits).
    const root = thread(w, started.thread_id).messages[0]!;
    expect((await reply(w, root, "Try again, please.")).status).toBe(200);
    await ended(w, key, 2);
    expect(w.log().filter((e) => e.event === "initialize")).toHaveLength(2);
    expect(w.log().filter((e) => e.event === "loadSession")).toHaveLength(1);
  }, 60_000);

  test("13: a tailnet guest is refused with owner_only on the runner and on the threads it runs; the owner is let in", async () => {
    const w = await world({ steps: [{ say: "ok" }] }, { tailnet: true });
    const listener = w.server.tailscale.listenerPort();
    expect(listener).not.toBeNull();
    const origin = `https://${MAGIC}:${w.server.port}`;
    const through = (path: string, login: string, init: { method?: string; body?: Record<string, unknown> } = {}) =>
      fetch(`http://127.0.0.1:${listener}${path}`, {
        method: init.method ?? "GET",
        headers: { Host: `${MAGIC}:${w.server.port}`, "Tailscale-User-Login": login, Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
        ...(init.body ? { body: JSON.stringify({ serverSession: w.server.serverSession, ...init.body }) } : {}),
      });
    const codeOf = async (r: Response) => [r.status, ((await r.json()) as { code?: string }).code];
    expect(await codeOf(await through("/api/inbox/acp", GUEST))).toEqual([403, "owner_only"]);
    expect(
      await codeOf(await through("/api/inbox/acp/start", GUEST, { method: "POST", body: { agent: "grok", project_id: w.projectId, body: "hi", idempotency_key: "k-guest" } })),
    ).toEqual([403, "owner_only"]);
    expect((await through("/api/inbox/acp", OWNER)).status).toBe(200);
    // The owner starts a session through the tailnet; the guest may not steer it.
    const started = await through("/api/inbox/acp/start", OWNER, { method: "POST", body: { agent: "grok", project_id: w.projectId, body: "From my phone.", idempotency_key: "k-owner" } });
    expect(started.status).toBe(200);
    const { thread_id, run } = (await started.json()) as { thread_id: string; run: { key: string } };
    await ended(w, run.key, 1);
    expect(await codeOf(await through(`/api/inbox/acp/${run.key}/stop`, GUEST, { method: "POST", body: {} }))).toEqual([403, "owner_only"]);
    const answer = agentMessages(w, thread_id, run.key)[0]!;
    expect(await codeOf(await through(`/api/inbox/messages/${answer.id}/reply`, GUEST, { method: "POST", body: { idempotency_key: "r-guest", words: "Delete everything." } }))).toEqual([403, "owner_only"]);
    expect(thread(w, thread_id).messages.some((m) => m.body.includes("Delete everything."))).toBe(false);
    expect((await through(`/api/inbox/messages/${answer.id}/reply`, OWNER, { method: "POST", body: { idempotency_key: "r-owner", words: "Thanks." } })).status).toBe(200);
  }, 60_000);

  test("14: a 👍 on the session's answer runs no turn, and the row never says it was delivered", async () => {
    const w = await world({ steps: answersInInbox("Totals fixed.") }, { setAsideDelayMs: 200 });
    const started = await startRun(w);
    const key = started.run.key;
    await ended(w, key, 1);
    const answer = agentMessages(w, started.thread_id, key)[0]!;
    expect((await post(w, `/api/inbox/messages/${answer.id}/ack`, {})).status).toBe(200);
    await until(() => w.server.store.message(answer.id)?.ack?.settled_seq != null, "the 👍 to settle");
    const row = await until(async () => {
      const list = (await (await fetch(`${w.base}/api/inbox/threads?archived=exclude`)).json()) as InboxListModel;
      const found = list.sections.flatMap((s) => s.threads).find((r) => r.thread_id === started.thread_id);
      return found?.delivery?.kind === "ack" && found.delivery.reason !== "ack_pending" ? found : null;
    }, "the row's 👍 delivery");
    expect(row.delivery).toMatchObject({ kind: "ack", state: "saved", reason: "reads", at: null });
    await Bun.sleep(300);
    expect(w.log().filter((e) => e.event === "prompt")).toHaveLength(1);
    expect((await status(w, key)).turns).toHaveLength(1);
  }, 60_000);

  test("7: a failing session/load sends nothing and says why", async () => {
    const w = await world({ loadSessionError: "the session file is unreadable", turns: [answersInInbox("Hello.")] });
    const started = await startRun(w);
    const key = started.run.key;
    await ended(w, key, 1);
    const [answer] = agentMessages(w, started.thread_id, key);
    const sent = (await (await reply(w, answer!, "And the tax lines?")).json()) as { reply: InboxMessage };
    const failed = await ended(w, key, 2);
    expect(failed.turn!.outcome).toBe("failed");
    expect(failed.turn!.error).toContain("could not reopen this session, so nothing was sent");
    expect(w.server.store.message(sent.reply.id)!.delivery ?? null).toBeNull();
    expect(w.log().filter((e) => e.event === "prompt")).toHaveLength(1);
    // Never a fallback to a new session (it would lose the history).
    expect(w.log().filter((e) => e.event === "newSession")).toHaveLength(1);
  }, 60_000);

  test("8: the guards refuse another site and a stale serverSession", async () => {
    const w = await world({ turns: [[{ say: "hi" }]] });
    const body = { agent: "grok", project_id: w.projectId, body: "x", idempotency_key: "g1" };
    expect((await post(w, "/api/inbox/acp/start", body, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await post(w, "/api/inbox/acp/start", { ...body, serverSession: "not-this-one" })).status).toBe(409);
    expect((await fetch(`${w.base}/api/inbox/acp`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(w.server.store.listRows()).toHaveLength(0);
  }, 30_000);

  test("9: an `_x.ai/*` notification carrying a secret never reaches disk, the window or the list", async () => {
    const w = await world({ turns: [[{ extNotify: { method: "_x.ai/mcp/servers_updated", params: { servers: [{ name: "github", env: { GITHUB_TOKEN: SECRET } }] } } }, { say: "ok" }]] });
    const events: string[] = [];
    const controller = new AbortController();
    void fetch(`${w.base}/api/inbox/events?cursor=0&window=w-acp-test-1&permission=default&origin=http%3A%2F%2Flocalhost`, { signal: controller.signal })
      .then(async (res) => {
        const reader = res.body!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          events.push(new TextDecoder().decode(value));
        }
      })
      .catch(() => {});
    const started = await startRun(w);
    const run = await ended(w, started.run.key, 1);
    expect(w.log().some((e) => e.event === "extNotify")).toBe(true);
    controller.abort();
    expect(JSON.stringify(run)).not.toContain(SECRET);
    expect(events.join("")).not.toContain(SECRET);
    expect(events.join("")).toContain("event: runs");
    expect(JSON.stringify(await (await fetch(`${w.base}/api/inbox/threads`)).json())).not.toContain(SECRET);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    for (const file of walk(w.dataDir)) expect(readFileSync(file, "utf8").includes(SECRET)).toBe(false);
  }, 60_000);
});
