/**
 * A pick is stored, echoed and recorded as the very choice the person
 * picked, however close two choices' words are: two that share a long
 * start, one whose label begins another, ones that share the words before a
 * dash, with a picture, or that differ only in case, end punctuation or an
 * underscore (the recommendation names the one written exactly). Two choices
 * that are the same once spaces are folded are one answer for two choices:
 * the send is refused, in the body or in an attached file.
 *
 * What regresses if this fails: the reply tells the agent "Answer: <the
 * other choice>", or calls a pick the recommendation when the person took
 * its neighbour, or a question whose choices cannot be told apart is asked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import type { InboxAttachment, InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-choice-labels-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  return { store, project: store.ensureProject({ name: "billing", root: "/work/billing" }) };
}

const block = (choices: string[], recommended?: string) =>
  [":::question", "Which way?", "", ...choices.map((c) => `- [ ] ${c}`), ...(recommended ? ["", `Recommended: ${recommended}`] : []), ":::"].join("\n");

const LONG = "Ship the new billing flow to every customer in every region, with the migration run in one window and the old tables kept ";

const CLOSE: [string, string[]][] = [
  ["two that share their first words", ["Yes, as written", "Yes, with changes"]],
  ["two that share a long start", [`${LONG}for a week`, `${LONG}for a month`]],
  ["one whose label begins the other", ["Ship it", "Ship it now"]],
  ["the same words before a dash", ["Yes — keep the flag", "Yes — drop the flag"]],
  ["a picture and an em dash", ["![A](a.png) Drawer A — closest", "![B](b.png) Drawer A — farthest"]],
  ["the same words before a dash, a picture after", ["Yes — keep it ![A](a.png)", "Yes — drop it ![B](b.png)"]],
  ["end punctuation apart", ["Yes", "Yes!"]],
  ["case apart", ["A", "a"]],
  ["emphasis apart", ["**Ship it**", "Ship it"]],
  ["a trailing dot apart", ["1.", "1"]],
  ["an underscore apart", ["snake_case", "snakecase"]],
  ["punctuation only", ["?", "!"]],
];

describe("each pick names its own choice", () => {
  for (const [name, choices] of CLOSE) {
    test(name, () => {
      const { store, project } = open();
      const labels = parseInboxQuestionBlocks(block(choices))[0]!.parsed.choices.map((c) => c.label);
      expect(new Set(labels).size).toBe(choices.length);
      labels.forEach((label, i) => {
        const sent = store.sendMessage({ project_id: project.id, author: AGENT, body: block(choices, choices[1]), idempotency_key: `k${i}` }).message;
        const q = store.questionsOf(sent.id)[0]!;
        expect(q.choices.map((c) => c.label)).toEqual(labels);
        expect(q.choices.map((c) => c.recommended)).toEqual([false, true]);
        store.savePicks(sent.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] } }]);
        const reply = store.sendReply(sent.id, { idempotency_key: `r${i}`, questions: [{ key: q.key, revision: 1 }] }).reply;
        const recorded = store.questionsOf(sent.id)[0] as InboxQuestion;
        expect(recorded.answer?.selected).toEqual([label]);
        const answerLine = reply.body.split("\n").find((line) => line.startsWith("Answer: "));
        expect(answerLine).toBe(`Answer: ${label}${i === 1 ? " (your recommendation)" : ""}`);
      });
    });
  }
});

describe("two choices that are the same once spaces are folded are refused at send", () => {
  const refused = (fn: () => unknown): InboxError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof InboxError) return error;
      throw error;
    }
    throw new Error("the send was taken");
  };

  test("in the body: the same label, or the same once spaces are folded, and nothing is written", () => {
    for (const pair of [["Ship it", "Ship it"], ["Ship it", "Ship  it\t"], ["Ship\tit", "Ship it"]]) {
      const { store, project } = open();
      const error = refused(() => store.sendMessage({ project_id: project.id, author: AGENT, body: block(pair) }));
      expect(error.code).toBe("validation_error");
      expect(error.message).toBe('body: question "Which way?" has the choice "Ship it" twice, so a pick cannot tell them apart. Give each choice its own words.');
      expect(store.listRows()).toEqual([]);
    }
  });

  test("in an attached file: named by the file", () => {
    const { store, project } = open();
    const plan: InboxAttachment = { id: "att_01JAAAAAAAAAAAAAAAAAAAAAAA", path: "/work/billing/plan.md", named_path: null, name: "plan.md", kind: "markdown", sent_sha256: "0".repeat(64), size: 10, sent_at: "", sent_mtime: "2026-11-09T00:00:00.000Z" };
    const error = refused(() =>
      store.sendMessage({
        project_id: project.id,
        author: AGENT,
        body: "The plan is attached.",
        attachments: [plan],
        attachment_questions: [{ attachment_id: plan.id, questions: parseInboxQuestionBlocks(block(["Keep it", "Keep  it"])) }],
      }),
    );
    expect(error.message).toStartWith('attachments: plan.md: question "Which way?" has the choice "Keep it" twice');
    expect(store.listRows()).toEqual([]);
  });
});
