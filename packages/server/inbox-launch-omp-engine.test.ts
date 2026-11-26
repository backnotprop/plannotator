/**
 * Oh My Pi through the real launch engine (inbox-launch.ts with its own hosts, no test host), against the fake `omp`
 * and the fake `pi` (tests/helpers/fake-omp, fake-pi), never the real ones. What each test guards: To offers
 * "Oh My Pi" as its own row beside "Pi" once `omp` and Plannotator's extension in its plugin record are there, and not
 * before; a Send starts `omp --mode rpc` in the project's folder and addresses the thread to the session id Oh My Pi
 * picked, as host `pi` (its extension polls the Inbox as Pi does), which takes the root; Pi's own row still starts Pi.
 * A reply that Oh My Pi resumes under a newer copy's id moves the thread to that id, and that session takes the reply;
 * later replies to a message from before the move reach it too (its poll's `continues`). With Auto Resume on, a new
 * start never takes a reply waiting for the session it reopened, nor cancels a turn of it.
 * A small bridge stands in for the Inbox's: no Inbox is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeOmp } from "../../tests/helpers/fake-omp";
import { installFakePi } from "../../tests/helpers/fake-pi";
import { stubBridge } from "../../tests/helpers/stub-bridge";
import { createInboxLaunch } from "./inbox-launch";

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

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-omp-engine-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const folder = join(root, "harbor");
  for (const dir of [home, bin, dataDir, folder]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  // The engine reads launch's switch from this data dir's config.json.
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  // Pi and Oh My Pi both on this computer, each with Plannotator's extension.
  const pi = installFakePi({ bin, state: join(root, "fake-pi"), home, config: {} });
  const fake = installFakeOmp({ bin, state: join(root, "fake-omp"), home, config: {} });
  cleanup.push(() => void pi.stopAll());
  cleanup.push(() => void fake.stopAll());
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "harbor", root: folder });
  const bridge = stubBridge(dataDir, store);
  cleanup.push(() => bridge.stop());
  const path = `${bin}:/usr/bin:/bin`;
  /** How far the engine's clock is ahead of the wall clock (past the start's grace). */
  const clock = { ahead: 0 };
  /** A launch engine over this data dir: the Inbox, or the Inbox after a restart. */
  const makeLaunch = () => {
  const made = createInboxLaunch({
    store,
    live: { runStateOf: (session) => bridge.runStateOf(session) },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    // The login shell carries a name of its own, an outer Pi session's markers and Plannotator's own names.
    loginEnv: async () => ({ HOME: home, PATH: path, LOGIN_ONLY: "from-login", PI_SESSION_ID: "outer-session", PI_MODEL: "outer/model", PLANNOTATOR_PORT: "1", PLANNOTATOR_TEST_SANDBOX: "1" }),
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
  cleanup.push(() => made.stop());
  return made;
  };
  const launch = makeLaunch();
  return { store, project, folder, dataDir, pi, fake, bridge, launch, clock, makeLaunch };
}

describe("Oh My Pi through the launch engine, against the fake omp", () => {
  test("To offers Oh My Pi as its own row beside Pi once omp and the extension's plugin record are there, and not before", async () => {
    const { launch } = setup();
    const agents = (await launch.composeBlock())!.agents;
    expect(agents).toContainEqual({ agent: "pi", name: "Pi", scratch_trusted: true });
    expect(agents).toContainEqual({ agent: "oh-my-pi", name: "Oh My Pi", scratch_trusted: true });

    const absent = setup();
    absent.fake.setInstalled(false);
    expect((await absent.launch.composeBlock())!.agents.map((a) => a.agent)).toEqual(expect.not.arrayContaining(["oh-my-pi"]));

    const noPlugin = setup();
    noPlugin.fake.setExtension(false);
    const left = (await noPlugin.launch.composeBlock())!.agents.map((a) => a.agent);
    expect(left).toContain("pi");
    expect(left).not.toContain("oh-my-pi");
  });

  test("Send starts omp in the project's folder; the thread goes to the session Oh My Pi picked, as host pi, which takes the root", async () => {
    const { store, project, folder, pi, fake, bridge, launch } = setup();
    fake.configure({ hold: true });
    const target = launch.target({ launch: { agent: "oh-my-pi", project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy the readme", body: "Tidy the readme.", resolveProject: async () => project });
    expect(prepared.launch.agent).toBe("oh-my-pi");
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy the readme", launch: prepared.launch }).message;
    launch.begin(root);

    const session = await until("the session", () => store.message(root.id)!.launch!.session_ref);
    const [start] = fake.starts();
    expect(start!.argv).toEqual(["--mode", "rpc", "--allow-home"]);
    expect(start!.cwd).toBe(folder);
    expect(store.message(root.id)!.to).toEqual({ host: "pi", session });
    expect(pi.starts()).toEqual([]);
    await until("the root delivered", () => fake.delivered().includes(root.id));
    expect(bridge.polls.has(session)).toBe(true);
    await until("the root marked delivered to that session", () => store.message(root.id)!.delivery);
    expect(store.message(root.id)!.delivery).toMatchObject({ host: "pi", session });
  });

  test("a reply Oh My Pi resumes as a newer copy of its conversation: the thread moves to that session, which takes the reply", async () => {
    const t = setup();
    const target = t.launch.target({ launch: { agent: "oh-my-pi", project_id: t.project.id } })!;
    const prepared = await t.launch.prepare(target, { name: "Tidy the readme", body: "Tidy the readme.", resolveProject: async () => t.project });
    const root = t.store.startPersonThread({ project_id: t.project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy the readme", launch: prepared.launch }).message;
    t.launch.begin(root);
    const session = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    // It answers the root, so its session file is saved; then the Inbox stops (its omp with it) and starts again.
    await until("the session saved", () => t.fake.sessionFiles().some((file) => file.endsWith(`_${session}.jsonl`) && readFileSync(file, "utf8").split("\n").filter(Boolean).length >= 3));
    await t.launch.stop();
    await until("the first omp ended", () => !t.fake.alive(t.fake.starts()[0]!.pid));
    const after = t.makeLaunch();
    t.clock.ahead = 120_000;
    // The window reads the thread once (the engine looks at the host then), as it does after a restart.
    await after.runOf(root.id);
    t.fake.configure({ resumeAs: "continuation" });
    const { reply } = t.store.sendReply(root.id, { words: "Please go on.", idempotency_key: "reply-1" });
    // The server sweeps every second; here the test does (the bridge still reads the old omp live for two seconds).
    const again = await until("a second start", () => (after.sweep(true), t.fake.starts()[1]));
    expect(again.argv).toEqual(["--mode", "rpc", "--allow-home", "--resume", session]);
    const moved = await until("the thread moved", () => {
      const ref = t.store.message(root.id)!.launch!.session_ref;
      return ref !== session ? ref : null;
    });
    expect(t.store.message(root.id)!.to).toEqual({ host: "pi", session: moved });
    await until("the reply delivered to that session", () => t.store.message(reply.id)!.delivery);
    expect(t.store.message(reply.id)!.delivery).toMatchObject({ host: "pi", session: moved });
    after.sweep(true);
    expect(t.fake.starts()).toHaveLength(2);
  }, 30_000);

  /**
   * A thread whose Oh My Pi answered under its first id (X, `answer`: written as its `send_message` writes it), then,
   * after an Inbox restart, resumed as a newer copy (Y) on a reply that Y took.
   */
  async function movedThread() {
    const t = setup();
    const target = t.launch.target({ launch: { agent: "oh-my-pi", project_id: t.project.id } })!;
    const prepared = await t.launch.prepare(target, { name: "Tidy the readme", body: "Tidy the readme.", resolveProject: async () => t.project });
    const root = t.store.startPersonThread({ project_id: t.project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy the readme", launch: prepared.launch }).message;
    t.launch.begin(root);
    const session = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    await until("the session saved", () => t.fake.sessionFiles().some((file) => file.endsWith(`_${session}.jsonl`) && readFileSync(file, "utf8").split("\n").filter(Boolean).length >= 3));
    const answer = t.store.sendMessage({ project_id: t.project.id, author: { kind: "agent", host: "pi", session, name: "Oh My Pi" }, body: "Tidied. Shall I fix the links too?", reply_to: root.id, idempotency_key: "answer-1" }).message;
    await t.launch.stop();
    await until("the first omp ended", () => !t.fake.alive(t.fake.starts()[0]!.pid));
    const after = t.makeLaunch();
    t.clock.ahead = 120_000;
    await after.runOf(root.id);
    t.fake.configure({ resumeAs: "continuation" });
    const { reply } = t.store.sendReply(answer.id, { words: "Yes, please.", idempotency_key: "reply-1" });
    await until("a second start", () => (after.sweep(true), t.fake.starts()[1]));
    const moved = await until("the thread moved", () => {
      const ref = t.store.message(root.id)!.launch!.session_ref;
      return ref !== session ? ref : null;
    });
    await until("the first reply delivered", () => t.store.message(reply.id)!.delivery);
    return { ...t, root, session, moved, answer, after };
  }

  test("after the move, a reply to an older message (written under the first id) reaches the new session", async () => {
    const t = await movedThread();
    // The new session answers under its own id; the person then replies to the older answer, which names the first id.
    t.store.sendMessage({ project_id: t.project.id, author: { kind: "agent", host: "pi", session: t.moved, name: "Oh My Pi" }, body: "Links fixed.", reply_to: t.root.id, idempotency_key: "answer-2" });
    const { reply } = t.store.sendReply(t.answer.id, { words: "And the badges, as you said.", idempotency_key: "reply-2" });
    await until("that reply taken by the new session", () => t.fake.delivered().includes(reply.id), 8_000);
    await until("its delivery recorded", () => t.store.message(reply.id)!.delivery);
    t.after.sweep(true);
    expect(t.fake.starts()).toHaveLength(2);
  }, 40_000);

  test("after the move, the person's next reply, before the new session wrote anything, reaches it", async () => {
    const t = await movedThread();
    // The latest agent message is still the first id's.
    const { reply } = t.store.sendReply(t.answer.id, { words: "One more: the changelog.", idempotency_key: "reply-2" });
    await until("that reply taken by the new session", () => t.fake.delivered().includes(reply.id), 8_000);
    t.after.sweep(true);
    expect(t.fake.starts()).toHaveLength(2);
  }, 40_000);

  test("Auto Resume on, and a reply waits for the session it reopens: the new start never takes that reply, nor cancels a turn of it", async () => {
    const t = setup();
    // An earlier thread in the folder: answered (so its file has turns), then the Inbox stops, and a reply waits for it.
    const target = t.launch.target({ launch: { agent: "oh-my-pi", project_id: t.project.id } })!;
    const first = await t.launch.prepare(target, { name: "Tidy the readme", body: "Tidy the readme.", resolveProject: async () => t.project });
    const root = t.store.startPersonThread({ project_id: t.project.id, body: "Tidy the readme.", to: first.to, idempotency_key: "send-1", thread_name: "Tidy the readme", launch: first.launch }).message;
    t.launch.begin(root);
    const earlier = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    await until("the session saved", () => t.fake.sessionFiles().some((file) => file.endsWith(`_${earlier}.jsonl`) && readFileSync(file, "utf8").split("\n").filter(Boolean).length >= 3));
    const answer = t.store.sendMessage({ project_id: t.project.id, author: { kind: "agent", host: "pi", session: earlier, name: "Oh My Pi" }, body: "Tidied.", reply_to: root.id, idempotency_key: "answer-1" }).message;
    await t.launch.stop();
    await until("the first omp ended", () => !t.fake.alive(t.fake.starts()[0]!.pid));
    const { reply } = t.store.sendReply(answer.id, { words: "Thanks, now the links.", idempotency_key: "reply-1" });
    // Auto Resume on, and Oh My Pi's other extensions slow to start: get_state waits while the extension is up.
    t.fake.configure({ autoResume: true, startMs: 1_500 });
    const after = t.makeLaunch();
    const second = await after.prepare(after.target({ launch: { agent: "oh-my-pi", project_id: t.project.id } })!, { name: "Write the changelog", body: "Write the changelog.", resolveProject: async () => t.project });
    const root2 = t.store.startPersonThread({ project_id: t.project.id, body: "Write the changelog.", to: second.to, idempotency_key: "send-2", thread_name: "Write the changelog", launch: second.launch }).message;
    after.begin(root2);
    const fresh = await until("the new session", () => t.store.message(root2.id)!.launch!.session_ref, 15_000);
    expect(fresh).not.toBe(earlier);
    await until("the new thread's root delivered", () => t.fake.delivered().includes(root2.id), 8_000);
    // The reply for the reopened session was never handed to this process, so no turn of it was cut off.
    expect(t.fake.delivered()).not.toContain(reply.id);
    expect(t.fake.cancelled()).toEqual([]);
    expect(t.store.message(reply.id)!.delivery).toBeUndefined();
  }, 40_000);
});
