/**
 * A choice longer than 200 characters is picked as written (the owner's
 * 0.28.17 report: "<the first 200 characters> is not one of the question's
 * choices"). The answer's labels were cut to 200 on validation while the
 * question's own labels were not, so a long task-list choice could never be
 * picked. On a real store in a temp dir; a replay from disk agrees.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { composeInboxReplyBody } from "@plannotator/core/inbox-questions";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-long-choice-"));
  roots.push(dir);
  return { store: InboxStore.open(dir), dir };
}

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const LONG =
  "Spike first. Find out what the sign-in grants (a Claude subscription paying for turns the platform runs?) and whether Anthropic allows it for a third-party product; the placeholder stays off the product until both answers are in";

const ask = (choice: string) =>
  ["How do we start?", "", ":::question", "Which way first?", "", `- [ ] ${choice}`, "- [ ] Ship the placeholder now", ":::"].join("\n");

describe("a long choice", () => {
  for (const [name, choice, label] of [
    ["with no separator", LONG, LONG],
    ["before a ' - ' why", `${LONG} - keeps it reversible`, LONG],
    ["before a ' — ' why", `${LONG} — keeps it reversible`, LONG],
  ] as const) {
    test(`${name}: is picked and sent with its whole label`, () => {
      const { store, dir } = open();
      const project = store.ensureProject({ name: "billing", root: "/work/billing" });
      const message = store.sendMessage({ project_id: project.id, author: AGENT, body: ask(choice) }).message;
      const q = store.questionsOf(message.id)[0]!;
      expect(q.choices[0]!.label).toBe(label);
      expect(label.length).toBeGreaterThan(200);
      const answer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [q.choices[0]!.label] } as never;
      const [picked] = store.savePicks(message.id, [{ key: q.key, revision: 0, answer }]);
      expect(picked!.state).toBe("picked");
      expect(picked!.answer!.selected).toEqual([label]);
      const sent = store.sendReply(message.id, { idempotency_key: "k-1", questions: [{ key: q.key, revision: 1 }] });
      expect(sent.reply!.body).toContain(label);
      expect(InboxStore.open(dir).questionsOf(message.id)[0]!.answer!.selected).toEqual([label]);
    });
  }

  test("an answer cut at 200 characters (an older window) is stored as the choice's whole label", () => {
    const { store } = open();
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: ask(LONG) }).message;
    const q = store.questionsOf(message.id)[0]!;
    const answer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [LONG.slice(0, 200)] } as never;
    const [picked] = store.savePicks(message.id, [{ key: q.key, revision: 0, answer }]);
    expect(picked!.answer!.selected).toEqual([LONG]);
  });

  test("the reply's answers section prints the full label for an answer cut at 200 characters", () => {
    const { store } = open();
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: ask(LONG) }).message;
    const q = store.questionsOf(message.id)[0]!;
    const record = store.questionRecord(`${message.id}/${q.key}`)!;
    const cut = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [LONG.slice(0, 200)] } as const;
    const body = composeInboxReplyBody({ questions: [record], sent: [{ ...cut, selected: [...cut.selected] }], earlier: [], words: undefined });
    expect(body).toContain(`Answer: ${LONG}`);
  });
});
