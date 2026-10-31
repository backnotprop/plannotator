/**
 * The Codex launch host (inbox-launch-codex.ts, inbox-launch-codex-permission.ts), on a real launch engine
 * over a temp data dir, with a fake `codex` and its fake app-server daemon (tests/helpers/fake-codex/) on the
 * engine's PATH and a temp HOME. The real Codex is never run.
 *
 * What it guards: the person's config.toml is never written (a new folder's trust goes in memory); the first
 * turn and every reply go in as `turn/start`, and as `codex queue` while a turn runs; Stop interrupts only a
 * running turn (an idle one would hang) and a reply after Stop starts a turn again; an approval request
 * becomes the permission card (no mode choices), its answer goes back as Codex's decision, a request sent
 * again is the same card, and one answered in Terminal is withdrawn; Delete deletes the thread.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PERMISSION_ALLOW_ONCE, INBOX_PERMISSION_ANSWERED_IN_TERMINAL, INBOX_PERMISSION_AUTO, INBOX_PERMISSION_DENY, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL, inboxPermissionAnswer, inboxPermissionChoices } from "@plannotator/core/inbox-permission";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeCodex, type FakeCodex, type FakeCodexConfig } from "../../tests/helpers/fake-codex";
import { createInboxLaunch } from "./inbox-launch";
import { codexHostState, codexTrustOverride, parseDaemonStart } from "./inbox-launch-codex";
import { CODEX_COMMAND_APPROVAL, CODEX_FILE_APPROVAL, CODEX_PERMISSION_TERMS, CODEX_PERMISSIONS_APPROVAL, codexDecision, codexDiffEdits, codexPermissionEvent, createCodexPermissions } from "./inbox-launch-codex-permission";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

const THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const messagesOf = (store: InboxStore, threadId: string): InboxMessage[] => store.thread(threadId)?.messages ?? [];

describe("the pure parts", () => {
  test("a folder with no trust gets it in memory; one the person trusted (itself, its real path or its repository) gets none", () => {
    const trusted = { projects: { "/real/app": { trust_level: "trusted" }, "/link/app": { trust_level: "trusted" } } };
    expect(codexTrustOverride(null, "/link/app", "/real/app", null)).toEqual(trusted);
    expect(codexTrustOverride('model = "gpt-5"\n', "/link/app", "/real/app", null)).toEqual(trusted);
    expect(codexTrustOverride('[projects."/real/app"]\ntrust_level = "untrusted"\n', "/link/app", "/real/app", null)).toEqual({});
    expect(codexTrustOverride('[projects."/link/app"]\ntrust_level = "trusted"\n', "/link/app", "/real/app", null)).toEqual({});
    expect(codexTrustOverride('[projects."/repo"]\ntrust_level = "trusted"\n', "/repo/app", "/repo/app", "/repo")).toEqual({});
    // An entry with no trust level is no trust: Codex would write one.
    expect(codexTrustOverride('[projects."/repo/app"]\nnote = "x"\n', "/repo/app", "/repo/app", null)).toEqual({ projects: { "/repo/app": { trust_level: "trusted" } } });
  });

  test("a thread's status is the run line's host state; one not loaded is absent", () => {
    expect(codexHostState(null)).toBe("absent");
    expect(codexHostState({ type: "notLoaded" })).toBe("absent");
    expect(codexHostState({ type: "idle" })).toEqual({ status: "idle", state: "idle", waitingFor: null });
    expect(codexHostState({ type: "systemError" })).toEqual({ status: "idle", state: "error", waitingFor: null });
    expect(codexHostState({ type: "active", activeFlags: [] })).toEqual({ status: "busy", state: "working", waitingFor: null });
    expect(codexHostState({ type: "active", activeFlags: ["waitingOnApproval"] })).toEqual({ status: "waiting", state: "working", waitingFor: "approval" });
  });

  test("daemon start's JSON line names the socket and the app-server's own version (not the CLI's)", () => {
    const line = '{"status":"running","socketPath":"/h/.codex/app-server-control/app-server-control.sock","managedCodexVersion":"0.160.0","cliVersion":"0.165.0"}';
    expect(parseDaemonStart(`starting\n${line}\n`)).toEqual({ socketPath: "/h/.codex/app-server-control/app-server-control.sock", appServerVersion: "0.160.0" });
    expect(parseDaemonStart("Error: no")).toBeNull();
  });

  test("a command is a Bash card; its session choice only when the command is shown exactly", () => {
    const params = { threadId: THREAD, cwd: "/p", command: "bun run build", reason: "Build it", itemId: "i1", turnId: "t1" };
    const event = codexPermissionEvent(CODEX_COMMAND_APPROVAL, params, undefined)!;
    expect(event).toMatchObject({ tool_name: "Bash", tool_input: { command: "bun run build", description: "Build it" }, cwd: "/p" });
    expect(inboxPermissionChoices(event, CODEX_PERMISSION_TERMS)).toEqual([INBOX_PERMISSION_ALLOW_ONCE, "Allow `bun run build` for this session", INBOX_PERMISSION_DENY, INBOX_PERMISSION_TERMINAL]);
    // A trailing `:*` reads as a prefix rule on the card; Codex's session cache is for the exact command.
    expect(codexPermissionEvent(CODEX_COMMAND_APPROVAL, { ...params, command: "git log:*" }, undefined)!.permission_suggestions).toEqual([]);
  });

  test("Codex has no modes: no Auto mode or Full permissions choice, and such a pick from an older card is Allow once", () => {
    const event = codexPermissionEvent(CODEX_COMMAND_APPROVAL, { threadId: THREAD, command: "ls" }, undefined)!;
    const choices = inboxPermissionChoices(event, { ...CODEX_PERMISSION_TERMS, fullPermissions: true });
    expect(choices).not.toContain(INBOX_PERMISSION_AUTO);
    expect(choices).not.toContain(INBOX_PERMISSION_FULL);
    const pick = (label: string) => ({ v: 1 as const, key: "k", kind: "single" as const, prompt: "p", selected: [label] });
    expect(inboxPermissionAnswer(pick(INBOX_PERMISSION_AUTO), event, CODEX_PERMISSION_TERMS).choice).toBe("once");
    expect(inboxPermissionAnswer(pick(INBOX_PERMISSION_FULL), event, { ...CODEX_PERMISSION_TERMS, fullPermissions: true }).choice).toBe("once");
    // Claude Code's terms are unchanged.
    expect(inboxPermissionChoices(event, {})).toContain(INBOX_PERMISSION_AUTO);
    expect(inboxPermissionAnswer(pick(INBOX_PERMISSION_AUTO), event, {}).choice).toBe("auto");
  });

  test("a patch is asked only when the card shows it whole: one new file (Write) or one changed file (Edit, MultiEdit)", () => {
    const params = { threadId: THREAD, itemId: "i1" };
    const add = { path: "/p/a.txt", kind: { type: "add" as const }, diff: "hello\n" };
    expect(codexPermissionEvent(CODEX_FILE_APPROVAL, params, [add])).toMatchObject({ tool_name: "Write", tool_input: { file_path: "/p/a.txt", content: "hello\n" } });
    const one = { path: "/p/b.ts", kind: { type: "update" as const }, diff: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n" };
    expect(codexPermissionEvent(CODEX_FILE_APPROVAL, params, [one])).toMatchObject({ tool_name: "Edit", tool_input: { file_path: "/p/b.ts", old_string: "b", new_string: "B" } });
    const two = { ...one, diff: `${one.diff}@@ -9 +9 @@\n-x\n+y\n` };
    expect(codexPermissionEvent(CODEX_FILE_APPROVAL, params, [two])).toMatchObject({ tool_name: "MultiEdit", tool_input: { edits: [{ old_string: "b", new_string: "B" }, { old_string: "x", new_string: "y" }] } });
    // Not whole or not exact: two files, a move, a delete, or no change seen.
    expect(codexPermissionEvent(CODEX_FILE_APPROVAL, params, [add, one])).toBeNull();
    expect(codexPermissionEvent(CODEX_FILE_APPROVAL, params, [{ ...one, kind: { type: "update", move_path: "/p/c.ts" } }])).toBeNull();
    expect(codexPermissionEvent(CODEX_FILE_APPROVAL, params, [{ ...add, kind: { type: "delete" } }])).toBeNull();
    expect(codexPermissionEvent(CODEX_FILE_APPROVAL, params, undefined)).toBeNull();
    expect(codexDiffEdits("no hunks")).toBeNull();
  });

  test("the answer goes back as Codex's decision; Approve in Terminal answers nothing", () => {
    expect(codexDecision(CODEX_COMMAND_APPROVAL, {}, "once")).toEqual({ decision: "accept" });
    expect(codexDecision(CODEX_COMMAND_APPROVAL, {}, "session")).toEqual({ decision: "acceptForSession" });
    expect(codexDecision(CODEX_FILE_APPROVAL, {}, "deny")).toEqual({ decision: "decline" });
    expect(codexDecision(CODEX_COMMAND_APPROVAL, {}, "terminal")).toBeNull();
    const asked = { permissions: { network: { enabled: true }, fileSystem: null } };
    expect(codexDecision(CODEX_PERMISSIONS_APPROVAL, asked, "once")).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(codexDecision(CODEX_PERMISSIONS_APPROVAL, asked, "deny")).toEqual({ permissions: {}, scope: "turn" });
  });
});

describe("the approval transport", () => {
  test("a request Codex sends again (a new id, the same item) is the same card, and the answer goes to the latest id", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-codex-perm-"));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = InboxStore.open(join(dir, "data"));
    const project = store.ensureProject({ name: "p", root: dir });
    const launch = { id: "lch_01J00000000000000000000001", agent: "codex" as const, session_ref: THREAD, folder: dir, scratch: false, started_at: new Date().toISOString() };
    const root = store.startPersonThread({ project_id: project.id, body: "Build it.", to: { host: "codex", session: THREAD }, idempotency_key: "send-1", launch }).message;
    const answers: [number | string, unknown][] = [];
    const permissions = createCodexPermissions({
      store,
      roots: () => [store.message(root.id)!],
      rootOf: () => store.message(root.id)!,
      displayFolder: (path) => path,
      host: { stateOf: () => null, readAt: () => null },
      onChange: () => {},
      respond: (id, result) => answers.push([id, result]),
      steer: () => {},
      status: () => null,
      connectedAt: () => null,
      rejoin: () => {},
    } as never);
    const params = { threadId: THREAD, turnId: "t1", itemId: "i1", approvalId: null, command: "bun run build", cwd: dir };
    permissions.asked(7, CODEX_COMMAND_APPROVAL, params);
    permissions.connectionLost();
    permissions.asked(12, CODEX_COMMAND_APPROVAL, params);
    const cards = messagesOf(store, root.thread_id).filter((m: InboxMessage) => m.author.session === `perm:${THREAD}`);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.author).toMatchObject({ host: "codex", name: "Codex" });
    const question = store.questionsOf(cards[0]!.id)[0]!;
    const picked = { v: 1 as const, key: question.key, kind: "single" as const, prompt: question.prompt, selected: [INBOX_PERMISSION_ALLOW_ONCE] };
    const saved = store.savePicks(cards[0]!.id, [{ key: question.key, revision: question.revision, answer: picked }], { unsentOnly: true });
    store.sendReply(cards[0]!.id, { idempotency_key: "answer-1", questions: [{ key: question.key, revision: saved[0]!.revision }] });
    permissions.sweep();
    permissions.sweep();
    expect(answers).toEqual([[12, { decision: "accept" }]]);
  });
});

// ── On the engine, with the fake codex ──

interface World {
  store: InboxStore;
  codex: FakeCodex;
  launch: ReturnType<typeof createInboxLaunch>;
  project: { id: string; root: string };
  home: string;
  post: (id: string, action: string) => Promise<Response | null>;
  send: (body: string, key: string) => Promise<InboxMessage>;
}

function world(options: { config?: FakeCodexConfig; configToml?: string; inboxMcp?: boolean } = {}): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-codex-")));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "ledger");
  const bin = join(root, "bin");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const codex = installFakeCodex({
    bin,
    state: join(root, "codex-state"),
    home,
    config: { workMs: 100, ...options.config },
    ...(options.inboxMcp === false ? { configToml: options.configToml ?? 'model = "gpt-5"\n' } : { inboxMcp: join(root, "plannotator", "plannotator"), ...(options.configToml ? { configToml: options.configToml } : {}) }),
  });
  restore.push(() => {
    codex.stopAll();
    rmSync(root, { recursive: true, force: true });
  });
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "ledger", root: folder });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    loginEnv: async () => env,
    ownEnv: () => env,
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["plannotator"],
  });
  restore.push(() => launch.stop());
  const post = (id: string, action: string) =>
    launch.route(new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", body: JSON.stringify({ serverSession: "srv" }) }), `/api/inbox/launch/${id}/${action}`, "local");
  const send = async (body: string, key: string) => {
    const target = launch.target({ launch: { agent: "codex", project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Ledger fix", body, resolveProject: async () => project });
    const sent = store.startPersonThread({ project_id: project.id, body, to: prepared.to, idempotency_key: key, thread_name: "Ledger fix", launch: prepared.launch }).message;
    launch.begin(sent);
    await until(() => !!store.message(sent.id)!.launch!.session_ref || !!store.message(sent.id)!.launch!.error, 10_000);
    return store.message(sent.id)!;
  };
  return { store, codex, launch, project, home, post, send };
}

async function until(check: () => boolean, ms = 5_000) {
  for (let waited = 0; waited < ms && !check(); waited += 20) await Bun.sleep(20);
  expect(check()).toBe(true);
}

const wake = (id: string, words: string) => `Plannotator Inbox: Ledger fix (${id})\nReply in the Inbox.\n\n${words}\n\n[thread x]`;

describe.skipIf(process.platform === "win32")("Codex behind LaunchHost", () => {
  test("To offers Codex only with a new enough CLI and the Inbox's MCP entry in config.toml", async () => {
    const w = world();
    expect((await w.launch.composeBlock())!.agents.map((a) => a.agent)).toEqual(["codex"]);
    const old = world({ config: { version: "0.164.0" } });
    expect((await old.launch.composeBlock())!.agents).toEqual([]);
    const unconnected = world({ inboxMcp: false });
    expect((await unconnected.launch.composeBlock())!.agents).toEqual([]);
  });

  test("Send starts the shared daemon and a thread in the folder; a new folder's trust goes in memory and config.toml stays as it was", async () => {
    const w = world();
    const before = w.codex.configToml();
    const root = await w.send("Fix the ledger rounding.", "send-1");
    const threadId = root.launch!.session_ref!;
    expect(root.launch!.error ?? null).toBeNull();
    expect(root.to).toEqual({ host: "codex", session: threadId });
    expect(w.codex.calls().some((c) => c.argv.join(" ") === "app-server daemon start")).toBe(true);
    const [started] = w.codex.rpc("thread/start");
    expect(started!.params.cwd).toBe(w.project.root);
    expect(started!.params.config.projects).toEqual({ [w.project.root]: { trust_level: "trusted" } });
    // A test Inbox: its thread's MCP talks to this data dir, not ~/.plannotator.
    expect(started!.params.config["mcp_servers.plannotator-inbox.env.PLANNOTATOR_DATA_DIR"]).toBe(process.env.PLANNOTATOR_DATA_DIR);
    expect(started!.params.approvalPolicy).toBeUndefined();
    expect(w.codex.configToml()).toBe(before);
    expect(w.codex.threads()[threadId]!.name).toBe("Ledger fix");
    // No turn yet: the Codex wake delivers the root.
    expect(w.codex.turns()).toEqual([]);
  });

  test("a folder the person already trusts gets no trust from the Inbox (theirs counts)", async () => {
    const w = world();
    const config = join(w.codex.home, "config.toml");
    writeFileSync(config, `${readFileSync(config, "utf8")}\n[projects."${w.project.root}"]\ntrust_level = "trusted"\n`);
    const before = w.codex.configToml();
    await w.send("Fix it.", "send-1");
    expect(w.codex.rpc("thread/start")[0]!.params.config.projects).toBeUndefined();
    expect(w.codex.configToml()).toBe(before);
  });

  test("a reply is a turn/start when idle and goes to codex queue while a turn runs; the line follows the thread", async () => {
    const w = world({ config: { hold: true } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "Fix it."))).toBe("delivered");
    expect(w.codex.turns()[0]).toMatchObject({ threadId, how: "turn/start" });
    expect(w.codex.turns()[0]!.text).toContain("Fix it.");
    w.store.recordDelivery(root.id, { host: "codex", session: threadId });
    expect(await w.launch.runOf(root.id)).toMatchObject({ state: "working", agent: "codex" });
    // Busy: the engine leaves it to `codex queue` (its next turn).
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "Also this."))).toBe("queue");
    // Not a launched session of ours: always the queue.
    expect(await w.launch.deliver("codex", THREAD, "x")).toBe("queue");
  });

  test("Stop with no turn running does not hang; Stop of a running turn interrupts it; a reply after Stop starts a turn again", async () => {
    const w = world({ config: { workMs: 50 } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    const at = Date.now();
    const stopped = await w.post(root.launch!.id, "stop");
    expect(stopped!.status).toBe(200);
    expect(Date.now() - at).toBeLessThan(3_000);
    expect(w.codex.rpc("turn/interrupt")).toEqual([]);
    expect(w.codex.rpc("thread/unsubscribe")).toHaveLength(1);

    // A reply after Stop: the thread is rejoined and the reply starts a turn (a queued one would wait on the interrupted thread).
    w.codex.configure({ hold: true });
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "Go on."))).toBe("delivered");
    expect(w.codex.rpc("thread/resume")).toHaveLength(1);
    await until(() => w.codex.turns().length === 1);
    await Bun.sleep(100);

    await w.post(root.launch!.id, "stop");
    const interrupts = w.codex.rpc("turn/interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.params.turnId).toBe(w.codex.turns()[0]!.turnId);
    await until(() => w.codex.turns().some((t) => t.ended === "interrupted"));

    // Again after the interrupt: a turn/start, never the paused queue.
    w.codex.configure({ hold: false });
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "Once more."))).toBe("delivered");
    await until(() => w.codex.turns().filter((t) => t.how === "turn/start").length === 2);
  });

  test("an approval request is the permission card in the thread; Allow once goes back as accept, Deny as decline", async () => {
    const w = world({ config: { prompts: [{ kind: "command", command: "bun test", reason: "Run the tests" }] } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    await w.launch.deliver("codex", threadId, wake(root.id, "Fix it."));
    const card = async () => {
      let found: InboxMessage | undefined;
      await until(() => !!(found = messagesOf(w.store, root.thread_id).filter((m: InboxMessage) => m.author.session === `perm:${threadId}`).at(-1)));
      return found!;
    };
    const first = await card();
    expect(first.author).toMatchObject({ kind: "agent", host: "codex", name: "Codex" });
    // A card never wakes the thread (the `perm:` identity).
    expect(first.wakes ?? false).toBe(false);
    const question = w.store.questionsOf(first.id)[0]!;
    expect(question.prompt).toContain("Codex");
    expect(question.choices.map((c) => c.label)).toEqual([INBOX_PERMISSION_ALLOW_ONCE, "Allow `bun test` for this session", INBOX_PERMISSION_DENY, INBOX_PERMISSION_TERMINAL]);

    const answer = (message: InboxMessage, label: string, other?: string) => {
      const q = w.store.questionsOf(message.id)[0]!;
      const picked = { v: 1 as const, key: q.key, kind: "single" as const, prompt: q.prompt, selected: other ? [] : [label], ...(other ? { other } : {}) };
      const saved = w.store.savePicks(message.id, [{ key: q.key, revision: q.revision, answer: picked }], { unsentOnly: true });
      w.store.sendReply(message.id, { idempotency_key: `answer-${message.id}`, questions: [{ key: q.key, revision: saved[0]!.revision }] });
    };
    answer(first, INBOX_PERMISSION_ALLOW_ONCE);
    for (let i = 0; i < 50 && w.codex.approvals().length === 0; i++) {
      w.launch.sweep(true);
      await Bun.sleep(40);
    }
    expect(w.codex.approvals()[0]).toMatchObject({ threadId, method: CODEX_COMMAND_APPROVAL, result: { decision: "accept" }, how: "answered" });
    await until(() => w.codex.turns().some((t) => t.ended === "completed"));

    // The next turn asks again; Deny with a reason: decline, and the reason goes into the running turn.
    w.codex.configure({ prompts: [{ kind: "command", command: "rm -rf build" }], hold: true });
    await w.launch.deliver("codex", threadId, wake(root.id, "Clean up."));
    await until(() => messagesOf(w.store, root.thread_id).filter((m: InboxMessage) => m.author.session === `perm:${threadId}`).length === 2);
    const second = await card();
    answer(second, "", "Not the build folder.");
    for (let i = 0; i < 50 && w.codex.approvals().length < 2; i++) {
      w.launch.sweep(true);
      await Bun.sleep(40);
    }
    expect(w.codex.approvals()[1]).toMatchObject({ result: { decision: "decline" }, how: "answered" });
    await until(() => w.codex.turns().some((t) => t.steer?.includes("Not the build folder.")));
  });

  test("a request the person answers in Terminal (codex resume) is withdrawn as answered there", async () => {
    const w = world({ config: { prompts: [{ kind: "command", command: "make" }] } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    await w.launch.deliver("codex", threadId, wake(root.id, "Fix it."));
    let card: InboxMessage | undefined;
    await until(() => !!(card = messagesOf(w.store, root.thread_id).find((m: InboxMessage) => m.author.session === `perm:${threadId}`)));
    w.codex.configure({ localAnswer: threadId });
    await until(() => w.codex.approvals().length === 1);
    await until(() => w.store.questionsOf(card!.id)[0]!.state !== "open");
    expect(w.codex.approvals()[0]!.how).toBe("local");
    expect(messagesOf(w.store, root.thread_id).some((m) => m.reply_to === card!.id && m.body === INBOX_PERMISSION_ANSWERED_IN_TERMINAL)).toBe(true);
  });

  test("Delete deletes the thread in Codex", async () => {
    const w = world();
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    expect(await (await w.post(root.launch!.id, "delete"))!.json()).toEqual({ ok: true });
    expect(w.codex.rpc("thread/delete").map((r) => r.params.threadId)).toEqual([threadId]);
    expect(w.codex.threads()[threadId]).toBeUndefined();
  });
});
