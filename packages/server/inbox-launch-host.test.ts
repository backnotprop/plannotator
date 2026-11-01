/**
 * The agent-host seam (inbox-launch-host.ts), on a real launch engine over a temp data dir. What each test
 * guards: a second agent registered as a `LaunchHost` drives the whole shared flow with no engine change
 * (To offers it, Send starts it and addresses the thread to it, the run line follows its own live state, its
 * permission question is written as its own agent, a reply after Stop restarts it once, Stop calls its stop
 * and withdraws through its transport, Delete calls its remove), so Claude Code is not wired into the engine; and a
 * record whose agent has no host here (after a downgrade) shows no line, is skipped by the sweep and answers
 * `launch_not_found`, never a crash. The optional seams: a host's own login-shell read (`context.loginEnv`),
 * `close` when the Inbox stops, a per-launch `stoppedNote`, and a `resume` that throws (a failed restart, never
 * an unhandled rejection).
 *
 * `fakeLaunchHost` is the engine's test fake: an in-memory agent whose sessions the test connects, works and
 * idles by hand. Claude Code's host is there too and stays out of the way: no `claude` is on the sandbox PATH.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLaunchAgent, InboxLaunchRecord, InboxMessage } from "@plannotator/core/inbox-types";
import { INBOX_RUN_START_GRACE_MS } from "@plannotator/core/inbox-run-line";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLaunch } from "./inbox-launch";
import { launchNoteText, writeLaunchNote, type LaunchHost, type LaunchHostContext, type LaunchLive } from "./inbox-launch-host";
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

/** Not an agent the product knows (`InboxLaunchAgent` is Claude Code's alone until the next agent widens it). */
const FAKE = "fake-agent" as InboxLaunchAgent;

/** An in-memory agent: `start` makes a session that is not connected; the test works and idles it (`poll`), and asks its permission questions (`ask`). */
function fakeLaunchHost() {
  const calls: string[] = [];
  /** What the test makes go wrong. */
  const faults: {
    resumeThrows: boolean;
    gate: Promise<void> | null;
    deliverGate: Promise<void> | null;
    /** The turn had gone before the Stop's signal came (Codex's `turn/start` sent). */
    lateTurn: boolean;
    /** The wake records the delivery as soon as the turn took it. */
    delivered: ((text: string) => void) | null;
  } = { resumeThrows: false, gate: null, deliverGate: null, lateTurn: false, delivered: null };
  let questions: ReturnType<typeof createLaunchQuestions> | null = null;
  const sessions = new Map<string, { ref: string; live: LaunchLive | null; state: "running" | "stopped" }>();
  const byRef = (ref: string) => [...sessions.values()].find((s) => s.ref === ref);
  const host: LaunchHost = {
    agent: FAKE,
    name: "Fake Agent",
    shellNames: [],
    available: async () => ({ ok: true, version: "1.0.0" }),
    startOf: () => ({ full: false, ownMode: false, bypass: false }),
    trusts: () => true,
    async start(launch, input) {
      calls.push(`start ${input.name}`);
      const ref = `f${sessions.size + 1}`;
      sessions.set(`session-${ref}`, { ref, live: null, state: "running" });
      return { ok: true, session: `session-${ref}`, ref };
    },
    sessions: async () => (ref) => {
      const session = byRef(ref);
      return session ? { status: session.live?.busy ? "busy" : "idle", state: session.state, waitingFor: null } : "absent";
    },
    live: (session) => sessions.get(session)?.live ?? null,
    async resume(launch) {
      calls.push(`resume ${launch.session_ref}`);
      if (faults.resumeThrows) throw new Error("the host broke");
      byRef(launch.session_ref!)!.state = "running";
      return { exitCode: 0, text: "", failure: null };
    },
    async stop(ref) {
      calls.push(`stop ${ref}`);
      const session = byRef(ref)!;
      // As OpenCode's: not live from the moment the stop begins; the stop itself takes a while (`gate`).
      session.state = "stopped";
      session.live = null;
      await faults.gate;
      return { exitCode: 0, text: "" };
    },
    async remove(ref) {
      calls.push(`remove ${ref}`);
      await faults.gate;
      return { exitCode: 0, text: "" };
    },
    purge: async (folder) => (calls.push(`purge ${folder}`), { exitCode: 0, text: "" }),
    // As Codex's: the wake's text goes in as a turn; it takes a while (`deliverGate`), and starts none once stopped.
    async deliver(launch, text, signal) {
      calls.push(`deliver ${text}`);
      await faults.deliverGate;
      if (signal.aborted && !faults.lateTurn) return { failed: "stopped" };
      calls.push(`turn ${text}`);
      faults.delivered?.(text);
      return "delivered";
    },
    attach: (launch) => (launch.session_ref ? `fake attach ${launch.session_ref}` : null),
    terminal: (launch) => `fake attach ${launch.session_ref}`,
    // Pushed prompts: no hook route; its questions are written by the shared question code.
    permissions(ctx) {
      questions = createLaunchQuestions({ store: ctx.store, name: "Fake Agent", displayFolder: ctx.displayFolder, onChange: ctx.onChange, log: () => {} });
      return {
        sweep() {},
        withdrawAll(root) {
          calls.push(`withdrawAll ${root.launch!.session_ref}`);
          questions!.withdrawAll(root);
        },
      };
    },
  };
  /** The session polls: live, busy or idle; each poll shows new life. */
  const poll = (session: string, busy: boolean, at: number) => {
    const s = sessions.get(session)!;
    s.live = { busy, busySince: busy ? (s.live?.busySince ?? at) : null, polls: (s.live?.polls ?? 0) + 1 };
  };
  /** The session asks to run a command: the question lands in the launch's thread. */
  const ask = (root: InboxMessage, session: string) => {
    const event = { session_id: session, tool_name: "Bash", tool_input: { command: "ls" }, cwd: root.launch!.folder, permission_suggestions: [], permission_mode: null };
    return questions!.ask(root, event, "req-1", questions!.questionFor(root, event, {}))!;
  };
  return { host, calls, poll, ask, faults };
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
  const post = (id: string, action: string) =>
    launch.route(new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", body: JSON.stringify({ serverSession: "srv" }) }), `/api/inbox/launch/${id}/${action}`, "local");
  return { store, clock, project, fake, launch, post, logins, context: () => context! };
}

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

  test("a host that delivers the reply itself: none goes in during a Stop or Delete, the reply waiting at Stop waits for the next, and after Delete none reaches the agent", async () => {
    const { store, project, fake, launch, post } = setup();
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send-d", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
    store.recordDelivery(root.id, { host: FAKE, session: "session-f1" });
    const turns = () => fake.calls.filter((call) => call.startsWith("turn "));
    const deliver = (text: string) => launch.deliver(FAKE, "session-f1", text);

    // A delivery under way when the person presses Stop: Stop waits for it, and it starts no turn after the Stop.
    store.sendReply(root.id, { words: "And the changelog.", idempotency_key: "reply-d1" });
    let open: () => void = () => {};
    fake.faults.deliverGate = new Promise((resolve) => (open = resolve));
    const under = deliver("And the changelog.");
    await until(() => fake.calls.includes("deliver And the changelog."));
    const stopped = post(prepared.launch.id, "stop");
    await Bun.sleep(20);
    expect(fake.calls.includes("stop f1")).toBe(false);
    open();
    expect(await under).toMatchObject({ failed: expect.any(String) });
    expect((await stopped)!.status).toBe(200);
    fake.faults.deliverGate = null;
    expect(turns()).toEqual([]);
    // Tried again later (the wake's back-off): it waited when the person pressed Stop, so it waits on.
    expect(await deliver("And the changelog.")).toBe("hold");
    // The person's next reply: both go in.
    store.sendReply(root.id, { words: "Go on.", idempotency_key: "reply-d2" });
    expect(await deliver("And the changelog.")).toBe("delivered");
    expect(await deliver("Go on.")).toBe("delivered");
    expect(turns()).toEqual(["turn And the changelog.", "turn Go on."]);

    // While a Delete stops and removes the session: nothing goes in; after it, a reply waits in the Inbox.
    fake.faults.gate = new Promise((resolve) => (open = resolve));
    const deleted = post(prepared.launch.id, "delete");
    await until(() => fake.calls.filter((call) => call === "stop f1").length === 2);
    store.sendReply(root.id, { words: "One more.", idempotency_key: "reply-d3" });
    expect(await deliver("One more.")).toMatchObject({ failed: expect.any(String) });
    open();
    await deleted;
    fake.faults.gate = null;
    expect(store.message(root.id)!.launch!.deleted_at).toBeTruthy();
    expect(await deliver("One more.")).toBe("hold");
    expect(turns()).toHaveLength(2);
    expect(fake.calls.filter((call) => call.startsWith("deliver ")).length).toBe(3);
  });

  test("a reply whose turn had gone when the person pressed Stop: the replies still waiting once it settled are held, an older one too", async () => {
    const { store, project, fake, launch, post } = setup();
    const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send-l", launch: prepared.launch }).message;
    launch.begin(root);
    await until(() => store.message(root.id)!.launch!.session_ref === "f1");
    store.recordDelivery(root.id, { host: FAKE, session: "session-f1" });
    // "Earlier." (another thread to the same session, so the later delivery does not settle it) failed once and
    // waits for the wake's retry; "Later." is going in as the person presses Stop.
    store.startPersonThread({ project_id: project.id, body: "Earlier.", to: { host: FAKE, session: "session-f1" }, idempotency_key: "send-l2" });
    const later = store.sendReply(root.id, { words: "Later.", idempotency_key: "reply-l2" }).reply;
    fake.faults.lateTurn = true;
    fake.faults.delivered = () => void store.recordDelivery(later.id, { host: FAKE, session: "session-f1" });
    let open: () => void = () => {};
    fake.faults.deliverGate = new Promise((resolve) => (open = resolve));
    const under = launch.deliver(FAKE, "session-f1", "Later.");
    await until(() => fake.calls.includes("deliver Later."));
    const stopped = post(prepared.launch.id, "stop");
    // The Stop is waiting on the delivery when its turn goes.
    await Bun.sleep(20);
    open();
    expect(await under).toBe("delivered");
    expect((await stopped)!.status).toBe(200);
    fake.faults.deliverGate = null;
    // The retry after the Stop: held, never a turn after it.
    expect(await launch.deliver(FAKE, "session-f1", "Earlier.")).toBe("hold");
    expect(fake.calls.filter((call) => call.startsWith("turn "))).toEqual(["turn Later."]);
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
