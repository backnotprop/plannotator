/**
 * Action items (approval "inbox-next-actions"): the store's rules, on a real store in
 * a temp dir on a clock the test moves. Failures to catch: a Done sent inside
 * its Undo window, or sent twice; an Undo after it went; an action item read as a
 * question by picks, skips or the reply's sections; Mark read leaving one open
 * or closing one already on its way; the agent's `done` reaching another
 * thread, a question, or an action item no longer open; a replay that changes any of
 * it. In the reply (approval "inbox-action-items-in-reply"): a staged Done sent
 * before the person's Send, or left out of it, or its note lost; the row
 * leaving "Stopped on you" while the Done waits; the agent's own done dropping
 * the person's note; a reload losing the staged Done.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_ACTIONS_HEADING, inboxActionKey } from "@plannotator/core/inbox-actions";
import { INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-actions-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  const clock = { now: Date.parse("2026-10-21T15:12:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  return { store, dir, clock };
}

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const UNDO_MS = 10_000;

const BODY = [
  "Release 4.2 is built.",
  "",
  ":::action",
  "Approve the production deploy on Vercel",
  "The build passed every check.",
  "Where: https://vercel.com/acme/web/deployments",
  "Stopped: release 4.2 waits on it",
  "Watching: the deployment",
  ":::",
  "",
  ":::question",
  "Announce it in #releases?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

function setup(dir?: string) {
  const opened = open(dir);
  const project = opened.store.ensureProject({ name: "web", root: "/work/web" });
  const asked = opened.store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
  const all = opened.store.questionsOf(asked.id);
  const action = all.find((q) => q.kind === "action")!;
  const question = all.find((q) => q.kind !== "action")!;
  return { ...opened, project, asked, action, question };
}

const pickYes = (store: InboxStore, messageId: string, q: InboxQuestion) =>
  store.savePicks(messageId, [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind as "single", prompt: q.prompt, selected: ["Yes"] } }]);

const rowOf = (store: InboxStore, threadId: string) => store.listRows().find((r) => r.thread_id === threadId)!;
const actionOf = (store: InboxStore, messageId: string): InboxQuestion => store.questionsOf(messageId).find((q) => q.kind === "action")!;

describe("a :::action block becomes an action item record", () => {
  test("kept as a question record of kind action, numbered on its own; the thread is Stopped on you and its row counts an action item", () => {
    const { store, asked, action, question } = setup();
    expect(action).toMatchObject({
      key: inboxActionKey("Approve the production deploy on Vercel"),
      kind: "action",
      position: 0,
      state: "open",
      stopped: "release 4.2 waits on it",
      context: "The build passed every check.",
      action: { where: "vercel.com", where_url: "https://vercel.com/acme/web/deployments", run: null, watching: "the deployment" },
      action_result: null,
    });
    expect(question).toMatchObject({ kind: "single", position: 0, state: "open" });
    const row = rowOf(store, asked.thread_id);
    expect(row.section).toBe("stopped");
    expect(row.questions).toMatchObject({ open: 2, actions: 1, stopped: true });
    // The question's own subject: the first question's prompt, never the action item (only an action item and words: the first line).
    expect(row.subject).toBe("Announce it in #releases?");
  });

  test("a message of an action item alone sits in Stopped on you by its Stopped: line, and its subject is the body's first line", () => {
    const { store, project } = open();
    const p = store.ensureProject({ name: "web", root: "/work/web2" });
    void project;
    const m = store.sendMessage({ project_id: p.id, author: AGENT, body: ":::action\nTouch your YubiKey\nStopped: the signing step\n:::" }).message;
    expect(rowOf(store, m.thread_id)).toMatchObject({ section: "stopped", subject: "Touch your YubiKey", questions: { open: 1, actions: 1 } });
  });
});

describe("Done and Can't do it", () => {
  test("Done is recorded at once, nothing is sent inside the Undo window, then one reply goes with the section", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", note: "Approved." });
    expect(actionOf(store, asked.id)).toMatchObject({ state: "picked", action_result: { outcome: "done", note: "Approved.", by: "person" } });
    // Inside the window: nothing written, nothing for the agent.
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(store.pendingReplies("ses_a")).toEqual([]);
    expect(store.actionsPending()).toBe(1);
    // Waits on nobody's Send: the row is not "Answered, not sent".
    expect(rowOf(store, asked.thread_id).answered_not_sent).toBe(false);
    clock.now += UNDO_MS;
    const [reply] = store.settleActions(UNDO_MS);
    expect(reply).toBeDefined();
    expect(reply!).toMatchObject({ author: { kind: "person" }, reply_to: asked.id, action_report: [`${asked.id}/${action.key}`] });
    expect(reply!.body.startsWith("Did 1 action item.\n\n## Action items you asked for\n\n1 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nDone, ")).toBe(true);
    // The question of the same message still waits on the person: the last line names it.
    expect(reply!.body.endsWith("\nNote: Approved.\n\nStill open: Q1. Announce it in #releases? — the person will answer it in the Inbox; don't ask again.")).toBe(true);
    expect(reply!.body).not.toContain(INBOX_ACTIONS_HEADING.toUpperCase());
    expect(actionOf(store, asked.id)).toMatchObject({ state: "sent", sent_reply_id: reply!.id });
    // The reply machinery hands it to the asking session, once.
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([reply!.id]);
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(store.actionsPending()).toBe(0);
    // Sent: no Undo, no second Done.
    expect(() => store.markAction(asked.id, action.key, { outcome: null })).toThrow(InboxError);
    expect(() => store.markAction(asked.id, action.key, { outcome: "done" })).toThrow(/already sent/);
    // The question in the same message is still open: the row is in Sent while the reply is the last message.
    expect(rowOf(store, asked.thread_id).section).toBe("waiting");
  });

  test("Undo inside the window takes it back with nothing sent; Can't do it needs a reason and goes word for word", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done" });
    store.markAction(asked.id, action.key, { outcome: null });
    expect(actionOf(store, asked.id)).toMatchObject({ state: "open", action_result: null });
    clock.now += UNDO_MS;
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(() => store.markAction(asked.id, action.key, { outcome: "cant" })).toThrow(/say why/);
    store.markAction(asked.id, action.key, { outcome: "cant", note: "I'm not in the acme team; ask Dana." });
    clock.now += UNDO_MS;
    const [reply] = store.settleActions(UNDO_MS);
    expect(reply!.body).toBe(
      "Couldn't do 1 action item.\n\n## Action items you asked for\n\n0 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nCan't do it: I'm not in the acme team; ask Dana.\n\nStill open: Q1. Announce it in #releases? — the person will answer it in the Inbox; don't ask again.",
    );
  });

  test("an action item is never a question: picks, Sends and skips that name it are refused, and a reply's sections leave it out", () => {
    const { store, asked, action, question } = setup();
    expect(() => store.savePicks(asked.id, [{ key: action.key, revision: 0, answer: { v: 1, key: action.key, kind: "single", prompt: action.prompt, selected: [] } as never }])).toThrow(/is an action item/);
    expect(() => store.sendReply(asked.id, { idempotency_key: "k1", words: "", skip: [action.key] })).toThrow(/is an action item/);
    expect(() => store.markAction(asked.id, question.key, { outcome: "done" })).toThrow(/is a question/);
    const { reply } = store.sendReply(asked.id, { idempotency_key: "k2", words: "Looking now." });
    expect(reply.body).toBe("Looking now.\n\nNo question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.");
    expect(actionOf(store, asked.id).state).toBe("open");
  });
});

describe("in the reply draft (approval \"inbox-action-items-in-reply\")", () => {
  test("a staged Done is never sent on a timer: it waits for the Send, the row stays Stopped on you and its draft counts it", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", staged: true });
    expect(actionOf(store, asked.id)).toMatchObject({ state: "picked", action_result: { outcome: "done", by: "person", staged: true } });
    clock.now += UNDO_MS * 100;
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(store.actionsPending()).toBe(0);
    expect(store.pendingReplies("ses_a")).toEqual([]);
    // Q2: the question of the same message answered too, so nothing is open; the Done keeps the row in Stopped on you.
    pickYes(store, asked.id, store.questionsOf(asked.id).find((q) => q.kind !== "action")!);
    const row = rowOf(store, asked.thread_id);
    expect(row.questions.open).toBe(0);
    expect(row.section).toBe("stopped");
    expect(row.unsent).toMatchObject({ picks: 1, done: 1 });
  });

  test("the Send carries it and its note: one first line, the section after the answers; marked sent with that reply", () => {
    const { store, asked, action, question } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", staged: true });
    store.markAction(asked.id, action.key, { outcome: "done", note: "Promoted at 3:12.", staged: true });
    pickYes(store, asked.id, store.questionsOf(asked.id).find((q) => q.key === question.key)!);
    const { reply } = store.sendReply(asked.id, {
      idempotency_key: "k1",
      words: "Go ahead.",
      questions: [{ key: question.key, revision: store.questionsOf(asked.id).find((q) => q.key === question.key)!.revision }],
      actions: [{ key: action.key }],
    });
    expect(reply.body.startsWith("Answered 1 question, did 1 action item.\n\n")).toBe(true);
    expect(reply.body).toContain("Go ahead.");
    const section = reply.body.slice(reply.body.indexOf(`## ${INBOX_ACTIONS_HEADING}`));
    expect(section.startsWith(`## ${INBOX_ACTIONS_HEADING}\n\n1 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nDone, `)).toBe(true);
    expect(section).toContain("\nNote: Promoted at 3:12.");
    // The section goes after everything else: the answers come before it.
    expect(reply.body.indexOf("## Answers to your questions")).toBeLessThan(reply.body.indexOf(`## ${INBOX_ACTIONS_HEADING}`));
    expect(actionOf(store, asked.id)).toMatchObject({ state: "sent", sent_reply_id: reply.id });
    expect(rowOf(store, asked.thread_id).section).not.toBe("stopped");
    // Sent once: a second Send naming it carries nothing of it.
    const again = store.sendReply(asked.id, { idempotency_key: "k2", words: "Thanks.", actions: [{ key: action.key }] }).reply;
    expect(again.body).not.toContain(INBOX_ACTIONS_HEADING);
  });

  test("Can't do it alone opens the reply with its own sentence; taking a Done back leaves it out", () => {
    const { store, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "cant", note: "I'm not an org owner.", staged: true });
    const { reply } = store.sendReply(asked.id, { idempotency_key: "k1", words: "", actions: [{ key: action.key }] });
    expect(reply.body.startsWith("Couldn't do 1 action item.\n\n")).toBe(true);
    // The question still open is the reply's own line; the section goes last.
    expect(reply.body.endsWith(`## ${INBOX_ACTIONS_HEADING}\n\n0 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nCan't do it: I'm not an org owner.`)).toBe(true);

    const b = setup();
    b.store.markAction(b.asked.id, b.action.key, { outcome: "done", staged: true });
    b.store.markAction(b.asked.id, b.action.key, { outcome: null, staged: true });
    expect(actionOf(b.store, b.asked.id)).toMatchObject({ state: "open", action_result: null });
    const words = b.store.sendReply(b.asked.id, { idempotency_key: "k1", words: "Later.", actions: [{ key: b.action.key }] }).reply;
    expect(words.body).not.toContain(INBOX_ACTIONS_HEADING);
    expect(actionOf(b.store, b.asked.id).state).toBe("open");
  });

  test("Q3: the agent's own done settles a staged Done; the person's note still goes with their Send", () => {
    const { store, project, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", note: "Promoted from the CLI.", staged: true });
    const ref = `${asked.id}/${action.key}`;
    const seen = store.sendMessage({ project_id: project.id, author: AGENT, body: "The deployment is Ready.", reply_to: asked.id, done: [ref] });
    expect(seen.done).toEqual([ref]);
    expect(actionOf(store, asked.id)).toMatchObject({
      state: "closed",
      action_result: { outcome: "done", by: "agent", message_id: seen.message.id, person: { outcome: "done", note: "Promoted from the CLI." } },
    });
    // The note waits in the draft.
    expect(rowOf(store, asked.thread_id).unsent).toMatchObject({ done: 1 });
    const { reply } = store.sendReply(seen.message.id, { idempotency_key: "k1", words: "", actions: [{ message_id: asked.id, key: action.key }] });
    expect(reply.body).toContain("### A1. Approve the production deploy on Vercel\nYou saw it done, ");
    expect(reply.body).toContain("\nNote: Promoted from the CLI.");
    expect(reply.body.startsWith("Did 1 action item.")).toBe(true);
    expect(actionOf(store, asked.id)).toMatchObject({ state: "closed", sent_reply_id: reply.id });
    expect(rowOf(store, asked.thread_id).unsent?.done ?? 0).toBe(0);
  });

  test("the agent's done over a staged Done with no note leaves nothing in the draft; a timed mark still refuses it", () => {
    const { store, project, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", staged: true });
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, done: [`${asked.id}/${action.key}`] });
    expect(rowOf(store, asked.thread_id).unsent?.done ?? 0).toBe(0);
    const { reply } = store.sendReply(asked.id, { idempotency_key: "k1", words: "Thanks.", actions: [{ key: action.key }] });
    expect(reply.body).not.toContain(INBOX_ACTIONS_HEADING);
  });

  test("a reload from disk keeps the staged Done and its note, still in the draft", () => {
    const first = setup();
    first.store.markAction(first.asked.id, first.action.key, { outcome: "done", note: "Approved.", staged: true });
    const again = open(first.dir);
    expect(actionOf(again.store, first.asked.id)).toMatchObject({ state: "picked", action_result: { outcome: "done", note: "Approved.", staged: true } });
    expect(rowOf(again.store, first.asked.thread_id)).toMatchObject({ section: "stopped", unsent: { done: 1 } });
    expect(again.store.settleActions(0)).toEqual([]);
  });

  test("a re-mark (a note added, Done to Can't do it) keeps the time it was first marked", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", staged: true });
    const first = actionOf(store, asked.id);
    clock.now += 60_000;
    store.markAction(asked.id, action.key, { outcome: "done", note: "Promoted.", staged: true });
    expect(actionOf(store, asked.id)).toMatchObject({ picked_at: first.picked_at, action_result: { at: first.action_result!.at, note: "Promoted." } });
    store.markAction(asked.id, action.key, { outcome: "cant", note: "No access after all.", staged: true });
    expect(actionOf(store, asked.id).action_result).toMatchObject({ outcome: "cant", at: first.action_result!.at });
  });

  test("an agent supersedes a staged Done: it is Replaced and leaves the draft; a timed mark is still refused", () => {
    const { store, project, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", note: "Approved.", staged: true });
    const ref = `${asked.id}/${action.key}`;
    const next = store.sendMessage({
      project_id: project.id,
      author: AGENT,
      reply_to: asked.id,
      body: ":::action\nApprove the 4.2.1 deploy on Vercel instead\nStopped: the hotfix waits on it\n:::",
      supersedes: [ref],
    });
    expect(actionOf(store, asked.id)).toMatchObject({ state: "superseded", superseded_by: { message_id: next.message.id } });
    expect(rowOf(store, asked.thread_id).unsent?.done ?? 0).toBe(0);
    // A Send that still names it (a window that has not caught up) has nothing left to send.
    expect(() => store.sendReply(asked.id, { idempotency_key: "k1", words: "", actions: [{ key: action.key }] })).toThrow(
      expect.objectContaining({ code: "nothing_to_send" }),
    );

    const timed = setup();
    timed.store.markAction(timed.asked.id, timed.action.key, { outcome: "done" });
    expect(() =>
      timed.store.sendMessage({ project_id: timed.project.id, author: AGENT, reply_to: timed.asked.id, body: "Never mind.", supersedes: [`${timed.asked.id}/${timed.action.key}`] }),
    ).toThrow(/the person already marked it; their answer reaches you in a few seconds/);
    // The refusal's list agrees with it: the marked item is not offered as open; the question still is.
    let refusal: InboxError | null = null;
    try {
      timed.store.sendMessage({ project_id: timed.project.id, author: AGENT, reply_to: timed.asked.id, body: "Never mind.", supersedes: [`${timed.asked.id}/${timed.action.key}`] });
    } catch (error) {
      refusal = error as InboxError;
    }
    const listed = (refusal!.details as { open_questions: { id: string }[] }).open_questions.map((q) => q.id);
    expect(listed).toEqual([`${timed.asked.id}/${timed.question.key}`]);
    expect(refusal!.message).not.toContain(`${timed.asked.id}/${timed.action.key} (`);
  });

  test("a Send of only action items that left the draft meanwhile is nothing to send, not a refusal", () => {
    const { store, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", staged: true });
    store.markAction(asked.id, action.key, { outcome: null, staged: true });
    expect(() => store.sendReply(asked.id, { idempotency_key: "k1", words: "", actions: [{ key: action.key }] })).toThrow(
      expect.objectContaining({ code: "nothing_to_send" }),
    );
    // With nothing named at all it is still the words refusal.
    expect(() => store.sendReply(asked.id, { idempotency_key: "k2", words: "" })).toThrow(expect.objectContaining({ code: "validation_error" }));
  });

  test("an item on a message the archive closed is left out of a Send, never refusing it", () => {
    const { store, project, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", staged: true });
    store.resolveThread(asked.id, true);
    const later = store.sendMessage({ project_id: project.id, author: AGENT, reply_to: asked.id, body: "One more thing: the changelog is out." }).message;
    const { reply } = store.sendReply(later.id, { idempotency_key: "k1", words: "Thanks.", actions: [{ message_id: asked.id, key: action.key }] });
    expect(reply.body).not.toContain(INBOX_ACTIONS_HEADING);
    expect(actionOf(store, asked.id).sent_reply_id).toBeNull();
  });

  test("a staged Can't do it the agent then saw done counts done, its reason labelled as theirs; the first sentence keeps their mark", () => {
    const { store, project, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "cant", note: "No access to the Vercel team.", staged: true });
    const seen = store.sendMessage({ project_id: project.id, author: AGENT, body: "Dana promoted it.", reply_to: asked.id, done: [`${asked.id}/${action.key}`] });
    expect(rowOf(store, asked.thread_id).unsent).toMatchObject({ done: 1 });
    expect(rowOf(store, asked.thread_id).unsent?.cant ?? 0).toBe(0);
    const { reply } = store.sendReply(seen.message.id, { idempotency_key: "k1", words: "", actions: [{ message_id: asked.id, key: action.key }] });
    // The person could not do it: never "Did 1 action item."; the item is done all the same.
    expect(reply.body.startsWith("Couldn't do 1 action item.\n\n")).toBe(true);
    expect(reply.body).not.toContain("Did 1 action item");
    expect(reply.body).toContain("1 of 1 done.");
    expect(reply.body).toContain("You saw it done, ");
    expect(reply.body).toContain("\nTheir reason: No access to the Vercel team.");
  });

  test("A1 never names two items: a group of another message than the replied-to one is labelled, and an open item of another message is named with it", () => {
    const { store } = open();
    const p = store.ensureProject({ name: "web", root: "/work/web" });
    const msg1 = store.sendMessage({ project_id: p.id, author: AGENT, body: ":::action\nApprove deploy\nStopped: the release\n:::" }).message;
    const msg2Body = "Next:\n\n:::action\nSign in to npm\nStopped: the publish\n:::\n\n:::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::";
    const msg2 = store.sendMessage({ project_id: p.id, author: AGENT, body: msg2Body, reply_to: msg1.id }).message;
    expect(msg2.thread_id).toBe(msg1.thread_id);
    const a1 = actionOf(store, msg1.id);
    store.markAction(msg1.id, a1.key, { outcome: "done", staged: true });
    const q = store.questionsOf(msg2.id).find((x) => x.kind !== "action")!;
    pickYes(store, msg2.id, q);
    const { reply } = store.sendReply(msg2.id, {
      idempotency_key: "k1",
      words: "",
      questions: [{ key: q.key, revision: store.questionsOf(msg2.id).find((x) => x.key === q.key)!.revision }],
      actions: [{ message_id: msg1.id, key: a1.key }],
    });
    const section = reply.body.slice(reply.body.indexOf(`## ${INBOX_ACTIONS_HEADING}`));
    // msg1's A1 under its message; msg2's own A1 (the replied-to message) still open, unqualified.
    expect(section.startsWith(`## ${INBOX_ACTIONS_HEADING}\n\n### Your message ${msg1.id}\n\n1 of 1 done.\n\n#### A1. Approve deploy\nDone, `)).toBe(true);
    expect(section.endsWith("\n\nStill open: A1. Sign in to npm — the person will do it in the Inbox; don't ask again.")).toBe(true);

    // The other way round: the reply answers msg1 and msg2's A1 is still open: named with msg2.
    const b = open();
    const pb = b.store.ensureProject({ name: "web", root: "/work/web" });
    const m1 = b.store.sendMessage({ project_id: pb.id, author: AGENT, body: ":::action\nApprove deploy\nStopped: the release\n:::" }).message;
    const m2 = b.store.sendMessage({ project_id: pb.id, author: AGENT, body: ":::action\nSign in to npm\nStopped: the publish\n:::", reply_to: m1.id }).message;
    const b1 = actionOf(b.store, m1.id);
    b.store.markAction(m1.id, b1.key, { outcome: "done", staged: true });
    const other = b.store.sendReply(m1.id, { idempotency_key: "k1", words: "", actions: [{ key: b1.key }] }).reply;
    expect(other.body).toContain(`## ${INBOX_ACTIONS_HEADING}\n\n1 of 1 done.\n\n### A1. Approve deploy\nDone, `);
    expect(other.body).not.toContain("### Your message");
    expect(other.body.endsWith(`\n\nStill open: A1 (your message ${m2.id}). Sign in to npm — the person will do it in the Inbox; don't ask again.`)).toBe(true);
  });

  test("a note save landing after the take-back never puts the mark back; on a mark still waiting it changes the note", () => {
    const { store, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", staged: true });
    store.markAction(asked.id, action.key, { outcome: "done", note: "Promoted.", staged: true, note_only: true });
    expect(actionOf(store, asked.id)).toMatchObject({ state: "picked", action_result: { outcome: "done", note: "Promoted.", staged: true } });
    // The tick's take-back and the field's blur save race: the take-back lands first.
    store.markAction(asked.id, action.key, { outcome: null, staged: true });
    store.markAction(asked.id, action.key, { outcome: "done", note: "Promoted at 3:12.", staged: true, note_only: true });
    expect(actionOf(store, asked.id)).toMatchObject({ state: "open", action_result: null });
    expect(rowOf(store, asked.thread_id).unsent?.done ?? 0).toBe(0);
    expect(() => store.markAction(asked.id, action.key, { outcome: "done", staged: true, note_only: "yes" })).toThrow(/note_only/);
  });

  test("Mark read leaves a staged Done in the draft", () => {
    const { store, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", staged: true });
    store.markRead(asked.thread_id, true);
    expect(actionOf(store, asked.id)).toMatchObject({ state: "picked", action_result: { staged: true } });
  });
});

describe("review fixes", () => {
  test("the report is not a look: an agent message landing inside the Undo window stays new (unseen, bold), the row shows the news", () => {
    const { store, clock, project, asked, action } = setup();
    store.markSeen(asked.thread_id);
    store.markAction(asked.id, action.key, { outcome: "done" });
    clock.now += 3_000;
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Also: the CDN purge finished.", reply_to: asked.id });
    clock.now += UNDO_MS;
    const [report] = store.settleActions(UNDO_MS);
    expect(report).toBeDefined();
    const row = rowOf(store, asked.thread_id);
    expect(row.unseen).toBe(1);
    expect(row.unread).toBe(true);
    // The question in the message still waits: Waiting on you. The report still rides `sent` for its delivery.
    expect(row.section).toBe("waiting");
    expect(row.sent?.at).toBe(report!.created_at);
    // A look (markSeen) is still due: the report did not record one.
    expect(store.markSeen(asked.thread_id).unseen).toBe(0);
  });

  test("with nothing else waiting, a report after unseen news puts the row in New, not Sent", () => {
    const { store, clock, project } = open();
    const p = store.ensureProject({ name: "web", root: "/work/news" });
    void project;
    const m = store.sendMessage({ project_id: p.id, author: AGENT, body: ":::action\nTouch your YubiKey\n:::" }).message;
    store.markSeen(m.thread_id);
    const key = actionOf(store, m.id).key;
    store.markAction(m.id, key, { outcome: "done" });
    store.sendMessage({ project_id: p.id, author: AGENT, body: "Signed; tagging now.", reply_to: m.id });
    clock.now += UNDO_MS;
    store.settleActions(UNDO_MS);
    expect(rowOf(store, m.thread_id)).toMatchObject({ section: "new", unseen: 1, unread: true });
  });

  test("two Done clicks seconds apart on one message go together, in one reply, once the later window passed", () => {
    const { store, clock, project } = open();
    const p = store.ensureProject({ name: "web", root: "/work/two" });
    void project;
    const m = store.sendMessage({ project_id: p.id, author: AGENT, body: ":::action\nApprove the deploy\n:::\n\n:::action\nSign in to npm\n:::" }).message;
    const [a1, a2] = store.questionsOf(m.id).filter((q) => q.kind === "action");
    store.markAction(m.id, a1!.key, { outcome: "done" });
    clock.now += 4_000;
    store.markAction(m.id, a2!.key, { outcome: "done" });
    clock.now += UNDO_MS - 4_000;
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    clock.now += 4_000;
    const replies = store.settleActions(UNDO_MS);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toContain("Did 2 action items.");
    expect(replies[0]!.body).toContain("2 of 2 done.");
    expect(replies[0]!.action_report).toHaveLength(2);
  });

  test("supersedes: one question and one action item in the new message, the old question is Replaced by the question; an action item never replaces a question", () => {
    const { store, project, asked, question } = setup();
    const next = store.sendMessage({
      project_id: project.id,
      author: AGENT,
      reply_to: asked.id,
      body: ":::question\nAnnounce it in #releases and #general?\n\n- [ ] Yes\n- [ ] No\n:::\n\n:::action\nApprove the canary\n:::",
      supersedes: [`${asked.id}/${question.key}`],
    }).message;
    const newQuestion = store.questionsOf(next.id).find((q) => q.kind !== "action")!;
    expect(store.questionsOf(asked.id).find((q) => q.key === question.key)!.superseded_by).toEqual({ message_id: next.id, key: newQuestion.key });

    const second = setup();
    const lone = second.store.sendMessage({
      project_id: second.project.id,
      author: AGENT,
      reply_to: second.asked.id,
      body: ":::action\nApprove the canary\n:::",
      supersedes: [`${second.asked.id}/${second.question.key}`],
    }).message;
    void lone;
    expect(second.store.questionsOf(second.asked.id).find((q) => q.key === second.question.key)!.superseded_by).toEqual({ message_id: lone.id, key: null });
    // An action item's own Replaces: line reaches only an action item.
    const replacesQuestion = () =>
      second.store.sendMessage({
        project_id: second.project.id,
        author: AGENT,
        reply_to: second.asked.id,
        body: `:::action\nApprove the rollout\nReplaces: ${second.asked.id}/${second.action.key}\n:::`,
      });
    const by = replacesQuestion().message;
    expect(second.store.questionsOf(second.asked.id).find((q) => q.kind === "action")!.superseded_by).toEqual({ message_id: by.id, key: expect.stringMatching(/^a-/) });
  });

  test("supersedes never takes an action item the person marked inside its Undo window: refused by its id, left out of a message-wide id; their answer still goes", () => {
    const { store, clock, project, asked, action, question } = setup();
    store.markAction(asked.id, action.key, { outcome: "done", note: "Approved." });
    const before = store.cursor();
    expect(() =>
      store.sendMessage({ project_id: project.id, author: AGENT, reply_to: asked.id, body: "Never mind the deploy.", supersedes: [`${asked.id}/${action.key}`] }),
    ).toThrow(/the person already marked it; their answer reaches you in a few seconds/);
    expect(store.cursor()).toBe(before);
    // A message-wide id supersedes the open question and leaves the marked action item alone.
    store.sendMessage({ project_id: project.id, author: AGENT, reply_to: asked.id, body: "Dropping the announcement question.", supersedes: [asked.id] });
    expect(store.questionsOf(asked.id).find((q) => q.key === question.key)!.state).toBe("superseded");
    expect(actionOf(store, asked.id)).toMatchObject({ state: "picked", superseded_by: null });
    clock.now += UNDO_MS;
    const [reply] = store.settleActions(UNDO_MS);
    expect(reply!.body).toContain("Done, ");
    expect(reply!.body).toContain("Note: Approved.");
  });

  test("Done, then Archive, then Unarchive: the Done is held back while archived and goes once the thread is open again", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done" });
    store.resolveThread(asked.id, true);
    clock.now += UNDO_MS;
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    store.resolveThread(asked.id, false);
    expect(actionOf(store, asked.id).state).toBe("picked");
    expect(store.settleActions(UNDO_MS)).toHaveLength(1);
    expect(actionOf(store, asked.id).state).toBe("sent");
  });
});

describe("Re-ask", () => {
  test("asks for the open questions and open action items together; the note says so and tells how to close an action item", () => {
    const { store, asked, action, question } = setup();
    const { reply } = store.sendReask(asked.id, { idempotency_key: "r1" });
    expect([...reply.reask!].sort()).toEqual([`${asked.id}/${action.key}`, `${asked.id}/${question.key}`].sort());
    expect(reply.body.split("\n")[0]).toBe("Please ask your 1 open question and 1 open action item in this thread again, together in one new message, so the person can answer them in one place.");
    expect(reply.body).toContain(`- ${asked.id}/${action.key}: (action item) ${action.prompt}`);
    expect(reply.body).toContain("an action item in a `:::action` block");
    expect(reply.body).toContain("- An action item you saw done yourself: put its id in `done`.");
    expect(reply.body).toContain("Until every id above is replaced, in `supersedes` or in `done`, the old ones stay open for the person.");
    // While the note waits, the row sits in Sent (rule 2a covers the action item too).
    expect(rowOf(store, asked.thread_id)).toMatchObject({ section: "sent", reask_pending: true });
  });

  test("a message with only an action item can be re-asked; one the person marked inside its Undo window is not asked again", () => {
    const { store: other, project } = open();
    const p = other.ensureProject({ name: "web", root: "/work/solo" });
    void project;
    const m = other.sendMessage({ project_id: p.id, author: AGENT, body: ":::action\nTouch your YubiKey\n:::\n\n:::action\nSign in to npm\n:::" }).message;
    const [a1, a2] = other.questionsOf(m.id);
    other.markAction(m.id, a1!.key, { outcome: "done" });
    const { reply } = other.sendReask(m.id, { idempotency_key: "r1" });
    expect(reply.reask).toEqual([`${m.id}/${a2!.key}`]);
    expect(reply.body.split("\n")[0]).toBe("Please ask your open action item in this thread again, in one new message, so the person can answer it in one place.");
    other.markAction(m.id, a2!.key, { outcome: "done" });
    expect(() => other.sendReask(m.id, { idempotency_key: "r2" })).toThrow(/No open question/);
  });

  test("a question-only note keeps its words byte for byte", () => {
    const { store: other, project } = open();
    const p = other.ensureProject({ name: "web", root: "/work/q" });
    void project;
    const m = other.sendMessage({ project_id: p.id, author: AGENT, body: ":::question\nShip it?\n\n- [ ] Yes\n- [ ] No\n:::" }).message;
    const { reply } = other.sendReask(m.id, { idempotency_key: "r1" });
    expect(reply.body).not.toContain("action item");
    expect(reply.body).toContain("put a `Replaces: <id>` line in its question block.");
  });
});

describe("Mark read", () => {
  test("sets an open action item aside like a question, the note lists it as A1, and Undo opens it again", () => {
    const { store, clock, asked } = setup();
    store.markRead(asked.thread_id, true);
    expect(actionOf(store, asked.id)).toMatchObject({ state: "closed", action_result: null });
    expect(actionOf(store, asked.id).set_aside_at).not.toBeNull();
    clock.now += UNDO_MS;
    const [note] = store.tellSetAside(asked.thread_id, UNDO_MS);
    expect(note!.body.startsWith(INBOX_SET_ASIDE_HEADING)).toBe(true);
    expect(note!.body).toContain("- Q1. Announce it in #releases?\n- A1. Approve the production deploy on Vercel");
    store.markRead(asked.thread_id, false);
    expect(actionOf(store, asked.id).state).toBe("open");
  });

  test("leaves an action item already marked Done (its Undo window running) on its way", () => {
    const { store, clock, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "done" });
    store.markRead(asked.thread_id, true);
    expect(actionOf(store, asked.id).state).toBe("picked");
    clock.now += UNDO_MS;
    expect(store.settleActions(UNDO_MS)).toHaveLength(1);
  });
});

describe("the agent marks its own action item done", () => {
  test("done closes it as seen by the agent, nothing is sent", () => {
    const { store, clock, project, asked, action } = setup();
    const ref = `${asked.id}/${action.key}`;
    const result = store.sendMessage({ project_id: project.id, author: AGENT, body: "The deployment is Ready.", reply_to: asked.id, done: [ref] });
    expect(result.done).toEqual([ref]);
    expect(result.message.done).toEqual([ref]);
    expect(actionOf(store, asked.id)).toMatchObject({ state: "closed", action_result: { outcome: "done", by: "agent", message_id: result.message.id } });
    clock.now += UNDO_MS;
    expect(store.settleActions(UNDO_MS)).toEqual([]);
    expect(store.pendingReplies("ses_a")).toEqual([]);
  });

  test("never overrides the person: an action item they marked (inside its Undo window) is refused, and their Done still goes", () => {
    const { store, clock, project, asked, action } = setup();
    store.markAction(asked.id, action.key, { outcome: "cant", note: "No access." });
    const ref = `${asked.id}/${action.key}`;
    expect(() => store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, done: [ref] })).toThrow(/the person already marked it/);
    clock.now += UNDO_MS;
    const [reply] = store.settleActions(UNDO_MS);
    expect(reply!.body).toContain("Can't do it: No access.");
  });

  test("only the session that wrote an action item marks it done", () => {
    const { store, project, asked, action } = setup();
    const other = { ...AGENT, session: "ses_other" };
    expect(() => store.sendMessage({ project_id: project.id, author: other, body: "Ready.", reply_to: asked.id, done: [`${asked.id}/${action.key}`] })).toThrow(/another session's/);
    expect(actionOf(store, asked.id).state).toBe("open");
  });

  test("a Re-ask redirected to another session (the asker ended) lets that session mark the listed action items done", () => {
    const { store, project, asked, action } = setup();
    const other = { ...AGENT, session: "ses_other" };
    const ref = `${asked.id}/${action.key}`;
    // Before any note it is not theirs.
    expect(() => store.sendMessage({ project_id: project.id, author: other, body: "Ready.", reply_to: asked.id, done: [ref] })).toThrow(/another session's/);
    const { reply } = store.sendReask(asked.id, { idempotency_key: "r1", to: { host: "claude-code", session: "ses_other" } });
    expect(reply.reask).toContain(ref);
    // A third session is still refused: the note went to ses_other only.
    expect(() =>
      store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_third" }, body: "Ready.", reply_to: reply.id, done: [ref] }),
    ).toThrow(/another session's/);
    // The message-wide id takes only what the note lists (the action item; the question is not an action item anyway).
    const result = store.sendMessage({ project_id: project.id, author: other, body: "The deployment is Ready.", reply_to: reply.id, done: [asked.id] });
    expect(result.done).toEqual([ref]);
    expect(actionOf(store, asked.id)).toMatchObject({ state: "closed", action_result: { outcome: "done", by: "agent" } });
  });

  test("a redirected note stops granting `done` once that session wrote after it", () => {
    const { store, project, asked, action } = setup();
    const other = { ...AGENT, session: "ses_other" };
    const { reply } = store.sendReask(asked.id, { idempotency_key: "r1", to: { host: "claude-code", session: "ses_other" } });
    store.sendMessage({ project_id: project.id, author: other, body: "Looking into it.", reply_to: reply.id });
    expect(() =>
      store.sendMessage({ project_id: project.id, author: other, body: "Ready.", reply_to: reply.id, done: [`${asked.id}/${action.key}`] }),
    ).toThrow(/another session's/);
  });

  test("refuses another thread, a question, an unknown id and an action item no longer open, writing nothing", () => {
    const { store, project, asked, action, question } = setup();
    const other = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: "elsewhere", thread: "other" }).message;
    const before = store.cursor();
    const attempt = (done: string[], replyTo = asked.id) => () => store.sendMessage({ project_id: project.id, author: AGENT, body: "x", reply_to: replyTo, done });
    expect(attempt([`${asked.id}/${question.key}`])).toThrow(/not an action item's id/);
    expect(attempt([`${asked.id}/a-00000000`])).toThrow(/has no action item/);
    expect(attempt([`${asked.id}/${action.key}`], other.id)).toThrow(/another thread/);
    expect(attempt(["nonsense"])).toThrow(/invalid_done|not an action item's id/);
    expect(store.cursor()).toBe(before);
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, done: [`${asked.id}/${action.key}`] });
    expect(attempt([`${asked.id}/${action.key}`])).toThrow(/not open/);
    try {
      attempt(["nonsense"])();
    } catch (error) {
      expect((error as InboxError).code).toBe("invalid_done");
    }
  });

  test("an idempotent retry with another `done` is refused", () => {
    const { store, project, asked, action } = setup();
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, idempotency_key: "k", done: [`${asked.id}/${action.key}`] });
    expect(() => store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, idempotency_key: "k" })).toThrow(/idempotency_key/);
    const replay = store.sendMessage({ project_id: project.id, author: AGENT, body: "Ready.", reply_to: asked.id, idempotency_key: "k", done: [`${asked.id}/${action.key}`] });
    expect(replay).toMatchObject({ replayed: true, done: [`${asked.id}/${action.key}`] });
  });
});

describe("a replay from disk", () => {
  test("reads every action item state back the same, a Done inside its window included", () => {
    const first = setup();
    const { store, clock, asked, action, project } = first;
    store.markAction(asked.id, action.key, { outcome: "done", note: "ok" });
    const second = store.sendMessage({ project_id: project.id, author: AGENT, body: ":::action\nSign in to npm\nRun: npm login\n:::", reply_to: asked.id }).message;
    const npm = actionOf(store, second.id);
    store.markAction(second.id, npm.key, { outcome: "cant", note: "No 2FA device here." });
    clock.now += UNDO_MS;
    store.settleActions(UNDO_MS);
    const third = store.sendMessage({ project_id: project.id, author: AGENT, body: ":::action\nTouch your key\n:::", reply_to: asked.id }).message;
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Signed.", reply_to: third.id, done: [third.id] });
    const wire = (s: InboxStore) => [asked.id, second.id, third.id].map((id) => s.questionsOf(id));
    const reopened = InboxStore.open(first.dir, { now: () => new Date(clock.now) });
    expect(wire(reopened)).toEqual(wire(store));
    expect(reopened.listRows()).toEqual(store.listRows());
  });
});
