/**
 * Grid round 4 (approval "inbox-agent-grid", 2026-11-24, built 2026-11-25): Stale, Nudge's offer and its words. Each
 * case is a thread as the window passes it and the time.
 */
import { describe, expect, test } from "bun:test";
import { GRID_HOUR, GRID_MIN, gridExact, gridModel, gridPlace, gridSaid, type GridAction, type GridNudgeIn, type GridPullIn, type GridThreadIn } from "./grid";
import { GRID_NUDGE_ASK, gridNudgeWords } from "./grid-nudge";
import { gridNudgeKey, gridNudgeKeyRead } from "./grid-nudge-key";

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
    nudge: nudgeIn(),
    ...over,
  };
}
/** A row's Nudge as the window passes it: its agent tide-ios live, nothing held, refused or taken back. */
function nudgeIn(over: Partial<GridNudgeIn> = {}): GridNudgeIn {
  return { to: "msg_last", seq: 9, agent: { name: "tide-ios", live: true }, taken: 0, last: null, held: null, refused: null, ...over };
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

  test("the words after the bar make room for why it is stale: the oldest pieces go, never the detail", () => {
    // "Working 50 min › PR 1 h › Stale 3.5 h · tests failing" is past the room: Working goes to "…".
    const failing = line(thread({ created_at: ago(330), last_agent_at: ago(210), pulls: [pull({ checks: "failing", added_at: ago(270) })] }));
    expect(failing.detail?.words).toBe("tests failing");
    const said = gridSaid(failing);
    expect(said.cut).toBe(true);
    expect(said.pieces.map((p) => p.name)).toEqual(["PR", "Stale"]);
    // A tighter room keeps the last piece alone, still with its detail after it.
    expect(gridSaid(failing, { phone: false, room: 30 }).pieces.map((p) => p.name)).toEqual(["Stale"]);
    // A stale plan says "Planned 7:20 PM" before its piece; with its detail it still fits.
    const plan = line(thread({ created_at: ago(14 * 60), last_agent_at: null, sent: { at: ago(14 * 60), checked_at: null } }));
    expect(gridSaid(plan)).toEqual({ cut: false, pieces: [expect.objectContaining({ name: "Stale" })] });
  });

  test("anything happening brings it back to Moving: a PR put on, a check run seen to start or end, a step, a message", () => {
    const quiet = { last_agent_at: ago(240) };
    expect(line(thread(quiet)).group).toBe("stale");
    expect(line(thread({ ...quiet, pulls: [pull({ added_at: ago(2) })] })).group).toBe("move");
    // A push starts a check run: its checks seen to change two minutes ago is movement; a run seen to end is too.
    expect(line(thread({ ...quiet, pulls: [pull({ checks: "running", checks_at: ago(2) })] })).group).toBe("move");
    expect(line(thread({ ...quiet, pulls: [pull({ checks: "failing", checks_at: ago(30) })] })).group).toBe("quiet");
    // A change not seen happen (no time) is no movement; a closed PR's checks are not this work's.
    expect(line(thread({ ...quiet, pulls: [pull({ checks: "failing", checks_at: null })] })).group).toBe("stale");
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
  test("offered on a stale line whose thread names where a reply goes and whose agent there is live; named as that agent", () => {
    const stale = thread({ last_agent_at: ago(217) });
    const nudge = nudgeOf(stale)!;
    expect([nudge.to, nudge.quietFrom, nudge.agent]).toEqual(["msg_last", NOW - 217 * GRID_MIN, "tide-ios"]);
    expect(nudgeOf(thread({ last_agent_at: ago(100) }))).toBeNull();
    expect(nudgeOf({ ...stale, nudge: null })).toBeNull();
    // After a hand-off the nudge goes to the new owner, and the line says so whoever its own agent is.
    const handed = thread({ last_agent_at: ago(217), nudge: nudgeIn({ agent: { name: "harbor review", live: true } }) });
    expect([nudgeOf(handed)!.agent, line(handed).nudgeTo]).toEqual(["harbor review", "harbor review"]);
  });

  test("an agent whose session is not known to be live (killed, asleep, not listed) is offered no Nudge; the line stays Stale", () => {
    for (const agent of [{ name: "tide-ios", live: false }, { name: "tide-ios", live: null }, null]) {
      const quiet = thread({ last_agent_at: ago(217), nudge: nudgeIn({ agent }) });
      expect([line(quiet).group, nudgeOf(quiet)]).toEqual(["stale", null]);
    }
  });

  test("once nudged, the line says so and has no Nudge until three more quiet hours; the nudge's own delivery is not movement", () => {
    const nudgedAt = ago(5);
    const nudged = thread({
      last_agent_at: ago(222),
      section: "sent",
      sent: { at: nudgedAt, checked_at: ago(4) },
      nudge: nudgeIn({ seq: 10, last: { at: nudgedAt, quiet_from: ago(222), answered_at: null } }),
    });
    const now = line(nudged);
    expect(now.group).toBe("stale");
    expect(now.nudged).toEqual({ at: NOW - 5 * GRID_MIN, now: true, held: null });
    expect(nudgeOf(nudged)).toBeNull();
    // Three more quiet hours: Nudge again, in a later turn of the stretch (another key).
    const later = NOW + 3 * GRID_HOUR;
    expect(nudgeOf(nudged, later)!.turn).toBeGreaterThan(nudgeOf(thread({ last_agent_at: ago(222) }))!.turn);
  });

  test("the turn's edge (6 h quiet): a nudge sent at 5 h 59 min leaves no Nudge at 6 h, though the turn number moved", () => {
    const pressed = thread({ created_at: ago(400), last_agent_at: ago(359) });
    expect(nudgeOf(pressed)!.turn).toBe(1);
    expect(nudgeOf(pressed, NOW + 1 * GRID_MIN)!.turn).toBe(2);
    const nudged = thread({ created_at: ago(400), last_agent_at: ago(359), nudge: nudgeIn({ last: { at: ago(0), quiet_from: ago(359), answered_at: null } }) });
    expect(nudgeOf(nudged, NOW + 1 * GRID_MIN)).toBeNull();
    expect(nudgeOf(nudged, NOW + 3 * GRID_HOUR - GRID_MIN)).toBeNull();
    expect(nudgeOf(nudged, NOW + 3 * GRID_HOUR)!.turn).toBe(2);
  });

  test("a nudge held for an away computer is nudged: no second Nudge in any turn while it waits, and the readout says what the outbox says", () => {
    const held = thread({ last_agent_at: ago(359), nudge: nudgeIn({ held: { at: ago(3), words: "Will send when Mac mini is back" } }) });
    expect(line(held).nudged).toEqual({ at: NOW - 3 * GRID_MIN, now: true, held: "Will send when Mac mini is back" });
    for (const later of [0, 2 * GRID_MIN, 3 * GRID_HOUR, 9 * GRID_HOUR]) expect(nudgeOf(held, NOW + later)).toBeNull();
  });

  test("a held nudge its computer refused (the work moved meanwhile): the line says why and offers none in that stretch; a new stretch can", () => {
    const words = "Not delivered: The work moved on after this nudge was pressed, so it was not sent.";
    const refused = thread({ last_agent_at: ago(217), nudge: nudgeIn({ refused: { words, quiet_from: NOW - 217 * GRID_MIN } }) });
    expect([line(refused).refused, nudgeOf(refused)]).toEqual([words, null]);
    const anew = thread({ last_agent_at: ago(190), nudge: nudgeIn({ refused: { words, quiet_from: NOW - 217 * GRID_MIN } }) });
    expect([line(anew).refused, nudgeOf(anew)?.kind]).toEqual([null, "nudge"]);
  });

  test("a press is one key for its stretch and turn: two windows or a held copy write one nudge; a Take back makes the next press a new write", () => {
    const stale = thread({ last_agent_at: ago(217) });
    const keyOf = (a: Extract<GridAction, { kind: "nudge" }>) => gridNudgeKey({ thread: a.thread, quietFrom: a.quietFrom, turn: a.turn, taken: a.taken });
    expect(keyOf(nudgeOf(stale)!)).toBe(keyOf(nudgeOf(stale, NOW + 20 * GRID_MIN)!));
    // Taken back: the row's last nudge is gone and `taken` counts it, so Nudge is offered again under a new key.
    const taken = thread({ last_agent_at: ago(217), nudge: nudgeIn({ taken: 1 }) });
    expect(keyOf(nudgeOf(taken)!)).not.toBe(keyOf(nudgeOf(stale)!));
    // The key is read back as it was made.
    const key = keyOf(nudgeOf(taken)!);
    expect(gridNudgeKeyRead(key)).toEqual({ thread: "msg_haptics", quietFrom: NOW - 217 * GRID_MIN, turn: 1, taken: 1 });
    expect(gridNudgeKeyRead("reply-1234")).toBeNull();
  });

  test("the agent answers: Moving again, and the nudged stretch stays on the bar as Stale up to the answer", () => {
    const answered = thread({
      last_agent_at: ago(1),
      pulls: [pull({ added_at: ago(250), checks: "running" })],
      nudge: nudgeIn({ to: "msg_answer", seq: 11, last: { at: ago(17), quiet_from: ago(233), answered_at: ago(1) } }),
    });
    const moved = line(answered);
    expect(moved.group).toBe("move");
    expect(moved.nudged).toEqual({ at: NOW - 17 * GRID_MIN, now: false, held: null });
    expect(moved.pieces.map((p) => p.kind)).toEqual(["work", "pr", "stale", "pr"]);
    expect(moved.pieces[2]).toEqual({ kind: "stale", from: NOW - 233 * GRID_MIN, to: NOW - 1 * GRID_MIN });
  });

  test("the words: the line's name, how long it has been quiet, one detail, then the approved sentence", () => {
    const failing = line(thread({ last_agent_at: ago(217), pulls: [pull({ checks: "failing" })] }));
    // No "since …" when the change was not seen happen: the quiet stretch's start would say something else.
    expect(gridNudgeWords(failing, NOW, at)).toBe("Haptics on save has been quiet for 3 h 37 min, with tests failing on #22. Please finish it, or tell me in a few words why it stopped.");
    // Seen to start failing (its checks' change is the stretch's start): "since" that time.
    const seen = line(thread({ last_agent_at: ago(240), pulls: [pull({ checks: "failing", checks_at: ago(217) })] }));
    expect(gridNudgeWords(seen, NOW, at)).toBe(`Haptics on save has been quiet for 3 h 37 min, with tests failing on #22 since 01:05. ${GRID_NUDGE_ASK}`);
    const unlabelled = line(thread({ last_agent_at: ago(217), pulls: [pull({ label: null, checks: "failing" })] }));
    expect(gridNudgeWords(unlabelled, NOW, at)).toBe(`Haptics on save has been quiet for 3 h 37 min, with tests failing. ${GRID_NUDGE_ASK}`);
    const draft = line(thread({ name: "Pricing page hero", last_agent_at: ago(7 * 60), created_at: ago(8 * 60), pulls: [pull({ label: "#7", state: "draft", added_at: ago(7 * 60 + 5) })] }));
    expect(gridNudgeWords(draft, NOW, at)).toBe(`Pricing page hero has been quiet for 7 h, with #7 still a draft. ${GRID_NUDGE_ASK}`);
    // A draft with no PR label: no detail (approved forms only).
    const bare = line(thread({ name: "Pricing page hero", last_agent_at: ago(7 * 60), created_at: ago(8 * 60), pulls: [pull({ label: null, state: "draft", added_at: ago(7 * 60 + 5) })] }));
    expect(gridNudgeWords(bare, NOW, at)).toBe(`Pricing page hero has been quiet for 7 h. ${GRID_NUDGE_ASK}`);
    // A day and more: to the hour, never a loose "1 d".
    const long = line(thread({ name: "Nightly summary", created_at: ago(40 * 60), last_agent_at: ago(30 * 60 + 12) }));
    expect(gridNudgeWords(long, NOW, at)).toBe(`Nightly summary has been quiet for 1 d 6 h. ${GRID_NUDGE_ASK}`);
    expect([gridExact(30 * GRID_HOUR), gridExact(30 * GRID_HOUR, true), gridExact(4 * GRID_HOUR + 5 * GRID_MIN), gridExact(4 * GRID_HOUR + 5 * GRID_MIN, true)]).toEqual(["1 d", "1 d 6 h", "4 h", "4 h 5 min"]);
    const plan = line(thread({ name: "Receipts by email", created_at: ago(14 * 60), last_agent_at: null, sent: { at: ago(14 * 60), checked_at: null } }));
    expect(gridNudgeWords(plan, NOW, at)).toBe(`Receipts by email has been quiet for 14 h, planned at 14:42 and not started. ${GRID_NUDGE_ASK}`);
    const plain = line(thread({ name: "Nightly summary", last_agent_at: ago(186) }));
    expect(gridNudgeWords(plain, NOW, at)).toBe(`Nightly summary has been quiet for 3 h 6 min. ${GRID_NUDGE_ASK}`);
    expect(GRID_NUDGE_ASK).toBe("Please finish it, or tell me in a few words why it stopped.");
  });
});
