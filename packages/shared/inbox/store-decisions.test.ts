/**
 * Decision mode's projection in the store (approval "inbox-decision-mode",
 * brief §10): `openDecisions()` lists exactly what waits on the person, in
 * queue order, and it can never disagree with the list's sections or a
 * thread's open-questions list, because all three read core's one rule
 * (`inboxQuestionWaitsOnPerson`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { inboxQuestionWaitsOnPerson } from "@plannotator/core/inbox-questions";
import type { InboxAuthor, InboxListRow, InboxQuestion } from "@plannotator/core/inbox-types";
import { threadOpenQuestions } from "../../inbox/openQuestions";
import { inboxDecisionExcerpt, orderInboxDecisions } from "./decisions";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENTS: Extract<InboxAuthor, { kind: "agent" }>[] = [
  { kind: "agent", host: "claude-code", session: "ses_a", name: null },
  { kind: "agent", host: "codex", session: "ses_b", name: null },
  { kind: "agent", host: "pi", session: "ses_c", name: null },
];

const block = (prompt: string, extra: string[] = [], kind = "question") =>
  [`:::${kind}`, prompt, "", ...extra, ...(kind === "question" ? ["- [ ] Yes", "- [ ] No"] : []), ":::"].join("\n");

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-decisions-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  return { store, project };
}

const yes = (q: InboxQuestion) => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [q.choices[0]?.label ?? "Yes"] });

describe("openDecisions", () => {
  test("orders sessions by how blocked they are, a thread at a time, Stopped first", () => {
    const { store, project } = open();
    const [a, b, c] = AGENTS;
    store.sendMessage({ project_id: project.id, author: a!, body: `Plain.\n\n${block("A: rename the flag?")}` });
    const bMsg = store.sendMessage({
      project_id: project.id,
      author: b!,
      body: `${block("B: plain one?")}\n\n${block("B: retry on 409?", ["Stopped: the worker cannot ship without this."])}`,
    }).message;
    store.sendMessage({ project_id: project.id, author: c!, body: block("C: merge now?", ["Holds up: the release"]) });
    const decisions = store.openDecisions();
    expect(decisions.map((d) => d.question.prompt)).toEqual(["B: retry on 409?", "B: plain one?", "C: merge now?", "A: rename the flag?"]);
    const first = decisions[0]!;
    expect(first.id).toBe(`${bMsg.id}/${first.question.key}`);
    expect(first.session).toEqual({ key: "s:codex\u0000ses_b", host: "codex", session: "ses_b", name: null, wakes: false });
    expect(first.thread.section).toBe("stopped");
    expect(first.question.revision).toBe(0);
    expect(first.message.excerpt).toBeNull();
    expect(decisions.at(-1)!.message.excerpt).toBe("Plain.");
  });

  test("keeps a pick until it is sent; drops sent, replaced, set-aside, archived and re-asked questions", () => {
    const { store, project } = open();
    const [a, b] = AGENTS;
    const m1 = store.sendMessage({ project_id: project.id, author: a!, body: `${block("Q1?")}\n\n${block("Q2?")}` }).message;
    const m2 = store.sendMessage({ project_id: project.id, author: b!, body: block("Q3?") }).message;
    expect(store.openDecisions()).toHaveLength(3);
    const [q1] = store.questionsOf(m1.id);
    store.savePicks(m1.id, [{ key: q1!.key, revision: q1!.revision, answer: yes(q1!) }]);
    const picked = store.openDecisions().find((d) => d.question.key === q1!.key)!;
    expect(picked.question.state).toBe("picked");
    expect(picked.question.revision).toBe(1);
    store.sendReply(m1.id, { idempotency_key: "r1", questions: [{ key: q1!.key, revision: 1 }] });
    expect(store.openDecisions().map((d) => d.question.prompt)).toEqual(["Q2?", "Q3?"]);
    // Replaced by the agent: the old one leaves, its replacement joins.
    store.sendMessage({ project_id: project.id, author: a!, reply_to: m1.id, body: block("Q2, again?"), supersedes: [m1.id] });
    expect(store.openDecisions().map((d) => d.question.prompt).sort()).toEqual(["Q2, again?", "Q3?"]);
    // Mark read sets the thread's questions aside.
    store.markRead(m1.thread_id, true);
    expect(store.openDecisions().map((d) => d.question.prompt)).toEqual(["Q3?"]);
    // A Re-ask note that waits takes the thread out (the list puts it in Sent).
    store.sendReask(m2.id, { idempotency_key: "k1" });
    expect(store.openDecisions()).toEqual([]);
    const m3 = store.sendMessage({ project_id: project.id, author: b!, body: block("Q4?"), thread: "other" }).message;
    expect(store.openDecisions().map((d) => d.question.prompt)).toEqual(["Q4?"]);
    store.resolveThread(m3.id, true);
    expect(store.openDecisions()).toEqual([]);
  });

  test("a Re-ask note leaves out what it lists, per session and only while that session is there", () => {
    const { store, project } = open();
    const [a, b] = AGENTS;
    // A asks through a connection that wakes its session (the only kind that can be told ended).
    const m1 = store.sendMessage({ project_id: project.id, author: a!, body: block("A asks?"), wakes: true }).message;
    const m2 = store.sendMessage({ project_id: project.id, author: b!, reply_to: m1.id, body: block("B asks?") }).message;
    expect(store.openDecisions().map((d) => d.question.prompt)).toEqual(["A asks?", "B asks?"]);
    // The person asks A to ask again: A's question is about to be asked again, B's still waits here.
    store.sendReask(m1.id, { idempotency_key: "k1" });
    expect(store.listRow(m1.thread_id)!.reask_pending).toBe(false);
    expect(store.openDecisions().map((d) => d.question.prompt)).toEqual(["B asks?"]);
    // Bounded: once A's session has ended (presence, with its grace), nobody will ask again, so its question is back.
    store.setDeliveryPresence({ connection: () => null, askerLive: (session) => session !== a!.session });
    expect(store.openDecisions().map((d) => d.question.prompt).sort()).toEqual(["A asks?", "B asks?"]);
    store.setDeliveryPresence(null);
    // A writes again: its note no longer waits, and what it still has open comes back.
    store.sendMessage({ project_id: project.id, author: a!, reply_to: m2.id, body: "Looking at it." });
    expect(store.openDecisions().map((d) => d.question.prompt).sort()).toEqual(["A asks?", "B asks?"]);
  });

  test("an MCP-only agent's Re-ask note waits until it writes again, whatever presence says (it may be in wait_for_reply)", () => {
    const { store, project } = open();
    const [a] = AGENTS;
    // No `wakes`: an agent that reads the Inbox through MCP. Its session is never told ended.
    const m1 = store.sendMessage({ project_id: project.id, author: a!, body: block("A asks?") }).message;
    store.sendReask(m1.id, { idempotency_key: "k1" });
    expect(store.openDecisions()).toEqual([]);
    store.setDeliveryPresence({ connection: () => null, askerLive: () => false });
    expect(store.openDecisions()).toEqual([]);
    store.setDeliveryPresence(null);
    // It writes again: the note no longer waits.
    store.sendMessage({ project_id: project.id, author: a!, reply_to: m1.id, body: "Back on it." });
    expect(store.openDecisions().map((d) => d.question.prompt)).toEqual(["A asks?"]);
  });

  test("with unsentOnly (decision mode), a pick that raced a Send (same revision, read before it) never reopens the sent question", () => {
    const { store, project } = open();
    const [a] = AGENTS;
    const m = store.sendMessage({ project_id: project.id, author: a!, body: block("Ship it?") }).message;
    const q0 = store.questionsOf(m.id)[0]!;
    const picked = store.savePicks(m.id, [{ key: q0.key, revision: 0, answer: yes(q0) }])[0]!;
    // The window read revision 1, then a Send took it (sent_revision 1, revision still 1).
    store.sendReply(m.id, { idempotency_key: "r1", questions: [{ key: q0.key, revision: picked.revision }] });
    expect(store.questionsOf(m.id)[0]!.state).toBe("sent");
    for (const answer of [{ ...yes(q0), selected: ["No"] }, null]) {
      let code: string | null = null;
      try {
        store.savePicks(m.id, [{ key: q0.key, revision: picked.revision, answer }], { unsentOnly: true });
      } catch (error) {
        code = error instanceof InboxError ? error.code : "other";
      }
      expect(code).toBe("question_already_sent");
      expect(store.questionsOf(m.id)[0]!.state).toBe("sent");
      expect(store.questionsOf(m.id)[0]!.answer?.selected).toEqual(["Yes"]);
    }
    expect(store.openDecisions()).toHaveLength(0);
    // Without it (the thread, a phone) a sent question takes a pick again, as the thread-state model has it.
    store.savePicks(m.id, [{ key: q0.key, revision: picked.revision, answer: { ...yes(q0), selected: ["No"] } }]);
    expect(store.questionsOf(m.id)[0]!.state).toBe("picked");
  });

  test("lists action items, and the message's files as references", () => {
    const { store, project } = open();
    const m = store.sendMessage({ project_id: project.id, author: AGENTS[0]!, body: `Before.\n\n${block("Approve the 2FA prompt", ["Where: https://example.com"], "action")}` }).message;
    const [d] = store.openDecisions();
    expect(d!.question.kind).toBe("action");
    expect(d!.message.id).toBe(m.id);
    expect(d!.pictures).toEqual({ inline: [], attachments: [] });
    // Marked done: on its way (its Undo window), it waits on nobody.
    store.markAction(m.id, d!.question.key, { outcome: "done" });
    expect(store.openDecisions()).toEqual([]);
  });

  test("the excerpt is the prose before the first block, one line, cut", () => {
    expect(inboxDecisionExcerpt("Hello **there**.\n\n![shot](a.png) See [the plan](x.md).\n\n:::question\nQ?\n:::")).toBe("Hello **there**. See the plan.");
    expect(inboxDecisionExcerpt(":::question\nQ?\n:::")).toBeNull();
    expect(inboxDecisionExcerpt(`${"word ".repeat(200)}\n:::action\nDo\n:::`)!.length).toBeLessThanOrEqual(280);
    expect(orderInboxDecisions([])).toEqual([]);
  });
});

// ─────────────────── The Decide count agrees with the list and the popover ───────────────────

type Op =
  | { op: "send"; agent: number; kind: "plain" | "stopped" | "holds" | "action" | "multi"; into: number | null; named: boolean }
  | { op: "pick"; at: number }
  | { op: "unpick"; at: number }
  | { op: "reply"; at: number }
  | { op: "read"; at: number; on: boolean }
  | { op: "resolve"; at: number; on: boolean }
  | { op: "supersede"; at: number }
  | { op: "reask"; at: number }
  | { op: "act"; at: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant("send" as const),
    agent: fc.nat(2),
    kind: fc.constantFrom("plain", "stopped", "holds", "action", "multi"),
    into: fc.option(fc.nat(20), { nil: null }),
    named: fc.boolean(),
  }),
  fc.record({ op: fc.constant("pick" as const), at: fc.nat(40) }),
  fc.record({ op: fc.constant("unpick" as const), at: fc.nat(40) }),
  fc.record({ op: fc.constant("reply" as const), at: fc.nat(40) }),
  fc.record({ op: fc.constant("read" as const), at: fc.nat(20), on: fc.boolean() }),
  fc.record({ op: fc.constant("resolve" as const), at: fc.nat(20), on: fc.boolean() }),
  fc.record({ op: fc.constant("supersede" as const), at: fc.nat(40) }),
  fc.record({ op: fc.constant("reask" as const), at: fc.nat(20) }),
  fc.record({ op: fc.constant("act" as const), at: fc.nat(40) }),
);

/** What the list says waits on the person: the rows it places in Stopped, Holding and Waiting, plus "Answered, not sent". */
/**
 * What the list says waits, less what a waiting Re-ask note lists and is still
 * open: the agent is about to ask those again, so decision mode leaves them
 * out (per note, so per session; the list keeps counting them in its row).
 */
function listCount(store: InboxStore, rows: readonly InboxListRow[]): number {
  let n = 0;
  for (const row of rows) {
    // Every open question listed (the list puts it in Sent): only what the person picked since waits (for a Send).
    if (row.reask_pending === true) {
      n += row.questions.picked;
      continue;
    }
    const waits = row.section === "stopped" || row.section === "holding" || row.section === "waiting" || row.answered_not_sent;
    if (!waits) continue;
    n += row.questions.open + row.questions.picked;
    n -= reaskedOpen(store, row.thread_id).size;
  }
  return n;
}

/** A thread's open questions a waiting Re-ask note lists. */
function reaskedOpen(store: InboxStore, threadId: string): Set<string> {
  const listed = store.reaskListedIds(threadId);
  const out = new Set<string>();
  for (const m of store.thread(threadId)?.messages ?? []) {
    for (const q of store.questionsOf(m.id)) if (q.state === "open" && listed.has(`${m.id}/${q.key}`)) out.add(`${m.id}/${q.key}`);
  }
  return out;
}

function bodyOf(kind: Op & { op: "send" }, n: number): string {
  const prompt = `Question ${n}?`;
  switch (kind.kind) {
    case "stopped":
      return block(prompt, ["Stopped: cannot go on"]);
    case "holds":
      return block(prompt, ["Holds up: the release"]);
    case "action":
      return block(`Do thing ${n}`, [], "action");
    case "multi":
      return [":::question-multi", prompt, "", "- [ ] A", "- [ ] B", ":::"].join("\n");
    default:
      return `Some prose ${n}.\n\n${block(prompt)}`;
  }
}

describe("the Decide count", () => {
  test("equals what the list's sections and each thread's open-questions list say, after any history", () => {
    let seen = 0;
    let picked = 0;
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 4, maxLength: 30 }), (ops) => {
        const { store, project } = open();
        const sent: string[] = [];
        let n = 0;
        const allWaiting = () =>
          sent.flatMap((id) => store.questionsOf(id).map((q) => ({ id, q }))).filter(({ q }) => inboxQuestionWaitsOnPerson(q));
        const pickAt = (at: number) => {
          const list = allWaiting();
          return list.length > 0 ? list[at % list.length]! : null;
        };
        for (const op of ops) {
          try {
            if (op.op === "send") {
              n += 1;
              const into = op.into !== null && sent.length > 0 ? sent[op.into % sent.length]! : null;
              const result = store.sendMessage({
                project_id: project.id,
                author: AGENTS[op.agent]!,
                body: bodyOf(op, n),
                ...(into ? { reply_to: into } : op.named ? { thread: `t${op.agent}` } : {}),
              });
              sent.push(result.message.id);
            } else if (op.op === "pick" || op.op === "unpick") {
              const hit = pickAt(op.at);
              if (!hit || hit.q.kind === "action") continue;
              store.savePicks(hit.id, [{ key: hit.q.key, revision: hit.q.revision, answer: op.op === "pick" ? yes(hit.q) : null }]);
            } else if (op.op === "reply") {
              const hit = pickAt(op.at);
              if (!hit) continue;
              const picks = store.questionsOf(hit.id).filter((q) => q.state === "picked" && q.kind !== "action");
              store.sendReply(hit.id, { idempotency_key: `r${n++}`, questions: picks.map((q) => ({ key: q.key, revision: q.revision })) });
            } else if (op.op === "read" || op.op === "resolve") {
              if (sent.length === 0) continue;
              const message = store.message(sent[op.at % sent.length]!)!;
              if (op.op === "read") store.markRead(message.thread_id, op.on);
              else store.resolveThread(message.thread_id, op.on);
            } else if (op.op === "supersede") {
              const hit = pickAt(op.at);
              if (!hit) continue;
              const m = store.message(hit.id)!;
              n += 1;
              const result = store.sendMessage({
                project_id: project.id,
                author: m.author as Extract<InboxAuthor, { kind: "agent" }>,
                reply_to: hit.id,
                body: block(`Replacement ${n}?`),
                supersedes: [`${hit.id}/${hit.q.key}`],
              });
              sent.push(result.message.id);
            } else if (op.op === "reask") {
              const hit = pickAt(op.at);
              if (!hit) continue;
              store.sendReask(hit.id, { idempotency_key: `k${n++}` });
            } else if (op.op === "act") {
              const hit = pickAt(op.at);
              if (!hit || hit.q.kind !== "action") continue;
              store.markAction(hit.id, hit.q.key, { outcome: "done" });
            }
          } catch (error) {
            if (!(error instanceof InboxError)) throw error;
          }
          const decisions = store.openDecisions();
          seen += decisions.length;
          picked += decisions.filter((d) => d.question.state === "picked").length;
          const rows = store.listRows();
          expect(decisions.length).toBe(listCount(store, rows));
          // No decision twice, and each is a waiting question of a live agent message.
          expect(new Set(decisions.map((d) => d.id)).size).toBe(decisions.length);
          for (const d of decisions) expect(inboxQuestionWaitsOnPerson(d.question)).toBe(true);
          // Per thread: its questions (not action items) are exactly what its "N open questions" list holds.
          for (const row of rows) {
            const thread = store.thread(row.thread_id)!;
            const reasked = reaskedOpen(store, row.thread_id);
            const popover = threadOpenQuestions(thread.messages).questions.map((q) => q.id).filter((id) => !reasked.has(id)).sort();
            const mine = decisions.filter((d) => d.thread.id === row.thread_id && d.question.kind !== "action").map((d) => d.id).sort();
            expect(mine).toEqual(popover);
          }
        }
      }),
      { numRuns: 120 },
    );
    // The histories reach the states that matter (not only empty Inboxes).
    expect(seen).toBeGreaterThan(100);
    expect(picked).toBeGreaterThan(5);
  });
});
