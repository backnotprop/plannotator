import { describe, expect, test } from "bun:test";
import {
  buildQuestionAnswerAnnotation,
  canonicalQuestionAnswer,
  formatQuestionAnswerText,
  formatQuestionAnswersSection,
  indexQuestionBlocks,
  isQuestionAnswerEmpty,
  parseQuestionAnswer,
  parseQuestionBlock,
  questionExportItems,
  questionKey,
  questionStatus,
  recommendedQuestionAnswer,
  type QuestionAnswer,
} from "./question-block";

const SPEC_BODY = `Where should losing conflict versions be kept?

Last-write-wins silently drops the loser unless we keep it somewhere.

- [ ] Local only, purged after 30 days — cheap, no server change
- [ ] Server-side per user — survives reinstall, needs a retention policy
- [ ] Nowhere — accept silent loss for v1

Recommended: Local only, purged after 30 days`;

describe("parseQuestionBlock", () => {
  test("parses the spaced (GitHub-friendly) form", () => {
    const q = parseQuestionBlock("question", SPEC_BODY)!;
    expect(q.kind).toBe("single");
    expect(q.prompt).toBe("Where should losing conflict versions be kept?");
    expect(q.promptLine).toBe(0);
    expect(q.context).toBe("Last-write-wins silently drops the loser unless we keep it somewhere.");
    expect(q.choices.map((c) => c.label)).toEqual([
      "Local only, purged after 30 days",
      "Server-side per user",
      "Nowhere",
    ]);
    expect(q.choices[1].description).toBe("survives reinstall, needs a retention policy");
    expect(q.choices.map((c) => c.recommended)).toEqual([true, false, false]);
    expect(q.suggestedText).toBeUndefined();
  });

  test("parses the tight form, arrow aliases and a recommendation carrying a reason", () => {
    const q = parseQuestionBlock(
      "question",
      `Should sync run in the background?
iOS background execution is unreliable.
- [ ] Yes, best-effort via BGAppRefreshTask
- [ ] No — foreground only, sync on app-open
➡️ No — foreground only, sync on app-open`,
    )!;
    expect(q.context).toBe("iOS background execution is unreliable.");
    expect(q.choices[1].recommended).toBe(true);

    const reason = parseQuestionBlock("question", `Pick one\n- [ ] Alpha\n- [ ] Beta\n**Recommended:** beta — it is cheaper`)!;
    expect(reason.choices.map((c) => c.recommended)).toEqual([false, true]);
  });

  test("[x] means settled, not recommended", () => {
    const q = parseQuestionBlock("question", `Transport?\n- [x] REST\n- [ ] WebSocket\nRecommended: WebSocket`)!;
    expect(q.choices.map((c) => [c.settled, c.recommended])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test("multi questions resolve a list of recommended labels", () => {
    const q = parseQuestionBlock(
      "question-multi",
      `Which indicators ship?\n\n- [ ] Status dot\n- [ ] Offline banner\n- [ ] Toasts\n\nRecommended: Status dot and Offline banner`,
    )!;
    expect(q.kind).toBe("multi");
    expect(q.choices.map((c) => c.recommended)).toEqual([true, true, false]);
  });

  test("a recommendation that names no choice becomes a suggested answer", () => {
    const q = parseQuestionBlock("question", `Pick\n- [ ] A\n- [ ] B\nRecommended: something else entirely`)!;
    expect(q.choices.every((c) => !c.recommended)).toBe(true);
    expect(q.suggestedText).toBe("something else entirely");
  });

  test("free text: question-text, or any kind with no choices", () => {
    const text = parseQuestionBlock("question-text", `Describe the manual test.\n\nRecommended: Two phones, one offline.`)!;
    expect(text.kind).toBe("text");
    expect(text.choices).toEqual([]);
    expect(text.suggestedText).toBe("Two phones, one offline.");

    const noChoices = parseQuestionBlock("question", `What is the budget?`)!;
    expect(noChoices.kind).toBe("text");
  });

  test("tolerates numbered markers, plain bullets, indented continuations and a heading prompt", () => {
    const numbered = parseQuestionBlock("question", `Pick\n1. [ ] One\n2) [ ] Two`)!;
    expect(numbered.choices.map((c) => c.label)).toEqual(["One", "Two"]);

    const bullets = parseQuestionBlock("question", `### Pick a colour\n\n- Red\n- Blue — calmer\n\nRecommended: Blue`)!;
    expect(bullets.prompt).toBe("Pick a colour");
    expect(bullets.choices.map((c) => c.label)).toEqual(["Red", "Blue"]);
    expect(bullets.choices[1].recommended).toBe(true);
    expect(bullets.context).toBe("");

    const cont = parseQuestionBlock("question", `Pick\n- [ ] One — first line\n  continues here\n- [ ] Two`)!;
    expect(cont.choices[0].description).toBe("first line continues here");
  });

  test("malformed blocks return null instead of throwing", () => {
    expect(parseQuestionBlock("note", SPEC_BODY)).toBeNull();
    expect(parseQuestionBlock("question", "")).toBeNull();
    expect(parseQuestionBlock("question", "- [ ] only choices\n- [ ] no prompt")).toBeNull();
    expect(parseQuestionBlock("question", "Recommended: nothing to ask")).toBeNull();
    expect(parseQuestionBlock("question", `Q?\n${"x".repeat(25_000)}`)).toBeNull();
    expect(parseQuestionBlock("question", undefined as unknown as string)).toBeNull();
  });
});

// The owner's live report (pando-ops review): plain-bullet choices that wrap
// onto indented lines were cut at the first line, and the rest of each choice
// landed in the context above the options.
const WRAPPED_PLAIN_BULLETS = `**4. How does a Cloudflare-run agent show in the Machines tab and on its work?**

The rulings say agents act as the person who launched them. Two ways to
name it:

- **One per session:** "ramos · cloud-3", "ramos · cloud-4". Each agent shows
  as its own machine in the Machines tab and beside its comments and pushes
  ("ramos, cloud-3"). Revoking one stops only that agent. A busy week can
  list dozens of them (ended ones sort to the bottom).
- **One per person:** "ramos · cloud", shared by all your cloud agents. A
  short Machines tab; revoking it stops all of them at once.

Commits are authored as you either way.

**Recommendation:** one per session. Answer: per session / per
person.`;

describe("plain-bullet choices keep their wrapped lines", () => {
  test("indented continuation lines belong to their bullet, not the context", () => {
    const q = parseQuestionBlock("question", WRAPPED_PLAIN_BULLETS)!;
    expect(q.kind).toBe("single");
    expect(q.choices.map((c) => c.label)).toEqual(["One per session", "One per person"]);
    expect(q.choices[0].description).toBe(
      `"ramos · cloud-3", "ramos · cloud-4". Each agent shows as its own machine in the Machines tab and beside its comments and pushes ("ramos, cloud-3"). Revoking one stops only that agent. A busy week can list dozens of them (ended ones sort to the bottom).`,
    );
    expect(q.choices[1].description).toBe(`"ramos · cloud", shared by all your cloud agents. A short Machines tab; revoking it stops all of them at once.`);
    expect(q.context).toBe(
      "The rulings say agents act as the person who launched them. Two ways to\nname it:\n\nCommits are authored as you either way.",
    );
  });

  test("a wrapped recommendation line stays the recommendation and matches a choice by its bold label", () => {
    const q = parseQuestionBlock("question", WRAPPED_PLAIN_BULLETS)!;
    expect(q.recommendation).toBe("one per session. Answer: per session / per person.");
    expect(q.context).not.toContain("person.");
    expect(q.choices.map((c) => c.recommended)).toEqual([true, false]);
    expect(q.suggestedText).toBeUndefined();
    const named = parseQuestionBlock("question", `Pick\n\n- **Alpha:** first\n  wrapped\n- **Beta:** second\n\nRecommended: Beta — it is cheaper`)!;
    expect(named.choices.map((c) => c.recommended)).toEqual([false, true]);
    // A recommendation naming no choice is still a suggested answer, in full.
    const free = parseQuestionBlock("question", `Pick\n\n- Alpha\n- Beta\n\nRecommended: neither of these. Build a third\nthing instead.`)!;
    expect(free.suggestedText).toBe("neither of these. Build a third thing instead.");
    // The whole joined bullet text matches too (raws keep the continuation).
    const whole = parseQuestionBlock("question", `Pick\n\n- Alpha first\n  wrapped\n- Beta\n\nRecommended: Alpha first wrapped`)!;
    expect(whole.choices.map((c) => [c.label, c.recommended])).toEqual([["Alpha first wrapped", true], ["Beta", false]]);
  });

  test("the answer quotes the full label", () => {
    const index = indexQuestionBlocks([{ id: "b", type: "directive", directiveKind: "question", content: WRAPPED_PLAIN_BULLETS, startLine: 1 }]);
    const rec = recommendedQuestionAnswer(index[0])!;
    expect(rec.selected).toEqual(["One per session"]);
    expect(formatQuestionAnswerText(rec)).toBe("Answer: One per session");
  });

  test("lazy (unindented) lines continue a bullet, as in CommonMark; a new block ends it", () => {
    const q = parseQuestionBlock("question", `Pick\n\n- Alpha runs\non two lines\n- Beta\n# not part of Beta\n\nAfter.`)!;
    expect(q.choices.map((c) => c.label)).toEqual(["Alpha runs on two lines", "Beta"]);
    expect(q.context).toBe("# not part of Beta\n\nAfter.");
  });

  test("an indented paragraph after a blank line continues the bullet; an unindented one does not", () => {
    const q = parseQuestionBlock(
      "question",
      `Pick\n\n- **Alpha:** first paragraph.\n\n  Second paragraph of Alpha.\n- **Beta:** only one.\n\nClosing prose.`,
    )!;
    expect(q.choices.map((c) => [c.label, c.description])).toEqual([
      ["Alpha", "first paragraph. Second paragraph of Alpha."],
      ["Beta", "only one."],
    ]);
    expect(q.context).toBe("Closing prose.");
  });

  test("a bold name runs into the label only when punctuation sets it off", () => {
    const q = parseQuestionBlock("question", `Pick\n\n- **Fast** mode with cache\n- **Slow** (no cache)\n- **a. It stops.** It waits.`)!;
    expect(q.choices.map((c) => [c.label, c.description])).toEqual([
      ["**Fast** mode with cache", undefined],
      ["**Slow** (no cache)", undefined],
      ["a. It stops.", "It waits."],
    ]);
  });

  test("an over-long label is cut at a sentence so it can still be picked, never dropped", () => {
    const sentence = "This first sentence names the option plainly.";
    const long = `${sentence} ${"More words follow here without any break at all ".repeat(6).trim()}`;
    const q = parseQuestionBlock("question", `Pick\n\n- ${long}\n- Short`)!;
    expect(q.choices[0].label).toBe(sentence);
    expect(`${q.choices[0].label} ${q.choices[0].description}`).toBe(long);
  });

  test("bullets that are not choices stay in the context, wrapped lines included", () => {
    const text = parseQuestionBlock("question-text", `Describe it\n\n- one\n  wrapped\n- two\n\nEnd.`)!;
    expect(text.kind).toBe("text");
    expect(text.context).toBe("- one\n  wrapped\n- two\n\nEnd.");

    const withTasks = parseQuestionBlock("question", `Pick\n\nFacts:\n\n- a fact\n  that wraps\n\n- [ ] Yes\n- [ ] No`)!;
    expect(withTasks.choices.map((c) => c.label)).toEqual(["Yes", "No"]);
    expect(withTasks.context).toBe("Facts:\n\n- a fact\n  that wraps");
  });

  test("the context keeps its markdown: table rows, code indentation, nested lists (shared indent removed)", () => {
    const q = parseQuestionBlock(
      "question-text",
      `  Set the numbers.\n\n  | Limit | Proposed |\n  | --- | --- |\n  | Agents | 3 |\n\n  \`\`\`ts\n  if (x) {\n    y();\n  }\n  \`\`\`\n\n  - outer\n    - inner`,
    )!;
    expect(q.context).toBe(
      "| Limit | Proposed |\n| --- | --- |\n| Agents | 3 |\n\n```ts\nif (x) {\n  y();\n}\n```\n\n- outer\n  - inner",
    );
  });

  // Review of #1699: a reason on the line right after `Recommended:` must stay
  // what it was before this change (context), not join the recommendation and
  // turn a recommended choice into a garbage "Other" suggestion. The expected
  // values are what the parser on main (0.28.1) returns for these bodies.
  test("a reason line under Recommended: parses exactly as before (task lists, multi, bold, arrow, text)", () => {
    const tasks = "- [ ] Local only — cheap\n- [ ] Server-side per user\n- [ ] Nowhere";
    const body = (rec: string) => `Where should it live?\n\nSome context.\n\n${tasks}\n${rec}`;
    for (const rec of [
      "Recommended: Local only\nIt is the cheapest option.",
      "**Recommended:** Local only\nIt is the cheapest option.",
      "Recommended: Local only.\nbecause it is cheap",
      "➡️ Local only\nWe accept the loss elsewhere.",
    ]) {
      const q = parseQuestionBlock("question", body(rec))!;
      expect(q.choices.map((c) => c.recommended)).toEqual([true, false, false]);
      expect(q.suggestedText).toBeUndefined();
      expect(q.recommendation).toMatch(/^Local only\.?$/);
      expect(q.context).toBe(`Some context.\n\n${rec.split("\n")[1]}`);
      // The export marks the reviewer's pick as the recommendation.
      const [indexed] = indexQuestionBlocks([{ id: "b", type: "directive", directiveKind: "question", content: body(rec), startLine: 1 }]);
      expect(recommendedQuestionAnswer(indexed)!.selected).toEqual(["Local only"]);
    }
    const multi = parseQuestionBlock("question-multi", body("Recommended: Local only and Nowhere\nBoth are cheap."))!;
    expect(multi.choices.map((c) => c.recommended)).toEqual([true, false, true]);
    expect(multi.context).toBe("Some context.\n\nBoth are cheap.");

    const text = parseQuestionBlock("question-text", "Describe the test.\n\nRecommended: Two phones, one offline.\nThe second phone rejoins later.")!;
    expect(text.suggestedText).toBe("Two phones, one offline.");
    expect(text.context).toBe("The second phone rejoins later.");
  });

  test("only a genuine wrap (no sentence end, lower-case next line) continues the recommendation", () => {
    const q = parseQuestionBlock("question", `Pick\n\n- [ ] Local only\n- [ ] Remote\n\nRecommended: Local only — because it\nneeds no server.`)!;
    expect(q.choices.map((c) => c.recommended)).toEqual([true, false]);
    expect(q.recommendation).toBe("Local only — because it needs no server.");
    expect(q.context).toBe("");
    // A first line naming no choice falls back to the wrapped text, which
    // is then the suggested answer in full.
    const free = parseQuestionBlock("question-text", `Describe it\n\nRecommended: two phones, one of them\noffline for a minute`)!;
    expect(free.suggestedText).toBe("two phones, one of them offline for a minute");
  });

  test("task-list labels are never cut, so a long label and its recommendation keep working", () => {
    const shared = "This option shares its first sentence.";
    const long = (tail: string) => `${shared} ${"more words ".repeat(20).trim()} ${tail}`;
    const q = parseQuestionBlock("question", `Pick\n\n- [ ] ${long("alpha")}\n- [ ] ${long("beta")}\n\nRecommended: ${long("alpha")}`)!;
    expect(q.choices.map((c) => c.label)).toEqual([long("alpha"), long("beta")]);
    expect(q.choices.map((c) => c.recommended)).toEqual([true, false]);
  });

  test("plain-bullet labels never collide: a cut or a bold name that two bullets share falls back", () => {
    const shared = "This option shares its first sentence.";
    const long = (tail: string) => `${shared} ${"more words ".repeat(20).trim()} ${tail}`;
    const cut = parseQuestionBlock("question", `Pick\n\n- ${long("alpha")}\n- ${long("beta")}\n- Short\n\nRecommended: ${long("beta")}`)!;
    expect(cut.choices.map((c) => c.label)).toEqual([long("alpha"), long("beta"), "Short"]);
    expect(cut.choices.map((c) => c.recommended)).toEqual([false, true, false]);

    const bold = parseQuestionBlock("question", `Pick\n\n- **Option:** keep it local\n- **Option:** move it to the server\n- **Other:** nothing`)!;
    expect(bold.choices.map((c) => c.label)).toEqual([
      "**Option:** keep it local",
      "**Option:** move it to the server",
      "Other",
    ]);

    // A recommendation may name a cut label's full (uncut) form.
    const one = parseQuestionBlock("question", `Pick\n\n- ${long("alpha")}\n- Short\n\nRecommended: ${long("alpha")}`)!;
    expect(one.choices[0].label).toBe(shared);
    expect(one.choices[0].recommended).toBe(true);
  });

  // Re-review of #1699: main matched a recommendation against a plain
  // bullet's first line, so it must still match once wrapped lines join it.
  test("a recommendation naming a wrapped bullet by its first line still marks it", () => {
    const indented = parseQuestionBlock("question", `Pick\n\n- Option A\n  more about A\n- Option B\n\nRecommended: Option A`)!;
    expect(indented.choices.map((c) => c.label)).toEqual(["Option A more about A", "Option B"]);
    expect(indented.choices.map((c) => c.recommended)).toEqual([true, false]);
    expect(indented.suggestedText).toBeUndefined();

    const lazy = parseQuestionBlock("question", `Pick\n\n- Option A — cheap\n- Option B — slow\nBoth are reversible.\n\nRecommended: Option B`)!;
    expect(lazy.choices.map((c) => c.description)).toEqual(["cheap", "slow Both are reversible."]);
    expect(lazy.choices.map((c) => c.recommended)).toEqual([false, true]);
    expect(lazy.suggestedText).toBeUndefined();
  });

  test("a recommendation replaced by a later one gives its wrapped lines back to the context", () => {
    const q = parseQuestionBlock(
      "question",
      `Pick\n\n- [ ] Local\n- [ ] Remote\n\nRecommended: Local, since it\nneeds no server\n\nRecommended: Remote`,
    )!;
    expect(q.recommendation).toBe("Remote");
    expect(q.choices.map((c) => c.recommended)).toEqual([false, true]);
    expect(q.context).toBe("needs no server");
  });

  test("only ** marks a bold name: __init__: stays one label", () => {
    const q = parseQuestionBlock("question", `Which method?\n\n- __init__: constructor\n- __call__: invoke`)!;
    expect(q.choices.map((c) => c.label)).toEqual(["__init__: constructor", "__call__: invoke"]);
  });

  test("an indented body (question inside a list item) still ends a bullet or a recommendation at a new block", () => {
    const body = [
      "  Pick one",
      "",
      "  - Alpha",
      "  > a quote after Alpha",
      "  - Beta",
      "  | a | b |",
      "  | --- | --- |",
      "  | 1 | 2 |",
      "",
      "  Recommended: Alpha — it is",
      "  ## Heading after",
    ].join("\n");
    const q = parseQuestionBlock("question", body)!;
    expect(q.choices.map((c) => c.label)).toEqual(["Alpha", "Beta"]);
    expect(q.choices[0].recommended).toBe(true);
    expect(q.context).toBe("> a quote after Alpha\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## Heading after");
  });

  test("shared indentation is removed in columns, tabs included", () => {
    const q = parseQuestionBlock("question-text", "\tAsk\n\n\tFirst line.\n\t    indented code-ish line")!;
    expect(q.context).toBe("First line.\n    indented code-ish line");
  });

  test("task-list choices are unchanged: bold names and lazy lines are not reinterpreted", () => {
    const q = parseQuestionBlock("question", `Pick\n- [ ] **Local** — cheap\n  still cheap\n- [ ] **Remote:** costly\nTrailing prose`)!;
    expect(q.choices.map((c) => [c.label, c.description])).toEqual([
      ["**Local**", "cheap still cheap"],
      ["**Remote:** costly", undefined],
    ]);
    expect(q.context).toBe("Trailing prose");
  });
});

// 0.28.2 pre-tag smoke: 0.28.1 read a wrapped plain bullet's first line as
// its label, so an answer saved then quotes that line. It must still show the
// choice it picked (and export as it), under the label 0.28.2 gives it.
describe("answers saved under an older label", () => {
  const OLD_LABEL = '**One per session:** "ramos · cloud-3", "ramos · cloud-4". Each agent shows';
  const index = indexQuestionBlocks([{ id: "b", type: "directive", directiveKind: "question", content: WRAPPED_PLAIN_BULLETS, startLine: 1 }]);
  const q = index[0].question;
  const saved: QuestionAnswer = { v: 1, key: q.key, kind: "single", prompt: q.prompt, selected: [OLD_LABEL] };

  test("canonicalQuestionAnswer maps a 0.28.1 label to the current one", () => {
    expect(canonicalQuestionAnswer(q, saved).selected).toEqual(["One per session"]);
    // The key is the prompt's, unchanged.
    expect(index[0].question.key).toBe(questionKey("single", q.prompt));
    // A current label, or one naming no choice, is left alone.
    const current = { ...saved, selected: ["One per person"] };
    expect(canonicalQuestionAnswer(q, current)).toBe(current);
    expect(canonicalQuestionAnswer(q, { ...saved, selected: ["Gone"] }).selected).toEqual(["Gone"]);
  });

  test("the export prints the current label, marked as the recommendation", () => {
    const out = formatQuestionAnswersSection(questionExportItems(index), [saved]);
    expect(out).toContain("Answer: One per session (your recommendation)");
    expect(out).not.toContain("Each agent shows");
  });

  // #1702 review: a stored label more than one choice could claim stays as
  // stored, never quietly becomes the first of them.
  test("an ambiguous stored label stays as stored; an exact match beats a normalized one", () => {
    const sharedFirstLine = parseQuestionBlock(
      "question",
      `Pick\n\n- Keep the cache\n  for reads\n- Keep the cache\n  for writes`,
    )!;
    expect(sharedFirstLine.choices.map((c) => c.label)).toEqual(["Keep the cache for reads", "Keep the cache for writes"]);
    const stored = (label: string): QuestionAnswer => ({ v: 1, key: "q-00000001", kind: "single", prompt: "Pick", selected: [label] });
    expect(canonicalQuestionAnswer(sharedFirstLine, stored("Keep the cache")).selected).toEqual(["Keep the cache"]);

    const lookalikes = parseQuestionBlock("question", `Pick\n\n- **Alpha:** more\n- alpha\n  for reads\n- Alpha — x`)!;
    expect(lookalikes.choices.map((c) => c.label)).toEqual(["**Alpha:** more", "alpha for reads", "Alpha"]);
    // "alpha" is exactly the second bullet's first line, its 0.28.1 label.
    expect(canonicalQuestionAnswer(lookalikes, stored("alpha")).selected).toEqual(["alpha for reads"]);
    // "ALPHA" matches several choices only after normalization: ambiguous.
    expect(canonicalQuestionAnswer(lookalikes, stored("ALPHA")).selected).toEqual(["ALPHA"]);
    // A current label is never remapped.
    expect(canonicalQuestionAnswer(lookalikes, stored("Alpha")).selected).toEqual(["Alpha"]);
  });

  test("the lettered rule: plain bullets only, case-sensitive, per part on a multi question", () => {
    const plain = (rec: string, kind = "question-multi") =>
      parseQuestionBlock(kind, `Pick\n\n- a. Local, kept on the device\n- b. Server, kept per user\n- c. Nowhere at all\n\nRecommended: ${rec}`)!
        .choices.map((c) => c.recommended);
    expect(plain("a. Local, b. Server")).toEqual([true, true, false]);
    expect(plain("a. Local and b. Server")).toEqual([true, true, false]);
    expect(plain("a. Local; c. Nowhere")).toEqual([true, false, true]);
    expect(plain("b. Default off; launch can allow it", "question")).toEqual([false, true, false]);
    expect(plain("A. Smith's proposal is better", "question")).toEqual([false, false, false]);

    // Task lists match exactly as on main (0.28.1): the letter alone names
    // nothing, and a multi list is split as before.
    const tasks = (rec: string, kind = "question-multi") =>
      parseQuestionBlock(kind, `Pick\n\n- [ ] a. Local\n- [ ] b. Server\n- [ ] c. Nowhere\n\nRecommended: ${rec}`)!;
    expect(tasks("a. Local, b. Server").choices.map((c) => c.recommended)).toEqual([true, true, false]);
    expect(tasks("a. Local; c. Nowhere").choices.map((c) => c.recommended)).toEqual([true, false, true]);
    const single = tasks("b. Default off", "question");
    expect(single.choices.map((c) => c.recommended)).toEqual([false, false, false]);
    expect(single.suggestedText).toBe("b. Default off");
    expect(tasks("A. Local", "question").choices.map((c) => c.recommended)).toEqual([true, false, false]);
  });

  test("a recommendation naming a lettered option matches the option with that letter", () => {
    const lettered = parseQuestionBlock(
      "question",
      `Merge?\n\n- **a. It stops at "ready".** It waits.\n- **b. "May merge when green", a checkbox.** Off by default.\n\n**Recommendation:** b. Default off; the launcher can allow it.`,
    )!;
    expect(lettered.choices.map((c) => c.recommended)).toEqual([false, true]);
    // Two labels sharing the letter: no guess.
    const twice = parseQuestionBlock("question", `Merge?\n\n- a. One\n- a) Two\n\nRecommended: a. whichever`)!;
    expect(twice.choices.every((c) => !c.recommended)).toBe(true);
  });
});

describe("question identity", () => {
  test("the key ignores case, whitespace and emphasis but not the kind", () => {
    expect(questionKey("single", "Where  is **it**?")).toBe(questionKey("single", "where is it?"));
    expect(questionKey("single", "Where is it?")).not.toBe(questionKey("multi", "Where is it?"));
    expect(questionKey("single", "Where is it?")).toMatch(/^q-[0-9a-f]{8}$/);
  });

  test("indexQuestionBlocks numbers, locates and de-duplicates questions", () => {
    const blocks = [
      { id: "block-0", type: "heading", content: "Plan", startLine: 1 },
      { id: "block-1", type: "directive", directiveKind: "question", content: "\nSame?\n- [ ] a", startLine: 3 },
      { id: "block-2", type: "directive", directiveKind: "note", content: "not a question", startLine: 8 },
      { id: "block-3", type: "directive", directiveKind: "question", content: "- [ ] no prompt", startLine: 11 },
      { id: "block-4", type: "directive", directiveKind: "question", content: "Same?\n- [ ] a", startLine: 14 },
    ];
    const index = indexQuestionBlocks(blocks);
    expect(index.map((q) => [q.blockId, q.number, q.line])).toEqual([
      ["block-1", 1, 5],
      ["block-4", 2, 15],
    ]);
    expect(index[1].question.key).toBe(`${index[0].question.key}-2`);
  });
});

const answer = (over: Partial<QuestionAnswer>): QuestionAnswer => ({
  v: 1,
  key: "q-0000000a",
  kind: "single",
  prompt: "Where?",
  selected: [],
  ...over,
});

describe("parseQuestionAnswer", () => {
  test("accepts a well-formed answer and drops unknown or empty fields", () => {
    const parsed = parseQuestionAnswer({ ...answer({ selected: ["A", "A", " "], other: "", note: "n" }), extra: 1 });
    expect(parsed).toEqual(answer({ selected: ["A"], note: "n" }));
  });

  test("fails closed on malformed input", () => {
    for (const bad of [
      null,
      "x",
      [],
      { ...answer({}), v: 2 },
      { ...answer({}), key: "../etc" },
      { ...answer({}), kind: "rank" },
      { ...answer({}), selected: "A" },
      { ...answer({}), selected: [1] },
      { ...answer({}), note: 3 },
      { ...answer({}), skipped: "yes" },
      { ...answer({}), sourceLine: -1 },
    ]) {
      expect(parseQuestionAnswer(bad)).toBeNull();
    }
  });

  test("truncates to the caps", () => {
    const parsed = parseQuestionAnswer(answer({ prompt: "p".repeat(900), text: "t".repeat(9000), selected: Array.from({ length: 30 }, (_, i) => `c${i}`) }))!;
    expect(parsed.prompt.length).toBe(400);
    expect(parsed.text!.length).toBe(4000);
    expect(parsed.selected.length).toBe(20);
  });
});

describe("answer helpers", () => {
  const indexed = indexQuestionBlocks([
    { id: "block-1", type: "directive", directiveKind: "question-multi", content: "Which?\n- [ ] A\n- [ ] B\n- [ ] C\nRecommended: A, C", startLine: 2 },
  ])[0];

  test("recommendedQuestionAnswer fills the recommended choices and clears a skip", () => {
    const rec = recommendedQuestionAnswer(indexed, answer({ key: indexed.question.key, kind: "multi", skipped: true, note: "keep" }))!;
    expect(rec.selected).toEqual(["A", "C"]);
    expect(rec.skipped).toBeUndefined();
    expect(rec.note).toBe("keep");
  });

  test("empty answers and the one-line text", () => {
    expect(isQuestionAnswerEmpty(answer({}))).toBe(true);
    expect(isQuestionAnswerEmpty(answer({ skipped: true }))).toBe(false);
    expect(formatQuestionAnswerText(answer({ selected: ["A"], other: "x\ny", note: "why" }))).toBe("Answer: A; Other: x y — note: why");
    expect(formatQuestionAnswerText(answer({ skipped: true }))).toBe("Skipped");
  });

  test("buildQuestionAnswerAnnotation carries the answer on a stable id", () => {
    const a = answer({ selected: ["A"] });
    const record = buildQuestionAnswerAnnotation("block-1", a, 5);
    expect(record).toMatchObject({ id: "ann-question-q-0000000a", blockId: "block-1", type: "COMMENT", originalText: "Where?", createdA: 5 });
    expect(record.questionAnswer).toBe(a);
  });
});

describe("formatQuestionAnswersSection", () => {
  const blocks = [
    { id: "b1", type: "directive", directiveKind: "question", content: SPEC_BODY, startLine: 21 },
    { id: "b2", type: "directive", directiveKind: "question", content: "Background sync?\n- [ ] Yes\n- [ ] No", startLine: 33 },
    { id: "b3", type: "directive", directiveKind: "question-multi", content: "Which indicators?\n- [ ] Dot\n- [ ] Banner\n- [ ] Toasts", startLine: 44 },
    { id: "b4", type: "directive", directiveKind: "question-text", content: "Describe the manual test.", startLine: 57 },
    { id: "b5", type: "directive", directiveKind: "question", content: "Transport?\n- [x] REST\n- [ ] WS", startLine: 70 },
  ];
  const index = indexQuestionBlocks(blocks);
  const items = questionExportItems(index);
  const key = (n: number) => index[n - 1].question.key;

  test("reports answers in document order with notes, lists, quotes and the open questions", () => {
    const out = formatQuestionAnswersSection(items, [
      answer({ key: key(3), kind: "multi", prompt: "Which indicators?", selected: ["Dot", "Banner"] }),
      answer({ key: key(1), prompt: "Where…", selected: ["Local only, purged after 30 days"], note: "keep it reachable" }),
      answer({ key: key(2), prompt: "Background sync?", other: "foreground only" }),
    ]);
    expect(out).toBe(`## Answers to your questions

3 of 4 questions answered. 1 already settled in the document was left as is.

### Q1. Where should losing conflict versions be kept? (line 22)
Answer: Local only, purged after 30 days (your recommendation)
Note: keep it reachable

### Q2. Background sync? (line 34)
Answer: Other: foreground only

### Q3. Which indicators? (line 45)
Answer:
- Dot
- Banner

### Unanswered
- Q4. Describe the manual test. (line 58)

`);
  });

  test("free text is quoted, a skip is reported, and a stale answer is kept", () => {
    const out = formatQuestionAnswersSection(items, [
      answer({ key: key(4), kind: "text", prompt: "Describe", text: "Two phones.\nOne offline." }),
      answer({ key: key(2), prompt: "Background sync?", skipped: true, note: "not sure yet" }),
      answer({ key: "q-deadbeef", prompt: "An old question", selected: ["Old"] }),
    ], { headingLevel: 3 });
    expect(out).toContain("#### Q2. Background sync? (line 34)\nSkipped\nNote: not sure yet\n");
    expect(out).toContain("#### Q4. Describe the manual test. (line 58)\nAnswer:\n> Two phones.\n> One offline.\n");
    expect(out).toContain("#### An old question (this question is no longer in the document)\nAnswer: Old\n");
    expect(out.startsWith("### Answers to your questions\n\n1 of 4 questions answered.")).toBe(true);
  });

  test("changing a settled question reports it and counts it", () => {
    const out = formatQuestionAnswersSection(items, [answer({ key: key(5), prompt: "Transport?", selected: ["WS"] })]);
    expect(out).toContain("1 of 5 questions answered.\n");
    expect(out).toContain("### Q5. Transport? (line 71)\nAnswer: WS\n");
  });

  test("a note alone on a settled question counts it answered by the settled choice", () => {
    // PR 1 review: the note printed alone and the question read as unanswered.
    const out = formatQuestionAnswersSection(items, [answer({ key: key(5), prompt: "Transport?", note: "REST is fine for v1" })]);
    expect(out).toContain("1 of 5 questions answered.\n");
    expect(out).toContain("### Q5. Transport? (line 71)\nAnswer: REST (already settled in the document)\nNote: REST is fine for v1\n");
  });

  test("a multi-line note keeps its line breaks; a one-line note stays on the Note line", () => {
    const multi = formatQuestionAnswersSection(items, [
      answer({ key: key(1), prompt: "Where", selected: ["Nowhere"], note: "First line.\nSecond line." }),
    ]);
    expect(multi).toContain("Answer: Nowhere\nNote:\n> First line.\n> Second line.\n");
    const single = formatQuestionAnswersSection(items, [answer({ key: key(1), prompt: "Where", selected: ["Nowhere"], note: "one line" })]);
    expect(single).toContain("Answer: Nowhere\nNote: one line\n");
  });

  test("no reportable answer means no section", () => {
    expect(formatQuestionAnswersSection(items, [])).toBe("");
    expect(formatQuestionAnswersSection(items, [answer({ key: key(1) })])).toBe("");
  });
});

describe("questionStatus", () => {
  const parsed = (body: string) => parseQuestionBlock("question", body)!;
  const settledQ = parsed("Transport?\n- [x] REST\n- [ ] WS");
  const openQ = parsed("Transport?\n- [ ] REST\n- [ ] WS");
  const base = (over: Partial<QuestionAnswer>): QuestionAnswer => ({ v: 1, key: settledQ.key, kind: "single", prompt: "Transport?", selected: [], ...over });

  test("answered beats skipped beats settled beats open; a note alone changes nothing", () => {
    expect(questionStatus(openQ)).toBe("open");
    expect(questionStatus(openQ, base({ note: "hm" }))).toBe("open");
    expect(questionStatus(settledQ)).toBe("settled");
    expect(questionStatus(settledQ, base({ note: "hm" }))).toBe("settled");
    expect(questionStatus(settledQ, base({ skipped: true }))).toBe("skipped");
    expect(questionStatus(settledQ, base({ selected: ["WS"] }))).toBe("answered");
    expect(questionStatus(openQ, base({ other: "gRPC" }))).toBe("answered");
  });
});

describe("Replaces: lines (the Plannotator Inbox)", () => {
  const OLD = "msg_01M4H6G73M9H3Z32T859E72DPY/q-4f7db09f";

  test("are read wherever they sit, never as the prompt or context, and leave the key alone", () => {
    const plain = parseQuestionBlock("question", "Retry a 409?\n\n- [ ] Yes\n- [ ] No");
    for (const body of [`Replaces: ${OLD}\nRetry a 409?\n\n- [ ] Yes\n- [ ] No`, `Retry a 409?\n\nreplaces:  ${OLD}\n\n- [ ] Yes\n- [ ] No`]) {
      const parsed = parseQuestionBlock("question", body)!;
      expect(parsed.prompt).toBe("Retry a 409?");
      expect(parsed.context).toBe("");
      expect(parsed.replaces).toEqual([OLD]);
      expect(parsed.key).toBe(plain!.key);
    }
  });

  test("take several ids, and a value that is not an id stays prose", () => {
    const parsed = parseQuestionBlock("question-text", `Why?\nReplaces: ${OLD}, msg_01M4H6G73M9H3Z32T859E72DPZ; q-12345678`)!;
    expect(parsed.replaces).toEqual([OLD, "msg_01M4H6G73M9H3Z32T859E72DPZ", "q-12345678"]);
    const prose = parseQuestionBlock("question-text", "Why?\nReplaces: the legacy cache")!;
    expect(prose.replaces).toBeUndefined();
    expect(prose.context).toBe("Replaces: the legacy cache");
  });

  test("a value that only starts like an id stays prose; a trailing period on an id is dropped", () => {
    for (const line of ["Replaces: q-learning with PPO for the agent.", "Replaces: msg_ queue drain approach", `Replaces: ${OLD} and the other one`]) {
      const parsed = parseQuestionBlock("question-text", `Why?\n${line}`)!;
      expect(parsed.replaces).toBeUndefined();
      expect(parsed.context).toBe(line);
    }
    const prompt = parseQuestionBlock("question-text", "Replaces: q-learning with PPO\nWhy?")!;
    expect(prompt.prompt).toBe("Replaces: q-learning with PPO");
    expect(parseQuestionBlock("question-text", `Why?\nReplaces: ${OLD}.`)!.replaces).toEqual([OLD]);
  });
});

// The owner's 0.28.17 report: a task-list choice longer than 200 characters
// could never be picked in the Inbox ("… is not one of the question's
// choices") and never showed as picked in plan review, because the answer's
// `selected` was cut to 200 characters while the label was not.
const LONG_SPIKE =
  "Spike first. Find out what the sign-in grants (a Claude subscription paying for turns the platform runs?) and whether Anthropic allows it for a third-party product; the placeholder stays off the product until both answers are in";
// The same text as a long label set off from a short "why" by ` - ` / ` — `:
// the label before the separator is still over 200 characters.
const LONG_DASH = `${LONG_SPIKE} - keeps it reversible`;
const LONG_EM = `${LONG_SPIKE} — keeps it reversible`;
// The short-lead form (` - ` right after the lead) splits as always.
const SHORT_LEAD = "Spike first - find out what the sign-in grants (a Claude subscription paying for turns the platform runs?) and whether Anthropic allows it for a third-party product; the placeholder stays off the product until both answers are in";

describe("long task-list choices (picked as written)", () => {
  const block = (choice: string) => `Which way?\n\n- [ ] ${choice}\n- [ ] Ship it now`;

  for (const [name, choice] of [
    ["no separator", LONG_SPIKE],
    ["a ' - ' separator", LONG_DASH],
    ["a ' — ' separator", LONG_EM],
  ] as const) {
    test(`${name}: the label round-trips through parseQuestionAnswer whole`, () => {
      const q = parseQuestionBlock("question", block(choice))!;
      const label = q.choices[0].label;
      expect(label.length).toBeGreaterThan(200);
      const saved = parseQuestionAnswer({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] })!;
      expect(saved.selected).toEqual([label]);
      expect(questionStatus(q, saved)).toBe("answered");
      const index = indexQuestionBlocks([{ id: "b", type: "directive", directiveKind: "question", content: block(choice), startLine: 1 }]);
      const out = formatQuestionAnswersSection(questionExportItems(index), [saved]);
      expect(out).toContain(`Answer: ${label}`);
    });
  }

  test("the separators keep their label/description split", () => {
    for (const choice of [LONG_DASH, LONG_EM]) {
      const q = parseQuestionBlock("question", block(choice))!;
      expect(q.choices[0]).toMatchObject({ label: LONG_SPIKE, description: "keeps it reversible" });
    }
    const short = parseQuestionBlock("question", block(SHORT_LEAD))!;
    expect(short.choices[0].label).toBe("Spike first");
    expect(short.choices[0].description).toStartWith("find out what");
  });

  test("an answer an older build cut at 200 characters maps back to the one choice it names", () => {
    const q = parseQuestionBlock("question", block(LONG_SPIKE))!;
    const cut = LONG_SPIKE.slice(0, 200);
    const stored: QuestionAnswer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [cut] };
    expect(canonicalQuestionAnswer(q, stored).selected).toEqual([LONG_SPIKE]);
    // Two choices sharing their first 200 characters: ambiguous, left as stored.
    const twin = parseQuestionBlock("question", `Which way?\n\n- [ ] ${LONG_SPIKE}\n- [ ] ${LONG_SPIKE.slice(0, 200)} but later`)!;
    expect(canonicalQuestionAnswer(twin, stored).selected).toEqual([cut]);
  });

  test("the export prints the full label for an answer an older build cut at 200 characters", () => {
    const index = indexQuestionBlocks([{ id: "b", type: "directive", directiveKind: "question", content: block(LONG_SPIKE), startLine: 1 }]);
    const q = index[0].question;
    const cut: QuestionAnswer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [LONG_SPIKE.slice(0, 200)] };
    const out = formatQuestionAnswersSection(questionExportItems(index), [cut]);
    expect(out).toContain(`Answer: ${LONG_SPIKE}`);
  });

  test("a long label adds no looser matching: only its exact 200-character cut maps", () => {
    const q = parseQuestionBlock("question", block(LONG_SPIKE))!;
    expect(q.choices.some((c) => c.aliases)).toBe(false);
    const stored = (label: string): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] });
    // Case or punctuation never maps here, as in a question with no long label.
    const loose = stored("ship it now.");
    expect(canonicalQuestionAnswer(q, loose)).toBe(loose);
    const cutLoose = stored(LONG_SPIKE.slice(0, 200).toUpperCase());
    expect(canonicalQuestionAnswer(q, cutLoose)).toBe(cutLoose);
  });

  test("selected stays bounded: a label longer than any block body is cut", () => {
    const parsed = parseQuestionAnswer(answer({ selected: ["x".repeat(30_000)] }))!;
    expect(parsed.selected[0].length).toBe(20_000);
  });
});
