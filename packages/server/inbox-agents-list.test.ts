/**
 * Each machine's agents for the sidebar's Agents section (inbox-agents-list.ts). The failures this catches: a live
 * session missing or in the wrong state, a session that still owns a thread waiting on the person dropped because it
 * ended, a session that ended yesterday counted as ended today (or one that ended today dropped, or the week the window reads lost), a launched agent that is only
 * stopped read as ended, a list that grows without bound, another machine's agents lost or unnamed on the merged view,
 * and an Agents change that no `event: deliveries` would tell a window about.
 *
 * In-process: the live sessions over a temp store with a test clock, and the pure listing; no Inbox server starts.
 * The forward of another machine's agents (its PeerLink) is in inbox-peer-link.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_AGENTS_LISTED_MAX, type InboxAgentsGroup } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxAgentsEndedSince, inboxAgentsGroup, inboxMergedAgents, inboxPeerAgentsGroup, inboxStartOfDay, type InboxAgentsEvidence } from "./inbox-agents-list";
import { createInboxFirstSeen, type InboxFirstSeen } from "./inbox-first-seen";
import { createInboxLiveSessions } from "./inbox-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Live sessions over a temp store, on a clock the test moves. Noon, so "today" has room both ways. */
function liveSessions(options: { firstSeen?: InboxFirstSeen } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-agents-")));
  roots.push(root);
  const clock = { t: new Date(2026, 10, 9, 12, 0, 0).getTime() };
  const live = createInboxLiveSessions({ store: InboxStore.open(join(root, "data")), serverSession: "srv", resolveRoot: async (path) => path, now: () => clock.t, ...options });
  return { live, clock, root };
}

const poll = async (live: ReturnType<typeof liveSessions>["live"], session: string, fields: Record<string, unknown> = {}) => (await live.pollStarted(session, "claude-code", { project_path: "/work/ledger", ...fields }))();

function evidence(over: Partial<InboxAgentsEvidence> = {}): InboxAgentsEvidence {
  return {
    sessions: [],
    launches: [],
    waits: [],
    archived: new Set(),
    projectOf: (root) => (root ? { id: "prj_ledger", name: "ledger" } : null),
    projectById: (id) => ({ id, name: id === "prj_ledger" ? "ledger" : "other" }),
    lastHeardOf: () => null,
    continuedBy: () => null,
    continuesOf: () => [],
    labels: true,
    ...over,
  };
}

describe("who is listed, and how", () => {
  test("every live session: idle, or working while a turn runs, with its project and label", async () => {
    const { live, clock } = liveSessions();
    await poll(live, "ses-idle", { busy: false, label: "Fix login redirect" });
    await poll(live, "ses-busy", { busy: true });
    const group = inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxStartOfDay(clock.t)) }));
    expect(group.total).toBe(2);
    expect(group.agents.map((agent) => [agent.id, agent.state, agent.live])).toEqual([
      ["ses-busy", "working", true],
      ["ses-idle", "idle", true],
    ]);
    expect(group.agents[1]).toMatchObject({ host: "claude-code", label: "Fix login redirect", project: { id: "prj_ledger", name: "ledger" }, waiting: 0 });
  });

  test("a live session carries its model and effort from its latest poll; a bad value, an older connection or an ended session carries none", async () => {
    const { live, clock } = liveSessions();
    await poll(live, "ses-set", { model: "claude-opus-5-5", effort: "high" });
    await poll(live, "ses-odd", { model: "<b>opus</b>", effort: "turbo" });
    await poll(live, "ses-old");
    const facts = () => Object.fromEntries(inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxStartOfDay(clock.t)) })).agents.map((agent) => [agent.id, [agent.model, agent.effort]]));
    expect(facts()).toEqual({ "ses-set": ["claude-opus-5-5", "high"], "ses-odd": [undefined, undefined], "ses-old": [undefined, undefined] });
    await poll(live, "ses-set", { model: "claude-haiku-5-5" });
    expect(facts()["ses-set"]).toEqual(["claude-haiku-5-5", undefined]);
    clock.t += 60 * 60_000;
    await poll(live, "ses-other");
    expect(facts()["ses-set"]).toEqual([undefined, undefined]);
  });

  test("a live session carries its context window's fill from its latest poll; a bad figure, an older connection or an ended session carries none", async () => {
    const { live, clock } = liveSessions();
    await poll(live, "ses-full", { context: 63 });
    await poll(live, "ses-odd", { context: 140 });
    await poll(live, "ses-old");
    let agents = inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxStartOfDay(clock.t)) })).agents;
    expect(Object.fromEntries(agents.map((agent) => [agent.id, agent.context]))).toEqual({ "ses-full": 63, "ses-odd": undefined, "ses-old": undefined });
    await poll(live, "ses-full");
    agents = inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxStartOfDay(clock.t)) })).agents;
    expect(agents.find((agent) => agent.id === "ses-full")!.context).toBeUndefined();
    await poll(live, "ses-full", { context: 91 });
    clock.t += 60 * 60_000;
    await poll(live, "ses-other");
    agents = inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxStartOfDay(clock.t)) })).agents;
    expect(agents.find((agent) => agent.id === "ses-full")).toMatchObject({ state: "ended" });
    expect(agents.find((agent) => agent.id === "ses-full")!.context).toBeUndefined();
  });

  test("a session that ended today is listed as ended and counted; one last heard yesterday is not", async () => {
    const { live, clock } = liveSessions();
    clock.t -= 13 * 60 * 60_000; // Yesterday, 11 PM.
    await poll(live, "ses-yesterday");
    clock.t += 3 * 60 * 60_000; // Today, 2 AM.
    await poll(live, "ses-today");
    clock.t += 10 * 60 * 60_000; // Noon: both stopped polling long ago.
    await poll(live, "ses-live");
    const group = inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxStartOfDay(clock.t)) }));
    expect(group.agents.map((agent) => [agent.id, agent.state])).toEqual([
      ["ses-live", "idle"],
      ["ses-today", "ended"],
    ]);
    expect(group.ended_today).toBe(1);
    expect(group.agents[1]!.live).toBe(false);
  });

  test("the window's read keeps a week of ended sessions (the list's Agents view names their threads' agent); only today's count as ended today", async () => {
    const { live, clock } = liveSessions();
    const noon = clock.t;
    clock.t = noon - 6 * 24 * 60 * 60_000 - 11 * 60 * 60_000; // Six days ago, 1 AM: the first day kept.
    await poll(live, "ses-six-days");
    clock.t = noon - 7 * 24 * 60 * 60_000; // A week ago, noon: before the first day kept.
    await poll(live, "ses-a-week");
    clock.t = noon - 13 * 60 * 60_000; // Yesterday, 11 PM.
    await poll(live, "ses-yesterday");
    clock.t = noon - 10 * 60 * 60_000; // Today, 2 AM.
    await poll(live, "ses-today");
    clock.t = noon;
    await poll(live, "ses-live");
    const group = inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxAgentsEndedSince(clock.t)), today: inboxStartOfDay(clock.t) }));
    expect(group.agents.map((agent) => [agent.id, agent.state])).toEqual([
      ["ses-live", "idle"],
      ["ses-today", "ended"],
      ["ses-yesterday", "ended"],
      ["ses-six-days", "ended"],
    ]);
    expect(group.ended_today).toBe(1);
    expect(group.total).toBe(4);
  });

  test("a session that owns a thread waiting on the person stays listed, waiting with its count, ended or not", () => {
    const group = inboxAgentsGroup(
      evidence({
        sessions: [{ session: "ses-live", host: "codex", root: "/work/ledger", startedAt: 1, lastSeen: 2, live: true, busy: true, label: null }],
        waits: [
          { thread_id: "msg_1", session: "ses-live", host: "codex", project: { id: "prj_ledger", name: "ledger" }, at: "2026-11-09T10:00:00.000Z" },
          { thread_id: "msg_2", session: "ses-gone", host: "pi", project: { id: "prj_other", name: "other" }, at: "2026-11-02T09:00:00.000Z" },
          { thread_id: "msg_3", session: "ses-gone", host: "pi", project: { id: "prj_other", name: "other" }, at: "2026-11-03T09:00:00.000Z" },
        ],
      }),
    );
    expect(group.agents.map((agent) => [agent.id, agent.state, agent.waiting, agent.live])).toEqual([
      ["ses-gone", "waiting", 2, false],
      ["ses-live", "waiting", 1, true],
    ]);
    // Never heard in this run: when its latest waiting thread moved, where it waits.
    expect(group.agents[0]).toMatchObject({ host: "pi", project: { id: "prj_other", name: "other" }, started_at: null, last_seen_at: "2026-11-03T09:00:00.000Z" });
    expect(group.ended_today).toBe(0);
  });

  test("a launched agent is listed by its launch: working while it starts, idle once stopped, ended when its start failed; done with an archived thread", () => {
    const launch = (id: string, run: InboxAgentsEvidence["launches"][number]["run"], session = `launch:${id}`) => ({ launch_id: id, session, thread_id: `msg_${id}`, host: "claude-code", project_id: "prj_ledger", started_at: "2026-11-09T08:00:00.000Z", started: session !== `launch:${id}`, run, scratch: id === "lch_starting" ? "palette-helper" : null });
    const group = inboxAgentsGroup(
      evidence({
        sessions: [{ session: "ses-real", host: "claude-code", root: "/work/ledger", startedAt: 1, lastSeen: 2, live: false, busy: null, label: "Stopped one" }],
        launches: [launch("lch_starting", "starting"), launch("lch_stopped", "stopped", "ses-real"), launch("lch_failed", "failed"), launch("lch_archived", "stopped")],
        archived: new Set(["msg_lch_archived"]),
      }),
    );
    expect(group.agents.map((agent) => [agent.id, agent.state, agent.live]).sort()).toEqual([
      ["lch_failed", "ended", false],
      ["lch_starting", "working", true],
      ["lch_stopped", "idle", true],
    ]);
    const byId = (id: string) => group.agents.find((agent) => agent.id === id);
    // The session it runs as, its launch and thread, and what its session said of itself.
    expect(byId("lch_stopped")).toMatchObject({ session: "ses-real", launch: { id: "lch_stopped", thread_id: "msg_lch_stopped", started: true, run: "stopped", scratch: null }, label: "Stopped one" });
    expect(byId("lch_starting")).toMatchObject({ session: "launch:lch_starting", launch: { started: false, run: "starting", scratch: "palette-helper" }, project: { id: "prj_ledger", name: "ledger" } });
  });

  test("a launch the person stopped reads idle at once, though its session's last poll still said busy", () => {
    const launch = (id: string, run: InboxAgentsEvidence["launches"][number]["run"]) => ({ launch_id: id, session: `ses-${id}`, thread_id: `msg_${id}`, host: "claude-code", project_id: "prj_ledger", started_at: "2026-11-09T08:00:00.000Z", started: true, run, scratch: null });
    const busy = (session: string) => ({ session, host: "claude-code", root: "/work/ledger", startedAt: 1, lastSeen: 2, live: true, busy: true, label: null });
    const group = inboxAgentsGroup(evidence({ sessions: [busy("ses-lch_stopped"), busy("ses-lch_running")], launches: [launch("lch_stopped", "stopped"), launch("lch_running", null)] }));
    expect(group.agents.map((agent) => [agent.id, agent.state]).sort()).toEqual([
      ["lch_running", "working"],
      ["lch_stopped", "idle"],
    ]);
  });

  test("a routine is one agent, its newest run's; an earlier run's session only while it is live; other launches as before", () => {
    const run = (id: string, day: number, session: string, thread = "msg_digest") => ({ launch_id: id, session, thread_id: thread, host: "claude-code", project_id: "prj_ledger", started_at: `2026-11-0${day}T07:16:00.000Z`, started: true, run: "stopped" as const, scratch: null, scheduled: true });
    const ended = (session: string, live = false) => ({ session, host: "claude-code", root: "/work/ledger", startedAt: 1, lastSeen: 2, live, busy: null, label: null });
    const group = inboxAgentsGroup(
      evidence({
        sessions: [ended("ses-day1"), ended("ses-day2"), ended("ses-day3", true), ended("ses-plain")],
        launches: [
          run("lch_day1", 1, "ses-day1"),
          run("lch_day3", 3, "ses-day3", "msg_other"),
          run("lch_day2", 2, "ses-day2"),
          run("lch_day4", 4, "ses-day4"),
          { ...run("lch_plain_a", 1, "ses-plain", "msg_plain"), scheduled: false },
          { ...run("lch_plain_b", 2, "ses-plain-b", "msg_plain"), scheduled: false },
        ],
      }),
    );
    expect(group.agents.map((agent) => agent.id).sort()).toEqual(["lch_day3", "lch_day4", "lch_plain_a", "lch_plain_b"]);
    // An earlier run still going is listed by its session, with no launch row of its own.
    const still = inboxAgentsGroup(evidence({ sessions: [ended("ses-day1", true)], launches: [run("lch_day1", 1, "ses-day1"), run("lch_day2", 2, "ses-day2")] }));
    expect(still.agents.map((agent) => agent.id).sort()).toEqual(["lch_day2", "ses-day1"]);
  });

  test("labels only when asked", () => {
    const sessions = [{ session: "ses-a", host: "pi", root: null, startedAt: 1, lastSeen: 2, live: true, busy: false, label: "Secret plan" }];
    expect(inboxAgentsGroup(evidence({ sessions, labels: false })).agents[0]!.label).toBeUndefined();
    const owned = [inboxAgentsGroup(evidence({ sessions }))];
    expect(owned[0]!.agents[0]!.label).toBe("Secret plan");
  });
});

describe("a fixed order: each agent stays where it first appeared, the newest first", () => {
  const listedNow = (live: ReturnType<typeof liveSessions>["live"], clock: { t: number }, over: Partial<InboxAgentsEvidence> = {}) =>
    inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxStartOfDay(clock.t)), lastHeardOf: live.lastHeardOf, continuedBy: live.continuedBy, continuesOf: live.continuesOf, ...over }));
  const ids = (group: InboxAgentsGroup) => group.agents.map((agent) => agent.id);
  const waitOn = (session: string) => ({ thread_id: `msg_${session}`, session, host: "claude-code", project: { id: "prj_ledger", name: "ledger" }, at: "2026-11-09T11:00:00.000Z" });

  test("never re-sorted by a turn starting or ending, a poll, a list read, a label, a thread waiting on the person or a session ending", async () => {
    const { live, clock } = liveSessions();
    // Started a minute apart, all polling now.
    for (const [i, session] of ["ses-a", "ses-b", "ses-c", "ses-d"].entries()) await poll(live, session, { busy: false, started_at: clock.t - (4 - i) * 60_000 });
    const order = ["ses-d", "ses-c", "ses-b", "ses-a"];
    expect(ids(listedNow(live, clock))).toEqual(order);
    live.stateChanged("ses-a", "claude-code", { busy: true });
    expect(ids(listedNow(live, clock))).toEqual(order);
    clock.t += 7_000;
    await poll(live, "ses-b", { busy: false });
    expect(ids(listedNow(live, clock))).toEqual(order);
    live.stateChanged("ses-a", "claude-code", { busy: false });
    await poll(live, "ses-a", { busy: false, label: "Renamed in Claude Code", title: "Its own title" });
    expect(ids(listedNow(live, clock))).toEqual(order);
    // Read again and again: the same order every time.
    expect(ids(listedNow(live, clock))).toEqual(order);
    const waiting = listedNow(live, clock, { waits: [waitOn("ses-b")] });
    expect(waiting.agents.map((agent) => [agent.id, agent.state])).toEqual([
      ["ses-d", "idle"],
      ["ses-c", "idle"],
      ["ses-b", "waiting"],
      ["ses-a", "idle"],
    ]);
    // ses-c stops polling and ends: it stays in its place for today; the others keep theirs.
    clock.t += 20_000;
    for (const session of ["ses-a", "ses-b", "ses-d"]) await poll(live, session, { busy: false });
    clock.t += 20_000;
    for (const session of ["ses-a", "ses-b", "ses-d"]) await poll(live, session, { busy: false });
    const later = listedNow(live, clock, { waits: [waitOn("ses-b")] });
    expect(later.agents.map((agent) => [agent.id, agent.state])).toEqual([
      ["ses-d", "idle"],
      ["ses-c", "ended"],
      ["ses-b", "waiting"],
      ["ses-a", "idle"],
    ]);
  });

  test("a new agent appears first; a plugin reload (its connection starting again, later) never moves one; ties go by session id", async () => {
    const { live, clock } = liveSessions();
    const t0 = clock.t;
    await poll(live, "ses-b", { busy: false, started_at: t0 });
    await poll(live, "ses-a", { busy: false, started_at: t0 });
    expect(ids(listedNow(live, clock))).toEqual(["ses-a", "ses-b"]);
    clock.t += 5 * 60_000;
    await poll(live, "ses-new", { busy: true, started_at: clock.t });
    expect(ids(listedNow(live, clock))).toEqual(["ses-new", "ses-a", "ses-b"]);
    clock.t += 60_000;
    // ses-b's module reloaded: its connection says a later start. It keeps its place.
    await poll(live, "ses-b", { busy: false, started_at: clock.t });
    expect(ids(listedNow(live, clock))).toEqual(["ses-new", "ses-a", "ses-b"]);
  });

  test("a linked machine's group comes in its machine's own fixed order, whatever happens there", async () => {
    const here = liveSessions();
    const far = liveSessions();
    await poll(here.live, "ses-here", { busy: false });
    for (const session of ["ses-m1", "ses-m2", "ses-m3"]) {
      await poll(far.live, session, { busy: false });
      far.clock.t += 60_000;
    }
    const merged = () => inboxMergedAgents("ibx_self", listedNow(here.live, here.clock), [inboxPeerAgentsGroup([listedNow(far.live, far.clock)], "ibx_far")!]);
    const before = merged().map((group) => [group.machine, ids(group)]);
    expect(before).toEqual([
      ["ibx_self", ["ses-here"]],
      ["ibx_far", ["ses-m3", "ses-m2", "ses-m1"]],
    ]);
    far.live.stateChanged("ses-m1", "claude-code", { busy: true });
    await poll(far.live, "ses-m2", { busy: false, label: "Named there" });
    expect(merged().map((group) => [group.machine, ids(group)])).toEqual(before);
  });

  test("an Inbox restart places a session by the first message it wrote, not by when its connection came back", () => {
    const { store, project } = storeWith();
    store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses-old", name: null }, thread: "early", subject: "Early work", body: "Started" });
    const sessions = [
      { session: "ses-old", host: "claude-code", root: "/work/ledger", startedAt: Date.parse("2026-11-09T12:00:00.000Z"), firstSeen: Date.parse("2026-11-09T12:00:00.000Z"), lastSeen: 1, live: true, busy: false, label: null, title: null },
      { session: "ses-mid", host: "claude-code", root: "/work/ledger", startedAt: Date.parse("2026-11-09T10:00:00.000Z"), firstSeen: Date.parse("2026-11-09T10:00:00.000Z"), lastSeen: 1, live: true, busy: false, label: null, title: null },
    ];
    expect(ids(inboxAgentsGroup(evidence({ sessions, ...fromStore(store) })))).toEqual(["ses-mid", "ses-old"]);
  });

  test("a plugin reload and then an Inbox restart (both on every release) move nothing: the first start is kept on disk, and the connection keeps its own", async () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 9, h, m).getTime();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-first-seen-")));
    roots.push(dir);
    const withFile = () => {
      const kept = createInboxFirstSeen(dir);
      const { live, clock, root } = liveSessions({ firstSeen: kept });
      return { live, clock, root, kept };
    };
    const before = withFile();
    // A connected at 9:00, B at 9:30; C and D (that never wrote anything) at 9:00 and 9:30.
    for (const [session, start] of [["ses-a", at(9)], ["ses-b", at(9, 30)], ["ses-c", at(9)], ["ses-d", at(9, 30)]] as const) await poll(before.live, session, { busy: false, started_at: start });
    const order = ["ses-b", "ses-d", "ses-a", "ses-c"];
    expect(ids(listedNow(before.live, before.clock, { kept: before.kept }))).toEqual(order);
    // All four reload at 11:00, D's and C's finishing in the other order.
    for (const [session, start] of [["ses-a", at(11)], ["ses-b", at(11, 1)], ["ses-d", at(11, 2)], ["ses-c", at(11, 3)]] as const) await poll(before.live, session, { busy: false, started_at: start });
    expect(ids(listedNow(before.live, before.clock, { kept: before.kept }))).toEqual(order);
    await Promise.resolve();
    // The Inbox restarts: a new process reads the same folder; the connections say only their reloaded starts.
    const after = withFile();
    for (const [session, start] of [["ses-a", at(11)], ["ses-b", at(11, 1)], ["ses-d", at(11, 2)], ["ses-c", at(11, 3)]] as const) await poll(after.live, session, { busy: false, started_at: start });
    expect(ids(listedNow(after.live, after.clock, { kept: after.kept }))).toEqual(order);
    // A fresh data folder: the first start each connection kept (`first_started_at`) places it.
    const fresh = liveSessions();
    for (const [session, start, first] of [["ses-a", at(11), at(9)], ["ses-b", at(11, 1), at(9, 30)], ["ses-d", at(11, 2), at(9, 30)], ["ses-c", at(11, 3), at(9)]] as const) await poll(fresh.live, session, { busy: false, started_at: start, first_started_at: first });
    expect(ids(listedNow(fresh.live, fresh.clock))).toEqual(order);
  });

  test("a conversation resumed under a new id keeps the place its old id had, across an Inbox restart too", async () => {
    const at = (h: number) => new Date(2026, 10, 9, h).getTime();
    const kept = createInboxFirstSeen(null);
    const { live, clock } = liveSessions({ firstSeen: kept });
    await poll(live, "ses-old", { busy: false, started_at: at(9) });
    await poll(live, "ses-b", { busy: false, started_at: at(10) });
    expect(ids(listedNow(live, clock, { kept }))).toEqual(["ses-b", "ses-old"]);
    // ses-old stops; its conversation goes on as ses-new, started at 11:00.
    for (const _ of [1, 2]) {
      clock.t += 20_000;
      await poll(live, "ses-b", { busy: false });
    }
    await poll(live, "ses-new", { busy: false, started_at: at(11), continues: ["ses-old"] });
    expect(ids(listedNow(live, clock, { kept }))).toEqual(["ses-b", "ses-new"]);
    // After a restart the old id is no live session at all: what was kept for it still places the new one.
    const restarted = liveSessions({ firstSeen: kept });
    await poll(restarted.live, "ses-b", { busy: false, started_at: at(10) });
    await poll(restarted.live, "ses-new", { busy: false, started_at: at(11), continues: ["ses-old"] });
    expect(ids(listedNow(restarted.live, restarted.clock, { kept }))).toEqual(["ses-b", "ses-new"]);
  });
});

/** A temp store with one project, on a clock the test moves (the first message at 9 AM). */
function storeWith() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-agents-store-")));
  roots.push(root);
  const clock = { now: Date.parse("2026-11-09T09:00:00.000Z") };
  const store = InboxStore.open(join(root, "data"), { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  return { store, project, clock };
}

/** The store's evidence, as the Inbox gives it (packages/server/inbox.ts `agentsOf`). */
function fromStore(store: InboxStore): Pick<InboxAgentsEvidence, "firstThreadOf" | "threadNameOf"> {
  return {
    firstThreadOf: (sessions) => {
      const firsts = store.firstThreadsBySession();
      const found = sessions.flatMap((session) => {
        const got = firsts.get(session);
        return got ? [got] : [];
      });
      return found.sort((a, b) => a.at.localeCompare(b.at))[0] ?? null;
    },
    threadNameOf: (id) => store.threadShortName(id) ?? store.threadSubject(id),
  };
}

describe("names the list gives the window: the host's title, and the thread each agent got first", () => {
  const agentAuthor = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: null });
  const liveOne = (session: string, over: Record<string, unknown> = {}) => ({ session, host: "claude-code", root: "/work/ledger", startedAt: 1, firstSeen: 1, lastSeen: 2, live: true, busy: false, label: null, title: null, ...over });

  test("the host's own title rides along with the label, both only when labels are shown", () => {
    const sessions = [liveOne("ses-a", { title: "Retry backoff for invoices" })];
    expect(inboxAgentsGroup(evidence({ sessions })).agents[0]).toMatchObject({ title: "Retry backoff for invoices" });
    expect(inboxAgentsGroup(evidence({ sessions, labels: false })).agents[0]!.title).toBeUndefined();
  });

  test("the first thread stays the agent's first thread when it writes in newer threads, waits on the person in another, or that one is archived", () => {
    const { store, project, clock } = storeWith();
    const first = store.sendMessage({ project_id: project.id, author: agentAuthor("ses-a"), subject: "Invoice retries", body: "Looking" }).message;
    const firstOf = () => inboxAgentsGroup(evidence({ sessions: [liveOne("ses-a")], ...fromStore(store) })).agents[0]!.first_thread;
    expect(firstOf()).toEqual({ id: first.thread_id, name: "Invoice retries" });
    clock.now += 60_000;
    const second = store.sendMessage({ project_id: project.id, author: agentAuthor("ses-a"), subject: "Semantic diffs", body: "Which way?" }).message;
    clock.now += 60_000;
    store.sendMessage({ project_id: project.id, author: agentAuthor("ses-a"), subject: "Release notes", body: "Drafted" });
    const waits = [{ thread_id: second.thread_id, session: "ses-a", host: "claude-code", project: { id: project.id, name: "ledger" }, at: new Date(clock.now).toISOString() }];
    expect(inboxAgentsGroup(evidence({ sessions: [liveOne("ses-a")], waits, ...fromStore(store) })).agents[0]!.first_thread).toEqual({ id: first.thread_id, name: "Invoice retries" });
    store.resolveThread(first.thread_id, true, "person");
    expect(firstOf()).toEqual({ id: first.thread_id, name: "Invoice retries" });
  });

  test("a thread the person started with a session is its first; a launched agent's first is its launch's thread; a continued conversation keeps the old id's", () => {
    const { store, project, clock } = storeWith();
    const opened = store.startPersonThread({ project_id: project.id, body: "Can you look?", to: { host: "pi", session: "ses-pi" }, idempotency_key: "k1", thread_name: "Queue timeouts" }).message;
    clock.now += 60_000;
    store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "pi", session: "ses-pi", name: null }, subject: "Something else", body: "Also" });
    store.sendMessage({ project_id: project.id, author: agentAuthor("ses-old"), subject: "Ledger sync", body: "Began" });
    const launches = [{ launch_id: "lch_1", session: "launch:lch_1", thread_id: opened.thread_id, host: "claude-code", project_id: project.id, started_at: "2026-11-09T09:30:00.000Z", started: false, run: "starting" as const, scratch: null }];
    const group = inboxAgentsGroup(evidence({ sessions: [liveOne("ses-pi"), liveOne("ses-new")], launches, continuesOf: (s) => (s === "ses-new" ? ["ses-old"] : []), ...fromStore(store) }));
    const byId = (id: string) => group.agents.find((agent) => agent.id === id)!;
    expect(byId("ses-pi").first_thread).toEqual({ id: opened.thread_id, name: "Queue timeouts" });
    expect(byId("lch_1").first_thread).toEqual({ id: opened.thread_id, name: "Queue timeouts" });
    expect(byId("ses-new").first_thread?.name).toBe("Ledger sync");
  });

  test("the first thread's name is kept as it first read: renaming or deleting that thread later neither renames the row nor moves it", () => {
    const { store, project, clock } = storeWith();
    const kept = createInboxFirstSeen(null);
    const first = store.sendMessage({ project_id: project.id, author: agentAuthor("ses-a"), subject: "Invoice retries", body: "Looking" }).message;
    clock.now += 60_000;
    store.sendMessage({ project_id: project.id, author: agentAuthor("ses-a"), subject: "Semantic diffs", body: "Next" });
    store.sendMessage({ project_id: project.id, author: agentAuthor("ses-b"), subject: "Ledger sync", body: "Began" });
    // Both connections came back at noon (an Inbox restart): their first messages place them.
    const noon = Date.parse("2026-11-09T12:00:00.000Z");
    const quiet = (session: string) => liveOne(session, { startedAt: noon, firstSeen: noon, lastSeen: noon });
    const listed = (over: Partial<InboxAgentsEvidence> = {}) => inboxAgentsGroup(evidence({ sessions: [quiet("ses-a"), quiet("ses-b")], ...fromStore(store), kept, ...over }));
    const rows = (group: InboxAgentsGroup) => group.agents.map((agent) => [agent.id, agent.first_thread?.name]);
    const before = [
      ["ses-b", "Ledger sync"],
      ["ses-a", "Invoice retries"],
    ];
    expect(rows(listed())).toEqual(before);
    // The thread renamed: the name the list reads for it changes; the row's does not.
    expect(rows(listed({ threadNameOf: () => "Renamed later", firstThreadOf: (sessions) => (sessions[0] === "ses-a" ? { id: first.thread_id, name: "Renamed later", at: first.created_at } : fromStore(store).firstThreadOf!(sessions)) }))).toEqual(before);
    // Deleted: the store's first thread for ses-a is now "Semantic diffs", a minute later; ses-a keeps its name and place.
    store.deleteThread(first.thread_id);
    expect(fromStore(store).firstThreadOf!(["ses-a"])?.name).toBe("Semantic diffs");
    expect(rows(listed())).toEqual(before);
  });
});

describe("one conversation under two session ids (a poll's `continues`) is one agent", () => {
  /** The list as the Inbox builds it from the live sessions. */
  const listed = (live: ReturnType<typeof liveSessions>["live"], clock: { t: number }, over: Partial<InboxAgentsEvidence> = {}) =>
    inboxAgentsGroup(evidence({ sessions: live.agentSessions(inboxStartOfDay(clock.t)), lastHeardOf: live.lastHeardOf, continuedBy: live.continuedBy, continuesOf: live.continuesOf, ...over }));
  const wait = (session: string, thread = "msg_asked") => ({ thread_id: thread, session, host: "claude-code", project: { id: "prj_ledger", name: "ledger" }, at: "2026-11-09T10:00:00.000Z" });
  /** `ses-old` polled and stopped; `ses-new` polls and says it continues it. */
  const handedOver = async () => {
    const made = liveSessions();
    await poll(made.live, "ses-old", { busy: false, label: "Ledger work" });
    made.clock.t += 31_000;
    await poll(made.live, "ses-new", { busy: false, label: "Ledger work", continues: ["ses-old"] });
    return made;
  };

  test("the old id is not listed beside the session that continues it, nor counted as ended today", async () => {
    const { live, clock } = await handedOver();
    const group = listed(live, clock);
    expect(group.agents.map((agent) => [agent.id, agent.state, agent.continues])).toEqual([["ses-new", "idle", ["ses-old"]]]);
    expect(group).toMatchObject({ total: 1, ended_today: 0 });
  });

  test("a thread that waits on the old id waits on the one agent, not on a second row", async () => {
    const { live, clock } = await handedOver();
    const group = listed(live, clock, { waits: [wait("ses-old"), wait("ses-new", "msg_second")] });
    expect(group.agents.map((agent) => [agent.id, agent.session, agent.state, agent.waiting, agent.live])).toEqual([["ses-new", "ses-new", "waiting", 2, true]]);
  });

  test("a launched session that got a new id is still its launch's one agent, running as the new id", async () => {
    const { live, clock } = await handedOver();
    const launches = [{ launch_id: "lch_1", session: "ses-old", thread_id: "msg_launch", host: "claude-code", project_id: "prj_ledger", started_at: "2026-11-09T08:00:00.000Z", started: true, run: "stopped" as const, scratch: null }];
    const group = listed(live, clock, { launches, waits: [wait("ses-old", "msg_launch")] });
    expect(group.agents.map((agent) => [agent.id, agent.session, agent.launch?.thread_id, agent.waiting, agent.live])).toEqual([["lch_1", "ses-new", "msg_launch", 1, true]]);
    expect(group.total).toBe(1);
  });

  test("once the continuing session stops, the old id's waiting thread is listed under the old id again", async () => {
    const { live, clock } = await handedOver();
    clock.t += 31_000;
    const group = listed(live, clock, { waits: [wait("ses-old")] });
    expect(group.agents.filter((agent) => agent.state !== "ended").map((agent) => [agent.id, agent.state])).toEqual([["ses-old", "waiting"]]);
  });

  test("a line of three (A to B to C): only the session at its live end is listed, with every waiting thread of the line", async () => {
    const { live, clock } = liveSessions();
    await poll(live, "ses-a", { busy: false });
    await poll(live, "ses-b", { busy: false, continues: ["ses-a"] });
    clock.t += 31_000;
    await poll(live, "ses-c", { busy: false, continues: ["ses-b", "ses-a"] });
    const group = listed(live, clock, { waits: [wait("ses-a", "msg_a"), wait("ses-b", "msg_b")] });
    expect(group.agents.map((agent) => [agent.id, agent.state, agent.waiting, agent.continues])).toEqual([["ses-c", "waiting", 2, ["ses-b", "ses-a"]]]);
    expect(group.total).toBe(1);
  });

  test("an old id that still polls keeps its own row, and the continuing one names it; the windows are told when the claim arrives", async () => {
    const { live, clock } = liveSessions();
    await poll(live, "ses-old", { busy: false });
    await poll(live, "ses-new", { busy: false });
    const before = live.agentsSignature(inboxStartOfDay(clock.t));
    await poll(live, "ses-new", { busy: false, continues: "ses-old" });
    expect(live.agentsSignature(inboxStartOfDay(clock.t))).not.toBe(before);
    const group = listed(live, clock);
    expect(group.agents.map((agent) => [agent.id, agent.continues]).sort()).toEqual([["ses-new", ["ses-old"]], ["ses-old", undefined]]);
  });

  test("two sessions in one folder that continue nothing stay two agents", async () => {
    const { live, clock } = liveSessions();
    await poll(live, "ses-one", { busy: false });
    await poll(live, "ses-two", { busy: false });
    expect(listed(live, clock).total).toBe(2);
  });
});

describe("the cap", () => {
  test("200 sessions list at most the cap; the oldest waiting one stays, in its fixed place; the newest live ones fill the rest; the counts name them all", () => {
    const sessions = Array.from({ length: 200 }, (_, i) => ({ session: `ses-${String(i).padStart(3, "0")}`, host: "claude-code", root: "/work/ledger", startedAt: i, firstSeen: i, lastSeen: 1000 + i, live: i % 4 !== 0, busy: i % 2 === 1, label: null, title: null }));
    const waits = [{ thread_id: "msg_w", session: "ses-000", host: "claude-code", project: { id: "prj_ledger", name: "ledger" }, at: "2026-11-09T10:00:00.000Z" }];
    const group = inboxAgentsGroup(evidence({ sessions, waits }));
    expect(group.agents.length).toBe(INBOX_AGENTS_LISTED_MAX);
    expect(group.total).toBe(200);
    expect(group.ended_today).toBe(49);
    // The first seen, it is last; nothing ended is kept while live ones are past the cap.
    expect(group.agents.at(-1)).toMatchObject({ id: "ses-000", state: "waiting" });
    expect(group.agents.slice(0, -1).every((agent) => agent.live)).toBe(true);
    expect(group.agents[0]!.id).toBe("ses-199");
    const seen = group.agents.map((agent) => Number(agent.id.slice(4)));
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  test("past the cap with more waiting agents than room: the newest waiting ones, in the fixed order", () => {
    const sessions = Array.from({ length: 6 }, (_, i) => ({ session: `ses-${i}`, host: "pi", root: null, startedAt: i, firstSeen: i, lastSeen: 50, live: true, busy: false, label: null, title: null }));
    const waits = [1, 2, 4].map((i) => ({ thread_id: `msg_${i}`, session: `ses-${i}`, host: "pi", project: { id: "prj_ledger", name: "ledger" }, at: "2026-11-09T10:00:00.000Z" }));
    expect(inboxAgentsGroup(evidence({ sessions, waits }), 2).agents.map((agent) => agent.id)).toEqual(["ses-4", "ses-2"]);
    expect(inboxAgentsGroup(evidence({ sessions, waits }), 4).agents.map((agent) => agent.id)).toEqual(["ses-5", "ses-4", "ses-2", "ses-1"]);
  });

  test("none: an empty group, so the window can tell no agents from an Inbox that names none", () => {
    expect(inboxAgentsGroup(evidence())).toEqual({ agents: [], total: 0, ended_today: 0 });
  });
});

describe("linked machines", () => {
  test("another machine's agent keeps its model, effort and context; a value a poll here would refuse is dropped", () => {
    const base = { host: "claude-code", project: null, state: "idle", waiting: 0, live: true, started_at: null, last_seen_at: null };
    const far = inboxPeerAgentsGroup([{ agents: [
      { ...base, id: "ses-set", session: "ses-set", model: "claude-opus-5-5", effort: "high", context: 63 },
      { ...base, id: "ses-odd", session: "ses-odd", model: "<b>opus</b>", effort: "turbo", context: 140 },
    ], total: 2, ended_today: 0 }], "ibx_far")!;
    expect(far.agents.map((agent) => [agent.id, agent.model, agent.effort, agent.context])).toEqual([
      ["ses-set", "claude-opus-5-5", "high", 63],
      ["ses-odd", undefined, undefined, undefined],
    ]);
  });

  test("the merged view: this Inbox's group first, named by its id, then each machine's from its list, named and capped", () => {
    const own = inboxAgentsGroup(evidence({ sessions: [{ session: "ses-here", host: "pi", root: null, startedAt: 1, lastSeen: 2, live: true, busy: false, label: null }] }));
    const farAgents = Array.from({ length: 100 }, (_, i) => ({ id: `ses-${i}`, session: `ses-${i}`, host: "codex", project: null, state: "idle", waiting: 0, live: true, started_at: null, last_seen_at: null }));
    const far = inboxPeerAgentsGroup([{ agents: farAgents, total: 100, ended_today: 0 }], "ibx_far")!;
    const merged = inboxMergedAgents("ibx_self", own, [far]);
    expect(merged.map((group) => [group.machine, group.agents.length, group.total])).toEqual([
      ["ibx_self", 1, 1],
      ["ibx_far", INBOX_AGENTS_LISTED_MAX, 100],
    ]);
  });

  test("another machine's group keeps only what parses; an older Inbox's list names none", () => {
    expect(inboxPeerAgentsGroup(undefined, "ibx_far")).toBeNull();
    expect(inboxPeerAgentsGroup([{ nope: true }], "ibx_far")).toBeNull();
    const group = inboxPeerAgentsGroup([{ agents: [{ id: "a", session: "a", state: "idle" }, { id: "b", state: "idle" }, null, { id: "c", session: "c", state: "dancing" }], total: -1 }], "ibx_far") as InboxAgentsGroup;
    expect(group.agents.map((agent) => agent.id)).toEqual(["a"]);
    expect(group).toMatchObject({ machine: "ibx_far", total: 1, ended_today: 0 });
  });

  test("another machine's agent keeps where it lives in that machine's Rex, its pane's status and mark, and Show in Rex only as that machine offers it", () => {
    const sent = { id: "a", session: "a", state: "waiting", place: { kind: "rex", line: "Rex · x / y", show: true }, rex_status: { state: "blocked", kind: "auth" }, rex_mark: { state: "blocked", kind: "auth" } };
    const [agent] = inboxPeerAgentsGroup([{ agents: [sent] }], "ibx_far")!.agents;
    expect(agent).toMatchObject({ id: "a", state: "waiting", place: { kind: "rex", line: "Rex · x / y", show: true }, rex_status: { state: "blocked", kind: "auth" }, rex_mark: { state: "blocked", kind: "auth" } });
    // It offered none (no Rex app attached to its Rex from elsewhere, or an older Inbox there): none here; nothing but `true` is an offer.
    for (const place of [{ kind: "rex", line: "Rex · x / y" }, { kind: "rex", line: "Rex · x / y", show: "yes" }]) {
      expect(inboxPeerAgentsGroup([{ agents: [{ ...sent, place }] }], "ibx_far")!.agents[0]!.place).toEqual({ kind: "rex", line: "Rex · x / y" });
    }
    // A malformed one is dropped, as any field that does not parse.
    const [odd] = inboxPeerAgentsGroup([{ agents: [{ ...sent, place: { kind: "elsewhere", line: 3 }, rex_mark: { state: "dancing" } }] }], "ibx_far")!.agents;
    expect([odd!.place, odd!.rex_mark]).toEqual([undefined, undefined]);
  });

  test("a machine keeps a tile choice only when its list says so: an older Inbox's group never claims it", () => {
    const agents = [{ id: "a", session: "a", state: "idle" }];
    expect(inboxPeerAgentsGroup([{ agents, faces: {}, faces_rev: 1, face_tiles: true }], "ibx_new")!.face_tiles).toBe(true);
    // 0.28.66 sends faces and no `face_tiles`; anything but `true` is not a claim.
    expect(inboxPeerAgentsGroup([{ agents, faces: {}, faces_rev: 1 }], "ibx_old")!.face_tiles).toBeUndefined();
    expect(inboxPeerAgentsGroup([{ agents, faces: {}, faces_rev: 1, face_tiles: "yes" }], "ibx_odd")!.face_tiles).toBeUndefined();
  });

  test("another machine's agent with a name that is not text keeps its row, without that name", () => {
    const sent = [{ agents: [{ id: "a", session: "a", state: "idle", label: 7, title: { x: 1 }, first_thread: { id: "thr_1", name: null } }, { id: "b", session: "b", state: "idle", label: "Kept", title: "Also kept", first_thread: { id: "thr_2", name: "Ledger sync" } }] }];
    const group = inboxPeerAgentsGroup(sent, "ibx_far") as InboxAgentsGroup;
    expect(group.agents.map((agent) => [agent.id, agent.label, agent.title, agent.first_thread])).toEqual([
      ["a", undefined, undefined, undefined],
      ["b", "Kept", "Also kept", { id: "thr_2", name: "Ledger sync" }],
    ]);
  });
});

describe("what tells the windows (`event: deliveries`' `agents`)", () => {
  test("moves when a session starts, a turn starts or ends, or it ends; never for a poll that changes nothing, nor a label (`labels` tells the owner's windows)", async () => {
    const { live, clock } = liveSessions();
    const since = () => inboxStartOfDay(clock.t);
    const seen = [live.agentsSignature(since())];
    const moved = () => {
      const next = live.agentsSignature(since());
      const changed = next !== seen.at(-1);
      seen.push(next);
      return changed;
    };
    await poll(live, "ses-a", { busy: false });
    expect(moved()).toBe(true);
    clock.t += 5_000;
    await poll(live, "ses-a", { busy: false });
    expect(moved()).toBe(false);
    live.stateChanged("ses-a", "claude-code", { busy: true });
    expect(moved()).toBe(true);
    live.stateChanged("ses-a", "claude-code", { busy: false });
    expect(moved()).toBe(true);
    await poll(live, "ses-a", { busy: false, label: "Renamed" });
    expect(moved()).toBe(false);
    await poll(live, "ses-a", { busy: false, label: "Renamed", model: "claude-opus-5-5", effort: "high" });
    expect(moved()).toBe(true);
    await poll(live, "ses-a", { busy: false, label: "Renamed", model: "claude-opus-5-5", effort: "max" });
    expect(moved()).toBe(true);
    await poll(live, "ses-a", { busy: false, label: "Renamed", model: "claude-opus-5-5", effort: "max" });
    expect(moved()).toBe(false);
    await poll(live, "ses-a", { busy: false, label: "Renamed", model: "claude-opus-5-5", effort: "max", context: 61 });
    expect(moved()).toBe(true);
    await poll(live, "ses-a", { busy: false, label: "Renamed", model: "claude-opus-5-5", effort: "max", context: 63 });
    expect(moved()).toBe(false);
    await poll(live, "ses-a", { busy: false, label: "Renamed", model: "claude-opus-5-5", effort: "max", context: 66 });
    expect(moved()).toBe(true);
    clock.t += 31_000; // Past the live window: it ended.
    expect(moved()).toBe(true);
    expect(live.agentSessions(since()).map((entry) => [entry.session, entry.live])).toEqual([["ses-a", false]]);
  });
});
