import { describe, expect, it } from "bun:test";
import type { AnswerRecord } from "./answers";
import { answerListItem, answerViewState, answersFooter, goesWith } from "./view";
import type { AskRunState } from "./session";

const NOW = 1_800_000_000_000;

function record(over: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    v: 1, id: "ans-1-abcd", guideId: "g", repoKey: "k", question: "Why did this change?",
    about: { kind: "selection", chapter: 1, chapterTitle: "Delivery loop", path: "src/webhooks/deliver.ts", side: "head", lines: { start: 25, end: 31 }, code: "const attempt = job.attempt + 1;\nif (x) {" },
    askedAt: NOW - 160_000, answeredAt: NOW - 119_000, status: "answered", title: "Failures loop back", html: "<p>x</p>",
    agent: { id: "claude-code", label: "Claude Code", model: { id: "sonnet", label: "Sonnet 5" }, effort: { id: "low", label: "Low" } },
    cost: { amount: 0.03, currency: "USD" }, headSha: "9b07e4d1234",
    ...over,
  };
}

describe("the answer tab's state", () => {
  it("an answered page: where it was asked, the agent line, a jump back to the lines", () => {
    const s = answerViewState({ record: record(), now: NOW });
    expect(s.kicker).toBe("Answer · Chapter 2 · deliver.ts 25–31");
    expect(s.meta).toBe("Claude Code · Sonnet 5 · low · 41s · $0.03 · 2 minutes ago");
    expect(s.jump).toEqual({ label: "Lines 25–31", link: "code:src/webhooks/deliver.ts#L25-L31" });
    expect(s.page).toEqual({ title: "Failures loop back", html: "<p>x</p>" });
    expect(s.status).toBe("answered");
    expect(s.canFollowUp).toBe(true);
  });

  it("while it answers: the quoted lines, the activity, the stream; no follow-up", () => {
    const run: AskRunState = {
      answerId: "ans-1-abcd", status: "working", startedAt: NOW - 18_000, activity: [{ id: 1, at: 4000, kind: "tool", title: "Read src/queue/worker.ts", status: "completed" }],
      stream: "Before this change", pendingPermissions: [], autoApprove: false, offerAutoApprove: false, cost: { amount: 0.01, currency: "USD" },
    };
    const s = answerViewState({ record: record({ status: "answering", answeredAt: undefined, title: undefined, html: undefined }), run, now: NOW, busy: true });
    expect(s.status).toBe("answering");
    expect(s.quote?.header).toBe("src/webhooks/deliver.ts · lines 25–31 · head 9b07e4d");
    expect(s.quote?.lines).toHaveLength(2);
    expect(s.activity[0]).toMatchObject({ at: "0:04", title: "Read src/queue/worker.ts" });
    expect(s.stream).toBe("Before this change");
    expect(s.cost).toBe("$0.01");
    expect(s.canFollowUp).toBe(false);
  });

  it("a chapter question jumps to the chapter; a base-side selection to the file", () => {
    expect(answerViewState({ record: record({ about: { kind: "chapter", chapter: 3, chapterTitle: "Worker" } }), now: NOW }).jump).toEqual({ label: "Chapter 4", link: "chapter:4" });
    expect(answerViewState({ record: record({ about: { ...record().about, side: "base" } }), now: NOW }).jump).toEqual({ label: "deliver.ts", link: "code:src/webhooks/deliver.ts" });
  });

  it("lists answers with a new mark until opened, and totals their cost", () => {
    expect(answerListItem(record(), NOW, false)).toEqual({ id: "ans-1-abcd", question: "Why did this change?", sub: "deliver.ts · lines 25–31", when: "2m", isNew: true, status: "answered" });
    expect(answerListItem(record({ seen: true }), NOW, false).isNew).toBe(false);
    expect(answerListItem(record(), NOW, true).when).toBe("answering");
    expect(answersFooter([record(), record({ cost: { amount: 0.02, currency: "USD" } })])).toBe("Claude Code · Sonnet 5 · low · answers $0.05");
  });

  it("says what goes with the question", () => {
    expect(goesWith(record().about)).toEqual(["deliver.ts 25–31", "the file's diff", "Chapter 2", "the guide"]);
    expect(goesWith({ kind: "chapter", chapter: 0, chapterTitle: "x" })).toEqual(["Chapter 1, its overview and its files' diffs", "the guide"]);
  });
});
