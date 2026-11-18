/**
 * Start in Rex (Settings → Agents' "Start new agents in": the launch backend, inbox-launch.ts with inbox-rex.ts):
 * a new agent runs in a Rex tab instead of in the background, and Rex owns it. The failures these guard: the agent
 * started twice (in Rex and in the background); the person's message on a command line; a send that fails because Rex
 * is not here (it starts in the background, and the line says why); a Rex session stopped, removed or its scratch
 * folder deleted by the Inbox; the person's choice not followed (Rex asked while the Inbox is chosen, or an agent
 * that cannot run in Rex offered); a session that never connects shown as "starting" for ever; a Rex pane blocked on
 * a prompt not said on the line; a reply to an ended Rex session restarted in the background instead of in Rex; a
 * second process started on a session its Rex tab still runs (H1); a routine's run, a phone's or a linked machine's
 * Send started in Rex (H2, M6); Stop, Open in Terminal or an attach command for one in Rex (M1); Rex's "no" taken for
 * a started agent (M2).
 *
 * A real launch engine over a temp data dir with the engine's fake host (tests/helpers/fake-launch-host.ts) and a
 * stand-in for inbox-rex.ts's `open` (its own tests cover the calls Rex gets). No Rex is reached.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_REX_MAY_RUN, INBOX_REX_NOT_HERE_AGAIN, INBOX_REX_STILL_RUNS, INBOX_RUN_IN_REX_OPEN, INBOX_RUN_IN_REX_STOP, INBOX_RUN_REX_NOT_CONNECTED, INBOX_RUN_START_GRACE_MS } from "@plannotator/core/inbox-run-line";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import type { InboxRexOpened, InboxRexStatus } from "./inbox-rex";
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
const opened: InboxRexOpened = { opened: true, session: "session:x", window: "window:y", line: "Rex · my-app / Fake Agent" };

function setup(options: { startIn?: "inbox" | "rex"; answer?: (request: OpenRequest) => Promise<InboxRexOpened>; attached?: boolean; scratch?: boolean } = {}) {
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
    rex: { open: async (request) => (opens.push(request), (options.answer ?? (async () => opened))(request)), appAttachedNow: async () => (asked.attached++, options.attached ?? true) },
    rexStatus: (session) => statuses.get(session) ?? null,
    processListing: async () => processes.listing,
    now: () => clock.now,
  });
  restore.push(() => launch.stop());
  const post = (id: string, action: string, body: Record<string, unknown> = {}) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/${action}`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv", ...body }) }),
      `/api/inbox/launch/${id}/${action}`,
      "local",
    );
  // `pressedHere`: a Send pressed in this computer's own window (the only one that may start in Rex).
  const send = async (words = "Tidy the changelog, then tell me.", pressedHere = true) => {
    const target = launch.target({ launch: options.scratch ? { agent: FAKE, scratch: true } : { agent: FAKE, project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: words, resolveProject: async () => project, pressedHere });
    const message = store.startPersonThread({ project_id: project.id, body: words, to: prepared.to, idempotency_key: `send-${words.length}`, thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(message);
    await until(() => !!store.message(message.id)!.launch!.session_ref || !!store.message(message.id)!.launch!.error);
    return { root: store.message(message.id)!, id: prepared.launch.id };
  };
  return { store, clock, project, fake, launch, opens, statuses, processes, asked, post, send, loginBin, dataDir };
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
    expect(root.launch).toMatchObject({ session_ref: "session-r1", session: "session-r1", rex: { line: "Rex · my-app / Fake Agent" } });
    // The tab is made and the agent not connected yet (Rex's app may not have jumped): where it is, on the line.
    expect(await launch.runOf(root.thread_id)).toMatchObject({ state: "starting", rex: { line: "Rex · my-app / Fake Agent" }, attach_command: null });
  });

  test("a Send not pressed in this computer's own window (a phone, the tailnet, a linked machine, a routine): Rex is never asked", async () => {
    const { fake, opens, send } = setup();
    const { root } = await send("From the phone.", false);
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

  test("Rex owns it: Stop is refused, Delete leaves its session and scratch folder (only the Inbox forgets it)", async () => {
    const { clock, fake, store, send, post } = setup({ scratch: true });
    const { root, id } = await send();
    fake.poll("session-r1", true, clock.now);
    store.recordDelivery(root.id, { host: FAKE, session: "session-r1" });
    await expect(post(id, "stop")).rejects.toMatchObject({ code: "launch_in_rex", message: INBOX_RUN_IN_REX_STOP });
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
  test("Rex is asked whether its app is here only for this computer's own Settings answer: never for the routines' clock or the tailnet", async () => {
    const { launch, asked } = setup({ startIn: "inbox" });
    // The routines' clock and the window's settings model: whether Launch is on, no Rex.
    expect(launch.enabled()).toBe(true);
    expect(launch.settingsState().enabled).toBe(true);
    expect("rex_here" in launch.settingsState()).toBe(false);
    const read = (via: string) => launch.route(new Request("http://127.0.0.1/api/inbox/launch/settings", { headers: { Host: "127.0.0.1" } }), "/api/inbox/launch/settings", via);
    expect(((await (await read("tailnet"))!.json()) as { launch: Record<string, unknown> }).launch.rex_here).toBeUndefined();
    expect(asked.attached).toBe(0);
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

  test("saved to config.json, read back with which agents can start there (whether Rex is here stays the pane's own read); anything else is refused", async () => {
    const { launch, dataDir } = setup({ startIn: "inbox", attached: true });
    const route = (body: Record<string, unknown>) =>
      launch.route(
        new Request("http://127.0.0.1/api/inbox/launch/settings", { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv", ...body }) }),
        "/api/inbox/launch/settings",
        "local",
      );
    const saved = (await (await route({ start_in: "rex" }))!.json()) as { launch: Record<string, unknown> };
    // Claude Code and Pi connect by themselves from a terminal; Codex and OpenCode never start in Rex (no dead choice).
    expect(saved.launch).toMatchObject({ start_in: "rex", rex_agents: ["claude-code", "pi", FAKE] });
    expect(saved.launch.rex_here).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxLaunch.startIn).toBe("rex");
    const back = (await (await route({ start_in: "inbox" }))!.json()) as { launch: Record<string, unknown> };
    expect(back.launch.start_in).toBe("inbox");
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxLaunch.startIn).toBeUndefined();
    await expect(route({ start_in: "terminal" })).rejects.toMatchObject({ code: "validation_error" });
  });
});
