import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPull, InboxPullRiskAuto } from "@plannotator/core/inbox-types";
import { createPullRiskAuto, type PullRiskAutoJob } from "./inbox-pull-risk-auto";
import { pullRiskAutoBody } from "./inbox-pull-risk-auto-start";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const pr = (number: number, fields: Partial<InboxPull> = {}): InboxPull => ({
  key: `github.com/northwind/web-app#${number}`,
  platform: "github",
  host: "github.com",
  repo: "northwind/web-app",
  number,
  url: `https://github.com/northwind/web-app/pull/${number}`,
  title: `PR ${number}`,
  author: "tomas",
  mine: false,
  requested: true,
  state: "open",
  base: "main",
  head: `feat/${number}`,
  head_repo: "northwind/web-app",
  head_sha: "a".repeat(40),
  additions: 3,
  deletions: 1,
  files: 1,
  review: null,
  approved_by: null,
  reviewers: [],
  checks: "success",
  updated_at: "2026-11-18T09:00:00.000Z",
  merged_at: null,
  ...fields,
});

function world(settings: InboxPullRiskAuto | null = { level: "high", make: "show_me" }, dataDir = mkdtempSync(join(tmpdir(), "pull-risk-auto-"))) {
  dirs.push(dataDir);
  const started: PullRiskAutoJob[] = [];
  const threads = new Set<string>();
  let fail: string | null = null;
  let hold: Promise<void> | null = null;
  const auto = createPullRiskAuto({
    dataDir,
    settings: () => settings,
    hasThread: async (pull) => threads.has(pull.key),
    start: async (job) => {
      started.push(job);
      if (hold) await hold;
      if (fail) throw new Error(`${fail} Nothing was sent.`);
      threads.add(job.key);
      return { thread_id: `thr_${job.pull.number}` };
    },
  });
  return {
    dataDir,
    auto,
    started,
    threads,
    failWith: (reason: string | null) => (fail = reason),
    holdStarts: () => {
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

test("a PR ranked at the level is made for once, with the chosen ask; a new head or a second judgment starts nothing", async () => {
  const w = world({ level: "high", make: "both", agent: "codex" });
  w.auto.judged(pr(880), "high");
  await w.auto.idle();
  w.threads.clear();
  w.auto.judged(pr(880, { head_sha: "b".repeat(40) }), "high");
  await w.auto.idle();
  expect(w.started.map((job) => [job.key, job.made, job.agent])).toEqual([[pr(880).key, "both", "codex"]]);
  expect(w.auto.runs()[pr(880).key]).toMatchObject({ state: "started", made: "both", level: "high", thread_id: "thr_880" });
});

test("nothing is made below the level, with a review thread already, or while it is off", async () => {
  const high = world({ level: "high", make: "guide" });
  high.auto.judged(pr(1), "medium");
  high.threads.add(pr(2).key);
  high.auto.judged(pr(2), "high");
  await high.auto.idle();
  expect(high.started).toEqual([]);
  expect(high.auto.runs()).toEqual({});
  const off = world(null);
  off.auto.judged(pr(3), "high");
  await off.auto.idle();
  expect(off.started).toEqual([]);
  const medium = world({ level: "medium", make: "guide" });
  medium.auto.judged(pr(4), "medium");
  medium.auto.judged(pr(5), "low");
  await medium.auto.idle();
  expect(medium.started.map((job) => job.pull.number)).toEqual([4]);
});

test("one start at a time across the Inbox: the rest wait their turn, in order", async () => {
  const w = world();
  const release = w.holdStarts();
  w.auto.judged(pr(1), "high");
  w.auto.judged(pr(2), "high");
  w.auto.judged(pr(3), "high");
  await Bun.sleep(5);
  expect(w.started.map((job) => job.pull.number)).toEqual([1]);
  expect(Object.values(w.auto.runs()).map((run) => run.state)).toEqual(["queued", "queued", "queued"]);
  release();
  await w.auto.idle();
  expect(w.started.map((job) => job.pull.number)).toEqual([1, 2, 3]);
});

test("a failed start is kept with its reason and never tried again by itself", async () => {
  const w = world();
  w.failWith("Codex can't be started here.");
  w.auto.judged(pr(7), "high");
  await w.auto.idle();
  w.auto.judged(pr(7), "high");
  w.auto.resume();
  await w.auto.idle();
  expect(w.started).toHaveLength(1);
  expect(w.auto.runs()[pr(7).key]).toEqual({ at: expect.any(String), level: "high", made: "show_me", state: "failed", thread_id: null, reason: "Codex can't be started here." });
});

test("a restart mid-queue starts each waiting PR once, and none that had started", async () => {
  const first = world();
  const release = first.holdStarts();
  first.auto.judged(pr(1), "high");
  first.auto.judged(pr(2), "high");
  await Bun.sleep(5);
  first.auto.stop();
  release();
  await first.auto.idle();
  const again = world({ level: "high", make: "show_me" }, first.dataDir);
  again.auto.resume();
  await again.auto.idle();
  expect(again.started.map((job) => job.pull.number)).toEqual([1, 2]);
  const third = world({ level: "high", make: "show_me" }, first.dataDir);
  third.auto.resume();
  await third.auto.idle();
  expect(third.started).toEqual([]);
});

test("the hand-off it sends asks for what was chosen, with those skills' text, and never to comment, approve or merge", () => {
  const both = pullRiskAutoBody({ pull: pr(880), made: "both" }).body;
  expect(both).toContain("1. Send me a guided review of its diff against main, using /review-curate");
  expect(both).toContain("2. Then send me a Show me page of its diff against main, using /show-me");
  expect(both).toContain("3. After that, we discuss it in this thread.");
  expect(both).toContain("--- BEGIN SKILL INSTRUCTIONS: review-curate ---");
  expect(both).toContain("--- BEGIN SKILL INSTRUCTIONS: show-me ---");
  expect(both).toContain("Don't push to the branch, comment on the pull request, approve it or merge it.");
  const showMe = pullRiskAutoBody({ pull: pr(880), made: "show_me" }).body;
  expect(showMe).not.toContain("/review-curate");
  expect(pullRiskAutoBody({ pull: pr(880), made: "guide" }).name).toBe("Review #880: PR 880");
});

test("a start run again after a restart replays the same thread: no second agent, the PR kept by that thread", async () => {
  const { pullRiskAutoStart } = await import("./inbox-pull-risk-auto-start");
  const threads = new Map<string, string>();
  const begun: string[] = [];
  const abandoned: string[] = [];
  const owned: [string[], string, string][] = [];
  const start = pullRiskAutoStart({
    store: {
      startPersonThread: (input: { idempotency_key: unknown }) => {
        const key = String(input.idempotency_key);
        const replayed = threads.has(key);
        if (!replayed) threads.set(key, `thr_${threads.size + 1}`);
        return { message: { thread_id: threads.get(key)! }, replayed };
      },
    } as never,
    launch: {
      enabled: () => true,
      composeBlock: async () => ({ agents: [{ agent: "claude-code" }] }) as never,
      prepare: async () => ({ project: { id: "prj_web" }, to: { host: "claude-code", session: "launch:1" }, launch: { id: "l1" }, trust: null }) as never,
      abandon: (launch: { id: string }) => abandoned.push(launch.id),
      begin: (message: { thread_id: string }) => begun.push(message.thread_id),
    } as never,
    resolveProject: async () => ({}) as never,
    projectOf: async () => "prj_web",
    own: (keys, threadId, made) => owned.push([keys, threadId, made]),
  });
  const job = { key: pr(880).key, pull: pr(880), made: "both" as const, agent: null };
  expect(await start(job)).toEqual({ thread_id: "thr_1" });
  expect(await start(job)).toEqual({ thread_id: "thr_1" });
  expect(begun).toEqual(["thr_1"]);
  expect(abandoned).toEqual(["l1"]);
  expect(owned).toEqual([[[pr(880).key], "thr_1", "both"], [[pr(880).key], "thr_1", "both"]]);
});
