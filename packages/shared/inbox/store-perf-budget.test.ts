import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const ON = process.env.PLANNOTATOR_PERF_BUDGET === "1";
const N = Number(process.env.PLANNOTATOR_PERF_BUDGET_N ?? 3000);
const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BODY = ["## Status", "", "The list now reads its rows once per request.", "", "```ts", "const rows = store.listRows();", "```", "", "- one", "- two"].join("\n");

function seed(messages: number): { dir: string; big: string } {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-perf-budget-"));
  roots.push(dir);
  let now = Date.parse("2026-10-01T00:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date((now += 1000)) });
  const projects = Array.from({ length: 8 }, (_, i) => store.ensureProject({ name: `p${i}`, root: `/work/p${i}` }));
  const thread = (size: number, i: number): string => {
    const author: InboxAuthor = { kind: "agent", host: "claude-code", session: `ses_${i % 50}`, name: "Claude Code" };
    const project = projects[i % projects.length]!;
    let root = "";
    let last = "";
    for (let m = 0; m < size; m++) {
      if (m % 2 === 0 || !last) {
        const sent = store.sendMessage({ project_id: project.id, author, body: `${BODY}\n\n${i}/${m}`, subject: m === 0 ? `Thread ${i}` : null, reply_to: root || null, thread: m === 0 ? `t-${i}` : null });
        root ||= sent.message.thread_id;
        last = sent.message.id;
      } else {
        store.markSeen(root);
        store.sendReply(last, { words: `Reply ${m}`, idempotency_key: `r-${i}-${m}` });
      }
    }
    return root;
  };
  const big = thread(400, 0);
  for (let i = 1, total = 400; total < messages; i++, total += 8) thread(8, i);
  return { dir, big };
}

function median(run: () => unknown, times = 7): number {
  const xs: number[] = [];
  run();
  for (let i = 0; i < times; i++) {
    const t = performance.now();
    run();
    xs.push(performance.now() - t);
  }
  return xs.sort((a, b) => a - b)[Math.floor(times / 2)]!;
}

const THREAD_READS = 50;

function measure(dir: string, big: string) {
  let store = InboxStore.open(dir);
  return {
    load: median(() => (store = InboxStore.open(dir)), 3),
    listRows: median(() => store.listRows()),
    windowThread: median(() => {
      for (let i = 0; i < THREAD_READS; i++) store.windowThread(big);
    }),
    changesSince: median(() => store.changesSince(0)),
    pendingReplies: median(() => store.pendingReplies("ses_1")),
  };
}

describe.skipIf(!ON)("Inbox store: work grows no faster than the data", () => {
  type Times = ReturnType<typeof measure>;
  let a: Times;
  let b: Times;
  beforeAll(() => {
    const small = seed(N);
    const large = seed(4 * N);
    a = measure(small.dir, small.big);
    b = measure(large.dir, large.big);
    console.log(JSON.stringify({ n: N, small: a, large: b }, null, 1));
  });
  const ratio = (k: keyof Times) => b[k] / Math.max(a[k], 0.05);

  test("loading the store: about linear in the log", () => expect(ratio("load")).toBeLessThan(10));
  test("the window's list (listRows): about linear in the messages", () => expect(ratio("listRows")).toBeLessThan(10));
  test("an agent's poll (pendingReplies): about linear in the messages", () => expect(ratio("pendingReplies")).toBeLessThan(10));
  test("a reconnecting window's replay (changesSince 0): about linear", () => expect(ratio("changesSince")).toBeLessThan(10));
  test("one thread of the same size reads in about the same time, whatever else the store holds", () => expect(ratio("windowThread")).toBeLessThan(3));
});
