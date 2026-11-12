/**
 * Codex through the real launch engine (inbox-launch.ts with its own hosts) and the real Codex wake
 * (inbox-codex-wake.ts), against the fake `codex` (tests/helpers/fake-codex-launch.ts), never the real one. What each
 * test guards: To offers Codex only with `codex` there, signed in and connected to the Inbox; a Send starts one
 * `codex app-server` in the project's folder with the person's env, starts a thread there and puts the root in as its
 * first turn (never through `codex queue`); a reply is a new turn; Stop interrupts the running turn and ends the
 * process, and the next reply resumes the thread; no login is a clear line; a failed turn is a note; an approval is
 * the permission card; the person's `config.toml` is never written. No Inbox server is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PERMISSION_ALLOW_ONCE } from "@plannotator/core/inbox-permission";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeCodexLaunch, type FakeCodexLaunchState } from "../../tests/helpers/fake-codex-launch";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { createInboxCodexWake } from "./inbox-codex-wake";
import { createInboxLaunch } from "./inbox-launch";
import { CODEX_SIGNED_OUT, codexLoginStatusSignedOut, codexSpawnEnv, codexTrustOverride, codexWritesTrust } from "./inbox-launch-codex";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function until<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(25);
  }
}

const CONFIG = ['sandbox_mode = "workspace-write"', "", "[mcp_servers.plannotator-inbox]", 'command = "plannotator"', 'args = ["inbox", "mcp"]', ""].join("\n");

function setup(options: { state?: FakeCodexLaunchState; config?: string | null; withCodex?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-codex-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  const codexHome = join(home, ".codex");
  for (const dir of [home, dataDir, folder, codexHome]) mkdirSync(dir, { recursive: true });
  if (options.config !== null) writeFileSync(join(codexHome, "config.toml"), options.config ?? CONFIG);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const fake = installFakeCodexLaunch(join(root, "fake"), options.state ?? {});
  const bin = options.withCodex === false ? join(root, "empty-bin") : fake.bin;
  mkdirSync(bin, { recursive: true });
  const path = `${bin}:/usr/bin:/bin`;
  cleanup.push(() => {
    // Any app-server still up (a failed test) ends with its stdin's owner; this is the backstop.
    for (const start of fake.starts()) if (fake.alive(start.pid)) process.kill(start.pid, "SIGKILL"); // inbox-guard: own child (the fake codex)
  });
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "project", root: folder });
  const clock = { ahead: 0 };
  const launch = createInboxLaunch({
    store,
    // Codex has no bridge poll: its host's own process is what is live.
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    // The login shell: the person's CODEX_HOME, a name of its own, an outer Codex thread's marker, Plannotator's own names.
    loginEnv: async () => ({ HOME: home, PATH: path, CODEX_HOME: codexHome, LOGIN_ONLY: "from-login", CODEX_THREAD_ID: "outer-thread", PLANNOTATOR_PORT: "1", PLANNOTATOR_TEST_SANDBOX: "1" }),
    ownEnv: () => ({ HOME: home, PATH: path }),
    installDirs: [],
    displayFolder: (p) => p,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["plannotator"],
    now: () => Date.now() + clock.ahead,
  });
  cleanup.push(() => launch.stop());
  const wake = createInboxCodexWake({
    store,
    environment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: path } }),
    commandOf: (item) => ({ type: item.reply_to ? "reply" : "message", id: item.id, thread_id: item.thread_id, reply_to: item.reply_to ?? null, subject: item.subject ?? null, body: item.body, url: `http://127.0.0.1/#${item.thread_id}` }),
    deliver: (session, text) => launch.deliver("codex", session, text),
    launched: (session) => launch.launched("codex", session),
    extraClis: [],
    log: () => {},
  });
  cleanup.push(() => wake.stop());
  const send = async (body: string) => {
    const target = launch.target({ launch: { agent: "codex", project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body, resolveProject: async () => project });
    const message = store.startPersonThread({ project_id: project.id, body, to: prepared.to, idempotency_key: `send-${body}`, thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(message);
    return message;
  };
  const stopRoute = (launchId: string) =>
    launch.route(new Request(`http://127.0.0.1/api/inbox/launch/${launchId}/stop`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ server_session: "srv" }) }), `/api/inbox/launch/${launchId}/stop`, "local");
  return { store, project, folder, dataDir, codexHome, fake, launch, wake, clock, send, stopRoute };
}

describe("Codex through the launch engine, against the fake codex", () => {
  test("To offers Codex only once codex is there, signed in and connected to the Inbox", async () => {
    const ready = setup();
    expect((await ready.launch.composeBlock())!.agents.map((a) => a.agent)).toContain("codex");

    const missing = setup({ withCodex: false });
    const block = (await missing.launch.composeBlock())!;
    expect(block.agents.map((a) => a.agent)).not.toContain("codex");
    expect(block.not_ready).toContainEqual({ agent: "codex", name: "Codex", code: "missing" });

    const signedOut = setup({ state: { login: "none" } });
    const out = (await signedOut.launch.composeBlock())!;
    expect(out.agents.map((a) => a.agent)).not.toContain("codex");
    expect(out.not_ready).toContainEqual({ agent: "codex", name: "Codex", code: "signed_out" });

    const notConnected = setup({ config: 'model = "gpt-5"\n' });
    expect((await notConnected.launch.composeBlock())!.not_ready).toContainEqual({ agent: "codex", name: "Codex", code: "tool_off" });
  });

  test("Send starts codex app-server in the folder with the person's env, starts a thread there and the root is its first turn", async () => {
    const t = setup();
    const before = readFileSync(join(t.codexHome, "config.toml"), "utf8");
    const root = await t.send("Tidy the readme.");
    const thread = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.store.message(root.id)!.to).toEqual({ host: "codex", session: thread });

    const [start] = t.fake.starts();
    expect(start!.argv).toEqual(["app-server"]);
    expect(start!.cwd).toBe(t.folder);
    expect(start!.env).toMatchObject({ CODEX_HOME: t.codexHome, LOGIN_ONLY: "from-login", PLANNOTATOR_DATA_DIR: t.dataDir });
    expect(start!.env.CODEX_THREAD_ID).toBeUndefined();
    expect(start!.env.PLANNOTATOR_PORT).toBeUndefined();

    const [started] = t.fake.rpc("thread/start");
    expect(started!.params.cwd).toBe(t.folder);
    // The MCP entry reaches this Inbox (Codex starts MCP servers with a clean env); the folder's trust stays in memory.
    expect(started!.params.config["mcp_servers.plannotator-inbox.env.PLANNOTATOR_DATA_DIR"]).toBe(t.dataDir);
    expect(started!.params.config.projects).toEqual({ [t.folder]: { trust_level: "trusted" } });
    // Nothing of the person's choice on the thread: their model, sandbox and approvals are Codex's own config.
    expect(Object.keys(started!.params).sort()).toEqual(["config", "cwd"]);
    expect(t.fake.rpc("thread/name/set")[0]!.params).toEqual({ threadId: thread, name: "Tidy" });

    await until("the root went in as a turn", () => t.fake.turnTexts().some((text) => text.includes("Tidy the readme.")));
    await until("the root marked delivered to that thread", () => t.store.message(root.id)!.delivery);
    expect(t.store.message(root.id)!.delivery).toMatchObject({ host: "codex", session: thread });
    expect(t.fake.calls().some((call) => call.event === "cli" && call.argv[0] === "queue")).toBe(false);
    expect(readFileSync(join(t.codexHome, "config.toml"), "utf8")).toBe(before);
  });

  test("a reply is a new turn on the same app-server; Stop interrupts the turn and ends it; the next reply resumes the thread", async () => {
    const t = setup();
    const root = await t.send("First SLOW job.");
    const thread = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    await until("working", async () => (await t.launch.runOf(root.id))?.state === "working");

    // While the slow turn runs, a reply goes in too (Codex runs it after the running one).
    const one = t.store.sendReply(root.id, { words: "Also check the tests.", idempotency_key: "reply-1" }).reply!;
    await until("the reply went in as a turn", () => t.fake.turnTexts().some((text) => text.includes("Also check the tests.")));
    await until("the reply marked delivered", () => t.store.message(one.id)!.delivery);
    expect(t.fake.starts()).toHaveLength(1);

    const stopped = await t.stopRoute(t.store.message(root.id)!.launch!.id);
    expect(stopped!.status).toBe(200);
    const [interrupt] = t.fake.rpc("turn/interrupt");
    expect(interrupt!.params.threadId).toBe(thread);
    const pid = t.fake.starts()[0]!.pid;
    await until("the app-server ended", () => !t.fake.alive(pid));
    expect(await t.launch.runOf(root.id)).toMatchObject({ state: "stopped" });

    t.store.sendReply(root.id, { words: "Please go on.", idempotency_key: "reply-2" });
    const again = await until("a second app-server", () => t.fake.starts()[1]);
    await until("it resumed the thread", () => t.fake.rpc("thread/resume").some((call) => call.pid === again.pid && call.params.threadId === thread));
    await until("the new reply went in on it", () => t.fake.rpc("turn/start").some((call) => call.pid === again.pid && JSON.stringify(call.params.input).includes("Please go on.")));
    expect(t.fake.rpc("thread/start")).toHaveLength(1);
  }, 30_000);

  test("Codex that refuses a second turn gets the reply steered into the running one", async () => {
    const t = setup({ state: { refuseSecondTurn: true } });
    const root = await t.send("A SLOW job.");
    await until("working", async () => (await t.launch.runOf(root.id))?.state === "working");
    const reply = t.store.sendReply(root.id, { words: "Steer this in.", idempotency_key: "reply-1" }).reply!;
    await until("steered", () => t.fake.rpc("turn/steer").some((call) => JSON.stringify(call.params.input).includes("Steer this in.")));
    await until("delivered", () => t.store.message(reply.id)!.delivery);
  }, 20_000);

  test("no Codex login: the start fails with how to sign in, and the message is kept", async () => {
    // `codex login status` says signed in (To offered it), but Codex's own account read finds no login.
    const t = setup({ state: { login: "chatgpt" } });
    const target = t.launch.target({ launch: { agent: "codex", project_id: t.project.id } })!;
    const prepared = await t.launch.prepare(target, { name: "Tidy", body: "Hello", resolveProject: async () => t.project });
    t.fake.set({ login: "none" });
    const root = t.store.startPersonThread({ project_id: t.project.id, body: "Hello", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy", launch: prepared.launch }).message;
    t.launch.begin(root);
    await until("the start failed", () => t.store.message(root.id)!.launch!.error);
    expect(t.store.message(root.id)!.launch!.error).toMatchObject({ code: "failed", text: CODEX_SIGNED_OUT });
    expect(await t.launch.runOf(root.id)).toMatchObject({ state: "failed", cause: CODEX_SIGNED_OUT });
    expect(t.fake.rpc("thread/start")).toHaveLength(0);
    await until("its app-server ended", () => t.fake.starts().every((start) => !t.fake.alive(start.pid)));
  });

  test("a turn that fails is one note in the thread, with Codex's own words", async () => {
    const t = setup({ state: { failTurn: "Your access token could not be refreshed. Please log out and sign in again." } });
    const root = await t.send("Do it.");
    const note = await until("the note", () =>
      t.store
        .threadMessageIds(root.id)
        .map((id) => t.store.message(id)!)
        .find((m) => m.author.kind === "agent" && m.body.startsWith("Codex's turn ended with an error:")),
    );
    expect(note.body).toBe("Codex's turn ended with an error: Your access token could not be refreshed. Please log out and sign in again.");
    expect(note.author).toMatchObject({ host: "codex", name: "Codex" });
    // Marked for the window's notification ("Codex couldn't answer").
    expect(note.turn_error).toBe(true);
  });

  test("an approval is the permission card, and Allow once answers accept", async () => {
    const t = setup();
    const root = await t.send("Please APPROVE this.");
    const question = await until("the card", () => {
      const ids = t.store.threadMessageIds(root.id);
      const id = ids.find((m) => t.store.message(m)!.author.kind === "agent" && t.store.questionsOf(m).length > 0);
      return id ? t.store.questionsOf(id)[0]! && { id, q: t.store.questionsOf(id)[0]! } : null;
    });
    expect(question.q.choices.map((c) => c.label)).toEqual(["Allow once", "Allow `touch approved.txt` for this session", "Deny"]);
    const picked = { v: 1 as const, key: question.q.key, kind: "single" as const, prompt: question.q.prompt, selected: [INBOX_PERMISSION_ALLOW_ONCE] };
    const saved = t.store.savePicks(question.id, [{ key: question.q.key, revision: question.q.revision, answer: picked }], { unsentOnly: true, confirmFull: false });
    t.store.sendReply(question.id, { idempotency_key: "answer-1", questions: [{ key: question.q.key, revision: saved[0]!.revision }] });
    t.launch.sweep(true);
    await until("Codex got accept", () => {
      t.launch.sweep(true);
      return t.fake.calls().some((call) => call.event === "answer" && call.method === "item/commandExecution/requestApproval" && JSON.stringify(call.result) === JSON.stringify({ decision: "accept" }));
    });
  });
});

describe("Codex host pieces", () => {
  test("the spawn env keeps the person's names and drops Plannotator's and an outer Codex thread's", () => {
    expect(codexSpawnEnv({ PATH: "/bin", CODEX_HOME: "/h/.codex", CODEX_THREAD_ID: "t", CODEX_SANDBOX: "seatbelt", PLANNOTATOR_PORT: "1", OPENAI_API_KEY: "k" }, "/data")).toEqual({
      PATH: "/bin",
      CODEX_HOME: "/h/.codex",
      OPENAI_API_KEY: "k",
      PLANNOTATOR_DATA_DIR: "/data",
    });
    expect(codexSpawnEnv({ PATH: "/bin" }, null)).toEqual({ PATH: "/bin" });
  });

  test("trust is passed in memory only where Codex itself would write it", () => {
    const writes = 'sandbox_mode = "workspace-write"\n';
    expect(codexWritesTrust(writes)).toBe(true);
    expect(codexWritesTrust("")).toBe(false);
    expect(codexTrustOverride(writes, "/p", "/p", null, true)).toEqual({ projects: { "/p": { trust_level: "trusted" } } });
    // The person's own decision stands, trusted or not.
    expect(codexTrustOverride(`${writes}[projects."/p"]\ntrust_level = "untrusted"\n`, "/p", "/p", null, true)).toEqual({});
    expect(codexTrustOverride(`${writes}[projects."/repo"]\ntrust_level = "trusted"\n`, "/repo/sub", "/repo/sub", "/repo", true)).toEqual({});
    expect(codexTrustOverride("", "/p", "/p", null, false)).toEqual({});
  });

  test("codex login status is signed out only when it says so", () => {
    expect(codexLoginStatusSignedOut({ exitCode: 1, stdout: "", stderr: "Not logged in\n" })).toBe(true);
    expect(codexLoginStatusSignedOut({ exitCode: 0, stdout: "", stderr: "Logged in using ChatGPT\n" })).toBe(false);
    expect(codexLoginStatusSignedOut({ exitCode: 1, stdout: "", stderr: "Error checking login status: boom\n" })).toBe(false);
  });
});
