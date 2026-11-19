/**
 * The status mark for every agent (inbox-agent-mark.ts, through the agents list inbox-agents-list.ts), and what it
 * must never claim (the owner's truth rules, 2026-11-18). The failures these guard:
 *  - a host that reports nothing about turns (`busy` null: Codex, Qwen Code, T3 Code, Antigravity) drawn working or
 *    idle, or its row still read as idle (`turns_unknown` missing);
 *  - any idle mark at all (owner ruling, 2026-11-18: working, asking and done are the approved marks; at rest draws
 *    nothing), a stopped launch included;
 *  - a thread waiting on the person not drawn "waiting on you here", or a terminal prompt not winning over it;
 *  - a terminal prompt drawn for a session the Inbox launched (its own launch shows that prompt here);
 *  - an ended agent, or one that ended only because its host went quiet, carrying any mark; `done` ever claimed;
 *  - a fresh Rex record not winning over the Inbox's own mark (one mark per agent), or Rex's word leaving
 *    `turns_unknown` on an agent whose pane reports its turns;
 *  - another machine's mark taken as sent when it is not one this Inbox knows, or free text riding along.
 * Pure: hand-made sessions, no store, no server.
 */
import { describe, expect, test } from "bun:test";
import { inboxAgentMarkChecked, inboxAgentNamesChecked, type InboxAgent } from "@plannotator/core/inbox-types";
import { inboxAgentsGroup, inboxPeerAgentsGroup, type InboxAgentLaunch, type InboxAgentsEvidence } from "./inbox-agents-list";
import type { InboxAgentSession } from "./inbox-sessions";
import { withRexMark, withRexStatus } from "./inbox-rex-status";

const T = Date.UTC(2026, 10, 18, 12);

function session(id: string, over: Partial<InboxAgentSession> = {}): InboxAgentSession {
  return { session: id, host: "claude-code", root: "/work/ledger", startedAt: T, firstSeen: T, lastSeen: T, live: true, busy: null, blocked: null, label: null, title: null, ...over };
}

function evidence(over: Partial<InboxAgentsEvidence> = {}): InboxAgentsEvidence {
  return {
    sessions: [],
    launches: [],
    waits: [],
    archived: new Set(),
    projectOf: () => ({ id: "prj_ledger", name: "ledger" }),
    projectById: (id) => ({ id, name: "ledger" }),
    lastHeardOf: () => null,
    continuedBy: () => null,
    continuesOf: () => [],
    labels: true,
    ...over,
  };
}

const wait = (sessionId: string, host = "claude-code") => ({ thread_id: `thr_${sessionId}`, session: sessionId, host, project: { id: "prj_ledger", name: "ledger" }, at: new Date(T).toISOString() });
const byId = (agents: InboxAgent[]) => Object.fromEntries(agents.map((agent) => [agent.id, agent]));

describe("what each agent's mark says", () => {
  test("a host that reports turns: working while busy, no mark at rest (no idle mark); one that reports nothing: no mark and turns_unknown", () => {
    const { agents } = inboxAgentsGroup(
      evidence({
        sessions: [session("cc-busy", { busy: true }), session("cc-idle", { busy: false }), session("codex-1", { host: "codex", busy: null }), session("qwen-1", { host: "qwen-code", busy: null })],
      }),
    );
    const a = byId(agents);
    expect(a["cc-busy"]!.status_mark).toEqual({ state: "working" });
    expect(a["cc-idle"]!.status_mark).toBeUndefined();
    for (const id of ["codex-1", "qwen-1"]) {
      expect(a[id]!.status_mark).toBeUndefined();
      expect(a[id]!.turns_unknown).toBe(true);
    }
    // A host that reports turns is never "unknown".
    expect(a["cc-idle"]!.turns_unknown).toBeUndefined();
  });

  test("a thread waiting on the person: waiting here, for any host, a quiet one too; a terminal prompt wins over it", () => {
    const { agents } = inboxAgentsGroup(
      evidence({
        sessions: [session("codex-1", { host: "codex", busy: null }), session("cc-busy", { busy: true }), session("cc-perm", { busy: true, blocked: "permission" }), session("pi-q", { host: "pi", busy: true, blocked: "question" })],
        waits: [wait("codex-1", "codex"), wait("cc-busy"), wait("cc-perm"), wait("gemini-1", "gemini")],
      }),
    );
    const a = byId(agents);
    expect(a["codex-1"]!.status_mark).toEqual({ state: "blocked", where: "inbox" });
    expect(a["cc-busy"]!.status_mark).toEqual({ state: "blocked", where: "inbox" });
    // An MCP-only host the Inbox holds no session for, owning a waiting thread: waiting here, nothing more.
    expect(a["gemini-1"]!.status_mark).toEqual({ state: "blocked", where: "inbox" });
    expect(a["cc-perm"]!.status_mark).toEqual({ state: "blocked", kind: "permission", where: "terminal" });
    expect(a["pi-q"]!.status_mark).toEqual({ state: "blocked", kind: "question", where: "terminal" });
    // The row's own state is unchanged by a terminal prompt: still working (its turn runs).
    expect(a["pi-q"]!.state).toBe("working");
  });

  test("a session the Inbox launched never shows a terminal prompt (its launch shows it here); a stopped launch has no mark", () => {
    const launch = (id: string, sessionId: string, run: InboxAgentLaunch["run"]): InboxAgentLaunch => ({ launch_id: id, session: sessionId, thread_id: `thr_${id}`, host: "claude-code", project_id: "prj_ledger", started_at: new Date(T).toISOString(), started: true, run, scratch: null });
    const { agents } = inboxAgentsGroup(
      evidence({
        sessions: [session("ses-launched", { busy: true, blocked: "permission" })],
        launches: [launch("lch_1", "ses-launched", "working"), launch("lch_2", "launch:lch_2", "stopped")],
      }),
    );
    const a = byId(agents);
    expect(a["lch_1"]!.status_mark).toEqual({ state: "working" });
    expect(a["lch_2"]!.status_mark).toBeUndefined();
  });

  test("ended, however it ended (a quiet host's hour included): no mark, nothing unknown; never done", () => {
    const { agents } = inboxAgentsGroup(
      evidence({
        sessions: [session("cc-ended", { live: false, busy: null }), session("codex-quiet", { host: "codex", live: false, busy: null, blocked: null })],
      }),
    );
    for (const agent of agents) {
      expect(agent.state).toBe("ended");
      expect(agent.status_mark).toBeUndefined();
      expect(agent.turns_unknown).toBeUndefined();
    }
    // No state the Inbox can work out is `done` (only a Rex record says it): every mark checked.
    expect(inboxAgentMarkChecked({ state: "done" })).toBeNull();
    expect(inboxAgentMarkChecked({ state: "idle" })).toBeNull();
  });
});

describe("a fresh Rex record wins", () => {
  test("the Rex mark replaces the Inbox's own, and Rex's word removes turns_unknown", () => {
    const [codex] = inboxAgentsGroup(evidence({ sessions: [session("codex-1", { host: "codex", busy: null })] })).agents;
    expect(codex!.turns_unknown).toBe(true);
    const placed = withRexStatus(codex!, { state: "done" });
    expect(placed.turns_unknown).toBeUndefined();
    const [busy] = inboxAgentsGroup(evidence({ sessions: [session("cc-1", { busy: true })] })).agents;
    const marked = withRexMark(busy!, { state: "blocked", kind: "permission" });
    expect(marked.rex_mark).toEqual({ state: "blocked", kind: "permission" });
    expect(marked.status_mark).toBeUndefined();
  });
});

describe("another machine's marks", () => {
  test("only a mark this Inbox knows passes, as a state, a kind and a place: no other field rides along", () => {
    expect(inboxAgentMarkChecked({ state: "blocked", kind: "permission", where: "terminal", msg: "rm -rf build" })).toEqual({ state: "blocked", kind: "permission", where: "terminal" });
    expect(inboxAgentMarkChecked({ state: "blocked", kind: "auth", where: "terminal" })).toBeNull();
    expect(inboxAgentMarkChecked({ state: "blocked" })).toBeNull();
    expect(inboxAgentMarkChecked({ state: "working", title: "Deploying" })).toEqual({ state: "working" });
    const agent = { id: "a", session: "a", host: "pi", project: null, state: "working", waiting: 0, live: true, started_at: null, last_seen_at: null, status_mark: { state: "busy" }, turns_unknown: "yes" } as unknown as InboxAgent;
    const checked = inboxAgentNamesChecked(agent);
    expect(checked.status_mark).toBeUndefined();
    expect(checked.turns_unknown).toBeUndefined();
    // A linked machine's group never carries its own setting into this window.
    const group = inboxPeerAgentsGroup([{ agents: [{ ...agent, status_mark: { state: "working" } }], total: 1, ended_today: 0, status_marks: true }], "ibx_peer");
    expect(group!.agents[0]!.status_mark).toEqual({ state: "working" });
    expect(group!.status_marks).toBeUndefined();
  });
});
