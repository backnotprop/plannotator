/**
 * "Recent activity" (approval "inbox-recent-activity-filter"): when the person last did something in a thread, on a
 * real store in a temp dir on a clock the test moves (acted.ts, `InboxStore.personActedAt`), and the file for what
 * the log does not hold (acted.json). Failures to catch: a kind of the person's doing that leaves no time (a reply,
 * a pick, Done, a Re-ask, a comment); tidying or an agent's message that sets one; a time lost on reload; a note
 * written per save instead of once; the file growing without bound.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxMessage, InboxQuestionRecord } from "@plannotator/core/inbox-types";
import { INBOX_RECENT_ACTIVITY_DAYS } from "@plannotator/core/inbox-types";
import { INBOX_ACTED_FILE, INBOX_ACTED_MAX, createInboxActed, personActOfMessage, personActOfQuestion, readInboxActed } from "./acted";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const START = Date.parse("2026-11-20T09:00:00.000Z");
const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const BODY = ["The migration is ready.", "", ":::action", "Rotate the staging key", "Where: the vault", ":::", "", ":::question", "Ship it tonight?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-acted-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  const clock = { now: START };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  return { store, dir, clock };
}

function setup() {
  const opened = open();
  const project = opened.store.ensureProject({ name: "billing", root: "/work/billing" });
  const ask = () => opened.store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
  return { ...opened, project, ask };
}

const at = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

describe("the store's record of what the person did in a thread", () => {
  test("an agent's message alone sets nothing; each kind of the person's doing sets the time it happened", () => {
    const { store, clock, ask } = setup();
    const asked = ask();
    expect(store.personActedAt(asked.thread_id)).toBeNull();

    // A pick.
    clock.now = START + 60_000;
    const question = store.questionsOf(asked.id).find((q) => q.kind !== "action")!;
    store.savePicks(asked.id, [{ key: question.key, revision: question.revision, answer: { v: 1, key: question.key, kind: question.kind as "single", prompt: question.prompt, selected: ["Yes"] } }]);
    expect(store.personActedAt(asked.thread_id)).toBe(at(START + 60_000));

    // Done on an action item.
    clock.now = START + 120_000;
    const action = store.questionsOf(asked.id).find((q) => q.kind === "action")!;
    store.markAction(asked.id, action.key, { outcome: "done" });
    expect(store.personActedAt(asked.thread_id)).toBe(at(START + 120_000));

    // A reply.
    clock.now = START + 180_000;
    store.sendReply(asked.id, { idempotency_key: "r1", words: "Shipping tonight." });
    expect(store.personActedAt(asked.thread_id)).toBe(at(START + 180_000));

    // A comment on the agent's message.
    clock.now = START + 240_000;
    store.saveMessageAnnotation(asked.id, { id: "ann-1", blockId: "block-0", startOffset: 0, endOffset: 3, type: "COMMENT", text: "Which key?", originalText: "The", createdA: 1 });
    expect(store.personActedAt(asked.thread_id)).toBe(at(START + 240_000));
  });

  test("a Re-ask is the person's doing", () => {
    const { store, clock, ask } = setup();
    const asked = ask();
    clock.now = START + 90_000;
    store.sendReask(asked.id, { idempotency_key: "q1" });
    expect(store.personActedAt(asked.thread_id)).toBe(at(START + 90_000));
  });

  test("tidying never sets it: star, Priority, snooze, tag, mark read and unread, archive", () => {
    const { store, clock, ask } = setup();
    const asked = ask();
    const id = asked.thread_id;
    clock.now = START + 60_000;
    store.setPinned(id, true);
    store.setPriority(id, true);
    store.setSnooze(id, at(START + 86_400_000));
    store.setThreadTagNamed(id, "Launch", true);
    store.markRead(id, true);
    store.markRead(id, false);
    store.markUnread(id);
    store.resolveThread(id, true, "person");
    expect(store.personActedAt(id)).toBeNull();
  });

  test("a reload of the store rebuilds it from the log, and another agent message never moves it", () => {
    const { store, dir, clock, ask, project } = setup();
    const asked = ask();
    clock.now = START + 60_000;
    store.sendReply(asked.id, { idempotency_key: "r1", words: "Go." });
    clock.now = START + 600_000;
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Done, shipped.", reply_to: asked.id });
    expect(store.personActedAt(asked.thread_id)).toBe(at(START + 60_000));
    const again = InboxStore.open(dir, { now: () => new Date(clock.now) });
    expect(again.personActedAt(asked.thread_id)).toBe(at(START + 60_000));
  });
});

describe("a 👍 and a review's ticks: later lines of an agent's message", () => {
  test("a 👍 Looks good counts at its press, through its settling and a reload; the agent's next message moves nothing", () => {
    const { store, dir, clock, project } = setup();
    const sent = store.sendMessage({ project_id: project.id, author: AGENT, body: "Retries now wait 24 hours." }).message;
    expect(store.personActedAt(sent.thread_id)).toBeNull();
    clock.now = START + 60_000;
    store.ackMessage(sent.id, true);
    expect(store.personActedAt(sent.thread_id)).toBe(at(START + 60_000));
    // The Undo window passes: the ack settles and its note goes to the agent, at a later time that is not a new act.
    clock.now = START + 120_000;
    expect(store.settleAcks(10_000)).toHaveLength(1);
    expect(store.personActedAt(sent.thread_id)).toBe(at(START + 60_000));
    clock.now = START + 180_000;
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Thanks.", reply_to: sent.id });
    expect(store.personActedAt(sent.thread_id)).toBe(at(START + 60_000));
    expect(InboxStore.open(dir, { now: () => new Date(clock.now) }).personActedAt(sent.thread_id)).toBe(at(START + 60_000));
  });

  test("ticking a guided review's section or a review's file Viewed counts when it changes; the same ticks again do not", () => {
    const { store, dir, clock, project } = setup();
    const guide = { sha256: "a".repeat(64), input_sha256: "b".repeat(64), bytes: 10, title: "Refund retries", sections: 2, files: 2, additions: 4, deletions: 1, review: true as const };
    const sent = store.sendMessage({ project_id: project.id, author: AGENT, body: "Please review.", guide }).message;
    expect(store.personActedAt(sent.thread_id)).toBeNull();
    clock.now = START + 60_000;
    store.saveGuideReviewed(sent.id, [true, false]);
    expect(store.personActedAt(sent.thread_id)).toBe(at(START + 60_000));
    clock.now = START + 120_000;
    store.saveGuideReviewed(sent.id, [true, false]);
    expect(store.personActedAt(sent.thread_id)).toBe(at(START + 60_000));
    clock.now = START + 180_000;
    store.saveGuideViewed(sent.id, ["src/refunds.ts"], ["src/refunds.ts", "src/retry.ts"]);
    expect(store.personActedAt(sent.thread_id)).toBe(at(START + 180_000));
    expect(InboxStore.open(dir, { now: () => new Date(clock.now) }).personActedAt(sent.thread_id)).toBe(at(START + 180_000));
  });

  test("one file's Viewed tick lays over what is kept: ticks held for a while never undo others, made here or there", () => {
    const { store, project } = setup();
    const guide = { sha256: "a".repeat(64), input_sha256: "b".repeat(64), bytes: 10, title: "Refund retries", sections: 1, files: 3, additions: 4, deletions: 1, review: true as const };
    const files = ["src/refunds.ts", "src/retry.ts", "src/ledger.ts"];
    const sent = store.sendMessage({ project_id: project.id, author: AGENT, body: "Please review.", guide }).message;
    // On this machine, while the other was away: ledger ticked here.
    expect(store.saveGuideViewed(sent.id, true, files, "src/ledger.ts")).toEqual(["src/ledger.ts"]);
    // Then the two ticks the other machine held arrive, in order (refunds, then retry): neither undoes ledger.
    store.saveGuideViewed(sent.id, true, files, "src/refunds.ts");
    expect(store.saveGuideViewed(sent.id, true, files, "src/retry.ts")).toEqual(["src/ledger.ts", "src/refunds.ts", "src/retry.ts"]);
    // A copy of a held tick changes nothing; an untick takes that file alone.
    expect(store.saveGuideViewed(sent.id, true, files, "src/retry.ts")).toEqual(["src/ledger.ts", "src/refunds.ts", "src/retry.ts"]);
    expect(store.saveGuideViewed(sent.id, false, files, "src/refunds.ts")).toEqual(["src/ledger.ts", "src/retry.ts"]);
    expect(() => store.saveGuideViewed(sent.id, true, files, "src/elsewhere.ts")).toThrow();
    expect(() => store.saveGuideViewed(sent.id, ["src/retry.ts"], files, "src/retry.ts")).toThrow();
  });
});

describe("which records are the person's doing", () => {
  const message = (extra: Partial<InboxMessage>): InboxMessage =>
    ({ id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", project_id: "prj_x", thread_id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", reply_to: null, author: { kind: "person" }, subject: null, body: "Yes", created_at: at(START), resolved_at: null, idempotency_key: null, ...extra }) as InboxMessage;

  test("the person's own message counts; an agent's, the Inbox's notes and a routine's run do not", () => {
    expect(personActOfMessage(message({}))).toBe(at(START));
    expect(personActOfMessage(message({ author: AGENT }))).toBeNull();
    expect(personActOfMessage(message({ set_aside: ["msg_x/q1"] }))).toBeNull();
    expect(personActOfMessage(message({ ack_of: "msg_x" }))).toBeNull();
    expect(personActOfMessage(message({ scheduled_run: { scheduled_id: "sch_1", run: 3, by: "schedule", due_at: at(START) } } as Partial<InboxMessage>))).toBeNull();
  });

  test("a pick or a mark is the person's only when they made it", () => {
    const record = { picked_by: null, picked_at: null, action_result: null } as unknown as InboxQuestionRecord;
    expect(personActOfQuestion(record)).toBeNull();
    expect(personActOfQuestion({ ...record, action_result: { outcome: "done", note: null, at: at(START), by: "agent" } } as InboxQuestionRecord)).toBeNull();
    expect(personActOfQuestion({ ...record, action_result: { outcome: "skip", note: null, at: at(START), by: "person" } } as InboxQuestionRecord)).toBe(at(START));
    expect(personActOfQuestion({ ...record, picked_by: { id: "person", name: null }, picked_at: at(START + 5) } as InboxQuestionRecord)).toBe(at(START + 5));
  });
});

describe("acted.json: what the log does not hold", () => {
  const T1 = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const T2 = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const dirOf = () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-acted-file-"));
    roots.push(dir);
    return dir;
  };
  /** The server's clock: a day after START, whatever day the test runs. */
  const clockAt = () => new Date(START + DAY);

  test("notes wait for one write; an older time never replaces a newer one; a restart reads them back", () => {
    const dir = dirOf();
    const acted = createInboxActed(dir, { flushMs: 60_000, now: clockAt });
    acted.note(T1, at(START + 10));
    acted.note(T1, at(START + 30));
    acted.note(T1, at(START + 20));
    acted.note(T2, at(START));
    expect(acted.at(T1)).toBe(at(START + 30));
    // Nothing written yet: many saves are one write.
    expect(existsSync(join(dir, INBOX_ACTED_FILE))).toBe(false);
    acted.flush();
    expect(readInboxActed(dir)).toEqual(new Map([[T1, at(START + 30)], [T2, at(START)]]));
    expect(createInboxActed(dir, { now: clockAt }).at(T1)).toBe(at(START + 30));
  });

  test("no note, no write; a value that is not a thread id is dropped; the file keeps the newest threads only", () => {
    const dir = dirOf();
    createInboxActed(dir).flush();
    expect(existsSync(join(dir, INBOX_ACTED_FILE))).toBe(false);
    const acted = createInboxActed(dir, { flushMs: 60_000, now: clockAt });
    acted.note("../etc", at(START));
    expect(acted.at("../etc")).toBeNull();
    const ids = Array.from({ length: INBOX_ACTED_MAX + 5 }, (_, i) => `msg_${String(i).padStart(26, "0")}`);
    ids.forEach((id, i) => acted.note(id, at(START + i * 1000)));
    acted.flush();
    const kept = readInboxActed(dir);
    expect(kept.size).toBe(INBOX_ACTED_MAX);
    expect(kept.has(ids[0]!)).toBe(false);
    expect(kept.has(ids.at(-1)!)).toBe(true);
  });

  test("a file that does not read is none; the next write moves it aside, kept as it was, and writes a good one", () => {
    const dir = dirOf();
    writeFileSync(join(dir, INBOX_ACTED_FILE), "{nope");
    const acted = createInboxActed(dir, { flushMs: 60_000, now: clockAt });
    expect(acted.at(T1)).toBeNull();
    acted.note(T1, at(START));
    acted.flush();
    expect(JSON.parse(readFileSync(join(dir, INBOX_ACTED_FILE), "utf8"))).toEqual({ v: 1, threads: { [T1]: at(START) } });
    const aside = readdirSync(dir).filter((name) => name.startsWith(`${INBOX_ACTED_FILE}.unreadable-`));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe("{nope");
  });

  test("a newer Plannotator's file is never written over: the notes hold in memory, and the file stays byte for byte", () => {
    const dir = dirOf();
    const newer = `${JSON.stringify({ v: 2, threads: { [T2]: { at: at(START), kind: "open" } } })}\n`;
    writeFileSync(join(dir, INBOX_ACTED_FILE), newer);
    const acted = createInboxActed(dir, { flushMs: 60_000, now: clockAt });
    acted.note(T1, at(START));
    acted.flush();
    expect(readFileSync(join(dir, INBOX_ACTED_FILE), "utf8")).toBe(newer);
    expect(readdirSync(dir).filter((name) => name.includes(".unreadable-"))).toEqual([]);
    expect(acted.at(T1)).toBe(at(START));
  });

  test("each write drops what the filter no longer reaches (past 30 days) and the threads this store deleted; a linked machine's thread stays", () => {
    const dir = dirOf();
    const OLD = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const LINKED = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAY";
    const now = START + 40 * DAY;
    const held = new Set([T1, T2, OLD]);
    const acted = createInboxActed(dir, { flushMs: 60_000, now: () => new Date(now), held: (id) => held.has(id) });
    acted.note(T1, at(now - 2 * DAY));
    acted.note(T2, at(now - DAY));
    acted.note(OLD, at(now - (INBOX_RECENT_ACTIVITY_DAYS + 1) * DAY));
    acted.note(LINKED, at(now - 3 * DAY));
    acted.flush();
    expect(readInboxActed(dir)).toEqual(new Map([[T2, at(now - DAY)], [T1, at(now - 2 * DAY)], [LINKED, at(now - 3 * DAY)]]));
    // T2 is deleted here: the deletion's sweep writes the file without it, with no other note.
    held.delete(T2);
    acted.sweep();
    acted.flush();
    expect([...readInboxActed(dir).keys()]).toEqual([T1, LINKED]);
    // A restart knows which of the file's threads it holds: a deletion after it sweeps them too.
    const again = createInboxActed(dir, { flushMs: 60_000, now: () => new Date(now), held: (id) => held.has(id) });
    held.delete(T1);
    again.sweep();
    again.flush();
    expect([...readInboxActed(dir).keys()]).toEqual([LINKED]);
  });

  test("a time ahead of the clock (the clock set back since) is never read, gives way to the next note, and the next write drops it", () => {
    const dir = dirOf();
    const AHEAD = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const now = START + DAY;
    // Noted on a clock a day fast, then set right; T1's time is 30 s ahead, inside the margin, and stays.
    writeFileSync(join(dir, INBOX_ACTED_FILE), JSON.stringify({ v: 1, threads: { [AHEAD]: at(now + DAY), [T1]: at(now + 30_000), [T2]: at(now - 60_000) } }));
    const acted = createInboxActed(dir, { flushMs: 60_000, now: () => new Date(now) });
    expect(acted.at(AHEAD)).toBeNull();
    expect(acted.at(T1)).toBe(at(now + 30_000));
    expect(acted.at(T2)).toBe(at(now - 60_000));
    acted.note(T2, at(now));
    acted.flush();
    expect(readInboxActed(dir)).toEqual(new Map([[T1, at(now + 30_000)], [T2, at(now)]]));

    // Set back while the server runs: the kept time is no longer read, and an act now replaces it.
    let clock = now + DAY;
    const running = createInboxActed(dir, { flushMs: 60_000, now: () => new Date(clock) });
    running.note(AHEAD, at(clock));
    clock = now;
    expect(running.at(AHEAD)).toBeNull();
    running.note(AHEAD, at(clock - 1000));
    expect(running.at(AHEAD)).toBe(at(clock - 1000));
  });
});
