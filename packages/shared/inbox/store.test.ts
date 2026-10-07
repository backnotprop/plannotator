/**
 * Invariants of the Inbox store, checked over generated operation sequences
 * against the real files in a temp data dir:
 *  - round trip: reopening the store from disk gives the same view;
 *  - seq: one counter, strictly increasing, every line unique;
 *  - a torn last line (a crash mid-append) is skipped, and the next append
 *    still reads back whole;
 *  - idempotency keys: a replayed send or Send writes nothing.
 * Plus the question key: the store's keys are core's keys.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questionKey, type QuestionAnswer } from "@plannotator/core/question-block";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { inboxThreadNameKey } from "@plannotator/core/inbox-types";
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
  | { op: "send"; root: number; body: string; key: string | null }
  | { op: "reply"; target: number; body: string }
  | { op: "pick"; target: number; choice: number }
  | { op: "personSend"; target: number; key: string; words: string }
  | { op: "resolve"; target: number; resolved: boolean };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("send" as const), root: fc.nat(2), body: bodyArb, key: fc.option(fc.constantFrom("a", "b", "c"), { nil: null }) }),
  fc.record({ op: fc.constant("reply" as const), target: fc.nat(), body: bodyArb }),
  fc.record({ op: fc.constant("pick" as const), target: fc.nat(), choice: fc.nat(3) }),
  fc.record({ op: fc.constant("personSend" as const), target: fc.nat(), key: fc.constantFrom("s1", "s2"), words: fc.constantFrom("", "ok", "go ahead") }),
  fc.record({ op: fc.constant("resolve" as const), target: fc.nat(), resolved: fc.boolean() }),
);

/** Run one op; expected refusals (InboxError) are part of the space and write nothing. */
function run(store: InboxStore, op: Op, messageIds: string[]): void {
  const pick = (n: number) => messageIds[n % Math.max(1, messageIds.length)];
  try {
    switch (op.op) {
      case "send": {
        const project = store.ensureProject({ name: `repo${op.root}`, root: `/work/repo${op.root}` });
        const result = store.sendMessage({
          project_id: project.id,
          author: { kind: "agent", host: "test", session: "ses_x", name: null },
          body: op.body,
          idempotency_key: op.key,
        });
        if (!result.replayed) messageIds.push(result.message.id);
        return;
      }
      case "reply": {
        const target = pick(op.target);
        if (!target) return;
        const message = store.message(target)!;
        const result = store.sendMessage({
          project_id: message.project_id,
          author: { kind: "agent", host: "test", session: "ses_x", name: null },
          body: op.body,
          reply_to: target,
        });
        messageIds.push(result.message.id);
        return;
      }
      case "pick": {
        const target = pick(op.target);
        if (!target) return;
        const question = store.questionsOf(target)[0];
        if (!question) return;
        const answer: QuestionAnswer =
          question.kind === "text"
            ? { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: [], text: "free" }
            : { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: [question.choices[op.choice % question.choices.length]!.label] };
        store.savePicks(target, [{ key: question.key, revision: question.revision, answer }]);
        return;
      }
      case "personSend": {
        const target = pick(op.target);
        if (!target) return;
        const picked = store.questionsOf(target).filter((q) => q.state === "picked");
        store.sendReply(target, {
          words: op.words,
          idempotency_key: op.key,
          questions: picked.map((q) => ({ key: q.key, revision: q.revision })),
        });
        return;
      }
      case "resolve": {
        const target = pick(op.target);
        if (target) store.resolveThread(target, op.resolved);
        return;
      }
    }
  } catch (error) {
    if (!(error instanceof InboxError)) throw error;
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
