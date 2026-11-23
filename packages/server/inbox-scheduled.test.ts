/**
 * Routines on a real launch engine over a temp data dir, with the engine's fake agent and a hand-moved
 * clock. What each test guards: a run is a launch of its own inside the one thread, its divider carrying the prompt
 * (replied, then didn't finish); the previous idle run is let go of, the person's reply reaches the newest run, and a
 * reply to an earlier run is refused saying it ended; an ordinary launched thread keeps its one launch on its root;
 * the store read back from disk after a restart keeps every routine and never runs one twice; a skip line is
 * delivered to no session, so it never wakes or restarts a run; a sleep is one late run or one skip line, never a pile
 * of runs; two starts at once are one run; an agent can neither turn one on first nor run it before the person did,
 * and the clock never runs one the person has not turned on; a folder runs as it is; nothing runs while off; a paired
 * cloud agent's change to a routine does what a local agent's does (the owner, 2026-11-21: "Allow fully, same as a
 * local agent"); a routine's name in a change line reads as typed in the window, the list row's preview, a folded line
 * and read_thread, and never shows as a picture, a tag, a link, a mention or an issue ref.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { createInboxScheduled, type InboxScheduledBy } from "./inbox-scheduled";
import { routineLineText } from "@plannotator/core/inbox-scheduled";
import { createInboxImageCapture } from "./inbox-message-images";
import { inboxMessageImageRefs, inboxMessageImageRefsInOrder } from "@plannotator/shared/inbox/message-images";
import { firstWords } from "@plannotator/core/inbox-folding";
import { inboxRowPreviewWords } from "../core/inbox-row-preview";
import { InboxError } from "@plannotator/shared/inbox/schema";

const NY = "America/New_York";
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

function world(start = "2026-11-16T13:59:00.000Z", startIn: "rex" | null = null) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-scheduled-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "project");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, ...(startIn ? { startIn } : {}) } }));
  // Rex's tabs asked for (a stand-in for inbox-rex.ts: here, always there).
  const rexOpens: string[] = [];
  const clock = { now: Date.parse(start) };
  const open = () => InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  let store = open();
  const project = store.ensureProject({ name: "project", root: folder });
  const fake = fakeLaunchHost();
  const other = { ...fakeLaunchHost().host, agent: "fake-two" as typeof FAKE };
  const switches = { on: true };
  /** Runs inside a launch's preparing, the moment a run is starting. */
  const during: { prepare: (() => Promise<void>) | null } = { prepare: null };
  const engine = () => {
    const made = createInboxLaunch({
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
      hosts: () => [fake.host, other],
      rex: { open: async (request) => (rexOpens.push(request.command), { opened: true, session: "session:x", window: "window:y", block: "block:z", line: "Rex · project / Fake Agent" }), appAttachedNow: async () => true, paneGone: async () => null, closePane: async () => "refused" as const },
      now: () => clock.now,
    });
    restore.push(() => made.stop());
    const scheduled = createInboxScheduled({
      store,
      launch: made,
      on: () => switches.on,
      launchOn: () => made.settingsState().enabled,
      // As the real one: a folder that is not there has no project.
      resolveProject: async (path) => {
        await during.prepare?.();
        if (!existsSync(path)) throw new InboxError("folder_missing", `${path} isn't there. Pick another folder. Nothing was sent.`);
        return store.project(project.id)!;
      },
      recordAttachments: async () => [],
      displayFolder: (path) => path,
      now: () => clock.now,
    });
    restore.push(() => scheduled.stop());
    return { launch: made, scheduled };
  };
  let current = engine();
  const person = { kind: "person" } as const;
  const make = (over: Record<string, unknown> = {}) =>
    current.scheduled.create({ name: "Morning triage", prompt: "Triage the new issues.", schedule: { cron: "0 9 * * *", tz: NY }, folder: { project_id: project.id }, agent: FAKE, enabled: true, ...over }, person);
  const dividers = (threadId: string | null) =>
    threadId
      ? store
          .threadMessageIds(threadId)
          .map((id) => store.message(id)!)
          .filter((m) => m.scheduled_run)
      : [];
  /** The run's session took its prompt and went idle, after a reply or without one. */
  const settle = async (divider: InboxMessage, reply: string | null) => {
    await until(() => !!store.message(divider.id)!.launch!.session_ref);
    const session = store.message(divider.id)!.to!.session;
    fake.poll(session, true, clock.now);
    store.recordDelivery(divider.id, { host: FAKE, session });
    // The window reads the run line while it works.
    expect(current.launch.runOfMessage(divider.id)?.state).toBe("working");
    if (reply) store.sendMessage({ project_id: divider.project_id, author: { kind: "agent", host: FAKE, session, name: "Fake Agent" }, body: reply, reply_to: divider.id });
    fake.poll(session, false, clock.now);
    return session;
  };
  return {
    get store() {
      return store;
    },
    home,
    clock,
    project,
    fake,
    rexOpens,
    switches,
    during,
    make,
    dividers,
    settle,
    at: (iso: string) => (clock.now = Date.parse(iso)),
    get scheduled() {
      return current.scheduled;
    },
    get launch() {
      return current.launch;
    },
    /** The Inbox again: the store read back from disk, a new engine and clock. */
    restart: () => {
      current.scheduled.stop();
      current.launch.stop();
      store = open();
      current = engine();
    },
  };
}

describe("what is news in the list", () => {
  test("a skip line is not: after a look the row stays read; a run's reply is", async () => {
    const w = world();
    const { record } = await w.make({ if_missed: "skip" });
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const thread = w.store.scheduledThread(record.id)!.thread_id!;
    await w.settle(w.dividers(thread)[0]!, "Three new issues, labelled.");
    expect(w.store.listRow(thread)).toMatchObject({ section: "new", unread: true });
    w.store.markSeen(thread);
    for (const reason of ["asleep", "missed"] as const) {
      const at = reason === "asleep" ? "2026-11-17T14:00:00.000Z" : "2026-11-18T14:00:00.000Z";
      w.store.writeScheduledLine({ project_id: w.project.id, thread_id: thread, name: record.name, body: `Skipped · ${reason}`, key: `sch:${record.id}:${at}`, scheduled_run: { scheduled_id: record.id, name: record.name, due_at: at, by: "schedule", skipped: { count: 1, from: at, to: at, reason } } });
      const row = w.store.listRow(thread)!;
      expect(row.section).not.toBe("new");
      expect([row.unread, row.unseen]).toEqual([false, 0]);
    }
  });
});

describe("a run is a launch of its own in the one thread", () => {
  test("an archived thread (bulk Archive, a swipe, a Combine that took it): the next run goes on in it, and its reply brings it back", async () => {
    const w = world();
    const { record } = await w.make();
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const thread = w.store.scheduledThread(record.id)!.thread_id!;
    await w.settle(w.dividers(thread)[0]!, "Three new issues, labelled.");
    w.store.resolveThread(thread, true, "person");
    w.at("2026-11-17T14:00:10.000Z");
    await w.scheduled.check();
    expect(w.store.scheduledThread(record.id)!.thread_id).toBe(thread);
    const [, second] = w.dividers(thread);
    expect(second!.scheduled_run).toMatchObject({ run: 2 });
    const session = await w.settle(second!, "Two more, labelled.");
    expect(w.scheduled.rowOf(w.store.scheduledThread(record.id)!)).toMatchObject({ runs: 2, last_run: { run: 2, outcome: "replied" } });
    expect(w.store.agentAfterArchive(thread)).toBe(true);
    expect(w.store.threadOwner(thread)?.session).toBe(session);
  });

  test("a thread the person deleted: the next run starts one new thread, its number counts on, and nothing already run runs again", async () => {
    const w = world();
    const { record } = await w.make();
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const first = w.store.scheduledThread(record.id)!.thread_id!;
    await w.settle(w.dividers(first)[0]!, "Three new issues, labelled.");
    w.store.deleteThread(first);
    w.at("2026-11-16T14:05:00.000Z");
    await w.scheduled.check();
    expect(w.store.scheduledThread(record.id)!.thread_id).toBeNull();
    w.restart();
    w.at("2026-11-17T14:00:10.000Z");
    await w.scheduled.check();
    const thread = w.store.scheduledThread(record.id)!.thread_id!;
    expect(thread).not.toBe(first);
    expect(w.dividers(thread).map((m) => m.scheduled_run)).toMatchObject([{ run: 2, due_at: "2026-11-17T14:00:00.000Z" }]);
    await w.settle(w.dividers(thread)[0]!, "Two more, labelled.");
    expect(w.scheduled.rowOf(w.store.scheduledThread(record.id)!)).toMatchObject({ thread_id: thread, runs: 2, last_run: { run: 2, outcome: "replied" } });
  });

  test("replied, then didn't finish; the newest run takes the reply, an earlier one says it ended", async () => {
    const w = world();
    const { record } = await w.make();
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const thread = w.store.scheduledThread(record.id)!.thread_id;
    const [first] = w.dividers(thread);
    expect(first!.body).toBe("Triage the new issues.");
    expect(first!.scheduled_run).toMatchObject({ scheduled_id: record.id, name: "Morning triage", run: 1, by: "schedule" });
    expect(first!.launch?.agent).toBe(FAKE);
    const one = await w.settle(first!, "Three new issues, labelled.");
    expect(w.scheduled.get(record.id).runs.map((r) => r.outcome)).toEqual(["replied"]);

    // The next day: a second launch in the same thread, the first (idle) session let go of.
    w.at("2026-11-17T14:00:10.000Z");
    await w.scheduled.check();
    const [, second] = w.dividers(thread);
    expect(second).toMatchObject({ thread_id: thread, took_over: true, scheduled_run: { run: 2, name: "Morning triage" } });
    const two = await w.settle(second!, null);
    expect(two).not.toBe(one);
    expect(w.fake.calls).toContain("stop f1");
    expect(w.scheduled.get(record.id).runs.map((r) => r.outcome)).toEqual(["didnt_finish", "replied"]);

    // The person's plain reply goes to the newest run; a reply to the first run's message is refused, nothing written.
    expect(w.store.threadOwner(thread!)?.session).toBe(two);
    const answer = w.store.message(w.store.threadMessageIds(thread!).find((id) => w.store.message(id)!.author.kind === "agent")!)!;
    expect(() => w.scheduled.checkReply(answer.id, undefined)).toThrow("Run 1 has ended, so your reply was not sent. Reply to the latest run (Run 2) instead.");
    expect(() => w.scheduled.checkReply(second!.id, undefined)).not.toThrow();
    const reply = w.store.sendReply(second!.id, { idempotency_key: "r1", words: "Also check the flaky test." }).reply;
    expect(reply.to?.session).toBe(two);
  });

  test("an ordinary launched thread keeps its one launch on its root", async () => {
    const w = world();
    const { record } = await w.make();
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    await w.settle(w.dividers(w.store.scheduledThread(record.id)!.thread_id)[0]!, "Done.");
    w.at("2026-11-17T14:00:10.000Z");
    await w.scheduled.check();
    const target = w.launch.target({ launch: { agent: FAKE, project_id: w.project.id } })!;
    const prepared = await w.launch.prepare(target, { name: "Tidy", body: "Tidy the readme.", resolveProject: async () => w.project });
    const plain = w.store.startPersonThread({ project_id: w.project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "tidy", thread_name: "Tidy", launch: prepared.launch }).message;
    w.launch.begin(plain);
    const [run1, run2] = w.dividers(w.store.scheduledThread(record.id)!.thread_id);
    expect(w.store.launchedRoots().map((m) => m.id).sort()).toEqual([run1!.id, plain.id].sort());
    expect(w.store.scheduledRunLaunches().map((m) => m.id)).toEqual([run2!.id]);
    expect(w.store.thread(plain.thread_id)!.messages.filter((m) => m.launch).map((m) => m.id)).toEqual([plain.id]);
  });
});

describe("Rex chosen in Settings → Agents", () => {
  test("a routine's run never starts in Rex: in the background, as ever, and its Stop and Delete stop it", async () => {
    const w = world(undefined, "rex");
    const { record } = await w.make();
    const { message } = await w.scheduled.runNow(record.id, { kind: "person" });
    await until(() => !!w.store.message(message.id)!.launch!.session_ref);
    expect(w.rexOpens).toEqual([]);
    expect(w.fake.calls.filter((call) => call.startsWith("start "))).toHaveLength(1);
    expect(w.store.message(message.id)!.launch!.rex).toBeUndefined();
    w.fake.poll(w.store.message(message.id)!.to!.session, true, w.clock.now);
    await w.scheduled.stopRun(record.id);
    expect(w.fake.calls.some((call) => call.startsWith("stop "))).toBe(true);
  });

  test("a run that runs in Rex (from before routines started only in the background): Stop and Delete go through, Rex's tab left as it is", async () => {
    const w = world();
    const { record } = await w.make();
    const { message } = await w.scheduled.runNow(record.id, { kind: "person" });
    await until(() => !!w.store.message(message.id)!.launch!.session_ref);
    const started = w.store.message(message.id)!;
    w.store.settleLaunch(message.id, { to: started.to!, session_ref: started.launch!.session_ref!, rex: { line: "Rex · project / Fake Agent" } });
    w.fake.poll(started.to!.session, true, w.clock.now);
    expect(w.scheduled.rowOf(record).state).toBe("running");
    await w.scheduled.stopRun(record.id);
    await w.scheduled.remove(record.id, { kind: "person" });
    expect(w.store.scheduledThread(record.id)).toBeNull();
    expect(w.fake.calls.filter((call) => call.startsWith("stop "))).toEqual([]);
  });
});

describe("delete", () => {
  test("a run under way is stopped first; Undo brings it back as it was, catching up nothing due meanwhile", async () => {
    const w = world();
    const { record } = await w.make();
    const { message } = await w.scheduled.runNow(record.id, { kind: "person" });
    await until(() => !!w.store.message(message.id)!.launch!.session_ref);
    w.fake.poll(w.store.message(message.id)!.to!.session, true, w.clock.now);
    expect(w.scheduled.rowOf(record).state).toBe("running");
    await w.scheduled.remove(record.id, { kind: "person" });
    expect(w.store.scheduledThread(record.id)).toBeNull();
    expect(w.fake.calls.some((call) => call.startsWith("stop "))).toBe(true);
    // Deleted over a due time: nothing runs, and Undo starts from now.
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    expect(w.dividers(w.store.deletedScheduledThread(record.id)!.thread_id)).toHaveLength(1);
    const back = w.scheduled.restore(record.id);
    expect(back).toMatchObject({ enabled: true, handled_through: "2026-11-16T14:00:10.000Z" });
    expect(w.scheduled.rowOf(back).state).not.toBe("running");
    await w.scheduled.check();
    expect(w.dividers(back.thread_id)).toHaveLength(1);
  });

  test("a delete while a run is starting: that run doesn't start, and the scratch folder made for it goes", async () => {
    const w = world();
    const { record } = await w.make({ folder: { scratch: true } });
    w.during.prepare = async () => {
      w.during.prepare = null;
      await w.scheduled.remove(record.id, { kind: "person" });
    };
    await expect(w.scheduled.runNow(record.id, { kind: "person" })).rejects.toThrow(`No routine ${record.id}.`);
    expect(w.fake.calls.filter((call) => call.startsWith("start "))).toEqual([]);
    expect(w.store.deletedScheduledThread(record.id)!.thread_id).toBeNull();
    const scratch = join(w.home, "..", "data", "scratch");
    expect(existsSync(scratch) ? readdirSync(scratch) : []).toEqual([]);
  });
});

describe("the clock", () => {
  test("rescheduling a one-time routine while it is preparing preserves the new run", async () => {
    const w = world();
    const { record } = await w.make({ folder: { scratch: true }, schedule: { at: "2026-11-16T09:00", tz: NY } });
    const replacement = { at: "2026-11-17T09:00", tz: NY };
    w.during.prepare = async () => {
      w.during.prepare = null;
      await w.scheduled.update(record.id, { schedule: replacement }, { kind: "person" });
    };

    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const rescheduled = w.store.scheduledThread(record.id)!;
    expect(rescheduled).toMatchObject({ enabled: true, schedule: replacement, thread_id: null });
    expect(rescheduled.done_at).toBeUndefined();

    w.at("2026-11-17T14:00:10.000Z");
    await w.scheduled.check();
    const finished = w.store.scheduledThread(record.id)!;
    expect(w.dividers(finished.thread_id).map((line) => line.scheduled_run?.due_at)).toEqual(["2026-11-17T14:00:00.000Z"]);
  });

  test("a restart reads every routine back from disk and never runs one twice; a skip line wakes no run", async () => {
    const w = world();
    const { record } = await w.make();
    const { record: skipper } = await w.make({ name: "Standup notes", if_missed: "skip" });
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const thread = w.store.scheduledThread(record.id)!.thread_id;
    const sessions: string[] = [];
    for (const id of [record.id, skipper.id]) sessions.push(await w.settle(w.dividers(w.store.scheduledThread(id)!.thread_id)[0]!, "Done."));
    w.restart();
    expect(w.store.scheduledThreads().map((r) => [r.id, r.enabled, !!r.approved_at])).toEqual([
      [record.id, true, true],
      [skipper.id, true, true],
    ]);
    w.at("2026-11-16T14:00:40.000Z");
    await w.scheduled.check();
    expect(w.dividers(thread)).toHaveLength(1);
    expect(w.fake.calls.filter((c) => c.startsWith("start Morning triage"))).toHaveLength(1);

    // Down over the next day's 9:00 and back at 9:30: the skip one says the Inbox wasn't running.
    w.restart();
    w.at("2026-11-17T14:30:00.000Z");
    await w.scheduled.check();
    const line = w.dividers(w.store.scheduledThread(skipper.id)!.thread_id).at(-1)!;
    expect(line.body).toBe("Skipped Tue 9:00 AM · the Inbox wasn't running");
    expect(line.scheduled_run).toMatchObject({ skipped: { count: 1, reason: "not_running" } });
    expect(line.launch).toBeUndefined();
    // Run 1's session, idle, is not handed the skip line, and is not started again for it.
    await Bun.sleep(20);
    expect(w.store.pendingReplies(sessions[1]!).map((m) => m.id)).not.toContain(line.id);
    expect(w.fake.calls.filter((c) => c.startsWith("resume"))).toEqual([]);
  });

  test("a sleep over five hourly runs is one late run, or one skip line", async () => {
    const w = world("2026-11-16T12:59:00.000Z");
    const hourly = { cron: "0 * * * *", tz: NY };
    const { record } = await w.make({ name: "Inbox sweep", schedule: hourly });
    const { record: skipper } = await w.make({ name: "Queue check", schedule: hourly, if_missed: "skip" });
    w.at("2026-11-16T13:00:10.000Z");
    await w.scheduled.check();
    for (const id of [record.id, skipper.id]) await w.settle(w.dividers(w.store.scheduledThread(id)!.thread_id)[0]!, "Done.");
    w.at("2026-11-16T13:00:40.000Z");
    await w.scheduled.check();
    // The lid closes; it opens at 1:40 PM local.
    w.at("2026-11-16T18:40:00.000Z");
    await w.scheduled.check();
    const runs = w.dividers(w.store.scheduledThread(record.id)!.thread_id);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.scheduled_run).toMatchObject({ run: 2, late: true, missed_before: 4, due_at: "2026-11-16T18:00:00.000Z" });
    expect(runs[1]!.body).toBe("Triage the new issues.\n\nThis run was due Mon 1:00 PM and started Mon 1:40 PM.");
    const skips = w.dividers(w.store.scheduledThread(skipper.id)!.thread_id).slice(1);
    expect(skips.map((m) => m.body)).toEqual(["Skipped 5 times, Mon 9:00 AM to Mon 1:00 PM · this computer was asleep"]);
    // The same wake checked again writes nothing more.
    await w.scheduled.check();
    expect(w.dividers(w.store.scheduledThread(record.id)!.thread_id)).toHaveLength(2);
  });

  test("off: no timer, no run, no line; on again starts from the next due time", async () => {
    const w = world();
    const { record } = await w.make();
    w.switches.on = false;
    w.scheduled.sync();
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    expect(w.dividers(record.thread_id)).toEqual([]);
    expect(w.fake.calls).toEqual([]);
    w.at("2026-11-16T15:00:00.000Z");
    w.switches.on = true;
    w.scheduled.switchedOn();
    await w.scheduled.check();
    expect(w.store.scheduledThread(record.id)!.thread_id).toBeNull();
  });
});

test("Start agents off and then on again catches up nothing that came due meanwhile, as the capability switch does", async () => {
  const w = world();
  const { record } = await w.make();
  const config = join(process.env.PLANNOTATOR_DATA_DIR!, "config.json");
  writeFileSync(config, JSON.stringify({ inboxLaunch: { enabled: false } }));
  w.at("2026-11-16T14:00:10.000Z");
  await w.scheduled.check();
  writeFileSync(config, JSON.stringify({ inboxLaunch: { enabled: true } }));
  w.at("2026-11-16T14:30:00.000Z");
  await w.scheduled.check();
  expect(w.store.scheduledThread(record.id)!.thread_id).toBeNull();
  // The next due time runs as usual.
  w.at("2026-11-17T14:00:10.000Z");
  await w.scheduled.check();
  expect(w.dividers(w.store.scheduledThread(record.id)!.thread_id).map((m) => m.scheduled_run!.run)).toEqual([1]);
});

describe("schedules refused when set", () => {
  test("a one-time time already passed, on create and on edit; one saved before its time keeps it", async () => {
    const w = world();
    const passed = { at: "2026-11-15T17:00", tz: NY };
    await expect(w.make({ schedule: passed })).rejects.toMatchObject({ code: "schedule_invalid", message: "That time has already passed." });
    const { record } = await w.make({ schedule: { at: "2026-11-16T17:00", tz: NY } });
    await expect(w.scheduled.update(record.id, { schedule: passed }, { kind: "person" })).rejects.toMatchObject({ message: "That time has already passed." });
    w.at("2026-11-17T12:00:00.000Z");
    expect((await w.scheduled.update(record.id, { schedule: { at: "2026-11-16T17:00", tz: NY }, name: "Send the report" }, { kind: "person" })).record.name).toBe("Send the report");
  });

  test("a date that is not real and a cron that never runs: schedule_invalid, nothing written", async () => {
    const w = world();
    for (const schedule of [{ at: "2026-02-30T10:00", tz: NY }, { cron: "0 9 31 2 *", tz: NY }]) await expect(w.make({ schedule })).rejects.toMatchObject({ code: "schedule_invalid" });
    expect(w.store.scheduledThreads()).toEqual([]);
  });

  test("an agent's /create-routine create with a refused schedule never reports its fields passed, so the person's grant is given back", async () => {
    const w = world();
    const agent: InboxScheduledBy = { kind: "agent", host: FAKE, session: "ses_maya", name: "Fake Agent", thread_id: null };
    let checked = 0;
    const input = { name: "Morning triage", prompt: "Triage the new issues.", folder: { project_id: w.project.id }, agent: FAKE };
    for (const schedule of [{ at: "2026-02-30T10:00", tz: NY }, { cron: "nope", tz: NY }]) {
      await expect(w.scheduled.create({ ...input, schedule }, agent, undefined, true, () => checked++)).rejects.toMatchObject({ code: "schedule_invalid" });
    }
    expect(checked).toBe(0);
    expect(w.store.scheduledThreads()).toEqual([]);
    // A good one passes its fields first, then saves.
    await w.scheduled.create({ ...input, schedule: { cron: "0 9 * * *", tz: NY } }, agent, undefined, true, () => checked++);
    expect(checked).toBe(1);
  });
});

test("a schedule without tz takes this computer's zone, and an update changes only the fields it names", async () => {
  const w = world();
  const { record } = await w.make({ schedule: { cron: "0 9 * * *" } });
  expect(record.schedule).toEqual({ cron: "0 9 * * *", tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const { record: renamed } = await w.scheduled.update(record.id, { name: "Morning sweep" }, { kind: "person" });
  expect({ ...renamed, name: record.name, updated_at: record.updated_at }).toEqual(record);
});

test("simultaneous routine updates preserve fields omitted by either edit", async () => {
  const w = world();
  const { record } = await w.make();
  const person = { kind: "person" } as const;
  await Promise.all([
    w.scheduled.update(record.id, { name: "Morning sweep" }, person),
    w.scheduled.update(record.id, { prompt: "Check the new reviews." }, person),
  ]);

  expect(w.store.scheduledThread(record.id)).toMatchObject({
    name: "Morning sweep",
    prompt: "Check the new reviews.",
  });
});

test("a routine deleted while an edit is validating stays deleted", async () => {
  const w = world();
  const { record } = await w.make();
  const person = { kind: "person" } as const;
  const edit = w.scheduled.update(record.id, { name: "Morning sweep" }, person);
  await w.scheduled.remove(record.id, person);

  await expect(edit).rejects.toMatchObject({ code: "routine_not_found" });
  expect(w.store.scheduledThread(record.id)).toBeNull();
});

describe("one run at a time", () => {
  test("two Run now presses at once, or Run now as the clock fires, are one run in one thread", async () => {
    const w = world();
    const { record } = await w.make({ schedule: null });
    const presses = await Promise.allSettled([w.scheduled.runNow(record.id, { kind: "person" }), w.scheduled.runNow(record.id, { kind: "person" })]);
    expect(presses.map((p) => p.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((presses.find((p) => p.status === "rejected") as PromiseRejectedResult).reason.code).toBe("routine_running");

    const { record: daily } = await w.make({ name: "Standup notes" });
    w.at("2026-11-16T14:00:10.000Z");
    const both = await Promise.allSettled([w.scheduled.check(), w.scheduled.runNow(daily.id, { kind: "person" })]);
    expect(both.map((p) => p.status)).toEqual(["fulfilled", "rejected"]);
    for (const id of [record.id, daily.id]) expect(w.dividers(w.store.scheduledThread(id)!.thread_id).map((m) => m.scheduled_run!.run)).toEqual([1]);
    expect(w.fake.calls.filter((c) => c.startsWith("start"))).toHaveLength(2);
  });

  test("a due time while a run works is a skip line that run never gets", async () => {
    const w = world();
    const { record } = await w.make({ if_missed: "skip" });
    w.at("2026-11-16T13:59:30.000Z");
    const { message: divider } = await w.scheduled.runNow(record.id, { kind: "person" });
    await until(() => !!w.store.message(divider.id)!.launch!.session_ref);
    const session = w.store.message(divider.id)!.to!.session;
    w.fake.poll(session, true, w.clock.now);
    w.store.recordDelivery(divider.id, { host: FAKE, session });
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const skip = w.dividers(divider.thread_id).at(-1)!;
    expect(skip.body).toBe("Skipped Mon 9:00 AM · the last run was still going");
    expect(w.store.pendingReplies(session).map((m) => m.id)).not.toContain(skip.id);
  });
});

describe("the person turns it on first", () => {
  const agent = (thread_id: string | null = null): InboxScheduledBy => ({ kind: "agent", host: FAKE, session: "s-maya", name: "Fake Agent", thread_id });

  test("an agent's on or run before that is refused with nothing written; the clock never runs one not turned on", async () => {
    const w = world();
    const { record } = await w.scheduled.create({ name: "Morning triage", prompt: "Triage.", schedule: { cron: "0 9 * * *", tz: NY }, folder: { project_id: w.project.id }, agent: FAKE }, agent());
    expect(record).toMatchObject({ enabled: false, approved_at: null });
    await expect(w.scheduled.setOn(record.id, true, agent())).rejects.toThrow("The person turns Morning triage on the first time");
    await expect(w.scheduled.runNow(record.id, agent())).rejects.toMatchObject({ code: "routine_not_approved" });
    expect(w.store.scheduledThread(record.id)).toEqual(record);
    // On, but never by the person (a record written by hand): the clock passes it by.
    w.store.putScheduledThread({ ...record, enabled: true, handled_through: "2026-11-16T13:00:00.000Z" });
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    expect(w.dividers(record.thread_id)).toEqual([]);
    expect(w.fake.calls).toEqual([]);
  });

  test("after it, an agent may run it; changing its folder or its agent turns it off and asks the person again", async () => {
    const w = world();
    const { record } = await w.make();
    const { message } = await w.scheduled.runNow(record.id, agent());
    expect(message.scheduled_run).toMatchObject({ run: 1, by: "agent" });
    for (const change of [{ agent: "fake-two" }, { folder: { path: w.home + "/code" } }]) {
      mkdirSync(join(w.home, "code"), { recursive: true });
      await w.scheduled.setOn(record.id, true, { kind: "person" });
      const { record: after } = await w.scheduled.update(record.id, change, agent());
      expect(after).toMatchObject({ enabled: false, approved_at: null });
      await expect(w.scheduled.runNow(record.id, agent())).rejects.toMatchObject({ code: "routine_not_approved" });
    }
    // A prompt edit applies at once and leaves it on.
    await w.scheduled.setOn(record.id, true, { kind: "person" });
    expect((await w.scheduled.update(record.id, { prompt: "Triage, then label." }, agent())).record).toMatchObject({ enabled: true, prompt: "Triage, then label." });
  });
});

describe("an agent's change with no thread_id is said in the routine's own thread", () => {
  const agent: InboxScheduledBy = { kind: "agent", host: "codex", session: "s-alex", name: "Codex", thread_id: null };

  test("a prompt edit on a routine that ran: one line there, old and new; it wakes no run, takes no reply, and is news", async () => {
    const w = world();
    const { record } = await w.make();
    const { message } = await w.scheduled.runNow(record.id, { kind: "person" });
    const session = await w.settle(message, "Three new issues, labelled.");
    const thread = message.thread_id;
    w.store.markSeen(thread);
    await w.scheduled.update(record.id, { prompt: "Triage, then label." }, agent);
    const line = w.store.message(w.store.threadMessageIds(thread).at(-1)!)!;
    expect(line).toMatchObject({ author: { kind: "agent", name: "Codex" }, scheduled_change: { scheduled_id: record.id, op: "update", fields: ["prompt"] } });
    expect(line.body).toContain("- Triage the new issues.\n+ Triage, then label.");
    expect(w.store.pendingReplies(session).map((m) => m.id)).not.toContain(line.id);
    expect(w.store.pendingReplies("s-alex")).toEqual([]);
    expect(w.store.threadOwner(thread)?.session).toBe(session);
    expect(w.store.listRow(thread)).toMatchObject({ unread: true });
    expect(w.scheduled.rowOf(w.store.scheduledThread(record.id)!).last_change).toEqual({ op: "update", by: "Codex", at: line.created_at });
  });

  test("after the person deletes its thread, two edits with no thread_id are two lines in one new thread", async () => {
    const w = world();
    const { record } = await w.make();
    const { message } = await w.scheduled.runNow(record.id, { kind: "person" });
    await w.settle(message, "Three new issues, labelled.");
    w.store.deleteThread(message.thread_id);
    expect(w.scheduled.rowOf(w.store.scheduledThread(record.id)!)).toMatchObject({ thread_id: null, thread_name: null, runs: 1 });
    const before = w.store.threadIds().length;
    await w.scheduled.update(record.id, { prompt: "Triage, then label." }, agent);
    await w.scheduled.update(record.id, { prompt: "Triage, label, then assign." }, agent);
    const thread = w.store.scheduledThread(record.id)!.thread_id!;
    expect(w.store.threadIds().length).toBe(before + 1);
    expect(w.store.threadMessageIds(thread).map((id) => w.store.message(id)!.scheduled_change?.op)).toEqual(["update", "update"]);
  });

  test("one that never ran: the line makes its thread, and its first run goes on in it", async () => {
    const w = world();
    const { record } = await w.scheduled.create({ name: "Morning triage", prompt: "Triage.", schedule: null, folder: { project_id: w.project.id }, agent: FAKE }, agent);
    expect(record.thread_id).not.toBeNull();
    const made = w.store.message(record.thread_id!)!;
    expect(made).toMatchObject({ subject: "Morning triage", scheduled_change: { op: "create" } });
    await w.scheduled.setOn(record.id, true, { kind: "person" });
    const { message } = await w.scheduled.runNow(record.id, agent);
    expect(message.thread_id).toBe(record.thread_id!);
    expect(w.store.threadOwner(record.thread_id!)?.session).toBe(message.to!.session);
  });
});

describe("the folder", () => {
  test("a folder by its path runs there, not at its project's root; home is refused", async () => {
    const w = world();
    const sub = join(w.home, "code", "api", "packages", "web");
    mkdirSync(sub, { recursive: true });
    const { record } = await w.make({ folder: { path: sub } });
    expect(record.folder).toEqual({ path: realpathSync(sub) });
    const { message } = await w.scheduled.runNow(record.id, { kind: "person" });
    expect(message.launch?.folder).toBe(realpathSync(sub));
    await expect(w.make({ folder: { path: w.home } })).rejects.toThrow("Pick a folder inside the home folder.");
  });

  test("a person's folder by its path gone before any run: the clock's run files its didn't-start line under the scratch folders' own folder, making no project for the gone one", async () => {
    const w = world();
    const gone = join(w.home, "code", "acme-web");
    mkdirSync(gone, { recursive: true });
    const { record } = await w.make({ folder: { path: gone } });
    rmSync(gone, { recursive: true });
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const row = w.scheduled.rowOf(w.store.scheduledThread(record.id)!);
    expect(row.last_run).toMatchObject({ run: 1, outcome: "didnt_start" });
    const [line] = w.dividers(row.thread_id);
    expect(line!.scheduled_run!.failed).toMatch(/acme-web isn't there\. Pick another folder\.$/);
    expect(w.store.project(line!.project_id)).toMatchObject({ name: "scratch", root: join(w.home, "..", "data", "scratch") });
    expect(w.store.allProjects().some((p) => p.root === (record.folder as { path: string }).path)).toBe(false);
  });

  test("a new scratch folder that can't be made on the first run: the clock's line goes under the scratch folders' own folder", async () => {
    const w = world();
    const repo = join(w.home, "..", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(w.home, "..", "data", "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, scratchDir: join(repo, "scratch") } }));
    const { record } = await w.make({ folder: { scratch: true } });
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const row = w.scheduled.rowOf(w.store.scheduledThread(record.id)!);
    expect(row.last_run).toMatchObject({ run: 1, outcome: "didnt_start" });
    const [line] = w.dividers(row.thread_id);
    expect(line!.scheduled_run!.failed).toContain("is inside the git repository");
    expect(w.store.project(line!.project_id)).toMatchObject({ name: "scratch", root: join(repo, "scratch") });
  });

  test("a folder by its path gone before its first run: a thread whose first line says the run didn't start, and why", async () => {
    const w = world();
    const gone = join(w.home, "code", "gone");
    mkdirSync(gone, { recursive: true });
    const calling = w.store.sendMessage({ project_id: w.project.id, author: { kind: "agent", host: FAKE, session: "s-maya", name: "Fake Agent" }, body: "Setting up a nightly check." }).message;
    const by: InboxScheduledBy = { kind: "agent", host: FAKE, session: "s-maya", name: "Fake Agent", thread_id: calling.thread_id };
    const { record } = await w.scheduled.create({ name: "Nightly check", prompt: "Check.", schedule: { cron: "0 3 * * *", tz: NY }, folder: { path: gone }, agent: FAKE }, by);
    rmSync(gone, { recursive: true });
    // Its folder is gone, so no project comes from it: the line goes in the project of the thread the agent made it from.
    const { message } = await w.scheduled.runNow(record.id, { kind: "person" });
    expect(message.project_id).toBe(w.project.id);
    expect(message.scheduled_run!.run).toBe(1);
    expect(message.scheduled_run!.failed).toMatch(/gone isn't there\. Pick another folder\.$/);
    expect(message.thread_id).toBe(message.id);
    expect(w.scheduled.rowOf(w.store.scheduledThread(record.id)!)).toMatchObject({ thread_id: message.id, last_run: { outcome: "didnt_start" } });
  });
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("a paired cloud agent's change to a routine the person turned on", () => {
  const cloud = (thread_id: string | null = null): InboxScheduledBy => ({ kind: "agent", host: "cloud-claude", session: "cloud.0123456789ab", name: "Nightly fixer", thread_id });
  const local = (thread_id: string | null = null): InboxScheduledBy => ({ kind: "agent", host: FAKE, session: "s-maya", name: "Fake Agent", thread_id });

  test("is a local agent's: a prompt, schedule, model or effort change keeps it on and runs, said where it asked; a folder or agent change turns it off for both", async () => {
    for (const by of [cloud, local]) {
      const w = world();
      const { record } = await w.make();
      const elsewhere = w.store.sendMessage({ project_id: w.project.id, author: { kind: "person" }, body: "Unrelated.", subject: "Unrelated" }).message;
      for (const change of [{ prompt: "Triage, then close them all." }, { schedule: { cron: "0 10 * * *", tz: NY } }, { model: "big-model" }, { effort: "high" }]) {
        await w.scheduled.setOn(record.id, true, { kind: "person" });
        const { record: after, told } = await w.scheduled.update(record.id, change, by(elsewhere.thread_id));
        expect([by().host, after.enabled]).toEqual([by().host, true]);
        expect(w.store.message(told!)!.thread_id).toBe(elsewhere.thread_id);
      }
      const { message } = await w.scheduled.runNow(record.id, by());
      expect(message.scheduled_run).toMatchObject({ run: 1, by: "agent" });
      const { record: moved } = await w.scheduled.update(record.id, { agent: "fake-two" }, by(elsewhere.thread_id));
      expect([by().host, moved.enabled]).toEqual([by().host, false]);
    }
  });
});

describe("a routine's name in a change line", () => {
  // A plain name (Maya's triage, written as it is, as on main), then each a name that would draw as something else were
  // it written into the line as it is (the window's drawing of these lines: packages/inbox/scheduled/changeLineNames.test.tsx).
  const NAMES = ["Maya's triage", "Deps: weekly", "@maya's sweep", "snake_case_name", "2 * 3 * 4", "Scan <img src=scan.png>", "Scan ![x](scan.png)", "Fix #123 now", "See https://e.co", "a `tick` and ``two``", "`edge`"];

  test("reads exactly as typed in the list row's preview, a folded line and read_thread, and no picture is read for it", async () => {
    const w = world();
    // In the project's folder, where an agent's line would find it.
    writeFileSync(join(w.project.root, "scan.png"), PNG);
    for (const by of [
      { kind: "agent" as const, host: "cloud-claude", session: "cloud.0123456789ab", name: "Nightly fixer", thread_id: null },
      { kind: "agent" as const, host: FAKE, session: "s-maya", name: "Fake Agent", thread_id: null },
    ]) {
      for (const name of NAMES) {
        const { record, told: made } = await w.scheduled.create({ name, prompt: "Triage.", schedule: null, folder: { project_id: w.project.id }, agent: FAKE }, by);
        const { told: renamed } = await w.scheduled.update(record.id, { name: "Plain" }, by);
        const { record: back } = await w.scheduled.update(record.id, { name }, by);
        const { told: deleted } = await w.scheduled.remove(back.id, by);
        const capture = createInboxImageCapture(w.store, { pauseMs: 0 });
        for (const id of [made, renamed, deleted]) {
          const line = w.store.message(id!)!;
          expect([name, inboxMessageImageRefsInOrder(line.body), [...inboxMessageImageRefs(line.body)]]).toEqual([name, [], []]);
          // The words (a rename's line names the old name too): the list row's line, a folded line, and the body
          // read_thread gives an agent.
          // The made line's name is its link's words, which drop [ and ] (as on main: they would end the link).
          const words = id === made ? name.replace(/[[\]]/g, "") : name;
          expect([name, inboxRowPreviewWords(line).includes(words), firstWords(line.body).includes(words), line.body.includes(words)]).toEqual([name, true, true, true]);
          capture.schedule(line.thread_id);
        }
        await capture.idle();
        capture.stop();
        for (const id of [made, renamed, deleted]) expect(w.store.message(id!)!.inline_images ?? []).toEqual([]);
      }
    }
  });

  test("a plain name's lines are main's, byte for byte", async () => {
    const w = world();
    const by = { kind: "agent" as const, host: FAKE, session: "s-maya", name: "Fake Agent", thread_id: null };
    const { record, told: made } = await w.scheduled.create({ name: "Maya's triage", prompt: "Triage.", schedule: null, folder: { project_id: w.project.id }, agent: FAKE }, by);
    expect(w.store.message(made!)!.body).toBe(`Made the routine [Maya's triage](#routine=${record.id}). It is off until you turn it on.`);
    const { told: renamed } = await w.scheduled.update(record.id, { name: "Morning triage" }, by);
    expect(w.store.message(renamed!)!.body).toBe(`Changed the routine [Morning triage](#routine=${record.id}).\n\nIts name was Maya's triage.`);
    const { told: deleted } = await w.scheduled.remove(record.id, by);
    expect(w.store.message(deleted!)!.body).toBe("Deleted the routine Morning triage. Its thread and past runs stay.");
  });

  test("a folder's path reads as typed, and the Inbox's own words for a folder stay plain words", async () => {
    const w = world();
    const { record } = await w.make();
    mkdirSync(join(w.home, "my-app_v2"), { recursive: true });
    const { told } = await w.scheduled.update(record.id, { folder: { path: w.home + "/my-app_v2" } }, { kind: "agent", host: FAKE, session: "s-maya", name: "Fake Agent", thread_id: null });
    const line = w.store.message(told!)!;
    expect(firstWords(line.body)).toContain(`${w.home}/my-app_v2`);
    expect(line.body).toContain(`${w.home}/my-app_v2`);
    // A plain path is written as it is, as on main (a temp folder holds no `.`); one a renderer could open as a file is code.
    expect(line.body).toMatch(/It now works in \/\S*\/home\/my-app_v2 \(was \//);
    mkdirSync(join(w.home, "next.js"), { recursive: true });
    const { told: dotted } = await w.scheduled.update(record.id, { folder: { path: w.home + "/next.js" } }, { kind: "agent", host: FAKE, session: "s-maya", name: "Fake Agent", thread_id: null });
    expect(w.store.message(dotted!)!.body).toMatch(/It now works in `\/\S*\/home\/next\.js` \(was \/\S*\/home\/my-app_v2\)\./);
    expect(routineLineText("a `b` c")).toBe("``a `b` c``");
    expect(routineLineText("`x`")).toBe("`` `x` ``");
  });
});
