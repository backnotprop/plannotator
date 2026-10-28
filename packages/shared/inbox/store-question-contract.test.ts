/**
 * The Inbox's question records with the optional contract lines and picture
 * choices (approval "inbox-decision-mode", agent contract lines). On a real
 * store in a temp dir.
 *
 * What regresses if this fails: a record loses `stakes`, `shows`, `why`,
 * `reversible` or a choice's `image` (the card has nothing to draw), the
 * card's plain picture label is refused by the server, the agent gets raw
 * markdown back as its answer, or a record written before picture choices
 * (a label holding `![B](b.png)`) refuses the plain label the card now picks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { checkInboxAnswer, parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { canonicalQuestionAnswer, parseQuestionBlock } from "@plannotator/core/question-block";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

const INNER = [
  "Which checkout drawer should ship?",
  "Stakes: ships to all of checkout on Thursday.",
  "Shows: [the drawer spec](drawer-spec.md)",
  "Reversible: no — the old drawer's code is deleted",
  "Stopped: the release branch waits on this",
  "",
  "- [ ] A · Total on top — ![Drawer A](drawer-a.png) closest to today",
  "- [ ] B · Total pinned — ![Drawer B](drawer-b.png) the total never scrolls away",
  "",
  "Recommended: B · Total pinned",
  "",
  "Why: on a phone only B keeps the total next to Pay.",
];
const BODY = ["Two drawers:", "", ":::question", ...INNER, ":::"].join("\n");

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-contract-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "shop", root: "/work/shop" });
  return { dir, store, project };
}

describe("contract lines on the stored record", () => {
  test("the record keeps every field, and the wire serves them; the context keeps only prose", () => {
    const [parsed] = parseInboxQuestionBlocks(BODY);
    expect(parsed!.parsed).toMatchObject({
      stakes: "ships to all of checkout on Thursday.",
      shows: { kind: "link", label: "the drawer spec", src: "drawer-spec.md" },
      why: "on a phone only B keeps the total next to Pay.",
      reversible: { value: false, why: "the old drawer's code is deleted" },
    });
    expect(parsed!.parsed.choices.map((c) => c.image)).toEqual([
      { alt: "Drawer A", src: "drawer-a.png" },
      { alt: "Drawer B", src: "drawer-b.png" },
    ]);
    expect(parsed!.stopped).toBe("the release branch waits on this");
    expect(parsed!.parsed.context).toBe("Stopped: the release branch waits on this");

    const { store, project } = newStore();
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
    const wire = store.questionsOf(message.id)[0]!;
    expect(wire.stakes).toBe("ships to all of checkout on Thursday.");
    expect(wire.shows).toEqual({ kind: "link", label: "the drawer spec", src: "drawer-spec.md" });
    expect(wire.why).toContain("phone");
    expect(wire.reversible).toEqual({ value: false, why: "the old drawer's code is deleted" });
    expect(wire.choices[1]).toMatchObject({ label: "B · Total pinned", recommended: true, image: { alt: "Drawer B", src: "drawer-b.png" } });
  });

  test("a block without the lines stores and serves exactly what it did", () => {
    const { store, project } = newStore();
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: [":::question", "Pick?", "- [ ] A", "- [ ] B", ":::"].join("\n") }).message;
    const wire = store.questionsOf(message.id)[0]!;
    for (const field of ["stakes", "shows", "why", "reversible"]) expect(wire).not.toHaveProperty(field);
    expect(wire.choices).toEqual([
      { label: "A", description: null, recommended: false, settled: false },
      { label: "B", description: null, recommended: false, settled: false },
    ]);
  });

  test("the card's picture label is the pick the server takes; Send gives the agent the plain label", () => {
    const { store, project } = newStore();
    const message = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
    const q = store.questionsOf(message.id)[0]!;
    const card = parseQuestionBlock("question", INNER.join("\n"), { decisionLines: false })!;
    expect(card.key).toBe(q.key);
    const label = card.choices[0]!.label;
    const [picked] = store.savePicks(message.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] } }]);
    expect(picked!.answer!.selected).toEqual(["A · Total on top"]);
    const sent = store.sendReply(message.id, { idempotency_key: "k-1", questions: [{ key: q.key, revision: 1 }] });
    expect(sent.reply!.body).toContain("Answer: A · Total on top");
    expect(sent.reply!.body).not.toContain("![");
  });
});

// Records origin/main stored before picture choices, frozen from that build's
// ACTUAL parser output (`parseInboxQuestionBlocks` run in a worktree of
// origin/main at e36db4209 over the bodies below), not written by hand.
const OLD_RECORDS = {
  // An image in front of the label: the label kept the markdown.
  imageInLabel: {
    inner: ["Which mock?", "- [ ] ![A](mock-a.png) A", "- [ ] ![B](mock-b.png) B"],
    parsed: {
      context: null,
      choices: [
        { label: "![A](mock-a.png) A", description: null, recommended: false, settled: false },
        { label: "![B](mock-b.png) B", description: null, recommended: false, settled: false },
      ],
      aliases: [null, null],
      recommendation: null,
      suggested_text: null,
      line: 2,
    },
    picks: ["A", "B"],
  },
  // A dash inside the alt text (` - `, ` — `, ` – `): the label was cut inside the image.
  dashInAlt: {
    inner: [
      "Which drawer?",
      "- [ ] ![Drawer A - closest](a.png) Drawer A",
      "- [ ] ![Drawer B — pinned](b.png) Drawer B",
      "- [ ] ![Drawer C – steps](c.png) Drawer C",
    ],
    parsed: {
      context: null,
      choices: [
        { label: "![Drawer A", description: "closest](a.png) Drawer A", recommended: false, settled: false },
        { label: "![Drawer B", description: "pinned](b.png) Drawer B", recommended: false, settled: false },
        { label: "![Drawer C", description: "steps](c.png) Drawer C", recommended: false, settled: false },
      ],
      aliases: [null, null, null],
      recommendation: null,
      suggested_text: null,
      line: 2,
    },
    picks: ["Drawer A", "Drawer B", "Drawer C"],
  },
} as const;

function oldStore(name: keyof typeof OLD_RECORDS) {
  const { dir, store, project } = newStore();
  const { inner, parsed } = OLD_RECORDS[name];
  const message = store.sendMessage({ project_id: project.id, author: AGENT, body: [":::question", ...inner, ":::"].join("\n") }).message;
  const record = store.questionRecord(`${message.id}/${store.questionsOf(message.id)[0]!.key}`)!;
  appendFileSync(
    join(store.dir, "projects", project.key, "questions.jsonl"),
    `${JSON.stringify({ v: 1, seq: store.cursor() + 1, at: new Date().toISOString(), kind: "question", id: record.id, record: { ...record, parsed } })}\n`,
  );
  const card = parseQuestionBlock("question", inner.join("\n"), { decisionLines: false })!;
  return { store: InboxStore.open(dir), message, card, key: record.key };
}

describe("a record from before picture choices", () => {
  for (const name of Object.keys(OLD_RECORDS) as (keyof typeof OLD_RECORDS)[]) {
    test(`${name}: each plain label the card picks is taken, stored under the record's label, and shown picked again`, () => {
      const { store, message, card, key } = oldStore(name);
      const { parsed, picks } = OLD_RECORDS[name];
      expect(card.choices.map((c) => c.label)).toEqual([...picks]);
      picks.forEach((label, index) => {
        const [picked] = store.savePicks(message.id, [{ key, revision: index, answer: { v: 1, key, kind: "single", prompt: card.prompt, selected: [label] } }]);
        expect(picked!.state).toBe("picked");
        expect(picked!.answer!.selected).toEqual([parsed.choices[index]!.label]);
        expect(canonicalQuestionAnswer(card, picked!.answer!).selected).toEqual([label]);
      });
    });
  }

  test("two stored labels that would read as one head add it to neither", () => {
    const { store, message, key } = oldStore("dashInAlt");
    const record = store.questionRecord(`${message.id}/${key}`)!;
    const same = { ...record.parsed, choices: record.parsed.choices.slice(0, 2).map((c) => ({ ...c, description: "x](a.png) Drawer" })), aliases: [null, null] };
    const refused = checkInboxAnswer({ ...record, parsed: same }, { v: 1, key, kind: "single", prompt: record.prompt, selected: ["Drawer"] }, "answer");
    expect(refused.ok).toBe(false);
  });
});
