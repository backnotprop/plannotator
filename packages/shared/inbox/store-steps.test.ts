/**
 * Thread steps in the store (approval "inbox-thread-steps", 2026-11-03): one
 * list per (thread, agent session), sent whole, on the store's one seq, and
 * silent. The failures these guard: a tick that moves the person's list (a
 * section, a row, unread, a pending reply), a list past the approved limits
 * that gets written, a second session's list overwriting the first's, a done
 * time that resets on every call, a call that changes nothing still writing a
 * line (every write is an event), a list that does not read back after a
 * restart, and a deleted thread whose steps survive it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_STEPS_MAX, INBOX_STEP_TEXT_MAX, inboxStepsProgress, type InboxAuthor, type InboxLine } from "@plannotator/core/inbox-types";
import { InboxError, STEPS_FILE } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
const OTHER: InboxAuthor = { kind: "agent", host: "pi", session: "ses_b", name: "Pi" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-steps-"));
  roots.push(dir);
  let now = Date.parse("2026-11-03T14:00:00.000Z");
  const open = () => InboxStore.open(dir, { now: () => new Date(now) });
  const store = open();
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "Retry worker for failed Stripe charges.", subject: "Retry worker" }).message.id;
  return { dir, store, project, thread, open, advance: (ms: number) => (now += ms) };
}

const PLAN = [
  { step: "Classify 30 days of failed charges", status: "done" },
  { step: "Retry worker on pg-boss", status: "done" },
  { step: "Replay the failures in staging", status: "doing", note: "38 of 40 recovered" },
  { step: "Ship it behind a flag", status: "waiting" },
  { step: "Admin retry view", status: "todo" },
  { step: "Retry Stripe 409s", status: "dropped", note: "Stripe settles them" },
];

function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof InboxError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("thread steps", () => {
  test("a list writes one steps line and moves nothing the person sees: sections, rows, unread, pending replies", () => {
    const { store, thread } = world();
    const person = store.sendMessage({ project_id: store.message(thread)!.project_id, author: { kind: "person" }, body: "Go ahead.", reply_to: thread }).message.id;
    const sections = JSON.stringify(store.listSections());
    const pending = store.pendingReplies("ses_a").map((m) => m.id);
    const lines: InboxLine[] = [];
    store.subscribe((line) => lines.push(line));
    const cursor = store.cursor();

    const { record, changed } = store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: PLAN });

    expect(changed).toBe(true);
    expect(lines.map((line) => line.kind)).toEqual(["steps"]);
    expect(store.cursor()).toBe(cursor + 1);
    expect(record.thread_id).toBe(thread);
    expect(JSON.stringify(store.listSections())).toBe(sections);
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual(pending);
    expect(pending).toContain(person);
    expect(inboxStepsProgress(record.steps)).toEqual({ done: 2, total: 5, doing: "Replay the failures in staging", waiting: true });
  });

  test("each call replaces the session's list; a step keeps its time while its status holds", () => {
    const w = world();
    const first = w.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: PLAN }).record;
    w.advance(4 * 60_000);
    const next = PLAN.map((s) => (s.step === "Replay the failures in staging" ? { step: s.step, status: "done" } : s.step === "Admin retry view" ? { ...s, status: "doing" } : s));
    const second = w.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: next }).record;
    expect(second.id).toBe(first.id);
    expect(second.steps[0]!.at).toBe(first.steps[0]!.at);
    expect(second.steps[2]!.at).not.toBe(first.steps[2]!.at);
    expect(second.steps[2]!.note).toBeNull();
    expect(w.store.threadSteps(w.thread)).toHaveLength(1);
  });

  test("a call that changes nothing writes nothing", () => {
    const { store, thread } = world();
    store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: PLAN });
    const cursor = store.cursor();
    expect(store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: PLAN }).changed).toBe(false);
    expect(store.cursor()).toBe(cursor);
  });

  test("two sessions keep two lists in one thread; a message id finds its thread", () => {
    const { store, thread, project } = world();
    const reply = store.sendMessage({ project_id: project.id, author: OTHER, body: "Taking the admin view.", reply_to: thread }).message.id;
    store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: PLAN });
    store.setThreadSteps({ thread_id: reply, agent: OTHER, steps: [{ step: "Admin retry view", status: "doing" }] });
    expect(store.threadSteps(thread).map((r) => r.agent.session).sort()).toEqual(["ses_a", "ses_b"]);
    expect(store.stepsOf(thread, "ses_a")!.steps).toHaveLength(PLAN.length);
  });

  test("the approved limits: 12 steps, 80 characters per step and per note; nothing written past them", () => {
    const { store, thread } = world();
    const cursor = store.cursor();
    const many = Array.from({ length: INBOX_STEPS_MAX + 1 }, (_, i) => ({ step: `Step ${i + 1}`, status: "todo" }));
    expect(refusal(() => store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: many })).code).toBe("validation_error");
    const long = "x".repeat(INBOX_STEP_TEXT_MAX + 1);
    expect(refusal(() => store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: [{ step: long, status: "todo" }] })).message).toContain("steps[0].step");
    expect(refusal(() => store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: [{ step: "Ok", status: "dropped", note: long }] })).message).toContain("steps[0].note");
    expect(refusal(() => store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: [{ step: "Ok", status: "blocked" }] })).message).toContain("todo, doing, done, waiting, dropped");
    expect(store.cursor()).toBe(cursor);
    // At the limits it is written.
    const full = Array.from({ length: INBOX_STEPS_MAX }, (_, i) => ({ step: `${i}`.padEnd(INBOX_STEP_TEXT_MAX, "s"), status: "todo", note: "n".repeat(INBOX_STEP_TEXT_MAX) }));
    expect(store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: full }).changed).toBe(true);
  });

  test("steps belong to an agent session and a thread that exists", () => {
    const { store, thread } = world();
    expect(refusal(() => store.setThreadSteps({ thread_id: thread, agent: { kind: "person" }, steps: PLAN })).code).toBe("validation_error");
    expect(refusal(() => store.setThreadSteps({ thread_id: thread, agent: { ...AGENT, session: null }, steps: PLAN })).code).toBe("validation_error");
    expect(refusal(() => store.setThreadSteps({ thread_id: "msg_00000000000000000000000000", agent: AGENT, steps: PLAN })).code).toBe("thread_not_found");
  });

  test("an empty list clears the session's steps", () => {
    const { store, thread } = world();
    store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: PLAN });
    expect(store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: [] }).changed).toBe(true);
    expect(store.threadSteps(thread)).toEqual([]);
  });

  test("reads back after a restart, keeps the seq, and goes with its deleted thread", () => {
    const w = world();
    const written = w.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: PLAN }).record;
    const reopened = w.open();
    expect(reopened.threadSteps(w.thread)).toEqual([written]);
    expect(reopened.cursor()).toBe(w.store.cursor());
    const file = join(w.dir, "inbox", "projects", w.project.key, STEPS_FILE);
    expect(existsSync(file)).toBe(true);
    reopened.deleteThread(w.thread);
    expect(reopened.threadSteps(w.thread)).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("");
    // The deleted line's seq is never handed out again.
    expect(w.open().cursor()).toBeGreaterThanOrEqual(w.store.cursor());
  });
});
