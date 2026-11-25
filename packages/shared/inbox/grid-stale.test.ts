/**
 * Grid round 4 (approval "inbox-agent-grid", 2026-11-24, built 2026-11-25): Stale, Nudge's offer and its words. Each
 * case is a thread as the window passes it and the time.
 */
import { describe, expect, test } from "bun:test";
import { GRID_HOUR, GRID_MIN, gridModel, gridPlace, gridSaid, type GridAction, type GridPullIn, type GridThreadIn } from "./grid";
import { GRID_NUDGE_ASK, gridNudgeWords } from "./grid-nudge";

const NOW = Date.parse("2026-11-24T04:42:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * GRID_MIN).toISOString();
/** A clock that says every time as "h:mm" UTC, so the words do not hang on the machine's zone. */
const at = (ms: number) => new Date(ms).toISOString().slice(11, 16);

function thread(over: Partial<GridThreadIn> = {}): GridThreadIn {
  return {
    id: "msg_haptics",
    name: "Haptics on save",
    machine: null,
    agent: { key: "tide", name: "tide-ios", host: "claude-code" },
    agentState: "idle",
    agentHere: true,
    agentEndedAt: null,
    terminal: null,
    running: false,
    created_at: ago(5 * 60),
    last_agent_at: ago(10),
    section: "quiet",
    waiting_since: null,
    prompt: null,
    open: 0,
    actions: 0,
    sent: null,
    session_ended: false,
    pulls: [],
    steps: null,
    seen: null,
    nudge: { to: "msg_last", last: null },
    ...over,
  };
}
const pull = (over: Partial<GridPullIn> = {}): GridPullIn => ({ key: "github.com/ada/tide#22", label: "#22", state: "open", added_at: ago(4 * 60), read_at: null, checks: null, review: null, ...over });
const line = (t: GridThreadIn, now = NOW) => gridPlace(t, now)!.line;
const nudgeOf = (t: GridThreadIn, now = NOW) => line(t, now).actions.find((a): a is Extract<GridAction, { kind: "nudge" }> => a.kind === "nudge") ?? null;

describe("Stale", () => {
  test("open work quiet 2 h 59 min is Not moving; at 3 h it is Stale, its whole quiet stretch drawn and said as Stale", () => {
    expect(line(thread({ last_agent_at: ago(179) })).group).toBe("quiet");
    const stale = line(thread({ last_agent_at: ago(180) }));
    expect(stale.group).toBe("stale");
    expect(stale.staleFrom).toBe(NOW - 180 * GRID_MIN);
    expect(stale.pieces.map((p) => [p.kind, p.from])).toEqual([["work", NOW - 300 * GRID_MIN], ["stale", NOW - 180 * GRID_MIN]]);
    expect(gridSaid(stale).pieces.map((p) => `${p.name} ${p.length}`)).toEqual(["Working 2 h", "Stale 3 h"]);
  });

  test("anything happening brings it back to Moving: a push, a step, a test run's PR read, a message", () => {
    const quiet = { last_agent_at: ago(240) };
    expect(line(thread(quiet)).group).toBe("stale");
    expect(line(thread({ ...quiet, pulls: [pull({ added_at: ago(2) })] })).group).toBe("move");
    expect(line(thread({ ...quiet, steps: { done: 2, total: 5, doing: "Stub the engine", at: ago(1) } })).group).toBe("move");
    expect(line(thread({ last_agent_at: ago(1) })).group).toBe("move");
    expect(line(thread({ ...quiet, running: true })).group).toBe("move");
  });

  test("work that needs the person is never stale, however long it waits", () => {
    const asks = thread({ section: "stopped", waiting_since: ago(9 * 60), last_agent_at: ago(9 * 60), prompt: "Use yesterday's key?", open: 1 });
    expect(line(asks).group).toBe("you");
    expect(line({ ...asks, waiting_since: null, open: 0, prompt: null, terminal: "permission" }).group).toBe("you");
  });

  test("an agent that ended is Dropped, never Stale: stale is work whose agent is still there", () => {
    expect(line(thread({ last_agent_at: ago(240), session_ended: true })).group).toBe("drop");
    expect(line(thread({ last_agent_at: ago(240), agentState: "ended" })).group).toBe("drop");
  });

  test("a plan nobody started is Not started for 12 hours, then Stale with its whole wait and \"not started\"", () => {
    const plan = (minutes: number) => thread({ created_at: ago(minutes), last_agent_at: null, sent: { at: ago(minutes), checked_at: null } });
    expect(line(plan(12 * 60 - 1)).group).toBe("plan");
    const stale = line(plan(12 * 60));
    expect(stale.group).toBe("stale");
    expect([stale.planned, stale.staleFrom, stale.detail?.words]).toEqual([NOW - 12 * GRID_HOUR, NOW - 12 * GRID_HOUR, "not started"]);
    expect(stale.pieces).toEqual([{ kind: "stale", from: NOW - 12 * GRID_HOUR, to: NOW }]);
  });

  test("the page puts Stale between Not moving and Landed, longest quiet first, with its count", () => {
    const model = gridModel(
      [
        thread({ id: "a", last_agent_at: ago(30) }),
        thread({ id: "b", last_agent_at: ago(200) }),
        thread({ id: "c", last_agent_at: ago(260) }),
        thread({ id: "d", pulls: [pull({ state: "merged", read_at: ago(5) })] }),
      ],
      NOW,
    );
    expect(model.groups.map((g) => g.id)).toEqual(["quiet", "stale", "land"]);
    expect(model.groups[1]!.lines.map((l) => l.id)).toEqual(["c", "b"]);
    expect(model.counts.stale).toBe(2);
  });
});

describe("Nudge", () => {
  test("offered on a stale line whose thread names where a reply goes; not on other lines, nor from an Inbox without it", () => {
    const stale = thread({ last_agent_at: ago(217) });
    const nudge = nudgeOf(stale)!;
    expect([nudge.to, nudge.quietFrom]).toEqual(["msg_last", NOW - 217 * GRID_MIN]);
    expect(nudgeOf(thread({ last_agent_at: ago(100) }))).toBeNull();
    expect(nudgeOf({ ...stale, nudge: null })).toBeNull();
  });

  test("once nudged, the line says so and has no Nudge until three more quiet hours; the nudge's own delivery is not movement", () => {
    const nudgedAt = ago(5);
    const nudged = thread({
      last_agent_at: ago(222),
      section: "sent",
      sent: { at: nudgedAt, checked_at: ago(4) },
      nudge: { to: "msg_last", last: { at: nudgedAt, quiet_from: ago(222), answered_at: null } },
    });
    const now = line(nudged);
    expect(now.group).toBe("stale");
    expect(now.nudged).toEqual({ at: NOW - 5 * GRID_MIN, now: true });
    expect(nudgeOf(nudged)).toBeNull();
    // Three more quiet hours: Nudge again, under another key.
    const later = NOW + 3 * GRID_HOUR;
    expect(nudgeOf(nudged, later)!.key).not.toBe(nudgeOf(thread({ last_agent_at: ago(222) }))!.key);
  });

  test("a press is one key for its stretch: two windows or a held copy write one nudge", () => {
    const stale = thread({ last_agent_at: ago(217) });
    expect(nudgeOf(stale)!.key).toBe(nudgeOf(stale, NOW + 20 * GRID_MIN)!.key);
  });

  test("the agent answers: Moving again, and the nudged stretch stays on the bar as Stale up to the answer", () => {
    const answered = thread({
      last_agent_at: ago(1),
      pulls: [pull({ added_at: ago(250), checks: "running" })],
      nudge: { to: "msg_answer", last: { at: ago(17), quiet_from: ago(233), answered_at: ago(1) } },
    });
    const moved = line(answered);
    expect(moved.group).toBe("move");
    expect(moved.nudged).toEqual({ at: NOW - 17 * GRID_MIN, now: false });
    expect(moved.pieces.map((p) => p.kind)).toEqual(["work", "pr", "stale", "pr"]);
    expect(moved.pieces[2]).toEqual({ kind: "stale", from: NOW - 233 * GRID_MIN, to: NOW - 1 * GRID_MIN });
  });

  test("the words: the line's name, how long it has been quiet, one detail, then the approved sentence", () => {
    const failing = line(thread({ last_agent_at: ago(217), pulls: [pull({ checks: "failing" })] }));
    expect(gridNudgeWords(failing, NOW, at)).toBe("Haptics on save has been quiet for 3 h 37 min, with tests failing on #22 since 01:05. Please finish it, or tell me in a few words why it stopped.");
    const draft = line(thread({ name: "Pricing page hero", last_agent_at: ago(7 * 60), created_at: ago(8 * 60), pulls: [pull({ label: "#7", state: "draft", added_at: ago(7 * 60 + 5) })] }));
    expect(gridNudgeWords(draft, NOW, at)).toBe(`Pricing page hero has been quiet for 7 h, with #7 still a draft. ${GRID_NUDGE_ASK}`);
    const plan = line(thread({ name: "Receipts by email", created_at: ago(14 * 60), last_agent_at: null, sent: { at: ago(14 * 60), checked_at: null } }));
    expect(gridNudgeWords(plan, NOW, at)).toBe(`Receipts by email has been quiet for 14 h, planned at 14:42 and not started. ${GRID_NUDGE_ASK}`);
    const plain = line(thread({ name: "Nightly summary", last_agent_at: ago(186) }));
    expect(gridNudgeWords(plain, NOW, at)).toBe(`Nightly summary has been quiet for 3 h 6 min. ${GRID_NUDGE_ASK}`);
    expect(GRID_NUDGE_ASK).toBe("Please finish it, or tell me in a few words why it stopped.");
  });
});
