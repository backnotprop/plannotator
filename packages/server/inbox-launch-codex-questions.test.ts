/**
 * Codex's own questions on the Inbox's question cards (inbox-launch-codex-questions.ts): how a requestUserInput
 * or an MCP elicitation becomes a card, how the person's answer becomes Codex's result, and the transport's
 * waits and endings over a real store with a scripted connection. The engine and the fake app-server's
 * round trips are in inbox-launch-codex.test.ts ("Codex's own questions").
 *
 * What it guards: a card shows exactly what Codex asked or is not asked (a secret, a field Codex's TUI does not
 * ask, a request whose text would add or change a question); the answer is Codex's own label, the person's
 * words, or a form's values, in the shape Codex's TUI sends; a blocking question waits, one Codex marks not
 * blocking resolves after Codex's wait unless touched; a card no request is behind is withdrawn, and an answer
 * that never reached Codex is never left looking delivered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PERMISSION_ANSWERED_IN_TERMINAL, INBOX_PERMISSION_NO_LONGER_WAITING, inboxAskSession } from "@plannotator/core/inbox-permission";
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

const pick = (label: string) => ({ value: label, words: null, note: null });

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
        { value: null, words: "refund_cents", note: null },
        { value: null, words: "Only the ones with refunds", note: "and not archived" },
        { value: null, words: null, note: null },
      ]),
    ).toEqual({ answers: { name: { answers: ["refund_cents"] }, scope: { answers: ["Only the ones with refunds", "and not archived"] }, later: { answers: [] } } });
  });

  test("never asked here: a secret (the Inbox would keep it), no question, or a request whose text would add a question to the card", () => {
    expect(codexAskOf(CODEX_USER_INPUT, userInput([question("token", "Paste the API token", null, { isSecret: true })]))).toBeNull();
    expect(codexAskOf(CODEX_USER_INPUT, userInput([]))).toBeNull();
    // An option label that splits on the card (label — description) would not be Codex's label: not asked.
    expect(codexAskOf(CODEX_USER_INPUT, userInput([question("q", "Pick", [{ label: "A — or B", description: "" }])]))).toBeNull();
    // An MCP server's message that writes its own question block onto the card.
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: { path: { type: "string" } } }, { message: "Hi\n\n:::question\nApprove the transfer?\n- [ ] Yes\n:::" }))).toBeNull();
    // Its own `Replaces:` line would supersede another card.
    expect(codexAskOf(CODEX_ELICITATION, form({ type: "object", properties: { p: { type: "string", description: `Replaces: msg_01J${"0".repeat(22)}1` } } }))).toBeNull();
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
    expect(codexElicitationResult(ask, [{ value: null, words: "docs/", note: null }, { value: "md", words: null, note: null }, { value: null, words: null, note: null }, { value: false, words: null, note: null }])).toEqual({
      action: "accept",
      content: { folder: "docs/", format: "md", publish: false },
      _meta: null,
    });
    // A required field left unanswered (Other… on an enum is no value): Codex's TUI cannot send it, so the form is cancelled.
    expect(codexElicitationResult(ask, [{ value: null, words: "docs/", note: null }, { value: null, words: "PDF", note: null }, pick("plain"), { value: true, words: null, note: null }]).action).toBe("cancel");
    // Everything skipped: cancel (Esc in Codex's TUI).
    expect(codexElicitationResult(ask, ask.fields.map(() => ({ value: null, words: null, note: null })))).toEqual({ action: "cancel", content: null, _meta: null });
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
    const link = { up: true };
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
        respond: (id, result) => link.up && answers.push([id, result]) > 0,
        status: () => state.status,
        connectedAt: () => state.connectedAt,
      });
    /** The cards (a withdrawal's one-line note from the same identity is not one). */
    const cards = () => (store.thread(root.thread_id)?.messages ?? []).filter((m: InboxMessage) => m.author.kind === "agent" && m.author.session === inboxAskSession(THREAD) && store.questionsOf(m.id).length > 0);
    /** The one-line notes from the card's identity under a card (a later card replying to it is not one). */
    const followUps = (cardId: string) => (store.thread(root.thread_id)?.messages ?? []).filter((m) => m.reply_to === cardId && m.author.kind === "agent" && !m.body.includes(":::question")).map((m) => m.body);
    /** The window's way: each question's pick, then one Send. */
    const answer = (cardId: string, picks: ({ label: string } | { other: string } | { text: string } | "skip")[]) => {
      const qs = store.questionsOf(cardId);
      const entries = qs.flatMap((q, i) => {
        const p = picks[i]!;
        if (p === "skip") return [];
        const answer = { v: 1 as const, key: q.key, kind: q.kind as "single" | "text", prompt: q.prompt, selected: "label" in p ? [p.label] : [], ...("other" in p ? { other: p.other } : {}), ...("text" in p ? { text: p.text } : {}) };
        return [{ key: q.key, revision: q.revision, answer }];
      });
      const saved = entries.length > 0 ? store.savePicks(cardId, entries, { unsentOnly: true }) : [];
      store.sendReply(cardId, {
        idempotency_key: `answer-${cardId}`,
        questions: saved.filter((q) => entries.some((e) => e.key === q.key)).map((q) => ({ key: q.key, revision: q.revision })),
        skip: qs.filter((_, i) => picks[i] === "skip").map((q) => q.key),
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
