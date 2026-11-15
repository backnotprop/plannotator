/**
 * Scheduled threads on a real launch engine over a temp data dir, with the engine's fake agent and a hand-moved
 * clock. What each test guards: a run is a launch of its own inside the one thread, its divider carrying the prompt
 * (replied, then didn't finish); the previous idle run is let go of, the person's reply reaches the newest run, and a
 * reply to an earlier run is refused saying it ended; an ordinary launched thread keeps its one launch on its root;
 * a restart mid-run never runs twice and says the right skip line; a sleep is one late run or one skip line, never a
 * pile of runs; nothing runs while the switch is off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { createInboxScheduled } from "./inbox-scheduled";

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

function world(start = "2026-11-16T13:59:00.000Z") {
  const root = mkdtempSync(join(tmpdir(), "plannotator-scheduled-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "project");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const clock = { now: Date.parse(start) };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "project", root: folder });
  const fake = fakeLaunchHost();
  const switches = { on: true };
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
      hosts: () => [fake.host],
      now: () => clock.now,
    });
    restore.push(() => made.stop());
    const scheduled = createInboxScheduled({
      store,
      launch: made,
      on: () => switches.on,
      launchOn: () => made.settingsState().enabled,
      resolveProject: async () => project,
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
    store,
    clock,
    project,
    fake,
    switches,
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
    restart: () => {
      current.scheduled.stop();
      current.launch.stop();
      current = engine();
    },
  };
}

describe("a run is a launch of its own in the one thread", () => {
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

describe("the clock", () => {
  test("a restart mid-run never runs it twice, and a due time it was down for is the right skip line", async () => {
    const w = world();
    const { record } = await w.make();
    const { record: skipper } = await w.make({ name: "Standup notes", if_missed: "skip" });
    w.at("2026-11-16T14:00:10.000Z");
    await w.scheduled.check();
    const thread = w.store.scheduledThread(record.id)!.thread_id;
    for (const id of [record.id, skipper.id]) await w.settle(w.dividers(w.store.scheduledThread(id)!.thread_id)[0]!, "Done.");
    // Down after the divider was written and before the record moved on: the restart answers the same run.
    w.store.putScheduledThread({ ...w.store.scheduledThread(record.id)!, handled_through: "2026-11-15T14:00:00.000Z" });
    w.restart();
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
    expect(w.store.scheduledThread(record.id)!.thread_id).toBeNull();
    expect(w.fake.calls).toEqual([]);
    w.at("2026-11-16T15:00:00.000Z");
    w.switches.on = true;
    w.scheduled.switchedOn();
    await w.scheduled.check();
    expect(w.store.scheduledThread(record.id)!.thread_id).toBeNull();
  });
});
