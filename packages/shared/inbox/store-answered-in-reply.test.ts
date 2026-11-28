import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_MESSAGE_FEEDBACK_TITLE } from "@plannotator/core/inbox-review";
import type { InboxAuthor, InboxMessage, InboxQuestion } from "@plannotator/core/inbox-types";
import { inboxAnsweredQuote, inboxReplyOwnWords } from "./answered-words";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Agent = Extract<InboxAuthor, { kind: "agent" }>;
const AGENT: Agent = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const OTHER: Agent = { kind: "agent", host: "codex", session: "ses_b", name: null };
const FAR: Agent = { ...AGENT, machine: "ibx_01JZ00000000000000000000S1", machine_name: "Studio" };

const block = (prompt: string, choices: string[], multi = false) => [":::question", prompt, ...(multi ? ["", "Pick all that apply."] : []), "", ...choices.map((c) => `- [ ] ${c}`), ":::"].join("\n");
const ASK = ["The new runner is up for harbor.", "", block("Which region should the new runner live in?", ["us-east-1", "eu-west-1"]), "", block("Keep the old Jenkins job as a fallback for a week?", ["Yes", "No"])].join("\n");

function setup(author: Agent = AGENT, body = ASK) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-answered-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const asked = store.sendMessage({ project_id: project.id, author, body }).message;
  const [region, jenkins] = store.questionsOf(asked.id) as [InboxQuestion, InboxQuestion];
  const state = (key: string) => store.questionsOf(asked.id).find((q) => q.key === key)!;
  /** The person replies to the asking message; the asking session gets it unless `delivered` is false. */
  const reply = (words: string, key: string, delivered = true): InboxMessage => {
    const sent = store.sendReply(asked.id, { idempotency_key: key, words, questions: [] }).reply;
    if (delivered) store.recordDelivery(sent.id, { host: "claude-code", session: "ses_a" });
    return sent;
  };
  const mark = (entries: unknown, as: Agent = author, replyTo: string = asked.id, extra: Record<string, unknown> = {}) =>
    store.sendMessage({ project_id: project.id, author: as, reply_to: replyTo, body: "Noted.", answered_in_reply: entries, ...extra });
  return { store, project, asked, region, jenkins, ref: `${asked.id}/${jenkins.key}`, regionRef: `${asked.id}/${region.key}`, state, reply, mark };
}

function refused(run: () => unknown): InboxError {
  try {
    run();
  } catch (error) {
    if (error instanceof InboxError) return error;
    throw error;
  }
  throw new Error("not refused");
}

const words = "Yep, keep Jenkins for a week, that's fine. Region I still need to think about.";

describe("answered_in_reply", () => {
  test("a plain reply in a one-agent thread, addressed to nobody in particular, counts", () => {
    const { ref, jenkins, state, reply, mark, store, asked } = setup();
    const sent = reply(words, "r1");
    const result = mark([{ question: ref, quote: "keep Jenkins for a week" }], AGENT, sent.id);
    expect(result.answered_in_reply).toEqual([ref]);
    expect(state(jenkins.key).state).toBe("answered_in_reply");
    expect(state(jenkins.key).answered_in_reply).toMatchObject({ reply_id: sent.id, quote: "keep Jenkins for a week", message_id: result.message.id });
    expect(store.listRow(asked.thread_id)!.questions.open).toBe(1);
  });

  test("an agent that reads the thread (read_thread, no wake) has the replies it read", () => {
    const { ref, jenkins, state, store, asked, mark } = setup();
    const sent = store.sendReply(asked.id, { idempotency_key: "r1", words, questions: [] }).reply;
    store.markAgentChecked(asked.thread_id, undefined, undefined, "ses_a");
    mark([{ question: ref }], AGENT, sent.id);
    expect(state(jenkins.key).state).toBe("answered_in_reply");
  });

  test("the default is the reply the agent answers, among replies that reached it; one still queued never counts", () => {
    const { ref, jenkins, state, reply, mark } = setup();
    const first = reply("Use Postgres, and keep Jenkins.", "r1");
    const queued = reply("Also rename the repo to foo.", "r2", false);
    mark([{ question: ref }], AGENT, first.id);
    expect(state(jenkins.key).answered_in_reply!.quote).toBe("Use Postgres, and keep Jenkins.");
    const other = setup();
    other.reply("Use Postgres, and keep Jenkins.", "r1");
    other.reply("Also rename the repo to foo.", "r2", false);
    other.mark([{ question: other.ref }]);
    expect(other.state(other.jenkins.key).answered_in_reply!.quote).toBe("Use Postgres, and keep Jenkins.");
    const named = setup();
    const late = named.reply("Also rename the repo to foo.", "r2", false);
    expect(refused(() => named.mark([{ question: named.ref, reply: late.id }])).message).toContain(`reply ${late.id} was not sent to you, or has not reached you yet`);
    expect(refused(() => named.mark([{ question: named.ref }])).message).toContain('no reply of the person\'s to you has reached you after it; name the reply with "reply"');
    expect(queued.id).not.toBe(first.id);
  });

  test("a reply the person sent to another agent is not the asking agent's to quote", () => {
    const { ref, store, asked, project, mark } = setup();
    const theirs = store.sendMessage({ project_id: project.id, author: OTHER, reply_to: asked.id, body: "Codex here." }).message;
    const toOther = store.sendReply(theirs.id, { idempotency_key: "r1", words: "Keep Jenkins for a week.", questions: [] }).reply;
    store.recordDelivery(toOther.id, { host: "codex", session: "ses_b" });
    expect(refused(() => mark([{ question: ref, reply: toOther.id }])).message).toContain("was not sent to you");
  });

  test("only the person's own words: text a Send appends (feedback quoting a file) is never quoted", () => {
    const body = `Keep Jenkins for a week.\n\n# ${INBOX_MESSAGE_FEEDBACK_TITLE}\n\n> rename the repo to foo`;
    expect(inboxReplyOwnWords(body).trim()).toBe("Keep Jenkins for a week.");
    expect(inboxAnsweredQuote(inboxReplyOwnWords(body), "rename the repo to foo")).toMatchObject({ ok: false });
  });

  test("a pick made on the card after the reply is never closed by those older words", () => {
    const { ref, jenkins, store, asked, reply, mark } = setup();
    const sent = reply(words, "r1");
    Bun.sleepSync(3);
    store.savePicks(asked.id, [{ key: jenkins.key, revision: 0, answer: { v: 1, key: jenkins.key, kind: "single", prompt: jenkins.prompt, selected: ["No"] } }]);
    expect(refused(() => mark([{ question: ref }], AGENT, sent.id)).message).toContain(`the person picked on the card after reply ${sent.id}`);
  });

  test("quotes are whole words from one paragraph; scripts without spaces match as written", () => {
    const said = "Keep Jenkins for a week.\n\nThe region can wait.";
    expect(inboxAnsweredQuote(said, "keep Jenk")).toMatchObject({ ok: false });
    expect(inboxAnsweredQuote(said, "Jenkins for a")).toEqual({ ok: true, quote: "Jenkins for a" });
    expect(inboxAnsweredQuote(said, "week. The region")).toMatchObject({ ok: false });
    expect(inboxAnsweredQuote(said, "K")).toMatchObject({ ok: false });
    expect(inboxAnsweredQuote(said, "...")).toMatchObject({ ok: false });
    expect(inboxAnsweredQuote("就用东京区域吧", "东京区域")).toEqual({ ok: true, quote: "东京区域" });
    expect(inboxAnsweredQuote(said, undefined)).toEqual({ ok: true, quote: "Keep Jenkins for a week. The region can wait." });
  });

  test("refusals, each writing nothing", () => {
    const cases: { name: string; run: (s: ReturnType<typeof setup>) => () => unknown; says: string }[] = [
      { name: "no reply", run: (s) => () => s.mark([{ question: s.ref }]), says: "has reached you after it" },
      { name: "another session", run: (s) => (s.reply(words, "r1"), () => s.mark([{ question: s.ref }], OTHER)), says: "only the agent that asked" },
      { name: "words not in the reply", run: (s) => (s.reply(words, "r1"), () => s.mark([{ question: s.ref, quote: "keep Jenkins forever" }])), says: "whole words copied exactly" },
      { name: "the asking message as the reply", run: (s) => (s.reply(words, "r1"), () => s.mark([{ question: s.ref, reply: s.asked.id }])), says: "is not the person's own reply" },
      { name: "a reply in another thread", run: (s) => {
        const elsewhere = s.store.sendMessage({ project_id: s.project.id, author: AGENT, body: "Elsewhere." }).message;
        const r = s.store.sendReply(elsewhere.id, { idempotency_key: "rx", words, questions: [] }).reply;
        return () => s.mark([{ question: s.ref, reply: r.id }]);
      }, says: "is not a message of this thread" },
      { name: "a reply before the question", run: (s) => {
        const later = s.store.sendMessage({ project_id: s.project.id, author: AGENT, reply_to: s.reply(words, "r1").id, body: block("Ship it?", ["Yes", "No"]) }).message;
        const key = s.store.questionsOf(later.id)[0]!.key;
        return () => s.store.sendMessage({ project_id: s.project.id, author: AGENT, reply_to: later.id, body: "Ok.", answered_in_reply: [{ question: `${later.id}/${key}`, reply: s.store.thread(s.asked.thread_id)!.messages[1]!.id }] });
      }, says: "came before the question" },
      { name: "a taken-back reply", run: (s) => {
        const r = s.reply(words, "r1", false);
        s.store.takeBack(r.id);
        return () => s.mark([{ question: s.ref, reply: r.id }]);
      }, says: "is not the person's own reply" },
      { name: "a Re-ask note", run: (s) => {
        s.reply(words, "r1");
        const note = s.store.sendReask(s.asked.id, { idempotency_key: "k1" }).reply;
        return () => s.mark([{ question: s.ref, reply: note.id }]);
      }, says: "is not the person's own reply" },
      { name: "a skills-only reply", run: (s) => (s.reply("**Skills referenced** (the person is asking you to invoke these skills when acting on this reply):\n- `grill-me`", "r1"), () => s.mark([{ question: s.ref }])), says: "no words of the person's to quote" },
      { name: "an action item", run: (s) => {
        const acted = s.store.sendMessage({ project_id: s.project.id, author: AGENT, reply_to: s.asked.id, body: ":::action\nApprove the deploy on Vercel\n:::" }).message;
        const key = s.store.questionsOf(acted.id).find((q) => q.kind === "action")!.key;
        s.reply(words, "r1");
        return () => s.mark([{ question: `${acted.id}/${key}` }]);
      }, says: "is not a question's id" },
      { name: "a superseded question", run: (s) => (s.reply(words, "r1"), s.mark(undefined, AGENT, s.asked.id, { supersedes: [s.ref] }), () => s.mark([{ question: s.ref }])), says: "is not open (it is superseded)" },
      { name: "also in supersedes", run: (s) => (s.reply(words, "r1"), () => s.mark([{ question: s.ref }], AGENT, s.asked.id, { supersedes: [s.ref] })), says: "is also in supersedes" },
      { name: "a sent question", run: (s) => {
        s.store.savePicks(s.asked.id, [{ key: s.region.key, revision: 0, answer: { v: 1, key: s.region.key, kind: "single", prompt: s.region.prompt, selected: ["us-east-1"] } }]);
        s.store.sendReply(s.asked.id, { idempotency_key: "r2", questions: [{ key: s.region.key, revision: 1 }] });
        s.reply(words, "r1");
        return () => s.mark([{ question: s.regionRef }]);
      }, says: "is not open (it is sent)" },
      { name: "not a list", run: (s) => () => s.mark({ question: s.ref }), says: "a list of" },
      { name: "an entry without a question", run: (s) => () => s.mark([{ quote: "x" }]), says: "each entry names its question" },
      { name: "over 100", run: (s) => () => s.mark(Array.from({ length: 101 }, (_, i) => `${s.asked.id}/q-${i}`)), says: "at most 100" },
    ];
    for (const c of cases) {
      const s = setup();
      const run = c.run(s);
      const agentMessages = () => s.store.thread(s.asked.thread_id)!.messages.filter((m) => m.author.kind === "agent").length;
      const before = agentMessages();
      let error: InboxError;
      try {
        error = refused(run);
      } catch (cause) {
        throw new Error(`${c.name}: ${(cause as Error).message}`);
      }
      expect(`${c.name}: ${error.message}`).toContain(c.says);
      expect(error.code).toBe("invalid_answered_in_reply");
      expect(agentMessages()).toBe(before);
    }
  });

  test("one reply answers several questions, any kind but an action item; a replay marks nothing again", () => {
    const multi = [block("Which regions?", ["us-east-1", "eu-west-1"], true), "", block("Keep Jenkins?", ["Yes", "No"])].join("\n");
    const s = setup(AGENT, multi);
    const sent = s.reply("Both regions, and yes keep it.", "r1");
    const entries = [{ question: s.regionRef, quote: "Both regions" }, { question: s.ref, quote: "yes keep it" }];
    const first = s.mark(entries, AGENT, sent.id, { idempotency_key: "k1" });
    expect(first.answered_in_reply).toEqual([s.regionRef, s.ref]);
    const again = s.mark(entries, AGENT, sent.id, { idempotency_key: "k1" });
    expect(again.replayed).toBe(true);
    expect(again.answered_in_reply).toEqual([s.regionRef, s.ref]);
    expect(refused(() => s.mark([entries[0]], AGENT, sent.id, { idempotency_key: "k1" })).code).toBe("idempotency_key_reused");
  });

  test("a send from another computer that waited: stale entries are skipped and the message still lands", () => {
    const s = setup(FAR);
    const sent = s.reply(words, "r1");
    s.store.savePicks(s.asked.id, [{ key: s.region.key, revision: 0, answer: { v: 1, key: s.region.key, kind: "single", prompt: s.region.prompt, selected: ["us-east-1"] } }]);
    s.store.sendReply(s.asked.id, { idempotency_key: "r2", questions: [{ key: s.region.key, revision: 1 }] });
    const result = s.mark([{ question: s.regionRef }, { question: s.ref }], FAR, sent.id);
    expect(result.answered_in_reply).toEqual([s.ref]);
    expect(result.answered_in_reply_skipped).toEqual([{ question: s.regionRef, reason: `${s.regionRef} is not open (it is sent).` }]);
    expect(s.store.message(result.message.id)).toBeTruthy();
    const elsewhere = s.mark([{ question: s.ref }], { ...FAR, machine: "ibx_01JZ00000000000000000000B1" }, sent.id);
    expect(elsewhere.answered_in_reply_skipped?.[0]?.reason).toContain("only the agent that asked");
  });

  test("Reopen puts the question back as it was, tells the agent, and words from before it no longer count", () => {
    const { store, asked, jenkins, ref, state, reply, mark } = setup();
    store.savePicks(asked.id, [{ key: jenkins.key, revision: 0, answer: { v: 1, key: jenkins.key, kind: "single", prompt: jenkins.prompt, selected: ["Yes"] } }]);
    const before = state(jenkins.key);
    Bun.sleepSync(3);
    const second = reply(words, "r2");
    mark([{ question: ref }], AGENT, second.id);
    expect(store.openDecisions().some((d) => d.id === ref)).toBe(false);
    const after = store.reopenAnswered(asked.id, jenkins.key).find((x) => x.key === jenkins.key)!;
    expect(after).toEqual(before);
    expect(store.openDecisions().some((d) => d.id === ref)).toBe(true);
    const note = store.thread(asked.thread_id)!.messages.at(-1)!;
    expect([note.author.kind, note.reply_to, note.reopened]).toEqual(["person", asked.id, [ref]]);
    expect(note.body).toContain("don't use those words as the answer");
    expect(refused(() => mark([{ question: ref, reply: second.id }])).message).toContain(`the person reopened it after reply ${second.id}`);
    expect(before.state).toBe("picked");
    expect(store.listRow(asked.thread_id)!.questions.picked).toBe(1);
  });

  test("a pick on an answered question is refused until it is reopened", () => {
    const { store, asked, jenkins, ref, reply, mark } = setup();
    mark([{ question: ref }], AGENT, reply(words, "r1").id);
    const pick = () => store.savePicks(asked.id, [{ key: jenkins.key, revision: 0, answer: { v: 1, key: jenkins.key, kind: "single", prompt: jenkins.prompt, selected: ["No"] } }]);
    expect(refused(pick).code).toBe("question_answered_in_reply");
    store.reopenAnswered(asked.id, jenkins.key);
    expect(pick()[1]!.state).toBe("picked");
  });

  test("a quoted reply reached the agent, so it can no longer be taken back", () => {
    const { store, ref, reply, mark } = setup();
    const sent = reply(words, "r1");
    mark([{ question: ref }], AGENT, sent.id);
    expect(refused(() => store.takeBack(sent.id)).code).toBe("agent_has_it");
  });
});
