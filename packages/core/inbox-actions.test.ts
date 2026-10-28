/**
 * The Inbox's `:::action` blocks (approval "inbox-next-actions"). Failures to
 * catch: an action item's grammar leaking into plan review's question grammar; a
 * `Stopped: no` or `Holds up: none` read as a stop; a `javascript:` Where
 * becoming a button; a code fence hiding no block; keys that move when the why
 * changes; the reply the agent gets drifting from the brief.
 */
import { describe, expect, test } from "bun:test";
import {
  checkInboxActionResult,
  composeInboxActionsReply,
  composeInboxActionsSection,
  withInboxActionsSection,
  withoutInboxActionsSection,
  inboxActionsStillOpenLine,
  inboxActionKey,
  INBOX_ACTION_EXAMPLE,
  parseInboxActionBlocks,
  parseInboxActionWhere,
  parseInboxDoneRef,
} from "./inbox-actions";
import { findQuestionBlocks, indexQuestionBlocks, parseQuestionBlock, isQuestionDirectiveKind } from "./question-block";
import { composeInboxReplyBody, composeInboxSetAsideBody, inboxQuestionState, parseInboxQuestionBlocks, parseInboxSupersedeRef, summarizeInboxQuestions } from "./inbox-questions";
import { inboxActionInDraft, inboxHasUnsent, readInboxQuestionKind, type InboxQuestion, type InboxQuestionRecord } from "./inbox-types";

const BODY = [
  "The deploy is ready.",
  "",
  INBOX_ACTION_EXAMPLE,
  "",
  ":::action",
  "Run: `npm login`",
  "Sign in to npm in your terminal",
  "The publish failed with E401.",
  "Stopped: no",
  "Holds up: none; the 4.2 publish",
  ":::",
].join("\n");

describe("parseInboxActionBlocks", () => {
  test("the first line is the action item, labelled lines are read, the rest is the why", () => {
    const [deploy, npm] = parseInboxActionBlocks(BODY);
    expect(deploy).toMatchObject({
      key: inboxActionKey("Approve the production deploy on Vercel"),
      position: 0,
      prompt: "Approve the production deploy on Vercel",
      why: 'The 4.2 build passed every check and waits under "Promote to Production". Nothing else needs changing.',
      action: {
        where: "vercel.com",
        where_url: "https://vercel.com/acme/web/deployments",
        run: null,
        watching: "the deployment; I go on by myself once it is Ready",
      },
      stopped: "release 4.2 cannot go out until it is approved",
      holds_up: [],
      startLine: 3,
      line: 4,
    });
    // A Run: line before the order is still a label; the negative-word guard holds for action items too.
    expect(npm).toMatchObject({ prompt: "Sign in to npm in your terminal", position: 1, why: "The publish failed with E401.", stopped: null, holds_up: ["the 4.2 publish"] });
    expect(npm!.action.run).toBe("npm login");
    expect(deploy!.key).toMatch(/^a-[0-9a-f]{8}$/);
  });

  test("the key follows the first line only: the why may change, a reworded action item is a new one; repeats get -2", () => {
    const a = parseInboxActionBlocks(":::action\nTouch your YubiKey\nfor the signing step\n:::")[0]!;
    const b = parseInboxActionBlocks(":::action\n**Touch your yubikey.**\nanother why\n:::")[0]!;
    expect(b.key).toBe(a.key);
    const twice = parseInboxActionBlocks(":::action\nTouch your YubiKey\n:::\n\n:::action\nTouch your YubiKey\n:::");
    expect(twice.map((x) => x.key)).toEqual([a.key, `${a.key}-2`]);
    expect(parseInboxActionBlocks(":::action\nTouch your YubiKey again\n:::")[0]!.key).not.toBe(a.key);
  });

  test("a block in a code fence, an empty block, or one with only labels is no action item", () => {
    expect(parseInboxActionBlocks("```\n:::action\nApprove it\n:::\n```")).toEqual([]);
    expect(parseInboxActionBlocks(":::action\n:::")).toEqual([]);
    expect(parseInboxActionBlocks(":::action\nWhere: https://x.test\n:::")).toEqual([]);
    expect(parseInboxActionBlocks("no blocks here")).toEqual([]);
  });

  test("Where: a link with a name, a bare URL, words; only http(s) becomes a button", () => {
    expect(parseInboxActionWhere("[Vercel](https://vercel.com/acme)")).toEqual({ where: "Vercel", where_url: "https://vercel.com/acme" });
    expect(parseInboxActionWhere("Stripe dashboard https://dashboard.stripe.com/apikeys")).toEqual({ where: "Stripe dashboard", where_url: "https://dashboard.stripe.com/apikeys" });
    expect(parseInboxActionWhere("<https://github.com/acme/web/pull/12>")).toEqual({ where: "github.com", where_url: "https://github.com/acme/web/pull/12" });
    expect(parseInboxActionWhere("the YubiKey on your desk")).toEqual({ where: "the YubiKey on your desk", where_url: null });
    expect(parseInboxActionWhere("[click](javascript:alert(1))")).toEqual({ where: "click", where_url: null });
    expect(parseInboxActionWhere("javascript:alert(1)").where_url).toBeNull();
  });

  test("Replaces: ids are read only when every token is an id; prose stays in the why", () => {
    const id = "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/a-4f2c19e0";
    const [block] = parseInboxActionBlocks(`:::action\nApprove the deploy\nReplaces: ${id}\n:::`);
    expect(block!.replaces).toEqual([id]);
    expect(block!.why).toBeNull();
    // An action item replaces only an action item: a question's id on its Replaces: line is prose.
    const [questionId] = parseInboxActionBlocks(":::action\nApprove the deploy\nReplaces: msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/q-4f2c19e0\n:::");
    expect(questionId!.replaces).toEqual([]);
    const [prose] = parseInboxActionBlocks(":::action\nApprove the deploy\nReplaces: the manual promote step\n:::");
    expect(prose!.replaces).toEqual([]);
    expect(prose!.why).toBe("Replaces: the manual promote step");
  });
});

describe("plan review's question grammar is unchanged", () => {
  test("`:::action` is not a question kind, the question reader ignores it, and question keys stay q-", () => {
    expect(isQuestionDirectiveKind("action")).toBe(false);
    expect(parseQuestionBlock("action", "Approve it")).toBeNull();
    expect(findQuestionBlocks(BODY)).toEqual([]);
    expect(parseInboxQuestionBlocks(BODY)).toEqual([]);
    const mixed = `${BODY}\n\n:::question\nShip on Friday?\n\n- [ ] Yes\n- [ ] No\n:::`;
    const questions = findQuestionBlocks(mixed);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.key).toMatch(/^q-/);
    expect(indexQuestionBlocks([{ id: "b", type: "directive", directiveKind: "action", content: "Approve it", startLine: 1 }])).toEqual([]);
  });
});

const record = (over: Partial<InboxQuestionRecord>): InboxQuestionRecord => ({
  id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/a-00000001",
  project_id: "prj_x",
  message_id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE",
  key: "a-00000001",
  position: 0,
  kind: "action",
  prompt: "Approve the production deploy on Vercel",
  parsed: { context: null, choices: [], aliases: [], recommendation: null, suggested_text: null, line: 2 },
  stopped: null,
  holds_up: [],
  asked_by_agent_id: "ses_a",
  answer: null,
  revision: 0,
  sent_revision: 0,
  picked_by: null,
  picked_at: null,
  sent_reply_id: null,
  action: { where: null, where_url: null, run: null, watching: null },
  action_result: null,
  ...over,
});

describe("an action item's state", () => {
  test("open, then picked inside the Undo window, then sent; the agent's own done closes it", () => {
    expect(inboxQuestionState(record({}), false)).toBe("open");
    const marked = record({ revision: 1, action_result: { outcome: "done", note: null, at: "2026-10-21T15:12:00.000Z", by: "person" } });
    expect(inboxQuestionState(marked, false)).toBe("picked");
    expect(inboxQuestionState({ ...marked, sent_revision: 1, sent_reply_id: "msg_x" }, false)).toBe("sent");
    expect(inboxQuestionState(record({ revision: 1, action_result: { outcome: "done", note: null, at: "x", by: "agent", message_id: "m" } }), false)).toBe("closed");
  });

  test("the row counts an open action item like a question, and says how many are action items; one in its Undo window waits on nobody", () => {
    const wire = (r: InboxQuestionRecord, state: InboxQuestion["state"]) => ({ ...r, state, orphaned: false, kind: r.kind }) as unknown as InboxQuestion;
    const summary = summarizeInboxQuestions([
      wire(record({ stopped: "release 4.2" }), "open"),
      wire(record({ kind: "single", key: "q-1" }), "open"),
      wire(record({ key: "a-2" }), "picked"),
    ]);
    expect(summary).toMatchObject({ open: 2, picked: 0, stopped: true, actions: 1 });
  });

  test("the kind is read fail-closed: a kind this build does not know is not answerable", () => {
    expect(readInboxQuestionKind("action")).toBe("action");
    expect(readInboxQuestionKind("single")).toBe("single");
    expect(readInboxQuestionKind("checklist")).toBe("unknown");
    expect(readInboxQuestionKind(undefined)).toBe("unknown");
  });
});

describe("what the agent gets", () => {
  test("the reply's section, exactly as the brief has it", () => {
    const done = record({ revision: 1, action_result: { outcome: "done", note: "Approved. I also fixed the preview env var while I was there.", at: "2026-10-21T15:12:00.000Z", by: "person" } });
    expect(composeInboxActionsReply({ reported: [done], all: [done], timeZone: "UTC" })).toBe(
      [
        "Did 1 action item.",
        "",
        "## Action items you asked for",
        "",
        "1 of 1 done.",
        "",
        "### A1. Approve the production deploy on Vercel",
        "Done, 3:12 PM.",
        "Note: Approved. I also fixed the preview env var while I was there.",
      ].join("\n"),
    );
  });

  test("Can't do it: the reason word for word; mixed outcomes count both", () => {
    const cant = record({ key: "a-2", position: 1, prompt: "Merge PR #12", revision: 1, action_result: { outcome: "cant", note: "I'm not in the acme team; ask Dana.", at: "2026-10-21T15:13:00.000Z", by: "person" } });
    const done = record({ revision: 1, action_result: { outcome: "done", note: null, at: "2026-10-21T15:12:00.000Z", by: "person" } });
    const body = composeInboxActionsReply({ reported: [cant, done], all: [done, cant], timeZone: "UTC" });
    expect(body.split("\n")[0]).toBe("Did 1 action item, couldn't do 1.");
    expect(body).toContain("1 of 2 done.");
    expect(body).toContain("### A2. Merge PR #12\nCan't do it: I'm not in the acme team; ask Dana.");
    expect(body.indexOf("### A1.")).toBeLessThan(body.indexOf("### A2."));
  });

  test("the still-open line names what of that message still waits, like the reply's still-open line", () => {
    expect(inboxActionsStillOpenLine([])).toBe("");
    expect(inboxActionsStillOpenLine([{ kind: "action", position: 1, prompt: "Approve the 2FA prompt for the npm org" }])).toBe(
      "Still open: A2. Approve the 2FA prompt for the npm org — the person will do it in the Inbox; don't ask again.",
    );
    expect(
      inboxActionsStillOpenLine([
        { kind: "action", position: 1, prompt: "Approve the 2FA prompt" },
        { kind: "question", position: 0, prompt: "Publish as latest?" },
      ]),
    ).toBe("Still open: Q1. Publish as latest?; A2. Approve the 2FA prompt — the person will answer or do them in the Inbox; don't ask again.");
    expect(inboxActionsStillOpenLine([{ kind: "question", position: 0, prompt: "Publish as latest?" }, { kind: "question", position: 1, prompt: "Tag it?" }])).toBe(
      "Still open: Q1. Publish as latest?; Q2. Tag it? — the person will answer them in the Inbox; don't ask again.",
    );
    const cant = record({ revision: 1, action_result: { outcome: "cant", note: "No key.", at: "2026-10-21T15:12:00.000Z", by: "person" } });
    const body = composeInboxActionsReply({ reported: [cant], all: [cant, record({ key: "a-2", position: 1 })], stillOpen: [{ kind: "action", position: 1, prompt: "Merge PR #12" }], timeZone: "UTC" });
    expect(body.endsWith("Can't do it: No key.\n\nStill open: A2. Merge PR #12 — the person will do it in the Inbox; don't ask again.")).toBe(true);
    expect(body).toContain("0 of 2 done.");
  });

  test("a reply's question sections never count or number an action item", () => {
    const question = record({ kind: "single", key: "q-11111111", prompt: "Ship on Friday?", parsed: { context: null, choices: [{ label: "Yes", description: null, recommended: false, settled: false }], aliases: [null], recommendation: null, suggested_text: null, line: 2 } });
    const body = composeInboxReplyBody({ questions: [], sent: [], earlier: [], words: "Thanks.", stillOpen: [question, record({})] });
    expect(body).toBe("Thanks.\n\nNo question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.");
  });

  test("Mark read's note lists action items as A1 after the questions", () => {
    expect(composeInboxSetAsideBody([record({ position: 0 }), { ...record({ kind: "single", position: 0 }), prompt: "Ship on Friday?" }])).toContain("- Q1. Ship on Friday?\n- A1. Approve the production deploy on Vercel");
  });
});

describe("in the person's reply (approval \"inbox-action-items-in-reply\")", () => {
  const AT = "2026-10-21T15:12:00.000Z";
  const wire = (r: InboxQuestionRecord, state: InboxQuestion["state"]) => ({ ...r, state, orphaned: false }) as unknown as InboxQuestion;

  test("in the draft: a staged mark not sent; the agent's done only while the person's note waits; never a timed mark", () => {
    const staged = record({ revision: 1, action_result: { outcome: "done", note: null, at: AT, by: "person", staged: true } });
    expect(inboxActionInDraft(wire(staged, "picked"))).toBe(true);
    expect(inboxActionInDraft(wire({ ...staged, sent_revision: 1 }, "sent"))).toBe(false);
    expect(inboxActionInDraft(wire(record({ revision: 1, action_result: { outcome: "done", note: null, at: AT, by: "person" } }), "picked"))).toBe(false);
    const seen = (note: string | null, sent = 0) =>
      wire(record({ revision: 2, sent_revision: sent, action_result: { outcome: "done", note: null, at: AT, by: "agent", message_id: "m", person: { outcome: "done", note, at: AT } } }), "closed");
    expect(inboxActionInDraft(seen("Rotated it too."))).toBe(true);
    expect(inboxActionInDraft(seen(null))).toBe(false);
    expect(inboxActionInDraft(seen("Rotated it too.", 2))).toBe(false);
  });

  test("a Done or Can't do it alone in the draft is unsent work (the row's Draft label, the New section)", () => {
    const none = { reply_at: null, picks: 0, comments: 0 };
    expect(inboxHasUnsent(none)).toBe(false);
    expect(inboxHasUnsent({ ...none, done: 1 })).toBe(true);
    expect(inboxHasUnsent({ ...none, cant: 1 })).toBe(true);
    expect(inboxHasUnsent({ ...none, done: 0, cant: 0 })).toBe(false);
  });

  test("the row: a staged mark keeps the item's Stopped and Holds up, and counts as staged, not open", () => {
    const summary = summarizeInboxQuestions([
      wire(record({ stopped: "release 4.2", revision: 1, action_result: { outcome: "done", note: null, at: AT, by: "person", staged: true } }), "picked"),
    ]);
    expect(summary).toMatchObject({ open: 0, staged: 1, stopped: true });
  });

  test("one first line: the action sentence joins the answers' sentence, else opens the reply; the section goes last", () => {
    const done = record({ revision: 1, action_result: { outcome: "done", note: null, at: AT, by: "person", staged: true } });
    const section = composeInboxActionsSection({ groups: [{ message_id: "m1", reported: [done], all: [done] }], timeZone: "UTC" });
    expect(withInboxActionsSection("Answered 1 question.\n\nGo ahead.\n\n## Answers to your questions\n\n### Q1. Ship?\nAnswer: Yes", section)).toBe(
      "Answered 1 question, did 1 action item.\n\nGo ahead.\n\n## Answers to your questions\n\n### Q1. Ship?\nAnswer: Yes\n\n## Action items you asked for\n\n1 of 1 done.\n\n### A1. Approve the production deploy on Vercel\nDone, 3:12 PM.",
    );
    expect(withInboxActionsSection("Answered 1 question, skipped 1.\n\n## Answers to your questions", section).split("\n")[0]).toBe("Answered 1 question, skipped 1, did 1 action item.");
    expect(withInboxActionsSection("Thanks.", section).startsWith("Did 1 action item.\n\nThanks.\n\n## Action items you asked for")).toBe(true);
    expect(withInboxActionsSection("", section)).toBe(section);
    expect(withInboxActionsSection("Thanks.", "")).toBe("Thanks.");
  });

  test("several messages: a sub-heading each; the agent's own done reads as seen with the person's note", () => {
    const a = record({ revision: 1, action_result: { outcome: "done", note: null, at: AT, by: "person", staged: true } });
    const b = record({
      id: "msg_2/a-2",
      message_id: "msg_2",
      key: "a-2",
      prompt: "Merge PR #12",
      revision: 2,
      action_result: { outcome: "done", note: null, at: "2026-10-21T15:14:00.000Z", by: "agent", message_id: "msg_3", person: { outcome: "done", note: "Squashed.\n\nKept the history.", at: AT } },
    });
    const body = composeInboxActionsSection({ groups: [{ message_id: "msg_1", reported: [a], all: [a] }, { message_id: "msg_2", reported: [b], all: [b] }], timeZone: "UTC" });
    expect(body).toBe(
      [
        "Did 2 action items.",
        "## Action items you asked for",
        "### Your message msg_1",
        "1 of 1 done.",
        "#### A1. Approve the production deploy on Vercel\nDone, 3:12 PM.",
        "### Your message msg_2",
        "1 of 1 done.",
        "#### A1. Merge PR #12\nYou saw it done, 3:14 PM.\nNote: Squashed.\nKept the history.",
      ].join("\n\n"),
    );
  });

  test("one group of another message than the replied-to one is labelled; a still-open item of another message is named with it", () => {
    const a = record({ revision: 1, action_result: { outcome: "done", note: null, at: AT, by: "person", staged: true } });
    const stillOpen = [
      { kind: "action" as const, position: 0, prompt: "Sign in to npm", message_id: "msg_9" },
      { kind: "action" as const, position: 1, prompt: "Merge", message_id: "msg_1" },
    ];
    const other = composeInboxActionsSection({ groups: [{ message_id: "msg_1", reported: [a], all: [a] }], stillOpen, replyTo: "msg_2", timeZone: "UTC" });
    expect(other.split("\n\n").slice(1, 4)).toEqual(["## Action items you asked for", "### Your message msg_1", "1 of 1 done."]);
    expect(other.endsWith("Still open: A1 (your message msg_9). Sign in to npm; A2 (your message msg_1). Merge — the person will do them in the Inbox; don't ask again.")).toBe(true);
    // The replied-to message: no label, its items first and unqualified.
    const own = composeInboxActionsSection({ groups: [{ message_id: "msg_1", reported: [a], all: [a] }], stillOpen, replyTo: "msg_1", timeZone: "UTC" });
    expect(own).not.toContain("### Your message");
    expect(own.endsWith("Still open: A2. Merge; A1 (your message msg_9). Sign in to npm — the person will do them in the Inbox; don't ask again.")).toBe(true);
  });

  test("a Can't do it the agent then saw done opens with the person's mark, not \"Did\"; it counts done in x of y", () => {
    const seen = record({ revision: 2, action_result: { outcome: "done", note: null, at: AT, by: "agent", message_id: "msg_3", person: { outcome: "cant", note: "No access.", at: AT } } });
    const body = composeInboxActionsSection({ groups: [{ message_id: "msg_1", reported: [seen], all: [seen] }], timeZone: "UTC" });
    expect(body.split("\n\n").slice(0, 3)).toEqual(["Couldn't do 1 action item.", "## Action items you asked for", "1 of 1 done."]);
    expect(body).toContain("You saw it done, 3:12 PM.\nTheir reason: No access.");
  });

  test("the window draws a sent reply without the agent-facing action sentence and section; everything else stays", () => {
    const done = record({ revision: 1, action_result: { outcome: "done", note: "Approved.", at: AT, by: "person", staged: true } });
    const section = composeInboxActionsSection({ groups: [{ message_id: "m1", reported: [done], all: [done] }], stillOpen: [{ kind: "action", position: 1, prompt: "Merge" }], timeZone: "UTC" });
    const answered = "Answered 1 question.\n\nGo ahead.\n\n## Answers to your questions\n\n### Q1. Ship?\nAnswer: Yes";
    expect(withoutInboxActionsSection(withInboxActionsSection(answered, section))).toBe(answered);
    expect(withoutInboxActionsSection(withInboxActionsSection("Thanks.", section))).toBe("Thanks.");
    expect(withoutInboxActionsSection(section)).toBe("");
    // A legacy report sent on its own (the timed path) strips the same way.
    expect(withoutInboxActionsSection(composeInboxActionsReply({ reported: [done], all: [done], timeZone: "UTC" }))).toBe("");
    // Words that only mention the heading stay.
    expect(withoutInboxActionsSection("Did you see the action items you asked for?")).toBe("Did you see the action items you asked for?");
  });
});

describe("ids", () => {
  test("done takes an action item's id; supersedes takes a question's or an action item's", () => {
    expect(parseInboxDoneRef("msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/a-4f2c19e0")).toEqual({ message_id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE", key: "a-4f2c19e0" });
    expect(parseInboxDoneRef("msg_01M5F3B7KD2WQ9XN4C8VJTR6YE")).toEqual({ message_id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE", key: null });
    expect(parseInboxDoneRef("msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/q-4f2c19e0")).toBeNull();
    expect(parseInboxSupersedeRef("msg_01M5F3B7KD2WQ9XN4C8VJTR6YE/a-4f2c19e0")).toEqual({ message_id: "msg_01M5F3B7KD2WQ9XN4C8VJTR6YE", key: "a-4f2c19e0" });
  });

  test("the person's result: Can't do it needs a reason, a note is capped, null is the Undo", () => {
    expect(checkInboxActionResult({ outcome: "done" })).toEqual({ ok: true, outcome: "done", note: null });
    expect(checkInboxActionResult({ outcome: "cant", note: "  " })).toMatchObject({ ok: false, field: "note" });
    expect(checkInboxActionResult({ outcome: "maybe" })).toMatchObject({ ok: false, field: "outcome" });
    expect(checkInboxActionResult({ outcome: null })).toEqual({ ok: true, outcome: null, note: null });
    expect(checkInboxActionResult({ outcome: "done", note: "x".repeat(2001) })).toMatchObject({ ok: false });
  });
});
