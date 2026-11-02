/**
 * Snoozes in the store (approval "inbox-snooze"): the person's own state,
 * outside the event log. What can regress: a snooze writing a store line or
 * taking a seq (an agent's cursor would move), an agent's message or new
 * question ending a snooze, the person's reply, Mark read or Archive not
 * ending it, a look ending it before its time, a return's mark lost on a
 * restart, the file left world-readable, and an entry outliving its thread.
 * The property runs a store with snoozes beside a twin that never snoozes and
 * checks every row an agent or the list reads never differs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A clock the test moves. */
function clock(start = "2026-11-03T14:40:00.000Z") {
  let at = Date.parse(start);
  return { now: () => new Date(at), go: (ms: number) => (at += ms) };
}
const HOUR = 3_600_000;

function open(now: () => Date, dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-store-snooze-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  const store = InboxStore.open(dir, { now });
  const project = store.ensureProject({ name: "repo", root: "/work/repo" });
  return { dir, store, project };
}

const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });
const ASK = ":::question\nWhich index?\n\n- [ ] Pagefind\n- [ ] Orama\n:::";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("snoozes in the store", () => {
  test("a snooze writes no store line, keeps the file owner-only, and survives a restart", () => {
    const t = clock();
    const { dir, store, project } = open(t.now);
    const thread = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "News" }).message.thread_id;
    const cursor = store.cursor();
    const until = new Date(t.now().getTime() + 2 * HOUR).toISOString();
    store.setSnooze(thread, until);
    expect(store.cursor()).toBe(cursor);
    const file = join(dir, "inbox", "snoozes.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, snoozes: [{ thread_id: thread, until, at: t.now().toISOString() }] });
    // The row agents and the list read is untouched: only the server's list model carries `snoozed`.
    expect(store.listRow(thread)).not.toHaveProperty("snoozed");
    const again = InboxStore.open(dir, { now: t.now });
    expect(again.snoozedThreads()).toEqual(new Set([thread]));
  });

  test("refuses a time gone by, an archived thread and a thread that is not one", () => {
    const t = clock();
    const { store, project } = open(t.now);
    const thread = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "News" }).message.thread_id;
    expect(code(() => store.setSnooze(thread, new Date(t.now().getTime() - 1000).toISOString()))).toBe("snooze_past");
    expect(code(() => store.setSnooze("msg_01K70000000000000000000099", new Date(t.now().getTime() + HOUR).toISOString()))).toBe("thread_not_found");
    store.resolveThread(thread, true);
    expect(code(() => store.setSnooze(thread, new Date(t.now().getTime() + HOUR).toISOString()))).toBe("thread_resolved");
  });

  test("nothing an agent writes ends it, a new question included", () => {
    const t = clock();
    const { store, project } = open(t.now);
    const thread = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "News", thread: "lane" }).message.thread_id;
    store.setSnooze(thread, new Date(t.now().getTime() + HOUR).toISOString());
    store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "More news", thread: "lane" });
    store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: ASK, thread: "lane" });
    expect(store.snoozedThreads().has(thread)).toBe(true);
    // The question is open for the agent, as it would be without a snooze.
    expect(store.listRow(thread)!.questions.open).toBe(1);
  });

  test("the person's reply, Mark read, Archive and Unsnooze end it", () => {
    const t = clock();
    const { store, project } = open(t.now);
    const until = () => new Date(t.now().getTime() + HOUR).toISOString();
    const make = (name: string, body = "News") => store.sendMessage({ project_id: project.id, author: agent(`ses_${name}`), body, thread: name }).message;
    const replied = make("r");
    store.setSnooze(replied.thread_id, until());
    store.sendReply(replied.id, { idempotency_key: "k1", words: "Thanks." });
    const read = make("m", ASK);
    store.setSnooze(read.thread_id, until());
    store.markRead(read.thread_id, true);
    const archived = make("a");
    store.setSnooze(archived.thread_id, until());
    store.resolveThread(archived.thread_id, true);
    const cleared = make("c");
    store.setSnooze(cleared.thread_id, until());
    store.clearSnooze(cleared.thread_id);
    expect(store.snoozes()).toEqual([]);
  });

  test("a look before its time leaves it; a look after its time takes the return's mark away", () => {
    const t = clock();
    const { dir, store, project } = open(t.now);
    const thread = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "News" }).message.thread_id;
    store.setSnooze(thread, new Date(t.now().getTime() + HOUR).toISOString());
    store.markSeen(thread);
    expect(store.snoozedThreads().has(thread)).toBe(true);
    t.go(HOUR + 1000);
    // Past its time it is no longer snoozed, but the entry stays (the row's clock) until a look, across a restart too.
    expect(store.snoozedThreads().has(thread)).toBe(false);
    expect(InboxStore.open(dir, { now: t.now }).snoozes().map((s) => s.thread_id)).toEqual([thread]);
    store.markSeen(thread);
    expect(store.snoozes()).toEqual([]);
  });

  test("a deleted thread leaves the file, and the listeners hear it", () => {
    const t = clock();
    const { store, project } = open(t.now);
    const thread = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "News" }).message.thread_id;
    store.setSnooze(thread, new Date(t.now().getTime() + HOUR).toISOString());
    let heard = 0;
    store.onSnoozesChange(() => (heard += 1));
    store.deleteThread(thread);
    expect(store.snoozes()).toEqual([]);
    expect(heard).toBe(1);
  });

  test("property: snoozes never change a row, a section, the cursor or where a send lands", () => {
    type Op =
      | { kind: "send"; session: number; ask: boolean; name: number | null }
      | { kind: "snooze"; thread: number; hours: number }
      | { kind: "unsnooze"; thread: number }
      | { kind: "look"; thread: number }
      | { kind: "tick"; hours: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("send" as const), session: fc.nat(3), ask: fc.boolean(), name: fc.option(fc.nat(2), { nil: null }) }),
      fc.record({ kind: fc.constant("snooze" as const), thread: fc.nat(8), hours: fc.integer({ min: 1, max: 30 }) }),
      fc.record({ kind: fc.constant("unsnooze" as const), thread: fc.nat(8) }),
      fc.record({ kind: fc.constant("look" as const), thread: fc.nat(8) }),
      fc.record({ kind: fc.constant("tick" as const), hours: fc.integer({ min: 1, max: 12 }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 40 }), (ops) => {
        const t = clock();
        const snoozing = open(t.now);
        const twin = open(t.now);
        const threads: [string[], string[]] = [[], []];
        const view = (store: InboxStore, ids: string[]) =>
          store
            .listRows()
            .map((row) =>
              JSON.stringify({
                i: ids.indexOf(row.thread_id),
                section: row.section,
                unread: row.unread,
                unseen: row.unseen,
                questions: row.questions,
                read: row.read_at ?? null,
                resolved: row.resolved_at !== null,
                snoozed: (row as { snoozed?: unknown }).snoozed,
              }),
            )
            .sort();
        for (const step of ops) {
          if (step.kind === "tick") {
            t.go(step.hours * HOUR);
            continue;
          }
          if (step.kind === "send" || step.kind === "look") {
            for (const [k, w] of [snoozing, twin].entries()) {
              if (step.kind === "look") {
                const id = threads[k]![step.thread];
                if (id) w.store.markSeen(id);
                continue;
              }
              const result = w.store.sendMessage({
                project_id: w.project.id,
                author: agent(`ses_${step.session}`),
                body: step.ask ? ASK : "News",
                ...(step.name !== null ? { thread: `lane-${step.name}` } : {}),
              }).message;
              if (!threads[k]!.includes(result.thread_id)) threads[k]!.push(result.thread_id);
            }
            continue;
          }
          // Snooze operations run on one store only, and move nothing else.
          const cursor = snoozing.store.cursor();
          const id = threads[0]![step.thread];
          if (id && step.kind === "snooze") snoozing.store.setSnooze(id, new Date(t.now().getTime() + step.hours * HOUR).toISOString());
          if (id && step.kind === "unsnooze") snoozing.store.clearSnooze(id);
          expect(snoozing.store.cursor()).toBe(cursor);
          expect(view(snoozing.store, threads[0]!)).toEqual(view(twin.store, threads[1]!));
        }
        expect(view(snoozing.store, threads[0]!)).toEqual(view(twin.store, threads[1]!));
        expect(snoozing.store.cursor()).toBe(twin.store.cursor());
        for (const snooze of snoozing.store.snoozes()) expect(snoozing.store.thread(snooze.thread_id)).not.toBeNull();
      }),
      { numRuns: 60 },
    );
  });
});
