/**
 * The person's Priority in the store: a file outside the event log. What can
 * regress: an add or remove writing a store line or moving a row's section,
 * an Undo not writing back the first time of an add, an archive leaving the
 * add in place, the file outliving a deleted thread across a restart, and a
 * newer or unreadable file being written over. The property runs a store with
 * Priority beside a twin that never uses it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(now?: () => Date) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-store-priority-"));
  roots.push(dir);
  const store = InboxStore.open(dir, now ? { now } : {});
  const project = store.ensureProject({ name: "repo", root: "/work/repo" });
  return { dir, store, project };
}

const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });
const ASK = ":::question\nWhich index?\n\n- [ ] Pagefind\n- [ ] Orama\n:::";
const file = (dir: string) => join(dir, "inbox", "priority.json");
const added = (store: InboxStore) => store.priorities().threads.map((e) => e.thread_id);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("the person's Priority in the store", () => {
  test("add keeps its first time, remove answers it, and the Undo writes exactly that back", () => {
    let clock = Date.parse("2026-11-12T10:00:00.000Z");
    const { dir, store, project } = open(() => new Date((clock += 60_000)));
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Ship the rate-limit change?" }).message;
    const reply = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Again", reply_to: a.id }).message;
    let told = 0;
    store.onPriorityChange(() => told++);
    const cursor = store.cursor();

    expect(store.setPriority(a.thread_id, true)).toEqual({ at: null, off_at: null });
    const first = store.priorities().threads[0]!.at;
    expect(store.setPriority(a.thread_id, true)).toEqual({ at: first, off_at: null });
    expect(store.priorities().threads[0]!.at).toBe(first);
    expect(told).toBe(1);

    expect(JSON.parse(readFileSync(file(dir), "utf8"))).toEqual({ v: 1, threads: [{ thread_id: a.thread_id, at: first }], off: [] });
    expect(statSync(file(dir)).mode & 0o777).toBe(0o600);

    const before = store.setPriority(a.thread_id, false);
    expect(before).toEqual({ at: first, off_at: null });
    expect(added(store)).toEqual([]);
    expect(existsSync(file(dir))).toBe(false);

    expect(store.restorePriority(a.thread_id, before)).toEqual({ at: null, off_at: null });
    expect(store.priorities().threads).toEqual([{ thread_id: a.thread_id, at: first }]);
    // None of it is a store line.
    expect(store.cursor()).toBe(cursor);

    // A reply is not a thread; an unknown id and a bad restore are refused.
    expect(code(() => store.setPriority(reply.id, true))).toBe("thread_not_found");
    expect(code(() => store.setPriority("msg_01K70000000000000000000099", true))).toBe("thread_not_found");
    for (const bad of [null, "x", { at: "soon", off_at: null }, { at: null }, [first, null]]) expect(code(() => store.restorePriority(a.thread_id, bad))).toBe("validation_error");
  });

  test("an archive drops the person's add; an archived thread takes no new add; a reply keeps it", () => {
    const { store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: ASK }).message;
    store.setPriority(a.thread_id, true);
    const first = store.priorities().threads[0]!.at;
    store.sendReply(a.id, { idempotency_key: "k1", words: "Pagefind." });
    expect(added(store)).toEqual([a.thread_id]);

    let told = 0;
    store.onPriorityChange(() => told++);
    store.resolveThread(a.id, true, "person");
    expect(added(store)).toEqual([]);
    expect(told).toBe(1);
    expect(code(() => store.setPriority(a.thread_id, true))).toBe("thread_resolved");

    // Archive's Undo: unarchive, then the add comes back with its first time.
    store.resolveThread(a.id, false, "person");
    store.restorePriority(a.thread_id, { at: first, off_at: null });
    expect(store.priorities().threads).toEqual([{ thread_id: a.thread_id, at: first }]);

    // An agent's resolve_message ends it too.
    store.resolveThread(a.id, true, "agent");
    expect(added(store)).toEqual([]);
  });

  test("a deleted thread's entry is pruned at the next load (a restart included), and the listeners hear it", () => {
    const { dir, store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "One" }).message;
    const b = store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "Two" }).message;
    store.setPriority(a.thread_id, true);
    store.setPriority(b.thread_id, true);
    let told = 0;
    store.onPriorityChange(() => told++);
    store.deleteThread(a.thread_id);
    expect(added(store)).toEqual([b.thread_id]);
    expect(told).toBe(1);

    // An entry for a thread this store never had (a file from an older run) goes at open, and the file is written back.
    const raw = JSON.parse(readFileSync(file(dir), "utf8"));
    raw.threads.push({ thread_id: "msg_01K70000000000000000000099", at: "2026-11-01T00:00:00.000Z" });
    writeFileSync(file(dir), JSON.stringify(raw));
    const again = InboxStore.open(dir);
    expect(added(again)).toEqual([b.thread_id]);
    expect(JSON.parse(readFileSync(file(dir), "utf8")).threads.map((e: { thread_id: string }) => e.thread_id)).toEqual([b.thread_id]);
  });

  test("a newer priority.json is refused and kept; an unreadable one is moved aside, never wiped", () => {
    const { dir, store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "One" }).message;
    const newer = JSON.stringify({ v: 2, threads: [{ thread: "x" }] });
    writeFileSync(file(dir), newer);
    expect(code(() => store.setPriority(a.thread_id, true))).toBe("priority_newer");
    expect(readFileSync(file(dir), "utf8")).toBe(newer);

    const bytes = '{"v":1,"threads":[';
    writeFileSync(file(dir), bytes);
    store.setPriority(a.thread_id, true);
    const aside = readdirSync(join(dir, "inbox")).filter((n) => n.startsWith("priority.json.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, "inbox", aside[0]!), "utf8")).toBe(bytes);
    expect(added(store)).toEqual([a.thread_id]);
  });

  test("property: Priority never changes a row, a section, a question, a read or the cursor", () => {
    type Op =
      | { kind: "send"; session: number; ask: boolean; name: number | null }
      | { kind: "add"; thread: number }
      | { kind: "remove"; thread: number }
      | { kind: "undo"; thread: number }
      | { kind: "read"; thread: number }
      | { kind: "resolve"; thread: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("send" as const), session: fc.nat(3), ask: fc.boolean(), name: fc.option(fc.nat(2), { nil: null }) }),
      fc.record({ kind: fc.constant("add" as const), thread: fc.nat(12) }),
      fc.record({ kind: fc.constant("remove" as const), thread: fc.nat(12) }),
      fc.record({ kind: fc.constant("undo" as const), thread: fc.nat(12) }),
      fc.record({ kind: fc.constant("read" as const), thread: fc.nat(12) }),
      fc.record({ kind: fc.constant("resolve" as const), thread: fc.nat(12) }),
    );
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 40 }), (ops) => {
        const withPriority = open();
        const twin = open();
        const threads: [string[], string[]] = [[], []];
        const lastBefore = new Map<string, { at: string | null; off_at: string | null }>();
        const view = (store: InboxStore, ids: string[]) =>
          store
            .listRows()
            .map((row) =>
              JSON.stringify({ i: ids.indexOf(row.thread_id), section: row.section, unread: row.unread, unseen: row.unseen, questions: row.questions, read: (row.read_at ?? null) !== null, resolved: row.resolved_at !== null, priority: "priority" in row }),
            )
            .sort();
        for (const step of ops) {
          const cursorBefore = withPriority.store.cursor();
          if (step.kind === "send") {
            const landed: number[] = [];
            for (const [k, w] of [withPriority, twin].entries()) {
              const result = w.store.sendMessage({ project_id: w.project.id, author: agent(`ses_${step.session}`), body: step.ask ? ASK : "News", ...(step.name !== null ? { thread: `lane-${step.name}` } : {}) }).message;
              if (!threads[k]!.includes(result.thread_id)) threads[k]!.push(result.thread_id);
              landed.push(threads[k]!.indexOf(result.thread_id));
            }
            expect(landed[0]).toBe(landed[1]);
            continue;
          }
          if (step.kind === "read" || step.kind === "resolve") {
            for (const [k, w] of [withPriority, twin].entries()) {
              const id = threads[k]![step.thread];
              if (!id) continue;
              if (step.kind === "read") code(() => w.store.markRead(id, true));
              else w.store.resolveThread(id, true, "person");
            }
            continue;
          }
          // Priority runs on one store only.
          const id = threads[0]![step.thread];
          if (!id) continue;
          if (step.kind === "add") code(() => lastBefore.set(id, withPriority.store.setPriority(id, true)));
          if (step.kind === "remove") lastBefore.set(id, withPriority.store.setPriority(id, false));
          if (step.kind === "undo" && lastBefore.has(id)) withPriority.store.restorePriority(id, lastBefore.get(id));
          expect(withPriority.store.cursor()).toBe(cursorBefore);
          expect(view(withPriority.store, threads[0]!)).toEqual(view(twin.store, threads[1]!));
          const ids = added(withPriority.store);
          expect(new Set(ids).size).toBe(ids.length);
        }
        expect(view(withPriority.store, threads[0]!)).toEqual(view(twin.store, threads[1]!));
        expect(withPriority.store.cursor()).toBe(twin.store.cursor());
      }),
      { numRuns: 60 },
    );
  });
});
