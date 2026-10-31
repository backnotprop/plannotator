/**
 * OpenCode's launch host (inbox-launch-opencode.ts) and its permission terms
 * (inbox-launch-opencode-permission.ts). What each test guards:
 *  - To offers OpenCode only for 1.18+ below 2 with Plannotator's plugin in the person's config, and says why not;
 *  - a start runs one `opencode serve` per launch with this Inbox's data dir, the plugin's tool and launch id,
 *    and a password that lives only in server.json (0600): never argv, the start log, the server log, the Inbox
 *    log or the attach command (which reads it from the file, and does read it);
 *  - full permissions is an allow-all session ruleset; otherwise the person's own permissions decide;
 *  - Stop ends the server and the commands it left running; a reply starts a new server on the same session;
 *  - Delete's remove runs `opencode session delete`;
 *  - OpenCode's prompts read as the card's tools, with its own choices (no mode switch) and replies;
 *  - only a server proved ours is adopted or signalled (a reused pid, one that takes any request: never);
 *  - Stop and Delete during a reply's restart end the new server, never throw, never make the folder again;
 *  - a subagent's prompt reaches the card; OpenCode's cascade withdraws cards with the right words; a reply
 *    the server did not take is sent again; a brief outage withdraws nothing, a longer one asks anew;
 *  - an idle server is stopped (never one with a turn), says so, and a reply continues it.
 * The real OpenCode is never run: the fake (tests/helpers/fake-opencode/) is the only `opencode` on PATH.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxPermissionAnswer, inboxPermissionQuestion } from "@plannotator/core/inbox-permission";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeOpenCode } from "../../tests/helpers/fake-opencode";
import { createAgentEnvironmentFor } from "./inbox-agents";
import type { LaunchHostContext } from "./inbox-launch-host";
import { OPENCODE_ALLOWED_EARLIER, OPENCODE_DENIED_EARLIER, createOpenCodeLaunchHost, isOpenCodeServe, openCodeAttachCommand, openCodeProcessOf, openCodeServerEnv, parseListening, parseOpenCodeVersion } from "./inbox-launch-opencode";
import { openCodePermissionEvent, openCodePermissionTerms, openCodeReply, readOpenCodePermission } from "./inbox-launch-opencode-permission";
import { openCode1LaunchWakes } from "../../apps/opencode-plugin/inbox";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const LAUNCH_ID = "lch_01KAAAAAAAAAAAAAAAAAAAAAAA";

function world(options: { plugin?: boolean; version?: string; full?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pn-launch-opencode-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  for (const dir of [home, bin, dataDir, folder]) mkdirSync(dir, { recursive: true });
  if (options.plugin !== false) {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugin: ["@plannotator/opencode@latest"] }));
  }
  const fake = installFakeOpenCode({ bin, state: join(root, "fake"), config: { ...(options.version ? { version: options.version } : {}), workMs: 50 } });
  const logs: string[] = [];
  const startLogs: string[] = [];
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const ctx: LaunchHostContext = {
    dataDir,
    homeDir: home,
    platform: process.platform,
    selfCommand: ["plannotator"],
    ownEnv: () => env,
    environment: async () => createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env }),
    shell: () => null,
    loginEnv: async () => ({ ...env, OPENCODE_SERVER_PASSWORD: "the-person-s-other-server", PLANNOTATOR_SESSION_TAG: "claude-code:x" }),
    config: () => ({ enabled: true, fullPermissions: options.full ?? null, model: null, scratchDir: null }) as never,
    launchDir: (id) => join(dataDir, "inbox", "launch", id),
    startLog: (_id, text) => startLogs.push(text),
    displayFolder: (path) => path,
    bridge: { runStateOf: () => null },
    log: (line) => logs.push(line),
  };
  const host = createOpenCodeLaunchHost(ctx);
  cleanup.push(() => {
    fake.stopAll();
    rmSync(root, { recursive: true, force: true });
  });
  const launch: InboxLaunchRecord = { id: LAUNCH_ID, agent: "opencode", session_ref: null, folder, scratch: false, started_at: new Date().toISOString(), ...(options.full ? { full_permissions: true } : {}) };
  return { root, home, dataDir, folder, fake, host, ctx, logs, startLogs, launch };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** As `until`, for a check that must ask (a promise is never taken for a yes). */
async function untilAsync(what: string, check: () => Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(50);
  }
}

async function until(what: string, check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(25);
  }
}

describe("availability", () => {
  test("offered for 1.18+ with the plugin; refused, with the reason, without it, for OpenCode 2 and for an older one", async () => {
    expect(await world().host.available()).toEqual({ ok: true, version: "1.18.23" });
    expect(await world({ plugin: false }).host.available()).toMatchObject({ ok: false, missing: false, reason: "Plannotator's OpenCode plugin is not in your OpenCode config" });
    expect(await world({ version: "2.1.4" }).host.available()).toMatchObject({ ok: false, missing: false, reason: "OpenCode 2.1.4 is OpenCode 2, which the Inbox cannot start yet" });
    expect(await world({ version: "1.17.9" }).host.available()).toMatchObject({ ok: false, missing: false, reason: "OpenCode 1.17.9 is older than 1.18.0" });
    const gone = world();
    rmSync(join(gone.root, "bin", "opencode"));
    expect(await gone.host.available()).toMatchObject({ ok: false, missing: true });
  });
});

describe("a launch's server", () => {
  test("start: one server with this Inbox's data dir and the plugin's tool; the password only in server.json; Stop ends it and its children; a reply starts it again on the same session; remove deletes the session", async () => {
    const w = world();
    const started = await w.host.start(w.launch, { name: "Tidy the readme", login: await w.ctx.loginEnv() });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.session).toMatch(/^ses_/);
    expect(started.ref).toBe(started.session);
    const serve = w.fake.serves()[0]!;
    // A free port the Inbox picked: never 0 (OpenCode would take its default 4096) and never 4096.
    expect(serve.argv.slice(0, 4)).toEqual(["serve", "--hostname", "127.0.0.1", "--port"]);
    const port = Number(serve.argv[4]);
    expect(port > 0 && port !== 4096).toBe(true);
    expect(serve.cwd).toBe(w.folder);
    expect(serve.values).toMatchObject({ PLANNOTATOR_DATA_DIR: w.dataDir, PLANNOTATOR_INBOX_TOOL: "1", PLANNOTATOR_LAUNCH: LAUNCH_ID });
    // A password of its own (never the shell's other server's), and no Claude Code session tag.
    expect(serve.passwordSet).toBe(true);
    expect(serve.env).not.toContain("PLANNOTATOR_SESSION_TAG");
    const file = join(w.dataDir, "inbox", "launch", LAUNCH_ID, "server.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const server = JSON.parse(readFileSync(file, "utf8")) as { pid: number; started: string; url: string; password: string };
    expect(server.password).toMatch(/^[0-9a-f]{48}$/);
    expect(server.url).toBe(`http://127.0.0.1:${port}`);
    // The process as recorded: its start time, so a reused pid is never taken for it.
    expect(server.started).toBe(openCodeProcessOf(server.pid)!.started);
    expect(server.password).not.toBe("the-person-s-other-server");
    // The session: its title, no ruleset (the person's own permissions decide).
    expect(w.fake.sessions()).toEqual([{ id: started.session, directory: w.folder, title: "Tidy the readme", permission: null }]);

    // The password is nowhere else: argv, the start log, the server log, the Inbox log, the attach command.
    const launched = { ...w.launch, session_ref: started.session };
    const attach = w.host.attach(launched)!;
    const serverLog = readFileSync(join(w.dataDir, "inbox", "launch", LAUNCH_ID, "server.log"), "utf8");
    for (const text of [serve.argv.join(" "), ...w.startLogs, serverLog, ...w.logs, attach, w.host.terminal(launched, false)]) expect(text).not.toContain(server.password);
    // The attach command reads it from the file: run with `opencode attach` swapped for a print, it has it.
    const probe = attach.replace(/ opencode attach .*$/, ` /bin/sh -c 'printf %s "$OPENCODE_SERVER_PASSWORD"'`);
    expect(spawnSync("/bin/sh", ["-c", probe], { encoding: "utf8" }).stdout).toBe(server.password);
    expect(attach).toContain(`opencode attach ${server.url} --session ${started.session}`);

    const sessions = await w.host.sessions();
    expect(sessions!(started.session)).toEqual({ status: "idle", state: "running", waitingFor: null });

    // Stop: the turn is aborted, the server and the command it left running end.
    const child = w.fake.childOf(server.pid)!;
    expect(alive(server.pid) && child.alive).toBe(true);
    expect((await w.host.stop(started.session)).exitCode).toBe(0);
    expect(w.fake.aborts()).toEqual([started.session]);
    await until("the server and its child end", () => !alive(server.pid) && w.fake.processes().every((p) => !p.alive));
    expect(() => statSync(file)).toThrow();
    expect((await w.host.sessions())!(started.session)).toEqual({ status: null, state: "stopped", waitingFor: null });
    // Stopped: the attach command opens the session from OpenCode's own database.
    expect(w.host.attach(launched)).toBe(`cd ${w.folder} && opencode --session ${started.session}`);

    // A reply: a new server (a fresh login read), the same session.
    const resumed = await w.host.resume(launched);
    expect(resumed.failure).toBeNull();
    expect(w.fake.serves()).toHaveLength(2);
    const again = JSON.parse(readFileSync(file, "utf8")) as { pid: number; password: string };
    expect(again.pid).not.toBe(server.pid);
    expect(again.password).not.toBe(server.password);

    // Delete: stop, then the session goes from OpenCode's database.
    await w.host.stop(started.session);
    const removed = await w.host.remove(started.session);
    expect(removed.exitCode).toBe(0);
    expect(w.fake.calls().at(-1)!.argv).toEqual(["session", "delete", started.session, "--pure"]);
    expect(w.fake.sessions()).toEqual([]);
    await until("nothing of the fake runs", () => w.fake.processes().every((p) => !p.alive));
  }, 30_000);

  test("full permissions: the session gets an allow-all ruleset", async () => {
    const w = world({ full: true });
    expect(w.host.startOf("/x")).toEqual({ full: true, ownMode: false, bypass: false });
    const started = await w.host.start(w.launch, { name: "n", login: await w.ctx.loginEnv() });
    expect(started.ok).toBe(true);
    expect(w.fake.sessions()[0]!.permission).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
    if (started.ok) await w.host.stop(started.session);
  }, 30_000);

  test("a server that never comes up is a failed start, with the cause, and nothing left running", async () => {
    const w = world();
    w.fake.configure({ failServe: true });
    const started = await w.host.start(w.launch, { name: "n", login: await w.ctx.loginEnv() });
    expect(started).toMatchObject({ ok: false, code: "failed" });
    expect(w.fake.processes().every((p) => !p.alive)).toBe(true);
  }, 40_000);
});

/** A started launch with its thread: the store, the permission transport, the person's answers, a turn put to the server. */
async function launched(options: { idleMs?: number; sweep?: boolean; config?: Parameters<ReturnType<typeof installFakeOpenCode>["configure"]>[0] } = {}) {
  const w = world();
  if (options.config) w.fake.configure(options.config);
  const host = options.idleMs ? createOpenCodeLaunchHost(w.ctx, { idleMs: options.idleMs }) : w.host;
  const store = InboxStore.open(w.dataDir);
  const project = store.ensureProject({ name: "project", root: w.folder });
  const started = await host.start(w.launch, { name: "Tidy", login: await w.ctx.loginEnv() });
  if (!started.ok) throw new Error(`did not start: ${started.text}`);
  const record: InboxLaunchRecord = { ...w.launch, session_ref: started.session };
  const root = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: { host: "opencode", session: started.session }, idempotency_key: "send-1", launch: record }).message;
  const permissionContext = {
    store,
    launchDir: (id: string) => join(w.dataDir, "inbox", "launch", id),
    rootOf: (id: string) => (id === LAUNCH_ID ? store.message(root.id) : null),
    roots: () => [store.message(root.id)!],
    displayFolder: (path: string) => path,
    host: { stateOf: () => null, readAt: () => 0 },
    onChange: () => {},
  };
  const permissions = host.permissions(permissionContext);
  /** The next Inbox (after `close`): a new host over the same data dir and thread. */
  const next = (opts: Parameters<typeof createOpenCodeLaunchHost>[1] = {}) => {
    const again = createOpenCodeLaunchHost(w.ctx, opts);
    again.permissions(permissionContext);
    return again;
  };
  const serverFile = join(w.dataDir, "inbox", "launch", LAUNCH_ID, "server.json");
  const server = () => JSON.parse(readFileSync(serverFile, "utf8")) as { pid: number; started: string; url: string; password: string };
  /** A turn, as the wake puts it (no Inbox runs in a unit test, so the test is the wake). */
  const turn = async (text = "Go on (msg_01KAAAAAAAAAAAAAAAAAAAAAAA)") => {
    const s = server();
    const response = await fetch(`${s.url}/session/${started.session}/prompt_async?directory=${encodeURIComponent(w.folder)}`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${s.password}`).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
    expect(response.status).toBe(204);
  };
  /** The thread's permission questions, in order. */
  const cards = () =>
    store
      .threadMessageIds(root.thread_id)
      .map((id) => store.message(id)!)
      .filter((m) => m.author.session?.startsWith("perm:") && store.questionsOf(m.id).length > 0);
  const stateOf = (id: string) => store.questionsOf(id)[0]!.state;
  /** The withdrawal follow-up's words for a question, or null. */
  const withdrawnAs = (id: string) => {
    for (const mid of store.threadMessageIds(root.thread_id)) {
      const m = store.message(mid)!;
      if (m.supersedes?.includes(id)) return m.body;
    }
    return null;
  };
  const answer = (messageId: string, pick: { selected?: string[]; other?: string }) => {
    const question = store.questionsOf(messageId)[0]!;
    const picked = { v: 1 as const, key: question.key, kind: "single" as const, prompt: question.prompt, selected: pick.selected ?? [], ...(pick.other ? { other: pick.other } : {}) };
    const saved = store.savePicks(messageId, [{ key: question.key, revision: question.revision, answer: picked }], { unsentOnly: true });
    store.sendReply(messageId, { idempotency_key: `answer-${messageId}`, questions: [{ key: question.key, revision: saved[0]!.revision }] });
  };
  /** The engine's sweep, every 50 ms, until the test ends. */
  let sweeping = options.sweep !== false;
  void (async () => {
    while (sweeping) {
      permissions.sweep();
      await Bun.sleep(50);
    }
  })();
  cleanup.push(() => {
    sweeping = false;
  });
  return { ...w, host, store, thread: root, record, session: started.session, serverFile, server, turn, cards, stateOf, withdrawnAs, answer, next };
}

/** A process the test owns, in its own group (as a launch's server is): a stand-in for a reused pid. */
function stranger(command: string[]): number {
  const child = spawn(command[0]!, command.slice(1), { stdio: "ignore", detached: true, env: { PATH: "/usr/bin:/bin" } });
  child.unref();
  const pid = child.pid!;
  cleanup.push(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone.
    }
  });
  return pid;
}

describe("only our own server is adopted or signalled", () => {
  test("a stale server.json naming another program's pid: dropped, never adopted, never signalled", async () => {
    const w = await launched();
    await w.host.stop(w.session);
    // The pid now runs something else (a reused pid), in its own group, with its start time on record.
    const pid = stranger(["/bin/sleep", "60"]);
    await until("the stand-in runs", () => openCodeProcessOf(pid) !== null);
    const forged = JSON.stringify({ pid, started: openCodeProcessOf(pid)!.started, url: "http://127.0.0.1:9", password: "a".repeat(48) });
    writeFileSync(w.serverFile, forged);
    // Stop with no connection: never signalled.
    expect((await w.host.stop(w.session)).text).toContain("not our server");
    expect(alive(pid)).toBe(true);
    // A reply: not adopted; a new server of our own instead. The stand-in still runs.
    writeFileSync(w.serverFile, forged);
    expect((await w.host.resume(w.record)).failure).toBeNull();
    expect(w.server().pid).not.toBe(pid);
    expect(w.fake.serves()).toHaveLength(2);
    await w.host.stop(w.session);
    expect(alive(pid)).toBe(true);
    // What `ours` asks of the command line: `opencode serve` on the server's own port.
    expect(isOpenCodeServe("/x/opencode serve --hostname 127.0.0.1 --port 5", 5)).toBe(true);
    expect(isOpenCodeServe("/x/opencode serve --hostname 127.0.0.1 --port 5", 6)).toBe(false);
    expect(isOpenCodeServe("/bin/sleep 60", 5)).toBe(false);
  }, 60_000);

  test("a server that takes any request (no password): never adopted, never signalled", async () => {
    const w = await launched();
    await w.host.stop(w.session);
    // Another `opencode serve`, one that answers without a password (the person's own, say), on a port of its own.
    const other = installFakeOpenCode({ bin: join(w.root, "bin-other"), state: join(w.root, "fake-other"), config: { acceptAnyAuth: true } });
    cleanup.push(() => other.stopAll());
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const pid = stranger([join(w.root, "bin-other", "opencode"), "serve", "--hostname", "127.0.0.1", "--port", String(port)]);
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/global/health`).then((r) => r.ok).catch(() => false);
      if (!up) await Bun.sleep(100);
    }
    expect(up).toBe(true);
    // Everything `ps` can tell matches; only its answer without a password gives it away.
    expect(isOpenCodeServe(openCodeProcessOf(pid)!.command, port)).toBe(true);
    const forged = JSON.stringify({ pid, started: openCodeProcessOf(pid)!.started, url: `http://127.0.0.1:${port}`, password: "b".repeat(48) });
    writeFileSync(w.serverFile, forged);
    expect((await w.host.stop(w.session)).text).toContain("not our server");
    expect(alive(pid)).toBe(true);
    writeFileSync(w.serverFile, forged);
    expect((await w.host.sessions())(w.session)).toMatchObject({ state: "stopped" });
    expect(w.logs.some((line) => line.includes("answers without the password"))).toBe(true);
    expect(alive(pid)).toBe(true);
  }, 60_000);
});

describe("Stop and Delete while it starts again", () => {
  test("Stop during a reply's restart cancels it: the new server ends, nothing is left, no failure", async () => {
    const w = await launched();
    await w.host.stop(w.session);
    w.fake.configure({ serveDelayMs: 4_000 });
    const resuming = w.host.resume(w.record);
    await until("the new server spawned", () => w.fake.serves().length === 2);
    // server.json is written at once, before the wait: an Inbox that dies now leaves a server the next one can prove and end.
    await until("server.json before the wait", () => existsSync(w.serverFile));
    const pending = w.server();
    expect(pending.pid).toBe(w.fake.serves()[1]!.pid);
    expect((await w.host.stop(w.session)).exitCode).toBe(0);
    expect(await resuming).toMatchObject({ exitCode: 0, failure: null });
    await until("the new server ended", () => !alive(pending.pid));
    expect(existsSync(w.serverFile)).toBe(false);
  }, 60_000);

  test("Delete during a reply's restart (its folder removed): no throw, the server ends, the folder is never made again", async () => {
    const w = await launched();
    await w.host.stop(w.session);
    w.fake.configure({ serveDelayMs: 4_000 });
    const resuming = w.host.resume(w.record);
    await until("the new server spawned", () => w.fake.serves().length === 2);
    const pid = w.fake.serves()[1]!.pid;
    const dir = join(w.dataDir, "inbox", "launch", LAUNCH_ID);
    rmSync(dir, { recursive: true, force: true });
    await expect(resuming).resolves.toMatchObject({ exitCode: 0, failure: null });
    await until("the server ended", () => !alive(pid));
    expect(existsSync(dir)).toBe(false);
  }, 60_000);
});

describe("permission prompts", () => {
  test("a subagent's prompt (a child session, looked up): asked on the card with its note, answered on the server", async () => {
    const w = await launched({ config: { subagent: true, prompts: [{ permission: "bash", patterns: ["ls"], always: ["ls *"], metadata: { command: "ls" } }] } });
    await w.turn();
    await until("the card", () => w.cards().length === 1);
    const card = w.cards()[0]!;
    expect(card.body).toContain("From a subagent (Look around (@explore subagent)).");
    w.answer(card.id, { selected: ["Allow once"] });
    await until("the reply", () => w.fake.replies().some((r) => r.reply === "once"));
    const child = w.fake.sessions().find((s) => s.parentID === w.session)!;
    expect(w.fake.replies().find((r) => r.reply === "once")!.session).toBe(child.id);
  }, 30_000);

  test("a subagent announced with session.created is known without a lookup", async () => {
    const w = await launched({ config: { subagent: true, announceChild: true, prompts: [{ permission: "bash", patterns: ["ls"], metadata: { command: "ls" } }] } });
    await w.turn();
    await until("the card", () => w.cards().length === 1);
    expect(w.cards()[0]!.body).toContain("From a subagent");
  }, 30_000);

  test("OpenCode's cascade: an always allows the prompts it covers, a reject denies the others; their cards say so", async () => {
    const build = { permission: "bash", patterns: ["bun run build"], always: ["bun run *"], metadata: { command: "bun run build" } };
    const check = { permission: "bash", patterns: ["bun run test"], always: ["bun run *"], metadata: { command: "bun run test" } };
    const w = await launched({ config: { parallel: true, prompts: [build, check] } });
    await w.turn();
    await until("two cards", () => w.cards().length === 2);
    const [first, second] = w.cards();
    w.answer(first!.id, { selected: ["Allow `bun run` for this session"] });
    await until("the second withdrawn", () => w.withdrawnAs(second!.id) !== null);
    expect(w.withdrawnAs(second!.id)).toBe(OPENCODE_ALLOWED_EARLIER);
    expect(w.fake.replies().filter((r) => r.cascade)).toHaveLength(1);

    // The next turn: a Deny rejects the other prompt with it.
    await Bun.sleep(800);
    await w.turn();
    await until("two more cards", () => w.cards().length === 4);
    const [, , third, fourth] = w.cards();
    w.answer(third!.id, { other: "Not now." });
    await until("the fourth withdrawn", () => w.withdrawnAs(fourth!.id) !== null);
    expect(w.withdrawnAs(fourth!.id)).toBe(OPENCODE_DENIED_EARLIER);
  }, 30_000);

  test("a reply the server did not take is sent again, never lost", async () => {
    const w = await launched({ config: { failReplies: 2, prompts: [{ permission: "bash", patterns: ["ls"], metadata: { command: "ls" } }] } });
    await w.turn();
    await until("the card", () => w.cards().length === 1);
    w.answer(w.cards()[0]!.id, { selected: ["Allow once"] });
    await until("taken at the third try", () => w.fake.replies().some((r) => r.reply === "once"), 20_000);
    expect(w.fake.failedReplies()).toHaveLength(2);
  }, 30_000);

  test("a brief outage strands nothing; after a longer one the server is adopted again and the prompt asked anew", async () => {
    const w = await launched({ config: { prompts: [{ permission: "bash", patterns: ["ls"], metadata: { command: "ls" } }] } });
    await w.turn();
    await until("the card", () => w.cards().length === 1);
    const card = w.cards()[0]!;
    // About a second of no answer: the stream drops, the health checks retry, nothing is withdrawn.
    w.fake.configure({ outageUntil: Date.now() + 1_200 });
    await Bun.sleep(3_500);
    expect(w.stateOf(card.id)).toBe("open");
    // Longer: the connection is lost and the card withdrawn; once the server answers again it is adopted and asked anew.
    w.fake.configure({ outageUntil: Date.now() + 6_000 });
    await until("withdrawn", () => w.stateOf(card.id) === "superseded", 15_000);
    await until("asked anew", () => w.cards().length === 2 && w.stateOf(w.cards()[1]!.id) === "open", 30_000);
    w.answer(w.cards()[1]!.id, { selected: ["Allow once"] });
    await until("the reply", () => w.fake.replies().some((r) => r.reply === "once"));
    // The same server all along: adopted again, never ended.
    expect(w.fake.serves()).toHaveLength(1);
  }, 60_000);
});

describe("an idle server", () => {
  test("stopped after the idle time with no turn and no prompt; the line says so; a reply continues it; a running turn keeps it", async () => {
    const w = await launched({ idleMs: 600, config: { hold: true } });
    const pid = w.server().pid;
    // A turn runs: kept past the idle time.
    await w.turn();
    await Bun.sleep(1_800);
    expect(alive(pid)).toBe(true);
    // The turn ends: stopped once the idle time passes.
    w.fake.configure({ hold: false });
    await until("stopped for idle", () => !alive(pid), 15_000);
    await until("server.json gone", () => !existsSync(w.serverFile));
    expect((await w.host.sessions())(w.session)).toEqual({ status: null, state: "stopped", waitingFor: null });
    expect(w.host.stoppedNote!(w.record)).toBe("It was idle for 1 minute. Your reply continues it.");
    expect(w.host.live(w.session)).toBeNull();
    // A reply continues the same session on a new server; the idle mark goes.
    expect((await w.host.resume(w.record)).failure).toBeNull();
    expect((await w.host.sessions())(w.session)).toMatchObject({ state: "running" });
    expect(w.host.stoppedNote!(w.record)).toBeNull();
    await w.host.stop(w.session);
  }, 40_000);
});

describe("the Inbox stops", () => {
  test("close ends a server with nothing to do (a reply continues it), and keeps one running a turn for the next Inbox, which adopts it", async () => {
    const quiet = await launched({});
    const idle = quiet.server().pid;
    quiet.host.close!();
    expect(quiet.host.live(quiet.session)).toBeNull();
    await until("the idle server ended", () => !alive(idle), 10_000);
    // Its file stays until the process is gone; the next Inbox drops it then, signalling nothing.
    await quiet.next().sessions();
    expect(existsSync(quiet.serverFile)).toBe(false);

    const w = await launched({ config: { hold: true } });
    const pid = w.server().pid;
    await w.turn();
    await untilAsync("busy", async () => (await w.host.sessions())(w.session)?.status === "busy");
    w.host.close!();
    await Bun.sleep(300);
    expect(alive(pid)).toBe(true);
    // The next Inbox adopts the same server: running, and no second one.
    const again = w.next();
    await untilAsync("adopted again", async () => (await again.sessions())(w.session)?.state === "running");
    expect(w.server().pid).toBe(pid);
    expect(w.fake.serves()).toHaveLength(1);
    await again.stop(w.session);
    await until("ended", () => !alive(pid), 10_000);
  }, 40_000);
});

describe("a reply while our server does not answer yet (after an Inbox restart)", () => {
  /** A launch running a turn, the Inbox closed; its server then stops answering for a while. */
  const restarted = async (outageMs: number) => {
    const w = await launched({ config: { hold: true } });
    const pid = w.server().pid;
    await w.turn();
    await untilAsync("busy", async () => (await w.host.sessions())(w.session)?.status === "busy");
    w.host.close!();
    w.fake.configure({ outageUntil: Date.now() + outageMs, outagePids: [pid] });
    return { w, pid };
  };

  test("it answers within the wait: the reply goes to the same server, even while a sweep's adoption found nothing", async () => {
    const { w, pid } = await restarted(4_000);
    // The real wait (20 s): each try it starts must fit in it, counted against a server that hangs.
    const again = w.next();
    // A sweep's adoption under way (it finds nothing while the server does not answer), then the reply.
    void again.sessions();
    await Bun.sleep(100);
    const resumed = await again.resume(w.record);
    expect(resumed.failure).toBeNull();
    expect(w.server().pid).toBe(pid);
    expect(w.fake.serves()).toHaveLength(1);
    await again.stop(w.session);
  }, 40_000);

  test("it does not answer within the wait: it is ended before a new one starts, never two servers on the session", async () => {
    const { w, pid } = await restarted(120_000);
    const again = w.next({ replyWaitMs: 1_500 });
    const resumed = await again.resume(w.record);
    expect(resumed.failure).toBeNull();
    expect(alive(pid)).toBe(false);
    const now = w.server();
    expect(now.pid).not.toBe(pid);
    expect(alive(now.pid)).toBe(true);
    expect(w.fake.serves()).toHaveLength(2);
    expect(w.fake.processes().filter((x) => x.kind === "server" && x.alive)).toHaveLength(1);
    await again.stop(w.session);
  }, 40_000);
});

describe("Stop, close and a later reply around a server that does not answer", () => {
  /** A launch running a turn, the Inbox closed; its server then does not answer (an outage in it alone). */
  const silent = async () => {
    const w = await launched({ config: { hold: true } });
    const pid = w.server().pid;
    await w.turn();
    await untilAsync("busy", async () => (await w.host.sessions())(w.session)?.status === "busy");
    w.host.close!();
    w.fake.configure({ outageUntil: Date.now() + 120_000, outagePids: [pid] });
    return { w, pid };
  };
  const aliveServers = (w: Awaited<ReturnType<typeof launched>>) => w.fake.processes().filter((x) => x.kind === "server" && x.alive);

  test("Stop while a reply waits on a sweep's adoption: the Stop holds; no server starts, none is left", async () => {
    const { w } = await silent();
    const again = w.next({ replyWaitMs: 3_000 });
    void again.sessions();
    await Bun.sleep(100);
    const resumed = again.resume(w.record);
    await Bun.sleep(100);
    await again.stop(w.session);
    expect((await resumed).failure).toBeNull();
    await Bun.sleep(500);
    expect(w.fake.serves()).toHaveLength(1);
    expect(aliveServers(w)).toHaveLength(0);
  }, 40_000);

  test("the Inbox closes while a reply waits on a sweep's adoption: nothing starts during shutdown", async () => {
    const { w, pid } = await silent();
    const again = w.next({ replyWaitMs: 3_000 });
    void again.sessions();
    await Bun.sleep(100);
    const resumed = again.resume(w.record);
    await Bun.sleep(100);
    again.close!();
    expect((await resumed).failure).toBeNull();
    await Bun.sleep(500);
    expect(w.fake.serves()).toHaveLength(1);
    // The busy server runs on for the next Inbox, still named by its file.
    expect(w.server().pid).toBe(pid);
  }, 40_000);

  test("a server that hangs (no answer at all): the reply's whole wait stays within 20 s, then a new server", async () => {
    const { w, pid } = await silent();
    w.fake.configure({ outageHangs: true });
    const again = w.next();
    const t0 = Date.now();
    const resumed = await again.resume(w.record);
    const took = Date.now() - t0;
    expect(resumed.failure).toBeNull();
    // About 20 s of waiting (no call runs past it), then the end of the old server and a new one: well inside the
    // engine's 60 s start grace.
    expect(took).toBeGreaterThan(17_000);
    expect(took).toBeLessThan(25_000);
    expect(alive(pid)).toBe(false);
    expect(aliveServers(w)).toHaveLength(1);
    await again.stop(w.session);
  }, 60_000);

  test("after Stop of a server that did not answer, a later reply starts at once (no wait for a server that is gone)", async () => {
    const { w } = await silent();
    const again = w.next({ replyWaitMs: 8_000 });
    await again.sessions();
    await again.stop(w.session);
    w.fake.configure({ outageUntil: 0 });
    const t0 = Date.now();
    const resumed = await again.resume(w.record);
    expect(resumed.failure).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(aliveServers(w)).toHaveLength(1);
    await again.stop(w.session);
  }, 40_000);

  test("close sends SIGTERM to an idle server that ignores it: its file stays, and the next Inbox adopts and ends it", async () => {
    const w = await launched({ config: { ignoreSigterm: true } });
    const pid = w.server().pid;
    w.host.close!();
    await until("SIGTERM ignored", () => w.fake.sigtermsIgnored() > 0, 10_000);
    expect(alive(pid)).toBe(true);
    expect(w.server().pid).toBe(pid);
    const again = w.next();
    await untilAsync("adopted", async () => (await again.sessions())(w.session)?.state === "running");
    await again.stop(w.session);
    await until("ended (SIGKILL)", () => !alive(pid), 10_000);
  }, 40_000);
});

describe("idle stop and a turn that comes while it reads the server", () => {
  test("a turn that arrives during the idle stop's last read keeps the server; it is not aborted", async () => {
    const w = await launched({ idleMs: 600, config: { permissionListDelayMs: 1_500, hold: true } });
    const pid = w.server().pid;
    // The idle stop's last read (GET /permission, slow here; the first one is the connection's catch-up) is under
    // way: a turn comes meanwhile.
    await until("the idle stop reads the server", () => w.fake.permissionLists() >= 2, 10_000);
    await w.turn();
    await Bun.sleep(2_500);
    expect(alive(pid)).toBe(true);
    expect(w.host.stoppedNote!(w.record)).toBeNull();
    expect(w.fake.aborts()).toEqual([]);
    w.fake.configure({ hold: false, permissionListDelayMs: 0 });
    await w.host.stop(w.session);
  }, 30_000);
});

describe("idle with no sweep", () => {
  test("Launch off (the engine sweeps no host): an idle server is still stopped on the host's own timer", async () => {
    const w = await launched({ idleMs: 600, sweep: false });
    const pid = w.server().pid;
    await until("stopped for idle", () => !alive(pid), 15_000);
    expect(w.host.stoppedNote!(w.record)).toBe("It was idle for 1 minute. Your reply continues it.");
  }, 30_000);
});

describe("pure parts", () => {
  test("version and the listening line", () => {
    expect(parseOpenCodeVersion("1.18.23\n")).toBe("1.18.23");
    expect(parseListening("Warning: x\nopencode server listening on http://127.0.0.1:47961\n")).toBe("http://127.0.0.1:47961");
    expect(parseListening("opencode server listening on http://0.0.0.0:1\n")).toBeNull();
  });

  test("the server env: the launch filter, no other server's password, this launch's names", () => {
    const env = openCodeServerEnv({ PATH: "/bin", OPENCODE_SERVER_PASSWORD: "theirs", OPENCODE_SERVER_USERNAME: "u", PLANNOTATOR_DATA_DIR: "/real", PLANNOTATOR_SESSION_TAG: "t", ANTHROPIC_API_KEY: "k" }, { launchId: LAUNCH_ID, password: "p".repeat(48), dataDir: "/test" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k", OPENCODE_SERVER_PASSWORD: "p".repeat(48), PLANNOTATOR_INBOX_TOOL: "1", PLANNOTATOR_LAUNCH: LAUNCH_ID, PLANNOTATOR_DATA_DIR: "/test" });
    // The default data dir: no PLANNOTATOR_DATA_DIR at all (the plugin's own default is the same).
    expect(openCodeServerEnv({}, { launchId: LAUNCH_ID, password: "x", dataDir: null })).not.toHaveProperty("PLANNOTATOR_DATA_DIR");
  });

  test("the attach command quotes the folder, and with no server opens the session from the database", () => {
    expect(openCodeAttachCommand("/a b/it's", "ses_1", null)).toBe(`cd '/a b/it'\\''s' && opencode --session ses_1`);
  });

  test("the plugin says replies come back as turns only in a launch's server", () => {
    expect(openCode1LaunchWakes({ PLANNOTATOR_LAUNCH: LAUNCH_ID })).toBe(true);
    expect(openCode1LaunchWakes({})).toBe(false);
    expect(openCode1LaunchWakes({ PLANNOTATOR_LAUNCH: "yes" })).toBe(false);
  });
});

describe("OpenCode's permission prompts", () => {
  const terms = openCodePermissionTerms((p) => p);
  const asked = (value: Record<string, unknown>) => readOpenCodePermission({ id: "per_1", sessionID: "ses_1", ...value })!;

  test("a command: Allow once, Allow <its always rule> for this session, Deny; no mode switch, no Terminal hand-off", () => {
    const event = openCodePermissionEvent(asked({ permission: "bash", patterns: ["git status"], always: ["git status *"], metadata: { command: "git status" } }), "/p");
    expect(event).toMatchObject({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/p" });
    const q = inboxPermissionQuestion(event, { agent: "OpenCode", folder: "/p", ...terms });
    expect(q.prompt).toBe("OpenCode wants to run a command");
    expect(q.choices).toEqual(["Allow once", "Allow `git status` for this session", "Deny"]);
    // The pick by its label, as OpenCode's reply.
    const pick = (label: string, other: string | null = null) => inboxPermissionAnswer({ selected: [label], other, note: null, skipped: false } as never, event, terms);
    expect(openCodeReply(pick("Allow once").choice, null)).toEqual({ reply: "once" });
    const session = pick("Allow `git status` for this session");
    expect(openCodeReply(session.choice, session.reason)).toEqual({ reply: "always" });
    const deny = inboxPermissionAnswer({ selected: [], other: "not now", note: null, skipped: false } as never, event, terms);
    expect(openCodeReply(deny.choice, deny.reason)).toEqual({ reply: "reject", message: "The person denied this in the Plannotator Inbox. Do not retry it; go on with the next step without it. Their reason: not now" });
  });

  test("a file change shows OpenCode's own diff; `*` is every file edit", () => {
    const diff = "Index: /p/a.txt\n===\n--- /p/a.txt\n+++ /p/a.txt\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
    const event = openCodePermissionEvent(asked({ permission: "edit", patterns: ["a.txt"], always: ["*"], metadata: { filepath: "/p/a.txt", diff } }), "/p");
    const q = inboxPermissionQuestion(event, { agent: "OpenCode", folder: "/p", ...terms });
    expect(q.prompt).toBe("OpenCode wants to edit a file");
    expect(q.body).toContain("```diff\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n```");
    expect(q.body).not.toContain("Index:");
    expect(q.choices).toEqual(["Allow once", "Allow every file edit for this session", "Deny"]);
  });

  test("a permission the card has no words for keeps its own name and shows its input whole", () => {
    const event = openCodePermissionEvent(asked({ permission: "external_directory", patterns: ["/etc/*"], always: ["/etc/*"], metadata: { filepath: "/etc/hosts" } }), "/p");
    const q = inboxPermissionQuestion(event, { agent: "OpenCode", folder: "/p", ...terms });
    expect(q.prompt).toBe("OpenCode wants to use `external_directory`");
    expect(q.body).toContain('"/etc/hosts"');
    expect(readOpenCodePermission({ id: "nope", sessionID: "s", permission: "bash" })).toBeNull();
  });
});
