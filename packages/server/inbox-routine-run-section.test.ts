/**
 * A routine's run going is filed under New (the owner, 2026-11-24: "while a routine's run is going, its thread sits
 * under New, with its Running mark, until the run ends"). On a real launch engine over a temp data dir with the
 * engine's fake agent, read through the list's own row decorator (`rowDecorator`, what the window's, the phone's and a
 * linked computer's list reads give). What regresses: a run's thread that drops into folded Quiet the moment its session
 * takes the divider (the person's message, so Sent, then Quiet once delivered), on the first run and on every later
 * one; a run that ends and stays in New with nothing new in it; a question during a run demoted to New; a running row
 * that raises a count (bold, unseen, waiting on the person, the phone's badge).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxRowWaitsOnPerson, type InboxMessage } from "@plannotator/core/inbox-types";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { createInboxScheduled } from "./inbox-scheduled";

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
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

const STOPPED = [":::question", "Which ledger should I use?", "", "Stopped: the check cannot go on without it.", "", "- [ ] March", "- [ ] April", ":::"].join("\n");

function world() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-routine-section-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "project");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const clock = { now: Date.parse("2026-11-16T13:59:00.000Z") };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "ledger", root: folder });
  const fake = fakeLaunchHost();
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => ({ HOME: home, PATH: "" }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: () => [fake.host],
    now: () => clock.now,
  });
  restore.push(() => launch.stop());
  const scheduled = createInboxScheduled({
    store,
    launch,
    on: () => true,
    launchOn: () => launch.settingsState().enabled,
    resolveProject: async () => store.project(project.id)!,
    recordAttachments: async () => [],
    displayFolder: (path) => path,
    now: () => clock.now,
  });
  restore.push(() => scheduled.stop());
  /** The thread's row as every list read gives it: the store's, decorated by the launcher. */
  const row = (threadId: string) => launch.rowDecorator()(store.listRow(threadId)!);
  /** Run once now: the run starts, its session takes the divider and works. */
  const start = async (id: string): Promise<{ divider: InboxMessage; session: string }> => {
    clock.now += 60_000;
    const { message } = await scheduled.runNow(id, { kind: "person" });
    await until(() => !!store.message(message.id)!.launch!.session_ref);
    const session = store.message(message.id)!.to!.session;
    fake.poll(session, true, clock.now);
    store.recordDelivery(message.id, { host: FAKE, session });
    expect(launch.runOfMessage(message.id)?.state).toBe("working");
    return { divider: store.message(message.id)!, session };
  };
  const say = (divider: InboxMessage, session: string, body: string) =>
    store.sendMessage({ project_id: divider.project_id, author: { kind: "agent", host: FAKE, session, name: "Fake Agent" }, body, reply_to: divider.id });
  /** The run's session goes idle: the run has ended. */
  const end = (session: string) => fake.poll(session, false, clock.now);
  const make = async () =>
    (await scheduled.create({ name: "Nightly ledger check", prompt: "Check the ledger exports.", schedule: null, folder: { project_id: project.id }, agent: FAKE, enabled: true }, { kind: "person" })).record;
  return { store, launch, scheduled, row, start, say, end, make };
}

/** Shown, not announced: not bold, nothing unseen (the tab's count), not waiting on the person (the sidebar's and the phone's badge). */
function countsNothing(row: ReturnType<ReturnType<typeof world>["row"]>) {
  expect([row.unread, row.unseen, inboxRowWaitsOnPerson(row)]).toEqual([false, 0, false]);
}

describe("a routine's run going is under New", () => {
  test("the first run: New with nothing counted while it goes (its delivered divider alone is Quiet); a run that left nothing goes back to Quiet", async () => {
    const w = world();
    const record = await w.make();
    const { divider, session } = await w.start(record.id);
    expect(divider.id).toBe(divider.thread_id);
    // The cause: the person's divider, taken by its session, is a reply the agent has; by the rules alone that is Quiet.
    expect(w.store.listRow(divider.thread_id)!.section).toBe("quiet");
    const running = w.row(divider.thread_id);
    expect([running.section, running.scheduled_running]).toEqual(["new", true]);
    countsNothing(running);
    w.end(session);
    const ended = w.row(divider.thread_id);
    expect([ended.section, ended.scheduled_running]).toEqual(["quiet", undefined]);
  });

  test("a later run, in a thread the person had read: New while it goes; one that leaves words stays New, bold, by the usual rule", async () => {
    const w = world();
    const record = await w.make();
    const first = await w.start(record.id);
    w.say(first.divider, first.session, "Done: the exports match.");
    w.end(first.session);
    const thread = first.divider.thread_id;
    w.store.markSeen(thread);
    expect(w.row(thread).section).toBe("quiet");
    const second = await w.start(record.id);
    expect(second.divider.scheduled_run?.run).toBe(2);
    expect(second.divider.thread_id).toBe(thread);
    const running = w.row(thread);
    expect([running.section, running.scheduled_running]).toEqual(["new", true]);
    countsNothing(running);
    w.say(second.divider, second.session, "Done: two exports differ.");
    w.end(second.session);
    const ended = w.row(thread);
    expect([ended.section, ended.unread, ended.unseen, ended.scheduled_running]).toEqual(["new", true, 1, undefined]);
  });

  test("a Mark read before the run does not hold it in Quiet; a later run that leaves nothing goes back to Quiet", async () => {
    const w = world();
    const record = await w.make();
    const first = await w.start(record.id);
    w.say(first.divider, first.session, "Done.");
    w.end(first.session);
    const thread = first.divider.thread_id;
    w.store.markRead(thread, true);
    expect(w.row(thread).section).toBe("quiet");
    const second = await w.start(record.id);
    expect(w.row(thread)).toMatchObject({ section: "new", scheduled_running: true, unread: false });
    w.end(second.session);
    expect(w.row(thread).section).toBe("quiet");
  });

  test("a question during the run keeps its more urgent section: New is a floor, never a demotion", async () => {
    const w = world();
    const record = await w.make();
    const { divider, session } = await w.start(record.id);
    w.say(divider, session, STOPPED);
    const asking = w.row(divider.thread_id);
    expect([asking.section, asking.scheduled_running, asking.unread]).toEqual(["stopped", true, true]);
  });

  test("an archived routine thread stays archived while a run goes (its reply brings it back, as any agent's does)", async () => {
    const w = world();
    const record = await w.make();
    const first = await w.start(record.id);
    w.say(first.divider, first.session, "Done.");
    w.end(first.session);
    const thread = first.divider.thread_id;
    w.store.resolveThread(thread, true, "person");
    await w.start(record.id);
    const row = w.row(thread);
    expect([row.section, row.back_from_archive]).toEqual(["quiet", false]);
  });
});
