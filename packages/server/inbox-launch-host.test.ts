/**
 * The agent-host seam (inbox-launch-host.ts), on a real launch engine over a temp data dir. What each test
 * guards: a second agent registered as a `LaunchHost` drives the whole shared flow with no engine change
 * (To offers it, Send starts it and addresses the thread to it, the run line follows its own live state, its
 * permission question is written as its own agent, a reply after Stop restarts it once, Stop calls its stop
 * and withdraws through its transport, Delete calls its remove), so Claude Code is not wired into the engine; and a
 * record whose agent has no host here (after a downgrade) shows no line, is skipped by the sweep and answers
 * `launch_not_found`, never a crash. The optional seams: a host's own login-shell read (`context.loginEnv`),
 * `close` when the Inbox stops, a per-launch `stoppedNote`, a `resume` that throws (a failed restart, never
 * an unhandled rejection), and `trustOffer`: Trust folder starts a launch refused for trust once and only once,
 * for the owner alone, and a failed write leaves the message kept and says why.
 *
 * `fakeLaunchHost` (tests/helpers/fake-launch-host.ts) is the engine's test fake. Claude Code's host is there too
 * and stays out of the way: no `claude` is on the sandbox PATH.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { INBOX_RUN_START_GRACE_MS } from "@plannotator/core/inbox-run-line";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { launchNoteText, writeLaunchNote, type LaunchHost, type LaunchHostContext, type LaunchLive, type LaunchTrustOffer } from "./inbox-launch-host";
import { createLaunchQuestions } from "./inbox-launch-permission";

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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-host-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "project");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(folder, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const clock = { now: Date.parse("2026-10-30T15:00:00.000Z") };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "project", root: folder });
  const fake = fakeLaunchHost();
  /** The login-shell reads the engine made, and the context it gave the hosts. */
  const logins = { count: 0 };
  let context: LaunchHostContext | null = null;
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => (logins.count++, { HOME: home, PATH: "", FAKE_LOGIN: "yes" }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: (made) => ((context = made), [fake.host]),
    now: () => clock.now,
  });
  restore.push(() => launch.stop());
  /** From the window. `warning`: what a Trust folder click says the person read; by default the offer's line, as the window sends it. */
  const post = (id: string, action: string, via = "local", owner?: boolean, warning: string | null | undefined = fake.faults.offer?.read().warning) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv", warning }) }),
      `/api/inbox/launch/${id}/${action}`,
      via,
      owner,
    );
  return { store, clock, project, fake, launch, post, logins, context: () => context! };
}

/** An offer whose reading is one line, and no facts. */
const offerOf = (warning: string | null, accept: () => Promise<void>): LaunchTrustOffer => ({ folder: "/trusted", read: () => ({ warning, facts: [], warns: false }), accept });

/** Wait for the engine's background work (a start, a restart) to land. */
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe("a thread note quoting an agent", () => {
  test("one line of what can be seen: a control, a bidi mark or a line break can't hide or reorder the text; an emoji's joiner stays", () => {
    expect(launchNoteText("rate‮ limit\n\treached\u0007", 80)).toBe("rate limit reached");
    expect(launchNoteText("🧑‍💻", 80)).toBe("🧑‍💻");
    expect(launchNoteText(null, 80)).toBe("");
  });

  test("its Markdown is escaped, so a provider's text can't draw a link or a heading in the thread", () => {
    expect(launchNoteText("# see [this](http://x) `now`", 80)).toBe("\\# see \\[this\\](http://x) \\`now\\`");
  });

  test("cut by characters to the limit, never through an emoji", () => {
    expect(launchNoteText("😀".repeat(10), 5)).toBe(`${"😀".repeat(4)}…`);
  });

  test("the note answers the thread's latest message, as the session; a failed write is logged and ends nothing", () => {
    const { store, project } = setup();
    const { message: root } = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "fake-agent", session: "s1", name: "Fake Agent" }, body: "first", idempotency_key: "root" });
    const { message: second } = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "fake-agent", session: "s1", name: "Fake Agent" }, body: "second", reply_to: root.id, idempotency_key: "second" });
    const changed: string[] = [];
    const lines: string[] = [];
    const note = { author: { host: "fake-agent", session: "s1", name: "Fake Agent" }, body: "It failed.", key: "note-1" };
    writeLaunchNote({ store, onChange: () => changed.push("changed") }, root, note, (line) => lines.push(line));
    const written = store.message(store.threadMessageIds(root.thread_id).at(-1)!)!;
    expect(written).toMatchObject({ body: "It failed.", reply_to: second.id, author: { kind: "agent", session: "s1" } });
    expect(changed).toEqual(["changed"]);

    const broken = { sendMessage: () => { throw new Error("the disk is full"); }, threadMessageIds: () => [] } as unknown as InboxStore;
    writeLaunchNote({ store: broken, onChange: () => changed.push("changed") }, root, note, (line) => lines.push(line));
    expect(lines.join("\n")).toContain("the disk is full");
    expect(changed).toEqual(["changed"]);
  });
});

describe("a second agent behind LaunchHost", () => {
  test("drives the shared flow: offered, started, its line, its question, Stop, a reply restarts it once, Delete", async () => {
    const { store, clock, project, fake, launch, post } = setup();

    // To offers it (Claude Code is not on the sandbox PATH).
    expect((await launch.composeBlock())!.agents).toEqual([{ agent: FAKE, name: "Fake Agent", scratch_trusted: true }]);

    // Send: the thread is addressed to the agent's placeholder, then its own session.
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy the readme", body: "Tidy the readme.", resolveProject: async () => project });
    expect(prepared.launch.agent).toBe(FAKE);
    expect(prepared.to.host).toBe(FAKE);
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy the readme", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
    expect(fake.calls).toEqual(["start Tidy the readme"]);
    expect(store.message(root.id)!.to).toEqual({ host: FAKE, session: "session-f1" });
    expect((await launch.runOf(root.id))!.state).toBe("starting");

    // Its own live state drives the line: it takes the turn and works, then rests.
    fake.poll("session-f1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-f1" });
    expect(await launch.runOf(root.id)).toMatchObject({ state: "working", agent: FAKE, attach_command: "fake attach f1" });
    const answer = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: FAKE, session: "session-f1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-1" }).message;
    fake.poll("session-f1", false, clock.now);
    expect(await launch.runOf(root.id)).toBeNull();

    // Its permission question is written by the shared code as its own agent, never as Claude Code.
    const asked = fake.ask(store.message(root.id)!, "session-f1");
    expect(store.message(asked)!.author).toMatchObject({ kind: "agent", host: FAKE, name: "Fake Agent" });
    expect(store.questionsOf(asked)[0]!.state).toBe("open");

    // Stop goes to its host, and withdraws the open question through its transport.
    const stopped = (await (await post(prepared.launch.id, "stop"))!.json()) as { run: { state: string; stopped_by_person: boolean } };
    expect(fake.calls.slice(-2)).toEqual(["stop f1", "withdrawAll f1"]);
    expect(stopped.run).toMatchObject({ state: "stopped", stopped_by_person: true });
    expect(store.questionsOf(asked)[0]!.state).toBe("superseded");

    // A reply to the stopped session restarts it, once per reply.
    clock.now += 1_000;
    store.sendReply(answer.id, { words: "One more thing.", idempotency_key: "reply-1" });
    await until(() => fake.calls.includes("resume f1"));
    expect(await launch.runOf(root.id)).toMatchObject({ state: "starting", again: true });
    launch.sweep(true);
    expect(fake.calls.filter((call) => call === "resume f1")).toHaveLength(1);

    // Delete: stopped and removed by its host, withdrawn through its transport; a project folder is never purged.
    const before = fake.calls.length;
    expect(await (await post(prepared.launch.id, "delete"))!.json()).toEqual({ ok: true });
    expect(fake.calls.slice(before)).toEqual(["stop f1", "remove f1", "withdrawAll f1"]);
    expect(store.message(root.id)!.launch!.deleted_at).toBeTruthy();
  });

  test("a host whose resume throws: a failed restart on the line, never an unhandled rejection (it would end the Inbox)", async () => {
    const { store, clock, project, fake, launch, post } = setup();
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send-throw", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
    fake.poll("session-f1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-f1" });
    const answer = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: FAKE, session: "session-f1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-throw" }).message;
    await post(prepared.launch.id, "stop");
    fake.faults.resumeThrows = true;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      clock.now += 1_000;
      store.sendReply(answer.id, { words: "One more thing.", idempotency_key: "reply-throw" });
      await until(() => fake.calls.includes("resume f1"));
      clock.now += 120_000;
      // The rejection lands a few ticks later (and would end the process uncaught).
      await Bun.sleep(50);
      expect(unhandled).toEqual([]);
      expect(await launch.runOf(root.id)).toMatchObject({ state: "failed", again: true, cause: "It did not start again." });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a reply waiting while Stop or Delete runs never starts the session again meanwhile; after Stop, only the next reply does", async () => {
    const { store, clock, project, fake, launch, post } = setup();
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send-q", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
    // Mid-turn, past the start grace: the follow-up waits for the turn to end.
    fake.poll("session-f1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-f1" });
    const answer = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: FAKE, session: "session-f1", name: "Fake Agent" }, body: "On it.", reply_to: root.id, idempotency_key: "answer-q" }).message;
    clock.now += 120_000;
    store.sendReply(answer.id, { words: "And the changelog.", idempotency_key: "reply-q1" });
    const resumes = () => fake.calls.filter((call) => call === "resume f1").length;
    const sweeps = async () => {
      for (let i = 0; i < 5; i++) {
        launch.sweep(true);
        await Bun.sleep(5);
      }
    };

    // Stop, slow: no restart while it runs, nor after it for the reply written before it.
    let open: () => void = () => {};
    fake.faults.gate = new Promise((resolve) => (open = resolve));
    const stopped = post(prepared.launch.id, "stop");
    await sweeps();
    expect(resumes()).toBe(0);
    open();
    await stopped;
    fake.faults.gate = null;
    clock.now += 1_000;
    await sweeps();
    expect(resumes()).toBe(0);
    // The person's next reply starts it again (the held one goes along).
    store.sendReply(answer.id, { words: "Go on.", idempotency_key: "reply-q2" });
    await until(() => resumes() === 1);
    await sweeps();
    expect(resumes()).toBe(1);

    // Mid-turn again with a reply waiting; Delete, slow: never started again while it stops and removes.
    fake.poll("session-f1", true, clock.now);
    clock.now += 120_000;
    store.sendReply(answer.id, { words: "One more.", idempotency_key: "reply-q3" });
    fake.faults.gate = new Promise((resolve) => (open = resolve));
    const deleted = post(prepared.launch.id, "delete");
    await sweeps();
    open();
    await deleted;
    await sweeps();
    expect(resumes()).toBe(1);
    expect(store.message(root.id)!.launch!.deleted_at).toBeTruthy();
  });

  test("a host reads the login shell through its context: a fresh read when it asks, shared with one under way", async () => {
    const { logins, context } = setup();
    const [first, second] = await Promise.all([context().loginEnv(), context().loginEnv()]);
    expect(first).toMatchObject({ FAKE_LOGIN: "yes" });
    expect(second).toBe(first);
    expect(logins.count).toBe(1);
    // Never held: the next ask reads it again.
    await context().loginEnv();
    expect(logins.count).toBe(2);
  });

  test("the Inbox stops: each host's close lets go of what it holds", () => {
    const { fake, launch } = setup();
    let closed = 0;
    fake.host.close = () => void closed++;
    launch.stop();
    expect(closed).toBe(1);
  });

  test("a session that stopped without the person's Stop: the host's note for that launch, else today's line", async () => {
    const { store, clock, project, fake, launch, post } = setup();
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const started: InboxMessage[] = [];
    for (const name of ["One", "Two"]) {
      const prepared = await launch.prepare(target, { name, body: `${name}.`, resolveProject: async () => project });
      const root = store.startPersonThread({ project_id: project.id, body: `${name}.`, to: prepared.to, idempotency_key: `send-${name}`, launch: prepared.launch }).message;
      launch.begin(root);
      await until(() => !!store.message(root.id)!.launch!.session_ref);
      started.push(store.message(root.id)!);
    }
    const [one, two] = started as [InboxMessage, InboxMessage];
    // Only the first launch has a note: the note is the host's word on that launch.
    fake.host.stoppedNote = (record) => (record.id === one.launch!.id ? "It ran out of time. Your reply continues it." : null);
    for (const root of [one, two]) {
      const session = store.message(root.id)!.to!.session;
      fake.poll(session, false, clock.now);
      store.recordDelivery(root.id, { host: FAKE, session });
      store.sendMessage({ project_id: project.id, author: { kind: "agent", host: FAKE, session, name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: `answer-${root.id}` });
    }
    // Both sessions end on their own (not the person's Stop), long after their start.
    await fake.host.stop("f1");
    await fake.host.stop("f2");
    clock.now += INBOX_RUN_START_GRACE_MS * 2;
    expect(await launch.runOf(one.id)).toMatchObject({ state: "stopped", stopped_by_person: false, cause: "It ran out of time. Your reply continues it." });
    expect(await launch.runOf(two.id)).toMatchObject({ state: "stopped", stopped_by_person: false, cause: null });
    // The person's own Stop: "You stopped …", never the host's note.
    await post(one.launch!.id, "stop");
    expect(await launch.runOf(one.id)).toMatchObject({ state: "stopped", stopped_by_person: true, cause: null });
  });

  test("a scratch launch's Delete purges its folder through its host", async () => {
    const { store, fake, launch, post } = setup();
    const target = launch.target({ launch: { agent: FAKE, scratch: true } })!;
    const prepared = await launch.prepare(target, { name: "Try a thing", body: "Try a thing.", resolveProject: async (folder) => store.ensureProject({ name: "try-a-thing", root: folder }) });
    const root = store.startPersonThread({ project_id: prepared.project.id, body: "Try a thing.", to: prepared.to, idempotency_key: "send-scratch", thread_name: "Try a thing", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");

    expect(await (await post(prepared.launch.id, "delete"))!.json()).toEqual({ ok: true, scratch_removed: true });
    expect(fake.calls).toEqual(["start Try a thing", "stop f1", "remove f1", "withdrawAll f1", `purge ${prepared.launch.folder}`]);
    expect(existsSync(prepared.launch.folder)).toBe(false);
  });

  test("a launch whose agent has no host here: no line, skipped by the sweep, launch_not_found on its routes", async () => {
    const { store, project, launch, post } = setup();
    const record: InboxLaunchRecord = { id: "lch_01J00000000000000000000000", agent: "gone-agent" as InboxLaunchAgent, session_ref: "g1", folder: project.root, scratch: false, started_at: new Date(Date.now() - INBOX_RUN_START_GRACE_MS * 2).toISOString() };
    const root = store.startPersonThread({ project_id: project.id, body: "Hello.", to: { host: "gone-agent", session: "session-g1" }, idempotency_key: "send-gone", launch: record }).message;

    expect(await launch.runOf(root.id)).toBeNull();
    expect(launch.attachOf(root.id)).toBeNull();
    expect(launch.signature()).toBe(`${record.id}:-`);
    expect(() => launch.sweep(true)).not.toThrow();
    for (const action of ["stop", "open", "delete", "retry"]) await expect(post(record.id, action)).rejects.toMatchObject({ code: "launch_not_found" });
    const hook = new Request(`http://127.0.0.1/api/inbox/launch/${record.id}/permission`, { method: "POST", body: "{}" });
    await expect(launch.permissionRoute(hook, `/api/inbox/launch/${record.id}/permission`)).rejects.toMatchObject({ code: "launch_not_found" });
    // A Send naming it is refused before anything is written.
    expect(() => launch.target({ launch: { agent: "gone-agent", project_id: project.id } })).toThrow(/to\.launch/);
  });
});

describe("Trust folder (`trustOffer`)", () => {
  /** A launch whose start was refused for trust, and an offer that counts its writes and starts the host trusting. */
  async function refused() {
    const world = setup();
    const { store, project, fake, launch } = world;
    fake.faults.untrusted = true;
    const accepts = { count: 0 };
    fake.faults.offer = offerOf("This folder has 1 hook that will run once you trust it.", async () => {
      accepts.count += 1;
      await fake.faults.gate;
      fake.faults.untrusted = false;
    });
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send-trust", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => store.message(root.id)!.launch!.error?.code === "untrusted");
    return { ...world, root, id: prepared.launch.id, accepts };
  }
  const startsOf = (calls: string[]) => calls.filter((call) => call.startsWith("start ")).length;
  const refusal = (promise: Promise<Response | null>) => promise.then(() => null, (error: { code?: string; message?: string }) => error);

  test("one click saves the trust, then starts the launch; the kept message goes to the new session with no second click", async () => {
    const { store, fake, post, root, id, accepts } = await refused();
    expect(startsOf(fake.calls)).toBe(1);
    expect((await post(id, "trust"))!.status).toBe(200);
    expect(accepts.count).toBe(1);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
    expect(startsOf(fake.calls)).toBe(2);
    expect(store.message(root.id)!.to).toEqual({ host: FAKE, session: "session-f1" });
    expect(store.message(root.id)!.launch!.error ?? null).toBeNull();
  });

  test("a double click saves once and starts once; a click from a stale window after that does nothing", async () => {
    const { store, fake, post, root, id, accepts } = await refused();
    let open = () => {};
    fake.faults.gate = new Promise((done) => (open = done));
    const clicks = [post(id, "trust"), post(id, "trust")];
    await Bun.sleep(10);
    // Try again during the write would be a second start.
    expect(await refusal(post(id, "retry"))).toMatchObject({ code: "validation_error" });
    open();
    const answers = await Promise.all(clicks.map(async (click) => (await click)!.json()));
    expect(answers[0]).toEqual(answers[1]);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
    expect((await post(id, "trust"))!.status).toBe(200);
    await Bun.sleep(20);
    expect(accepts.count).toBe(1);
    expect(startsOf(fake.calls)).toBe(2);
  });

  test("a folder that changed after the line was read: nothing is saved or started, the answer has the new line, and a click on it goes through", async () => {
    const { store, fake, post, root, id, accepts } = await refused();
    const read = fake.faults.offer!.read().warning;
    const fresh = "This folder has 2 hooks that will run once you trust it.";
    fake.faults.offer = offerOf(fresh, fake.faults.offer!.accept);
    const refused1 = await refusal(post(id, "trust", "local", undefined, read));
    expect(refused1).toMatchObject({ code: "trust_warning_changed" });
    expect(refused1!.message).toContain(fresh);
    // A window that sent no line read none.
    expect(await refusal(post(id, "trust", "local", undefined, null))).toMatchObject({ code: "trust_warning_changed" });
    expect(accepts.count).toBe(0);
    expect(startsOf(fake.calls)).toBe(1);
    expect((await post(id, "trust", "local", undefined, fresh))!.status).toBe(200);
    expect(accepts.count).toBe(1);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
  });

  test("a failed write says why; the message stays kept, nothing starts, and the button can be pressed again", async () => {
    const { store, fake, post, launch, root, id } = await refused();
    const before = store.message(root.id)!;
    const offer = fake.faults.offer!;
    fake.faults.offer = offerOf(null, async () => {
      throw new Error("Could not update ~/.claude.json: it is not plain JSON. Nothing was changed.");
    });
    expect(await refusal(post(id, "trust"))).toMatchObject({ code: "trust_failed", message: "Could not update ~/.claude.json: it is not plain JSON. Nothing was changed." });
    expect(startsOf(fake.calls)).toBe(1);
    expect(store.message(root.id)).toEqual(before);
    expect(await launch.runOf(root.id, true)).toMatchObject({ state: "failed", untrusted: true, trust: { warning: null } });
    fake.faults.offer = offer;
    await post(id, "trust");
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
  });

  test("the owner alone: a guest's read has no offer and the route refuses it; the owner over the tailnet clicks like the window", async () => {
    const { store, post, launch, root, id, accepts } = await refused();
    expect((await launch.runOf(root.id, false))!.trust).toBeUndefined();
    expect(await refusal(post(id, "trust", "tailnet", false))).toMatchObject({ code: "owner_only" });
    // The default for a tailnet request is no owner, too.
    expect(await refusal(post(id, "trust", "tailnet"))).toMatchObject({ code: "owner_only" });
    expect(accepts.count).toBe(0);
    expect((await launch.runOf(root.id, true))!.trust).toEqual({ warning: "This folder has 1 hook that will run once you trust it." });
    expect((await post(id, "trust", "tailnet", true))!.status).toBe(200);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
  });

  test("Open in Terminal is this computer's: over the tailnet the owner and a guest are refused alike", async () => {
    const { post, id } = await refused();
    for (const owner of [true, false, undefined]) {
      const answer = (await post(id, "open", "tailnet", owner))!;
      expect(answer.status).toBe(403);
      expect(await answer.json()).toMatchObject({ code: "owner_only" });
    }
  });

  test("the owner's window alone: an agent's bare local call, with or without this run's session, saves nothing and starts nothing", async () => {
    const { fake, launch, id, accepts } = await refused();
    const warning = fake.faults.offer!.read().warning;
    const bare = (headers: Record<string, string>, body: Record<string, unknown>) =>
      launch.route(new Request(`http://127.0.0.1/api/inbox/launch/${id}/trust`, { method: "POST", headers, body: JSON.stringify({ warning, ...body }) }), `/api/inbox/launch/${id}/trust`, "local", true);
    for (const answer of [await bare({}, { serverSession: "srv" }), await bare({}, {}), await bare({ Origin: "http://127.0.0.1", Host: "127.0.0.1" }, {}), await bare({ Origin: "http://other.example", Host: "127.0.0.1" }, { serverSession: "srv" })]) {
      expect(answer!.status).toBe(403);
      expect(((await answer!.json()) as { code: string }).code).toBe("window_only");
    }
    expect(accepts.count).toBe(0);
    expect(startsOf(fake.calls)).toBe(1);
  });

  test("a restart refused for trust goes through resume, not a new start", async () => {
    const { store, clock, project, fake, launch, post } = setup();
    const accepts = { count: 0 };
    fake.faults.offer = offerOf(null, async () => {
      accepts.count += 1;
      fake.faults.resumeUntrusted = false;
    });
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send-respawn", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
    fake.poll("session-f1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-f1" });
    const answer = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: FAKE, session: "session-f1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-respawn" }).message;
    await post(prepared.launch.id, "stop");
    fake.faults.resumeUntrusted = true;
    clock.now += 1_000;
    store.sendReply(answer.id, { words: "One more thing.", idempotency_key: "reply-respawn" });
    await until(() => fake.calls.includes("resume f1"));
    await Bun.sleep(10);
    clock.now += 120_000;
    expect(await launch.runOf(root.id, true)).toMatchObject({ state: "failed", untrusted: true, trust: { warning: null } });
    expect((await post(prepared.launch.id, "trust"))!.status).toBe(200);
    await until(() => fake.calls.filter((call) => call === "resume f1").length === 2);
    expect(accepts.count).toBe(1);
    expect(fake.calls.filter((call) => call.startsWith("start "))).toHaveLength(1);
  });

  test("deleted while the write waited: nothing starts", async () => {
    const { store, fake, post, root, id } = await refused();
    let open = () => {};
    fake.faults.gate = new Promise((done) => (open = done));
    const click = post(id, "trust");
    await Bun.sleep(10);
    fake.faults.gate = null;
    await post(id, "delete");
    open();
    expect((await click)!.status).toBe(200);
    await Bun.sleep(20);
    expect(startsOf(fake.calls)).toBe(1);
    expect(store.message(root.id)!.launch!.deleted_at).toBeTruthy();
  });

  test("a folder the host can't trust (the home folder) shows no button and refuses the route", async () => {
    const { fake, post, launch, root, id } = await refused();
    fake.faults.offer = null;
    expect((await launch.runOf(root.id, true))!.trust).toBeUndefined();
    expect(await refusal(post(id, "trust"))).toMatchObject({ code: "trust_failed" });
    expect(startsOf(fake.calls)).toBe(1);
  });
});
