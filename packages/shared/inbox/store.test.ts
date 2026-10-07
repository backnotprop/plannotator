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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questionKey, type QuestionAnswer } from "@plannotator/core/question-block";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
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
  return store.listProjects().map((project) => ({
    project,
    threads: store.threadsOf(project.id).map((summary) => ({ summary, thread: store.thread(summary.thread_id) })),
  }));
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
