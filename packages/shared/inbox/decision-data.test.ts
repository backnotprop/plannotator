/**
 * Decision data's numbers, over a real store in a temp folder: what counts as what, the trend rule, the slices that
 * give the server back, and the lines kept when a thread or project is deleted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    // The plain reply, the picked-but-unsent one and the untouched one still wait on the person.
    expect(summary.waiting).toBe(3);
    void open;
    // Took is exact, and only over answers to a question that named a recommendation.
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
    // The first project has more questions in all, but fewer answers.
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

/** `n` answers in a period, `hit` of them marked, spread inside it. */
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

  /** Waits around `minutes`, so a period has a spread, as a real one does. */
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
    // 25 recent questions were answered quickly; the slower 30 have not been answered at all.
    const recent = period("recent", 55, (index, at) => (index < 25 ? waited(30)(index, at) : { stopped: true, asked_at: at, answered_at: null, sent_at: null, fate: "open" as const }));
    expect(trendsOf([...before, ...recent], NOW, HISTORY)).toEqual([]);
    // Dropping them would have claimed the fall.
    expect(trendsOf([...before, ...recent.filter((r) => r.fate !== "open")], NOW, HISTORY)[0]).toMatchObject({ key: "waits", direction: "down" });
  });

  test("three changes make three lines, in the approved order", () => {
    const before = period("before", 100, (index, at) => ({ ...takes(60)(index), ...(index >= 95 ? { fate: "skipped" as const, took: null } : {}), ...(index < 40 ? waited(600)(index, at) : {}) }));
    const recent = period("recent", 100, (index, at) => ({ ...takes(90)(index), ...(index >= 70 ? { fate: "skipped" as const, took: null } : {}), ...(index < 40 ? waited(60)(index, at) : {}) }));
    expect(trendsOf([...before, ...recent], NOW, HISTORY).map((t) => t.key)).toEqual(["recommendations", "waits", "skips"]);
  });

  test("the summary's trends read the whole history, whatever range is showing", async () => {
    const w = world();
    w.tick(-70 * DAY + 10 * DAY); // back to 70 days before NOW
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
  /** Holds the thread about a millisecond per step, as a big store would. */
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
    // The export reads the same, line for line.
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

  test("the range cuts by when it was asked", async () => {
    const w = world();
    const old = w.ask();
    w.tick(9 * DAY);
    const recent = w.ask();
    const text = await w.csv(NOW - 3 * DAY);
    expect(text).toContain(recent.thread_id);
    expect(text).not.toContain(old.thread_id);
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
