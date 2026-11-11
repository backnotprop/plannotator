/**
 * Each machine's agents for the sidebar's Agents section (inbox-agents-list.ts). The failures this catches: a live
 * session missing or in the wrong state, a session that still owns a thread waiting on the person dropped because it
 * ended, a session that ended yesterday still listed (or one that ended today dropped), a launched agent that is only
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
import { inboxAgentsGroup, inboxAgentsWithoutLabels, inboxMergedAgents, inboxPeerAgentsGroup, inboxStartOfDay, type InboxAgentsEvidence } from "./inbox-agents-list";
import { createInboxLiveSessions } from "./inbox-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Live sessions over a temp store, on a clock the test moves. Noon, so "today" has room both ways. */
function liveSessions() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-agents-")));
  roots.push(root);
  const clock = { t: new Date(2026, 10, 9, 12, 0, 0).getTime() };
  const live = createInboxLiveSessions({ store: InboxStore.open(join(root, "data")), serverSession: "srv", resolveRoot: async (path) => path, now: () => clock.t });
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
    const launch = (id: string, run: InboxAgentsEvidence["launches"][number]["run"], session = `launch:${id}`) => ({ launch_id: id, session, thread_id: `msg_${id}`, host: "claude-code", project_id: "prj_ledger", started_at: "2026-11-09T08:00:00.000Z", run });
    const group = inboxAgentsGroup(
      evidence({
        sessions: [{ session: "ses-real", host: "claude-code", root: "/work/ledger", startedAt: 1, lastSeen: 2, live: false, busy: null, label: "Stopped one" }],
        launches: [launch("lch_starting", "starting"), launch("lch_stopped", "stopped", "ses-real"), launch("lch_failed", "failed"), launch("lch_archived", "stopped")],
        archived: new Set(["msg_lch_archived"]),
      }),
    );
    expect(group.agents.map((agent) => [agent.id, agent.state, agent.live])).toEqual([
      ["lch_starting", "working", true],
      ["lch_stopped", "idle", true],
      ["lch_failed", "ended", false],
    ]);
    // The session it runs as, its launch and thread, and what its session said of itself.
    expect(group.agents[1]).toMatchObject({ session: "ses-real", launch: { id: "lch_stopped", thread_id: "msg_lch_stopped" }, label: "Stopped one" });
    expect(group.agents[0]).toMatchObject({ session: "launch:lch_starting", project: { id: "prj_ledger", name: "ledger" } });
  });

  test("labels only for this computer's owner", () => {
    const sessions = [{ session: "ses-a", host: "pi", root: null, startedAt: 1, lastSeen: 2, live: true, busy: false, label: "Secret plan" }];
    expect(inboxAgentsGroup(evidence({ sessions, labels: false })).agents[0]!.label).toBeUndefined();
    const owned = [inboxAgentsGroup(evidence({ sessions }))];
    expect(owned[0]!.agents[0]!.label).toBe("Secret plan");
    expect(inboxAgentsWithoutLabels(owned)[0]!.agents[0]!.label).toBeUndefined();
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
    const launches = [{ launch_id: "lch_1", session: "ses-old", thread_id: "msg_launch", host: "claude-code", project_id: "prj_ledger", started_at: "2026-11-09T08:00:00.000Z", run: "stopped" as const }];
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
  test("200 sessions list at most the cap, the waiting ones first, and the counts name them all", () => {
    const sessions = Array.from({ length: 200 }, (_, i) => ({ session: `ses-${String(i).padStart(3, "0")}`, host: "claude-code", root: "/work/ledger", startedAt: i, lastSeen: 1000 + i, live: i % 4 !== 0, busy: i % 2 === 1, label: null }));
    const waits = [{ thread_id: "msg_w", session: "ses-000", host: "claude-code", project: { id: "prj_ledger", name: "ledger" }, at: "2026-11-09T10:00:00.000Z" }];
    const group = inboxAgentsGroup(evidence({ sessions, waits }));
    expect(group.agents.length).toBe(INBOX_AGENTS_LISTED_MAX);
    expect(group.total).toBe(200);
    expect(group.ended_today).toBe(49);
    expect(group.agents[0]).toMatchObject({ id: "ses-000", state: "waiting" });
    expect(group.agents[1]!.state).toBe("working");
    // Within a state, the most recently heard first.
    expect(group.agents[1]!.id).toBe("ses-199");
  });

  test("none: an empty group, so the window can tell no agents from an Inbox that names none", () => {
    expect(inboxAgentsGroup(evidence())).toEqual({ agents: [], total: 0, ended_today: 0 });
  });
});

describe("linked machines", () => {
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
    clock.t += 31_000; // Past the live window: it ended.
    expect(moved()).toBe(true);
    expect(live.agentSessions(since()).map((entry) => [entry.session, entry.live])).toEqual([["ses-a", false]]);
  });
});
