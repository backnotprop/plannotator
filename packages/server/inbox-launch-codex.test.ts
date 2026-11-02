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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { INBOX_PERMISSION_ALLOW_ONCE, INBOX_PERMISSION_ANSWERED_IN_TERMINAL, INBOX_PERMISSION_ASK_IN_TERMINAL, INBOX_PERMISSION_AUTO, INBOX_PERMISSION_DENY, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL, inboxPermissionAnswer, inboxPermissionChoices } from "@plannotator/core/inbox-permission";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_RUN_START_GRACE_MS } from "@plannotator/core/inbox-run-line";
import { installFakeCodex, type FakeCodex, type FakeCodexConfig } from "../../tests/helpers/fake-codex";
import { createInboxLaunch } from "./inbox-launch";
import { codexHostState, codexTrustOverride, codexTrustRoot, codexTurnErrorNote, codexWritesTrust, parseDaemonStart } from "./inbox-launch-codex";
import { CODEX_COMMAND_APPROVAL, CODEX_FILE_APPROVAL, CODEX_PERMISSION_TERMS, CODEX_PERMISSIONS_APPROVAL, codexApprovalKey, codexDecision, codexDiffEdits, codexPermissionEvent, createCodexPermissions } from "./inbox-launch-codex-permission";

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
const cardsOf = (store: InboxStore, root: InboxMessage, threadId: string) => messagesOf(store, root.thread_id).filter((m) => m.author.session === `perm:${threadId}`);
/** The window's way: the pick, then the Send. */
function answerCard(store: InboxStore, cardId: string, label: string) {
  const q = store.questionsOf(cardId)[0]!;
  const picked = { v: 1 as const, key: q.key, kind: "single" as const, prompt: q.prompt, selected: [label] };
  const saved = store.savePicks(cardId, [{ key: q.key, revision: q.revision, answer: picked }], { unsentOnly: true });
  store.sendReply(cardId, { idempotency_key: `answer-${cardId}`, questions: [{ key: q.key, revision: saved[0]!.revision }] });
}

describe("the pure parts", () => {
  test("trust goes in memory only where Codex would write it, found as Codex finds the folder's project", () => {
    const trusted = { projects: { "/real/app": { trust_level: "trusted" }, "/link/app": { trust_level: "trusted" } } };
    expect(codexTrustOverride(null, "/link/app", "/real/app", null, true)).toEqual(trusted);
    // Codex would write nothing (read-only: no write to the folder): nothing in memory either, so nothing widens.
    expect(codexTrustOverride(null, "/link/app", "/real/app", null, false)).toEqual({});
    // The person's trust level, trusted or untrusted, on the folder (either spelling) or its trust root: theirs.
    expect(codexTrustOverride('[projects."/real/app"]\ntrust_level = "untrusted"\n', "/link/app", "/real/app", null, true)).toEqual({});
    expect(codexTrustOverride('[projects."/link/app"]\ntrust_level = "trusted"\n', "/link/app", "/real/app", null, true)).toEqual({});
    expect(codexTrustOverride('[projects."/main"]\ntrust_level = "untrusted"\n', "/wt/app", "/wt/app", "/main", true)).toEqual({});
    // The folder's own entry comes first, even with no trust level: Codex reads it (not the root's) and would write.
    expect(codexTrustOverride('[projects."/wt/app"]\nnote = "x"\n[projects."/main"]\ntrust_level = "untrusted"\n', "/wt/app", "/wt/app", "/main", true)).toEqual({ projects: { "/wt/app": { trust_level: "trusted" } } });
    expect(codexTrustOverride('[projects."/wt/app"]\ntrust_level = "trusted"\n[projects."/main"]\ntrust_level = "untrusted"\n', "/wt/app", "/wt/app", "/main", true)).toEqual({});
  });

  test("Codex writes trust only when the thread can write the folder", () => {
    expect(codexWritesTrust(null)).toBe(false);
    expect(codexWritesTrust('sandbox_mode = "read-only"\n')).toBe(false);
    expect(codexWritesTrust('sandbox_mode = "workspace-write"\n')).toBe(true);
    expect(codexWritesTrust('sandbox_mode = "danger-full-access"\n')).toBe(true);
    // The selected profile's sandbox wins; a named permissions profile is not guessed at.
    expect(codexWritesTrust('sandbox_mode = "read-only"\nprofile = "w"\n[profiles.w]\nsandbox_mode = "workspace-write"\n')).toBe(true);
    expect(codexWritesTrust('sandbox_mode = "workspace-write"\ndefault_permissions = "mine"\n')).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a linked worktree's trust root is its main checkout, as Codex resolves it; a plain checkout's is itself", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-codex-trust-")));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
    const env = { PATH: "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (cwd: string, ...args: string[]) => expect(spawnSync("/usr/bin/git", args, { cwd, env }).status).toBe(0);
    const main = join(dir, "main");
    mkdirSync(join(main, "src"), { recursive: true });
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "first");
    git(main, "worktree", "add", "-q", join(dir, "wt"));
    mkdirSync(join(dir, "wt", "pkg"));
    expect(codexTrustRoot(join(main, "src"))).toBe(main);
    expect(codexTrustRoot(join(dir, "wt", "pkg"))).toBe(main);
    expect(codexTrustRoot(dir)).toBeNull();
    // The person marked the main checkout untrusted: the worktree gets no trust from the Inbox.
    const config = `sandbox_mode = "workspace-write"\n[projects."${main}"]\ntrust_level = "untrusted"\n`;
    const wt = join(dir, "wt", "pkg");
    expect(codexTrustOverride(config, wt, wt, codexTrustRoot(wt), codexWritesTrust(config))).toEqual({});
    // A `.git` file that is not a linked worktree's (a forged pointer): no root, as Codex finds none.
    const forged = join(dir, "forged");
    mkdirSync(forged);
    writeFileSync(join(forged, ".git"), `gitdir: ${join(main, ".git")}\n`);
    expect(codexTrustRoot(forged)).toBeNull();
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
    // More sandbox access with the command: the card would show the command alone, so it goes to Terminal.
    expect(codexPermissionEvent(CODEX_COMMAND_APPROVAL, { ...params, additionalPermissions: { network: { enabled: true } } }, undefined)).toBeNull();
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
  function transport() {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-codex-perm-"));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = InboxStore.open(join(dir, "data"));
    const project = store.ensureProject({ name: "p", root: dir });
    const launch = { id: "lch_01J00000000000000000000001", agent: "codex" as const, session_ref: THREAD, folder: dir, scratch: false, started_at: new Date().toISOString() };
    const root = store.startPersonThread({ project_id: project.id, body: "Build it.", to: { host: "codex", session: THREAD }, idempotency_key: "send-1", launch }).message;
    const answers: [number | string, unknown][] = [];
    const link = { up: true };
    const permissions = createCodexPermissions({
      store,
      roots: () => [store.message(root.id)!],
      rootOf: () => store.message(root.id)!,
      displayFolder: (path) => path,
      host: { stateOf: () => null, readAt: () => null },
      onChange: () => {},
      respond: (id, result) => link.up && answers.push([id, result]) > 0,
      steer: () => {},
      status: () => null,
      connectedAt: () => null,
      rejoin: () => {},
    } as never);
    const cards = () => messagesOf(store, root.thread_id).filter((m: InboxMessage) => m.author.session === `perm:${THREAD}`);
    const answer = (cardId: string) => {
      const question = store.questionsOf(cardId)[0]!;
      const picked = { v: 1 as const, key: question.key, kind: "single" as const, prompt: question.prompt, selected: [INBOX_PERMISSION_ALLOW_ONCE] };
      const saved = store.savePicks(cardId, [{ key: question.key, revision: question.revision, answer: picked }], { unsentOnly: true });
      store.sendReply(cardId, { idempotency_key: `answer-${cardId}`, questions: [{ key: question.key, revision: saved[0]!.revision }] });
    };
    return { store, root, dir, answers, link, permissions, cards, answer };
  }

  test("a request Codex sends again (a new id, the same item) is the same card, and the answer goes to the latest id", () => {
    const t = transport();
    const params = { threadId: THREAD, turnId: "t1", itemId: "i1", approvalId: null, command: "bun run build", cwd: t.dir };
    t.permissions.asked(7, CODEX_COMMAND_APPROVAL, params);
    t.permissions.connectionLost();
    t.permissions.asked(12, CODEX_COMMAND_APPROVAL, params);
    expect(t.cards()).toHaveLength(1);
    expect(t.cards()[0]!.author).toMatchObject({ host: "codex", name: "Codex" });
    t.answer(t.cards()[0]!.id);
    t.permissions.sweep();
    t.permissions.sweep();
    expect(t.answers).toEqual([[12, { decision: "accept" }]]);
  });

  test("two approvals of one item (approval ids with a long shared prefix) are two cards, each answered on its own request", () => {
    const t = transport();
    const prefix = `zsh-exec-bridge-${"a".repeat(60)}`;
    const base = { threadId: THREAD, turnId: "t1", itemId: "item-with-a-long-identifier-0001", cwd: t.dir };
    t.permissions.asked(1, CODEX_COMMAND_APPROVAL, { ...base, approvalId: `${prefix}-1`, command: "ls" });
    t.permissions.asked(2, CODEX_COMMAND_APPROVAL, { ...base, approvalId: `${prefix}-2`, command: "rm -rf build" });
    expect(t.cards().map((c) => c.body.split("\n")[1])).toEqual(["ls", "rm -rf build"]);
    expect(codexApprovalKey(THREAD, base.itemId, `${prefix}-1`)).not.toBe(codexApprovalKey(THREAD, base.itemId, `${prefix}-2`));
    t.answer(t.cards()[0]!.id);
    t.permissions.sweep();
    expect(t.answers).toEqual([[1, { decision: "accept" }]]);
  });

  test("an answer that could not go (no connection) goes on the request Codex sends again", () => {
    const t = transport();
    const params = { threadId: THREAD, turnId: "t1", itemId: "i1", approvalId: null, command: "make", cwd: t.dir };
    t.permissions.asked(3, CODEX_COMMAND_APPROVAL, params);
    t.answer(t.cards()[0]!.id);
    t.link.up = false;
    t.permissions.sweep();
    expect(t.answers).toEqual([]);
    t.link.up = true;
    t.permissions.connectionLost();
    t.permissions.asked(9, CODEX_COMMAND_APPROVAL, params);
    t.permissions.sweep();
    expect(t.answers).toEqual([[9, { decision: "accept" }]]);
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
  restart: () => { store: InboxStore; launch: ReturnType<typeof createInboxLaunch> };
  /** The login-shell reads the engine made. */
  logins: { count: number };
  daemonDown: () => Promise<void>;
}

/** The person's config.toml in these tests: their threads can write their folder, so Codex would write its trust. */
const WRITES = 'model = "gpt-5"\nsandbox_mode = "workspace-write"\n';

function world(options: { config?: FakeCodexConfig; configToml?: string; inboxMcp?: boolean; fullPermissions?: boolean } = {}): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-codex-")));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "ledger");
  const bin = join(root, "bin");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, ...(options.fullPermissions === undefined ? {} : { fullPermissions: options.fullPermissions }) } }));
  const codex = installFakeCodex({
    bin,
    state: join(root, "codex-state"),
    home,
    config: { workMs: 100, ...options.config },
    ...(options.inboxMcp === false ? { configToml: options.configToml ?? WRITES } : { inboxMcp: join(root, "plannotator", "plannotator"), configToml: options.configToml ?? WRITES }),
  });
  restore.push(() => {
    codex.stopAll();
    rmSync(root, { recursive: true, force: true });
  });
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "ledger", root: folder });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  /** The person's login shell: its own object, with a name the Inbox's own env lacks (`CODEX_TEST_LOGIN`). */
  const logins = { count: 0 };
  const loginEnv = async () => (logins.count++, { ...env, CODEX_TEST_LOGIN: "1" });
  const logs: string[] = [];
  const engine = (on: InboxStore, laterMs = 0) => {
  const launch = createInboxLaunch({
    store: on,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    loginEnv,
    ownEnv: () => ({ ...env }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: (line) => void logs.push(line),
    selfCommand: ["plannotator"],
    now: () => Date.now() + laterMs,
  });
  restore.push(() => launch.stop());
  return launch;
  };
  const launch = engine(store);
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
  /**
   * The Inbox restarts: this engine stops (its connection goes, the daemon and its threads stay), a new one opens
   * the same data dir, its clock past the start's grace (so a read of the thread asks the host).
   */
  const restart = () => {
    launch.stop();
    const again = InboxStore.open(dataDir);
    return { store: again, launch: engine(again, INBOX_RUN_START_GRACE_MS * 2) };
  };
  const socket = join(home, "app-server-control", "app-server-control.sock");
  /** The daemon stops (`daemon stop`, a reboot, its updater): its socket goes, and the Inbox sees its connection close. */
  const daemonDown = async () => {
    const closes = () => logs.filter((line) => line.includes("Codex app-server connection closed")).length;
    const was = closes();
    expect(codex.cli(["app-server", "daemon", "stop"]).status).toBe(0);
    await until(() => !existsSync(socket) && closes() > was);
  };
  return { store, codex, launch, project, home, post, send, restart, logins, daemonDown };
}

/** A turn ends in the fake's log before the host hears the thread went idle, and until then a delivery answers `queue`. */
async function deliverWhenIdle(w: World, threadId: string, text: string) {
  let answer = await w.launch.deliver("codex", threadId, text);
  for (let i = 0; i < 100 && answer === "queue"; i++) {
    await Bun.sleep(20);
    answer = await w.launch.deliver("codex", threadId, text);
  }
  return answer;
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

  test("Codex runs with the person's own Codex settings: no approval policy or sandbox from the Inbox, whatever Settings → Agents' switch says", async () => {
    for (const fullPermissions of [true, false, undefined]) {
      const w = world(fullPermissions === undefined ? {} : { fullPermissions });
      const root = await w.send("Fix it.", "send-1");
      expect(root.launch!.full_permissions ?? false).toBe(false);
      // A restart for a reply sends the thread's settings again: none there either.
      w.store.recordDelivery(root.id, { host: "codex", session: root.launch!.session_ref! });
      await w.post(root.launch!.id, "stop");
      w.store.sendReply(root.id, { words: "Go on.", idempotency_key: "reply-1" });
      await until(() => w.codex.rpc("thread/resume").length > 0);
      for (const sent of [...w.codex.rpc("thread/start"), ...w.codex.rpc("thread/resume")]) {
        expect(sent.params.approvalPolicy).toBeUndefined();
        expect(sent.params.sandbox).toBeUndefined();
      }
    }
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

  // Live check (Pi's, same gap here): the provider refused the turn, and the thread said only "Delivered".
  test("a turn that fails (the provider refused the model) shows Codex's own error in one note from the session, once", async () => {
    const message = "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
    const w = world({ config: { turnError: { message, codexErrorInfo: "other" } } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "Fix it."))).toBe("delivered");
    const notes = () => w.store.threadMessageIds(root.thread_id).map((id) => w.store.message(id)!).filter((m) => m.author.kind === "agent");
    await until(() => notes().length > 0);
    expect(notes()[0]!.author).toMatchObject({ kind: "agent", host: "codex", session: threadId, name: "Codex" });
    expect(notes()[0]!.body).toBe(`Codex's turn ended with an error: ${message}`);
    expect(w.codex.turns().find((t) => t.ended)).toMatchObject({ ended: "failed" });
    await Bun.sleep(300);
    expect(notes()).toHaveLength(1);
    // One line, Markdown's marks escaped: Codex's text can never become a question block.
    expect(codexTurnErrorNote('401 {"error":"*expired*"}\n\n:::question\n- [ ] Yes')).toBe(`Codex's turn ended with an error: 401 \\{"error":"\\*expired\\*"\\} :::question - \\[ \\] Yes`);
  });

  test("Stop with no turn running does not hang; Stop of a running turn interrupts it; a reply after Stop starts a turn again", async () => {
    const w = world({ config: { workMs: 50 } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    // The wake delivered the root; each reply below is the person's, written after a Stop.
    w.store.recordDelivery(root.id, { host: "codex", session: threadId });
    const reply = (words: string, key: string) => {
      const sent = w.store.sendReply(root.id, { words, idempotency_key: key }).reply;
      return { text: wake(root.id, words), delivered: () => w.store.recordDelivery(sent.id, { host: "codex", session: threadId }) };
    };
    const at = Date.now();
    const stopped = await w.post(root.launch!.id, "stop");
    expect(stopped!.status).toBe(200);
    expect(Date.now() - at).toBeLessThan(3_000);
    expect(w.codex.rpc("turn/interrupt")).toEqual([]);
    expect(w.codex.rpc("thread/unsubscribe")).toHaveLength(1);

    // A reply after Stop: the thread is rejoined and the reply starts a turn (a queued one would wait on the interrupted thread).
    w.codex.configure({ hold: true });
    const goOn = reply("Go on.", "reply-1");
    expect(await w.launch.deliver("codex", threadId, goOn.text)).toBe("delivered");
    goOn.delivered();
    // Rejoined (the engine's restart for the reply may have rejoined it too).
    expect(w.codex.rpc("thread/resume").length).toBeGreaterThan(0);
    await until(() => w.codex.turns().length === 1);
    await Bun.sleep(100);

    await w.post(root.launch!.id, "stop");
    const interrupts = w.codex.rpc("turn/interrupt");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.params.turnId).toBe(w.codex.turns()[0]!.turnId);
    await until(() => w.codex.turns().some((t) => t.ended === "interrupted"));

    // Again after the interrupt: a turn/start, never the paused queue.
    w.codex.configure({ hold: false });
    expect(await deliverWhenIdle(w, threadId, reply("Once more.", "reply-2").text)).toBe("delivered");
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
    expect(await deliverWhenIdle(w, threadId, wake(root.id, "Clean up."))).toBe("delivered");
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

  test("a folder Codex would not write trust for (read-only, its default) gets none in memory, and nothing widens", async () => {
    const w = world({ configToml: 'model = "gpt-5"\n' });
    const before = w.codex.configToml();
    await w.send("Fix it.", "send-1");
    expect(w.codex.rpc("thread/start")[0]!.params.config.projects).toBeUndefined();
    expect(w.codex.configToml()).toBe(before);
  });

  test("after an Inbox restart, a card answered there reaches Codex, though the window read the thread before any sweep", async () => {
    const w = world({ config: { prompts: [{ kind: "command", command: "bun test" }] } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    await w.launch.deliver("codex", threadId, wake(root.id, "Fix it."));
    await until(() => cardsOf(w.store, root, threadId).length === 1);
    const again = w.restart();
    // The window reads the thread first: that read opens the new connection.
    await again.launch.runOf(root.id);
    answerCard(again.store, cardsOf(again.store, root, threadId)[0]!.id, INBOX_PERMISSION_ALLOW_ONCE);
    for (let i = 0; i < 100 && w.codex.approvals().length === 0; i++) {
      again.launch.sweep(true);
      await Bun.sleep(40);
    }
    expect(w.codex.approvals()[0]).toMatchObject({ threadId, result: { decision: "accept" }, how: "answered" });
    expect(cardsOf(again.store, root, threadId)).toHaveLength(1);
  });

  test("a patch card left open across an Inbox restart (its change is not sent again) is handed to Terminal", async () => {
    const w = world({ config: { prompts: [{ kind: "fileChange", changes: [{ path: "/p/a.txt", kind: { type: "add" }, diff: "hi\n" }] }] } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    await w.launch.deliver("codex", threadId, wake(root.id, "Fix it."));
    await until(() => cardsOf(w.store, root, threadId).length === 1);
    const card = cardsOf(w.store, root, threadId)[0]!;
    const again = w.restart();
    await again.launch.runOf(root.id);
    await until(() => messagesOf(again.store, root.thread_id).some((m) => m.reply_to === card.id && m.body === INBOX_PERMISSION_ASK_IN_TERMINAL));
    expect(w.codex.approvals()).toEqual([]);
  });

  test("a turn/start that may have gone (the connection dropped before its answer) is never sent again", async () => {
    const w = world({ config: { dropOnTurnStart: true, hold: true } });
    const root = await w.send("Fix it.", "send-1");
    const result = await w.launch.deliver("codex", root.launch!.session_ref!, wake(root.id, "Fix it."));
    expect(result).toMatchObject({ uncertain: expect.any(String) });
    expect(w.codex.turns().filter((t) => t.how === "turn/start")).toHaveLength(1);
  });

  test("Stop reads the thread first: a turn this Inbox did not see (started from Terminal) is interrupted", async () => {
    const w = world({ config: { hold: true } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    await w.post(root.launch!.id, "stop");
    // The person goes on in Terminal: this Inbox is off the thread and sees none of it.
    expect(w.codex.cli(["queue", `--thread=${threadId}`, "--message=Keep going."]).status).toBe(0);
    await until(() => w.codex.turns().length === 1);
    await w.post(root.launch!.id, "stop");
    expect(w.codex.rpc("turn/interrupt").map((r) => r.params.turnId)).toEqual([w.codex.turns()[0]!.turnId]);
  });

  test("Delete never starts the daemon: with none running, the thread is left in Codex, and a reply after it never reaches Codex", async () => {
    const w = world();
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    w.store.recordDelivery(root.id, { host: "codex", session: threadId });
    await w.daemonDown();
    const starts = () => w.codex.calls().filter((c) => c.argv.join(" ") === "app-server daemon start").length;
    const before = starts();
    expect(await (await w.post(root.launch!.id, "delete"))!.json()).toEqual({ ok: true });
    expect(starts()).toBe(before);
    expect(w.codex.rpc("thread/delete")).toEqual([]);
    expect(w.codex.threads()[threadId]).toBeDefined();
    // A reply in the kept thread: it waits in the Inbox (never `codex queue`, which would run the deleted session again).
    w.store.sendReply(root.id, { words: "Still there?", idempotency_key: "reply-1" });
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "Still there?"))).toBe("hold");
    expect(starts()).toBe(before);
    expect(w.codex.turns()).toEqual([]);
  });

  test("a reply waiting when the person pressed Stop is held across an Inbox restart: no turn until their next reply", async () => {
    const w = world();
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    w.store.recordDelivery(root.id, { host: "codex", session: threadId });
    // Written, and Stop pressed before the wake delivered it.
    w.store.sendReply(root.id, { words: "Wrong one.", idempotency_key: "reply-1" });
    await w.post(root.launch!.id, "stop");
    const again = w.restart();
    // The new Inbox's first sweeps: no restart, and the wake's ask is held.
    for (let i = 0; i < 3; i++) {
      again.launch.sweep(true);
      await Bun.sleep(20);
    }
    expect(await again.launch.deliver("codex", threadId, wake(root.id, "Wrong one."))).toBe("hold");
    expect(w.codex.rpc("turn/start")).toEqual([]);
    // Their next reply starts it again, and the held one goes along.
    again.store.sendReply(root.id, { words: "This one.", idempotency_key: "reply-2" });
    expect(await again.launch.deliver("codex", threadId, wake(root.id, "Wrong one."))).toBe("delivered");
    expect(w.codex.rpc("turn/start")).toHaveLength(1);
  });

  test("the daemon stopped (its socket gone): a sweep finds none and keeps nothing of it; a look once it runs again finds it, and a reply then starts it", async () => {
    const w = world({ config: { hold: true } });
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    w.store.recordDelivery(root.id, { host: "codex", session: threadId });
    const lookWithNone = async () => {
      await w.daemonDown();
      // The 1 s sweep looks for the daemon (never starting it) and finds none.
      w.launch.sweep(true);
      await Bun.sleep(50);
    };
    await lookWithNone();
    // Started again from outside (Codex's updater): Stop finds it. A look stuck on the earlier "none" would say
    // "not running" here, and a reply's start would then never return (the whole Inbox stuck).
    expect(w.codex.cli(["app-server", "daemon", "start"]).status).toBe(0);
    await w.post(root.launch!.id, "stop");
    expect(w.codex.rpc("thread/unsubscribe")).toHaveLength(1);
    // Stopped again, a look, then the person replies: the reply starts the daemon and goes in as a turn.
    await lookWithNone();
    w.store.sendReply(root.id, { words: "Go on.", idempotency_key: "reply-1" });
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "Go on."))).toBe("delivered");
    await until(() => w.codex.turns().length === 1);
  }, 20_000);

  test("a reply's daemon start reads the login shell, and only then: never the Inbox's own env, and no read while the daemon runs", async () => {
    const w = world();
    const root = await w.send("Fix it.", "send-1");
    const threadId = root.launch!.session_ref!;
    w.store.recordDelivery(root.id, { host: "codex", session: threadId });
    const starts = () => w.codex.calls().filter((c) => c.argv.join(" ") === "app-server daemon start");
    const fromLogin = () => starts().at(-1)!.env.includes("CODEX_TEST_LOGIN");
    const reads = w.logins.count;
    // The daemon runs: a reply reads no login shell.
    w.store.sendReply(root.id, { words: "One.", idempotency_key: "reply-1" });
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "One."))).toBe("delivered");
    expect(w.logins.count).toBe(reads);
    await until(() => w.codex.turns().some((t) => t.ended === "completed"));

    // Stopped (a reboot): the wake's deliver starts it with the login shell's env.
    await w.daemonDown();
    const before = starts().length;
    w.store.sendReply(root.id, { words: "Two.", idempotency_key: "reply-2" });
    expect(await w.launch.deliver("codex", threadId, wake(root.id, "Two."))).toBe("delivered");
    expect(starts()).toHaveLength(before + 1);
    expect(fromLogin()).toBe(true);
    expect(w.logins.count).toBe(reads + 1);

    // Stopped again, and the Inbox restarted: a reply's restart (`resume`) starts it with the login shell's env too.
    await w.daemonDown();
    const again = w.restart();
    again.store.sendReply(root.id, { words: "Three.", idempotency_key: "reply-3" });
    await until(() => starts().length === before + 2);
    expect(fromLogin()).toBe(true);
  });
});
