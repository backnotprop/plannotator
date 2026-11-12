import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { questionKey, type QuestionAnswer } from "@plannotator/core/question-block";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { INBOX_SECTIONS, inboxHasUnsent, inboxRowOffersMarkRead, inboxThreadNameKey, type InboxListRow, type InboxListSection, type InboxSectionId } from "@plannotator/core/inbox-types";
import { waitingCount } from "../../inbox/held";
import { inboxArchivedRows, inboxListSections, inboxRowArchived } from "./list";
import { archiveProject, markProjectRead, unarchiveProject, unmarkProjectRead } from "./project-batch";
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

function view(store: InboxStore) {
  return {
    projects: store.listProjects().map((project) => ({
      project,
      threads: store.threadsOf(project.id).map((summary) => ({ summary, thread: store.thread(summary.thread_id) })),
      sections: store.listSections(project.id),
    })),
    sections: store.listSections(),
    cards: store.listCards().map((card) => store.cardWire(card)),
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

const promptArb = fc.stringMatching(/^[A-Za-z][A-Za-z ?,]{2,40}$/).map((s) => s.trim() + "?");
const labelArb = fc.stringMatching(/^[A-Za-z][A-Za-z ]{1,20}$/).map((s) => s.trim());

const bodyArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9 .,]{1,60}$/).filter((s) => s.trim().length > 0),
  fc.string({ unit: "binary", minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
  fc.constant('x"}\n{"v":1,"seq":999999,"at":"x","kind":"message","id":"msg_FAKE","record":{"id":"msg_FAKE"}}\n'),
  fc.tuple(promptArb, fc.uniqueArray(labelArb, { minLength: 2, maxLength: 4, selector: (s) => s.toLowerCase() })).map(
    ([prompt, labels]) => [":::question", prompt, "", ...labels.map((l) => `- [ ] ${l}`), ":::"].join("\n"),
  ),
  promptArb.map((prompt) => [":::question-text", prompt, ":::"].join("\n")),
  fc.tuple(promptArb, fc.boolean()).map(([prompt, stopped]) => [":::action", prompt.replace(/\?$/, ""), "The why.", ...(stopped ? ["Stopped: it waits on you"] : []), ":::"].join("\n")),
  fc.tuple(promptArb, promptArb).map(([todo, ask]) => [":::action", todo.replace(/\?$/, ""), ":::", "", ":::question-text", ask, ":::"].join("\n")),
);

type Op =
  | { op: "send"; root: number; body: string; key: string | null; session?: string | null }
  | { op: "reply"; target: number; body: string; session?: string }
  | { op: "pick"; target: number; choice: number; question?: number }
  | { op: "personSend"; target: number; key: string; words: string; skip?: boolean; tag?: string | null; across?: boolean }
  | { op: "resolve"; target: number; resolved: boolean }
  | { op: "tagDeliver"; target: number; session: string }
  | { op: "supersede"; target: number; whole: boolean; body: string }
  | { op: "seen"; target: number; through?: number }
  | { op: "read"; target: number; read: boolean }
  | { op: "unread"; target: number }
  | { op: "agentRead"; target: number }
  | { op: "tell"; target: number }
  | { op: "personStart"; root: number; key: string; session: string; body: string }
  | { op: "deliver"; target: number }
  | { op: "ack"; target: number; on: boolean }
  | { op: "draft"; target: number; words: boolean }
  | { op: "reask"; target: number; key: string }
  | { op: "card"; target: number; card: CardOp }
  | { op: "todo"; target: number; outcome: "done" | "cant" | "undo" }
  | { op: "settle" }
  | { op: "agentDone"; target: number };

type CardOp = { kind: "create" } | { kind: "move"; n: number; column: string; person: boolean; you: boolean; reason: boolean } | { kind: "say"; n: number } | { kind: "restore"; n: number };

const cardOpArb: fc.Arbitrary<CardOp> = fc.oneof(
  fc.record({ kind: fc.constant("create" as const) }),
  fc.record({
    kind: fc.constant("move" as const),
    n: fc.nat(),
    column: fc.constantFrom("backlog", "todo", "in_progress", "in_review", "shipped", "dropped", "building", "icebox"),
    person: fc.boolean(),
    you: fc.boolean(),
    reason: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("say" as const), n: fc.nat() }),
  fc.record({ kind: fc.constant("restore" as const), n: fc.nat() }),
);

function runCard(store: InboxStore, op: CardOp, target: string | undefined, cardIds: string[]): void {
  const agent = { kind: "agent" as const, host: "test", session: "ses_x", name: null };
  if (op.kind === "create") {
    if (!target) return;
    const message = store.message(target)!;
    cardIds.push(store.createCard({ project_id: message.project_id, by: agent, threads: [target] }).card.id);
    return;
  }
  const id = cardIds[op.n % Math.max(1, cardIds.length)];
  if (!id) return;
  if (op.kind === "say") store.updateCard(id, { by: agent, say: "still on it" });
  else if (op.kind === "restore") store.updateCard(id, { by: { kind: "person" }, restore: true });
  else
    store.updateCard(id, {
      by: op.person ? { kind: "person" } : agent,
      column: op.column,
      ...(op.you ? { you: "look at it" } : {}),
      ...(op.reason ? { reason: "moot" } : {}),
    });
}

const PERSON_BODIES = ["Idea: group the list by session.", "Add a retry budget to the relay."] as const;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("send" as const), root: fc.nat(2), body: bodyArb, key: fc.option(fc.constantFrom("a", "b", "c"), { nil: null }) }),
  fc.record({ op: fc.constant("reply" as const), target: fc.nat(), body: bodyArb }),
  fc.record({ op: fc.constant("pick" as const), target: fc.nat(), choice: fc.nat(3) }),
  fc.record({
    op: fc.constant("personSend" as const),
    target: fc.nat(),
    key: fc.constantFrom("s1", "s2"),
    words: fc.constantFrom("", "ok", "go ahead"),
    skip: fc.boolean(),
    tag: fc.constantFrom(null, null, "ses_t1", "ses_t2", "ses_x"),
    across: fc.boolean(),
  }),
  fc.record({ op: fc.constant("resolve" as const), target: fc.nat(), resolved: fc.boolean() }),
  fc.record({ op: fc.constant("tagDeliver" as const), target: fc.nat(), session: fc.constantFrom("ses_t1", "ses_t2") }),
  fc.record({ op: fc.constant("supersede" as const), target: fc.nat(), whole: fc.boolean(), body: bodyArb }),
  fc.record({ op: fc.constant("seen" as const), target: fc.nat() }),
  fc.record({ op: fc.constant("read" as const), target: fc.nat(), read: fc.boolean() }),
  fc.record({ op: fc.constant("agentRead" as const), target: fc.nat() }),
  fc.record({ op: fc.constant("tell" as const), target: fc.nat() }),
  fc.record({
    op: fc.constant("personStart" as const),
    root: fc.nat(2),
    key: fc.constantFrom("p1", "p2", "p3"),
    session: fc.constantFrom("ses_a", "ses_b"),
    body: fc.constantFrom(...PERSON_BODIES),
  }),
  fc.record({ op: fc.constant("deliver" as const), target: fc.nat() }),
  fc.record({ op: fc.constant("ack" as const), target: fc.nat(), on: fc.boolean() }),
  fc.record({ op: fc.constant("card" as const), target: fc.nat(), card: cardOpArb }),
  fc.record({ op: fc.constant("todo" as const), target: fc.nat(), outcome: fc.constantFrom("done" as const, "cant" as const, "undo" as const) }),
  fc.record({ op: fc.constant("settle" as const) }),
  fc.record({ op: fc.constant("agentDone" as const), target: fc.nat() }),
);

const cardIdsOf = new WeakMap<InboxStore, string[]>();

type Outcome = "ok" | "noop" | "replayed" | `refused:${string}`;

function targetOf(op: Op, messageIds: readonly string[]): string | undefined {
  return op.op === "send" || op.op === "personStart" || op.op === "settle" ? undefined : messageIds[op.target % Math.max(1, messageIds.length)];
}

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
          author: { kind: "agent", host: "test", session: op.session ?? "ses_x", name: null },
          body: op.body,
          reply_to: target,
        });
        messageIds.push(result.message.id);
        return "ok";
      }
      case "pick": {
        if (!target) return "noop";
        const questions = store.questionsOf(target).filter((q) => q.kind !== "action");
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
        const own = store.message(target)!;
        const session = own.author.kind === "agent" ? (own.author.session ?? null) : null;
        const others =
          op.across === true && session
            ? store
                .thread(own.thread_id)!
                .messages.filter(
                  (m) =>
                    m.id !== target &&
                    m.author.kind === "agent" &&
                    m.author.session === session &&
                    (m.questions ?? []).some((q) => q.state === "open" || q.state === "picked"),
                )
                .map((m) => m.id)
            : [];
        const picked = [target, ...others].flatMap((id) =>
          store
            .questionsOf(id)
            .filter((q) => q.state === "picked" && q.kind !== "action")
            .map((q) => ({ ...(id === target ? {} : { message_id: id }), key: q.key, revision: q.revision })),
        );
        const listed = [target, ...others].flatMap((id) =>
          store
            .questionsOf(id)
            .filter((q) => q.kind !== "action")
            .map((q) => (id === target ? { key: q.key } : { message_id: id, key: q.key })),
        );
        const result = store.sendReply(target, {
          words: op.words,
          idempotency_key: op.key,
          questions: picked,
          ...(op.skip === true ? { skip: listed } : {}),
          ...(op.tag ? { tags: [{ host: "test", session: op.tag, wakes: op.tag !== "ses_t2" }] } : {}),
        });
        if (result.replayed) return "replayed";
        return "ok";
      }
      case "resolve": {
        if (!target) return "noop";
        store.resolveThread(target, op.resolved);
        return "ok";
      }
      case "tagDeliver": {
        if (!target) return "noop";
        const waiting = store
          .thread(threadOf(target))!
          .messages.filter((m) => m.author.kind === "person" && m.tags?.some((t) => t.session === op.session && !t.delivery));
        for (const message of waiting) store.recordDelivery(message.id, { host: "test", session: op.session });
        return waiting.length > 0 ? "ok" : "noop";
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
      case "unread":
        if (!target) return "noop";
        store.markUnread(threadOf(target));
        return "ok";
      case "agentRead":
        if (!target) return "noop";
        store.markAgentChecked(threadOf(target));
        return "ok";
      case "tell":
        if (!target) return "noop";
        store.tellSetAside(threadOf(target), 0);
        return "ok";
      case "personStart": {
        const project = store.ensureProject({ name: `repo${op.root}`, root: `/work/repo${op.root}` });
        const result = store.startPersonThread({ project_id: project.id, body: op.body, to: { host: "test", session: op.session }, idempotency_key: op.key });
        if (result.replayed) return "replayed";
        messageIds.push(result.message.id);
        return "ok";
      }
      case "deliver": {
        if (!target) return "noop";
        const waiting = store.thread(threadOf(target))!.messages.filter((m) => m.author.kind === "person" && m.to && !m.delivery);
        for (const message of waiting) store.recordDelivery(message.id, message.to!);
        return waiting.length > 0 ? "ok" : "noop";
      }
      case "ack":
        if (!target) return "noop";
        store.ackMessage(target, op.on);
        return "ok";
      case "draft": {
        if (!target) return "noop";
        const thread = threadOf(target);
        store.saveReplyDraft(thread, { body: op.words ? "Cards, but keep the totals" : "", base: store.replyDraft(thread)?.updated_at ?? null });
        return "ok";
      }
      case "card": {
        const cardIds = cardIdsOf.get(store) ?? [];
        cardIdsOf.set(store, cardIds);
        runCard(store, op.card, target, cardIds);
        return "ok";
      }
      case "reask": {
        if (!target) return "noop";
        return store.sendReask(target, { idempotency_key: op.key }).replayed ? "replayed" : "ok";
      }
      case "todo": {
        if (!target) return "noop";
        const action = store.questionsOf(target).find((q) => q.kind === "action");
        if (!action) return "noop";
        store.markAction(target, action.key, op.outcome === "undo" ? { outcome: null } : { outcome: op.outcome, note: op.outcome === "cant" ? "No access." : null });
        return "ok";
      }
      case "settle":
        return store.settleActions(0).length > 0 ? "ok" : "noop";
      case "agentDone": {
        if (!target) return "noop";
        const message = store.message(target)!;
        if (!store.questionsOf(target).some((q) => q.kind === "action")) return "noop";
        const result = store.sendMessage({
          project_id: message.project_id,
          author: { kind: "agent", host: "test", session: "ses_x", name: null },
          body: "Saw it done.",
          reply_to: target,
          done: [target],
        });
        messageIds.push(result.message.id);
        return "ok";
      }
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

  test("a reply that tags agents is settled for each recipient only by its own delivery: no agent's read, and no other recipient's delivery, moves it", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const dir = dataDir();
        const store = InboxStore.open(dir);
        const ids: string[] = [];
        for (const op of ops) run(store, op, ids);
        for (const session of ["ses_x", "ses_t1", "ses_t2"]) {
          const pending = new Set(store.pendingReplies(session).map((m) => m.id));
          for (const id of ids) {
            for (const message of store.thread(store.message(id)!.thread_id)!.messages) {
              if (message.author.kind !== "person" || !message.tags?.length) continue;
              const stored = store.message(message.id)!;
              expect(stored.tags!.some((t) => store.isOwner(stored, t.session))).toBe(false);
              if (store.isOwner(stored, session)) expect(pending.has(stored.id)).toBe(!stored.delivery);
              const tag = stored.tags!.find((t) => t.session === session);
              if (tag && !store.isOwner(stored, session)) expect(pending.has(stored.id)).toBe(!tag.delivery);
            }
          }
          for (const message of store.pendingReplies(session, { tags: false })) expect(store.isOwner(message, session)).toBe(true);
        }
        const reopened = InboxStore.open(dir);
        for (const session of ["ses_x", "ses_t1", "ses_t2"]) {
          expect(reopened.pendingReplies(session).map((m) => m.id)).toEqual(store.pendingReplies(session).map((m) => m.id));
        }
      }),
      { numRuns: 80 },
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
        const torn = storeFiles(dir)
          .filter((f) => f.endsWith(".jsonl") && statSync(f).size > 0)
          .map((f) => f.slice(dir.length))
          .sort();
        for (const relative of torn) {
          const copy = dataDir();
          cpSync(dir, copy, { recursive: true });
          const file = join(copy, relative);
          const text = readFileSync(file, "utf8");
          const lastStart = text.lastIndexOf("\n", text.length - 2) + 1;
          const lastLength = text.length - 1 - lastStart;
          const tornLine = parseInboxLine(text.slice(lastStart))!;
          truncateSync(file, lastStart + Math.max(1, Math.floor(lastLength * cut)));

          const recovered = InboxStore.open(copy);
          expect(recovered.changesSince(0).some((l) => l.seq === tornLine.seq)).toBe(false);
          expect(recovered.changesSince(0).length).toBeGreaterThan(0);

          const key = file.split("/").at(-2)!;
          const project = recovered.listProjects().find((p) => p.key === key)!;
          const before = recovered.cursor();
          const again = () => InboxStore.open(copy).changesSince(before);
          if (relative.endsWith("/cards.jsonl")) {
            const card = recovered.createCard({ project_id: project.id, by: { kind: "person" }, title: "Written after the crash" }).card;
            expect(again().some((l) => l.kind === "card" && l.record.id === card.id && l.record.title === "Written after the crash")).toBe(true);
          } else {
            const body = ":::question\nWritten after the crash?\n\n- [ ] Yes\n- [ ] No\n:::";
            const written = recovered.sendMessage({
              project_id: project.id,
              author: { kind: "agent", host: null, session: null, name: null },
              body,
            });
            const after = again();
            expect(after.some((l) => l.kind === "message" && l.record.body === body)).toBe(true);
            expect(after.some((l) => l.kind === "question" && l.record.message_id === written.message.id)).toBe(true);
          }
          expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
        }
      }),
      {
        numRuns: 60,
        examples: [
          [
            [
              { op: "personStart", root: 0, key: "p1", session: "ses_a", body: "Idea: group the list by session." },
              { op: "card", target: 0, card: { kind: "create" } },
              { op: "personStart", root: 0, key: "p1", session: "ses_a", body: "Idea: group the list by session." },
            ],
            0.05,
          ],
          [[{ op: "send", root: 0, body: ":::question-text\nA,??\n:::", key: null }, { op: "card", target: 0, card: { kind: "create" } }], 0.05],
        ],
      },
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

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a Send whose reply line never landed reads as picked, and can be sent again", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "repo", root: "/work/repo" });
    const author = { kind: "agent" as const, host: null, session: null, name: null };
    const sent = store.sendMessage({ project_id: project.id, author, body: ":::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::" });
    const q = store.questionsOf(sent.message.id)[0]!;
    store.savePicks(sent.message.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] } }]);
    const messagesFile = join(dir, "inbox", "projects", project.key, "messages.jsonl");

    chmodSync(messagesFile, 0o400);
    try {
      expect(() => store.sendReply(sent.message.id, { idempotency_key: "s", questions: [{ key: q.key, revision: 1 }] })).toThrow();
    } finally {
      chmodSync(messagesFile, 0o600);
    }
    expect(store.questionsOf(sent.message.id)[0]!.state).toBe("picked");
    const reopened = InboxStore.open(dir);
    expect(reopened.questionsOf(sent.message.id)[0]).toMatchObject({ state: "picked", sent_reply_id: null });
    expect(reopened.thread(sent.message.thread_id)!.messages).toHaveLength(1);

    const retry = reopened.sendReply(sent.message.id, { idempotency_key: "s", questions: [{ key: q.key, revision: 1 }] });
    expect(retry.replayed).toBe(false);
    expect(retry.questions[0]).toMatchObject({ state: "sent", sent_reply_id: retry.reply.id });
    expect(InboxStore.open(dir).questionsOf(sent.message.id)[0]).toMatchObject({ state: "sent", sent_reply_id: retry.reply.id });
  });

  test("two same-named roots whose 6-hex keys collide still get separate folders", () => {
    const dir = dataDir();
    const store = InboxStore.open(dir);
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
      | { op: "personReply"; target: number; key: string }
      | { op: "personStart"; project: number; key: string; session: string; name: string | null; auto: boolean }
      | { op: "name"; target: number; session: string; thread: string }
      | { op: "card"; target: number; card: CardOp };
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
      fc.record({
        op: fc.constant("personStart" as const),
        project: fc.nat(1),
        key: fc.constantFrom("c1", "c2", "c3"),
        session: fc.constantFrom("ses_a", "ses_b"),
        name: fc.constantFrom(null, null, "alpha", "BETA"),
        auto: fc.boolean(),
      }),
      fc.record({ op: fc.constant("name" as const), target: fc.nat(), session: fc.constantFrom("ses_a", "ses_b"), thread: fc.constantFrom("alpha", "Beta", "gamma") }),
      { arbitrary: fc.record({ op: fc.constant("card" as const), target: fc.nat(), card: cardOpArb }), weight: 3 },
    );

    fc.assert(
      fc.property(fc.array(routeOpArb, { maxLength: 40 }), (ops) => {
        const dir = dataDir();
        const store = InboxStore.open(dir);
        const ids: string[] = [];
        const cardIds: string[] = [];
        const pick = (n: number) => ids[n % Math.max(1, ids.length)];
        for (const op of ops) {
          try {
            if (op.op === "card") {
              const before = JSON.stringify({ sections: store.listSections(), threads: store.threadIds().map((id) => store.threadSummary(id)) });
              try {
                runCard(store, op.card, pick(op.target), cardIds);
              } finally {
                expect(JSON.stringify({ sections: store.listSections(), threads: store.threadIds().map((id) => store.threadSummary(id)) })).toBe(before);
              }
            } else if (op.op === "send") {
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
            } else if (op.op === "personStart") {
              const project = store.ensureProject({ name: `repo${op.project}`, root: `/work/repo${op.project}` });
              const r = store.startPersonThread({ project_id: project.id, body: "an idea", to: { host: "test", session: op.session }, idempotency_key: op.key, thread_name: op.name, thread_name_auto: op.auto });
              if (!r.replayed) ids.push(r.message.id);
            } else if (op.op === "name") {
              const target = pick(op.target);
              if (!target) continue;
              const r = store.sendMessage({
                project_id: store.message(target)!.project_id,
                author: { kind: "agent", host: "test", session: op.session, name: null },
                body: "named",
                reply_to: target,
                thread: op.thread,
              });
              ids.push(r.message.id);
            } else {
              const target = pick(op.target);
              if (target) store.sendReply(target, { words: "ok", idempotency_key: op.key });
            }
          } catch (error) {
            if (!(error instanceof InboxError)) throw error;
          }
        }

        const lines = allLines(dir).sort((a, b) => a.seq - b.seq);
        const threadOf = new Map<string, string>();
        const resolved = new Map<string, boolean>();
        const byName = new Map<string, string[]>();
        const current = new Map<string, string>();
        const agentNamed = new Set<string>();
        const nameKey = inboxThreadNameKey;
        const rootsNamed = (key: string) => (byName.get(key) ?? []).filter((root) => current.get(root) === key);
        const holders = (key: string) => [...current].filter(([, k]) => k === key).map(([root]) => root);
        for (const line of lines) {
          if (line.kind !== "message") continue;
          const m = line.record;
          if (threadOf.has(m.id)) {
            if (m.id === m.thread_id) resolved.set(m.id, m.resolved_at !== null);
            if (m.id === m.thread_id && m.started_by_person && m.thread_name != null && m.named_by?.kind === "agent" && !agentNamed.has(m.id)) {
              const key = `${m.project_id}\0${nameKey(m.thread_name)}`;
              if (current.has(m.id)) expect(m.named_by?.kind).toBe("agent");
              expect(holders(key).filter((root) => root !== m.id && !resolved.get(root))).toEqual([]);
              current.set(m.id, key);
              agentNamed.add(m.id);
              byName.set(key, [...(byName.get(key) ?? []), m.id]);
            }
            continue;
          }
          let expected: string;
          if (m.reply_to) {
            expected = threadOf.get(m.reply_to)!;
          } else if (m.author.kind === "person") {
            expect(m.started_by_person).toBe(true);
            expected = m.id;
          } else {
            const name = m.thread_name ?? null;
            const candidate = name !== null ? rootsNamed(`${m.project_id}\0${nameKey(name)}`).filter((root) => !resolved.get(root)).at(-1) : undefined;
            expected = candidate && !resolved.get(candidate) ? candidate : m.id;
          }
          expect(m.thread_id).toBe(expected);
          threadOf.set(m.id, m.thread_id);
          if (m.id === m.thread_id) {
            resolved.set(m.id, m.resolved_at !== null);
            if (m.thread_name != null) {
              const key = `${m.project_id}\0${nameKey(m.thread_name)}`;
              if (m.started_by_person) expect(holders(key).filter((root) => !resolved.get(root))).toEqual([]);
              current.set(m.id, key);
              if (m.started_by_person) continue;
              byName.set(key, [...(byName.get(key) ?? []), m.id]);
            }
          }
        }

        const project = store.ensureProject({ name: "repo0", root: "/work/repo0" });
        const copy = dataDir();
        cpSync(dir, copy, { recursive: true });
        const replayed = InboxStore.open(copy);
        expect(view(replayed)).toEqual(view(store));
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
    expect(questionKey("single", "Which way should the worker go on a Stripe 409?")).toMatch(/^q-[0-9a-f]{8}$/);
    expect(parseInboxQuestionBlocks(":::question\nWhich way should the worker go on a Stripe 409?\n\n- [ ] A\n- [ ] B\n:::")[0]!.key).toBe(
      questionKey("single", "Which way should the worker go on a Stripe 409?"),
    );
  });
});

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
    ...(agentKeys
      ? [
          {
            arbitrary: fc.record({
              op: fc.constant("personSend" as const),
              target: fc.nat(),
              key: fc.constantFrom("s1", "s2", "s3"),
              words: fc.constantFrom("", "ok"),
              skip: fc.boolean(),
              across: fc.constant(true),
            }),
            weight: 3,
          },
        ]
      : []),
    { arbitrary: fc.record({ op: fc.constant("seen" as const), target: fc.nat() }), weight: 2 },
    ...(agentKeys ? [{ arbitrary: fc.record({ op: fc.constant("seen" as const), target: fc.nat(), through: fc.nat() }), weight: 2 }] : []),
    { arbitrary: fc.record({ op: fc.constant("read" as const), target: fc.nat(), read: fc.boolean() }), weight: 3 },
    { arbitrary: fc.record({ op: fc.constant("resolve" as const), target: fc.nat(), resolved: fc.boolean() }), weight: 3 },
    { arbitrary: fc.record({ op: fc.constant("agentRead" as const), target: fc.nat() }), weight: 2 },
    { arbitrary: fc.record({ op: fc.constant("tell" as const), target: fc.nat() }), weight: 2 },
    ...(agentKeys
      ? [
          {
            arbitrary: fc.record({
              op: fc.constant("personStart" as const),
              root: fc.nat(1),
              key: fc.constantFrom("p1", "p2", "p3"),
              session: fc.constantFrom("ses_a", "ses_b"),
              body: fc.constantFrom(...PERSON_BODIES),
            }),
            weight: 1,
          },
          { arbitrary: fc.record({ op: fc.constant("deliver" as const), target: fc.nat() }), weight: 1 },
          { arbitrary: fc.record({ op: fc.constant("ack" as const), target: fc.nat(), on: fc.boolean() }), weight: 2 },
          { arbitrary: fc.record({ op: fc.constant("draft" as const), target: fc.nat(), words: fc.boolean() }), weight: 2 },
          { arbitrary: fc.record({ op: fc.constant("reask" as const), target: fc.nat(), key: fc.constantFrom("r1", "r2", "s1") }), weight: 2 },
          { arbitrary: fc.record({ op: fc.constant("unread" as const), target: fc.nat() }), weight: 2 },
        ]
      : []),
  );
}

const stateOpArb = stateOpArbOf(
  fc.oneof({ arbitrary: fc.constantFrom(...Object.values(STATE_BODIES)), weight: 6 }, { arbitrary: bodyArb, weight: 1 }),
  true,
);
const traceOpArb = stateOpArbOf(fc.constantFrom(...Object.values(STATE_BODIES)), false);

type QState = "open" | "picked" | "sent" | "closed" | "superseded";
type ModelAnswer = null | "pick" | "skip";

interface ModelQuestion {
  id: string;
  action: boolean;
  stopped: boolean;
  holds: boolean;
  answer: ModelAnswer;
  sent: boolean;
  setAside: { answer: ModelAnswer; sent: boolean; by: number } | null;
  superseded: boolean;
}

interface ModelMessage {
  id: string;
  author: "agent" | "person";
  note: "set_aside" | "reopened" | null;
  tick: number;
  questions: ModelQuestion[];
  replyKeys: Set<string>;
  reaskKeys?: Set<string>;
  session?: string | null;
  reask?: { session: string | null; ids: string[] };
  addressed?: { delivered: boolean };
  ack?: { readTick: number | null; made: boolean } | null;
}

interface ModelThread {
  id: string;
  messages: ModelMessage[];
  seen: number;
  read: number | null;
  seenBeforeRead: number | undefined;
  resolved: boolean;
  archive: number;
  checked: number;
  told: Set<string>;
  draft?: boolean;
}

const SHW: readonly InboxSectionId[] = ["stopped", "holding", "waiting"];
const SHWN: readonly InboxSectionId[] = ["stopped", "holding", "waiting", "new"];

class ThreadStateModel {
  readonly threads = new Map<string, ModelThread>();
  private readonly byMessage = new Map<string, { thread: ModelThread; message: ModelMessage }>();
  private readonly keyed = new Map<string, string>();
  private readonly personKeyed = new Map<string, string>();
  private created: readonly string[] = [];
  private used = 0;

  closedByArchive(t: ModelThread, m: ModelMessage): boolean {
    return t.resolved && m.tick < t.archive;
  }

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

  private lookTick(t: ModelThread): number {
    let look = t.seen;
    for (const m of t.messages) if (m.author === "person" && m.note === null) look = Math.max(look, m.tick);
    return look;
  }

  unseen(t: ModelThread): number {
    const look = this.lookTick(t);
    return t.messages.filter((m) => m.author === "agent" && m.tick > look).length;
  }

  waitingOnPerson(t: ModelThread): boolean {
    const last = [...t.messages].reverse().find((m) => m.note === null)!;
    return !t.resolved && last.author === "agent" && !this.readHolds(t);
  }

  agentAfter(t: ModelThread): boolean {
    return t.resolved && t.messages.some((m) => m.author === "agent" && m.tick > t.archive);
  }

  replyUnreadAfterArchive(t: ModelThread): boolean {
    const real = [...t.messages].reverse().find((m) => !(m.author === "person" && m.note !== null));
    return real !== undefined && real.author === "person" && real.tick > t.archive && t.checked < real.tick;
  }

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
      (this.replyUnreadAfterArchive(t) && !this.readHolds(t))
    );
  }

  archived(t: ModelThread): boolean {
    return t.resolved && !this.back(t);
  }

  unsent(t: ModelThread): boolean {
    return t.draft === true || this.counts(t).picked > 0;
  }

  section(t: ModelThread): InboxSectionId {
    if (this.archived(t)) return "quiet";
    if (this.readHolds(t) && this.unseen(t) > 0) return "new";
    if (this.readHolds(t)) return this.unsent(t) && !this.reaskPending(t) ? "new" : "quiet";
    if (this.reaskPending(t)) return "sent";
    const c = this.counts(t);
    if (c.open > 0) return c.stopped ? "stopped" : c.holds ? "holding" : "waiting";
    if (c.picked > 0) return "new";
    const last = [...t.messages].reverse().find((m) => m.note === null)!;
    if (last.author === "person" && t.checked < last.tick) return "sent";
    if (this.unseen(t) > 0) return "new";
    return this.unsent(t) ? "new" : "quiet";
  }

  waits(t: ModelThread): boolean {
    const section = this.section(t);
    if (section === "new") return this.unseen(t) > 0 || this.counts(t).picked > 0;
    return SHW.includes(section);
  }

  unread(t: ModelThread): boolean {
    return this.waits(t) && (this.section(t) === "new" || this.unseen(t) > 0);
  }

  reaskPending(t: ModelThread): boolean {
    const open = new Set<string>();
    for (const m of t.messages) for (const q of m.questions) if (this.state(t, m, q) === "open") open.add(q.id);
    const covered = new Set<string>();
    t.messages.forEach((note, i) => {
      if (!note.reask) return;
      if (t.messages.slice(i + 1).some((m) => m.author === "agent" && m.session === note.reask!.session)) return;
      for (const id of note.reask.ids) if (open.has(id)) covered.add(id);
    });
    return open.size > 0 && [...open].every((id) => covered.has(id));
  }

  threadOf(messageId: string): ModelThread | undefined {
    return this.byMessage.get(messageId)?.thread;
  }

  private take(): string {
    const id = this.created[this.used];
    if (id === undefined) throw new Error("the model expected the store to write a message it did not write");
    this.used += 1;
    return id;
  }

  private addAgent(thread: ModelThread, tick: number, store: InboxStore, session: string | null = "ses_x"): void {
    const id = this.take();
    const message: ModelMessage = {
      id,
      author: "agent",
      session,
      note: null,
      tick,
      replyKeys: new Set(),
      questions: store.questionsOf(id).map((q) => ({
        id: `${id}/${q.key}`,
        action: q.kind === "action",
        stopped: q.stopped !== null,
        holds: q.holds_up.length > 0,
        answer: null,
        sent: false,
        setAside: null,
        superseded: false,
      })),
    };
    thread.messages.push(message);
    this.byMessage.set(id, { thread, message });
    this.agentMessages.push(message);
  }

  private readonly agentMessages: ModelMessage[] = [];

  private tickOfAgent(index: number): number {
    return this.agentMessages[index % Math.max(1, this.agentMessages.length)]?.tick ?? 0;
  }

  private addPerson(thread: ModelThread, tick: number, note: ModelMessage["note"]): void {
    const id = this.take();
    const message: ModelMessage = { id, author: "person", note, tick, replyKeys: new Set(), questions: [] };
    thread.messages.push(message);
    this.byMessage.set(id, { thread, message });
  }

  apply(op: Op, target: string | undefined, created: readonly string[], store: InboxStore, tick: number): Outcome {
    this.created = created;
    this.used = 0;
    const outcome = this.event(op, target, store, tick);
    expect(this.used).toBe(created.length);
    return outcome;
  }

  private event(op: Op, target: string | undefined, store: InboxStore, tick: number): Outcome {
    if (op.op === "personStart") {
      const body = this.personKeyed.get(op.key);
      if (body !== undefined) return body === op.body ? "replayed" : "refused:idempotency_key_reused";
      const id = this.created[this.used]!;
      const thread: ModelThread = { id, messages: [], seen: 0, read: null, seenBeforeRead: undefined, resolved: false, archive: 0, checked: 0, told: new Set() };
      this.threads.set(id, thread);
      this.addPerson(thread, tick, null);
      const root = thread.messages[0]!;
      root.addressed = { delivered: false };
      this.agentMessages.push(root);
      this.personKeyed.set(op.key, op.body);
      return "ok";
    }
    if (op.op === "send") {
      const project = `repo${op.root}`;
      const key = op.key?.trim() || null;
      if (key !== null) {
        const body = this.keyed.get(`${project}\0${key}`);
        if (body !== undefined) return body === op.body ? "replayed" : "refused:idempotency_key_reused";
      }
      const session = op.session === undefined ? "ses_x" : op.session;
      const id = this.created[this.used]!;
      const thread: ModelThread = { id, messages: [], seen: 0, read: null, seenBeforeRead: undefined, resolved: false, archive: 0, checked: 0, told: new Set() };
      this.threads.set(id, thread);
      this.addAgent(thread, tick, store, session);
      if (key !== null) this.keyed.set(`${project}\0${key}`, op.body);
      return "ok";
    }
    if (!target) return "noop";
    const { thread, message } = this.byMessage.get(target)!;
    switch (op.op) {
      case "reply":
        this.addAgent(thread, tick, store, op.session ?? "ses_x");
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
        const pickable = message.questions.filter((q) => !q.action);
        if (pickable.length === 0) return "noop";
        const q = pickable[(op.question ?? 0) % pickable.length]!;
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
        const others =
          op.across === true && message.author === "agent" && message.session
            ? thread.messages.filter(
                (m) =>
                  m !== message &&
                  m.author === "agent" &&
                  m.session === message.session &&
                  m.questions.some((q) => {
                    const st = this.state(thread, m, q);
                    return st === "open" || st === "picked";
                  }),
              )
            : [];
        const covered = [message, ...others];
        const picks = covered.flatMap((m) => m.questions.filter((q) => this.recordState(q) === "picked"));
        const skips = op.skip ? covered.flatMap((m) => m.questions.filter((q) => !q.action && this.recordState(q) === "open")) : [];
        if (picks.length === 0 && skips.length === 0 && op.words.trim() === "") {
          return op.skip && covered.some((m) => m.questions.some((q) => !q.action)) ? "refused:nothing_to_send" : "refused:validation_error";
        }
        for (const q of picks) q.sent = true;
        for (const q of skips) {
          q.answer = "skip";
          q.sent = true;
        }
        message.replyKeys.add(op.key);
        this.addPerson(thread, tick, null);
        if (message.addressed) thread.messages[thread.messages.length - 1]!.addressed = { delivered: false };
        return "ok";
      }
      case "resolve":
        if (thread.resolved === op.resolved) return "ok";
        if (op.resolved) {
          thread.resolved = true;
          thread.archive = tick;
        } else {
          if (thread.read !== null && thread.read > thread.archive) {
            thread.read = null;
            thread.seenBeforeRead = undefined;
          }
          thread.resolved = false;
          thread.archive = 0;
        }
        return "ok";
      case "seen": {
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
          } else if (this.unseen(thread) > 0) {
            thread.seen = Math.max(...thread.messages.filter((m) => m.author === "agent").map((m) => m.tick));
          }
          return "ok";
        }
        const ownRead = thread.read;
        const own = (q: ModelQuestion) => q.setAside !== null && q.setAside.by === ownRead;
        const closed = live.flatMap((m) => m.questions).filter(own);
        if (ownRead === null && closed.length === 0) return "ok";
        if (ownRead !== null) for (const m of thread.messages) if (m.ack && m.ack.readTick === ownRead) m.ack = null;
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
      case "unread": {
        if (thread.resolved) return "refused:thread_resolved";
        const last = [...thread.messages].reverse().find((m) => m.note === null)!;
        if (last.author === "agent" && this.unseen(thread) === 0) thread.seen = last.tick - 1;
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
      case "deliver": {
        const waiting = thread.messages.filter((m) => m.addressed && !m.addressed.delivered);
        for (const m of waiting) {
          m.addressed!.delivered = true;
          thread.checked = Math.max(thread.checked, m.tick);
        }
        return waiting.length > 0 ? "ok" : "noop";
      }
      case "ack": {
        if (!op.on) {
          const ack = message.ack;
          if (!ack) return "ok";
          message.ack = null;
          if (ack.made && ack.readTick !== null && thread.read === ack.readTick && !thread.resolved) {
            this.event({ op: "read", target: op.target, read: false }, target, store, tick);
          }
          return "ok";
        }
        if (message.author !== "agent") return "refused:ack_not_allowed";
        if (thread.resolved) return "refused:thread_resolved";
        const latest = [...thread.messages].reverse().find((m) => m.author === "agent");
        if (latest !== message) return "refused:ack_stale";
        if (thread.messages.some((m) => m.tick > message.tick && m.author === "person" && m.note === null)) return "refused:ack_after_reply";
        const waiting = thread.messages
          .filter((m) => m.author === "agent")
          .flatMap((m) => m.questions)
          .some((q) => {
            const s = this.recordState(q);
            return s === "open" || s === "picked";
          });
        if (waiting) return "refused:question_open";
        if (message.ack) return "ok";
        const before = thread.read;
        this.event({ op: "read", target: op.target, read: true }, target, store, tick);
        message.ack = { readTick: thread.read, made: thread.read !== before };
        return "ok";
      }
      case "draft":
        thread.draft = op.words;
        return "ok";
      case "reask": {
        if (message.reaskKeys?.has(op.key)) return "replayed";
        if (message.replyKeys.has(op.key)) return "refused:idempotency_key_reused";
        if (this.closedByArchive(thread, message)) return "refused:thread_resolved";
        if (message.author !== "agent") return "refused:validation_error";
        const session = message.session ?? null;
        const group = thread.messages.filter(
          (m) => m.author === "agent" && (session !== null ? m.session === session : m === message) && !this.closedByArchive(thread, m),
        );
        const questions = group.flatMap((m) => m.questions);
        const asked = questions.filter((q) => this.recordState(q) === "open");
        if (asked.length === 0) return "refused:nothing_to_reask";
        for (const q of questions) if (this.recordState(q) === "picked") q.sent = true;
        message.replyKeys.add(op.key);
        (message.reaskKeys ??= new Set()).add(op.key);
        this.addPerson(thread, tick, null);
        thread.messages[thread.messages.length - 1]!.reask = { session, ids: asked.map((q) => q.id) };
        return "ok";
      }
      case "personStart":
      case "send":
        return "noop";
    }
  }
}

function listViews(rows: readonly InboxListRow[]) {
  return {
    include: inboxListSections(rows),
    exclude: inboxListSections(rows.filter((row) => !inboxRowArchived(row))),
    archived: inboxArchivedRows(rows),
  };
}

const placedIds = (sections: readonly InboxListSection[]) => sections.flatMap((s) => s.threads.map((r) => r.thread_id));

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
  timeOf: Map<number, number>;
  lastRead: { threadId: string; before: ReturnType<typeof readSnapshot> } | null;
  lastAck?: { threadId: string; before: ReturnType<typeof readSnapshot> } | null;
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

function readSnapshot(world: StateWorld, threadId: string) {
  const row = world.store.listRow(threadId)!;
  return {
    section: row.section,
    unseen: row.unseen,
    read_at: row.read_at ?? null,
    questions: world.store.thread(threadId)!.messages.map((m) => (m.questions ?? []).map((q) => ({ ...q, revision: 0 }))),
  };
}

function checkThreadState(world: StateWorld): void {
  const { store, model } = world;
  const rows = store.listRows();
  const views = listViews(rows);
  const all = [...model.threads.keys()].sort();
  expect(rows.map((r) => r.thread_id).sort()).toEqual(all);
  const order = INBOX_SECTIONS.map((s) => s.id);
  for (const sections of [views.include, views.exclude]) {
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
      ack: (row.ack ?? null) !== null,
      unread: row.unread,
      draft: (row.unsent?.reply_at ?? null) !== null,
      picks: row.unsent?.picks ?? 0,
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
      ack: model.readHolds(t) && (lastAgent?.ack ?? null) !== null,
      unread: model.unread(t),
      draft: t.draft === true,
      picks: model.unsent(t) ? row.questions.picked : 0,
    });
    if (inboxHasUnsent(row.unsent) && !inboxRowArchived(row)) expect(row.section).not.toBe("quiet");
    for (const m of t.messages) {
      expect(store.message(m.id)?.thread_id).toBe(t.id);
      expect(store.questionsOf(m.id).map((q) => q.state)).toEqual(m.questions.map((q) => model.state(t, m, q)));
    }
    const thread = store.thread(row.thread_id)!;
    const openIds = thread.messages.flatMap((m) => (m.questions ?? []).filter((q) => q.state === "open").map((q) => `${m.id}/${q.key}`));
    const inWaitingNote = (id: string) =>
      thread.messages.some((note, i) => {
        if (!note.reask?.includes(id)) return false;
        const asked = thread.messages.find((m) => m.id === note.reply_to);
        const by = note.to ?? (asked?.author.kind === "agent" ? { host: asked.author.host ?? "", session: asked.author.session } : null);
        if (!by) return false;
        return !thread.messages
          .slice(i + 1)
          .some((m) => m.author.kind === "agent" && m.author.session === by.session && (m.author.host ?? "") === (by.host ?? ""));
      });
    if (openIds.some((id) => !inWaitingNote(id))) expect(SHW).toContain(row.section);
    expect(row.reask_pending === true).toBe(!model.archived(t) && model.reaskPending(t));
    if (inboxRowArchived(row)) expect(row.unread).toBe(false);
  }
  const inSections = (sections: readonly InboxListSection[], ids: readonly InboxSectionId[]) =>
    sections.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.threads.length, 0);
  const waiting = rows.filter((r) => SHW.includes(r.section)).length;
  expect(waitingCount(views.include)).toBe(waiting);
  expect(waitingCount(views.exclude)).toBe(waiting);
  expect(inSections(views.exclude, SHW)).toBe(waiting);
  for (const project of store.listProjects()) {
    expect(waitingCount(views.exclude, project.id)).toBe(rows.filter((r) => r.project.id === project.id && SHW.includes(r.section)).length);
  }
  for (const r of rows) {
    if (SHW.includes(r.section)) expect(r.unread).toBe(r.unseen > 0);
    if (r.section === "new" && !r.unread) expect(r.unseen === 0 && !r.answered_not_sent && inboxHasUnsent(r.unsent)).toBe(true);
    if (!SHWN.includes(r.section)) expect(r.unread).toBe(false);
  }
  expect(windowView(InboxStore.open(world.dir))).toEqual(windowView(store));
}

interface StepResult {
  outcome: Outcome;
  target: string | undefined;
  created: string[];
}

function stateStep(world: StateWorld, op: Op, sameTick = false): StepResult {
  const tick = ++world.tick;
  if (!sameTick || tick === 1) world.clock.now += STATE_STEP_MS;
  world.timeOf.set(tick, world.clock.now);
  const target = targetOf(op, world.ids);
  const thread = target ? world.model.threadOf(target) : undefined;
  const wasResolved = thread?.resolved ?? false;
  const readAfterArchive = thread !== undefined && thread.resolved && thread.read !== null && thread.read > thread.archive;
  const readBefore = thread ? readSnapshot(world, thread.id) : null;
  const readRecord = (threadId: string) => {
    const { person_read_seq, person_read_at, person_seen_before_read } = world.store.message(threadId)!;
    return { seq: person_read_seq ?? null, at: person_read_at ?? null, lookBefore: person_seen_before_read };
  };
  const readRecordBefore = thread ? readRecord(thread.id) : null;

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
  const lastAck = world.lastAck ?? null;
  world.lastAck = null;
  if (outcome !== "ok" || !thread) return { outcome, target, created };
  const row = world.store.listRow(thread.id)!;
  const inList = () => placedIds(listViews(world.store.listRows()).exclude).includes(thread.id);
  if ((op.op === "reply" || op.op === "supersede") && wasResolved) {
    expect(row.back_from_archive).toBe(true);
    expect(inList()).toBe(true);
  }
  if (op.op === "read" && op.read && wasResolved && thread.messages.some((m) => m.author === "agent" && m.tick > thread.archive)) {
    expect(inboxRowArchived(row)).toBe(true);
    expect(inList()).toBe(false);
  }
  if (op.op === "read" && op.read && readBefore && readBefore.read_at === null) {
    world.lastRead = { threadId: thread.id, before: readBefore };
  }
  if (op.op === "read" && !op.read) {
    const root = world.store.message(thread.id)!;
    expect(root.person_read_seq ?? null).toBeNull();
    expect(root.person_read_at ?? null).toBeNull();
    expect(row.read_at ?? null).toBeNull();
    for (const m of thread.messages) {
      if (m.author !== "agent" || world.model.closedByArchive(thread, m)) continue;
      expect(world.store.questionsOf(m.id).map((q) => q.set_aside_at !== null)).toEqual(m.questions.map((q) => q.setAside !== null));
    }
    if (lastRead?.threadId === thread.id) expect(readSnapshot(world, thread.id)).toEqual(lastRead.before);
  }
  if (op.op === "unread") {
    const last = [...thread.messages].reverse().find((m) => m.note === null)!;
    if (last.author === "agent") expect(row.unseen).toBeGreaterThan(0);
    expect(readRecord(thread.id)).toEqual(readRecordBefore!);
    expect(created).toEqual([]);
  }
  if (op.op === "ack" && op.on && readBefore && readBefore.read_at === null) {
    world.lastAck = { threadId: thread.id, before: readBefore };
  }
  if (op.op === "ack" && !op.on) {
    expect(world.store.message(target!)!.ack ?? null).toBeNull();
    if (lastAck?.threadId === thread.id) expect(readSnapshot(world, thread.id)).toEqual(lastAck.before);
  }
  if (op.op === "resolve" && !op.resolved && readAfterArchive) {
    expect(world.store.message(thread.id)!.person_read_seq ?? null).toBeNull();
  }
  return { outcome, target, created };
}

const rootIndex = (world: StateWorld, threadId: string) => world.ids.indexOf(threadId);

describe("the thread-state model", () => {
  test("generated sequences: the store agrees with the model, and every invariant holds after every step", () => {
    const ties = { sections: 0, archived: 0 };
    fc.assert(
      fc.property(fc.array(fc.tuple(stateOpArb, fc.nat(3)), { minLength: 15, maxLength: 45, size: "max" }), (steps) => {
        const world = stateWorld();
        for (const [op, roll] of steps) stateStep(world, op, roll === 0);
        ties.sections += world.ties.sections;
        ties.archived += world.ties.archived;
      }),
      { numRuns: 300, seed: 20261012 },
    );
    expect(ties.sections).toBeGreaterThan(0);
  });

  test("a message's images captured on first read (one more line for it) change nothing the model sees, and replay the same", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(stateOpArb, fc.nat(4)), { minLength: 15, maxLength: 40, size: "max" }), (steps) => {
        const world = stateWorld();
        let captures = 0;
        for (const [op, roll] of steps) {
          stateStep(world, op);
          if (roll !== 0) continue;
          const message = world.ids.map((id) => world.store.message(id)!).find((m) => m.author.kind === "agent" && m.inline_images === undefined);
          if (!message) continue;
          const rows = JSON.stringify(world.store.listRows());
          const cursor = world.store.messageCursor(message.id);
          const image = { id: `att_${"0".repeat(25)}${captures % 10}`, path: "/p/a.png", named_path: null, name: "a.png", kind: "image" as const, sent_sha256: "a".repeat(64), size: 1, sent_at: message.created_at, sent_mtime: message.created_at, ref: "a.png", captured: "on_open" as const };
          world.store.addCapturedImages(message.id, [image]);
          captures += 1;
          expect(world.store.message(message.id)!.inline_images).toHaveLength(1);
          world.store.addCapturedImages(message.id, []);
          expect(world.store.message(message.id)!.inline_images).toHaveLength(1);
          expect(world.store.messageCursor(message.id)).toBe(cursor);
          expect(JSON.stringify(world.store.listRows())).toBe(rows);
        }
        const reopened = InboxStore.open(world.dir);
        expect(JSON.stringify(reopened.listRows())).toBe(JSON.stringify(world.store.listRows()));
        for (const id of world.ids) expect(reopened.message(id)).toEqual(world.store.message(id));
      }),
      { numRuns: 120, seed: 20261015 },
    );
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

  test("Re-ask (rule 2a): another session's question after a note, the note's questions superseded by someone else, the person's words after it", () => {
    const sectionAfter = (ops: Op[]) => {
      const world = stateWorld();
      for (const op of ops) expect(stateStep(world, op).outcome).toBe("ok");
      return world.store.listRow(world.ids[0]!)!.section;
    };
    const ask: Op = { op: "send", root: 0, body: STATE_BODIES.two, key: null, session: "ses_a" };
    const reask: Op = { op: "reask", target: 0, key: "r1" };
    expect(sectionAfter([ask, reask])).toBe("sent");
    expect(sectionAfter([ask, reask, { op: "reply", target: 0, body: STATE_BODIES.stop }])).toBe("stopped");
    expect(sectionAfter([ask, reask, { op: "supersede", target: 0, whole: true, body: STATE_BODIES.news }])).not.toBe("sent");
    expect(sectionAfter([ask, reask, { op: "personSend", target: 0, key: "s1", words: "ok", skip: false }])).toBe("sent");
    expect(sectionAfter([ask, reask, { op: "reply", target: 0, body: STATE_BODIES.news, session: "ses_a" }])).toBe("stopped");
  });

  test("Archive then Unarchive loses no message, question or pick", () => {
    fc.assert(
      fc.property(fc.array(stateOpArb, { minLength: 10, maxLength: 30, size: "max" }), (ops) => {
        const world = stateWorld();
        for (const op of ops) stateStep(world, op);
        for (const threadId of [...world.model.threads.keys()]) {
          if (world.store.message(threadId)!.resolved_at !== null) continue;
          const before = { thread: world.store.windowThread(threadId), row: world.store.listRow(threadId) };
          const target = rootIndex(world, threadId);
          stateStep(world, { op: "resolve", target, resolved: true });
          stateStep(world, { op: "resolve", target, resolved: false });
          expect({ thread: world.store.windowThread(threadId), row: world.store.listRow(threadId) }).toEqual(before);
        }
      }),
      { numRuns: 100, seed: 20261014 },
    );
  });

  test("every hand-written edge runs clean through the model", () => {
    for (const trace of HAND_TRACES) runTrace(trace.events);
  });
});

type BatchItem =
  | { kind: "op"; op: Op }
  | { kind: "batch"; action: "read" | "archive"; root: number }
  | { kind: "undo" };

const batchItemArb: fc.Arbitrary<BatchItem> = fc.oneof(
  { arbitrary: stateOpArb.map((op) => ({ kind: "op" as const, op })), weight: 8 },
  { arbitrary: fc.record({ kind: fc.constant("batch" as const), action: fc.constantFrom("read" as const, "archive" as const), root: fc.nat(1) }), weight: 2 },
  { arbitrary: fc.constant({ kind: "undo" as const }), weight: 1 },
);

interface BatchDone {
  projectId: string;
  action: "read" | "archive";
  read: string[];
  resolved: string[];
  looked?: string[];
}

function modelThreadsOf(world: StateWorld, projectId: string): ModelThread[] {
  return [...world.model.threads.values()].filter((t) => world.store.message(t.id)!.project_id === projectId);
}

function projectSnapshot(world: StateWorld, projectId: string) {
  return world.store
    .listRows({ projectId })
    .map((row) => ({ id: row.thread_id, resolved: row.resolved_at !== null, back: row.back_from_archive === true, ...readSnapshot(world, row.thread_id) }));
}

function modelSingle(world: StateWorld, op: Op, threadId: string, created: readonly string[], tick: number): void {
  const mine = created.filter((id) => world.store.message(id)!.thread_id === threadId);
  expect(world.model.apply(op, threadId, mine, world.store, tick)).toBe("ok");
}

function batchStep(world: StateWorld, item: Exclude<BatchItem, { kind: "op" }>, last: BatchDone | null): BatchDone | null {
  const tick = ++world.tick;
  world.clock.now += STATE_STEP_MS;
  world.timeOf.set(tick, world.clock.now);
  world.lastRead = null;
  const created: string[] = [];
  const stop = world.store.subscribe((line) => {
    if (line.kind === "message" && world.store.messageCursor(line.id) === line.seq) created.push(line.id);
  });
  let done: BatchDone | null = null;
  const refusesUnread = (id: string) => {
    const t = world.model.threads.get(id)!;
    return t.resolved && !world.model.agentAfter(t);
  };
  const skipRead = item.kind === "undo" && last ? new Set(last.read.filter(refusesUnread)) : new Set<string>();
  const lookedBack = item.kind === "undo" && last ? (last.looked ?? []).filter((id) => !world.model.threads.get(id)!.resolved) : [];
  const skipLooked = item.kind === "undo" && last ? (last.looked ?? []).filter((id) => !lookedBack.includes(id)) : [];
  try {
    if (item.kind === "undo") {
      if (!last) return null;
      if (last.action === "read") {
        expect(new Set(unmarkProjectRead(world.store, last.projectId, last.read, last.looked).skipped)).toEqual(new Set([...skipRead, ...skipLooked]));
      } else {
        const result = unarchiveProject(world.store, last.projectId, { resolved: last.resolved, read: last.read });
        expect(new Set(result.skipped)).toEqual(skipRead);
      }
    } else {
      const project = world.store.listProjects().find((p) => p.name === `repo${item.root}`);
      if (!project) return null;
      if (item.action === "read") done = { projectId: project.id, action: "read", resolved: [], ...markProjectRead(world.store, project.id) };
      else done = { projectId: project.id, action: "archive", ...archiveProject(world.store, project.id) };
    }
  } finally {
    stop();
  }

  if (item.kind === "undo") {
    for (const id of last!.resolved) modelSingle(world, { op: "resolve", target: 0, resolved: false }, id, created, tick);
    for (const id of last!.read) if (!skipRead.has(id)) modelSingle(world, { op: "read", target: 0, read: false }, id, created, tick);
    for (const id of lookedBack) modelSingle(world, { op: "unread", target: 0 }, id, created, tick);
  } else {
    const threads = modelThreadsOf(world, done!.projectId).filter((t) => !world.model.archived(t));
    if (item.action === "read") {
      const waits = threads.filter((t) => world.model.waits(t) && !world.model.readHolds(t)).map((t) => t.id);
      expect(new Set(done!.read)).toEqual(new Set(waits));
      const looked = threads.filter((t) => world.model.readHolds(t) && world.model.unseen(t) > 0).map((t) => t.id);
      expect(new Set(done!.looked)).toEqual(new Set(looked));
      for (const id of [...done!.read, ...looked]) modelSingle(world, { op: "read", target: 0, read: true }, id, created, tick);
    } else {
      expect(new Set(done!.resolved)).toEqual(new Set(threads.filter((t) => !t.resolved).map((t) => t.id)));
      expect(new Set(done!.read)).toEqual(new Set(threads.filter((t) => t.resolved).map((t) => t.id)));
      for (const id of done!.resolved) modelSingle(world, { op: "resolve", target: 0, resolved: true }, id, created, tick);
      for (const id of done!.read) modelSingle(world, { op: "read", target: 0, read: true }, id, created, tick);
    }
    expect(created).toEqual([]);
  }
  checkThreadState(world);
  if (done) {
    const rows = world.store.listRows({ projectId: done.projectId });
    if (done.action === "read") expect(rows.filter((r) => inboxRowOffersMarkRead(r))).toEqual([]);
    else expect(rows.filter((r) => !inboxRowArchived(r))).toEqual([]);
  }
  return done;
}

describe("the thread-state model: the project menu's batches", () => {
  test("generated histories with batches and their Undo between the steps: the store agrees with the model after every step", () => {
    let batches = 0;
    let undone = 0;
    fc.assert(
      fc.property(fc.array(batchItemArb, { minLength: 15, maxLength: 50, size: "max" }), (items) => {
        const world = stateWorld();
        let last: BatchDone | null = null;
        for (const item of items) {
          if (item.kind === "op") {
            stateStep(world, item.op);
            continue;
          }
          const done = batchStep(world, item, last);
          if (item.kind === "undo") {
            if (last) undone += 1;
            last = null;
          } else if (done) {
            last = done;
            batches += 1;
          }
        }
      }),
      { numRuns: 200, seed: 20261014 },
    );
    expect(batches).toBeGreaterThan(0);
    expect(undone).toBeGreaterThan(0);
  });

  test("a batch undone back to back gives the project back exactly as it was", () => {
    let touched = 0;
    fc.assert(
      fc.property(fc.array(stateOpArb, { minLength: 10, maxLength: 35, size: "max" }), fc.constantFrom("read" as const, "archive" as const), (ops, action) => {
        const world = stateWorld();
        for (const op of ops) stateStep(world, op);
        for (const project of world.store.listProjects()) {
          const before = projectSnapshot(world, project.id);
          const done = batchStep(world, { kind: "batch", action, root: Number(project.name.slice(4)) }, null)!;
          touched += done.read.length + done.resolved.length;
          batchStep(world, { kind: "undo" }, done);
          expect(projectSnapshot(world, project.id)).toEqual(before);
        }
      }),
      { numRuns: 100, seed: 20261016 },
    );
    expect(touched).toBeGreaterThan(0);
  });
});

type TraceEvent =
  | { type: "agent_message"; project: string; session?: string | null; reply_to: string | null; supersedes?: string[]; body: string }
  | { type: "seen" | "mark_read" | "unread" | "archive" | "unarchive" | "agent_read" | "set_aside_note"; thread: string; through?: string }
  | { type: "pick"; message: string; key: string; choice?: string; text?: string }
  | { type: "send"; message: string; words: string; skip_unanswered: boolean }
  | { type: "person_thread"; project: string; session: string; body: string }
  | { type: "delivered"; thread: string };

interface TraceDef {
  name: string;
  description: string;
  events: TraceEvent[];
}

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

function traceOp(event: TraceEvent, world: StateWorld, labels: TraceLabels, step: number): Op {
  const at = (label: string) => {
    const i = world.ids.indexOf(labels.id(label));
    if (i < 0) throw new Error(`${label} is not an agent message or a thread the person started`);
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
    case "person_thread": {
      const root = /^repo(\d)$/.exec(event.project);
      if (!root) throw new Error(`project ${event.project}: repo0 or repo1`);
      return { op: "personStart", root: Number(root[1]), key: `person-${step}`, session: event.session, body: event.body };
    }
    case "delivered":
      return { op: "deliver", target: at(event.thread) };
  }
}

function traceEventOf(op: Op, world: StateWorld, labels: TraceLabels): TraceEvent | null {
  if (op.op === "send") return { type: "agent_message", project: `repo${op.root}`, session: op.session ?? null, reply_to: null, body: op.body };
  if (op.op === "personStart") return { type: "person_thread", project: `repo${op.root}`, session: op.session, body: op.body };
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
      if (op.across === true) return null;
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
    case "deliver":
      return { type: "delivered", thread };
    case "reask":
      return null;
    case "ack":
      return { type: op.on ? "ack" : "unack", message: labels.label(target) };
  }
}

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
    counts: { waiting: waitingCount(views.exclude), unread: rows.filter((r) => r.unread).length },
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
const PERSON = (body: string, session = "ses_a", project = "repo0"): TraceEvent => ({ type: "person_thread", project, session, body });
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
    description: "Every message without reply_to starts a new thread, before an Archive, after it and after Unarchive alike.",
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
    description: "Archive closes the questions (no Mark read, no pick) and Unarchive gives back every pick; the Send sends them.",
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
  {
    name: "hand-19-person-started-thread",
    description:
      "The person starts a thread addressed to a session (Sent); its delivery moves it to Quiet; the agent's reply_to answer lands in it (New), and a look makes it Quiet. The session's message without reply_to starts a thread of its own. A second person thread waits in Sent until delivered.",
    events: [
      PERSON(PERSON_BODIES[0]),
      ON("delivered", "t1"),
      REPLY("m1", STATE_BODIES.news),
      ON("seen", "t1"),
      ROOT(STATE_BODIES.ask, "ses_a"),
      PERSON(PERSON_BODIES[1], "ses_b"),
      REPLY("m4", STATE_BODIES.ask),
      ON("mark_read", "t3"),
      ON("delivered", "t3"),
    ],
  },
];

const TRACE_SEEDS = Array.from({ length: 24 }, (_, i) => 1001 + i);

const TRACE_DIR = join(import.meta.dir, "fixtures", "thread-state", "v1");

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
    expect(InboxStore.open(store.dir.replace(/\/inbox$/, "")).listRow(m1.id)).toEqual(store.listRow(m1.id));
  });

  test("B: Mark read on a came-back thread whose reply the agent has not read returns it to Archived", () => {
    const { store, say } = knownStore();
    const m1 = say(STATE_BODIES.news);
    store.resolveThread(m1.id, true);
    const m2 = say(STATE_BODIES.ask, m1.id);
    store.sendReply(m2.id, { words: "thinking", idempotency_key: "k1" });
    store.markRead(m1.id, true);
    expect(inboxRowArchived(store.listRow(m1.id)!)).toBe(true);
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
