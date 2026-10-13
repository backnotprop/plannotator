/**
 * Invariants of the Inbox store, checked over generated operation sequences
 * against the real files in a temp data dir:
 *  - round trip: reopening the store from disk gives the same view;
 *  - seq: one counter, strictly increasing, every line unique;
 *  - a torn last line (a crash mid-append) is skipped, and the next append
 *    still reads back whole;
 *  - idempotency keys: a replayed send or Send writes nothing.
 * Plus the question key: the store's keys are core's keys.
 *
 * And the thread-state model (adr/implementation/inbox-thread-state.md): an
 * independent model of the list's rules, checked against the store after
 * every step of generated and hand-written sequences, the invariants on both
 * list views, the trace fixtures the phone apps replay
 * (fixtures/thread-state/v1/), and the minimal sequences of the three
 * violations it found (A, B, C), fixed since.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questionKey, type QuestionAnswer } from "@plannotator/core/question-block";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { INBOX_SECTIONS, inboxThreadNameKey, type InboxListRow, type InboxListSection, type InboxSectionId } from "@plannotator/core/inbox-types";
// The sidebar's counts and the decisions the Send route records, from the code that computes them.
import { waitingCount } from "../../inbox/held";
import { recordDecisionsForReply, waitingDecisionCount } from "../../server/inbox-decisions";
import { inboxArchivedRows, inboxListSections, inboxRowArchived } from "./list";
import { InboxError, parseInboxLine } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-inbox-store-"));
  roots.push(root);
  return root;
}

/** Everything a reader can observe, as plain JSON. */
function view(store: InboxStore) {
  return {
    projects: store.listProjects().map((project) => ({
      project,
      threads: store.threadsOf(project.id).map((summary) => ({ summary, thread: store.thread(summary.thread_id) })),
      sections: store.listSections(project.id),
    })),
    sections: store.listSections(),
  };
}

function storeFiles(dir: string): string[] {
  const projects = join(dir, "inbox", "projects");
  const out: string[] = [];
  let keys: string[] = [];
  try {
    keys = readdirSync(projects);
  } catch {
    return out;
  }
  for (const key of keys) for (const name of readdirSync(join(projects, key))) out.push(join(projects, key, name));
  return out;
}

function allLines(dir: string) {
  return storeFiles(dir).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => parseInboxLine(line))
      .filter((line) => line !== null),
  );
}

// ─────────────────────────── generated operations ───────────────────────────

const promptArb = fc.stringMatching(/^[A-Za-z][A-Za-z ?,]{2,40}$/).map((s) => s.trim() + "?");
const labelArb = fc.stringMatching(/^[A-Za-z][A-Za-z ]{1,20}$/).map((s) => s.trim());

const bodyArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9 .,]{1,60}$/).filter((s) => s.trim().length > 0),
  // Any text an agent can send, newlines, quotes, NULs, U+2028 and lone
  // surrogates included: a body can never break out of its JSONL line.
  fc.string({ unit: "binary", minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
  fc.constant('x"}\n{"v":1,"seq":999999,"at":"x","kind":"message","id":"msg_FAKE","record":{"id":"msg_FAKE"}}\n'),
  fc.tuple(promptArb, fc.uniqueArray(labelArb, { minLength: 2, maxLength: 4, selector: (s) => s.toLowerCase() })).map(
    ([prompt, labels]) => [":::question", prompt, "", ...labels.map((l) => `- [ ] ${l}`), ":::"].join("\n"),
  ),
  promptArb.map((prompt) => [":::question-text", prompt, ":::"].join("\n")),
);

type Op =
  // An agent's message without reply_to: it routes to the session's open default thread, or starts one.
  | { op: "send"; root: number; body: string; key: string | null; session?: string | null }
  | { op: "reply"; target: number; body: string }
  | { op: "pick"; target: number; choice: number; question?: number }
  // The person's Send: the message's picks and words; `skip` is the Send that skips (false: Keep open).
  | { op: "personSend"; target: number; key: string; words: string; skip?: boolean }
  | { op: "resolve"; target: number; resolved: boolean }
  | { op: "supersede"; target: number; whole: boolean; body: string }
  // The person opened the thread (POST /api/inbox/threads/:id/seen). `through`
  // (an index like `target`): the look stops at that agent message's seq
  // (`through_seq`: the newest message the window showed).
  | { op: "seen"; target: number; through?: number }
  // Mark read, or its Undo (POST /api/inbox/threads/:id/read and /unread).
  | { op: "read"; target: number; read: boolean }
  // An agent read the thread (read_thread, or wait_for_reply handed it the reply).
  | { op: "agentRead"; target: number }
  // The Undo window passed: the server tells the asking agent what a Mark read set aside.
  | { op: "tell"; target: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("send" as const), root: fc.nat(2), body: bodyArb, key: fc.option(fc.constantFrom("a", "b", "c"), { nil: null }) }),
  fc.record({ op: fc.constant("reply" as const), target: fc.nat(), body: bodyArb }),
  fc.record({ op: fc.constant("pick" as const), target: fc.nat(), choice: fc.nat(3) }),
  fc.record({ op: fc.constant("personSend" as const), target: fc.nat(), key: fc.constantFrom("s1", "s2"), words: fc.constantFrom("", "ok", "go ahead"), skip: fc.boolean() }),
  fc.record({ op: fc.constant("resolve" as const), target: fc.nat(), resolved: fc.boolean() }),
  // An agent replaces an earlier question (or a whole message's), replying in its thread.
  fc.record({ op: fc.constant("supersede" as const), target: fc.nat(), whole: fc.boolean(), body: bodyArb }),
  fc.record({ op: fc.constant("seen" as const), target: fc.nat() }),
  fc.record({ op: fc.constant("read" as const), target: fc.nat(), read: fc.boolean() }),
  fc.record({ op: fc.constant("agentRead" as const), target: fc.nat() }),
  fc.record({ op: fc.constant("tell" as const), target: fc.nat() }),
);

/** What one op did: wrote, wrote nothing (no target, or no question to pick), replayed a key, or was refused with a code. */
type Outcome = "ok" | "noop" | "replayed" | `refused:${string}`;

/** The message an op aims at (every op but `send`): the n-th message an agent wrote, wrapping. */
function targetOf(op: Op, messageIds: readonly string[]): string | undefined {
  return op.op === "send" ? undefined : messageIds[op.target % Math.max(1, messageIds.length)];
}

/**
 * Run one op as the server's route does; expected refusals (InboxError) are
 * part of the space and write nothing. A Send also records the decisions its
 * answers carry, as POST /messages/:id/reply does after the reply lands.
 */
function run(store: InboxStore, op: Op, messageIds: string[]): Outcome {
  const target = targetOf(op, messageIds);
  const threadOf = (id: string) => store.message(id)!.thread_id;
  try {
    switch (op.op) {
      case "send": {
        const project = store.ensureProject({ name: `repo${op.root}`, root: `/work/repo${op.root}` });
        const result = store.sendMessage({
          project_id: project.id,
          author: { kind: "agent", host: "test", session: op.session === undefined ? "ses_x" : op.session, name: null },
          body: op.body,
          idempotency_key: op.key,
        });
        if (result.replayed) return "replayed";
        messageIds.push(result.message.id);
        return "ok";
      }
      case "reply": {
        if (!target) return "noop";
        const message = store.message(target)!;
        const result = store.sendMessage({
          project_id: message.project_id,
          author: { kind: "agent", host: "test", session: "ses_x", name: null },
          body: op.body,
          reply_to: target,
        });
        messageIds.push(result.message.id);
        return "ok";
      }
      case "pick": {
        if (!target) return "noop";
        const questions = store.questionsOf(target);
        const question = questions[(op.question ?? 0) % Math.max(1, questions.length)];
        if (!question) return "noop";
        const answer: QuestionAnswer =
          question.kind === "text"
            ? { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: [], text: "free" }
            : { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: [question.choices[op.choice % question.choices.length]!.label] };
        store.savePicks(target, [{ key: question.key, revision: question.revision, answer }]);
        return "ok";
      }
      case "personSend": {
        if (!target) return "noop";
        const picked = store.questionsOf(target).filter((q) => q.state === "picked");
        const result = store.sendReply(target, {
          words: op.words,
          idempotency_key: op.key,
          questions: picked.map((q) => ({ key: q.key, revision: q.revision })),
          skip_unanswered: op.skip === true,
        });
        if (result.replayed) return "replayed";
        recordDecisionsForReply(store, result.reply.id);
        return "ok";
      }
      case "resolve": {
        if (!target) return "noop";
        store.resolveThread(target, op.resolved);
        return "ok";
      }
      case "supersede": {
        if (!target) return "noop";
        const message = store.message(target)!;
        const first = store.questionsOf(target)[0];
        const result = store.sendMessage({
          project_id: message.project_id,
          author: { kind: "agent", host: "test", session: "ses_x", name: null },
          body: op.body,
          reply_to: target,
          supersedes: [op.whole || !first ? target : `${target}/${first.key}`],
        });
        messageIds.push(result.message.id);
        return "ok";
      }
      case "seen": {
        if (!target) return "noop";
        const through = op.through === undefined ? undefined : messageIds[op.through % messageIds.length];
        store.markSeen(threadOf(target), through === undefined ? undefined : (store.messageCursor(through) ?? undefined));
        return "ok";
      }
      case "read":
        if (!target) return "noop";
        store.markRead(threadOf(target), op.read);
        return "ok";
      case "agentRead":
        if (!target) return "noop";
        store.markAgentChecked(threadOf(target));
        return "ok";
      case "tell":
        if (!target) return "noop";
        store.tellSetAside(threadOf(target), 0);
        return "ok";
    }
  } catch (error) {
    if (!(error instanceof InboxError)) throw error;
    return `refused:${error.code}`;
  }
}

describe("InboxStore invariants", () => {
  test("round trip: reopening from disk gives exactly the live view", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const dir = dataDir();
        const store = InboxStore.open(dir);
        const ids: string[] = [];
        for (const op of ops) run(store, op, ids);
        const reopened = InboxStore.open(dir);
        expect(view(reopened)).toEqual(view(store));
        expect(reopened.cursor()).toBe(store.cursor());
        expect(reopened.changesSince(0)).toEqual(store.changesSince(0));
      }),
      { numRuns: 60 },
    );
  });

  test("seq is one counter: unique, increasing in write order, and the cursor is the last one", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const dir = dataDir();
        const store = InboxStore.open(dir);
        const written: number[] = [];
        store.subscribe((line) => written.push(line.seq));
        const ids: string[] = [];
        for (const op of ops) run(store, op, ids);
        for (let i = 1; i < written.length; i++) expect(written[i]).toBe(written[i - 1]! + 1);
        const onDisk = allLines(dir).map((l) => l.seq).sort((a, b) => a - b);
        expect(onDisk).toEqual(written);
        expect(store.cursor()).toBe(written.at(-1) ?? 0);
        // Later writes continue the counter after a reopen.
        const reopened = InboxStore.open(dir);
        const next: number[] = [];
        reopened.subscribe((line) => next.push(line.seq));
        run(reopened, { op: "send", root: 0, body: "after reopen", key: null }, []);
        expect(next[0]).toBe((written.at(-1) ?? 0) + 1);
      }),
      { numRuns: 60 },
    );
  });

  test("a torn last line is skipped, and the next append reads back whole", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 20 }), fc.double({ min: 0.05, max: 0.95, noNaN: true }), (ops, cut) => {
        const dir = dataDir();
        const store = InboxStore.open(dir);
        const ids: string[] = [];
        for (const op of ops) run(store, op, ids);
        const jsonl = storeFiles(dir).filter((f) => f.endsWith(".jsonl") && statSync(f).size > 0);
        if (jsonl.length === 0) return;
        const file = jsonl[0]!;
        const text = readFileSync(file, "utf8");
        const lastStart = text.lastIndexOf("\n", text.length - 2) + 1;
        const lastLength = text.length - 1 - lastStart;
        const tornLine = parseInboxLine(text.slice(lastStart))!;
        // Crash mid-append: keep only part of the last line, no newline.
        truncateSync(file, lastStart + Math.max(1, Math.floor(lastLength * cut)));

        const recovered = InboxStore.open(dir);
        // Everything but the torn record's last snapshot survives; the torn line is gone.
        expect(recovered.changesSince(0).some((l) => l.seq === tornLine.seq)).toBe(false);
        expect(recovered.changesSince(0).length).toBeGreaterThan(0);

        // The next write to THAT file (a message, with a question, in the torn
        // file's project) lands on its own line and reads back whole.
        const key = file.split("/").at(-2)!;
        const project = recovered.listProjects().find((p) => p.key === key)!;
        const before = recovered.cursor();
        const body = ":::question\nWritten after the crash?\n\n- [ ] Yes\n- [ ] No\n:::";
        const written = recovered.sendMessage({
          project_id: project.id,
          author: { kind: "agent", host: null, session: null, name: null },
          body,
        });
        const again = InboxStore.open(dir);
        const after = again.changesSince(before);
        expect(after.some((l) => l.kind === "message" && l.record.body === body)).toBe(true);
        expect(after.some((l) => l.kind === "question" && l.record.message_id === written.message.id)).toBe(true);
        expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  test("idempotency keys: replaying a send or a Send writes nothing", () => {
    fc.assert(
      fc.property(bodyArb, fc.integer({ min: 2, max: 5 }), (body, times) => {
        const dir = dataDir();
        const store = InboxStore.open(dir);
        const project = store.ensureProject({ name: "repo", root: "/work/repo" });
        const author = { kind: "agent" as const, host: null, session: "ses_x", name: null };
        const first = store.sendMessage({ project_id: project.id, author, body, idempotency_key: "same" });
        const cursor = store.cursor();
        for (let i = 0; i < times; i++) {
          const again = store.sendMessage({ project_id: project.id, author, body, idempotency_key: "same" });
          expect(again).toMatchObject({ replayed: true, message: { id: first.message.id } });
        }
        expect(store.cursor()).toBe(cursor);
        expect(() => store.sendMessage({ project_id: project.id, author, body: `${body} changed`, idempotency_key: "same" })).toThrow(
          expect.objectContaining({ code: "idempotency_key_reused" }),
        );

        const reply = store.sendReply(first.message.id, { words: "thanks", idempotency_key: "send" });
        const afterSend = store.cursor();
        for (let i = 0; i < times; i++) {
          const replay = store.sendReply(first.message.id, { words: "thanks", idempotency_key: "send" });
          expect(replay).toMatchObject({ replayed: true, reply: { id: reply.reply.id } });
        }
        expect(store.cursor()).toBe(afterSend);
        expect(InboxStore.open(dir).thread(first.message.thread_id)!.messages).toHaveLength(2);
      }),
      { numRuns: 40 },
    );
  });

  // A read-only file is how the test makes the append fail; root and Windows ignore that mode.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a Send whose reply line never landed reads as picked, and can be sent again", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "repo", root: "/work/repo" });
    const author = { kind: "agent" as const, host: null, session: null, name: null };
    const sent = store.sendMessage({ project_id: project.id, author, body: ":::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::" });
    const q = store.questionsOf(sent.message.id)[0]!;
    store.savePicks(sent.message.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] } }]);
    const messagesFile = join(dir, "inbox", "projects", project.key, "messages.jsonl");

    // The append of the reply fails (here: the file is read-only) after the
    // questions' "sent" lines were written.
    chmodSync(messagesFile, 0o400);
    try {
      expect(() => store.sendReply(sent.message.id, { idempotency_key: "s", questions: [{ key: q.key, revision: 1 }] })).toThrow();
    } finally {
      chmodSync(messagesFile, 0o600);
    }
    // Live and after a restart: picked, not "sent" with nothing sent.
    expect(store.questionsOf(sent.message.id)[0]!.state).toBe("picked");
    const reopened = InboxStore.open(dir);
    expect(reopened.questionsOf(sent.message.id)[0]).toMatchObject({ state: "picked", sent_reply_id: null });
    expect(reopened.thread(sent.message.thread_id)!.messages).toHaveLength(1);

    // The person's retry of the same Send now goes through, once.
    const retry = reopened.sendReply(sent.message.id, { idempotency_key: "s", questions: [{ key: q.key, revision: 1 }] });
    expect(retry.replayed).toBe(false);
    expect(retry.questions[0]).toMatchObject({ state: "sent", sent_reply_id: retry.reply.id });
    expect(InboxStore.open(dir).questionsOf(sent.message.id)[0]).toMatchObject({ state: "sent", sent_reply_id: retry.reply.id });
  });

  test("two same-named roots whose 6-hex keys collide still get separate folders", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    // Find two roots whose short keys collide (a birthday search over 6 hex).
    const seen = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; !pair; i++) {
      const root = `/work/${i}/api`;
      const short = createHash("sha256").update(root).digest("hex").slice(0, 6);
      const other = seen.get(short);
      if (other) pair = [other, root];
      else seen.set(short, root);
    }
    const a = store.ensureProject({ name: "api", root: pair[0] });
    const b = store.ensureProject({ name: "api", root: pair[1] });
    expect(a.key).not.toBe(b.key);
    store.sendMessage({ project_id: a.id, author: { kind: "agent", host: null, session: null, name: null }, body: "to a" });
    const reopened = InboxStore.open(dir);
    expect(reopened.listProjects().map((p) => p.root).sort()).toEqual([...pair].sort());
    expect(reopened.threadsOf(a.id)).toHaveLength(1);
  });

  test("routing is deterministic given the event log: an independent replay of the lines assigns every message the same thread", () => {
    type RouteOp =
      | { op: "send"; project: number; session: string | null; thread: string | null; key: string | null; body: string }
      | { op: "reply"; target: number; session: string | null; thread: string | null }
      | { op: "resolve"; target: number; resolved: boolean }
      | { op: "seen"; target: number }
      | { op: "personReply"; target: number; key: string };
    const routeOpArb: fc.Arbitrary<RouteOp> = fc.oneof(
      {
        arbitrary: fc.record({
          op: fc.constant("send" as const),
          project: fc.nat(1),
          session: fc.constantFrom("ses_a", "ses_b", null),
          thread: fc.constantFrom(null, null, "alpha", "Alpha ", "al\u200Bpha", "beta", "  BETA", "ｂｅｔａ"),
          key: fc.option(fc.constantFrom("k1", "k2"), { nil: null }),
          body: fc.constantFrom("one", "two", "three"),
        }),
        weight: 5,
      },
      fc.record({ op: fc.constant("reply" as const), target: fc.nat(), session: fc.constantFrom("ses_a", "ses_b", null), thread: fc.constantFrom(null, "alpha") }),
      { arbitrary: fc.record({ op: fc.constant("resolve" as const), target: fc.nat(), resolved: fc.boolean() }), weight: 2 },
      fc.record({ op: fc.constant("seen" as const), target: fc.nat() }),
      fc.record({ op: fc.constant("personReply" as const), target: fc.nat(), key: fc.constantFrom("p1", "p2", "p3") }),
    );

    fc.assert(
      fc.property(fc.array(routeOpArb, { maxLength: 40 }), (ops) => {
        const dir = dataDir();
        const store = InboxStore.open(dir);
        const ids: string[] = [];
        const pick = (n: number) => ids[n % Math.max(1, ids.length)];
        for (const op of ops) {
          try {
            if (op.op === "send") {
              const project = store.ensureProject({ name: `repo${op.project}`, root: `/work/repo${op.project}` });
              const r = store.sendMessage({
                project_id: project.id,
                author: { kind: "agent", host: null, session: op.session, name: null },
                body: op.body,
                thread: op.thread,
                idempotency_key: op.key,
              });
              if (!r.replayed) ids.push(r.message.id);
            } else if (op.op === "reply") {
              const target = pick(op.target);
              if (!target) continue;
              const r = store.sendMessage({
                project_id: store.message(target)!.project_id,
                author: { kind: "agent", host: null, session: op.session, name: null },
                body: "reply",
                reply_to: target,
                thread: op.thread,
              });
              ids.push(r.message.id);
            } else if (op.op === "resolve") {
              const target = pick(op.target);
              if (target) store.resolveThread(target, op.resolved);
            } else if (op.op === "seen") {
              const target = pick(op.target);
              if (target) store.markSeen(store.message(target)!.thread_id);
            } else {
              const target = pick(op.target);
              if (target) store.sendReply(target, { words: "ok", idempotency_key: op.key });
            }
          } catch (error) {
            if (!(error instanceof InboxError)) throw error;
          }
        }

        // The oracle: walk the lines in seq order with only what the log says
        // at that point, and apply the routing rules from scratch.
        const lines = allLines(dir).sort((a, b) => a.seq - b.seq);
        const threadOf = new Map<string, string>();
        const resolved = new Map<string, boolean>();
        const bySession = new Map<string, string>();
        // Every root of a name, oldest first: a name joins its newest OPEN one.
        const byName = new Map<string, string[]>();
        const nameKey = inboxThreadNameKey;
        for (const line of lines) {
          if (line.kind !== "message") continue;
          const m = line.record;
          if (threadOf.has(m.id)) {
            if (m.id === m.thread_id) resolved.set(m.id, m.resolved_at !== null);
            continue;
          }
          let expected: string;
          if (m.reply_to) {
            expected = threadOf.get(m.reply_to)!;
          } else if (m.author.kind === "person") {
            throw new Error("a person's message always replies");
          } else {
            const name = m.thread_name ?? null;
            const candidate =
              name !== null
                ? (byName.get(`${m.project_id}\0${nameKey(name)}`) ?? []).filter((root) => !resolved.get(root)).at(-1)
                : m.author.session
                  ? bySession.get(`${m.project_id}\0${m.author.session}`)
                  : undefined;
            expected = candidate && !resolved.get(candidate) ? candidate : m.id;
          }
          expect(m.thread_id).toBe(expected);
          threadOf.set(m.id, m.thread_id);
          if (m.id === m.thread_id) {
            resolved.set(m.id, m.resolved_at !== null);
            if (m.thread_name != null) {
              const key = `${m.project_id}\0${nameKey(m.thread_name)}`;
              byName.set(key, [...(byName.get(key) ?? []), m.id]);
            }
            else if (m.author.kind === "agent" && m.author.session) bySession.set(`${m.project_id}\0${m.author.session}`, m.id);
          }
        }

        // And the store replayed from disk (a copy, so each has one writer)
        // routes every next send exactly as the live one does.
        const project = store.ensureProject({ name: "repo0", root: "/work/repo0" });
        const copy = dataDir();
        cpSync(dir, copy, { recursive: true });
        const replayed = InboxStore.open(copy);
        expect(view(replayed)).toEqual(view(store));
        // Threads the probes start get fresh ids on each side: pair them up.
        const started = new Map<string, string>();
        for (const session of ["ses_a", "ses_b", null]) {
          for (const thread of [null, "alpha", "BETA"]) {
            const probe = { project_id: project.id, author: { kind: "agent" as const, host: null, session, name: null }, body: "probe", thread };
            const live = store.sendMessage(probe).message;
            const again = replayed.sendMessage(probe).message;
            if (live.thread_id === live.id) {
              expect(again.thread_id).toBe(again.id);
              started.set(live.id, again.id);
            } else {
              expect(again.thread_id).toBe(started.get(live.thread_id) ?? live.thread_id);
            }
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  test("question keys are core's: q- + hash of kind and prompt, -2 for a repeat", () => {
    fc.assert(
      fc.property(promptArb, fc.constantFrom("question", "question-multi", "question-text"), (prompt, directive) => {
        const kind = directive === "question" ? "single" : directive === "question-multi" ? "multi" : "text";
        const choices = kind === "text" ? [] : ["", "- [ ] One", "- [ ] Two"];
        const block = [`:::${directive}`, prompt, ...choices, ":::"].join("\n");
        const parsed = parseInboxQuestionBlocks(`${block}\n\n${block}\n`);
        const key = questionKey(kind, prompt);
        expect(parsed.map((q) => q.key)).toEqual([key, `${key}-2`]);
      }),
      { numRuns: 100 },
    );
    // Fixed prompts, pinned: a key change would orphan every stored answer.
    expect(questionKey("single", "Which way should the worker go on a Stripe 409?")).toMatch(/^q-[0-9a-f]{8}$/);
    expect(parseInboxQuestionBlocks(":::question\nWhich way should the worker go on a Stripe 409?\n\n- [ ] A\n- [ ] B\n:::")[0]!.key).toBe(
      questionKey("single", "Which way should the worker go on a Stripe 409?"),
    );
  });
});

// ─────────────────────────── the thread-state model ───────────────────────────
//
// adr/implementation/inbox-thread-state.md is the model this checks. The ops
// above run against the real store; `ThreadStateModel` is an independent
// account of the same events (which thread a message lands in, each
// question's state, the look, Mark read, the archive line, the agent's read)
// that predicts every op's outcome and every row's section. After every step
// the two must agree, and the invariants below must hold on the store's own
// output, in both list views. The model learns only what a message ASKS from
// the store (its question records: keys, `Stopped:`, `Holds up:`,
// `Decision:`); parsing is core's and is tested there.

/** Bodies an agent sends in the model runs and the trace fixtures. */
const STATE_BODIES = {
  news: "The nightly build is green.",
  ask: [":::question", "Ship it today?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n"),
  stop: [":::question", "Which layout should the list use?", "", "Stopped: the list cannot be built without this.", "", "- [ ] Cards", "- [ ] Table", ":::"].join("\n"),
  hold: [":::question", "Should overdue invoices sort first?", "", "Holds up: invoice list; export", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n"),
  decide: [":::question", "Which database should we use?", "", "Decision: when answered", "", "- [ ] Postgres", "- [ ] SQLite", ":::"].join("\n"),
  text: [":::question-text", "Anything the empty state should say?", ":::"].join("\n"),
  two: [
    "Two calls.",
    "",
    ":::question",
    "Keep the old route?",
    "",
    "- [ ] Yes",
    "- [ ] No",
    ":::",
    "",
    ":::question",
    "Which region first?",
    "",
    "Stopped: the deploy waits on this.",
    "",
    "- [ ] East",
    "- [ ] West",
    ":::",
  ].join("\n"),
} as const;

/** The question keys of STATE_BODIES (core's keys: q- + a hash of kind and prompt). */
const KEY = {
  ask: questionKey("single", "Ship it today?"),
  stop: questionKey("single", "Which layout should the list use?"),
  hold: questionKey("single", "Should overdue invoices sort first?"),
  decide: questionKey("single", "Which database should we use?"),
  keepRoute: questionKey("single", "Keep the old route?"),
  region: questionKey("single", "Which region first?"),
};

function stateOpArbOf(body: fc.Arbitrary<string>, agentKeys: boolean): fc.Arbitrary<Op> {
  return fc.oneof(
    {
      arbitrary: fc.record({
        op: fc.constant("send" as const),
        root: fc.nat(1),
        body,
        key: agentKeys ? fc.option(fc.constantFrom("a", "b"), { nil: null, freq: 4 }) : fc.constant(null),
        session: fc.constantFrom("ses_a", "ses_b", null),
      }),
      weight: 4,
    },
    { arbitrary: fc.record({ op: fc.constant("reply" as const), target: fc.nat(), body }), weight: 3 },
    {
      arbitrary: fc.record({
        op: fc.constant("supersede" as const),
        target: fc.nat(),
        whole: fc.boolean(),
        body: fc.constantFrom(STATE_BODIES.ask, STATE_BODIES.stop, STATE_BODIES.news),
      }),
      weight: 1,
    },
    { arbitrary: fc.record({ op: fc.constant("pick" as const), target: fc.nat(), choice: fc.nat(3), question: fc.nat(1) }), weight: 3 },
    {
      arbitrary: fc.record({
        op: fc.constant("personSend" as const),
        target: fc.nat(),
        key: fc.constantFrom("s1", "s2", "s3"),
        words: fc.constantFrom("", "ok"),
        skip: fc.boolean(),
      }),
      weight: 3,
    },
    { arbitrary: fc.record({ op: fc.constant("seen" as const), target: fc.nat() }), weight: 2 },
    // The look capped at a message (`through_seq`), in the property runs only: the
    // generated trace fixtures were drawn from this arbitrary without it, and a
    // phone kit replays them as written.
    ...(agentKeys ? [{ arbitrary: fc.record({ op: fc.constant("seen" as const), target: fc.nat(), through: fc.nat() }), weight: 2 }] : []),
    { arbitrary: fc.record({ op: fc.constant("read" as const), target: fc.nat(), read: fc.boolean() }), weight: 3 },
    { arbitrary: fc.record({ op: fc.constant("resolve" as const), target: fc.nat(), resolved: fc.boolean() }), weight: 3 },
    { arbitrary: fc.record({ op: fc.constant("agentRead" as const), target: fc.nat() }), weight: 2 },
    { arbitrary: fc.record({ op: fc.constant("tell" as const), target: fc.nat() }), weight: 2 },
  );
}

/** The property runs: the fixed bodies, and now and then any text an agent can send. */
const stateOpArb = stateOpArbOf(
  fc.oneof({ arbitrary: fc.constantFrom(...Object.values(STATE_BODIES)), weight: 6 }, { arbitrary: bodyArb, weight: 1 }),
  true,
);
/** The trace fixtures: the fixed bodies only, no agent idempotency keys, so a phone kit can replay them as written. */
const traceOpArb = stateOpArbOf(fc.constantFrom(...Object.values(STATE_BODIES)), false);

type QState = "open" | "picked" | "sent" | "closed" | "superseded";
type ModelAnswer = null | "pick" | "skip";

interface ModelQuestion {
  id: string;
  stopped: boolean;
  holds: boolean;
  decision: boolean;
  answer: ModelAnswer;
  sent: boolean;
  /** Closed by a Mark read (`by`: the step of that Mark read); what an Undo puts back. */
  setAside: { answer: ModelAnswer; sent: boolean; by: number } | null;
  superseded: boolean;
  decided: boolean;
}

interface ModelMessage {
  id: string;
  author: "agent" | "person";
  /** The Inbox's own person notes: Mark read's set-aside note and its Undo's reopened note. */
  note: "set_aside" | "reopened" | null;
  /** The step that wrote it: the model's order of events. */
  tick: number;
  questions: ModelQuestion[];
  /** The person's Send keys on this message (a replayed key writes nothing). */
  replyKeys: Set<string>;
}

interface ModelThread {
  id: string;
  messages: ModelMessage[];
  /** The latest agent message the person looked at (0: none). */
  seen: number;
  /** The step of the latest Mark read (whether or not it still stands), or null after its Undo. */
  read: number | null;
  /** The look before that Mark read, which its Undo puts back. */
  seenBeforeRead: number | undefined;
  resolved: boolean;
  /** The archive line: the step that archived it (resolved only). */
  archive: number;
  /** The latest person message an agent has read. */
  checked: number;
  /** Questions a set-aside note named and no reopened note took back. */
  told: Set<string>;
}

const SHW: readonly InboxSectionId[] = ["stopped", "holding", "waiting"];
const SHWN: readonly InboxSectionId[] = ["stopped", "holding", "waiting", "new"];

class ThreadStateModel {
  readonly threads = new Map<string, ModelThread>();
  private readonly byMessage = new Map<string, { thread: ModelThread; message: ModelMessage }>();
  /** An agent's idempotency key per project, and the body it was first sent with. */
  private readonly keyed = new Map<string, string>();
  /** The newest unnamed thread each agent session started, per project. */
  private readonly sessionRoots = new Map<string, string>();
  private created: readonly string[] = [];
  private used = 0;

  // ── what the model derives ──

  closedByArchive(t: ModelThread, m: ModelMessage): boolean {
    return t.resolved && m.tick < t.archive;
  }

  /** A question's state ignoring the archive (Mark read and Send read questions this way). */
  private recordState(q: ModelQuestion): QState {
    if (q.superseded) return "superseded";
    if (q.setAside) return "closed";
    if (q.answer === null) return "open";
    return q.sent ? "sent" : "picked";
  }

  state(t: ModelThread, m: ModelMessage, q: ModelQuestion): QState {
    if (!q.superseded && this.closedByArchive(t, m)) return "closed";
    return this.recordState(q);
  }

  private counts(t: ModelThread) {
    let open = 0;
    let picked = 0;
    let stopped = false;
    let holds = false;
    for (const m of t.messages) {
      for (const q of m.questions) {
        const s = this.state(t, m, q);
        if (s === "picked") picked += 1;
        if (s !== "open") continue;
        open += 1;
        stopped ||= q.stopped;
        holds ||= q.holds;
      }
    }
    return { open, picked, stopped, holds };
  }

  /**
   * Where "new since you looked" starts: the last look, or the person's
   * latest real reply. The Inbox's own notes are not a look.
   */
  private lookTick(t: ModelThread): number {
    let look = t.seen;
    for (const m of t.messages) if (m.author === "person" && m.note === null) look = Math.max(look, m.tick);
    return look;
  }

  unseen(t: ModelThread): number {
    const look = this.lookTick(t);
    return t.messages.filter((m) => m.author === "agent" && m.tick > look).length;
  }

  /**
   * The summary's `waiting_on_person`: open (not archived), the last word
   * (the Inbox's notes read past) is an agent's, and no Mark read stands.
   */
  waitingOnPerson(t: ModelThread): boolean {
    const last = [...t.messages].reverse().find((m) => m.note === null)!;
    return !t.resolved && last.author === "agent" && !this.readHolds(t);
  }

  agentAfter(t: ModelThread): boolean {
    return t.resolved && t.messages.some((m) => m.author === "agent" && m.tick > t.archive);
  }

  /** The person's latest real reply (not an Inbox note) came after the archive line and no agent has read it. */
  replyUnreadAfterArchive(t: ModelThread): boolean {
    const real = [...t.messages].reverse().find((m) => !(m.author === "person" && m.note !== null));
    return real !== undefined && real.author === "person" && real.tick > t.archive && t.checked < real.tick;
  }

  /** Mark read still stands: no message after it but its own set-aside notes, and (archived) made after the archive line. */
  readHolds(t: ModelThread): boolean {
    if (t.read === null) return false;
    if (t.resolved && t.read < t.archive) return false;
    return t.messages.every((m) => m.tick < t.read! || (m.author === "person" && m.note === "set_aside"));
  }

  back(t: ModelThread): boolean {
    if (!this.agentAfter(t)) return false;
    const look = this.lookTick(t);
    const c = this.counts(t);
    return (
      t.messages.some((m) => m.author === "agent" && m.tick > t.archive && m.tick > look) ||
      c.open > 0 ||
      c.picked > 0 ||
      // A Mark read made after it (still standing) sends the thread back to the archive.
      (this.replyUnreadAfterArchive(t) && !this.readHolds(t))
    );
  }

  archived(t: ModelThread): boolean {
    return t.resolved && !this.back(t);
  }

  /** The section, strongest reason first (the doc's table "Sections"). */
  section(t: ModelThread): InboxSectionId {
    if (this.archived(t)) return "quiet";
    if (this.readHolds(t)) return "quiet";
    const c = this.counts(t);
    if (c.open > 0) return c.stopped ? "stopped" : c.holds ? "holding" : "waiting";
    if (c.picked > 0) return "new";
    // The person's reply is the last message, the Inbox's notes read past.
    const last = [...t.messages].reverse().find((m) => m.note === null)!;
    if (last.author === "person" && t.checked < last.tick) return "sent";
    if (this.unseen(t) > 0) return "new";
    return "quiet";
  }

  decisionsWaiting(): number {
    let n = 0;
    for (const t of this.threads.values()) {
      for (const m of t.messages) {
        for (const q of m.questions) {
          const s = this.state(t, m, q);
          if (q.decision && !q.decided && (s === "open" || s === "picked")) n += 1;
        }
      }
    }
    return n;
  }

  threadOf(messageId: string): ModelThread | undefined {
    return this.byMessage.get(messageId)?.thread;
  }

  // ── the events ──

  private take(): string {
    const id = this.created[this.used];
    if (id === undefined) throw new Error("the model expected the store to write a message it did not write");
    this.used += 1;
    return id;
  }

  private addAgent(thread: ModelThread, tick: number, store: InboxStore): void {
    const id = this.take();
    const message: ModelMessage = {
      id,
      author: "agent",
      note: null,
      tick,
      replyKeys: new Set(),
      questions: store.questionsOf(id).map((q) => ({
        id: `${id}/${q.key}`,
        stopped: q.stopped !== null,
        holds: q.holds_up.length > 0,
        decision: q.decision_recording,
        answer: null,
        sent: false,
        setAside: null,
        superseded: false,
        decided: false,
      })),
    };
    thread.messages.push(message);
    this.byMessage.set(id, { thread, message });
    this.agentMessages.push(message);
  }

  /** Every agent message in the order written: what an op's index (`target`, `through`) names. */
  private readonly agentMessages: ModelMessage[] = [];

  /** The step that wrote the agent message an index names (wrapping, as `targetOf` does). */
  private tickOfAgent(index: number): number {
    return this.agentMessages[index % Math.max(1, this.agentMessages.length)]?.tick ?? 0;
  }

  private addPerson(thread: ModelThread, tick: number, note: ModelMessage["note"]): void {
    const id = this.take();
    const message: ModelMessage = { id, author: "person", note, tick, replyKeys: new Set(), questions: [] };
    thread.messages.push(message);
    this.byMessage.set(id, { thread, message });
  }

  /**
   * Apply one op as the model understands it and return the outcome it
   * predicts. `created` names the messages the store wrote for it, in order:
   * the model cannot predict ULIDs, so it takes them as it needs them, and the
   * caller checks that it took exactly those.
   */
  apply(op: Op, target: string | undefined, created: readonly string[], store: InboxStore, tick: number): Outcome {
    this.created = created;
    this.used = 0;
    const outcome = this.event(op, target, store, tick);
    expect(this.used).toBe(created.length);
    return outcome;
  }

  private event(op: Op, target: string | undefined, store: InboxStore, tick: number): Outcome {
    if (op.op === "send") {
      const project = `repo${op.root}`;
      const key = op.key?.trim() || null;
      if (key !== null) {
        const body = this.keyed.get(`${project}\0${key}`);
        if (body !== undefined) return body === op.body ? "replayed" : "refused:idempotency_key_reused";
      }
      const session = op.session === undefined ? "ses_x" : op.session;
      const route = session ? `${project}\0${session}` : null;
      const joined = route ? this.sessionRoots.get(route) : undefined;
      let thread = joined ? this.threads.get(joined) : undefined;
      if (!thread || thread.resolved) {
        // Resolved means done: the next message starts a new thread.
        const id = this.created[this.used]!;
        thread = { id, messages: [], seen: 0, read: null, seenBeforeRead: undefined, resolved: false, archive: 0, checked: 0, told: new Set() };
        this.threads.set(id, thread);
        if (route) this.sessionRoots.set(route, id);
      }
      this.addAgent(thread, tick, store);
      if (key !== null) this.keyed.set(`${project}\0${key}`, op.body);
      return "ok";
    }
    if (!target) return "noop";
    const { thread, message } = this.byMessage.get(target)!;
    switch (op.op) {
      case "reply":
        this.addAgent(thread, tick, store);
        return "ok";
      case "supersede": {
        if (message.author !== "agent") return "refused:invalid_supersedes";
        const first = message.questions[0];
        const named = op.whole || !first ? message.questions : [first];
        const open = named.filter((q) => {
          const s = this.state(thread, message, q);
          return s === "open" || s === "picked";
        });
        if (open.length === 0) return "refused:invalid_supersedes";
        this.addAgent(thread, tick, store);
        for (const q of open) q.superseded = true;
        return "ok";
      }
      case "pick": {
        if (message.questions.length === 0) return "noop";
        const q = message.questions[(op.question ?? 0) % message.questions.length]!;
        if (this.closedByArchive(thread, message)) return "refused:thread_resolved";
        if (q.superseded) return "refused:question_superseded";
        if (q.setAside) return "refused:question_set_aside";
        q.answer = "pick";
        q.sent = false;
        return "ok";
      }
      case "personSend": {
        if (message.replyKeys.has(op.key)) return "replayed";
        if (this.closedByArchive(thread, message)) return "refused:thread_resolved";
        const picks = message.questions.filter((q) => this.recordState(q) === "picked");
        const skips = op.skip ? message.questions.filter((q) => this.recordState(q) === "open") : [];
        if (picks.length === 0 && skips.length === 0 && op.words.trim() === "") {
          return op.skip ? "refused:nothing_to_send" : "refused:validation_error";
        }
        for (const q of picks) {
          q.sent = true;
          // The Send route records a decision for a sent pick whose question records one.
          if (q.decision) q.decided = true;
        }
        for (const q of skips) {
          q.answer = "skip";
          q.sent = true;
        }
        message.replyKeys.add(op.key);
        this.addPerson(thread, tick, null);
        return "ok";
      }
      case "resolve":
        if (thread.resolved === op.resolved) return "ok";
        if (op.resolved) {
          thread.resolved = true;
          thread.archive = tick;
        } else {
          // Unarchive drops a Mark read made while archived.
          if (thread.read !== null && thread.read > thread.archive) {
            thread.read = null;
            thread.seenBeforeRead = undefined;
          }
          thread.resolved = false;
          thread.archive = 0;
        }
        return "ok";
      case "seen": {
        // A look covers every agent message so far, or, capped (`through_seq`),
        // those written at or before the message it names (any thread's: a seq
        // is one counter across the Inbox). It never goes back.
        const cap = op.through === undefined ? Number.POSITIVE_INFINITY : this.tickOfAgent(op.through);
        let latestAgent = 0;
        for (const m of thread.messages) if (m.author === "agent" && m.tick <= cap) latestAgent = Math.max(latestAgent, m.tick);
        if (latestAgent > this.lookTick(thread)) thread.seen = latestAgent;
        return "ok";
      }
      case "read": {
        if (thread.resolved && !this.agentAfter(thread)) return "refused:thread_resolved";
        const live = thread.messages.filter((m) => m.author === "agent" && !this.closedByArchive(thread, m));
        if (op.read) {
          const waiting = live.flatMap((m) => m.questions).filter((q) => {
            const s = this.recordState(q);
            return s === "open" || s === "picked";
          });
          if (!this.readHolds(thread) || waiting.length > 0) {
            let latestAgent = 0;
            for (const m of thread.messages) if (m.author === "agent") latestAgent = Math.max(latestAgent, m.tick);
            thread.seenBeforeRead = thread.seen;
            thread.read = tick;
            thread.seen = Math.max(thread.seen, latestAgent);
            for (const q of waiting) {
              q.setAside = { answer: q.answer, sent: q.sent, by: tick };
              q.answer = "skip";
            }
          }
          return "ok";
        }
        // The ruling: Undo reopens only what its own Mark read closed; a
        // question an earlier Mark read set aside stays closed. With no Mark
        // read on the thread there is nothing to undo.
        const ownRead = thread.read;
        const own = (q: ModelQuestion) => q.setAside !== null && q.setAside.by === ownRead;
        const closed = live.flatMap((m) => m.questions).filter(own);
        if (ownRead === null && closed.length === 0) return "ok";
        if (ownRead !== null) {
          if (this.readHolds(thread) && thread.seenBeforeRead !== undefined) thread.seen = thread.seenBeforeRead;
          thread.read = null;
          thread.seenBeforeRead = undefined;
        }
        const reopened = new Map<ModelMessage, ModelQuestion[]>();
        for (const m of live) {
          for (const q of m.questions) {
            if (!own(q)) continue;
            if (thread.told.has(q.id) && !q.superseded) reopened.set(m, [...(reopened.get(m) ?? []), q]);
            q.answer = q.setAside.answer;
            q.sent = q.setAside.sent;
            q.setAside = null;
          }
        }
        for (const m of thread.messages) {
          const qs = reopened.get(m);
          if (!qs) continue;
          this.addPerson(thread, tick, "reopened");
          for (const q of qs) thread.told.delete(q.id);
        }
        return "ok";
      }
      case "agentRead": {
        let latestPerson = 0;
        for (const m of thread.messages) if (m.author === "person") latestPerson = Math.max(latestPerson, m.tick);
        if (latestPerson > thread.checked) thread.checked = latestPerson;
        return "ok";
      }
      case "tell":
        for (const m of thread.messages) {
          if (m.author !== "agent" || this.closedByArchive(thread, m)) continue;
          const qs = m.questions.filter((q) => q.setAside && !q.superseded && !thread.told.has(q.id));
          if (qs.length === 0) continue;
          this.addPerson(thread, tick, "set_aside");
          for (const q of qs) thread.told.add(q.id);
        }
        return "ok";
    }
  }
}

/** The two list views and the archived block, built as the server builds them (packages/server/inbox.ts: listModel, archivedModel). */
function listViews(rows: readonly InboxListRow[]) {
  return {
    include: inboxListSections(rows),
    exclude: inboxListSections(rows.filter((row) => !inboxRowArchived(row))),
    archived: inboxArchivedRows(rows),
  };
}

const placedIds = (sections: readonly InboxListSection[]) => sections.flatMap((s) => s.threads.map((r) => r.thread_id));

/** Every thread as the window reads it, for the replay comparison. */
function windowView(store: InboxStore) {
  return store.listRows().map((row) => ({ row, thread: store.windowThread(row.thread_id) }));
}

const STATE_START = Date.parse("2026-10-12T10:00:00.000Z");
const STATE_STEP_MS = 1000;
const isoAt = (tick: number) => new Date(STATE_START + tick * STATE_STEP_MS).toISOString();

interface StateWorld {
  dir: string;
  store: InboxStore;
  model: ThreadStateModel;
  ids: string[];
  clock: { now: number };
  tick: number;
  /** The clock time of each step (steps may share one: the sort's tie-break). */
  timeOf: Map<number, number>;
  /** The last successful Mark read, for the Mark read then Undo check. */
  lastRead: { threadId: string; before: ReturnType<typeof readSnapshot> } | null;
  /** Rows the tie-break ordered: equal `last_at` in a section, equal `resolved_at` in the archived list. */
  ties: { sections: number; archived: number };
}

function stateWorld(): StateWorld {
  const dir = dataDir();
  const clock = { now: STATE_START };
  return {
    dir,
    store: InboxStore.open(dir, { now: () => new Date(clock.now) }),
    model: new ThreadStateModel(),
    ids: [],
    clock,
    tick: 0,
    timeOf: new Map(),
    lastRead: null,
    ties: { sections: 0, archived: 0 },
  };
}

/** A thread's questions and row as a Mark read then Undo must give them back (revisions move by two; nothing else may). */
function readSnapshot(world: StateWorld, threadId: string) {
  const row = world.store.listRow(threadId)!;
  return {
    section: row.section,
    unseen: row.unseen,
    read_at: row.read_at ?? null,
    questions: world.store.thread(threadId)!.messages.map((m) => (m.questions ?? []).map((q) => ({ ...q, revision: 0 }))),
  };
}

/**
 * The invariants of the doc's "Invariants", on the store's own output, plus
 * agreement with the model on every field; any disagreement fails.
 */
function checkThreadState(world: StateWorld): void {
  const { store, model } = world;
  const rows = store.listRows();
  const views = listViews(rows);
  const all = [...model.threads.keys()].sort();
  expect(rows.map((r) => r.thread_id).sort()).toEqual(all);
  const order = INBOX_SECTIONS.map((s) => s.id);
  for (const sections of [views.include, views.exclude]) {
    // Sections in the fixed order; each thread in exactly one; newest first, ties on the thread id.
    expect(sections.map((s) => s.id)).toEqual(order);
    const ids = placedIds(sections);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of sections) {
      for (const row of section.threads) expect(row.section).toBe(section.id);
      for (let i = 1; i < section.threads.length; i++) {
        const a = section.threads[i - 1]!;
        const b = section.threads[i]!;
        if (a.last_at === b.last_at) world.ties.sections += 1;
        expect(a.last_at > b.last_at || (a.last_at === b.last_at && a.thread_id < b.thread_id)).toBe(true);
      }
    }
  }
  // No thread disappears: every thread is in the default list, and in the window's list or the archived block (never both).
  expect(placedIds(views.include).sort()).toEqual(all);
  const archivedIds = views.archived.map((r) => r.thread_id);
  expect([...placedIds(views.exclude), ...archivedIds].sort()).toEqual(all);
  for (let i = 1; i < views.archived.length; i++) {
    const a = views.archived[i - 1]!;
    const b = views.archived[i]!;
    if (a.resolved_at === b.resolved_at) world.ties.archived += 1;
    expect(a.resolved_at! > b.resolved_at! || (a.resolved_at === b.resolved_at && a.thread_id < b.thread_id)).toBe(true);
  }
  for (const row of rows) {
    const t = model.threads.get(row.thread_id)!;
    // The store matches the model exactly, on every field...
    const lastAgent = [...t.messages].reverse().find((m) => m.author === "agent");
    expect({
      section: row.section,
      archived: inboxRowArchived(row),
      read: (row.read_at ?? null) !== null,
      back: row.back_from_archive === true,
      after: row.agent_after_archive === true,
      unseen: row.unseen,
      last_at: row.last_at,
      last_agent_at: row.last_agent_at ?? null,
      waiting_on_person: row.waiting_on_person,
      messages: row.message_count,
    }).toEqual({
      section: model.section(t),
      archived: model.archived(t),
      read: model.readHolds(t),
      back: model.back(t),
      after: model.agentAfter(t),
      unseen: model.unseen(t),
      last_at: new Date(world.timeOf.get(t.messages.at(-1)!.tick)!).toISOString(),
      last_agent_at: lastAgent ? new Date(world.timeOf.get(lastAgent.tick)!).toISOString() : null,
      waiting_on_person: model.waitingOnPerson(t),
      messages: t.messages.length,
    });
    // ...on where each message landed and on every question's state.
    for (const m of t.messages) {
      expect(store.message(m.id)?.thread_id).toBe(t.id);
      expect(store.questionsOf(m.id).map((q) => q.state)).toEqual(m.questions.map((q) => model.state(t, m, q)));
    }
    // A question still waiting on the person keeps its thread in Stopped, Holding or Waiting.
    if (t.messages.some((m) => store.questionsOf(m.id).some((q) => q.state === "open"))) expect(SHW).toContain(row.section);
    // An archived thread never counts.
    if (inboxRowArchived(row)) expect(row.unread).toBe(false);
  }
  // Counts. The first two follow from the sections by construction (the
  // sidebar counts the rows in Stopped, Holding and Waiting; `unread` is
  // defined from the section), so they guard the counting code more than the
  // rules. The Decisions count is checked against the model's own account.
  const inSections = (sections: readonly InboxListSection[], ids: readonly InboxSectionId[]) =>
    sections.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.threads.length, 0);
  const waiting = rows.filter((r) => SHW.includes(r.section)).length;
  expect(waitingCount(views.include)).toBe(waiting);
  expect(waitingCount(views.exclude)).toBe(waiting);
  expect(inSections(views.exclude, SHW)).toBe(waiting);
  for (const project of store.listProjects()) {
    expect(waitingCount(views.exclude, project.id)).toBe(rows.filter((r) => r.project.id === project.id && SHW.includes(r.section)).length);
  }
  const unread = rows.filter((r) => r.unread).length;
  expect(inSections(views.include, SHWN)).toBe(unread);
  expect(inSections(views.exclude, SHWN)).toBe(unread);
  expect(waitingDecisionCount(store)).toBe(model.decisionsWaiting());
  // Replay determinism: the store read again from disk gives the same rows and threads.
  expect(windowView(InboxStore.open(world.dir))).toEqual(windowView(store));
}

interface StepResult {
  outcome: Outcome;
  target: string | undefined;
  created: string[];
}

/**
 * Run one op on the store and the model, then check the step's own rules and
 * every invariant. `sameTick`: the step shares the previous step's clock
 * time, so `last_at` and `resolved_at` can tie.
 */
function stateStep(world: StateWorld, op: Op, sameTick = false): StepResult {
  const tick = ++world.tick;
  if (!sameTick || tick === 1) world.clock.now += STATE_STEP_MS;
  world.timeOf.set(tick, world.clock.now);
  const target = targetOf(op, world.ids);
  const thread = target ? world.model.threadOf(target) : undefined;
  const wasResolved = thread?.resolved ?? false;
  const readAfterArchive = thread !== undefined && thread.resolved && thread.read !== null && thread.read > thread.archive;
  const readBefore = thread ? readSnapshot(world, thread.id) : null;

  const created: string[] = [];
  const stop = world.store.subscribe((line) => {
    if (line.kind === "message" && world.store.messageCursor(line.id) === line.seq) created.push(line.id);
  });
  let outcome: Outcome;
  try {
    outcome = run(world.store, op, world.ids);
  } finally {
    stop();
  }
  expect(outcome).toBe(world.model.apply(op, target, created, world.store, tick));
  checkThreadState(world);

  const lastRead = world.lastRead;
  world.lastRead = null;
  if (outcome !== "ok" || !thread) return { outcome, target, created };
  const row = world.store.listRow(thread.id)!;
  const inList = () => placedIds(listViews(world.store.listRows()).exclude).includes(thread.id);
  if ((op.op === "reply" || op.op === "supersede") && wasResolved) {
    // An agent message after the archive line brings the thread back into the list while something waits.
    expect(row.back_from_archive).toBe(true);
    expect(inList()).toBe(true);
  }
  if (op.op === "read" && op.read && wasResolved && thread.messages.some((m) => m.author === "agent" && m.tick > thread.archive)) {
    // Mark read on a came-back thread returns it to Archived, even while the
    // person's own reply there waits on the agent (once violation B).
    expect(inboxRowArchived(row)).toBe(true);
    expect(inList()).toBe(false);
  }
  if (op.op === "read" && op.read && readBefore && readBefore.read_at === null) {
    // Kept for the Mark read then Undo check. Questions an earlier Mark read
    // set aside stay closed through both (once violation C), so they need no exception.
    world.lastRead = { threadId: thread.id, before: readBefore };
  }
  if (op.op === "read" && !op.read) {
    // Undo clears the read fields; a question stays set aside exactly when the
    // model says an earlier Mark read closed it (Undo reopens only its own).
    const root = world.store.message(thread.id)!;
    expect(root.person_read_seq ?? null).toBeNull();
    expect(root.person_read_at ?? null).toBeNull();
    expect(row.read_at ?? null).toBeNull();
    for (const m of thread.messages) {
      if (m.author !== "agent" || world.model.closedByArchive(thread, m)) continue;
      expect(world.store.questionsOf(m.id).map((q) => q.set_aside_at !== null)).toEqual(m.questions.map((q) => q.setAside !== null));
    }
    // Mark read then Undo, back to back, gives the thread back exactly as it was.
    if (lastRead?.threadId === thread.id) expect(readSnapshot(world, thread.id)).toEqual(lastRead.before);
  }
  if (op.op === "resolve" && !op.resolved && readAfterArchive) {
    // Unarchive clears a read made while archived, in the same root line.
    expect(world.store.message(thread.id)!.person_read_seq ?? null).toBeNull();
  }
  return { outcome, target, created };
}

/** The index in `ids` of a thread's first message, so an op can aim at the thread. */
const rootIndex = (world: StateWorld, threadId: string) => world.ids.indexOf(threadId);

describe("the thread-state model", () => {
  // Deterministic: the seeds are fixed, so a failure names a seed and a path to rerun.
  test("generated sequences: the store agrees with the model, and every invariant holds after every step", () => {
    const ties = { sections: 0, archived: 0 };
    fc.assert(
      // About one step in four shares the previous step's clock time, so `last_at` and `resolved_at` tie.
      fc.property(fc.array(fc.tuple(stateOpArb, fc.nat(3)), { minLength: 15, maxLength: 45, size: "max" }), (steps) => {
        const world = stateWorld();
        for (const [op, roll] of steps) stateStep(world, op, roll === 0);
        ties.sections += world.ties.sections;
        ties.archived += world.ties.archived;
      }),
      { numRuns: 300, seed: 20261012 },
    );
    // The sections' tie-break on the thread id was exercised, not only defined.
    expect(ties.sections).toBeGreaterThan(0);
  });

  test("the archived list breaks ties on the thread id: every open thread archived in one clock tick", () => {
    let ties = 0;
    fc.assert(
      fc.property(fc.array(stateOpArb, { minLength: 10, maxLength: 30, size: "max" }), (ops) => {
        const world = stateWorld();
        for (const op of ops) stateStep(world, op);
        let first = true;
        for (const threadId of [...world.model.threads.keys()]) {
          if (world.store.message(threadId)!.resolved_at !== null) continue;
          stateStep(world, { op: "resolve", target: rootIndex(world, threadId), resolved: true }, !first);
          first = false;
        }
        ties += world.ties.archived;
      }),
      { numRuns: 60, seed: 20261015 },
    );
    expect(ties).toBeGreaterThan(0);
  });

  test("Mark read then Undo, on every thread after a generated history, gives the thread back exactly as it was", () => {
    fc.assert(
      fc.property(fc.array(stateOpArb, { minLength: 10, maxLength: 30, size: "max" }), (ops) => {
        const world = stateWorld();
        for (const op of ops) stateStep(world, op);
        for (const threadId of [...world.model.threads.keys()]) {
          const target = rootIndex(world, threadId);
          const read = stateStep(world, { op: "read", target, read: true });
          if (read.outcome === "ok") stateStep(world, { op: "read", target, read: false });
        }
      }),
      { numRuns: 100, seed: 20261013 },
    );
  });

  test("Archive then Unarchive loses no message, question, pick or decision", () => {
    fc.assert(
      fc.property(fc.array(stateOpArb, { minLength: 10, maxLength: 30, size: "max" }), (ops) => {
        const world = stateWorld();
        for (const op of ops) stateStep(world, op);
        for (const threadId of [...world.model.threads.keys()]) {
          if (world.store.message(threadId)!.resolved_at !== null) continue;
          const before = { thread: world.store.windowThread(threadId), row: world.store.listRow(threadId), decisions: [...world.store.allDecisions()] };
          const target = rootIndex(world, threadId);
          stateStep(world, { op: "resolve", target, resolved: true });
          stateStep(world, { op: "resolve", target, resolved: false });
          expect({ thread: world.store.windowThread(threadId), row: world.store.listRow(threadId), decisions: [...world.store.allDecisions()] }).toEqual(before);
        }
      }),
      { numRuns: 100, seed: 20261014 },
    );
  });

  test("every hand-written edge runs clean through the model", () => {
    for (const trace of HAND_TRACES) runTrace(trace.events);
  });
});

// ─────────────────────────── trace fixtures ───────────────────────────
//
// fixtures/thread-state/v1/ holds JSON traces a phone kit replays in a unit
// test: the events, and after each step the sections in both list views, the
// archived block, the counts and each thread's row and questions. They are
// generated here (the hand-written edges below, and generated sequences from
// fixed seeds) through the same checked steps, and this test fails when the
// files differ from what the store does now. Regenerate with
// `PLANNOTATOR_INBOX_TRACES=write bun test packages/shared/inbox/store.test.ts`.

type TraceEvent =
  | { type: "agent_message"; project: string; session?: string | null; reply_to: string | null; supersedes?: string[]; body: string }
  // `through` (seen only, optional): the look stops at that agent message (`through_seq`).
  | { type: "seen" | "mark_read" | "unread" | "archive" | "unarchive" | "agent_read" | "set_aside_note"; thread: string; through?: string }
  | { type: "pick"; message: string; key: string; choice?: string; text?: string }
  | { type: "send"; message: string; words: string; skip_unanswered: boolean };

interface TraceDef {
  name: string;
  description: string;
  events: TraceEvent[];
}

/** The labels a trace uses: m1, m2, … for messages in the order they were written; t1, t2, … for threads. */
class TraceLabels {
  private readonly toId = new Map<string, string>();
  private readonly toLabel = new Map<string, string>();
  private messages = 0;
  private threads = 0;

  name(id: string, store: InboxStore): string {
    const known = this.toLabel.get(id);
    if (known) return known;
    const label = `m${++this.messages}`;
    this.toLabel.set(id, label);
    this.toId.set(label, id);
    if (store.message(id)!.thread_id === id) {
      const thread = `t${++this.threads}`;
      this.toLabel.set(`thread:${id}`, thread);
      this.toId.set(thread, id);
    }
    return label;
  }

  label(id: string): string {
    return this.toLabel.get(id)!;
  }

  threadLabel(threadId: string): string {
    return this.toLabel.get(`thread:${threadId}`)!;
  }

  id(label: string): string {
    const id = this.toId.get(label);
    if (!id) throw new Error(`the trace names ${label} before it exists`);
    return id;
  }
}

/** The op a trace event is, aimed by index at the store's agent messages. */
function traceOp(event: TraceEvent, world: StateWorld, labels: TraceLabels, step: number): Op {
  const at = (label: string) => {
    const i = world.ids.indexOf(labels.id(label));
    if (i < 0) throw new Error(`${label} is not an agent message`);
    return i;
  };
  switch (event.type) {
    case "agent_message": {
      if (event.reply_to === null) {
        const root = /^repo(\d)$/.exec(event.project);
        if (!root) throw new Error(`project ${event.project}: repo0 or repo1`);
        return { op: "send", root: Number(root[1]), body: event.body, key: null, session: event.session ?? null };
      }
      if (!event.supersedes) return { op: "reply", target: at(event.reply_to), body: event.body };
      const ref = event.supersedes[0]!;
      const first = world.store.questionsOf(labels.id(event.reply_to))[0];
      if (event.supersedes.length !== 1 || (ref !== event.reply_to && ref !== `${event.reply_to}/${first?.key}`)) {
        throw new Error("supersedes: the message replied to, or its first question");
      }
      return { op: "supersede", target: at(event.reply_to), whole: ref === event.reply_to, body: event.body };
    }
    case "pick": {
      const questions = world.store.questionsOf(labels.id(event.message));
      const question = questions.findIndex((q) => q.key === event.key);
      const q = questions[question];
      if (!q) throw new Error(`${event.message} has no question ${event.key}`);
      const choice = q.kind === "text" ? 0 : q.choices.findIndex((c) => c.label === event.choice);
      if (choice < 0) throw new Error(`${event.key} has no choice ${event.choice}`);
      return { op: "pick", target: at(event.message), question, choice };
    }
    case "send":
      return { op: "personSend", target: at(event.message), key: `send-${step}`, words: event.words, skip: event.skip_unanswered };
    case "seen":
      return event.through === undefined ? { op: "seen", target: at(event.thread) } : { op: "seen", target: at(event.thread), through: at(event.through) };
    case "mark_read":
      return { op: "read", target: at(event.thread), read: true };
    case "unread":
      return { op: "read", target: at(event.thread), read: false };
    case "archive":
      return { op: "resolve", target: at(event.thread), resolved: true };
    case "unarchive":
      return { op: "resolve", target: at(event.thread), resolved: false };
    case "agent_read":
      return { op: "agentRead", target: at(event.thread) };
    case "set_aside_note":
      return { op: "tell", target: at(event.thread) };
  }
}

/** The trace event a generated op is, before it runs (null for an op that aims at nothing). */
function traceEventOf(op: Op, world: StateWorld, labels: TraceLabels): TraceEvent | null {
  if (op.op === "send") return { type: "agent_message", project: `repo${op.root}`, session: op.session ?? null, reply_to: null, body: op.body };
  const target = targetOf(op, world.ids);
  if (!target) return null;
  const message = world.store.message(target)!;
  const thread = labels.threadLabel(message.thread_id);
  const project = world.store.project(message.project_id)!.name;
  switch (op.op) {
    case "reply":
      return { type: "agent_message", project, reply_to: labels.label(target), body: op.body };
    case "supersede": {
      const first = world.store.questionsOf(target)[0];
      const ref = op.whole || !first ? labels.label(target) : `${labels.label(target)}/${first.key}`;
      return { type: "agent_message", project, reply_to: labels.label(target), supersedes: [ref], body: op.body };
    }
    case "pick": {
      const questions = world.store.questionsOf(target);
      const q = questions[(op.question ?? 0) % Math.max(1, questions.length)];
      if (!q) return null;
      return q.kind === "text"
        ? { type: "pick", message: labels.label(target), key: q.key, text: "free" }
        : { type: "pick", message: labels.label(target), key: q.key, choice: q.choices[op.choice % q.choices.length]!.label };
    }
    case "personSend":
      return { type: "send", message: labels.label(target), words: op.words, skip_unanswered: op.skip === true };
    case "seen":
      return op.through === undefined ? { type: "seen", thread } : { type: "seen", thread, through: labels.label(world.ids[op.through % world.ids.length]!) };
    case "read":
      return { type: op.read ? "mark_read" : "unread", thread };
    case "resolve":
      return { type: op.resolved ? "archive" : "unarchive", thread };
    case "agentRead":
      return { type: "agent_read", thread };
    case "tell":
      return { type: "set_aside_note", thread };
  }
}

/** What a phone kit checks after a step. */
function traceExpect(world: StateWorld, labels: TraceLabels) {
  const { store } = world;
  const rows = store.listRows();
  const views = listViews(rows);
  const sections = (list: readonly InboxListSection[]) => Object.fromEntries(list.map((s) => [s.id, s.threads.map((r) => labels.threadLabel(r.thread_id))]));
  const byLabel = [...rows].sort((a, b) => Number(labels.threadLabel(a.thread_id).slice(1)) - Number(labels.threadLabel(b.thread_id).slice(1)));
  return {
    sections: sections(views.include),
    sections_exclude_archived: sections(views.exclude),
    archived: views.archived.map((r) => labels.threadLabel(r.thread_id)),
    counts: { waiting: waitingCount(views.exclude), unread: rows.filter((r) => r.unread).length, decisions_waiting: waitingDecisionCount(store) },
    threads: Object.fromEntries(
      byLabel.map((row) => {
        const messages = store.thread(row.thread_id)!.messages;
        return [
          labels.threadLabel(row.thread_id),
          {
            section: row.section,
            unread: row.unread,
            unseen: row.unseen,
            read: (row.read_at ?? null) !== null,
            archived: inboxRowArchived(row),
            agent_after_archive: row.agent_after_archive === true,
            back_from_archive: row.back_from_archive === true,
            last: labels.label(messages.at(-1)!.id),
            questions: Object.fromEntries(messages.flatMap((m) => (m.questions ?? []).map((q) => [`${labels.label(m.id)}/${q.key}`, q.state]))),
          },
        ];
      }),
    ),
  };
}

/** Run a trace's events through checked steps on a fresh store; returns each step as the fixture records it. */
function runTrace(events: readonly TraceEvent[]) {
  const world = stateWorld();
  const labels = new TraceLabels();
  const steps = events.map((event, i) => {
    const op = traceOp(event, world, labels, i + 1);
    const result = stateStep(world, op);
    const names = result.created.map((id) => labels.name(id, world.store));
    const landsIn = event.type === "agent_message" && result.outcome === "ok" ? labels.threadLabel(world.store.message(result.created[0]!)!.thread_id) : undefined;
    return { event, outcome: result.outcome, created: names, ...(landsIn ? { lands_in: landsIn } : {}), expect: traceExpect(world, labels) };
  });
  return { steps };
}

/**
 * A generated sequence as trace events: a root first (so no trace is
 * empty), then each sampled op run once, and only those that wrote
 * something kept. Used only to make a missing file: once written, a
 * generated trace's events are data, replayed from the file.
 */
function generatedEvents(seed: number): TraceEvent[] {
  const [ops] = fc.sample(fc.array(traceOpArb, { minLength: 14, maxLength: 24 }), { seed, numRuns: 1 });
  const first: Op = { op: "send", root: 0, body: STATE_BODIES.ask, key: null, session: "ses_a" };
  const world = stateWorld();
  const labels = new TraceLabels();
  const kept: TraceEvent[] = [];
  for (const op of [first, ...ops!]) {
    const event = traceEventOf(op, world, labels);
    const { outcome, created } = stateStep(world, op);
    for (const id of created) labels.name(id, world.store);
    if (event && outcome === "ok") kept.push(event);
  }
  return kept;
}

const ROOT = (body: string, session: string | null = "ses_a", project = "repo0"): TraceEvent => ({ type: "agent_message", project, session, reply_to: null, body });
const REPLY = (reply_to: string, body: string, supersedes?: string[]): TraceEvent => ({
  type: "agent_message",
  project: "repo0",
  reply_to,
  ...(supersedes ? { supersedes } : {}),
  body,
});
const ON = (type: Extract<TraceEvent, { thread: string }>["type"], thread: string): TraceEvent => ({ type, thread });
const SEEN_THROUGH = (thread: string, through: string): TraceEvent => ({ type: "seen", thread, through });
const PICK = (message: string, key: string, choice: string): TraceEvent => ({ type: "pick", message, key, choice });
const SEND = (message: string, words: string, skip_unanswered: boolean): TraceEvent => ({ type: "send", message, words, skip_unanswered });

const HAND_TRACES: TraceDef[] = [
  {
    name: "hand-01-stopped-pick-send-agent-reads",
    description: "A stopped question is picked (New: answered, not sent), sent (Sent), read by the agent (Quiet); the agent's next message is New until looked at.",
    events: [ROOT(STATE_BODIES.stop), ON("seen", "t1"), PICK("m1", KEY.stop, "Cards"), SEND("m1", "", false), ON("agent_read", "t1"), REPLY("m1", STATE_BODIES.news), ON("seen", "t1")],
  },
  {
    name: "hand-02-sections-and-order",
    description: "Holding, Waiting, New and Stopped side by side, two projects; within Waiting the newest message sorts first and a new message moves its thread to the top.",
    events: [
      ROOT(STATE_BODIES.hold, "ses_a"),
      ROOT(STATE_BODIES.ask, "ses_b"),
      ROOT(STATE_BODIES.news, null, "repo1"),
      ROOT(STATE_BODIES.stop, null),
      ON("seen", "t3"),
      ROOT(STATE_BODIES.ask, null),
      REPLY("m2", STATE_BODIES.news),
    ],
  },
  {
    name: "hand-03-mark-read-and-undo",
    description: "Mark read closes both questions (a saved pick included) and Undo puts them back; after the set-aside note went, Undo writes one reopened note.",
    events: [ROOT(STATE_BODIES.two), PICK("m1", KEY.keepRoute, "Yes"), ON("mark_read", "t1"), ON("unread", "t1"), ON("mark_read", "t1"), ON("set_aside_note", "t1"), ON("unread", "t1")],
  },
  {
    name: "hand-04-mark-read-racing-agent-message",
    description: "Mark read, then the agent writes news inside the Undo window, then the set-aside note goes.",
    events: [ROOT(STATE_BODIES.ask), ON("mark_read", "t1"), REPLY("m1", STATE_BODIES.news), ON("set_aside_note", "t1")],
  },
  {
    name: "hand-05-mark-read-then-agent-asks",
    description: "News marked read leaves the top; the agent's next question brings it back as Waiting; the Send that skips sends it.",
    events: [ROOT(STATE_BODIES.news), ON("mark_read", "t1"), REPLY("m1", STATE_BODIES.ask), SEND("m2", "ok", true)],
  },
  {
    name: "hand-06-archive-then-agent-writes-again",
    description: "An archived thread comes back on the agent's reply (New, then Stopped when it asks), is answered without unarchiving, and returns to the archive once handled.",
    events: [
      ROOT(STATE_BODIES.ask),
      ON("archive", "t1"),
      REPLY("m1", STATE_BODIES.news),
      ON("seen", "t1"),
      REPLY("m1", STATE_BODIES.stop),
      SEND("m3", "", true),
      ON("agent_read", "t1"),
    ],
  },
  {
    name: "hand-07-archived-next-message-starts-new-thread",
    description: "Archive means done: the session's next message without reply_to starts a new thread; after Unarchive the session's default thread is the newest one.",
    events: [ROOT(STATE_BODIES.news, "ses_a"), ON("archive", "t1"), ROOT(STATE_BODIES.ask, "ses_a"), ON("unarchive", "t1"), ROOT(STATE_BODIES.news, "ses_a")],
  },
  {
    name: "hand-08-came-back-mark-read-and-unarchive",
    description: "Mark read on a came-back thread returns it to Archived and Undo brings it back; Unarchive drops a Mark read made while archived and reopens what the archive closed.",
    events: [
      ROOT(STATE_BODIES.ask),
      ON("seen", "t1"),
      ON("archive", "t1"),
      REPLY("m1", STATE_BODIES.stop),
      ON("mark_read", "t1"),
      ON("unread", "t1"),
      ON("mark_read", "t1"),
      ON("unarchive", "t1"),
    ],
  },
  {
    name: "hand-09-came-back-mark-read-with-unread-reply",
    description: "A came-back thread whose question the person answered with Keep open (their reply unread by the agent) is marked read.",
    events: [ROOT(STATE_BODIES.news), ON("archive", "t1"), REPLY("m1", STATE_BODIES.ask), SEND("m2", "thinking", false), ON("mark_read", "t1"), ON("agent_read", "t1")],
  },
  {
    name: "hand-10-supersede-chain",
    description: "A picked question is replaced by a stopped one (the pick is never sent), that by a holding one, that withdrawn with nothing in its place; superseding a closed question is refused.",
    events: [
      ROOT(STATE_BODIES.ask),
      PICK("m1", KEY.ask, "Yes"),
      REPLY("m1", STATE_BODIES.stop, [`m1/${KEY.ask}`]),
      REPLY("m2", STATE_BODIES.hold, [`m2/${KEY.stop}`]),
      REPLY("m3", STATE_BODIES.news, ["m3"]),
      ON("seen", "t1"),
      REPLY("m1", STATE_BODIES.ask, ["m1"]),
    ],
  },
  {
    name: "hand-11-send-that-skips-and-keep-open",
    description: "The Send that skips sends a pick and skips the rest (Sent); Keep open leaves both questions open (Stopped); an empty Send is refused.",
    events: [
      ROOT(STATE_BODIES.two, "ses_a"),
      ROOT(STATE_BODIES.two, "ses_b"),
      PICK("m1", KEY.keepRoute, "No"),
      SEND("m1", "", true),
      SEND("m2", "later", false),
      SEND("m2", "", false),
      SEND("m2", "", true),
    ],
  },
  {
    name: "hand-12-archive-unarchive-keeps-everything",
    description: "Archive closes the questions (no Mark read, no pick) and Unarchive gives back every pick and the decision waiting; the Send records the decision.",
    events: [
      ROOT(STATE_BODIES.decide),
      REPLY("m1", STATE_BODIES.ask),
      PICK("m1", KEY.decide, "Postgres"),
      PICK("m2", KEY.ask, "No"),
      ON("archive", "t1"),
      ON("mark_read", "t1"),
      PICK("m2", KEY.ask, "Yes"),
      ON("unarchive", "t1"),
      SEND("m1", "", false),
    ],
  },
  {
    name: "hand-13-mark-read-before-archive-is-kept",
    description: "A Mark read made before the archive survives Archive then Unarchive; the agent's next message ends it.",
    events: [ROOT(STATE_BODIES.news), ON("mark_read", "t1"), ON("archive", "t1"), ON("unarchive", "t1"), REPLY("m1", STATE_BODIES.news)],
  },
  {
    name: "hand-14-undo-after-an-earlier-mark-read",
    description: "Mark read, the agent writes news (New, the question stays closed), Mark read again, Undo.",
    events: [ROOT(STATE_BODIES.ask), ON("mark_read", "t1"), REPLY("m1", STATE_BODIES.news), ON("mark_read", "t1"), ON("unread", "t1")],
  },
  {
    name: "hand-15-archive-holds-the-set-aside-note",
    description: "Mark read, then archive: no set-aside note goes while archived; after Unarchive (the Mark read kept) it goes.",
    events: [ROOT(STATE_BODIES.ask), ON("mark_read", "t1"), ON("archive", "t1"), ON("set_aside_note", "t1"), ON("unarchive", "t1"), ON("set_aside_note", "t1")],
  },
  {
    name: "hand-16-undo-reopens-only-its-own-mark-read",
    description:
      "Two Mark reads, each told to the agent: Undo reopens only the second one's question (one reopened note, for it); the first one's stays closed; the notes are never the person's reply or a look.",
    events: [
      ROOT(STATE_BODIES.ask),
      ON("mark_read", "t1"),
      ON("set_aside_note", "t1"),
      REPLY("m1", STATE_BODIES.stop),
      ON("mark_read", "t1"),
      ON("set_aside_note", "t1"),
      ON("unread", "t1"),
      ON("unread", "t1"),
    ],
  },
  {
    name: "hand-17-came-back-mark-read-then-reply",
    description: "A came-back thread marked read goes back to Archived; the person's reply after that brings it back as Sent, and the agent's read returns it to the archive.",
    events: [ROOT(STATE_BODIES.news), ON("archive", "t1"), REPLY("m1", STATE_BODIES.ask), ON("mark_read", "t1"), SEND("m2", "one more thing", false), ON("agent_read", "t1")],
  },
  {
    name: "hand-18-look-capped-by-through",
    description:
      "The look capped at what the window showed (`seen` with `through`): a message that landed after the window read the thread stays New; a cap behind the recorded look changes nothing; a cap past the thread's newest message (here another thread's later message) covers all of it.",
    events: [
      ROOT(STATE_BODIES.news, "ses_a"),
      REPLY("m1", STATE_BODIES.news),
      SEEN_THROUGH("t1", "m1"),
      SEEN_THROUGH("t1", "m2"),
      REPLY("m1", STATE_BODIES.ask),
      SEEN_THROUGH("t1", "m1"),
      SEEN_THROUGH("t1", "m3"),
      REPLY("m1", STATE_BODIES.news),
      ROOT(STATE_BODIES.news, null, "repo1"),
      SEEN_THROUGH("t1", "m5"),
    ],
  },
];

/** The generated traces' seeds (fast-check's `fc.sample`, one sequence each). */
const TRACE_SEEDS = Array.from({ length: 24 }, (_, i) => 1001 + i);

const TRACE_DIR = join(import.meta.dir, "fixtures", "thread-state", "v1");

/** The events of a generated trace already on disk (its data), or null when the file is missing. */
function generatedEventsOnDisk(name: string): TraceEvent[] | null {
  const file = join(TRACE_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  return (JSON.parse(readFileSync(file, "utf8")) as { steps: { event: TraceEvent }[] }).steps.map((step) => step.event);
}

function buildTraceFiles(resample: boolean): Map<string, unknown> {
  const files = new Map<string, unknown>();
  const head = (name: string, description: string, source: "hand" | "generated", seed: number | null) => ({
    format: "plannotator-inbox-thread-state",
    version: 1,
    name,
    description,
    source,
    seed,
    clock: { start: isoAt(0), step_ms: STATE_STEP_MS },
  });
  // No rule of the model is broken any more (A, B and C were fixed), so every
  // trace's `known_violations` is empty; the field stays in the format.
  for (const trace of HAND_TRACES) {
    const { steps } = runTrace(trace.events);
    files.set(`${trace.name}.json`, { ...head(trace.name, trace.description, "hand", null), known_violations: [], steps });
  }
  for (const seed of TRACE_SEEDS) {
    const name = `gen-seed-${seed}`;
    const events = (!resample && generatedEventsOnDisk(name)) || generatedEvents(seed);
    const { steps } = runTrace(events);
    files.set(`${name}.json`, {
      ...head(name, "A generated sequence (store.test.ts, traceOpArb): a root, then the sampled events that wrote something.", "generated", seed),
      known_violations: [],
      steps,
    });
  }
  files.set("index.json", {
    format: "plannotator-inbox-thread-state",
    version: 1,
    traces: [...files.keys()].sort(),
  });
  return files;
}

describe("thread-state trace fixtures (fixtures/thread-state/v1)", () => {
  // PLANNOTATOR_INBOX_TRACES=write rewrites the files from the hand traces
  // and the generated traces' stored events; =resample also draws the
  // generated events again from their seeds (after a change to traceOpArb).
  test("the files are what the store does now", () => {
    const mode = process.env.PLANNOTATOR_INBOX_TRACES;
    const files = buildTraceFiles(mode === "resample");
    if (mode === "write" || mode === "resample") {
      mkdirSync(TRACE_DIR, { recursive: true });
      for (const name of readdirSync(TRACE_DIR)) if (name.endsWith(".json") && !files.has(name)) rmSync(join(TRACE_DIR, name));
      for (const [name, body] of files) writeFileSync(join(TRACE_DIR, name), `${JSON.stringify(body, null, 2)}\n`);
    }
    expect(existsSync(TRACE_DIR)).toBe(true);
    const onDisk = readdirSync(TRACE_DIR).filter((name) => name.endsWith(".json")).sort();
    expect(onDisk).toEqual([...files.keys()].sort());
    for (const [name, body] of files) expect(JSON.parse(readFileSync(join(TRACE_DIR, name), "utf8"))).toEqual(body);
  });
});

// ─────────────────────────── fixed violations ───────────────────────────
//
// Found by the model on main at 53a49c81e (A, B, C in the doc) and fixed
// since. Each is the minimal sequence, asserting what the doc's rule says;
// they were `test.failing` until the fix.

/** A store on a clock that moves one step per write, with one agent session. */
function knownStore() {
  const dir = dataDir();
  const clock = { now: STATE_START };
  const store = InboxStore.open(dir, { now: () => new Date((clock.now += STATE_STEP_MS)) });
  const project = store.ensureProject({ name: "repo0", root: "/work/repo0" });
  const agent = { kind: "agent" as const, host: "test", session: "ses_a", name: null };
  const say = (body: string, reply_to?: string) => store.sendMessage({ project_id: project.id, author: agent, body, ...(reply_to ? { reply_to } : {}) }).message;
  const pick = (messageId: string, label: string) => {
    const q = store.questionsOf(messageId)[0]!;
    store.savePicks(messageId, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] } }]);
  };
  return { store, say, pick };
}

describe("the thread-state model: fixed violations", () => {
  // A: one minimal case per shape the generated runs met while it stood
  // (the section the rule gives > the one the store gave, and how unseen
  // moved). Rule: the Inbox's own notes (Mark read's set-aside note, a late
  // Undo's reopened note) are neither the person's reply nor a look. They
  // were person-authored lines the store counted as both: a row read Sent
  // though the person wrote nothing, and agent messages the person never saw
  // stopped counting as unseen. The notes are still person-authored lines,
  // delivered to the agent as before.
  const A_CASES: { signature: string; sequence: string; run: (k: ReturnType<typeof knownStore>) => string; spec: { section: InboxSectionId; unseen: number } }[] = [
    {
      signature: "new>sent unseen-",
      sequence: "the agent asks; Mark read; the agent writes news inside the Undo window; the set-aside note goes",
      run: ({ store, say }) => {
        const m1 = say(STATE_BODIES.ask);
        store.markRead(m1.id, true);
        say(STATE_BODIES.news, m1.id);
        store.tellSetAside(m1.id, 0);
        return m1.id;
      },
      spec: { section: "new", unseen: 1 },
    },
    {
      signature: "asks>asks unseen-",
      sequence: "the agent asks; Mark read; the agent asks a new question; the set-aside note goes",
      run: ({ store, say }) => {
        const m1 = say(STATE_BODIES.ask);
        store.markRead(m1.id, true);
        say(STATE_BODIES.decide, m1.id);
        store.tellSetAside(m1.id, 0);
        return m1.id;
      },
      spec: { section: "waiting", unseen: 1 },
    },
    {
      signature: "asks>asks unseen-",
      sequence: "the agent asks, never opened; Mark read; the set-aside note goes; Undo (its reopened note)",
      run: ({ store, say }) => {
        const m1 = say(STATE_BODIES.ask);
        store.markRead(m1.id, true);
        store.tellSetAside(m1.id, 0);
        store.markRead(m1.id, false);
        return m1.id;
      },
      spec: { section: "waiting", unseen: 1 },
    },
    {
      signature: "new>quiet unseen-",
      sequence: "the agent asks; Mark read; the agent writes news; the set-aside note goes; an agent reads the thread",
      run: ({ store, say }) => {
        const m1 = say(STATE_BODIES.ask);
        store.markRead(m1.id, true);
        say(STATE_BODIES.news, m1.id);
        store.tellSetAside(m1.id, 0);
        store.markAgentChecked(m1.id);
        return m1.id;
      },
      spec: { section: "new", unseen: 1 },
    },
    {
      signature: "quiet>sent",
      sequence: "the agent asks; Mark read; the agent writes news; the person opens the thread; the set-aside note goes",
      run: ({ store, say }) => {
        const m1 = say(STATE_BODIES.ask);
        store.markRead(m1.id, true);
        say(STATE_BODIES.news, m1.id);
        store.markSeen(m1.id);
        store.tellSetAside(m1.id, 0);
        return m1.id;
      },
      spec: { section: "quiet", unseen: 0 },
    },
    {
      signature: "new>new unseen-",
      sequence: "the agent asks; Mark read; the agent asks again; the person picks; the set-aside note goes",
      run: ({ store, say, pick }) => {
        const m1 = say(STATE_BODIES.ask);
        store.markRead(m1.id, true);
        const m2 = say(STATE_BODIES.decide, m1.id);
        pick(m2.id, "Postgres");
        store.tellSetAside(m1.id, 0);
        return m1.id;
      },
      spec: { section: "new", unseen: 1 },
    },
    {
      signature: "quiet>quiet unseen-",
      sequence: "the agent asks; Mark read; the agent writes news; the set-aside note goes; archive",
      run: ({ store, say }) => {
        const m1 = say(STATE_BODIES.ask);
        store.markRead(m1.id, true);
        say(STATE_BODIES.news, m1.id);
        store.tellSetAside(m1.id, 0);
        store.resolveThread(m1.id, true);
        return m1.id;
      },
      spec: { section: "quiet", unseen: 1 },
    },
  ];

  for (const c of A_CASES) {
    test(`A (was ${c.signature}): ${c.sequence}`, () => {
      const k = knownStore();
      const threadId = c.run(k);
      const row = k.store.listRow(threadId)!;
      expect({ section: row.section, unseen: row.unseen }).toEqual(c.spec);
      // The note is still written as before: a person-authored reply to the asking message.
      const notes = k.store.thread(threadId)!.messages.filter((m) => (m.set_aside?.length ?? 0) > 0 || (m.reopened?.length ?? 0) > 0);
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) expect(note).toMatchObject({ author: { kind: "person" }, reply_to: expect.any(String) });
    });
  }

  test("A: after the note, opening the thread records the look the note no longer stands in for", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.ask);
    store.markRead(m1.id, true);
    say(STATE_BODIES.news, m1.id);
    store.tellSetAside(m1.id, 0);
    expect(store.listRow(m1.id)).toMatchObject({ section: "new", unseen: 1, sent: null });
    store.markSeen(m1.id);
    expect(store.listRow(m1.id)).toMatchObject({ section: "quiet", unseen: 0, sent: null });
    // Replayed from disk: the same.
    expect(InboxStore.open(store.dir.replace(/\/inbox$/, "")).listRow(m1.id)).toEqual(store.listRow(m1.id));
  });

  // B. Sequence: news (m1); archive; the agent asks (m2, came back,
  // Waiting); the person replies with Keep open (m3, the question still
  // open); Mark read. Rule: a Mark read made after the latest post-archive
  // agent message (and still standing) ends "came back", so the thread
  // returns to Archived at once, as the window's toast says ("went back to
  // Archived"). It used to stay in the list (Quiet, Read) until the agent
  // read m3, because the unread reply kept `back_from_archive`.
  test("B: Mark read on a came-back thread whose reply the agent has not read returns it to Archived", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.news);
    store.resolveThread(m1.id, true);
    const m2 = say(STATE_BODIES.ask, m1.id);
    store.sendReply(m2.id, { words: "thinking", idempotency_key: "k1" });
    store.markRead(m1.id, true);
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
    // The agent reading the reply changes nothing; Undo brings it back as it was (Waiting).
    store.markAgentChecked(m1.id);
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
    store.markRead(m1.id, false);
    expect(store.listRow(m1.id)).toMatchObject({ section: "waiting", back_from_archive: true });
  });

  test("B: a reply the person sends after that Mark read brings the thread back as Sent", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.news);
    store.resolveThread(m1.id, true);
    const m2 = say(STATE_BODIES.ask, m1.id);
    store.markRead(m1.id, true);
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
    store.sendReply(m2.id, { words: "one more thing", idempotency_key: "k2" });
    expect(store.listRow(m1.id)).toMatchObject({ section: "sent", back_from_archive: true, read_at: null });
  });

  // C (owner ruling: Undo reopens only what its own Mark read closed).
  // Sequence: the agent asks (m1); Mark read (its question closes); the
  // agent writes news (m2: New, the question stays closed); Mark read; Undo.
  // Undo used to reopen every question any Mark read had closed: the first
  // one's question reopened and the thread jumped to Waiting.
  test("C: Undo reopens only what its own Mark read closed", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.ask);
    store.markRead(m1.id, true);
    say(STATE_BODIES.news, m1.id);
    store.markRead(m1.id, true);
    store.markRead(m1.id, false);
    expect(store.listRow(m1.id)!.section).toBe("new");
    expect(store.questionsOf(m1.id)[0]!.state).toBe("closed");
  });

  test("C: each Mark read's Undo reopens its own questions, and a reopened note names only those", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.ask);
    store.markRead(m1.id, true);
    store.tellSetAside(m1.id, 0);
    const m2 = say(STATE_BODIES.stop, m1.id);
    store.markRead(m1.id, true);
    store.tellSetAside(m1.id, 0);
    const q1 = store.questionsOf(m1.id)[0]!;
    const q2 = store.questionsOf(m2.id)[0]!;
    expect([q1.state, q2.state]).toEqual(["closed", "closed"]);
    const before = store.thread(m1.id)!.messages.length;
    store.markRead(m1.id, false);
    expect([store.questionsOf(m1.id)[0]!.state, store.questionsOf(m2.id)[0]!.state]).toEqual(["closed", "open"]);
    const added = store.thread(m1.id)!.messages.slice(before);
    expect(added.map((m) => ({ reply_to: m.reply_to, reopened: m.reopened }))).toEqual([{ reply_to: m2.id, reopened: [`${m2.id}/${q2.key}`] }]);
    expect(store.listRow(m1.id)!.section).toBe("stopped");
    // A second Undo has no Mark read to undo: nothing is written, q1 stays closed.
    const cursor = store.cursor();
    store.markRead(m1.id, false);
    expect(store.cursor()).toBe(cursor);
    expect(store.questionsOf(m1.id)[0]!.state).toBe("closed");
  });

  test("C: a set-aside record older than read_seq is matched to its Mark read by time", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.ask);
    store.markRead(m1.id, true);
    say(STATE_BODIES.news, m1.id);
    const m3 = say(STATE_BODIES.ask, m1.id);
    store.markRead(m1.id, true);
    // Rewrite the store's lines as an Inbox before the field wrote them: no read_seq.
    const dir = store.dir;
    for (const project of readdirSync(join(dir, "projects"))) {
      const file = join(dir, "projects", project, "questions.jsonl");
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((raw) => JSON.parse(raw));
      for (const line of lines) if (line.record.set_aside) delete line.record.set_aside.read_seq;
      writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    const old = InboxStore.open(dir.replace(/\/inbox$/, ""));
    old.markRead(m1.id, false);
    expect([old.questionsOf(m1.id)[0]!.state, old.questionsOf(m3.id)[0]!.state]).toEqual(["closed", "open"]);
  });
});

// The Archived column of the doc's transition table, on a real store: an
// archived thread refuses the person's writes only while no agent wrote
// after the archive line. One that came back and returned to the archive
// takes Mark read, Undo, and picks and Sends on its later messages.
describe("the thread-state model: the Archived column", () => {
  const refused = (f: () => unknown) => {
    try {
      f();
      return null;
    } catch (error) {
      return error instanceof InboxError ? error.code : String(error);
    }
  };

  test("no agent wrote after the archive line: pick, Send, Mark read and Undo are refused", () => {
    const { store, say, pick } = knownStore();
    const m1 = say(STATE_BODIES.ask);
    store.resolveThread(m1.id, true);
    expect(refused(() => pick(m1.id, "Yes"))).toBe("thread_resolved");
    expect(refused(() => store.sendReply(m1.id, { words: "ok", idempotency_key: "k1" }))).toBe("thread_resolved");
    expect(refused(() => store.markRead(m1.id, true))).toBe("thread_resolved");
    expect(refused(() => store.markRead(m1.id, false))).toBe("thread_resolved");
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
  });

  test("came back and returned: Mark read and Undo are taken and it stays Archived; a Send on the later message brings it back as Sent", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.news);
    store.resolveThread(m1.id, true);
    const m2 = say(STATE_BODIES.news, m1.id);
    store.markSeen(m1.id);
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
    expect(refused(() => store.markRead(m1.id, true))).toBeNull();
    expect(store.listRow(m1.id)).toMatchObject({ section: "quiet", back_from_archive: false });
    expect(refused(() => store.markRead(m1.id, false))).toBeNull();
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
    // The message before the line still refuses; the later one takes the Send.
    expect(refused(() => store.sendReply(m1.id, { words: "x", idempotency_key: "k0" }))).toBe("thread_resolved");
    expect(refused(() => store.sendReply(m2.id, { words: "thanks", idempotency_key: "k1" }))).toBeNull();
    expect(store.listRow(m1.id)).toMatchObject({ section: "sent", back_from_archive: true });
  });

  test("came back and returned: a pick on a later question is taken and brings it back as New", () => {
    const { store, say, pick } = knownStore();
    const m1 = say(STATE_BODIES.news);
    store.resolveThread(m1.id, true);
    const m2 = say(STATE_BODIES.ask, m1.id);
    pick(m2.id, "Yes");
    const q = store.questionsOf(m2.id)[0]!;
    store.sendReply(m2.id, { idempotency_key: "k1", questions: [{ key: q.key, revision: q.revision }] });
    store.markAgentChecked(m1.id);
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
    expect(refused(() => pick(m2.id, "No"))).toBeNull();
    expect(store.listRow(m1.id)).toMatchObject({ section: "new", back_from_archive: true });
  });

  test("Mark read sends a came-back thread to the archive; Undo brings it back as it was (Waiting, unseen put back)", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.news);
    store.resolveThread(m1.id, true);
    say(STATE_BODIES.ask, m1.id);
    const before = store.listRow(m1.id)!;
    expect(before).toMatchObject({ section: "waiting", back_from_archive: true, unseen: 2 });
    store.markRead(m1.id, true);
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
    store.markRead(m1.id, false);
    expect(store.listRow(m1.id)).toMatchObject({ section: "waiting", back_from_archive: true, unseen: 2 });
  });
});
