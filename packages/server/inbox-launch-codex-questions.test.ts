/**
 * Codex's own questions on the Inbox's question cards (inbox-launch-codex-questions.ts): how a requestUserInput
 * or an MCP elicitation becomes a card, how the person's answer becomes Codex's result, and the transport's
 * waits and endings over a real store with a scripted connection. The engine and the fake app-server's
 * round trips are in inbox-launch-codex.test.ts ("Codex's own questions").
 *
 * What it guards: a card shows exactly what Codex asked or is not asked (a secret, a field Codex's TUI does not
 * ask, a request whose text would add or change a question); the answer is Codex's own label, the person's
 * words, or a form's values, in the shape Codex's TUI sends; a blocking question waits, one Codex marks not
 * blocking resolves after Codex's wait unless touched; Mark read or an archive never answers for the person;
 * words Codex's answer has no place for go on as a turn, never dropped; a card no request is behind is
 * withdrawn, and an answer that never reached Codex is never left looking delivered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PERMISSION_ANSWERED_IN_TERMINAL, INBOX_PERMISSION_NO_LONGER_WAITING, inboxAskSession } from "@plannotator/core/inbox-permission";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import {
  CODEX_ASK_NOT_TAKEN,
  CODEX_BOOLEAN_FALSE,
  CODEX_BOOLEAN_TRUE,
  CODEX_ELICITATION,
  CODEX_USER_INPUT,
  CODEX_USER_INPUT_AUTO_RESOLVE_MS,
  codexAskOf,
  codexElicitationResult,
  codexUserInputResult,
  createCodexQuestions,
} from "./inbox-launch-codex-questions";
import type { CodexThreadStatus } from "./inbox-launch-codex";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

const THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";

const pick = (label: string) => ({ value: label, words: null, note: null, forward: false });

/** One requestUserInput question as Codex sends it. */
const question = (id: string, q: string, options: { label: string; description: string }[] | null, extra: Record<string, unknown> = {}) => ({ id, header: "Approach", question: q, isOther: true, isSecret: false, options, ...extra });

const userInput = (questions: unknown[], extra: Record<string, unknown> = {}) => ({ threadId: THREAD, turnId: "t1", itemId: "call_1", questions, isBlocking: true, autoResolutionMs: null, ...extra });

const form = (requestedSchema: unknown, extra: Record<string, unknown> = {}) => ({ threadId: THREAD, turnId: "t1", serverName: "docs", mode: "form", _meta: null, message: "Where should the docs go?", requestedSchema, ...extra });

describe("a request as a card", () => {
  test("a choice question: one block, Codex's options as choices, its `(Recommended)` marker read as the card's recommendation; the answer is Codex's own label", () => {
    const ask = codexAskOf(CODEX_USER_INPUT, userInput([question("rounding", "Round refunds how?", [{ label: "Banker's rounding (Recommended)", description: "Matches the ledger" }, { label: "Half up", description: "Simpler" }])]))!;
    expect(ask.body).toContain(":::question\nRound refunds how?");
    expect(ask.body).toContain("**Approach**");
    expect(ask.fields).toHaveLength(1);
    expect(ask.fields[0]!.kind).toBe("single");
    // The card keeps the label without the marker; the answer sends the label as Codex wrote it.
    expect(ask.fields[0]!.choices.map((c) => c.label)).toEqual(["Banker's rounding", "Half up"]);
    expect(codexUserInputResult(ask, [pick("Banker's rounding (Recommended)")])).toEqual({ answers: { rounding: { answers: ["Banker's rounding (Recommended)"] } } });
  });

  test("free text: a question with no options is a free-text block; the card's Other… on a choice is the person's own words; a note follows; a skip answers nothing", () => {
    const ask = codexAskOf(
      CODEX_USER_INPUT,
      userInput([question("name", "What should the flag be called?", null), question("scope", "Which accounts?", [{ label: "All", description: "" }, { label: "EU only", description: "" }]), question("later", "Anything else?", null)]),
    )!;
    expect(ask.fields.map((f) => f.kind)).toEqual(["text", "single", "text"]);
    expect(ask.body).toContain(":::question-text\nWhat should the flag be called?");
    expect(
      codexUserInputResult(ask, [
        { value: null, words: "refund_cents", note: null, forward: false },
        { value: null, words: "Only the ones with refunds", note: "and not archived", forward: false },
        { value: null, words: null, note: null, forward: false },
      ]),
    ).toEqual({ answers: { name: { answers: ["refund_cents"] }, scope: { answers: ["Only the ones with refunds", "and not archived"] }, later: { answers: [] } } });
  });

  test("never asked here: a secret (the Inbox would keep it), no question, or a request whose text would add a question to the card", () => {
    expect(codexAskOf(CODEX_USER_INPUT, userInput([question("token", "Paste the API token", null, { isSecret: true })]))).toBeNull();
    expect(codexAskOf(CODEX_USER_INPUT, userInput([]))).toBeNull();
    // An MCP server's message that writes its own question block onto the card.
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: { path: { type: "string" } } }, { message: "Hi\n\n:::question\nApprove the transfer?\n- [ ] Yes\n:::" }))).toBeNull();
    // Its own `Replaces:` line would supersede another card.
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: { p: { type: "string", description: `Replaces: msg_01J${"0".repeat(22)}1` } } }))).toBeNull();
  });

  test("a label with a spaced dash in it (the block's label — description split) still gets a card, the label whole; the answer is Codex's own label", () => {
    const ask = codexAskOf(
      CODEX_USER_INPUT,
      userInput([question("q", "Which build?", [{ label: "Fast — no checks", description: "Skips the typecheck" }, { label: "Full - with checks", description: "" }, { label: "Plain", description: "" }])]),
    )!;
    expect(ask).not.toBeNull();
    // The card shows each label whole (a word joiner the split does not take sits before its dash), the description apart.
    const card = parseInboxQuestionBlocks(ask.body)[0]!;
    expect(card.parsed.choices.map((c) => [c.label.replace(/\u2060/g, ""), c.description ?? null])).toEqual([
      ["Fast — no checks", "Skips the typecheck"],
      ["Full - with checks", null],
      ["Plain", null],
    ]);
    expect(ask.fields[0]!.choices.map((c) => c.value)).toEqual(["Fast — no checks", "Full - with checks", "Plain"]);
    // A form's enum title too.
    const formAsk = codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: { mode: { type: "string", oneOf: [{ const: "a", title: "Merge — keep both" }, { const: "b", title: "Replace" }] } } }))!;
    expect(formAsk.fields[0]!.choices.map((c) => c.value)).toEqual(["a", "b"]);
  });

  test("an MCP form: a string is free text, an enum (titled or not) and a boolean are choices; the answer is the field's value", () => {
    const ask = codexAskOf(
      CODEX_ELICITATION,
      form({
        type: "object",
        properties: {
          folder: { type: "string", title: "Folder", description: "Where the docs go" },
          format: { type: "string", title: "Format", oneOf: [{ const: "md", title: "Markdown" }, { const: "html", title: "HTML" }] },
          tone: { type: "string", enum: ["plain", "formal"] },
          publish: { type: "boolean", title: "Publish now?" },
        },
        required: ["folder", "format"],
      }),
    )!;
    expect(ask.body.startsWith("Where should the docs go?")).toBe(true);
    expect(ask.fields.map((f) => [f.id, f.kind, f.prompt, f.choices.map((c) => c.label)])).toEqual([
      ["folder", "text", "Folder", []],
      ["format", "single", "Format", ["Markdown", "HTML"]],
      ["tone", "single", "tone", ["plain", "formal"]],
      ["publish", "single", "Publish now?", [CODEX_BOOLEAN_TRUE, CODEX_BOOLEAN_FALSE]],
    ]);
    expect(codexElicitationResult(ask, [{ value: null, words: "docs/", note: null, forward: false }, { value: "md", words: null, note: null, forward: false }, { value: null, words: null, note: null, forward: false }, { value: false, words: null, note: null, forward: false }])).toEqual({
      action: "accept",
      content: { folder: "docs/", format: "md", publish: false },
      _meta: null,
    });
    // A required field left unanswered (Other… on an enum is no value): Codex's TUI cannot send it, so the form is cancelled.
    expect(codexElicitationResult(ask, [{ value: null, words: "docs/", note: null, forward: false }, { value: null, words: "PDF", note: null, forward: false }, pick("plain"), { value: true, words: null, note: null, forward: false }]).action).toBe("cancel");
    // Everything skipped: cancel (Esc in Codex's TUI).
    expect(codexElicitationResult(ask, ask.fields.map(() => ({ value: null, words: null, note: null, forward: false })))).toEqual({ action: "cancel", content: null, _meta: null });
  });

  test("an MCP request the card does not ask: a number or a multi-select field (Codex's TUI does not either), an approval riding elicitation, a message-only form, a URL", () => {
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: { n: { type: "number" } } }))).toBeNull();
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } } }))).toBeNull();
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: {} }, { _meta: { codex_approval_kind: "mcp_tool_call" } }))).toBeNull();
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: { ok: { type: "boolean" } } }, { _meta: { codex_approval_kind: "mcp_tool_call" } }))).toBeNull();
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: {} }))).toBeNull();
    expect(codexAskOf(CODEX_ELICITATION, { threadId: THREAD, turnId: "t1", serverName: "docs", mode: "url", message: "Sign in", url: "https://x", elicitationId: "e1" })).toBeNull();
  });
});

describe("the transport", () => {
  function transport() {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-codex-ask-"));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = InboxStore.open(join(dir, "data"));
    const project = store.ensureProject({ name: "p", root: dir });
    const launch = { id: "lch_01J00000000000000000000001", agent: "codex" as const, session_ref: THREAD, folder: dir, scratch: false, started_at: new Date().toISOString() };
    const root = store.startPersonThread({ project_id: project.id, body: "Fix the rounding.", to: { host: "codex", session: THREAD }, idempotency_key: "send-1", launch }).message;
    const answers: [number | string, unknown][] = [];
    /** `refuse`: the requests whose answer cannot go yet (Codex takes the others). */
    const link = { up: true, refuse: new Set<number | string>() };
    const clock = { now: Date.now() };
    const state: { status: CodexThreadStatus | null; connectedAt: number | null } = { status: null, connectedAt: null };
    const make = () =>
      createCodexQuestions({
        store,
        launchDir: () => dir,
        roots: () => [store.message(root.id)!],
        rootOf: () => store.message(root.id)!,
        displayFolder: (path) => path,
        host: { stateOf: () => null, readAt: () => 0 },
        onChange: () => {},
        now: () => clock.now,
        respond: (id, result) => link.up && !link.refuse.has(id) && answers.push([id, result]) > 0,
        status: () => state.status,
        connectedAt: () => state.connectedAt,
      });
    /** The cards (a withdrawal's one-line note from the same identity is not one). */
    const cards = () => (store.thread(root.thread_id)?.messages ?? []).filter((m: InboxMessage) => m.author.kind === "agent" && m.author.session === inboxAskSession(THREAD) && store.questionsOf(m.id).length > 0);
    /** The one-line notes from the card's identity under a card (a later card replying to it is not one). */
    const followUps = (cardId: string) => (store.thread(root.thread_id)?.messages ?? []).filter((m) => m.reply_to === cardId && m.author.kind === "agent" && !m.body.includes(":::question")).map((m) => m.body);
    /** The window's way: each question's pick, then one Send. */
    const answer = (cardId: string, picks: ((({ label: string } | { other: string } | { text: string }) & { note?: string }) | "skip")[], words?: string) => {
      const qs = store.questionsOf(cardId);
      const entries = qs.flatMap((q, i) => {
        const p = picks[i]!;
        if (p === "skip") return [];
        const answer = { v: 1 as const, key: q.key, kind: q.kind as "single" | "text", prompt: q.prompt, selected: "label" in p ? [p.label] : [], ...("other" in p ? { other: p.other } : {}), ...("text" in p ? { text: p.text } : {}), ...(p.note ? { note: p.note } : {}) };
        return [{ key: q.key, revision: q.revision, answer }];
      });
      const saved = entries.length > 0 ? store.savePicks(cardId, entries, { unsentOnly: true }) : [];
      store.sendReply(cardId, {
        idempotency_key: `answer-${cardId}`,
        questions: saved.filter((q) => entries.some((e) => e.key === q.key)).map((q) => ({ key: q.key, revision: q.revision })),
        skip: qs.filter((_, i) => picks[i] === "skip").map((q) => q.key),
        ...(words ? { words } : {}),
      });
    };
    return { store, root, answers, link, clock, state, make, cards, followUps, answer };
  }
  const choice = userInput([question("rounding", "Round refunds how?", [{ label: "Banker's", description: "" }, { label: "Half up", description: "" }])]);

  test("the card is the person's question, never a turn: its own `perm:ask:` identity, no wakes; a request sent again is the same card, answered on its latest id", () => {
    const t = transport();
    const q = t.make();
    expect(q.asked(4, CODEX_USER_INPUT, choice)).toBe(true);
    expect(t.cards()).toHaveLength(1);
    expect(t.cards()[0]!.author).toMatchObject({ kind: "agent", host: "codex", name: "Codex", session: `perm:ask:${THREAD}` });
    expect(t.cards()[0]!.wakes ?? false).toBe(false);
    q.connectionLost();
    q.asked(4, CODEX_USER_INPUT, choice);
    expect(t.cards()).toHaveLength(1);
    t.answer(t.cards()[0]!.id, [{ label: "Half up" }]);
    q.sweep();
    q.sweep();
    expect(t.answers).toEqual([[4, { answers: { rounding: { answers: ["Half up"] } } }]]);
    // The reply that carried it is delivered, to the card's identity (never to Codex's own session as a turn).
    const reply = t.store.message(t.store.questionsOf(t.cards()[0]!.id)[0]!.sent_reply_id!)!;
    expect(reply.delivery).toMatchObject({ host: "codex", session: `perm:ask:${THREAD}` });
    expect(t.store.pendingReplies(THREAD).map((m) => m.id)).not.toContain(reply.id);
    // An approval or another server request is not this transport's.
    expect(q.asked(5, "item/commandExecution/requestApproval", { threadId: THREAD })).toBe(false);
  });

  test("an unanswered blocking question waits as long as Codex does; one Codex marks not blocking resolves with no answers after its wait, unless the person touched it", () => {
    const t = transport();
    const q = t.make();
    q.asked(1, CODEX_USER_INPUT, choice);
    t.clock.now += 24 * 60 * 60 * 1000;
    q.sweep();
    expect(t.answers).toEqual([]);
    expect(t.store.questionsOf(t.cards()[0]!.id)[0]!.state).toBe("open");

    q.asked(2, CODEX_USER_INPUT, { ...choice, itemId: "call_2", isBlocking: false });
    const loose = t.cards()[1]!;
    t.clock.now += CODEX_USER_INPUT_AUTO_RESOLVE_MS - 1_000;
    q.sweep();
    expect(t.answers).toEqual([]);
    t.clock.now += 2_000;
    q.sweep();
    expect(t.answers).toEqual([[2, { answers: {} }]]);
    expect(t.store.questionsOf(loose.id)[0]!.state).toBe("superseded");
    expect(t.followUps(loose.id)).toEqual([INBOX_PERMISSION_NO_LONGER_WAITING]);

    // Touched (a pick saved, not sent): Codex's TUI stops its countdown, so the card keeps waiting.
    q.asked(3, CODEX_USER_INPUT, { ...choice, itemId: "call_3", isBlocking: false });
    const touched = t.cards()[2]!;
    const qq = t.store.questionsOf(touched.id)[0]!;
    t.store.savePicks(touched.id, [{ key: qq.key, revision: qq.revision, answer: { v: 1, key: qq.key, kind: "single", prompt: qq.prompt, selected: ["Banker's"] } }], { unsentOnly: true });
    t.clock.now += CODEX_USER_INPUT_AUTO_RESOLVE_MS * 2;
    q.sweep();
    expect(t.answers.filter(([id]) => id === 3)).toEqual([]);
  });

  test("a card of several questions answers Codex only once every one is sent or skipped", () => {
    const t = transport();
    const q = t.make();
    q.asked(9, CODEX_USER_INPUT, userInput([question("a", "First?", [{ label: "Yes", description: "" }, { label: "No", description: "" }]), question("b", "Second?", null)]));
    const card = t.cards()[0]!;
    const [first] = t.store.questionsOf(card.id);
    const saved = t.store.savePicks(card.id, [{ key: first!.key, revision: first!.revision, answer: { v: 1, key: first!.key, kind: "single", prompt: first!.prompt, selected: ["Yes"] } }], { unsentOnly: true });
    t.store.sendReply(card.id, { idempotency_key: "half", questions: [{ key: first!.key, revision: saved[0]!.revision }] });
    q.sweep();
    expect(t.answers).toEqual([]);
    t.store.sendReply(card.id, { idempotency_key: "rest", skip: [t.store.questionsOf(card.id)[1]!.key] });
    q.sweep();
    expect(t.answers).toEqual([[9, { answers: { a: { answers: ["Yes"] }, b: { answers: [] } } }]]);
  });

  test("the person's words are never dropped: Other on a question Codex takes no Other for, or on a form's choice, answers it as skipped, and that reply (a form's note too) goes on to the thread as its next turn", () => {
    const t = transport();
    const q = t.make();
    // isOther false: Codex's TUI offers no Other here, but the card does.
    q.asked(1, CODEX_USER_INPUT, userInput([question("rounding", "Round refunds how?", [{ label: "Banker's", description: "" }, { label: "Half up", description: "" }], { isOther: false })]));
    const card = t.cards()[0]!;
    t.answer(card.id, [{ other: "Neither: keep whole cents" }]);
    q.sweep();
    expect(t.answers).toEqual([[1, { answers: { rounding: { answers: [] } } }]]);
    const reply = t.store.message(t.store.questionsOf(card.id)[0]!.sent_reply_id!)!;
    // Addressed to Codex's thread itself and not delivered: the Inbox's wake gives it to Codex as a turn.
    expect(reply.to).toEqual({ host: "codex", session: THREAD });
    expect(reply.delivery ?? null).toBeNull();
    expect(reply.body).toContain("Neither: keep whole cents");
    expect(t.store.pendingReplies(THREAD).map((m) => m.id)).toContain(reply.id);
    // The thread that asked takes it: the wake never calls it a reply written to another session that ended.
    expect(t.store.redirectedFrom(reply)).toBeNull();
    // Never said to be lost: the turn ends, the card is not withdrawn and no note says the answer was not taken.
    q.turnEnded(THREAD);
    t.state.connectedAt = t.clock.now - 60_000;
    t.state.status = { type: "idle" };
    q.sweep();
    expect(t.followUps(card.id)).toEqual([]);

    // With isOther, the words are Codex's answer and nothing goes on as a turn.
    q.asked(2, CODEX_USER_INPUT, { ...userInput([question("scope", "Which accounts?", [{ label: "All", description: "" }])]), itemId: "call_2" });
    const open = t.cards()[1]!;
    t.answer(open.id, [{ other: "EU only" }]);
    q.sweep();
    expect(t.answers[1]).toEqual([2, { answers: { scope: { answers: ["EU only"] } } }]);
    expect(t.store.message(t.store.questionsOf(open.id)[0]!.sent_reply_id!)!.delivery).toMatchObject({ session: `perm:ask:${THREAD}` });

    // A form: Other on its choice skips that field; a note has no place in it. The rest of the form is accepted.
    q.asked(3, CODEX_ELICITATION, form({ type: "object", properties: { folder: { type: "string", title: "Folder" }, format: { type: "string", title: "Format", enum: ["md", "html"] } } }));
    const formCard = t.cards()[2]!;
    t.answer(formCard.id, [{ text: "docs/", note: "the public one" }, { other: "PDF" }]);
    q.sweep();
    expect(t.answers[2]).toEqual([3, { action: "accept", content: { folder: "docs/" }, _meta: null }]);
    const formReply = t.store.message(t.store.questionsOf(formCard.id)[0]!.sent_reply_id!)!;
    expect(formReply.to).toEqual({ host: "codex", session: THREAD });
    expect(formReply.body).toContain("the public one");
    expect(formReply.body).toContain("PDF");
  });

  test("what goes on to Codex as a turn is only what its answer could not carry: never the answers it took, never the card's word joiner; a reply's own words go on too", () => {
    const t = transport();
    const q = t.make();
    // Q1's label has a spaced dash (the card keeps it whole with a word joiner); Q2 takes no Other.
    q.asked(1, CODEX_USER_INPUT, userInput([
      question("build", "Which build?", [{ label: "Fast — no checks", description: "" }, { label: "Full", description: "" }]),
      question("rounding", "Round refunds how?", [{ label: "Banker's", description: "" }, { label: "Half up", description: "" }], { isOther: false }),
    ]));
    const card = t.cards()[0]!;
    const fast = t.store.questionsOf(card.id)[0]!.choices[0]!.label;
    expect(fast).toContain("\u2060");
    t.answer(card.id, [{ label: fast }, { other: "Neither: keep whole cents" }]);
    q.sweep();
    expect(t.answers).toEqual([[1, { answers: { build: { answers: ["Fast — no checks"] }, rounding: { answers: [] } } }]]);
    const reply = t.store.message(t.store.questionsOf(card.id)[0]!.sent_reply_id!)!;
    // The person's reply as shown (and in read_thread): every answer, no word joiner.
    expect(reply.body).toContain("Fast — no checks");
    expect(reply.body).not.toContain("\u2060");
    // The turn: only the answer Codex took as skipped.
    expect(reply.forward_body).toContain("Neither: keep whole cents");
    expect(reply.forward_body).not.toContain("Fast");
    expect(reply.forward_body).not.toContain("\u2060");

    // Answers Codex takes whole, with words of the person's own: Codex gets the answer; the turn, the words alone.
    q.asked(2, CODEX_USER_INPUT, { ...userInput([question("scope", "Which accounts?", [{ label: "All", description: "" }, { label: "EU only", description: "" }])]), itemId: "call_2" });
    const second = t.cards()[1]!;
    t.answer(second.id, [{ label: "EU only" }], "And log what you skip.");
    q.sweep();
    expect(t.answers[1]).toEqual([2, { answers: { scope: { answers: ["EU only"] } } }]);
    const withWords = t.store.message(t.store.questionsOf(second.id)[0]!.sent_reply_id!)!;
    expect(withWords.to).toEqual({ host: "codex", session: THREAD });
    expect(withWords.forward_body).toBe("And log what you skip.");

    // Words alone on a card still open: they go on now; the card stays open and Codex keeps waiting on it.
    q.asked(3, CODEX_USER_INPUT, { ...choice, itemId: "call_3" });
    const third = t.cards()[2]!;
    const wordsOnly = t.store.sendReply(third.id, { idempotency_key: "words-3", words: "Give me a minute, checking the ledger." }).reply;
    q.sweep();
    expect(t.store.message(wordsOnly.id)!.to).toEqual({ host: "codex", session: THREAD });
    expect(t.store.message(wordsOnly.id)!.forward_body).toBe("Give me a minute, checking the ledger.");
    expect(t.store.questionsOf(third.id)[0]!.state).toBe("open");
    expect(t.answers).toHaveLength(2);
  });

  test("one Send that answers two cards: Codex takes each card's answer, and the turn carries the words of both that the answers had no place for, once both are taken", () => {
    const t = transport();
    const q = t.make();
    // The older card: a question that takes no Other. The newer: a form whose choice label has a spaced dash.
    q.asked(1, CODEX_USER_INPUT, userInput([question("rounding", "Round refunds how?", [{ label: "Banker's", description: "" }, { label: "Half up", description: "" }], { isOther: false })]));
    q.asked(2, CODEX_ELICITATION, form({ type: "object", properties: { mode: { type: "string", title: "Mode", oneOf: [{ const: "merge", title: "Merge — keep both" }, { const: "replace", title: "Replace" }] } } }));
    const [older, newer] = t.cards();
    const a = t.store.questionsOf(older!.id)[0]!;
    const b = t.store.questionsOf(newer!.id)[0]!;
    const merge = b.choices[0]!.label;
    expect(merge).toContain("\u2060");
    const savedA = t.store.savePicks(older!.id, [{ key: a.key, revision: a.revision, answer: { v: 1, key: a.key, kind: "single", prompt: a.prompt, selected: [], other: "Neither, do Z" } }], { unsentOnly: true });
    const savedB = t.store.savePicks(newer!.id, [{ key: b.key, revision: b.revision, answer: { v: 1, key: b.key, kind: "single", prompt: b.prompt, selected: [merge], note: "and tag the merge" } }], { unsentOnly: true });
    // The window's Send: one reply for the session, to its newest card, answering both.
    const reply = t.store.sendReply(newer!.id, {
      idempotency_key: "both",
      questions: [
        { message_id: older!.id, key: a.key, revision: savedA[0]!.revision },
        { key: b.key, revision: savedB[0]!.revision },
      ],
      words: "Some words.",
    }).reply;
    // Codex takes the older card's answer first: the reply waits for the newer card's before it goes on.
    t.link.refuse.add(2);
    q.sweep();
    expect(t.answers).toEqual([[1, { answers: { rounding: { answers: [] } } }]]);
    expect(t.store.message(reply.id)!.to?.session).not.toBe(THREAD);
    t.link.refuse.clear();
    q.sweep();
    expect(t.answers).toEqual([
      [1, { answers: { rounding: { answers: [] } } }],
      [2, { action: "accept", content: { mode: "merge" }, _meta: null }],
    ]);
    const sent = t.store.message(reply.id)!;
    expect(sent.to).toEqual({ host: "codex", session: THREAD });
    expect(sent.delivery ?? null).toBeNull();
    // Both cards' words, and the reply's own; never the card's word joiner.
    expect(sent.forward_body).toContain("Neither, do Z");
    expect(sent.forward_body).toContain("and tag the merge");
    expect(sent.forward_body).toContain("Some words.");
    expect(sent.forward_body).not.toContain("\u2060");
    // Under Codex's own question text: never the Inbox's message ids or card lines, which Codex never saw.
    expect(sent.forward_body).toContain("Round refunds how?");
    expect(sent.forward_body).not.toContain("msg_");
    expect(sent.forward_body).not.toContain("(line");
    expect(t.followUps(older!.id)).toEqual([]);
    expect(t.followUps(newer!.id)).toEqual([]);
  });

  test("an Inbox restart while a reply waits on a card Codex has not taken: it keeps waiting; the words of that card go once Codex takes it, or the card says they were not taken", () => {
    for (const comesBack of [true, false]) {
      const t = transport();
      const q = t.make();
      q.asked(1, CODEX_USER_INPUT, { ...userInput([question("a", "Ship it?", [{ label: "Yes", description: "" }, { label: "No", description: "" }])]), itemId: "call_a" });
      const bParams = {
        ...userInput([
          question("b1", "Round how?", [{ label: "Banker's", description: "" }, { label: "Half up", description: "" }], { isOther: false }),
          question("b2", "Which accounts?", [{ label: "All", description: "" }, { label: "EU", description: "" }]),
        ]),
        itemId: "call_b",
      };
      q.asked(2, CODEX_USER_INPUT, bParams);
      const [cardA, cardB] = t.cards();
      const a = t.store.questionsOf(cardA!.id)[0]!;
      const [b1, b2] = t.store.questionsOf(cardB!.id);
      const savedA = t.store.savePicks(cardA!.id, [{ key: a.key, revision: a.revision, answer: { v: 1, key: a.key, kind: "single", prompt: a.prompt, selected: ["Yes"] } }], { unsentOnly: true });
      const savedB = t.store.savePicks(cardB!.id, [{ key: b1!.key, revision: b1!.revision, answer: { v: 1, key: b1!.key, kind: "single", prompt: b1!.prompt, selected: [], other: "B-ONE WORDS" } }], { unsentOnly: true });
      // One Send: card A, B's first question (B's second left open), and words of the person's own.
      const reply = t.store.sendReply(cardB!.id, {
        idempotency_key: "half",
        questions: [{ message_id: cardA!.id, key: a.key, revision: savedA[0]!.revision }, { key: b1!.key, revision: savedB[0]!.revision }],
        words: "Own words.",
      }).reply;
      q.sweep();
      expect(t.answers).toEqual([[1, { answers: { a: { answers: ["Yes"] } } }]]);
      const held = () => {
        const m = t.store.message(reply.id)!;
        return (m.delivery ?? null) === null && m.to?.session !== THREAD;
      };
      expect(held()).toBe(true);

      // The Inbox restarts: a new transport, nothing pending in memory. The reply still waits on card B.
      t.state.connectedAt = t.clock.now;
      t.state.status = null;
      const again = t.make();
      again.sweep();
      expect(held()).toBe(true);

      if (comesBack) {
        // Codex sends B again; the person answers its second question; Codex takes B.
        again.asked(3, CODEX_USER_INPUT, bParams);
        const savedB2 = t.store.savePicks(cardB!.id, [{ key: b2!.key, revision: b2!.revision, answer: { v: 1, key: b2!.key, kind: "single", prompt: b2!.prompt, selected: ["All"] } }], { unsentOnly: true });
        const second = t.store.sendReply(cardB!.id, { idempotency_key: "rest", questions: [{ key: b2!.key, revision: savedB2[0]!.revision }] }).reply;
        t.clock.now += 10_000;
        t.state.status = { type: "idle" };
        again.sweep();
        again.sweep();
        expect(t.answers[1]).toEqual([3, { answers: { b1: { answers: [] }, b2: { answers: ["All"] } } }]);
        const sent = t.store.message(reply.id)!;
        expect(sent.to).toEqual({ host: "codex", session: THREAD });
        expect(sent.forward_body).toContain("B-ONE WORDS");
        expect(sent.forward_body).toContain("Own words.");
        expect(sent.forward_body).not.toContain("Ship it?");
        expect(t.store.message(second.id)!.delivery).toMatchObject({ session: `perm:ask:${THREAD}` });
        expect(t.followUps(cardB!.id)).toEqual([]);
      } else {
        // B never comes back: it goes, saying its answer was not taken; the reply's own words still go on.
        t.clock.now += 10_000;
        t.state.status = { type: "idle" };
        again.sweep();
        again.sweep();
        expect(t.followUps(cardB!.id)).toContain(CODEX_ASK_NOT_TAKEN);
        const sent = t.store.message(reply.id)!;
        expect(sent.to).toEqual({ host: "codex", session: THREAD });
        expect(sent.forward_body).toBe("Own words.");
      }
      // Card A's answer reached Codex: never said not taken, however the restart's sweep reads it.
      expect(t.followUps(cardA!.id)).toEqual([]);
    }
  });

  test("a card that goes before Codex takes its answer: a reply with nothing else is never marked delivered; one with words of its own still goes on to the thread", () => {
    const t = transport();
    const q = t.make();
    q.asked(1, CODEX_USER_INPUT, choice);
    q.asked(2, CODEX_USER_INPUT, { ...choice, itemId: "call_2" });
    const [plain, worded] = t.cards();
    t.answer(plain!.id, [{ label: "Half up" }]);
    t.answer(worded!.id, [{ label: "Banker's" }], "And check the ledger.");
    t.link.refuse.add(1);
    t.link.refuse.add(2);
    q.sweep();
    q.turnEnded(THREAD);
    q.sweep();
    expect(t.answers).toEqual([]);
    const plainReply = t.store.message(t.store.questionsOf(plain!.id)[0]!.sent_reply_id!)!;
    expect(plainReply.delivery ?? null).toBeNull();
    expect(plainReply.to?.session).not.toBe(THREAD);
    expect(t.followUps(plain!.id)).toContain(CODEX_ASK_NOT_TAKEN);
    const wordedReply = t.store.message(t.store.questionsOf(worded!.id)[0]!.sent_reply_id!)!;
    expect(wordedReply.to).toEqual({ host: "codex", session: THREAD });
    expect(wordedReply.forward_body).toBe("And check the ledger.");
    expect(t.followUps(worded!.id)).toContain(CODEX_ASK_NOT_TAKEN);
    // Said not taken: a request sent again for it never takes that answer after all.
    t.link.refuse.clear();
    q.asked(3, CODEX_USER_INPUT, choice);
    q.sweep();
    expect(t.answers).toEqual([]);
  });

  test("marking the thread read never answers for the person: the card stays open and Codex keeps waiting; one the archive closed waits too, until the person answers it", () => {
    const t = transport();
    const q = t.make();
    q.asked(1, CODEX_USER_INPUT, choice);
    const card = t.cards()[0]!;
    t.store.markRead(t.root.thread_id, true);
    expect(t.store.questionsOf(card.id)[0]!.state).toBe("open");
    q.sweep();
    expect(t.answers).toEqual([]);
    // Archived: its questions read closed, unanswered. Codex still waits, as it does in Terminal.
    t.store.resolveThread(t.root.thread_id, true, "person");
    expect(t.store.questionsOf(card.id)[0]!.state).toBe("closed");
    t.clock.now += 24 * 60 * 60 * 1000;
    q.sweep();
    expect(t.answers).toEqual([]);
    t.store.resolveThread(t.root.thread_id, false, "person");
    t.answer(card.id, [{ label: "Half up" }]);
    q.sweep();
    expect(t.answers).toEqual([[1, { answers: { rounding: { answers: ["Half up"] } } }]]);
  });

  test("only Codex's own question is kept from Mark read: a normal agent's question (plannotator_inbox) in the same thread is set aside and archived exactly as before", () => {
    const t = transport();
    const q = t.make();
    q.asked(1, CODEX_USER_INPUT, choice);
    const card = t.cards()[0]!;
    const normal = t.store.sendMessage({
      project_id: t.root.project_id,
      author: { kind: "agent", host: "claude-code", session: "ses_normal" },
      body: ":::question\nShip it today?\n\n- [ ] Yes\n- [ ] No\n:::",
      reply_to: t.root.id,
    }).message;
    const normalQ = () => t.store.questionsOf(normal.id)[0]!;
    // Mark read: the normal question is closed as a skip and set aside; Codex's stays open.
    t.store.markRead(t.root.thread_id, true);
    expect(normalQ().state).toBe("closed");
    expect(normalQ().set_aside_at).toBeTruthy();
    expect(t.store.questionsOf(card.id)[0]!.state).toBe("open");
    // Its Undo reopens the normal question, as before.
    t.store.markRead(t.root.thread_id, false);
    expect(normalQ().state).toBe("open");
    // Archive closes both, and Unarchive reopens both: the store's archive is unchanged.
    t.store.resolveThread(t.root.thread_id, true, "person");
    expect([normalQ().state, t.store.questionsOf(card.id)[0]!.state]).toEqual(["closed", "closed"]);
    t.store.resolveThread(t.root.thread_id, false, "person");
    expect([normalQ().state, t.store.questionsOf(card.id)[0]!.state]).toEqual(["open", "open"]);
    q.sweep();
    expect(t.answers).toEqual([]);
  });

  test("the session goes away: settled in Codex while its turn runs is answered in Terminal; a turn that ended is no longer waiting; an answer that never went is said so, never left looking delivered", () => {
    const t = transport();
    const q = t.make();
    q.asked(1, CODEX_USER_INPUT, choice);
    const inTerminal = t.cards()[0]!;
    q.resolved(1);
    q.sweep();
    t.clock.now += 1_500;
    q.sweep();
    expect(t.followUps(inTerminal.id)).toEqual([INBOX_PERMISSION_ANSWERED_IN_TERMINAL]);

    // Settled by the turn's end (Stop): Codex says resolved, then the turn ends; the card says no longer waiting.
    q.asked(2, CODEX_USER_INPUT, { ...choice, itemId: "call_2" });
    const stopped = t.cards()[1]!;
    q.resolved(2);
    q.turnEnded(THREAD);
    expect(t.followUps(stopped.id)).toEqual([INBOX_PERMISSION_NO_LONGER_WAITING]);
    expect(t.store.questionsOf(stopped.id)[0]!.state).toBe("superseded");

    // Answered while the connection is down, then the turn ends: the answer never reached Codex.
    q.asked(3, CODEX_USER_INPUT, { ...choice, itemId: "call_3" });
    const lost = t.cards()[2]!;
    t.link.up = false;
    t.answer(lost.id, [{ label: "Banker's" }]);
    q.sweep();
    q.turnEnded(THREAD);
    expect(t.answers).toEqual([]);
    expect(t.followUps(lost.id)).toEqual([CODEX_ASK_NOT_TAKEN]);
    const reply = t.store.message(t.store.questionsOf(lost.id)[0]!.sent_reply_id!)!;
    expect(reply.delivery ?? null).toBeNull();
  });

  test("after an Inbox restart: an open card whose request Codex sends again is answerable; one no request is behind is withdrawn once the thread is no longer waiting on the person", () => {
    const t = transport();
    const before = t.make();
    before.asked(7, CODEX_USER_INPUT, choice);
    before.asked(8, CODEX_ELICITATION, form({ type: "object", properties: { folder: { type: "string" } } }));
    const [kept, orphan] = t.cards();
    // A new Inbox: nothing pending. Codex re-sends the user input (same id), not the form (its daemon dropped it).
    const after = t.make();
    t.state.connectedAt = t.clock.now;
    t.state.status = { type: "active", activeFlags: ["waitingOnUserInput"] };
    after.asked(7, CODEX_USER_INPUT, choice);
    expect(t.cards()).toHaveLength(2);
    t.clock.now += 10_000;
    after.sweep();
    // Still waiting on the person: nothing is withdrawn while its request may come again.
    expect(t.followUps(orphan!.id)).toEqual([]);
    t.state.status = { type: "active", activeFlags: [] };
    after.sweep();
    expect(t.followUps(orphan!.id)).toEqual([INBOX_PERMISSION_NO_LONGER_WAITING]);
    expect(t.store.questionsOf(kept!.id)[0]!.state).toBe("open");
    t.answer(kept!.id, [{ label: "Banker's" }]);
    after.sweep();
    expect(t.answers).toEqual([[7, { answers: { rounding: { answers: ["Banker's"] } } }]]);
  });
});
