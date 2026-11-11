import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DECISION_LINES_FILE, DecisionDataAborted, decisionDataCsv, decisionDataSummary, readDecisionLines, runInSlices, trendsOf, type DecisionRow } from "./decision-data";
import { InboxStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");

function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-decision-data-")));
  dirs.push(dir);
  let clock = NOW - 10 * DAY;
  const store = InboxStore.open(dir, { now: () => new Date((clock += 1000)) });
  const project = store.ensureProject({ name: "harbor", root: join(dir, "harbor") });
  const claude = { kind: "agent" as const, host: "claude-code", session: "ses-c", name: null };
  let keys = 0;
  const key = () => `k${keys++}`;
  const ask = (input: { project?: string; author?: typeof claude; recommended?: boolean; stopped?: boolean; prompt?: string; extra?: object } = {}) =>
    store.sendMessage({
      project_id: input.project ?? project.id,
      author: input.author ?? claude,
      body: `:::question\n${input.prompt ?? "Pick one?"}\n\nContext.\n${input.stopped ? "\nStopped: on this one.\n" : ""}\n- [ ] A\n- [ ] B\n${input.recommended === false ? "" : "\nRecommended: A\n"}:::`,
      thread: `t${keys}`,
      idempotency_key: key(),
      ...input.extra,
    }).message;
  const q = (id: string) => store.questionsOf(id)[0]!;
  const pick = (id: string, label: string | null, extra: object = {}) =>
    store.savePicks(id, [{ key: q(id).key, revision: q(id).revision, answer: { v: 1, key: q(id).key, kind: "single", prompt: q(id).prompt, selected: label ? [label] : [], ...extra } }]);
  const send = (id: string) => store.sendReply(id, { questions: [{ key: q(id).key, revision: q(id).revision }], idempotency_key: key() });
  const answer = (id: string, label: string) => {
    pick(id, label);
    return send(id);
  };
  const summary = async (query: { since?: number | null; tz?: number } = {}) =>
    decisionDataSummary({ ...store.decisionDataInput(), deleted: await readDecisionLines(store.dir) }, { since: query.since ?? null, until: NOW, tz_offset_min: query.tz ?? 0, now: NOW });
  const csv = async (since: number | null = null) => decisionDataCsv({ ...store.decisionDataInput(), deleted: await readDecisionLines(store.dir) }, since);
  return { dir, store, project, claude, ask, q, pick, send, answer, summary, csv, key, tick: (ms: number) => (clock += ms) };
}

describe("what counts as what", () => {
  test("each way a question can end is counted once, as what it is; action items and the person's own messages are not questions", async () => {
    const w = world();
    const took = w.ask();
    w.answer(took.id, "A");
    const other = w.ask();
    w.answer(other.id, "B");
    const noRecommendation = w.ask({ recommended: false });
    w.answer(noRecommendation.id, "A");
    const skipped = w.ask();
    w.pick(skipped.id, null, { skipped: true });
    w.send(skipped.id);
    const plain = w.ask();
    w.store.sendReply(plain.id, { words: "Go with the simpler one.", idempotency_key: w.key() });
    const replaced = w.ask();
    w.pick(replaced.id, "A");
    w.store.sendMessage({ project_id: w.project.id, author: w.claude, body: "Changed my mind.", reply_to: replaced.id, supersedes: [replaced.id], idempotency_key: w.key() });
    const closed = w.ask();
    w.store.markRead(closed.thread_id, true);
    const unsent = w.ask();
    w.pick(unsent.id, "A");
    const open = w.ask();
    w.store.sendMessage({ project_id: w.project.id, author: w.claude, body: ":::action\nDo the thing.\n:::", thread: "action", idempotency_key: w.key() });

    const summary = await w.summary();
    expect(summary.history.asked).toBe(9);
    expect(summary.counts).toEqual({ answered: 3, skipped: 1, set_aside: 1, replaced: 1 });
    expect(summary.waiting).toBe(3);
    void open;
    expect(summary.recommendation).toEqual({ offered: 2, taken: 1 });
    expect(summary.settled_in_words).toBe(1);
    expect(summary.agents[0]).toMatchObject({ label: "Claude Code", host: "claude-code", answered: 3, skipped: 1, set_aside: 1, replaced: 1 });
  });

  test("the range cuts decisions by when they were made, while what waits and the history stay whole", async () => {
    const w = world();
    const old = w.ask();
    w.answer(old.id, "A");
    w.tick(9 * DAY);
    const recent = w.ask();
    w.answer(recent.id, "A");
    const waiting = w.ask();
    void waiting;
    const inRange = await w.summary({ since: NOW - 3 * DAY });
    expect(inRange.counts.answered).toBe(1);
    expect(inRange.history).toMatchObject({ asked: 3, answered: 2 });
    expect(inRange.waiting).toBe(1);
    expect(inRange.days.map((d) => d.answered)).toEqual([1]);
    expect((await w.summary()).counts.answered).toBe(2);
  });

  test("days are the reader's: the same moment lands on another day east of the date line", async () => {
    const w = world();
    const late = w.ask();
    // 10 days before NOW is 12:00Z; at +840 minutes that clock reads 02:00 the next day.
    w.answer(late.id, "A");
    const utc = await w.summary({ tz: 0 });
    const east = await w.summary({ tz: 840 });
    expect(utc.days.map((d) => d.day)).toEqual(["2026-10-26"]);
    expect(east.days.map((d) => d.day)).toEqual(["2026-10-27"]);
  });

  test("a combined project counts as the one the person sees", async () => {
    const w = world();
    const other = w.store.ensureProject({ name: "harbor-worktree", root: join(w.dir, "harbor-worktree") });
    const a = w.ask();
    w.answer(a.id, "A");
    const b = w.ask({ project: other.id });
    w.answer(b.id, "A");
    expect((await w.summary()).projects.length).toBe(2);
    w.store.combineProject(other.id, w.project.id);
    const combined = await w.summary();
    expect(combined.projects.length).toBe(1);
    expect(combined.projects[0]).toMatchObject({ id: w.project.id, answered: 2 });
  });

  test("who asks most comes first, by the decisions the table shows, whatever was skipped", async () => {
    const w = world();
    const others = w.store.ensureProject({ name: "bay", root: join(w.dir, "bay") });
    w.answer(w.ask().id, "A");
    for (let i = 0; i < 3; i++) {
      const skipped = w.ask();
      w.pick(skipped.id, null, { skipped: true });
      w.send(skipped.id);
    }
    w.answer(w.ask({ project: others.id }).id, "A");
    w.answer(w.ask({ project: others.id }).id, "A");
    expect((await w.summary()).projects.map((p) => p.label)).toEqual(["bay", "harbor"]);
  });

  test("pressing Re-ask is not the person's words: not a plain reply on the chart, and not an end in their own words", async () => {
    const w = world();
    const reasked = w.ask();
    w.store.sendReask(reasked.id, { idempotency_key: w.key() });
    const pressed = await w.summary();
    expect(pressed.days.map((d) => d.own_words)).toEqual([]);
    expect(pressed.settled_in_words).toBe(0);

    w.store.sendMessage({ project_id: w.project.id, author: w.claude, body: "No longer needed.", reply_to: reasked.id, supersedes: [reasked.id], idempotency_key: w.key() });
    const replaced = await w.summary();
    expect(replaced.counts.replaced).toBe(1);
    expect(replaced.settled_in_words).toBe(0);
    expect(replaced.days.map((d) => d.own_words)).toEqual([]);

    const typed = w.ask();
    w.store.sendReply(typed.id, { words: "Go with the simpler one.", idempotency_key: w.key() });
    const after = await w.summary();
    expect(after.settled_in_words).toBe(1);
    expect(after.days.map((d) => d.own_words)).toEqual([1]);
  });

  test("a Re-asked question waits on the agent, not the person, as the Inbox's own count reads it, until the agent writes again", async () => {
    const w = world();
    const agrees = async (waiting: number) => {
      expect((await w.summary()).waiting).toBe(waiting);
      expect(w.store.openDecisions().length).toBe(waiting);
    };
    const asked = w.ask();
    await agrees(1);
    w.store.sendReask(asked.id, { idempotency_key: w.key() });
    await agrees(0);
    w.store.sendMessage({ project_id: w.project.id, author: w.claude, body: "Still looking.", reply_to: asked.id, idempotency_key: w.key() });
    await agrees(1);
  });

  test("a Re-ask leaves the rest waiting: a pick made since, and another session's question in the thread", async () => {
    const w = world();
    const two = ":::question\nFirst?\n\n- [ ] A\n- [ ] B\n:::\n\n:::question\nSecond?\n\n- [ ] A\n- [ ] B\n:::";
    const asked = w.store.sendMessage({ project_id: w.project.id, author: w.claude, body: two, thread: "two", idempotency_key: w.key() }).message;
    const other = { kind: "agent" as const, host: "codex", session: "ses-o", name: null };
    w.store.sendMessage({ project_id: w.project.id, author: other, body: ":::question\nAnother session's?\n\n- [ ] A\n- [ ] B\n:::", reply_to: asked.id, idempotency_key: w.key() });
    w.store.sendReask(asked.id, { idempotency_key: w.key() });
    expect((await w.summary()).waiting).toBe(1);
    expect(w.store.openDecisions().length).toBe(1);

    const [first] = w.store.questionsOf(asked.id);
    w.store.savePicks(asked.id, [{ key: first!.key, revision: first!.revision, answer: { v: 1, key: first!.key, kind: "single", prompt: first!.prompt, selected: ["A"] } }]);
    expect((await w.summary()).waiting).toBe(2);
    expect(w.store.openDecisions().length).toBe(2);
  });

  test("a thread that came back: what the agent asked after the archive waits on the person as the Inbox says, and what the archive closed does not", async () => {
    const w = world();
    const closed = w.ask({ prompt: "Before the archive?" });
    w.store.resolveThread(closed.thread_id, true, "person");
    expect((await w.summary()).waiting).toBe(0);

    const again = w.store.sendMessage({ project_id: w.project.id, author: w.claude, body: ":::question\nAfter the archive?\n\n- [ ] A\n- [ ] B\n:::", reply_to: closed.id, idempotency_key: w.key() }).message;
    expect(w.store.message(closed.thread_id)!.resolved_at).not.toBeNull();
    expect(w.store.questionsOf(again.id)[0]!.state).toBe("open");
    expect(w.store.questionsOf(closed.id)[0]!.state).not.toBe("open");
    expect((await w.summary()).waiting).toBe(1);
    const fates = (await w.csv()).trim().split("\n").slice(1).map((line) => line.split(",")[5]);
    expect(fates.sort()).toEqual(["archived", "open"]);

    w.pick(again.id, "A");
    expect((await w.summary()).waiting).toBe(1);
    w.send(again.id);
    const answered = await w.summary();
    expect(answered.waiting).toBe(0);
    expect(answered.counts.answered).toBe(1);
  });

  test("archiving does not undo an answer: an answered question in an archived thread stays a decision", async () => {
    const w = world();
    const answered = w.ask();
    w.answer(answered.id, "A");
    const picked = w.ask();
    w.pick(picked.id, "A");
    w.store.resolveThread(answered.thread_id, true, "person");
    w.store.resolveThread(picked.thread_id, true, "person");
    const summary = await w.summary();
    expect(summary.counts.answered).toBe(1);
    expect(summary.history.answered).toBe(1);
    expect(summary.recommendation).toEqual({ offered: 1, taken: 1 });
    expect(summary.waiting).toBe(0);
    const fates = (await w.csv()).trim().split("\n").slice(1).map((line) => line.split(",")[5]);
    expect(fates.sort()).toEqual(["answered", "archived"]);
  });

  test("a project's numbers wait for enough behind them: the usual wait needs five answers", async () => {
    const w = world();
    for (let i = 0; i < 4; i++) w.answer(w.ask().id, "A");
    expect((await w.summary()).projects[0]!.median_wait_ms).toBeNull();
    w.answer(w.ask().id, "A");
    expect((await w.summary()).projects[0]!.median_wait_ms).not.toBeNull();
  });
});

const row = (at: number, over: Partial<DecisionRow> = {}): DecisionRow => ({
  id: `q${at}`,
  thread_id: "t",
  project_id: "p",
  agent: "Claude Code",
  kind: "single",
  asked_at: at - 60_000,
  answered_at: at,
  sent_at: at,
  fate: "answered",
  took: null,
  offered: false,
  stopped: false,
  holds_up: false,
  files: false,
  revisions: 1,
  ...over,
});

function period(which: "recent" | "before", n: number, make: (index: number, at: number) => Partial<DecisionRow>): DecisionRow[] {
  const from = which === "recent" ? NOW - 29 * DAY : NOW - 59 * DAY;
  return Array.from({ length: n }, (_, index) => {
    const at = from + (index + 1) * Math.floor((28 * DAY) / (n + 1));
    return row(at, make(index, at));
  });
}
const takes = (hits: number) => (index: number) => ({ took: index < hits, offered: true });
const HISTORY = NOW - 70 * DAY;

describe("trends", () => {
  test("a real change in recommendations taken is a line with its direction and both numbers", () => {
    const rows = [...period("before", 100, takes(60)), ...period("recent", 100, takes(90))];
    expect(trendsOf(rows, NOW, HISTORY)).toEqual([{ key: "recommendations", direction: "up", now: 0.9, was: 0.6 }]);
    const down = [...period("before", 100, takes(90)), ...period("recent", 100, takes(60))];
    expect(trendsOf(down, NOW, HISTORY)[0]).toMatchObject({ key: "recommendations", direction: "down" });
  });

  test("no line when the history does not cover both full periods, whatever the numbers say", () => {
    const rows = [...period("before", 100, takes(60)), ...period("recent", 100, takes(90))];
    expect(trendsOf(rows, NOW, NOW - 59 * DAY)).toEqual([]);
    expect(trendsOf(rows, NOW, null)).toEqual([]);
    expect(trendsOf(rows, NOW, NOW - 60 * DAY)).not.toEqual([]);
  });

  test("no line under 20 in either period", () => {
    const rows = [...period("before", 19, takes(0)), ...period("recent", 19, takes(19))];
    expect(trendsOf(rows, NOW, HISTORY)).toEqual([]);
    const enough = [...period("before", 20, takes(0)), ...period("recent", 20, takes(20))];
    expect(trendsOf(enough, NOW, HISTORY).length).toBe(1);
  });

  test("no line for a change under five points, even on so many answers that chance could not explain it", () => {
    const rows = [...period("before", 20000, takes(10000)), ...period("recent", 20000, takes(10900))];
    expect(trendsOf(rows, NOW, HISTORY)).toEqual([]);
    const five = [...period("before", 20000, takes(10000)), ...period("recent", 20000, takes(11100))];
    expect(trendsOf(five, NOW, HISTORY).length).toBe(1);
  });

  test("no line for a change that chance can explain", () => {
    const rows = [...period("before", 25, takes(12)), ...period("recent", 25, takes(16))];
    expect(trendsOf(rows, NOW, HISTORY)).toEqual([]);
  });

  test("skipping is a share of decisions by when they were decided", () => {
    const skips = (hits: number) => (index: number) => ({ fate: index < hits ? ("skipped" as const) : ("answered" as const) });
    const rows = [...period("before", 100, skips(5)), ...period("recent", 100, skips(30))];
    expect(trendsOf(rows, NOW, HISTORY)).toEqual([{ key: "skips", direction: "up", now: 0.3, was: 0.05 }]);
  });

  const waited = (minutes: number) => (index: number, at: number) => ({ stopped: true, asked_at: at - (minutes + index) * 60_000, sent_at: at });

  test("stopped agents' middle wait is a line when it moves a quarter or more, by when the agent asked", () => {
    const rows = [...period("before", 40, waited(600)), ...period("recent", 40, waited(120))];
    const [line] = trendsOf(rows, NOW, HISTORY);
    expect(line).toMatchObject({ key: "waits", direction: "down" });
    expect(line && "now_ms" in line ? [line.now_ms, line.was_ms] : []).toEqual([140 * 60_000, 620 * 60_000]);
    const small = [...period("before", 40, waited(100)), ...period("recent", 40, waited(80))];
    expect(trendsOf(small, NOW, HISTORY)).toEqual([]);
  });

  test("still-open stopped questions count as the longest wait, so a recent period cannot claim waits fell just because its slow half is unanswered", () => {
    const before = period("before", 40, waited(600));
    const recent = period("recent", 55, (index, at) => (index < 25 ? waited(30)(index, at) : { stopped: true, asked_at: at, answered_at: null, sent_at: null, fate: "open" as const }));
    expect(trendsOf([...before, ...recent], NOW, HISTORY)).toEqual([]);
    expect(trendsOf([...before, ...recent.filter((r) => r.fate !== "open")], NOW, HISTORY)[0]).toMatchObject({ key: "waits", direction: "down" });
  });

  test("three changes make three lines, in the approved order", () => {
    const before = period("before", 100, (index, at) => ({ ...takes(60)(index), ...(index >= 95 ? { fate: "skipped" as const, took: null } : {}), ...(index < 40 ? waited(600)(index, at) : {}) }));
    const recent = period("recent", 100, (index, at) => ({ ...takes(90)(index), ...(index >= 70 ? { fate: "skipped" as const, took: null } : {}), ...(index < 40 ? waited(60)(index, at) : {}) }));
    expect(trendsOf([...before, ...recent], NOW, HISTORY).map((t) => t.key)).toEqual(["recommendations", "waits", "skips"]);
  });

  describe("whole days", () => {
    const MIDNIGHT = Date.parse("2026-11-05T00:00:00Z");
    const onEdge = () => {
      const spread = (from: number, n: number, hits: number) => Array.from({ length: n }, (_, index) => row(from + (index + 1) * 3 * 3_600_000, { id: `r${from}-${index}`, offered: true, took: index < hits }));
      const edge = Array.from({ length: 5 }, (_, index) => row(MIDNIGHT - 30 * DAY + 12.5 * 3_600_000 + index, { id: `edge-${index}`, offered: true, took: true }));
      return [...spread(MIDNIGHT - 58 * DAY, 60, 30), ...spread(MIDNIGHT - 20 * DAY, 55, 40), ...edge];
    };

    test("on unchanged data every hour of a day reads the same, across the moment a sliding window would flip it", () => {
      const rows = onEdge();
      const first = trendsOf(rows, MIDNIGHT, MIDNIGHT - 90 * DAY);
      for (let hour = 0; hour < 24; hour++) {
        for (const minute of [0, 29, 31, 59]) expect(trendsOf(rows, MIDNIGHT + hour * 3_600_000 + minute * 60_000, MIDNIGHT - 90 * DAY)).toEqual(first);
      }
    });

    test("the periods meet at a UTC midnight, today counts in the recent one, and the next day may read differently", () => {
      const rows = [...period("before", 100, takes(60)), ...period("recent", 100, takes(90))];
      const end = Date.parse("2026-11-06T00:00:00Z");
      const cut = end - 30 * DAY;
      const start = end - 60 * DAY;
      const shares = (extra: DecisionRow[]) => trendsOf([...rows, ...extra], NOW, HISTORY)[0] as { now: number; was: number };
      const base = shares([]);
      const miss = (at: number) => [row(at, { id: `m${at}`, offered: true, took: false })];
      expect(shares(miss(NOW)).now).toBeLessThan(base.now);
      expect(shares(miss(end))).toEqual(base);
      expect(shares(miss(cut)).now).toBeLessThan(base.now);
      expect(shares(miss(cut - 1)).was).toBeLessThan(base.was);
      expect(shares(miss(start)).was).toBeLessThan(base.was);
      expect(shares(miss(start - 1))).toEqual(base);
    });
  });

  test("the summary's trends read the whole history, whatever range is showing", async () => {
    const w = world();
    w.tick(-70 * DAY + 10 * DAY);
    for (let i = 0; i < 25; i++) w.answer(w.ask({ prompt: `Old ${i}?` }).id, "B");
    w.tick(35 * DAY);
    for (let i = 0; i < 25; i++) w.answer(w.ask({ prompt: `Before ${i}?` }).id, "B");
    w.tick(30 * DAY);
    for (let i = 0; i < 25; i++) w.answer(w.ask({ prompt: `Recent ${i}?` }).id, "A");
    const narrow = await w.summary({ since: NOW - 7 * DAY });
    expect(narrow.trends.map((t) => t.key)).toContain("recommendations");
  });
});

describe("the slices", () => {
  function* busy(steps: number, ran: { steps: number }): Generator<void, string> {
    for (let i = 0; i < steps; i++) {
      const until = performance.now() + 1;
      while (performance.now() < until);
      ran.steps++;
      yield;
    }
    return "finished";
  }

  test("a long calculation gives the event loop back every few milliseconds, and still finishes", async () => {
    let turns = 0;
    let stop = false;
    const counting = () => {
      if (stop) return;
      turns++;
      setImmediate(counting);
    };
    setImmediate(counting);
    const value = await runInSlices(busy(40, { steps: 0 }));
    stop = true;
    expect(value).toBe("finished");
    // 40 ms of work at 4 ms a slice: anything held much longer would let far fewer turns through.
    expect(turns).toBeGreaterThanOrEqual(5);
  });

  test("a reader who left stops it: no more of the work runs", async () => {
    const controller = new AbortController();
    const ran = { steps: 0 };
    setImmediate(() => controller.abort());
    await expect(runInSlices(busy(5000, ran), controller.signal)).rejects.toBeInstanceOf(DecisionDataAborted);
    expect(ran.steps).toBeLessThan(100);
  });

  test("the summary and the CSV both give way over a store, and a reader who left stops either", async () => {
    const w = world();
    for (let i = 0; i < 300; i++) w.answer(w.ask({ prompt: `Q ${i}?` }).id, "A");
    const input = { ...w.store.decisionDataInput(), deleted: "" };
    const query = { since: null, until: NOW, tz_offset_min: 0, now: NOW };
    const saved = performance.now;
    let at = saved.call(performance);
    // Every look at the clock is 5 ms on, so each offer to give way is taken, as on a much bigger store.
    performance.now = () => (at += 5);
    try {
      for (const run of [(signal?: AbortSignal) => decisionDataSummary(input, query, signal), (signal?: AbortSignal) => decisionDataCsv(input, null, signal)]) {
        let turns = 0;
        let stop = false;
        const counting = () => {
          if (stop) return;
          turns++;
          setImmediate(counting);
        };
        setImmediate(counting);
        await run();
        stop = true;
        expect(turns).toBeGreaterThan(1);
        const controller = new AbortController();
        controller.abort();
        await expect(run(controller.signal)).rejects.toBeInstanceOf(DecisionDataAborted);
      }
    } finally {
      performance.now = saved;
    }
  });
});

describe("numbers kept when a thread is deleted", () => {
  const SECRET = "ZEBRA-QUESTION-WORDS";

  test("the totals do not change and the words are gone", async () => {
    const w = world();
    const kept = w.ask();
    w.answer(kept.id, "A");
    const gone = w.ask({ prompt: `Which ${SECRET}?` });
    w.pick(gone.id, "A", { note: `${SECRET}-note` });
    w.send(gone.id);
    const before = await w.summary();
    const csvBefore = await w.csv();

    w.store.deleteThread(gone.thread_id);
    expect(w.store.message(gone.id)).toBeNull();

    const after = await w.summary();
    expect(after.counts).toEqual(before.counts);
    expect(after.recommendation).toEqual(before.recommendation);
    expect(after.history).toEqual(before.history);
    expect(after.projects).toEqual(before.projects);
    expect(after.agents).toEqual(before.agents);
    expect(after.days).toEqual(before.days);
    expect(after.waiting).toBe(before.waiting);

    const lines = readFileSync(join(w.store.dir, DECISION_LINES_FILE), "utf8");
    expect(lines.trim().split("\n").length).toBe(1);
    expect(lines).not.toContain(SECRET);
    expect(lines).not.toContain("Pick one");
    const sorted = (text: string) => text.trim().split("\n").sort();
    expect(sorted(await w.csv())).toEqual(sorted(csvBefore));
  });

  test("a line stays after the store is read again from disk, and each question counts once", async () => {
    const w = world();
    const gone = w.ask();
    w.answer(gone.id, "A");
    w.store.deleteThread(gone.thread_id);
    const reopened = InboxStore.open(w.dir);
    const summary = await decisionDataSummary({ ...reopened.decisionDataInput(), deleted: await readDecisionLines(reopened.dir) }, { since: null, until: NOW, tz_offset_min: 0, now: NOW });
    expect(summary.counts.answered).toBe(1);
  });

  test("an unanswered question stops waiting when its thread goes, and is not a decision", async () => {
    const w = world();
    const open = w.ask({ stopped: true });
    const picked = w.ask();
    w.pick(picked.id, "A");
    expect((await w.summary()).waiting).toBe(2);
    w.store.deleteThread(open.thread_id);
    w.store.deleteThread(picked.thread_id);
    const after = await w.summary();
    expect(after.waiting).toBe(0);
    expect(after.history).toMatchObject({ asked: 2, answered: 0 });
    expect(after.counts.answered).toBe(0);
  });

  test("deleting a project keeps every question's line, under the name it had", async () => {
    const w = world();
    const other = w.store.ensureProject({ name: "fieldnotes", root: join(w.dir, "fieldnotes") });
    w.answer(w.ask({ project: other.id }).id, "A");
    w.answer(w.ask({ project: other.id }).id, "B");
    w.answer(w.ask().id, "A");
    w.store.deleteProject(other.id);
    const after = await w.summary();
    expect(after.counts.answered).toBe(3);
    expect(after.projects.find((p) => p.id === other.id)).toMatchObject({ label: "fieldnotes", answered: 2 });
    expect(await w.csv()).toContain(",fieldnotes,");
  });

  test("a thread with no questions writes no line", () => {
    const w = world();
    const note = w.store.sendMessage({ project_id: w.project.id, author: w.claude, body: "Just a note.", thread: "n", idempotency_key: w.key() }).message;
    w.store.deleteThread(note.thread_id);
    expect(existsSync(join(w.store.dir, DECISION_LINES_FILE))).toBe(false);
  });

  test("a line torn by a crash is skipped, and a line beside a question still stored counts once", async () => {
    const w = world();
    const gone = w.ask();
    w.answer(gone.id, "A");
    const stays = w.ask();
    w.answer(stays.id, "A");
    w.store.deleteThread(gone.thread_id);
    const file = join(w.store.dir, DECISION_LINES_FILE);
    const line = readFileSync(file, "utf8");
    // As if the delete crashed after writing a line for `stays`, and another line was torn mid-write.
    const stored = w.store.decisionDataInput().questions.find((question) => question.message_id === stays.id)!.id;
    const twin = line.replace(JSON.parse(line).id, stored);
    writeFileSync(file, `${line}${twin}{"v":1,"id":"torn`);
    const summary = await w.summary();
    expect(summary.counts.answered).toBe(2);
    expect(summary.history.asked).toBe(2);
  });

  test("a torn last line costs only itself: the next delete's line starts fresh and counts", async () => {
    const w = world();
    const first = w.ask();
    w.answer(first.id, "A");
    const second = w.ask();
    w.answer(second.id, "A");
    const file = join(w.store.dir, DECISION_LINES_FILE);
    w.store.deleteThread(first.thread_id);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"id":"torn`);
    w.store.deleteThread(second.thread_id);
    const raw = readFileSync(file, "utf8").split("\n");
    expect(raw.length).toBe(4);
    expect(raw[1]).toBe('{"v":1,"id":"torn');
    expect(raw[3]).toBe("");
    expect((await w.summary()).counts.answered).toBe(2);
  });

  test("a file that ends cleanly gets no blank lines between deletes", () => {
    const w = world();
    for (const asked of [w.ask(), w.ask()]) {
      w.answer(asked.id, "A");
      w.store.deleteThread(asked.thread_id);
    }
    expect(readFileSync(join(w.store.dir, DECISION_LINES_FILE), "utf8").split("\n").filter((line) => line === "").length).toBe(1);
  });

  test("two lines for one question count once, on the page and in the CSV", async () => {
    const w = world();
    const gone = w.ask();
    w.answer(gone.id, "A");
    w.store.deleteThread(gone.thread_id);
    const file = join(w.store.dir, DECISION_LINES_FILE);
    const line = readFileSync(file, "utf8");
    writeFileSync(file, `${line}${line}`);
    const summary = await w.summary();
    expect(summary.counts.answered).toBe(1);
    expect(summary.history.asked).toBe(1);
    expect((await w.csv()).trim().split("\n").length).toBe(2);
  });

  test("a line of the wrong shape is skipped, and neither the count nor the CSV stops for it", async () => {
    const w = world();
    const gone = w.ask();
    w.answer(gone.id, "A");
    w.store.deleteThread(gone.thread_id);
    const file = join(w.store.dir, DECISION_LINES_FILE);
    const good = readFileSync(file, "utf8");
    const base = JSON.parse(good) as Record<string, unknown>;
    const breaks: Record<string, unknown>[] = [
      { answered_at: undefined },
      { answered_at: 1e300 },
      { answered_at: "yesterday" },
      { sent_at: 9e15 },
      { asked_at: Infinity },
      { asked_at: "2026" },
      { agent: 5 },
      { agent: undefined },
      { kind: null },
      { fate: "gone" },
      { took: "yes" },
      { offered: 1 },
      { revisions: "2" },
      { project_id: 3 },
      { thread_id: null },
    ];
    const bad = breaks.map((change, index) => JSON.stringify({ ...base, ...change, id: `bad-${index}` }));
    writeFileSync(file, `${["null", "7", "[]", '"text"', ...bad].join("\n")}\n${good}`);

    const summary = await w.summary();
    expect(summary.counts.answered).toBe(1);
    expect(summary.history.asked).toBe(1);
    expect(summary.agents.map((agent) => agent.label)).toEqual(["Claude Code"]);
    const rows = (await w.csv()).trim().split("\n").slice(1);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain(String(base.id));
  });

  test("a line whose time would fall off the calendar in the reader's zone is skipped, not thrown on", async () => {
    const w = world();
    const gone = w.ask();
    w.answer(gone.id, "A");
    w.store.deleteThread(gone.thread_id);
    const file = join(w.store.dir, DECISION_LINES_FILE);
    const base = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, `${JSON.stringify({ ...base, id: "edge", answered_at: 8.64e15, sent_at: 8.64e15 })}\n`);
    const summary = await w.summary({ tz: 840 });
    expect(summary.counts.answered).toBe(0);
  });

  test("a line that cannot be written never stops the delete", () => {
    const w = world();
    const thread = w.ask();
    w.answer(thread.id, "A");
    const other = w.store.ensureProject({ name: "fieldnotes", root: join(w.dir, "fieldnotes") });
    w.answer(w.ask({ project: other.id }).id, "A");
    // A folder where the file goes: the append fails whatever the permissions.
    mkdirSync(join(w.store.dir, DECISION_LINES_FILE));

    w.store.deleteThread(thread.thread_id);
    expect(w.store.message(thread.id)).toBeNull();
    w.store.deleteProject(other.id);
    expect(w.store.decisionDataInput().questions.length).toBe(0);
    const reopened = InboxStore.open(w.dir);
    expect(reopened.message(thread.id)).toBeNull();
  });

  describe("a record that can't be read", () => {
    function damage(w: ReturnType<typeof world>, projectId: string, messageId: string, change: (record: Record<string, unknown>) => void): InboxStore {
      const folder = readdirSync(join(w.store.dir, "projects"))
        .map((name) => join(w.store.dir, "projects", name))
        .find((path) => readFileSync(join(path, "project.json"), "utf8").includes(projectId))!;
      const file = join(folder, "questions.jsonl");
      const lines = readFileSync(file, "utf8").split("\n").map((raw) => {
        if (!raw) return raw;
        const line = JSON.parse(raw) as { record: Record<string, unknown> };
        if (line.record.message_id !== messageId) return raw;
        change(line.record);
        return JSON.stringify(line);
      });
      writeFileSync(file, lines.join("\n"));
      return InboxStore.open(w.dir);
    }
    const counted = async (store: InboxStore) => {
      const input = { ...store.decisionDataInput(), deleted: await readDecisionLines(store.dir) };
      return { summary: await decisionDataSummary(input, { since: null, until: NOW, tz_offset_min: 0, now: NOW }), csv: await decisionDataCsv(input, null) };
    };
    const dropped = ["parsed", "holds_up", "revision"];

    for (const field of dropped) {
      test(`without its ${field}: the count and the CSV skip it, and deleteThread still deletes, keeping the other lines`, async () => {
        const w = world();
        const bad = w.ask({ prompt: "Bad one?" });
        const goodInThread = w.store.sendMessage({ project_id: w.project.id, author: w.claude, body: ":::question\nGood one?\n\n- [ ] A\n- [ ] B\n:::", reply_to: bad.id, idempotency_key: w.key() }).message;
        w.answer(goodInThread.id, "A");
        const elsewhere = w.ask();
        w.answer(elsewhere.id, "A");
        const store = damage(w, w.project.id, bad.id, (record) => delete record[field]);

        const { summary, csv } = await counted(store);
        expect(summary.history.asked).toBe(2);
        expect(summary.counts.answered).toBe(2);
        expect(csv.trim().split("\n").length).toBe(3);

        store.deleteThread(bad.thread_id);
        expect(store.message(bad.id)).toBeNull();
        const lines = readFileSync(join(store.dir, DECISION_LINES_FILE), "utf8").trim().split("\n");
        expect(lines.length).toBe(1);
        const after = await counted(store);
        expect(after.summary.counts.answered).toBe(2);
      });

      test(`without its ${field}: deleteProject still deletes, keeping the other lines`, async () => {
        const w = world();
        const other = w.store.ensureProject({ name: "fieldnotes", root: join(w.dir, "fieldnotes") });
        const bad = w.ask({ project: other.id });
        w.answer(w.ask({ project: other.id }).id, "A");
        const store = damage(w, other.id, bad.id, (record) => delete record[field]);

        store.deleteProject(other.id);
        expect(store.message(bad.id)).toBeNull();
        expect(readFileSync(join(store.dir, DECISION_LINES_FILE), "utf8").trim().split("\n").length).toBe(1);
        expect((await counted(store)).summary.counts.answered).toBe(1);
      });
    }

    test("a person's message of the wrong shape costs its own mark, not the count", async () => {
      const w = world();
      const asked = w.ask();
      w.store.sendReply(asked.id, { words: "My own words.", idempotency_key: w.key() });
      const reply = w.store.decisionDataInput().messages.find((message) => message.author.kind === "person")!;
      const folder = readdirSync(join(w.store.dir, "projects")).map((name) => join(w.store.dir, "projects", name))[0]!;
      const file = join(folder, "messages.jsonl");
      const lines = readFileSync(file, "utf8").split("\n").map((raw) => {
        if (!raw) return raw;
        const line = JSON.parse(raw) as { record: Record<string, unknown> };
        return line.record.id === reply.id ? JSON.stringify({ ...line, record: { ...line.record, body: 5 } }) : raw;
      });
      writeFileSync(file, lines.join("\n"));
      const { summary } = await counted(InboxStore.open(w.dir));
      expect(summary.history.asked).toBe(1);
      expect(summary.days).toEqual([]);
    });
  });

  test("the lines count in Settings -> Storage's total", () => {
    const w = world();
    const gone = w.ask();
    w.answer(gone.id, "A");
    w.store.deleteThread(gone.thread_id);
    const bytes = readFileSync(join(w.store.dir, DECISION_LINES_FILE)).byteLength;
    const withLines = w.store.diskUsage().bytes;
    rmSync(join(w.store.dir, DECISION_LINES_FILE));
    expect(withLines - w.store.diskUsage().bytes).toBe(bytes);
  });
});

describe("the CSV", () => {
  test("one line per question, times and ids, no words", async () => {
    const w = world();
    const SECRET = "ZEBRA-PROMPT";
    const asked = w.ask({ prompt: `Why ${SECRET}?` });
    w.pick(asked.id, "A", { note: "ZEBRA-NOTE" });
    w.send(asked.id);
    const text = await w.csv();
    const [head, line, end] = text.split("\n");
    expect(head!.split(",")[0]).toBe("question_id");
    expect(line!.split(",").length).toBe(head!.split(",").length);
    expect(end).toBe("");
    expect(text).not.toContain("ZEBRA");
    expect(line).toContain(asked.thread_id);
    expect(line).toContain(",harbor,Claude Code,");
  });

  test("the range cuts as the page does: a decision by when it was made, what waits whatever its age, anything else by when it was asked", async () => {
    const w = world();
    const decidedLately = w.ask();
    const oldOpen = w.ask();
    const decidedLongAgo = w.ask();
    w.answer(decidedLongAgo.id, "A");
    const oldClosed = w.ask();
    w.store.markRead(oldClosed.thread_id, true);
    w.tick(9 * DAY);
    w.answer(decidedLately.id, "A");
    const recentClosed = w.ask();
    w.store.markRead(recentClosed.thread_id, true);
    const since = NOW - 3 * DAY;
    const text = await w.csv(since);
    expect(text).toContain(decidedLately.thread_id);
    expect(text).toContain(oldOpen.thread_id);
    expect(text).toContain(recentClosed.thread_id);
    expect(text).not.toContain(oldClosed.thread_id);
    expect(text).not.toContain(decidedLongAgo.thread_id);
    const fates = text.trim().split("\n").slice(1).map((line) => line.split(",")[5]);
    const page = await w.summary({ since });
    expect(fates.filter((fate) => fate === "answered").length).toBe(page.counts.answered);
    expect(fates.filter((fate) => fate === "set_aside").length).toBe(page.counts.set_aside);
    expect(fates.filter((fate) => fate === "open").length).toBe(page.waiting);
  });

  test("a formula behind spaces or in full-width signs is kept as text like any other; an ordinary name is left alone", async () => {
    const w = world();
    const names = [" =SUM(A1)", "\u3000=SUM(A1)", "\uFF1DSUM(A1)", "\uFF0BSUM(A1)", "\uFF0DSUM(A1)", "\uFF20SUM(A1)", " \uFF1DSUM(A1)", "=SUM(A1)", "+SUM(A1)"];
    for (const name of names) w.ask({ project: w.store.ensureProject({ name, root: join(w.dir, name) }).id });
    w.ask({ project: w.store.ensureProject({ name: "a=b", root: join(w.dir, "a=b") }).id });
    const projects = (await w.csv()).trim().split("\n").slice(1).map((line) => line.split(",")[2]);
    for (const name of names) expect(projects).toContain(`'${name}`);
    expect(projects).toContain("a=b");
  });

  test("an agent's or project's name can't run as a spreadsheet formula or break the columns", async () => {
    const w = world();
    const project = w.store.ensureProject({ name: "evil", root: join(w.dir, '=HYPERLINK("x","y")') });
    w.ask({ project: project.id, author: { kind: "agent", host: null as never, session: "s", name: "@SUM(A1), and more" } as never });
    const [head, line] = (await w.csv()).split("\n");
    expect(line).toContain(`"'=HYPERLINK(""x"",""y"")"`);
    expect(line).toContain(`"'@SUM(A1), and more"`);
    expect(head).toBeDefined();
  });
});
