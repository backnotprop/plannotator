import { describe, expect, test } from "bun:test";
import { derivePersonThreadSubject, PERSON_THREAD_NAME_COLUMNS, PERSON_THREAD_NAME_WORDS, suggestPersonThreadName } from "./inbox-questions";

function columns(text: string): number {
  let n = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
    const cp = segment.codePointAt(0)!;
    n += (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff) ? 2 : 1;
  }
  return n;
}

const TABLE: [string, string][] = [
  ["I want to explore what adding a board would look like. Kanban specifically. And the kanban needs to be well thought out.", "Kanban board"],
  ["can you fix the paste bug in the reply box", "Paste bug"],
  ["Hey, where did we get with the portless setup?", "Portless setup"],
  ["Hey Claude, can you look at why the build is failing on main? It started this morning.", "Build failing"],
  ["Should we use Postgres or SQLite for the inbox store?", "Postgres or SQLite"],
  ["Let's add dark mode to the settings page", "Dark mode"],
  ["The relay retries too often when the phone is offline", "Relay retries"],
  ["Look into the flaky e2e tests on CI", "Flaky e2e tests"],
  ["I think the problem is in the relay retry code", "Relay retry code"],
  ["Please rename the inbox_tool knob", "inbox_tool knob"],
  ["Thoughts on switching to pnpm?", "pnpm"],
  ["so I've been thinking about the inbox lately and I want a way to see every thread by state", "Inbox"],
  ["We need a better onboarding flow for first-time users of the VS Code extension", "Onboarding flow"],
  ["Quick question: does the paste handler work in Safari?", "Paste handler"],
  ["Reply box loses focus after picking an answer", "Reply box"],
  ["Can you write tests for the markdown preview?", "Markdown preview"],
  ["Fix the crash in packages/inbox/compose/ComposeDialog.tsx", "Crash"],
  ["https://github.com/backnotprop/plannotator/pull/1934", "PR 1934"],
  ["Hey can you check https://github.com/backnotprop/plannotator/pull/1934#issuecomment-123 and tell me what you think", "PR 1934"],
  ["https://github.com/backnotprop/plannotator/issues/12", "Issue 12"],
  ["https://example.com/docs/getting-started", "Getting started"],
  ["What do you think?", ""],
  ["thoughts?", ""],
  ["ok", ""],
  ["Hey Claude", ""],
  ["```\nerror: cannot find module\n```", ""],
  ["supercalifragilisticexpialidociousness is great", ""],
  ["🔥🔥🔥", ""],
  ["看板ボードを追加したらどうなるか検討したいです。特にカンバン方式で。", "看板ボード"],
  ["我想给收件箱加一个看板视图", "看板视图"],
  ["칸반 보드를 추가하고 싶어요", "칸반 보드"],
  ["¿Puedes arreglar el error de pegado en la caja de respuesta?", "Error de pegado"],
  ["Je voudrais un mode sombre pour les paramètres", "Mode sombre"],
  ["Kannst du dir den Login-Flow auf dem iPad ansehen?", "Login-Flow"],
  ["<script>alert(1)</script>", ""],
  ["can you fix the pa\u200bste bug", "Paste bug"],
  ["So I want to make the thing work better", "Thing work better"],
  ["I think we should do it", ""],
  ["日本語のテキストです。カンバンボードを追加したいです。", "カンバンボード"],
  ["![](./design/board-mock.png)", "Board mock"],
  ["Look at this ![Checkout drawer](./shots/c.png)", "Checkout drawer"],
];

describe("suggestPersonThreadName: compose fills the thread's chip with a short name", () => {
  for (const [body, name] of TABLE) {
    test(`${JSON.stringify(body.slice(0, 50))} → ${JSON.stringify(name)}`, () => {
      expect(suggestPersonThreadName(body)).toBe(name);
    });
  }

  test("every name is short: at most three words and 24 columns, never ending in punctuation", () => {
    for (const [body] of TABLE) {
      const name = suggestPersonThreadName(body);
      expect(columns(name)).toBeLessThanOrEqual(PERSON_THREAD_NAME_COLUMNS);
      expect(name.split(" ").filter(Boolean).length).toBeLessThanOrEqual(PERSON_THREAD_NAME_WORDS);
      expect(name).not.toMatch(/[\s.,;:!?…]$/);
    }
  });

  test("never cut in a word: every word of the name is a whole word of the message", () => {
    const body = "Let's make the notification permission prompt less annoying on first launch";
    const name = suggestPersonThreadName(body);
    expect(name).not.toBe("");
    for (const word of name.toLowerCase().split(" ")) expect(body.toLowerCase().split(/\s+/)).toContain(word);
  });

  test("a body with no words names itself from an attached file", () => {
    expect(suggestPersonThreadName("", { files: ["relay-retry-budget.md"] })).toBe("Relay retry budget");
    expect(suggestPersonThreadName("", { files: ["pasted-image-2026-10-16-1405.png"] })).toBe("");
  });

  test("a 1 MB line (an unclosed link, tag or image) is named in milliseconds, not minutes: the markdown rules read only its start", () => {
    for (const evil of ["[x](y".repeat(200_000), "<a ".repeat(330_000), "![a](b".repeat(170_000), "[".repeat(1_000_000), "word ".repeat(200_000)]) {
      const started = performance.now();
      suggestPersonThreadName(evil);
      derivePersonThreadSubject(evil);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  test("never throws on anything", () => {
    expect(suggestPersonThreadName(undefined as unknown as string)).toBe("");
    expect(suggestPersonThreadName("‮" + "x".repeat(10_000))).toBe("");
  });
});
