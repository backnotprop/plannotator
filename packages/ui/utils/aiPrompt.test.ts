import { describe, test, expect } from "bun:test";
import { buildReviewContextPreamble } from "./aiPrompt.ts";
import { buildDefaultPrompt } from "../hooks/useAIChat.ts";
import { elementIdentityForAskAI } from "./parser";

describe("buildReviewContextPreamble", () => {
  const command =
    "Changeset: the code changes against the base branch 'main'.\nRun `git diff main..HEAD` to inspect the changes.";
  const pasted = "Code changes:\n\n```diff\ndiff --git a/foo.ts\n+x\n```";

  test("no context → empty string", () => {
    expect(buildReviewContextPreamble(undefined, { changed: true })).toBe("");
    expect(buildReviewContextPreamble("", { changed: true })).toBe("");
    expect(buildReviewContextPreamble("   ", { changed: false })).toBe("");
  });

  test("changed → full context (command)", () => {
    expect(buildReviewContextPreamble(command, { changed: true })).toBe(command);
  });

  test("changed → full context even when pasted (e.g. switched to full-stack mid-chat)", () => {
    expect(buildReviewContextPreamble(pasted, { changed: true })).toContain("```diff");
  });

  test("unchanged + pasted → short reminder, never re-pastes the diff", () => {
    const out = buildReviewContextPreamble(pasted, { changed: false });
    expect(out).not.toContain("```");
    expect(out).not.toContain("diff --git");
    expect(out.toLowerCase()).toContain("still reviewing");
  });

  test("unchanged + command → restates the (short) command", () => {
    // Command contexts are short and the agent benefits from the reminder of
    // exactly what to run, so they are restated rather than dropped.
    expect(buildReviewContextPreamble(command, { changed: false })).toContain(
      "git diff main..HEAD",
    );
  });
});

describe("buildDefaultPrompt with contextPreamble", () => {
  test("prepends the preamble before the question", () => {
    const out = buildDefaultPrompt({ prompt: "why is this async?", contextPreamble: "CTX" });
    expect(out.startsWith("CTX")).toBe(true);
    expect(out).toContain("why is this async?");
    expect(out.indexOf("CTX")).toBeLessThan(out.indexOf("why is this async?"));
  });

  test("preamble leads the file/line note too", () => {
    const out = buildDefaultPrompt({
      prompt: "explain",
      contextPreamble: "CTX",
      filePath: "src/a.ts",
      lineStart: 3,
      lineEnd: 5,
      side: "new",
    });
    expect(out.indexOf("CTX")).toBeLessThan(out.indexOf("Re: src/a.ts"));
  });

  test("preamble leads the viewing note", () => {
    const out = buildDefaultPrompt({
      prompt: "q",
      contextPreamble: "CTX",
      viewing: { scope: "file", filePath: "src/b.ts" },
    });
    expect(out.indexOf("CTX")).toBeLessThan(out.indexOf("currently viewing src/b.ts"));
  });

  test("no preamble → unchanged behavior", () => {
    expect(buildDefaultPrompt({ prompt: "hi" })).toBe("hi");
    expect(buildDefaultPrompt({ prompt: "hi", contextPreamble: "   " })).toBe("hi");
  });
});

// Failure to catch: an Ask AI question asked from an image pinpoint reaching
// the model (SDK provider or "Ask this session", which both send this
// prompt) as a bare "[element: Image]" with nothing that says WHICH image.
describe("buildDefaultPrompt — pinpointed element identity", () => {
  const imageTarget = {
    text: '[element: Image "Team photo" (team.jpg)]',
    anchor: { selector: 'img[alt="Team photo"]' },
    context: {
      tag: "img",
      path: "body > main > div.gallery > img:nth-of-type(2)",
      role: "img",
      name: "Team photo",
      attrs: [["src", "https://cdn.test/img/team.jpg?…"], ["alt", "Team photo"]],
      outline: '<img src="https://cdn.test/img/team.jpg?…" alt="Team photo">',
    },
  };

  test("the question carries the element's selector, path and src, without the outline", () => {
    const detail = elementIdentityForAskAI([imageTarget]);
    const out = buildDefaultPrompt({
      prompt: "which photo is this?",
      scope: { kind: "selection", label: "Selected HTML", text: imageTarget.text, detail },
    });
    expect(out).toContain('img[alt="Team photo"]');
    expect(out).toContain("body > main > div.gallery > img:nth-of-type(2)");
    expect(out).toContain("team.jpg");
    expect(out).toContain('**name** "Team photo"');
    expect(out).not.toContain("````html");
    expect(out.indexOf("team.jpg")).toBeLessThan(out.indexOf("which photo is this?"));
  });

  test("several pinpointed elements are numbered so each stays distinguishable", () => {
    const second = {
      text: "[element: Image (logo.svg)]",
      anchor: { selector: "#logo" },
      context: { tag: "img", attrs: [["src", "/logo.svg"]] },
    };
    const detail = elementIdentityForAskAI([imageTarget, second]);
    expect(detail).toContain('Element 1: "[element: Image');
    expect(detail).toContain('Element 2: "[element: Image (logo.svg)]"');
    expect(detail).toContain("`#logo`");
  });

  test("Ask AI carries no query strings: not in the selector's href rung, not in the live route", () => {
    const link = {
      text: "Checkout",
      anchor: { selector: 'a[href="/checkout?session=abc123#tok"]' },
      context: {
        tag: "a",
        attrs: [["href", "/checkout?…"]],
        page: { url: "/cart?coupon=SECRET", title: "Cart" },
      },
    };
    const detail = elementIdentityForAskAI([link]);
    expect(detail).toContain('a[href="/checkout?…"]');
    expect(detail).toContain("`/cart?…`");
    expect(detail).not.toContain("session=abc123");
    expect(detail).not.toContain("SECRET");
  });

  test("a selection with no element context asks exactly what it asked before", () => {
    expect(elementIdentityForAskAI([{ text: "plain words", anchor: null }])).toBe("");
    const scope = { kind: "selection" as const, label: "Selected HTML", text: "plain words" };
    expect(buildDefaultPrompt({ prompt: "q", scope: { ...scope, detail: "" } })).toBe(
      buildDefaultPrompt({ prompt: "q", scope }),
    );
  });
});

// Failure to catch (#1731): a text selection whose phrase appears more than
// once in the document reaching the agent as a bare path, so it cannot tell
// which occurrence the question is about.
describe("buildDefaultPrompt — source lines of a text selection", () => {
  const scope = { kind: "selection" as const, label: "Selected text", text: "retry the job", sourcePath: "/docs/plan.md" };

  test("the Source line names the selection's line", () => {
    const out = buildDefaultPrompt({ prompt: "why?", scope: { ...scope, lineStart: 41, lineEnd: 41 } });
    expect(out).toContain("\nSource: /docs/plan.md, line 41\n");
  });

  test("a selection over several lines names the range", () => {
    const out = buildDefaultPrompt({ prompt: "why?", scope: { ...scope, lineStart: 41, lineEnd: 44 } });
    expect(out).toContain("\nSource: /docs/plan.md, lines 41–44\n");
  });

  test("lines without a path still name the location", () => {
    const { sourcePath: _omit, ...noPath } = scope;
    const out = buildDefaultPrompt({ prompt: "why?", scope: { ...noPath, lineStart: 7 } });
    expect(out).toContain("\nSource: line 7\n");
  });

  test("a scope without lines (or with an invalid one) asks exactly what it asked before", () => {
    const before = buildDefaultPrompt({ prompt: "q", scope });
    expect(before).toContain("\nSource: /docs/plan.md\n");
    expect(buildDefaultPrompt({ prompt: "q", scope: { ...scope, lineStart: 0 } })).toBe(before);
    expect(buildDefaultPrompt({ prompt: "q", scope: { ...scope, lineStart: Number.NaN } })).toBe(before);
  });
});
