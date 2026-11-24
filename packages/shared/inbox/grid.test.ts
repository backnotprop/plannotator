/**
 * Grid's groups, bars and decay (approval "inbox-agent-grid", round 3: `.product/approved/inbox-agent-grid/NOTES.md`,
 * "Final decay rules"). Each case is a thread as the window passes it and the time.
 */
import { describe, expect, test } from "bun:test";
import { GRID_DAY, GRID_HOUR, GRID_MIN, gridExact, gridLandedWord, gridModel, gridPlace, gridRounded, gridSaid, type GridThreadIn } from "./grid";

const NOW = Date.parse("2026-11-23T23:42:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * GRID_MIN).toISOString();

function thread(over: Partial<GridThreadIn> = {}): GridThreadIn {
  return {
    id: "msg_a",
    name: "Pagination cursors",
    machine: null,
    agent: { key: "fern", name: "fern-api", host: "claude-code" },
    agentState: "idle",
    agentHere: true,
    agentEndedAt: null,
    terminal: null,
    running: false,
    created_at: ago(200),
    last_agent_at: ago(5),
    section: "sent",
    waiting_since: null,
    prompt: null,
    open: 0,
    actions: 0,
    sent: { at: ago(10), checked_at: ago(9) },
    session_ended: false,
    pull: null,
    ...over,
  };
}
const pull = (over: Partial<NonNullable<GridThreadIn["pull"]>> = {}): NonNullable<GridThreadIn["pull"]> => ({
  label: "#88",
  state: "open",
  added_at: ago(72),
  read_at: null,
  checks: null,
  review: null,
  ...over,
});
const groupOf = (t: GridThreadIn, look: number | null = null, now = NOW) => {
  const placed = gridPlace(t, now, look);
  return placed && placed.place === "shown" ? placed.line.group : (placed?.place ?? null);
};

describe("groups", () => {
  test("an open question is Needs you, its words under the name, and it never leaves by age", () => {
    const asks = thread({ section: "stopped", waiting_since: ago(32), prompt: "Keep the old page param?", open: 1, pull: pull() });
    const placed = gridPlace(asks, NOW, null)!;
    expect(placed.line.group).toBe("you");
    expect(placed.line.ask).toBe("Keep the old page param?");
    expect(placed.line.pieces.map((p) => p.kind)).toEqual(["work", "pr", "wait"]);
    expect(groupOf({ ...asks, waiting_since: ago(60 * 24 * 9) }, NOW)).toBe("you");
  });

  test("an agent stopped on a permission prompt in its terminal needs the person, only on the thread it works in", () => {
    expect(gridPlace(thread({ terminal: "permission" }), NOW, null)!.line.ask).toBe("Asks for permission in its terminal");
    expect(groupOf(thread({ terminal: "permission", agentHere: false }))).toBe("move");
  });

  test("work the agent owes an answer on is Moving, and Not moving after 20 quiet minutes", () => {
    expect(groupOf(thread({ last_agent_at: ago(19), sent: { at: ago(25), checked_at: ago(19) } }))).toBe("move");
    expect(groupOf(thread({ last_agent_at: ago(21), sent: { at: ago(25), checked_at: ago(21) } }))).toBe("quiet");
    // A turn running in this thread keeps it Moving however long since its last message.
    expect(groupOf(thread({ last_agent_at: ago(90), sent: { at: ago(95), checked_at: ago(90) }, agentState: "working" }))).toBe("move");
  });

  test("a thread whose agent answered and asks nothing, with no PR in play, is not work in flight", () => {
    expect(gridPlace(thread({ section: "quiet", sent: null }), NOW, null)).toBeNull();
    expect(gridPlace(thread({ section: "new", sent: null }), NOW, null)).toBeNull();
    // An open PR keeps it on the page whoever spoke last.
    expect(groupOf(thread({ section: "quiet", sent: null, last_agent_at: ago(3), pull: pull() }))).toBe("move");
  });

  test("a message no agent has read or answered yet is Not started, at the time it was sent", () => {
    const placed = gridPlace(thread({ last_agent_at: null, sent: { at: ago(147), checked_at: null } }), NOW, null)!;
    expect(placed.line.group).toBe("plan");
    expect(placed.line.planned).toBe(NOW - 147 * GRID_MIN);
  });

  test("a merged PR is Landed until seen, three hours at least; unseen past twelve hours only a count", () => {
    const merged = (minutes: number) => thread({ section: "quiet", sent: null, pull: pull({ state: "merged", read_at: ago(minutes) }) });
    expect(groupOf(merged(11))).toBe("land");
    expect(gridPlace(merged(11), NOW, null)!.line.fresh).toBe(true);
    // Seen after it landed: kept three hours, then Earlier.
    expect(groupOf(merged(170), NOW - 60 * GRID_MIN)).toBe("land");
    expect(groupOf(merged(190), NOW - 60 * GRID_MIN)).toBe("earlier");
    // Never seen: shown up to twelve hours, then counted in the Since line.
    expect(groupOf(merged(11 * 60), NOW - 13 * 60 * GRID_MIN)).toBe("land");
    expect(groupOf(merged(13 * 60), NOW - 14 * 60 * GRID_MIN)).toBe("counted");
  });

  test("nothing leaves without Dropped: a closed PR, open work whose agent ended, open work quiet three days", () => {
    const closed = gridPlace(thread({ pull: pull({ state: "closed", read_at: ago(40) }) }), NOW, null)!;
    expect(closed.line.group).toBe("drop");
    expect(closed.line.dropped).toEqual({ at: NOW - 40 * GRID_MIN, why: "PR closed" });
    const ended = gridPlace(thread({ session_ended: true, created_at: ago(300), last_agent_at: ago(230), sent: { at: ago(240), checked_at: ago(230) }, agentEndedAt: ago(110) }), NOW, null)!;
    expect(ended.line.dropped).toEqual({ at: NOW - 110 * GRID_MIN, why: "agent ended" });
    // The bar stops where it was dropped: Working, then Not moving up to the end.
    expect(ended.line.pieces.map((p) => p.kind)).toEqual(["work", "idle"]);
    expect(ended.line.pieces.at(-1)!.to).toBe(NOW - 110 * GRID_MIN);
    const quiet = gridPlace(thread({ created_at: ago(5000), last_agent_at: ago(4400), sent: { at: ago(4410), checked_at: ago(4400) }, pull: pull({ added_at: ago(4405) }) }), NOW, null)!;
    expect(quiet.line.dropped?.why).toBe("quiet 3 days");
    expect(quiet.line.dropped?.at).toBe(NOW - 4400 * GRID_MIN + 3 * GRID_DAY);
    // A conversation whose agent ended after answering was not work in flight: it is not dropped.
    expect(gridPlace(thread({ section: "quiet", sent: null, session_ended: true }), NOW, null)).toBeNull();
  });

  test("Dropped stays until seen and three hours at least, then Earlier for seven days, then nothing", () => {
    const at = (minutes: number) => thread({ pull: pull({ state: "closed", read_at: ago(minutes) }) });
    expect(groupOf(at(200), NOW - 300 * GRID_MIN)).toBe("drop");
    expect(groupOf(at(200), NOW - 100 * GRID_MIN)).toBe("earlier");
    expect(groupOf(at(100), NOW - 10 * GRID_MIN)).toBe("drop");
    expect(groupOf(at(8 * 24 * 60), null)).toBeNull();
  });
});

describe("the page", () => {
  test("counts each group, says what landed and dropped since the last look, and keeps Earlier", () => {
    const look = NOW - 52 * GRID_MIN;
    const model = gridModel(
      [
        thread({ id: "a", section: "stopped", waiting_since: ago(32), open: 1, prompt: "Keep the old page param?" }),
        thread({ id: "b" }),
        thread({ id: "c", section: "quiet", sent: null, pull: pull({ state: "merged", read_at: ago(11) }) }),
        thread({ id: "d", section: "quiet", sent: null, pull: pull({ state: "merged", read_at: ago(15 * 60) }) }),
        thread({ id: "e", pull: pull({ state: "closed", read_at: ago(5 * 60) }) }),
      ],
      NOW,
      look,
    );
    expect(model.groups.map((g) => [g.id, g.lines.map((l) => l.id)])).toEqual([
      ["you", ["a"]],
      ["move", ["b"]],
      ["land", ["c"]],
    ]);
    expect(model.counts).toEqual({ you: 1, move: 1, quiet: 0, land: 1, plan: 0, drop: 0 });
    expect(model.since).toEqual({ at: look, merged: 1, dropped: 0 });
    expect(model.earlier.map((l) => l.id)).toEqual(["e", "d"]);
    // The clock reaches back past the last look, six hours at least.
    expect(model.span).toEqual({ from: NOW - 6 * GRID_HOUR, to: NOW });
  });

  test("a linked computer's thread is a line like any other, with its computer", () => {
    const model = gridModel([thread({ id: "far", machine: "ibx_mini" })], NOW, null);
    expect(model.groups[0]!.lines[0]!.machine).toBe("ibx_mini");
  });

  test("Moving keeps an agent's lines together, the busiest agent first, PRs before plain work", () => {
    const ops = { key: "ops", name: "harbor ops", host: "claude-code" };
    const model = gridModel(
      [
        thread({ id: "fern1", created_at: ago(300) }),
        thread({ id: "ops1", agent: ops, created_at: ago(100) }),
        thread({ id: "ops2", agent: ops, created_at: ago(50), pull: pull({ added_at: ago(10) }) }),
      ],
      NOW,
      null,
    );
    expect(model.groups[0]!.lines.map((l) => l.id)).toEqual(["ops2", "ops1", "fern1"]);
  });
});

describe("words", () => {
  test("lengths round as the line says them and as the readout does", () => {
    expect([gridRounded(32 * GRID_MIN), gridRounded(95 * GRID_MIN), gridRounded(130 * GRID_MIN), gridRounded(30 * GRID_HOUR), gridRounded(3 * GRID_DAY)]).toEqual(["32 min", "1.5 h", "2 h", "1 d", "3 d"]);
    expect([gridExact(40 * GRID_MIN), gridExact(130 * GRID_MIN), gridExact(4 * GRID_HOUR + 5 * GRID_MIN)]).toEqual(["40 min", "2 h 10 min", "4 h"]);
  });

  test("the bar in words: the last piece is where the work is, at most three, the oldest cut first", () => {
    const line = gridPlace(thread({ section: "stopped", waiting_since: ago(32), open: 1, pull: pull() }), NOW, null)!.line;
    const said = gridSaid(line);
    expect(said.cut).toBe(false);
    expect(said.pieces.map((p) => `${p.name} ${p.length}${p.on ? " (now)" : ""}`)).toEqual(["Working 2 h", "PR 40 min", "Needs you 32 min (now)"]);
    expect(gridSaid(line, { phone: false, room: 20 }).cut).toBe(true);
    // A merged line ends at Merged: none of its pieces is "now".
    const landed = gridPlace(thread({ pull: pull({ state: "merged", read_at: ago(11) }) }), NOW, null)!.line;
    expect(gridSaid(landed).pieces.some((p) => p.on)).toBe(false);
  });

  test("checks and the review follow the last piece; a closed or merged PR has none", () => {
    expect(gridPlace(thread({ pull: pull({ checks: "failing" }) }), NOW, null)!.line.detail).toEqual({ words: "tests failing", bad: true });
    expect(gridPlace(thread({ pull: pull({ checks: "passing", review: "approved" }) }), NOW, null)!.line.detail?.words).toBe("reviewed");
    expect(gridPlace(thread({ pull: pull({ state: "draft" }) }), NOW, null)!.line.detail?.words).toBe("draft");
    expect(gridPlace(thread({ pull: pull({ state: "merged", read_at: ago(5), checks: "failing" }) }), NOW, null)!.line.detail).toBeNull();
  });

  test("Landed says tonight, overnight or today", () => {
    expect([gridLandedWord(23), gridLandedWord(7), gridLandedWord(13)]).toEqual(["tonight", "overnight", "today"]);
  });
});
