/**
 * Start in Rex (Settings → Agents' "Start new agents in": the launch backend, inbox-launch.ts with inbox-rex.ts):
 * a new agent runs in a Rex tab instead of in the background, and Rex owns it. The failures these guard: the agent
 * started twice (in Rex and in the background); the person's message on a command line; a send that fails because Rex
 * is not here (it starts in the background, and the line says why); a Rex session stopped, removed or its scratch
 * folder deleted by the Inbox; the person's choice not followed (Rex asked while the Inbox is chosen, or an agent
 * that cannot run in Rex offered); a session that never connects shown as "starting" for ever; a Rex pane blocked on
 * a prompt not said on the line; a reply to an ended Rex session restarted in the background instead of in Rex; a
 * second process started on a session its Rex tab still runs (H1), or a wait for nothing when Rex says the tab is gone;
 * a routine's run started in Rex (a new tab per run), or a phone's or a linked machine's Send kept out of it; Stop
 * that leaves the agent running or closes another pane; Open in Terminal or an attach command for one in Rex (a
 * second copy); Rex's "no" taken for a started agent (M2); agents started in Rex losing their place once the setting
 * goes back to the Inbox.
 *
 * A real launch engine over a temp data dir with the engine's fake host (tests/helpers/fake-launch-host.ts) and a
 * stand-in for inbox-rex.ts's `open` (its own tests cover the calls Rex gets). No Rex is reached.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_REX_MAY_RUN, INBOX_REX_NOT_HERE_AGAIN, INBOX_REX_STILL_RUNS, INBOX_RUN_IN_REX_COULDNT, INBOX_RUN_IN_REX_ELSEWHERE, INBOX_RUN_IN_REX_NO_ANSWER, INBOX_RUN_IN_REX_NO_TAB, INBOX_RUN_IN_REX_OPEN, INBOX_RUN_IN_REX_STOP, INBOX_RUN_REX_NOT_CONNECTED, INBOX_RUN_START_GRACE_MS } from "@plannotator/core/inbox-run-line";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import type { InboxRexClosed, InboxRexOpened, InboxRexStatus } from "./inbox-rex";
import { INBOX_REX_RESUME_AFTER_BOOT_MS } from "./inbox-rex-resume";

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

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

type OpenRequest = { project: string; projectKey: string; tab: string; command: string; pathPrepend?: readonly string[] };
const opened: InboxRexOpened = { opened: true, session: "session:x", window: "window:y", block: "block:z", line: "Rex · my-app / Fake Agent" };

function setup(options: { startIn?: "inbox" | "rex"; answer?: (request: OpenRequest) => Promise<InboxRexOpened>; attached?: boolean; scratch?: boolean; headless?: boolean; shared?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-rex-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "my-app");
  const loginBin = join(root, "login-bin");
  for (const dir of [dataDir, home, folder, loginBin]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, ...(options.startIn ? { startIn: options.startIn } : { startIn: "rex" }) } }));
  const clock = { now: Date.parse("2026-11-18T09:00:00.000Z") };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "my-app", root: folder });
  const fake = fakeLaunchHost();
  const opens: OpenRequest[] = [];
  const statuses = new Map<string, InboxRexStatus>();
  // This computer's processes as `ps` lists them (a Rex tab's agent shows up here while it runs).
  const processes = { listing: "  1     0 /sbin/launchd\n" as string | null };
  // How often Rex was asked whether its app is attached (each ask is a connection to the person's Rex).
  const asked = { attached: 0 };
  // Rex's word on a pane (null: no answer), whether it closes one, and the panes it was asked about or to close.
  // `hold`: Rex's answer about a pane waits for it (a slow Rex).
  const panes = { gone: false as boolean | null, closes: "closed" as InboxRexClosed, asked: [] as string[], closed: [] as string[], hold: null as Promise<void> | null };
  // The processes Stop ended (SIGTERM), by pid: never a real signal here. `kills.ok` false: every signal is refused.
  const ended: number[] = [];
  const kills = { ok: true };
  // Where live sessions say they run (their polls' place hints).
  const places = new Map<string, { kind: "rex"; session: string; block: string }>();
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    // The person's login shell puts its own folder on PATH: the Rex tab gets it too.
    loginEnv: async () => ({ HOME: home, PATH: loginBin }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: () => [fake.host],
    rex: {
      open: async (request) => (opens.push(request), (options.answer ?? (async () => opened))(request)),
      appAttachedNow: async () => (asked.attached++, options.attached ?? true),
      ...(options.headless ? { headless: true } : {}),
      ...(options.shared !== undefined ? { shared: () => options.shared === true } : {}),
      paneGone: async (place) => (panes.asked.push(`${place.session}/${place.block}`), await panes.hold, panes.gone),
      closePane: async (place) => (panes.closed.push(`${place.session}/${place.block}`), panes.closes),
    },
    placeOf: (session) => places.get(session) ?? null,
    rexStatus: (session) => statuses.get(session) ?? null,
    processListing: async () => processes.listing,
    endProcess: (pid) => (ended.push(pid), kills.ok),
    now: () => clock.now,
  });
  restore.push(() => launch.stop());
  const post = (id: string, action: string, body: Record<string, unknown> = {}) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv", ...body }) }),
      `/api/inbox/launch/${id}/${action}`,
      "local",
    );
  // `background`: a routine's run.
  const send = async (words = "Tidy the changelog, then tell me.", background = false) => {
    const target = launch.target({ launch: options.scratch ? { agent: FAKE, scratch: true } : { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: words, resolveProject: async () => project, background });
    const message = store.startPersonThread({ project_id: project.id, body: words, to: prepared.to, idempotency_key: `send-${words.length}`, thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(message);
    await until(() => !!store.message(message.id)!.launch!.session_ref || !!store.message(message.id)!.launch!.error);
    return { root: store.message(message.id)!, id: prepared.launch.id };
  };
  const setStartIn = async (startIn: "inbox" | "rex") =>
    launch.route(
      new Request("http://127.0.0.1/api/inbox/launch/settings", { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv", start_in: startIn }) }),
      "/api/inbox/launch/settings",
      "local",
    );
  return { store, clock, project, fake, launch, opens, statuses, processes, asked, panes, places, ended, kills, post, send, setStartIn, loginBin, dataDir };
}

describe("Start in Rex", () => {
  test("Rex chosen and here: one Rex tab runs the agent's own command, named for it, through the login PATH; nothing starts in the background", async () => {
    const { fake, opens, send, loginBin, project, launch } = setup();
    const words = "Tidy the changelog, then tell me.";
    const { root } = await send(words);
    expect(fake.calls).toEqual(["rexCommand new"]);
    expect(opens).toEqual([{ project: "my-app", projectKey: project.id, tab: "Fake Agent", command: expect.stringContaining("fake-agent --session session-r1"), pathPrepend: [loginBin] }]);
    // The message reaches it as its first turn through its own channel: never on the command line.
    expect(opens[0]!.command).not.toContain("changelog");
    expect(root.to).toEqual({ host: FAKE, session: "session-r1" });
    // Where Rex put it, and the pane Rex made (Stop closes that pane).
    expect(root.launch).toMatchObject({ session_ref: "session-r1", session: "session-r1", rex: { line: "Rex · my-app / Fake Agent", session: "session:x", block: "block:z" } });
    // The tab is made and the agent not connected yet (Rex's app may not have jumped): where it is, on the line.
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "starting", rex: { line: "Rex · my-app / Fake Agent" }, attach_command: null });
  });

  test("a routine's run starts in the background with Rex chosen: Rex is never asked (no new tab per run)", async () => {
    const { fake, opens, send } = setup();
    const { root } = await send("The nightly run.", true);
    expect(opens).toEqual([]);
    expect(fake.calls).toEqual(["start Tidy"]);
    expect(root.launch!.rex).toBeUndefined();
  });

  test("the Inbox chosen (the default): Rex is never asked, and the agent starts in the background", async () => {
    const { fake, opens, send } = setup({ startIn: "inbox" });
    const { root } = await send();
    expect(opens).toEqual([]);
    expect(fake.calls).toEqual(["start Tidy"]);
    expect(root.launch!.rex).toBeUndefined();
  });

  test("Rex chosen but not here at the start: the send still starts the agent, in the background, and the line says why", async () => {
    const { fake, opens, send, launch } = setup({ answer: async () => ({ opened: false, sent: false }) });
    const { root } = await send();
    expect(opens).toHaveLength(1);
    expect(fake.calls).toEqual(["rexCommand new", "start Tidy"]);
    expect(root.launch).toMatchObject({ session_ref: "f2", rex: { unavailable: true } });
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "starting", rex: { line: null, unavailable: true } });
  });

  test("why Rex was not used is kept with the launch, so the line says the true thing: a Rex server that is not running (no app to open there), or one that is another account's", async () => {
    const server = setup({ headless: true, answer: async () => ({ opened: false, sent: false }) });
    const first = await server.send();
    expect(first.root.launch).toMatchObject({ session_ref: "f2", rex: { unavailable: true, why: "server" } });
    expect(await server.launch.runOf(first.root.thread_id)).toMatchObject({ state: "starting", rex: { unavailable: true, why: "server" } });
    const shared = setup({ headless: true, answer: async () => ({ opened: false, sent: false, shared: true }) });
    const second = await shared.send();
    // It started in the background, once.
    expect(shared.fake.calls).toEqual(["rexCommand new", "start Tidy"]);
    expect(second.root.launch).toMatchObject({ rex: { unavailable: true, why: "shared" } });
    // A Mac's line is as it was: no reason kept.
    const mac = setup({ answer: async () => ({ opened: false, sent: false }) });
    expect((await mac.send()).root.launch!.rex).toEqual({ unavailable: true });
  });

  test("Rex said no to the tab (an error answer: it made nothing): the agent starts in the background, and the line says so", async () => {
    const { fake, send, launch } = setup({ answer: async () => ({ opened: false, sent: false, refused: true }) });
    const { root } = await send();
    expect(fake.calls).toEqual(["rexCommand new", "start Tidy"]);
    expect(root.launch).toMatchObject({ session_ref: "f2", rex: { refused: true } });
    // Not Rex's: the Inbox's own Stop and attach work as for any background agent.
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "starting", rex: { line: null, refused: true } });
    expect(launch.attachOf(root.thread_id)).not.toBeNull();
  });

  test("Rex asked for the tab but never answered: counted as started in Rex (the tab may run it), never started twice", async () => {
    const { fake, send } = setup({ answer: async () => ({ opened: false, sent: true }) });
    const { root } = await send();
    expect(fake.calls).toEqual(["rexCommand new"]);
    expect(root.launch).toMatchObject({ session_ref: "session-r1" });
    expect(root.launch!.rex).toEqual({});
  });

  test("a session that never connects: the line says to look at its tab in Rex once the start grace is over", async () => {
    const { clock, send, launch } = setup();
    const { root } = await send();
    clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "failed", cause: INBOX_RUN_REX_NOT_CONNECTED });
  });

  test("connected: working as the session polls; its Rex pane blocked on a prompt says so on the line, with the kind", async () => {
    const { clock, fake, store, statuses, send, launch } = setup();
    const { root } = await send();
    fake.poll("session-r1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "working", rex: { line: "Rex · my-app / Fake Agent" } });
    statuses.set("session-r1", { state: "blocked", kind: "permission" });
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "waiting_terminal", rex: { waiting: "permission" } });
    statuses.set("session-r1", { state: "working" });
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "working" });
  });

  test("Stop closes the pane Rex made for it (where the person moved it too: a pane keeps its id), never the host's stop; the line says stopped", async () => {
    const { clock, fake, store, panes, places, ended, send, post, launch } = setup();
    const { root, id } = await send();
    fake.poll("session-r1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    // Its own pane, as its connection reports it.
    places.set("session-r1", { kind: "rex", session: "session:x", block: "block:z" });
    expect((await launch.runOf(root.thread_id))?.rex?.stops).toBe(true);
    const stopped = (await (await post(id, "stop"))!.json()) as { run: { state: string; stopped_by_person?: boolean } };
    expect(panes.closed).toEqual(["session:x/block:z"]);
    expect(ended).toEqual([]);
    expect(fake.calls.filter((call) => call.startsWith("stop "))).toEqual([]);
    expect(stopped.run).toMatchObject({ state: "stopped", stopped_by_person: true });
  });

  test("Stop of an agent the person resumed in a shell pane of their own: only its process ends, their pane (shell, jobs, scrollback) is never closed", async () => {
    const { clock, fake, store, panes, places, processes, ended, send, post, launch } = setup();
    const { root, id } = await send();
    fake.poll("session-r1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    // `fake-agent --session session-r1` run by hand from their shell (pid 900) in a pane the Inbox did not open.
    places.set("session-r1", { kind: "rex", session: "session:theirs", block: "block:their-shell" });
    processes.listing = "  1     0 /sbin/launchd\n  900     1 -zsh\n  4242   900 fake-agent --session session-r1\n";
    expect((await launch.runOf(root.thread_id))?.rex?.stops).toBe(true);
    const stopped = (await (await post(id, "stop"))!.json()) as { run: { state: string } };
    expect(ended).toEqual([4242]);
    expect(panes.closed).toEqual([]);
    expect(stopped.run.state).toBe("stopped");
    // Its process not found there: nothing is closed or ended, and the words say where to stop it.
    const again = setup();
    const second = await again.send();
    again.fake.poll("session-r1", true, again.clock.now);
    again.store.recordDelivery(second.root.id, { host: FAKE, session: "session-r1" });
    again.places.set("session-r1", { kind: "rex", session: "session:theirs", block: "block:their-shell" });
    await expect(again.post(second.id, "stop")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_RUN_IN_REX_ELSEWHERE });
    expect(again.panes.closed).toEqual([]);
    expect(again.ended).toEqual([]);
    expect((await again.launch.runOf(second.root.thread_id))?.state).toBe("working");
  });

  test("Stop when its own pane is gone but the session still runs elsewhere (no place reported, as Pi): its process ends; nothing running: stopped", async () => {
    const { clock, fake, store, panes, processes, ended, send, post } = setup();
    const { root, id } = await send();
    fake.poll("session-r1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    panes.closes = "gone";
    processes.listing = "  1     0 /sbin/launchd\n  5150     1 fake-agent --session session-r1\n";
    const stopped = (await (await post(id, "stop"))!.json()) as { run: { state: string } };
    expect(ended).toEqual([5150]);
    expect(stopped.run.state).toBe("stopped");
    const quiet = setup();
    const second = await quiet.send();
    quiet.fake.poll("session-r1", true, quiet.clock.now);
    quiet.store.recordDelivery(second.root.id, { host: FAKE, session: "session-r1" });
    quiet.panes.closes = "gone";
    const done = (await (await quiet.post(second.id, "stop"))!.json()) as { run: { state: string } };
    expect(quiet.ended).toEqual([]);
    expect(done.run.state).toBe("stopped");
  });

  test("Stop when its own pane is gone and it could not be stopped: the words say so, never that it runs in a tab the Inbox didn't open, and nothing counts as stopped", async () => {
    const cases: [string, (w: ReturnType<typeof setup>) => void][] = [
      // `ps` could not be read.
      ["ps unread", (w) => (w.processes.listing = null)],
      // Only a wrapper names it (`tmux new 'fake-agent …'`): the agent runs where `ps` cannot tell.
      ["a wrapper only", (w) => (w.processes.listing = "  1     0 /sbin/launchd\n  700   600 tmux new fake-agent --session session-r1\n")],
      // Its process is there but every signal was refused.
      ["signal refused", (w) => ((w.processes.listing = "  5150     1 fake-agent --session session-r1\n"), (w.kills.ok = false))],
    ];
    for (const [, arrange] of cases) {
      const w = setup();
      const { root, id } = await w.send();
      w.fake.poll("session-r1", true, w.clock.now);
      w.store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
      w.panes.closes = "gone";
      arrange(w);
      await expect(w.post(id, "stop")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_RUN_IN_REX_COULDNT });
      expect(w.ended.filter((pid) => pid === 700)).toEqual([]);
      expect((await w.launch.runOf(root.thread_id))?.state).not.toBe("stopped");
    }
  });

  test("a check of its pane that Rex answers after the Inbox stopped starts nothing", async () => {
    const { clock, fake, store, opens, panes, send, launch } = setup();
    const { root } = await send();
    fake.poll("session-r1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const answer = store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: FAKE, session: "session-r1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-late" }).message;
    let answerNow = () => {};
    panes.hold = new Promise<void>((done) => (answerNow = done));
    panes.gone = true;
    clock.now += 5_000;
    store.sendReply(answer.id, { words: "Still there?", idempotency_key: "reply-late" });
    await until(() => panes.asked.length === 1);
    launch.stop();
    answerNow();
    await Bun.sleep(30);
    expect(opens).toHaveLength(1);
  });

  test("Stop before the agent took its first message: the line says stopped by the person, never that it didn't connect", async () => {
    const { clock, fake, panes, send, post } = setup();
    const { id } = await send();
    fake.poll("session-r1", true, clock.now);
    clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
    const stopped = (await (await post(id, "stop"))!.json()) as { run: { state: string; stopped_by_person?: boolean } };
    expect(panes.closed).toEqual(["session:x/block:z"]);
    expect(stopped.run).toMatchObject({ state: "stopped", stopped_by_person: true });
  });

  test("Stopped before it ever connected (held at a prompt in its tab), then a reply: it really starts again, in a new Rex tab on its own id as a first start (nothing to resume); never without the Stop", async () => {
    const { clock, fake, store, opens, panes, send, post, launch } = setup({ answer: async () => (opens.length > 1 ? { ...opened, block: "block:new" } : opened) });
    const { root, id } = await send();
    // Never connected: a reply waits for it (its line says to look at its tab), and starts nothing by itself.
    clock.now += 5_000;
    store.sendReply(root.id, { words: "Are you there?", idempotency_key: "reply-unconnected-0" });
    launch.sweep(false);
    await Bun.sleep(30);
    expect(opens).toHaveLength(1);
    expect((await (await post(id, "stop"))!.json()) as { run: unknown }).toMatchObject({ run: { state: "stopped", stopped_by_person: true } });
    expect(panes.closed).toEqual(["session:x/block:z"]);
    panes.gone = true;
    // Nothing written since the Stop: nothing starts (the reply before it stays for the person's next one).
    launch.sweep(false);
    await Bun.sleep(30);
    expect(opens).toHaveLength(1);
    // "Your reply starts it again": it does.
    store.sendReply(root.id, { words: "Go on, please.", idempotency_key: "reply-unconnected-1" });
    await until(() => opens.length === 2);
    expect(fake.calls.filter((call) => /^(rexCommand|start|resume) /.test(call))).toEqual(["rexCommand new", "rexCommand fresh"]);
    expect(opens[1]!.command).toContain("--session session-r1");
    // Addressed as before (the root and the reply reach it once it connects), and Stop closes its new pane.
    await until(() => store.message(root.id)!.launch!.rex?.block === "block:new");
    expect(store.message(root.id)!.to).toEqual({ host: FAKE, session: "session-r1" });
    expect((await launch.runOf(root.thread_id))?.state).toBe("starting");
    launch.sweep(false);
    await Bun.sleep(30);
    expect(opens).toHaveLength(2);
  });

  test("Stop in Rex that cannot work: no pane known (Rex never asked), or Rex said no; each with its own true words, and nothing counts as stopped", async () => {
    const unknown = setup({ answer: async () => ({ opened: false, sent: true }) });
    const first = await unknown.send();
    unknown.fake.poll("session-r1", true, unknown.clock.now);
    unknown.store.recordDelivery(first.root.id, { host: FAKE, session: "session-r1" });
    expect((await unknown.launch.runOf(first.root.thread_id))?.rex?.stops).toBeUndefined();
    await expect(unknown.post(first.id, "stop")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_RUN_IN_REX_NO_TAB });
    expect(unknown.panes.closed).toEqual([]);
    const refusing = setup();
    refusing.panes.closes = "refused";
    const second = await refusing.send();
    refusing.fake.poll("session-r1", true, refusing.clock.now);
    refusing.store.recordDelivery(second.root.id, { host: FAKE, session: "session-r1" });
    await expect(refusing.post(second.id, "stop")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_RUN_IN_REX_STOP });
    expect((await refusing.launch.runOf(second.root.thread_id))?.state).toBe("working");
  });

  test("Stop that Rex did not answer in time: a reply written before it stays held, so it never reopens the agent if Rex closed the pane after all", async () => {
    const { clock, fake, store, opens, panes, send, post, launch } = setup();
    const { root, id } = await send();
    fake.poll("session-r1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const answer = store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: FAKE, session: "session-r1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-late" }).message;
    store.sendReply(answer.id, { words: "Then the README.", idempotency_key: "reply-late" });
    panes.closes = "no_answer";
    panes.gone = null;
    await expect(post(id, "stop")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_RUN_IN_REX_NO_ANSWER });
    // Rex closed it after all: the agent ends, and later looks never open a new tab for that reply.
    fake.ended("session-r1");
    panes.gone = true;
    clock.now += INBOX_REX_RESUME_AFTER_BOOT_MS + 1_000;
    launch.sweep(false);
    await Bun.sleep(30);
    expect(opens).toHaveLength(1);
  });

  test("Delete leaves its Rex session and scratch folder (only the Inbox forgets it)", async () => {
    const { clock, fake, store, send, post } = setup({ scratch: true });
    const { root, id } = await send();
    fake.poll("session-r1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const deleted = (await (await post(id, "delete"))!.json()) as Record<string, unknown>;
    expect(deleted).toMatchObject({ ok: true, scratch_removed: false });
    expect(fake.calls.filter((call) => /^(stop|remove|purge) /.test(call))).toEqual([]);
    expect(store.message(root.id)!.launch!.deleted_at).toBeTruthy();
  });

  test("Rex owns it: no attach command and no Open in Terminal (Terminal would run a second copy)", async () => {
    const { clock, fake, store, send, post, launch } = setup();
    const { root, id } = await send();
    fake.poll("session-r1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    expect(launch.attachOf(root.thread_id)).toBeNull();
    expect(await launch.runOf(root.thread_id)).toMatchObject({ attach_command: null });
    await expect(post(id, "open")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_RUN_IN_REX_OPEN });
  });

  test("a reply after an Inbox restart, its Rex tab's agent not heard from yet: no second tab on the session", async () => {
    const { clock, fake, store, opens, processes, send, post, launch } = setup();
    const { root, id } = await send();
    fake.poll("session-r1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const answer = store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: FAKE, session: "session-r1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-h1" }).message;
    // Not live here (the Inbox just started again; its connection retries every minute at most).
    fake.ended("session-r1");
    clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
    store.sendReply(answer.id, { words: "Still there?", idempotency_key: "reply-h1" });
    await Bun.sleep(30);
    expect(opens).toHaveLength(1);
    expect(fake.calls).not.toContain("rexCommand resume");
    // Its line says the reply waits, never "Your reply starts it again" meanwhile.
    expect((await launch.runOf(root.thread_id))?.rex?.held).toBe("may_run");
    // Past that, while its tab still runs the session (a dialog there holds it): still none, and Try again says why.
    clock.now += INBOX_REX_RESUME_AFTER_BOOT_MS;
    processes.listing = `  1     0 /sbin/launchd\n 4242     1 claude --resume session-r1 --settings /tmp/s.json\n`;
    store.sendReply(answer.id, { words: "Hello?", idempotency_key: "reply-h1b" });
    await Bun.sleep(30);
    expect(opens).toHaveLength(1);
    expect((await launch.runOf(root.thread_id))?.rex?.held).toBe("still_runs");
    await expect(post(id, "retry")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_REX_STILL_RUNS });
    // A listing that cannot be read is one that may run it.
    processes.listing = null;
    await expect(post(id, "retry")).rejects.toMatchObject({ message: INBOX_REX_STILL_RUNS });
    // Its process gone: the next look (a few seconds on) opens the one new tab.
    processes.listing = "  1     0 /sbin/launchd\n";
    clock.now += 10_000;
    store.sendReply(answer.id, { words: "Once more.", idempotency_key: "reply-h1c" });
    await until(() => opens.length === 2);
    expect(opens[1]!.command).toContain("--session session-r1");
    expect((await launch.runOf(root.thread_id))?.rex?.held).toBeUndefined();
  });

  test("an agent whose running process does not keep its argv (Pi lists as `pi` alone): its host's own check holds the session", async () => {
    const { clock, fake, store, opens, processes, send, post } = setup();
    // As Pi: `ps` shows `pi`, and only the claim its extension wrote says which session that pid runs.
    const asked: [string, string][] = [];
    (fake.host as { runsSession?: (session: string, listing: string) => boolean }).runsSession = (session, listing) => (asked.push([session, listing]), listing.includes(" pi\n"));
    const { root, id } = await send();
    // Never connected, after the Inbox's first minute and a half: Try again never opens a second tab beside it.
    clock.now += INBOX_REX_RESUME_AFTER_BOOT_MS;
    processes.listing = "  1     0 /sbin/launchd\n 4242     1 pi\n";
    await expect(post(id, "retry")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_REX_STILL_RUNS });
    expect(asked.at(-1)).toEqual(["session-r1", processes.listing]);
    // It connected once, then went quiet past its live window (a Mac that slept): a reply waits for it too.
    fake.poll("session-r1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const answer = store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: FAKE, session: "session-r1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-pi" }).message;
    fake.ended("session-r1");
    clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
    store.sendReply(answer.id, { words: "Still there?", idempotency_key: "reply-pi" });
    await Bun.sleep(30);
    expect(opens).toHaveLength(1);
    // That Pi quit: the next look opens the one new tab.
    processes.listing = "  1     0 /sbin/launchd\n";
    clock.now += 10_000;
    store.sendReply(answer.id, { words: "Once more.", idempotency_key: "reply-pi-2" });
    await until(() => opens.length === 2);
  });

  test("a reply right after an Inbox restart whose tab Rex says is gone: no wait, one new tab at once (its new pane recorded); Rex unsure: it waits", async () => {
    const { clock, fake, store, opens, panes, send, launch } = setup({ answer: async (request) => (request.command.includes("--resume") || opens.length > 1 ? { ...opened, block: "block:new" } : opened) });
    const { root } = await send();
    fake.poll("session-r1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const answer = store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: FAKE, session: "session-r1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-gone" }).message;
    fake.ended("session-r1");
    clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
    // Rex has no answer about the pane: within the Inbox's first minute and a half, the reply waits.
    panes.gone = null;
    store.sendReply(answer.id, { words: "Still there?", idempotency_key: "reply-gone-1" });
    await until(() => panes.asked.length === 1);
    await Bun.sleep(20);
    expect(opens).toHaveLength(1);
    expect((await launch.runOf(root.thread_id))?.rex?.held).toBe("may_run");
    // Rex says the pane is gone (and no process runs the session): the next look starts it again at once.
    panes.gone = true;
    clock.now += 10_000;
    store.sendReply(answer.id, { words: "Hello?", idempotency_key: "reply-gone-2" });
    await until(() => opens.length === 2);
    expect(panes.asked.at(-1)).toBe("session:x/block:z");
    await until(() => store.message(root.id)!.launch!.rex?.block === "block:new");
  });

  test("a session started in Rex counts as not connected (its tab is where it is) until it connects, for a quarter of an hour at most; stopped, or connected once and ended: no longer", async () => {
    const { clock, fake, launch, send } = setup();
    await send();
    expect([...launch.rexUnconnected().keys()]).toEqual(["session-r1"]);
    fake.poll("session-r1", true, clock.now);
    expect([...launch.rexUnconnected().keys()]).toEqual([]);
    // It ended (no poll for long): it stays out (Rex is not read for a tab it left).
    fake.ended("session-r1");
    clock.now += 60_000;
    expect([...launch.rexUnconnected().keys()]).toEqual([]);
    const again = setup();
    const started = await again.send();
    expect([...again.launch.rexUnconnected().keys()]).toEqual(["session-r1"]);
    expect((await again.post(started.id, "stop")).status).toBe(200);
    expect([...again.launch.rexUnconnected().keys()]).toEqual([]);
    const late = setup();
    await late.send();
    late.clock.now += 15 * 60_000;
    expect([...late.launch.rexUnconnected().keys()]).toEqual([]);
  });

  test("its pane closed while it reads live and its start's grace runs: a reply starts it again in a new tab at once; its pane still there: the running agent takes the reply", async () => {
    const { clock, fake, store, opens, panes, send } = setup({ answer: async () => (opens.length > 1 ? { ...opened, block: "block:new" } : opened) });
    const { root } = await send();
    fake.poll("session-r1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const answer = store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: FAKE, session: "session-r1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-closed" }).message;
    clock.now += 5_000;
    // Its pane is there: the live agent takes the reply itself, no second tab.
    panes.gone = false;
    store.sendReply(answer.id, { words: "And then?", idempotency_key: "reply-closed-1" });
    await until(() => panes.asked.length === 1);
    await Bun.sleep(20);
    expect(opens).toHaveLength(1);
    // The person closed its pane (its last poll still reads live, its start a few seconds ago): the next reply opens
    // the one new tab at once, never after the polls go stale or the grace runs out.
    clock.now += 6_000;
    panes.gone = true;
    store.sendReply(answer.id, { words: "Still there?", idempotency_key: "reply-closed-2" });
    await until(() => opens.length === 2);
    expect(opens[1]!.command).toContain("session-r1");
    await until(() => store.message(root.id)!.launch!.rex?.block === "block:new");
    await Bun.sleep(20);
    expect(opens).toHaveLength(2);
  });

  test("Try again right after an Inbox restart: refused, as the tab's agent may still be running", async () => {
    const { clock, send, post } = setup();
    const { id } = await send();
    // Never connected: the failed line offers Try again.
    clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
    await expect(post(id, "retry")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_REX_MAY_RUN });
  });

  test("a reply to a Rex session that ended starts it again in a new Rex tab, as the same session; Rex gone, the line says so", async () => {
    const { clock, fake, store, opens, send } = setup();
    const { root } = await send();
    fake.poll("session-r1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const answer = store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: FAKE, session: "session-r1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer" }).message;
    // Its tab was closed: the session stops polling.
    fake.ended("session-r1");
    clock.now += INBOX_REX_RESUME_AFTER_BOOT_MS + 1_000;
    store.sendReply(answer.id, { words: "One more thing.", idempotency_key: "reply-1" });
    await until(() => fake.calls.includes("rexCommand resume"));
    expect(fake.calls).not.toContain("resume session-r1");
    await until(() => opens.length === 2);
    expect(opens[1]!.command).toContain("--session session-r1");
  });

  test("a reply while Rex is not here: no background restart of a Rex session; the failed line says Rex isn't open", async () => {
    let here = true;
    const { clock, fake, store, send, launch } = setup({ answer: async () => (here ? opened : { opened: false, sent: false }) });
    const { root } = await send();
    fake.poll("session-r1", false, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    const answer = store.sendMessage({ project_id: root.project_id, author: { kind: "agent", host: FAKE, session: "session-r1", name: "Fake Agent" }, body: "Done.", reply_to: root.id, idempotency_key: "answer-2" }).message;
    fake.ended("session-r1");
    clock.now += INBOX_REX_RESUME_AFTER_BOOT_MS + 1_000;
    here = false;
    store.sendReply(answer.id, { words: "Again.", idempotency_key: "reply-2" });
    await until(() => fake.calls.includes("rexCommand resume"));
    await Bun.sleep(20);
    expect(fake.calls).not.toContain("resume session-r1");
    clock.now += INBOX_RUN_START_GRACE_MS + 1_000;
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "failed", again: true, cause: INBOX_REX_NOT_HERE_AGAIN });
  });
});

describe("Settings → Agents: Start new agents in", () => {
  test("back to the background: agents started in Rex keep their Rex place until they end; every agent in a Rex pane counts only while Rex is chosen", async () => {
    const { launch, send, setStartIn } = setup();
    await send();
    expect(launch.startsInRex()).toBe(true);
    expect([...(launch.rexSessions() ?? [])]).toEqual(["session-r1"]);
    await setStartIn("inbox");
    expect(launch.startsInRex()).toBe(false);
    expect([...(launch.rexSessions() ?? [])]).toEqual(["session-r1"]);
    // Each with the pane Rex made for it (the place of an agent that reports none, as Pi); a background one is in none.
    expect([...(launch.rexPanes() ?? [])]).toEqual([["session-r1", { kind: "rex", session: "session:x", block: "block:z" }]]);
    expect([...launch.backgroundSessions()]).toEqual([]);
    const behind = setup({ startIn: "inbox" });
    await behind.send();
    expect([...behind.launch.backgroundSessions()]).toEqual(["session-f1"]);
    expect(behind.launch.rexPanes()!.size).toBe(0);
  });

  test("a Rex with no app on its computer (a server used from elsewhere): the tailnet's Settings read says whether it is here too, so the row shows where the person is; a linked machine's or a phone's read never asks", async () => {
    const { launch, asked } = setup({ startIn: "inbox", headless: true });
    const read = (via: string, door?: { platform: string; window: boolean }) => launch.route(new Request("http://127.0.0.1/api/inbox/launch/settings", { headers: { Host: "127.0.0.1" } }), "/api/inbox/launch/settings", via, door);
    expect(((await (await read("tailnet"))!.json()) as { launch: Record<string, unknown> }).launch).toMatchObject({ rex_here: true, rex_headless: true });
    expect(((await (await read("local"))!.json()) as { launch: Record<string, unknown> }).launch.rex_here).toBe(true);
    expect(asked.attached).toBe(2);
    expect(((await (await read("tailnet", { platform: "ios", window: false }))!.json()) as { launch: Record<string, unknown> }).launch.rex_here).toBeUndefined();
    expect(asked.attached).toBe(2);
  });

  test("a Rex server that answered but is another account's (a shared one): Settings' read says so, so the row never says the server isn't running; never while Rex is here, and never on a read that does not ask Rex", async () => {
    const read = async (launch: ReturnType<typeof setup>["launch"], url = "http://127.0.0.1/api/inbox/launch/settings") =>
      ((await (await launch.route(new Request(url, { headers: { Host: "127.0.0.1" } }), "/api/inbox/launch/settings", "local"))!.json()) as { launch: Record<string, unknown> }).launch;
    const shared = setup({ headless: true, attached: false, shared: true });
    expect(await read(shared.launch)).toMatchObject({ rex_here: false, rex_headless: true, rex_shared: true });
    expect("rex_shared" in (await read(shared.launch, "http://127.0.0.1/api/inbox/launch/settings?ahead=1"))).toBe(false);
    const away = setup({ headless: true, attached: false, shared: false });
    expect("rex_shared" in (await read(away.launch))).toBe(false);
    const here = setup({ headless: true, attached: true, shared: true });
    expect("rex_shared" in (await read(here.launch))).toBe(false);
  });

  test("Rex is asked whether its app is here only for Settings → Agents' own read: never for the routines' clock, New message's pick or a save", async () => {
    const { launch, asked } = setup({ startIn: "inbox" });
    // The routines' clock and the window's settings model: whether Launch is on, no Rex.
    expect(launch.enabled()).toBe(true);
    expect(launch.settingsState().enabled).toBe(true);
    expect("rex_here" in launch.settingsState()).toBe(false);
    const read = (via: string) => launch.route(new Request("http://127.0.0.1/api/inbox/launch/settings", { headers: { Host: "127.0.0.1" } }), "/api/inbox/launch/settings", via);
    // New message's agent pick reads ahead: no Rex either.
    const ahead = await launch.route(new Request("http://127.0.0.1/api/inbox/launch/settings?ahead=1", { headers: { Host: "127.0.0.1" } }), "/api/inbox/launch/settings", "local");
    expect(((await ahead!.json()) as { launch: Record<string, unknown> }).launch.rex_here).toBeUndefined();
    expect(asked.attached).toBe(0);
    // A save's answer: no Rex.
    const saved = await launch.route(
      new Request("http://127.0.0.1/api/inbox/launch/settings", { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv", full_permissions: false }) }),
      "/api/inbox/launch/settings",
      "local",
    );
    expect(((await saved!.json()) as { launch: Record<string, unknown> }).launch.rex_here).toBeUndefined();
    expect(asked.attached).toBe(0);
    // Settings → Agents' own read on this computer: the one that asks.
    expect(((await (await read("local"))!.json()) as { launch: Record<string, unknown> }).launch.rex_here).toBe(true);
    expect(asked.attached).toBe(1);
  });

  test("a Mac's Rex app attached: Settings → Agents' read over the tailnet says Rex is here too, so the row shows in a window on the tailnet address (this computer's or another's); the device door never asks", async () => {
    const { launch, asked } = setup({ startIn: "inbox", attached: true });
    const read = async (via: string, door?: { platform: string; window: boolean }) =>
      ((await (await launch.route(new Request("http://127.0.0.1/api/inbox/launch/settings", { headers: { Host: "127.0.0.1" } }), "/api/inbox/launch/settings", via, door))!.json()) as { launch: Record<string, unknown> }).launch;
    expect((await read("tailnet")).rex_here).toBe(true);
    expect(asked.attached).toBe(1);
    expect((await read("local", { platform: "ios", window: false })).rex_here).toBeUndefined();
    expect((await read("local", { platform: "machine", window: true })).rex_here).toBeUndefined();
    expect(asked.attached).toBe(1);
    const gone = setup({ startIn: "rex", attached: false });
    const away = ((await (await gone.launch.route(new Request("http://127.0.0.1/api/inbox/launch/settings", { headers: { Host: "127.0.0.1" } }), "/api/inbox/launch/settings", "tailnet"))!.json()) as { launch: Record<string, unknown> }).launch;
    expect(away.rex_here).toBe(false);
  });

  test("saved to config.json, read back with which agents can start there (whether Rex is here stays the pane's own read); anything else is refused", async () => {
    const { launch, dataDir } = setup({ startIn: "inbox", attached: true });
    const route = (body: Record<string, unknown>) =>
      launch.route(
        new Request("http://127.0.0.1/api/inbox/launch/settings", { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv", ...body }) }),
        "/api/inbox/launch/settings",
        "local",
      );
    const saved = (await (await route({ start_in: "rex" }))!.json()) as { launch: Record<string, unknown> };
    // Claude Code, Pi and OpenCode connect by themselves from a terminal; Codex never starts in Rex (no dead choice).
    expect(saved.launch).toMatchObject({ start_in: "rex", rex_agents: ["claude-code", "pi", "opencode", FAKE] });
    expect(saved.launch.rex_here).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxLaunch.startIn).toBe("rex");
    const back = (await (await route({ start_in: "inbox" }))!.json()) as { launch: Record<string, unknown> };
    expect(back.launch.start_in).toBe("inbox");
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxLaunch.startIn).toBeUndefined();
    await expect(route({ start_in: "terminal" })).rejects.toMatchObject({ code: "validation_error" });
  });
});
