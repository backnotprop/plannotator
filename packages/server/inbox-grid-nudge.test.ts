/**
 * Grid's Nudge on the store (approval "inbox-agent-grid", round 4), on a real store in a temp dir: a nudge is an
 * ordinary reply from the person whose body is exactly the window's words, marked `nudge` for the window only (an
 * agent reading the thread sees the words, never the mark); the same press (its key) writes it once; a list row says
 * where a nudge goes, to whom, and when the last one went (`grid_nudge`), stripped from a read that did not ask for
 * Grid; it goes where a typed reply's words would (a hand-off's new owner, a takeover, never a removed agent however far
 * back); a Take back makes the next press a new write; a held nudge whose work moved is refused at delivery; and the
 * outbox holds one nudge per thread. What regresses if this fails: a nudge sent twice, sent with other words, told to
 * agents as something new, sent to the wrong session, "Nudged" for a nudge that did not go, or Grid unable to say
 * "Nudged just now" or keep the nudged stretch on the bar.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxListRow } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { gridNudgeKey } from "@plannotator/shared/inbox/grid-nudge-key";
import { gridNudgeHeld, gridNudgeOfThread, gridNudgeReader, gridNudgeRefusal } from "./inbox-grid-nudge";
import { gridRowDecorator, gridRowStripped } from "./inbox-grid-row";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TIDE: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_tide", name: "Claude Code" };
const REVIEW: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "codex", session: "ses_review", name: "Codex" };
const WORDS = "Haptics on save has been quiet for 3 h 37 min, with tests failing on #22. Please finish it, or tell me in a few words why it stopped.";

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

const nudgeReply = (key: string, quietFrom: string) => ({ idempotency_key: key, words: WORDS, questions: [], nudge: { quiet_from: quietFrom } });

describe("a nudge on the store", () => {
  test("is the person's reply to the agent, its body exactly the words, marked for the window, and written once per key", () => {
    const { store, clock, project } = setup();
    const opened = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Haptics on save", body: "Opened #22." }).message;
    clock.now += 15 * 60_000;
    const failing = store.sendMessage({ project_id: project.id, author: TIDE, body: "One test fails on the simulator.", reply_to: opened.id }).message;
    clock.now += 217 * 60_000;
    const row = gridNudgeOfThread(store, opened.thread_id)!;
    expect([row.to, row.agent]).toEqual([failing.id, { host: "claude-code", session: "ses_tide" }]);

    const input = nudgeReply("grid-nudge-a-1", failing.created_at);
    const sent = store.sendReply(row.to, input);
    expect(sent.replayed).toBe(false);
    expect(sent.reply.body).toBe(WORDS);
    expect(sent.reply.author.kind).toBe("person");
    expect(sent.reply.nudge).toEqual({ quiet_from: failing.created_at });
    // The same press again (a second window, a double click, a held copy): the same reply, nothing new.
    expect(store.sendReply(row.to, input).replayed).toBe(true);
    expect(store.thread(opened.thread_id)!.messages.filter((m) => m.nudge).length).toBe(1);

    // The agent reads the words and nothing about Grid.
    const agentView = store.agentThread(opened.thread_id)!.messages.at(-1)!;
    expect(agentView.body).toBe(WORDS);
    expect("nudge" in agentView).toBe(false);

    // A mark that is not one: refused, nothing written.
    expect(refused(() => store.sendReply(row.to, { ...input, idempotency_key: "grid-nudge-a-2", nudge: { quiet_from: "soon" } }))).toBe("validation_error");
    expect(store.thread(opened.thread_id)!.messages.filter((m) => m.nudge).length).toBe(1);
  });

  test("the row says where a nudge goes, to whom, and the last one; the agent's answer is its end; a read without Grid has none of it", () => {
    const { store, clock, project } = setup();
    // A plan: a thread the person started that no agent answered. A nudge goes on the person's first message (to its session).
    const plan = store.startPersonThread({ project_id: project.id, body: "Add receipts by email.", to: { host: "claude-code", session: "ses_harbor" }, idempotency_key: "plan-1" }).message;
    expect(gridNudgeOfThread(store, plan.thread_id)).toMatchObject({ to: plan.id, agent: { host: "claude-code", session: "ses_harbor" } });
    const planNudge = store.sendReply(plan.id, nudgeReply("grid-nudge-plan", plan.created_at)).reply;
    expect(planNudge.to?.session).toBe("ses_harbor");

    const asked = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Haptics on save", body: "Opened #22." }).message;
    const read = gridNudgeReader(store);
    const rowOf = (over: Partial<InboxListRow> = {}) => ({ thread_id: asked.thread_id, section: "quiet", waiting_since: null, questions: { open: 0 }, ...over }) as InboxListRow;
    expect(read(rowOf())).toEqual({ to: asked.id, seq: store.messageCursor(asked.id)!, agent: { host: "claude-code", session: "ses_tide" }, taken: 0, last: null });

    clock.now += 4 * 3600_000;
    const nudge = store.sendReply(asked.id, nudgeReply("grid-nudge-b", asked.created_at)).reply;
    expect(read(rowOf())!.last).toEqual({ at: nudge.created_at, quiet_from: asked.created_at, answered_at: null });

    clock.now += 16 * 60_000;
    const answer = store.sendMessage({ project_id: project.id, author: TIDE, body: "Stubbed the engine and pushed to #22.", reply_to: asked.id }).message;
    // `seq`: the thread's newest, which the nudge sends as what the person saw.
    expect(read(rowOf())).toMatchObject({ to: answer.id, seq: store.messageCursor(answer.id)!, last: { at: nudge.created_at, quiet_from: asked.created_at, answered_at: answer.created_at } });

    const decorated = gridRowDecorator({ get: () => undefined }, null, read)(rowOf());
    expect(decorated.grid_nudge?.to).toBe(answer.id);
    expect("grid_nudge" in gridRowStripped(decorated)).toBe(false);
  });

  test("goes where a typed reply's words go: a hand-off's new owner, a takeover's session, never a removed agent however far back", () => {
    const { store, clock, project } = setup();
    const opened = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Haptics on save", body: "Opened #22." }).message;
    // Handed from tide to review: the nudge goes to review (the hand-off reply itself until review writes), even after tide writes again.
    const handoff = store.sendReply(opened.id, { idempotency_key: "hand-1", words: "Over to you.", questions: [], handoff: { to: { host: "codex", session: "ses_review" }, from: { host: "claude-code", session: "ses_tide", wakes: true } } }).reply;
    expect(gridNudgeOfThread(store, opened.thread_id)).toMatchObject({ to: handoff.id, agent: { session: "ses_review" } });
    clock.now += 60_000;
    store.sendMessage({ project_id: project.id, author: TIDE, body: "Still here.", reply_to: opened.id });
    const theirs = store.sendMessage({ project_id: project.id, author: REVIEW, body: "On it.", reply_to: handoff.id }).message;
    store.sendMessage({ project_id: project.id, author: TIDE, body: "Me again.", reply_to: opened.id });
    expect(gridNudgeOfThread(store, opened.thread_id)).toMatchObject({ to: theirs.id, agent: { host: "codex", session: "ses_review" } });

    // A takeover: tide's session ended and the person sent to review instead; review holds the thread until an agent writes.
    const other = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Retry queue", body: "Retrying." }).message;
    const took = store.sendReply(other.id, { idempotency_key: "took-1", words: "Carry on.", questions: [], to: { host: "codex", session: "ses_review" }, took_over: true }).reply;
    expect(gridNudgeOfThread(store, other.thread_id)).toMatchObject({ to: took.id, agent: { session: "ses_review" } });

    // A removal 70 messages back still stands: the removed agent is never the nudge's.
    const long = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Long thread", body: "Start." }).message;
    store.sendMessage({ project_id: project.id, author: REVIEW, body: "Joining.", reply_to: long.id });
    store.removeFromThread(long.thread_id, "ses_tide");
    for (let i = 0; i < 70; i++) store.sendMessage({ project_id: project.id, author: TIDE, body: `Line ${i}.`, reply_to: long.id });
    expect(gridNudgeOfThread(store, long.thread_id)!.agent?.session).toBe("ses_review");
  });

  test("Take back, then Nudge: the row forgets the nudge and counts it taken, so the next press is a new key and really writes", () => {
    const { store, project } = setup();
    const asked = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Haptics on save", body: "Opened #22." }).message;
    const press = (taken: number) => gridNudgeKey({ thread: asked.thread_id, quietFrom: Date.parse(asked.created_at), turn: 1, taken });
    const first = store.sendReply(asked.id, nudgeReply(press(0), asked.created_at)).reply;
    store.takeBack(first.id);
    const row = gridNudgeOfThread(store, asked.thread_id)!;
    expect([row.last, row.taken]).toEqual([null, 1]);
    // The old key would replay the taken-back reply and write nothing; the window's next key carries `taken`.
    expect(store.sendReply(asked.id, nudgeReply(press(0), asked.created_at)).replayed).toBe(true);
    const again = store.sendReply(asked.id, nudgeReply(press(row.taken), asked.created_at));
    expect(again.replayed).toBe(false);
    expect(gridNudgeOfThread(store, asked.thread_id)!.last?.at).toBe(again.reply.created_at);
  });

  test("a held nudge delivered after its work moved (a step, a PR put on, a check run seen) is refused, nothing written; a replay answers", () => {
    const { store, project } = setup();
    const asked = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Haptics on save", body: "Opened #22." }).message;
    const from = Date.parse(asked.created_at);
    const at = (minutes: number) => new Date(from + minutes * 60_000).toISOString();
    let pulls: { thread_id: string; pull: string; added_at: string }[] = [];
    let steps: { thread_id: string; steps: { at: string }[] }[] = [];
    let checksAt: string | null = null;
    const fake = { message: (id: string) => store.message(id), replyByKey: (m: string, k: string) => store.replyByKey(m, k), allThreadPulls: () => pulls, allSteps: () => steps };
    const live = { live: () => (checksAt ? { checks_at: checksAt } : {}) };
    const check = (key = "grid-nudge-held") => refused(() => gridNudgeRefusal(fake, live, asked.id, { idempotency_key: key, nudge: { quiet_from: asked.created_at } }));
    // The movement that began the stretch, or before it, is not movement since.
    pulls = [{ thread_id: asked.thread_id, pull: "github.com/ada/tide#22", added_at: at(0) }];
    steps = [{ thread_id: asked.thread_id, steps: [{ at: at(-5) }] }];
    expect(check()).toBe("not refused");
    checksAt = at(90);
    expect(check()).toBe("thread_moved_on");
    checksAt = null;
    steps = [{ thread_id: asked.thread_id, steps: [{ at: at(120) }] }];
    expect(check()).toBe("thread_moved_on");
    steps = [];
    pulls = [...pulls, { thread_id: asked.thread_id, pull: "github.com/ada/tide#23", added_at: at(30) }];
    expect(check()).toBe("thread_moved_on");
    // Another thread's movement is not this one's.
    pulls = [{ thread_id: "msg_other", pull: "github.com/ada/tide#23", added_at: at(30) }];
    expect(check()).toBe("not refused");
    // A key already written answers what it wrote, moved or not.
    store.sendReply(asked.id, nudgeReply("grid-nudge-written", asked.created_at));
    steps = [{ thread_id: asked.thread_id, steps: [{ at: at(120) }] }];
    expect(check("grid-nudge-written")).toBe("not refused");
  });

  test("the outbox holds one nudge per thread: a second press under another key (another window, a later turn) answers the held one", () => {
    const a = gridNudgeKey({ thread: "msg_tide", quietFrom: 1_000, turn: 1, taken: 0 });
    const b = gridNudgeKey({ thread: "msg_tide", quietFrom: 1_000, turn: 2, taken: 0 });
    const other = gridNudgeKey({ thread: "msg_ship", quietFrom: 1_000, turn: 1, taken: 0 });
    const pending = [{ key: a }, { key: "reply-xyz" }];
    expect(gridNudgeHeld(pending, b)).toEqual({ thread: "msg_tide", held: { key: a } });
    // The same key is the outbox's own replay; another thread's nudge, or a typed reply, is not held back.
    expect(gridNudgeHeld(pending, a)).toEqual({ thread: "msg_tide", held: null });
    expect(gridNudgeHeld(pending, other)).toEqual({ thread: "msg_ship", held: null });
    expect(gridNudgeHeld(pending, "reply-abc")).toBeNull();
  });

  test("a list read works a row out only when it can go stale or was before, and reads its thread again only when it changed", () => {
    const { store, project } = setup();
    const asked = store.sendMessage({ project_id: project.id, author: TIDE, thread: "Haptics on save", body: "Opened #22." }).message;
    let reads = 0;
    const counted = { threadMessageIds: (id: string) => (reads++, store.threadMessageIds(id)), message: (id: string) => store.message(id), messageCursor: (id: string) => store.messageCursor(id), threadVersion: (id: string) => store.threadVersion(id) };
    const read = gridNudgeReader(counted);
    const waiting = { thread_id: asked.thread_id, section: "stopped", waiting_since: asked.created_at, questions: { open: 1 } } as InboxListRow;
    expect(read(waiting)).toBeUndefined();
    expect(reads).toBe(0);
    const open = { thread_id: asked.thread_id, section: "quiet", waiting_since: null, questions: { open: 0 } } as InboxListRow;
    read(open);
    read(open);
    expect(reads).toBe(1);
    store.sendMessage({ project_id: project.id, author: TIDE, body: "More.", reply_to: asked.id });
    expect(read(open)!.seq).toBe(store.messageCursor(store.threadMessageIds(asked.thread_id).at(-1)!)!);
    expect(reads).toBe(2);
  });
});
