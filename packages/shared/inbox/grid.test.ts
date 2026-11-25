/**
 * Grid's groups, bars and decay (approval "inbox-agent-grid", round 3: `.product/approved/inbox-agent-grid/NOTES.md`,
 * "Final decay rules"). Each case is a thread as the window passes it and the time.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createGridModel, GRID_DAY, GRID_HOUR, GRID_MIN, gridExact, gridHourTicks, gridLandedWord, gridModel, gridPlace, gridRounded, gridSaid, gridSpoken, type GridPullIn, type GridThreadIn } from "./grid";

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
    pulls: [],
    steps: null,
    seen: null,
    ...over,
  };
}
const pull = (over: Partial<GridPullIn> = {}): GridPullIn => ({
  key: "github.com/ada/harbor#88",
  label: "#88",
  state: "open",
  added_at: ago(72),
  read_at: null,
  checks: null,
  review: null,
  ...over,
});
/** A look at `minutes` ago that showed everything up to then. */
const lookAt = (minutes: number) => ({ through: NOW - minutes * GRID_MIN, at: NOW - minutes * GRID_MIN });
const groupOf = (t: GridThreadIn, now = NOW) => {
  const placed = gridPlace(t, now);
  return placed && placed.place === "shown" ? placed.line.group : (placed?.place ?? null);
};

describe("groups", () => {
  test("an open question is Needs you, its words under the name, and it never leaves by age", () => {
    const asks = thread({ section: "stopped", waiting_since: ago(32), prompt: "Keep the old page param?", open: 1, pulls: [pull()] });
    const placed = gridPlace(asks, NOW)!;
    expect(placed.line.group).toBe("you");
    expect(placed.line.ask).toBe("Keep the old page param?");
    expect(placed.line.pieces.map((p) => p.kind)).toEqual(["work", "pr", "wait"]);
    expect(groupOf({ ...asks, waiting_since: ago(60 * 24 * 9) })).toBe("you");
  });

  test("an agent stopped on a permission prompt in its terminal needs the person, only on the thread it works in", () => {
    expect(gridPlace(thread({ terminal: "permission" }), NOW)!.line.ask).toBe("Asks for permission in its terminal");
    expect(groupOf(thread({ terminal: "permission", agentHere: false }))).toBe("move");
  });

  test("work the agent owes an answer on is Moving, and Not moving after 20 quiet minutes", () => {
    expect(groupOf(thread({ last_agent_at: ago(19), sent: { at: ago(25), checked_at: ago(19) } }))).toBe("move");
    expect(groupOf(thread({ last_agent_at: ago(21), sent: { at: ago(25), checked_at: ago(21) } }))).toBe("quiet");
    // A turn running in this thread keeps it Moving however long since its last message.
    expect(groupOf(thread({ last_agent_at: ago(90), sent: { at: ago(95), checked_at: ago(90) }, agentState: "working" }))).toBe("move");
    // A checklist step that changed is movement.
    expect(groupOf(thread({ last_agent_at: ago(90), sent: null, steps: { done: 2, total: 5, doing: "Write the migration", at: ago(3) } }))).toBe("move");
  });

  test("work whose agent's turn ended without a question never leaves silently: Not moving, then Dropped", () => {
    // Moving while the agent works, with no PR...
    expect(groupOf(thread({ agentState: "working", sent: { at: ago(30), checked_at: ago(29) } }))).toBe("move");
    // ...its turn ends with an answer and no question: still on the page.
    const answered = thread({ section: "quiet", sent: null, last_agent_at: ago(2) });
    expect(groupOf(answered)).toBe("move");
    expect(groupOf({ ...answered, last_agent_at: ago(25) })).toBe("quiet");
    expect(groupOf({ ...answered, created_at: ago(5000), last_agent_at: ago(3 * 24 * 60 - 1) })).toBe("quiet");
    // Three quiet days: Dropped, not gone.
    const dropped = gridPlace({ ...answered, created_at: ago(5000), last_agent_at: ago(3 * 24 * 60 + 5) }, NOW)!;
    expect(dropped.line.group).toBe("drop");
    expect(dropped.line.dropped?.why).toBe("quiet 3 days");
    // Its agent ended: Dropped too.
    expect(gridPlace({ ...answered, session_ended: true }, NOW)!.line.dropped?.why).toBe("agent ended");
  });

  test("only work is drawn: a thread no agent is known for is not a line, whatever it carries", () => {
    expect(gridPlace(thread({ agent: null, agentState: null, agentHere: false, open: 1, prompt: "Ship it?" }), NOW)).toBeNull();
    expect(gridPlace(thread({ agent: null, agentState: null, agentHere: false }), NOW)).toBeNull();
  });

  test("a message no agent has read or answered yet is Not started, at the time it was sent", () => {
    const placed = gridPlace(thread({ last_agent_at: null, sent: { at: ago(147), checked_at: null } }), NOW)!;
    expect(placed.line.group).toBe("plan");
    expect(placed.line.planned).toBe(NOW - 147 * GRID_MIN);
  });

  test("a merged PR is Landed until its line is seen, three hours at least; unseen past twelve hours only a count, never gone", () => {
    const merged = (minutes: number, seen: GridThreadIn["seen"] = null) => thread({ section: "quiet", sent: null, pulls: [pull({ state: "merged", read_at: ago(minutes) })], seen });
    expect(groupOf(merged(11))).toBe("land");
    expect(gridPlace(merged(11), NOW)!.line.fresh).toBe(true);
    // Its line seen after it landed: kept three hours, then Earlier.
    expect(groupOf(merged(170, lookAt(60)))).toBe("land");
    expect(gridPlace(merged(170, lookAt(60)), NOW)!.line.fresh).toBe(false);
    expect(groupOf(merged(190, lookAt(60)))).toBe("earlier");
    // A look before it landed is not a look at it.
    expect(gridPlace(merged(190, lookAt(300)), NOW)!.line.fresh).toBe(true);
    // Never seen: shown up to twelve hours, then counted in the Since line, however long it waits.
    expect(groupOf(merged(11 * 60, lookAt(13 * 60)))).toBe("land");
    expect(groupOf(merged(13 * 60, lookAt(14 * 60)))).toBe("counted");
    expect(groupOf(merged(40 * 24 * 60, lookAt(41 * 24 * 60)))).toBe("counted");
  });

  test("an end older than a week that no look ever showed happened before Grid could show it: not drawn", () => {
    expect(gridPlace(thread({ pulls: [pull({ state: "merged", read_at: ago(8 * 24 * 60) })] }), NOW)).toBeNull();
    expect(gridPlace(thread({ created_at: ago(30 * 24 * 60), last_agent_at: ago(20 * 24 * 60), sent: null }), NOW)).toBeNull();
  });

  test("nothing leaves without Dropped: every PR closed, the agent ended, open work quiet three days", () => {
    const closed = gridPlace(thread({ pulls: [pull({ state: "closed", read_at: ago(40) })] }), NOW)!;
    expect(closed.line.group).toBe("drop");
    expect(closed.line.dropped).toEqual({ at: NOW - 40 * GRID_MIN, why: "PR closed" });
    const ended = gridPlace(thread({ session_ended: true, created_at: ago(300), last_agent_at: ago(230), sent: { at: ago(240), checked_at: ago(230) }, agentEndedAt: ago(110) }), NOW)!;
    expect(ended.line.dropped).toEqual({ at: NOW - 110 * GRID_MIN, why: "agent ended" });
    // The bar stops where it was dropped: Working, then Not moving up to the end.
    expect(ended.line.pieces.map((p) => p.kind)).toEqual(["work", "idle"]);
    expect(ended.line.pieces.at(-1)!.to).toBe(NOW - 110 * GRID_MIN);
    const quiet = gridPlace(thread({ created_at: ago(5000), last_agent_at: ago(4400), sent: { at: ago(4410), checked_at: ago(4400) }, pulls: [pull({ added_at: ago(4405) })] }), NOW)!;
    expect(quiet.line.dropped?.why).toBe("quiet 3 days");
    expect(quiet.line.dropped?.at).toBe(NOW - 4400 * GRID_MIN + 3 * GRID_DAY);
  });

  test("a reopened PR comes back from Dropped", () => {
    const t = thread({ pulls: [pull({ state: "closed", read_at: ago(40) })] });
    expect(groupOf(t)).toBe("drop");
    expect(groupOf({ ...t, pulls: [pull({ state: "open", read_at: ago(1) })] })).toBe("move");
  });

  test("Dropped stays until its line is seen, however long, and three hours at least; then Earlier for seven days", () => {
    const at = (minutes: number, seen: GridThreadIn["seen"]) => thread({ pulls: [pull({ state: "closed", read_at: ago(minutes) })], seen });
    expect(groupOf(at(200, lookAt(300)))).toBe("drop");
    expect(groupOf(at(30 * 24 * 60, lookAt(31 * 24 * 60)))).toBe("drop");
    expect(groupOf(at(200, lookAt(100)))).toBe("earlier");
    expect(groupOf(at(100, lookAt(10)))).toBe("drop");
    expect(groupOf(at(12 * 24 * 60, lookAt(11 * 24 * 60)))).toBeNull();
  });

  test("a thread with several PRs is one line: open while any is, landed when none is and one merged", () => {
    const first = pull({ key: "k1", label: "#1", added_at: ago(100) });
    const second = pull({ key: "k2", label: "#2", added_at: ago(50), checks: "failing" });
    const both = gridPlace(thread({ pulls: [first, second] }), NOW)!.line;
    expect([both.group, both.pr, both.detail?.words]).toEqual(["move", "#1", "tests failing"]);
    expect(both.pieces.find((p) => p.kind === "pr")!.from).toBe(NOW - 100 * GRID_MIN);
    const done = gridPlace(thread({ pulls: [{ ...first, state: "merged", read_at: ago(30) }, { ...second, state: "closed", read_at: ago(20) }] }), NOW)!.line;
    expect([done.group, done.merged]).toEqual(["land", NOW - 20 * GRID_MIN]);
    expect(gridPlace(thread({ pulls: [{ ...first, state: "closed", read_at: ago(30) }, { ...second, state: "closed", read_at: ago(20) }] }), NOW)!.line.dropped?.why).toBe("PR closed");
  });
});

describe("the page", () => {
  test("counts each group, says what landed and dropped unseen since the last look, and keeps Earlier", () => {
    const look = lookAt(52);
    const model = gridModel(
      [
        thread({ id: "a", section: "stopped", waiting_since: ago(32), open: 1, prompt: "Keep the old page param?", seen: look }),
        thread({ id: "b", seen: look }),
        thread({ id: "c", section: "quiet", sent: null, pulls: [pull({ state: "merged", read_at: ago(11) })], seen: look }),
        thread({ id: "d", section: "quiet", sent: null, pulls: [pull({ state: "merged", read_at: ago(15 * 60) })], seen: lookAt(14 * 60) }),
        thread({ id: "e", pulls: [pull({ state: "closed", read_at: ago(5 * 60) })], seen: lookAt(4 * 60) }),
      ],
      NOW,
    );
    expect(model.groups.map((g) => [g.id, g.lines.map((l) => l.id)])).toEqual([
      ["you", ["a"]],
      ["move", ["b"]],
      ["land", ["c"]],
    ]);
    expect(model.counts).toEqual({ you: 1, move: 1, quiet: 0, land: 1, plan: 0, drop: 0 });
    expect(model.since).toEqual({ at: look.at, merged: 1, dropped: 0 });
    expect(model.earlier.map((l) => l.id)).toEqual(["e", "d"]);
    // The clock reaches back past the last look, six hours at least.
    expect(model.span).toEqual({ from: NOW - 6 * GRID_HOUR, to: NOW });
  });

  test("a landed line only counted is in the Since count until seen", () => {
    const model = gridModel([thread({ id: "old", section: "quiet", sent: null, pulls: [pull({ state: "merged", read_at: ago(20 * 60) })], seen: lookAt(21 * 60) })], NOW);
    expect(model.groups).toEqual([]);
    expect(model.counted.map((l) => l.id)).toEqual(["old"]);
    expect(model.since).toEqual({ at: NOW - 21 * 60 * GRID_MIN, merged: 1, dropped: 0 });
  });

  test("a linked computer's thread is a line like any other, with its computer", () => {
    const model = gridModel([thread({ id: "far", machine: "ibx_mini" })], NOW);
    expect(model.groups[0]!.lines[0]!.machine).toBe("ibx_mini");
  });

  test("Moving keeps an agent's lines together, the busiest agent first, PRs before plain work", () => {
    const ops = { key: "ops", name: "harbor ops", host: "claude-code" };
    const model = gridModel(
      [
        thread({ id: "fern1", created_at: ago(300) }),
        thread({ id: "ops1", agent: ops, created_at: ago(100) }),
        thread({ id: "ops2", agent: ops, created_at: ago(50), pulls: [pull({ added_at: ago(10) })] }),
      ],
      NOW,
    );
    expect(model.groups[0]!.lines.map((l) => l.id)).toEqual(["ops2", "ops1", "fern1"]);
  });

  test("kept between reads: an unchanged thread keeps its line object, a changed one gets a new one", () => {
    const derive = createGridModel();
    const a = thread({ id: "a" });
    const b = thread({ id: "b", pulls: [pull()] });
    const first = derive([a, b], NOW);
    // A new read: new objects with the same contents, and b's checks changed.
    const second = derive([{ ...a }, { ...b, pulls: [pull({ checks: "running" })] }], NOW);
    const line = (m: typeof first, id: string) => m.groups.flatMap((g) => g.lines).find((l) => l.id === id)!;
    expect(line(second, "a")).toBe(line(first, "a"));
    expect(line(second, "b")).not.toBe(line(first, "b"));
    expect(line(second, "b").detail?.words).toBe("tests running");
  });

  test("the minute works out again only the lines whose bar runs to now; a landed line waits for its mark", () => {
    const derive = createGridModel();
    const landed = thread({ id: "land", pulls: [pull({ state: "merged", added_at: ago(90), read_at: ago(30) })], seen: { through: NOW, at: NOW } });
    const moving = thread({ id: "move", running: true });
    const line = (m: ReturnType<typeof derive>, id: string) => [...m.groups.flatMap((g) => g.lines), ...m.earlier].find((l) => l.id === id);
    const first = derive([landed, moving], NOW);
    const later = derive([{ ...landed }, { ...moving }], NOW + GRID_MIN);
    expect(line(later, "land")).toBe(line(first, "land"));
    expect(line(later, "move")).not.toBe(line(first, "move"));
    // Seen, it leaves for Earlier at its three hours: the clock alone moves it.
    const past = derive([landed, moving], NOW + 3 * GRID_HOUR);
    expect(past.groups.flatMap((g) => g.lines).map((l) => l.id)).toEqual(["move"]);
    expect(past.earlier.map((l) => l.id)).toEqual(["land"]);
  });
});

describe("words", () => {
  test("lengths round as the line says them and as the readout does", () => {
    expect([gridRounded(32 * GRID_MIN), gridRounded(95 * GRID_MIN), gridRounded(130 * GRID_MIN), gridRounded(30 * GRID_HOUR), gridRounded(3 * GRID_DAY)]).toEqual(["32 min", "1.5 h", "2 h", "1 d", "3 d"]);
    expect([gridExact(40 * GRID_MIN), gridExact(130 * GRID_MIN), gridExact(4 * GRID_HOUR + 5 * GRID_MIN)]).toEqual(["40 min", "2 h 10 min", "4 h"]);
    expect([gridSpoken("1.5 h"), gridSpoken("1 h"), gridSpoken("32 min"), gridSpoken("3 d")]).toEqual(["1.5 hours", "1 hour", "32 minutes", "3 days"]);
  });

  test("the bar in words: the last piece is where the work is, at most three, the oldest cut first", () => {
    const line = gridPlace(thread({ section: "stopped", waiting_since: ago(32), open: 1, pulls: [pull()] }), NOW)!.line;
    const said = gridSaid(line);
    expect(said.cut).toBe(false);
    expect(said.pieces.map((p) => `${p.name} ${p.length}${p.on ? " (now)" : ""}`)).toEqual(["Working 2 h", "PR 40 min", "Needs you 32 min (now)"]);
    expect(gridSaid(line, { phone: false, room: 20 }).cut).toBe(true);
    // A merged line ends at Merged: none of its pieces is "now".
    const landed = gridPlace(thread({ pulls: [pull({ state: "merged", read_at: ago(11) })] }), NOW)!.line;
    expect(gridSaid(landed).pieces.some((p) => p.on)).toBe(false);
  });

  test("checks and the review follow the last piece; a closed or merged PR has none", () => {
    expect(gridPlace(thread({ pulls: [pull({ checks: "failing" })] }), NOW)!.line.detail).toEqual({ words: "tests failing", bad: true });
    expect(gridPlace(thread({ pulls: [pull({ checks: "passing", review: "approved" })] }), NOW)!.line.detail?.words).toBe("reviewed");
    expect(gridPlace(thread({ pulls: [pull({ state: "draft" })] }), NOW)!.line.detail?.words).toBe("draft");
    expect(gridPlace(thread({ pulls: [pull({ state: "merged", read_at: ago(5), checks: "failing" })] }), NOW)!.line.detail).toBeNull();
  });

  test("Landed is named by when its work landed, not by the hour now", () => {
    const at = (iso: string) => Date.parse(iso);
    // Local time is UTC here (offset 0). Monday 11:42 PM: all since 6 PM is tonight; with a merge from the morning, today.
    const mon = at("2026-11-23T23:42:00Z");
    expect(gridLandedWord([at("2026-11-23T21:40:00Z"), at("2026-11-23T23:31:00Z")], mon, 0)).toBe("tonight");
    expect(gridLandedWord([at("2026-11-23T09:10:00Z"), at("2026-11-23T23:31:00Z")], mon, 0)).toBe("today");
    // Tuesday 7:10 AM: merges from last night and the small hours are overnight.
    const tue = at("2026-11-24T07:10:00Z");
    expect(gridLandedWord([at("2026-11-23T23:50:00Z"), at("2026-11-24T03:40:00Z")], tue, 0)).toBe("overnight");
    // Older than that: no word.
    expect(gridLandedWord([at("2026-11-21T10:00:00Z")], tue, 0)).toBeNull();
    // The same instant in a zone five and a half hours east is another time of day.
    expect(gridLandedWord([at("2026-11-23T13:00:00Z")], at("2026-11-23T14:00:00Z"), 330)).toBe("tonight");
  });
});

describe("the clock", () => {
  const zone = process.env.TZ;
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  test("ticks fall on local whole hours, in a zone half an hour off UTC too", () => {
    process.env.TZ = "Asia/Kolkata";
    const from = Date.parse("2026-11-23T10:10:00Z");
    const ticks = gridHourTicks(from, from + 6 * GRID_HOUR);
    expect(ticks.length).toBe(6);
    for (const at of ticks) expect(new Date(at).getMinutes()).toBe(0);
    // 10:30 UTC is 4 PM there: the first tick.
    expect(ticks[0]).toBe(Date.parse("2026-11-23T10:30:00Z"));
  });
});
