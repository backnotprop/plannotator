/**
 * Grid's Nudge on the store (approval "inbox-agent-grid", round 4), on a real store in a temp dir: a nudge is an
 * ordinary reply from the person whose body is exactly the window's words, marked `nudge` for the window only (an
 * agent reading the thread sees the words, never the mark); the same press (its key) writes it once; and a list row
 * says where a nudge goes and when the last one went (`grid_nudge`), stripped from a read that did not ask for Grid.
 * What regresses if this fails: a nudge sent twice, sent with other words, told to agents as something new, sent to
 * the wrong session, or Grid unable to say "Nudged just now" or keep the nudged stretch on the bar.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxListRow } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { gridNudgeReader } from "./inbox-grid-nudge";
import { gridRowDecorator, gridRowStripped } from "./inbox-grid-row";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TIDE: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_tide", name: "Claude Code" };
const WORDS = "Haptics on save has been quiet for 3 h 37 min, with tests failing on #22 since 8:05 PM. Please finish it, or tell me in a few words why it stopped.";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-grid-nudge-"));
  roots.push(dir);
  const clock = { now: Date.parse("2026-11-24T04:42:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  return { store, clock, project };
}

const refused = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
  return "not refused";
};

describe("a nudge on the store", () => {
  test("is the person's reply to the agent, its body exactly the words, marked for the window, and written once per key", () => {
    const { store, clock, project } = setup();
    const opened = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Haptics on save", body: "Opened #22." }).message;
    clock.now += 15 * 60_000;
    const failing = store.sendMessage({ project_id: project.id, author: TIDE, body: "One test fails on the simulator.", reply_to: opened.id }).message;
    clock.now += 217 * 60_000;
    const to = gridNudgeReader(store)(opened.thread_id)!.to;
    expect(to).toBe(failing.id);

    const input = { idempotency_key: "grid-nudge-a-1", words: WORDS, questions: [], nudge: { quiet_from: failing.created_at } };
    const sent = store.sendReply(to, input);
    expect(sent.replayed).toBe(false);
    expect(sent.reply.body).toBe(WORDS);
    expect(sent.reply.author.kind).toBe("person");
    expect(sent.reply.nudge).toEqual({ quiet_from: failing.created_at });
    // The same press again (a second window, a double click, a held copy): the same reply, nothing new.
    expect(store.sendReply(to, input).replayed).toBe(true);
    const nudges = store.thread(opened.thread_id)!.messages.filter((m) => m.nudge);
    expect(nudges.length).toBe(1);

    // The agent reads the words and nothing about Grid.
    const agentView = store.agentThread(opened.thread_id)!.messages.at(-1)!;
    expect(agentView.body).toBe(WORDS);
    expect("nudge" in agentView).toBe(false);

    // A mark that is not one: refused, nothing written.
    expect(refused(() => store.sendReply(to, { ...input, idempotency_key: "grid-nudge-a-2", nudge: { quiet_from: "soon" } }))).toBe("validation_error");
    expect(store.thread(opened.thread_id)!.messages.filter((m) => m.nudge).length).toBe(1);
  });

  test("the row says where a nudge goes and the last one; the agent's answer is its end; a read without Grid has none of it", () => {
    const { store, clock, project } = setup();
    // A plan: a thread the person started that no agent answered. A nudge goes on the person's first message (to its session).
    const plan = store.startPersonThread({ project_id: project.id, body: "Add receipts by email.", to: { host: "claude-code", session: "ses_harbor" }, idempotency_key: "plan-1" }).message;
    expect(gridNudgeReader(store)(plan.thread_id)?.to).toBe(plan.id);
    const planNudge = store.sendReply(plan.id, { idempotency_key: "grid-nudge-plan", words: WORDS, questions: [], nudge: { quiet_from: plan.created_at } }).reply;
    expect(planNudge.to?.session).toBe("ses_harbor");

    const asked = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Haptics on save", body: "Opened #22." }).message;
    const read = gridNudgeReader(store);
    expect(read(asked.thread_id)).toEqual({ to: asked.id, seq: store.messageCursor(asked.id)!, last: null });

    clock.now += 4 * 3600_000;
    const nudge = store.sendReply(asked.id, { idempotency_key: "grid-nudge-b", words: WORDS, questions: [], nudge: { quiet_from: asked.created_at } }).reply;
    expect(read(asked.thread_id)).toEqual({ to: asked.id, seq: store.messageCursor(nudge.id)!, last: { at: nudge.created_at, quiet_from: asked.created_at, answered_at: null } });

    clock.now += 16 * 60_000;
    const answer = store.sendMessage({ project_id: project.id, author: TIDE, body: "Stubbed the engine and pushed to #22.", reply_to: asked.id }).message;
    // `seq`: the thread's newest, which the nudge sends as what the person saw.
    expect(read(asked.thread_id)).toEqual({ to: answer.id, seq: store.messageCursor(answer.id)!, last: { at: nudge.created_at, quiet_from: asked.created_at, answered_at: answer.created_at } });

    const row = { thread_id: asked.thread_id } as InboxListRow;
    const decorated = gridRowDecorator({ get: () => undefined }, null, read)(row);
    expect(decorated.grid_nudge?.to).toBe(answer.id);
    expect("grid_nudge" in gridRowStripped(decorated)).toBe(false);
  });
});
