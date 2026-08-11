import { describe, test, expect } from "bun:test";
import { parseMarkdownToBlocks, computeListIndices, extractFrontmatter, exportAnnotations, resolveReferenceLinks } from "./parser";
import { shouldStripFrontmatter } from "@plannotator/core/annotatable";
import type { Block } from "../types";

/** Tiny factory for list-item blocks used by computeListIndices tests. */
const li = (level: number, ordered: boolean, orderedStart?: number): Block => ({
  id: `b${Math.random()}`,
  type: "list-item",
  content: "",
  level,
  ordered: ordered || undefined,
  orderedStart,
  order: 0,
  startLine: 1,
});

describe("resolveReferenceLinks (#923)", () => {
  test("resolves full, collapsed, and shortcut references to inline links", () => {
    expect(resolveReferenceLinks("[text][id]\n\n[id]: https://e.com")).toBe(
      "[text](https://e.com)\n\n",
    );
    expect(resolveReferenceLinks("[text][]\n\n[text]: https://e.com")).toBe(
      "[text](https://e.com)\n\n",
    );
    expect(resolveReferenceLinks("[text]\n\n[text]: https://e.com")).toBe(
      "[text](https://e.com)\n\n",
    );
  });

  test("matches labels case-insensitively and collapses internal whitespace", () => {
    expect(resolveReferenceLinks("[Text][My  Ref]\n\n[my ref]: https://e.com")).toBe(
      "[Text](https://e.com)\n\n",
    );
  });

  test("supports the angle-bracket destination form and reference images", () => {
    expect(resolveReferenceLinks("[x][id]\n\n[id]: <https://e.com>")).toBe(
      "[x](https://e.com)\n\n",
    );
    expect(resolveReferenceLinks("![alt][id]\n\n[id]: /img.png")).toBe(
      "![alt](/img.png)\n\n",
    );
  });

  test("uses the first definition when a label is defined more than once", () => {
    expect(
      resolveReferenceLinks("[id]: https://one.com\n[id]: https://two.com\n\n[x][id]"),
    ).toBe("\n\n\n[x](https://one.com)");
  });

  test("leaves unknown references and non-reference brackets untouched", () => {
    expect(resolveReferenceLinks("[text][missing].")).toBe("[text][missing].");
    // No definitions at all: fast path returns the input unchanged.
    expect(resolveReferenceLinks("array [0] and [TODO] here")).toBe(
      "array [0] and [TODO] here",
    );
    // A shortcut that does not name a definition stays literal even when other
    // definitions exist. The definition itself is never consumed by anything
    // in this document, so it stays visible too (PR #1168: unused definitions
    // are not blanked).
    expect(resolveReferenceLinks("[TODO] and [0]\n\n[id]: https://e.com")).toBe(
      "[TODO] and [0]\n\n[id]: https://e.com",
    );
  });

  test("does not double-link an inline link whose text matches a definition", () => {
    // The inline link uses its own explicit URL and never consumes the
    // definition, so the definition stays visible (PR #1168).
    expect(
      resolveReferenceLinks("[text](https://real.com)\n\n[text]: https://def.com"),
    ).toBe("[text](https://real.com)\n\n[text]: https://def.com");
  });

  test("never rewrites references inside fenced code blocks or inline code spans", () => {
    // Both definitions are only ever "referenced" from inside a protected
    // region (a fence, an inline code span), so neither reference resolves
    // and neither definition is consumed — both stay visible verbatim
    // (PR #1168).
    expect(resolveReferenceLinks("```\n[a][b]\n```\n\n[b]: https://e.com")).toBe(
      "```\n[a][b]\n```\n\n[b]: https://e.com",
    );
    expect(resolveReferenceLinks("use `[a][b]` here\n\n[b]: https://e.com")).toBe(
      "use `[a][b]` here\n\n[b]: https://e.com",
    );
  });

  test("does not collect a definition that sits inside a fenced code block", () => {
    // The only `[id]:` is inside code, so `[id]` outside stays a literal shortcut.
    expect(
      resolveReferenceLinks("```\n[id]: https://code.com\n```\n\n[id]"),
    ).toBe("```\n[id]: https://code.com\n```\n\n[id]");
  });

  test("does not treat prose with an invalid title as a definition", () => {
    expect(
      resolveReferenceLinks("[Reminder]: call the bank tomorrow\n\n[Reminder]"),
    ).toBe("[Reminder]: call the bank tomorrow\n\n[Reminder]");
  });

  test("does not corrupt bare space-delimited numbers on a resolved line", () => {
    expect(resolveReferenceLinks("value is 0 and 1 and [x][id]\n\n[id]: https://e.com")).toBe(
      "value is 0 and 1 and [x](https://e.com)\n\n",
    );
  });

  test("blanks definition lines in place so block start-lines stay accurate", () => {
    const blocks = parseMarkdownToBlocks("[id]: https://e.com\n\n# Heading\n\ntext [x][id]");
    // The definition line renders nothing; the heading and paragraph keep their
    // original source line numbers.
    const heading = blocks.find((b) => b.type === "heading");
    const paragraph = blocks.find((b) => b.type === "paragraph");
    expect(heading?.startLine).toBe(3);
    expect(paragraph?.startLine).toBe(5);
    expect(paragraph?.content).toBe("text [x](https://e.com)");
    expect(blocks.some((b) => b.content.includes("[id]: https://e.com"))).toBe(false);
  });

  test("does not delete a definition-shaped line that continues a paragraph", () => {
    // CommonMark: a definition cannot interrupt a paragraph. The second line
    // must survive as content, not be silently blanked.
    expect(resolveReferenceLinks("The config keys are:\n[timeout]: 30")).toBe(
      "The config keys are:\n[timeout]: 30",
    );
    expect(resolveReferenceLinks("text before\n[id]: url\nmore [x][id]")).toBe(
      "text before\n[id]: url\nmore [x][id]",
    );
  });

  test("collects a definition after a blank line, a code fence, or another definition", () => {
    expect(resolveReferenceLinks("[a]: https://one.com\n[b]: https://two.com\n\n[x][a] [y][b]")).toBe(
      "\n\n\n[x](https://one.com) [y](https://two.com)",
    );
    expect(resolveReferenceLinks("```\ncode\n```\n[id]: https://e.com\n\n[x][id]")).toBe(
      "```\ncode\n```\n\n\n[x](https://e.com)",
    );
  });

  test("does not clobber a checked task-list item when an [x] definition exists", () => {
    // The checkbox guard means the task-list `[x]` never resolves as a
    // reference, so the "x" definition is never consumed and stays visible
    // (PR #1168).
    expect(resolveReferenceLinks("- [x] done task\n- [ ] todo\n\n[x]: https://e.com")).toBe(
      "- [x] done task\n- [ ] todo\n\n[x]: https://e.com",
    );
    expect(resolveReferenceLinks("1. [x] done\n\n[x]: https://e.com")).toBe(
      "1. [x] done\n\n[x]: https://e.com",
    );
  });

  test("resolves the shortcut image form", () => {
    expect(resolveReferenceLinks("![id]\n\n[id]: /img.png")).toBe("![id](/img.png)\n\n");
  });
});

describe("resolveReferenceLinks — owner review fixups (PR #1168)", () => {
  test("does not rewrite a reference inside a fence indented 4+ spaces (block parser still treats it as code)", () => {
    // The block parser detects a fence via `trimmed.startsWith('```')` after a
    // full `.trim()` — ANY indentation still opens a code block. The resolver
    // must recognize the exact same fence, not just fences within 3 spaces.
    const md = "    ```\n    [a][b]\n    ```\n\n[b]: https://e.com";
    // The code content must survive verbatim, and since "b" is never consumed
    // outside the code fence, the definition itself must remain visible too —
    // as its own trailing paragraph, not silently dropped.
    expect(parseMarkdownToBlocks(md).map((b) => b.type)).toEqual(["code", "paragraph"]);
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("does not rewrite a reference inside a fence nested inside a list item at 4+ spaces", () => {
    const md = "- outer\n  - inner\n    ```\n    [a][b]\n    ```\n\n[b]: https://e.com";
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("protects a link definition sitting inside a <details> raw HTML block", () => {
    const md = "<details>\n<summary>Notes</summary>\n\n[id]: https://from-details.com\n\n</details>";
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("protects references and definitions inside a <pre> raw HTML block", () => {
    const md = "<pre>\n[a][b]\n</pre>\n\n[b]: https://e.com";
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("a reference used only inside a <details> block never counts as consumed, so the definition stays visible", () => {
    const md = "<details>\n\n[x][id]\n\n</details>\n\n[id]: https://e.com";
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("does not treat a GFM footnote definition ([^label]: ...) as a link reference definition", () => {
    // A footnote body that is a bare token (looks exactly like a definition
    // destination) is the real hazard — prose bodies with spaces already fail
    // the destination shape by accident.
    const md = "See the note.[^1]\n\n[^1]: https://example.com/footnote";
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("does not clobber a footnote reference ([^1]) that happens to share a label with a real definition", () => {
    const md = "See[^1] and [x][1]\n\n[^1]: https://footnote.com\n\n[1]: https://real-def.com";
    expect(resolveReferenceLinks(md)).toBe(
      "See[^1] and [x](https://real-def.com)\n\n[^1]: https://footnote.com\n\n",
    );
  });

  test("leaves an entirely unused link reference definition visible", () => {
    expect(resolveReferenceLinks("[id]: https://e.com\n\nSome unrelated text.")).toBe(
      "[id]: https://e.com\n\nSome unrelated text.",
    );
  });

  test("leaves a definition visible when its only reference sits inside a fenced code block", () => {
    const md = "```\n[x][id]\n```\n\n[id]: https://e.com";
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("still blanks every definition line for a label once it is genuinely consumed, including redefinitions", () => {
    expect(
      resolveReferenceLinks("[id]: https://one.com\n[id]: https://two.com\n\n[x][id]"),
    ).toBe("\n\n\n[x](https://one.com)");
  });

  test("preserves total line count for a document mixing consumed, unused, and protected definitions", () => {
    const md = [
      "# Heading",
      "",
      "[used]: https://used.com",
      "[unused]: https://unused.com",
      "",
      "text [x][used]",
      "",
      "```",
      "[y][coded]",
      "```",
      "",
      "[coded]: https://coded.com",
    ].join("\n");
    const resolved = resolveReferenceLinks(md);
    expect(resolved.split("\n").length).toBe(md.split("\n").length);
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.find((b) => b.type === "heading")?.startLine).toBe(1);
    // "unused" and "coded" (only referenced inside the fence) must remain
    // visible; only the genuinely consumed "used" definition is blanked.
    expect(resolved).toContain("[unused]: https://unused.com");
    expect(resolved).toContain("[coded]: https://coded.com");
    expect(resolved).not.toContain("[used]: https://used.com");
    expect(resolved).toContain("text [x](https://used.com)");
  });

  test("supports CRLF documents and preserves the CRLF line endings", () => {
    const md = "[text][id]\r\n\r\n[id]: https://e.com\r\n";
    expect(resolveReferenceLinks(md)).toBe("[text](https://e.com)\r\n\r\n\r\n");
  });

  test("leaves an unconsumed CRLF definition visible with its line ending intact", () => {
    const md = "[id]: https://e.com\r\n\r\nunrelated text\r\n";
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("does not exhibit quadratic slowdown on a long run of unmatched '[' characters", () => {
    const junk = "[".repeat(200_000);
    const md = `${junk}\n\n[id]: https://e.com`;
    const start = performance.now();
    const result = resolveReferenceLinks(md);
    const elapsed = performance.now() - start;
    // A naive unbounded backtracking scan would take many seconds to minutes
    // here; a bounded one-pass scan finishes in well under a second.
    expect(elapsed).toBeLessThan(1500);
    expect(result.startsWith(junk)).toBe(true);
  });

  test("caps reference/definition label length so a single pathological label cannot force backtracking", () => {
    const longLabel = "x".repeat(1500);
    const md = `[text][${longLabel}]\n\n[${longLabel}]: https://e.com`;
    // Deliberate safe degradation: a label above the bound is not resolved
    // and its definition-shaped line is not collected either, so both sides
    // are left untouched rather than partially/incorrectly rewritten.
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("is idempotent: resolving an already-resolved document is a no-op", () => {
    const inputs = [
      "[text][id]\n\n[id]: https://e.com",
      "![alt][id]\n\n[id]: /img.png",
      "```\n[a][b]\n```\n\n[b]: https://e.com",
      "- [x] done\n\n[x]: https://e.com",
      "<pre>\n[a][b]\n</pre>\n\n[b]: https://e.com",
      "[id]: https://e.com\n\nunused elsewhere",
      "See[^1]\n\n[^1]: https://footnote.com",
    ];
    for (const md of inputs) {
      const once = resolveReferenceLinks(md);
      const twice = resolveReferenceLinks(once);
      expect(twice).toBe(once);
    }
  });

  test("aligns tilde-fence handling with the block parser (neither treats ~~~ as a code fence)", () => {
    const md = "~~~\n[a][b]\n~~~\n\n[b]: https://e.com";
    expect(parseMarkdownToBlocks(md).some((b) => b.type === "code")).toBe(false);
    expect(resolveReferenceLinks(md)).toBe("~~~\n[a](https://e.com)\n~~~\n\n");
  });

  test("resolves a destination containing a closing parenthesis", () => {
    expect(resolveReferenceLinks("[x][id]\n\n[id]: https://e.com/a(b)")).toBe(
      "[x](https://e.com/a(b))\n\n",
    );
  });

  test("backslash-escaped brackets never resolve, and their captured (unusable) label leaves the definition visible", () => {
    const md = "Not a ref: \\[text\\]\\[id\\]\n\n[id]: https://e.com";
    expect(resolveReferenceLinks(md)).toBe(md);
  });

  test("a genuinely nested-bracket shortcut does not corrupt the destination pipeline or crash", () => {
    // Unescaped nested brackets in link text are not legal CommonMark; the
    // simplified single-pass scanner does not fully recover the intended
    // reference, but it must never throw and must never do something that
    // could bypass URL sanitization later.
    const md = "[outer [inner] text][id]\n\n[id]: https://e.com";
    expect(() => resolveReferenceLinks(md)).not.toThrow();
    const result = resolveReferenceLinks(md);
    expect(result).toContain("https://e.com");
  });

  test("dangerous destinations still go through sanitizeLinkUrl identically to a hand-written inline link", () => {
    // resolveReferenceLinks only ever emits `[text](dest)`, so it reuses the
    // exact same inline-link rendering/sanitization path — it must never
    // special-case or bypass it.
    const resolved = resolveReferenceLinks("[x][id]\n\n[id]: javascript:alert(1)");
    expect(resolved).toBe("[x](javascript:alert(1))\n\n");
    // The literal string is unchanged (dangerous-protocol stripping happens
    // downstream in sanitizeLinkUrl at render time), confirming this pass
    // does not attempt — and therefore cannot get wrong — its own filtering.
  });
});

describe("parseMarkdownToBlocks — code fences", () => {
  /**
   * Baseline: the common triple-backtick fence still works after the nested-
   * fence fix. Regression guard so we don't break normal plans.
   */
  test("triple-backtick fence produces a single code block", () => {
    const md = "```js\nconsole.log('hi');\n```";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].language).toBe("js");
    expect(blocks[0].content).toBe("console.log('hi');");
  });

  /**
   * A 4-backtick fence is used to embed a triple-backtick fence inside a code
   * block (e.g. showing a markdown example). Before the fix the inner ``` would
   * prematurely close the block, producing broken output.
   */
  test("4-backtick fence treats inner triple-backtick as content", () => {
    const md = "````md\n```js\ncode\n```\n````";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].content).toBe("```js\ncode\n```");
  });

  /**
   * Ensure the language tag is still extracted correctly when the fence uses
   * more than three backticks.
   */
  test("4-backtick fence preserves language tag", () => {
    const md = "````markdown\nhello\n````";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe("markdown");
  });

  /**
   * 5-backtick fence should allow both ``` and ```` lines as content,
   * only closing on a line of 5+ backticks.
   */
  test("5-backtick fence treats 3- and 4-backtick lines as content", () => {
    const md = "`````\n````\n```\n`````";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].content).toBe("````\n```");
  });

  /**
   * A closing fence may have more backticks than the opener (CommonMark §4.5).
   * We support this so plans generated by tools that follow the spec parse
   * correctly.
   */
  test("closing fence with more backticks than opener still closes the block", () => {
    const md = "````\ncontent\n`````";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("content");
  });

  /**
   * Text before and after a nested-fence block must still parse into their own
   * blocks — the nested-fence fix must not swallow surrounding content.
   */
  test("nested-fence block does not swallow surrounding paragraphs", () => {
    const md = "intro\n\n````\n```\nnested\n```\n````\n\noutro";
    const blocks = parseMarkdownToBlocks(md);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(["paragraph", "code", "paragraph"]);
    expect(blocks[1].content).toBe("```\nnested\n```");
  });

  /**
   * An unclosed fence at end-of-file should produce a code block containing
   * whatever content was seen (CommonMark §4.5: unclosed fences extend to EOF).
   */
  test("unclosed fence at EOF produces a code block with seen content", () => {
    const md = "```js\nconst x = 1;";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].language).toBe("js");
    expect(blocks[0].content).toBe("const x = 1;");
  });

  /**
   * A fence opener as the very last line of the document (no content, no
   * closing fence) should produce an empty code block rather than crashing.
   */
  test("fence opener as last line produces an empty code block", () => {
    const md = "```ts";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].language).toBe("ts");
    expect(blocks[0].content).toBe("");
  });

  /**
   * Indented code fences (e.g. inside list items in a plan) must close when
   * the closing fence is equally indented. Before the fix, the closing fence
   * regex required backticks at column 0, so indented ``` never matched and
   * the code block swallowed everything to EOF.
   */
  test("indented closing fence closes the code block", () => {
    const md = "- Replace with reads:\n  ```ts\n  const x = 1;\n  ```\n- Next item";
    const blocks = parseMarkdownToBlocks(md);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual(["list-item", "code", "list-item"]);
    expect(blocks[1].content).toBe("  const x = 1;");
    expect(blocks[2].content).toBe("Next item");
  });

  /**
   * A closing fence with trailing text (e.g. ``` some comment) should still
   * close the block. Before the fix, the regex required only whitespace after
   * backticks, so trailing text caused the fence to swallow everything to EOF.
   */
  test("closing fence with trailing text still closes the block", () => {
    const md = "```js\nconst x = 1;\n``` this is ignored\nafter";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].content).toBe("const x = 1;");
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].content).toBe("after");
  });

  test("deeply indented fence closes correctly", () => {
    const md = "    ```py\n    print('hi')\n    ```\nafter";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].language).toBe("py");
    expect(blocks[0].content).toBe("    print('hi')");
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].content).toBe("after");
  });
});

describe("parseMarkdownToBlocks — display math", () => {
  test("multi-line $$ block produces a math block", () => {
    const md = "$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("math");
    expect(blocks[0].content).toBe("\\int_0^1 x^2 dx = \\frac{1}{3}");
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(3);
  });

  test("single-line $$ block produces a math block", () => {
    const blocks = parseMarkdownToBlocks("before\n\n$$ E = mc^2 $$\n\nafter");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(blocks[1].content).toBe("E = mc^2");
    expect(blocks[1].startLine).toBe(3);
    expect(blocks[1].sourceLineCount).toBe(1);
  });

  test("display math does not swallow following paragraphs", () => {
    const md = "$$\na^2 + b^2 = c^2\n$$\n\nText after.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["math", "paragraph"]);
    expect(blocks[1].content).toBe("Text after.");
  });

  test("unclosed display math does NOT swallow the rest of the document", () => {
    // A stray/unclosed $$ (or informal money like "$$100k") must not consume every
    // following block to EOF — it's treated as ordinary text and later content
    // (headings, paragraphs) is preserved. Mirrors the unclosed-HTML-tag policy.
    const blocks = parseMarkdownToBlocks("$$\nx + y\n\n## Later heading\n\nMore text.");
    expect(blocks.some((b) => b.type === "math")).toBe(false);
    expect(blocks.some((b) => b.type === "heading" && b.content === "Later heading")).toBe(true);
    expect(blocks.some((b) => b.content === "More text.")).toBe(true);
  });

  test("unclosed $$ does not pair with a stray $$ inside a later code fence", () => {
    // The close-tag scan stops at a blank line, so an unterminated $$ can't reach
    // (and pair with) a $$ that appears far below inside a code fence — which would
    // otherwise swallow every heading/paragraph in between into one broken block.
    const md = "$$\n\\theta = x\n\n## Next\n\n```\nnot math $$ here\n```\n\n## After";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.every((b) => !(b.type === "math" && b.content.length > 100))).toBe(true);
    expect(blocks.some((b) => b.type === "heading" && b.content === "Next")).toBe(true);
    expect(blocks.some((b) => b.type === "heading" && b.content === "After")).toBe(true);
    expect(blocks.some((b) => b.type === "code")).toBe(true);
  });

  test("empty single-line display math does not swallow following content", () => {
    const blocks = parseMarkdownToBlocks("$$$$\n\nAfter");
    expect(blocks.map((b) => b.type)).toEqual(["math", "paragraph"]);
    expect(blocks[0].content).toBe("");
    expect(blocks[1].content).toBe("After");
  });

  test("multi-line \\[ block produces a math block", () => {
    const md = "\\[\n\\int_0^1 x^2 dx = \\frac{1}{3}\n\\]";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("math");
    expect(blocks[0].content).toBe("\\int_0^1 x^2 dx = \\frac{1}{3}");
    expect(blocks[0].startLine).toBe(1);
    expect(blocks[0].sourceLineCount).toBe(3);
  });

  test("single-line \\[ block produces a math block", () => {
    const blocks = parseMarkdownToBlocks("before\n\n\\[ E = mc^2 \\]\n\nafter");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(blocks[1].content).toBe("E = mc^2");
    expect(blocks[1].startLine).toBe(3);
    expect(blocks[1].sourceLineCount).toBe(1);
  });

  // Regression: the closing $$ was only recognized when it was the last thing
  // on the line, so a trailing char (a period) or trailing words made the line
  // look like an unterminated opener and swallowed the rest of the document.
  test("$$ closing with a trailing period does not swallow following content", () => {
    const md = "$$E = mc^2$$.\n\n## Next\n\nBody.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["math", "paragraph", "heading", "paragraph"]);
    expect(blocks[0].content).toBe("E = mc^2");
    expect(blocks[1].content).toBe(".");
    expect(blocks[2].content).toBe("Next");
  });

  test("$$ closing with trailing words keeps the trailing text as a paragraph", () => {
    const md = "$$E = mc^2$$ where E is energy.\n\n## Deploy";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["math", "paragraph", "heading"]);
    expect(blocks[0].content).toBe("E = mc^2");
    expect(blocks[1].content).toBe("where E is energy.");
  });

  test("multi-line $$ whose closing line has trailing text does not swallow", () => {
    const md = "$$\na + b\n= c $$ done\n\nNext.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["math", "paragraph", "paragraph"]);
    expect(blocks[0].content).toBe("a + b\n= c ");
    expect(blocks[1].content).toBe("done");
    expect(blocks[2].content).toBe("Next.");
  });

  test("\\[ closing with a trailing period does not swallow following content", () => {
    const md = "\\[a^2 + b^2 = c^2\\].\n\n## Next\n\nBody.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(["math", "paragraph", "heading", "paragraph"]);
    expect(blocks[0].content).toBe("a^2 + b^2 = c^2");
    expect(blocks[1].content).toBe(".");
    expect(blocks[2].content).toBe("Next");
  });
});

describe("parseMarkdownToBlocks — tables", () => {
  test("pipe-delimited table parses correctly", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("table");
  });

  /**
   * Prose containing pipe characters (e.g. TypeScript union types in inline
   * code) must NOT be treated as a table. Before the fix, the regex
   * matched any line with 2+ pipes.
   */
  test("paragraph with inline code containing pipes is not a table", () => {
    const md = "The type is `'scroll' | 'wrap'` and supports `'a' | 'b' | 'c'` values.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toBe(md);
  });

  test("paragraph with multiple pipes in prose is not a table", () => {
    const md = "Use option A | B | C depending on context.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  test("real-world plan: prose with union types is not a table", () => {
    const md = "`@pierre/diffs` supports `overflow: 'scroll' | 'wrap'` plus options, but Plannotator doesn't expose any of them.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });
});

describe("parseMarkdownToBlocks — real-world plan regression", () => {
  test("indented code fence inside list does not swallow rest of plan", () => {
    const md = [
      "### 5. Migrate App.tsx",
      "",
      "- **Remove** `useState` for `diffStyle`",
      "- **Replace** with ConfigStore reads:",
      "  ```ts",
      "  const diffStyle = useConfigValue('diffStyle');",
      "  ```",
      "- **Update** toolbar toggle handler",
      "",
      "### 6. Update DiffViewer",
    ].join("\n");
    const blocks = parseMarkdownToBlocks(md);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading",      // ### 5. Migrate App.tsx
      "list-item",    // - **Remove**
      "list-item",    // - **Replace**
      "code",         // ```ts ... ```
      "list-item",    // - **Update**
      "heading",      // ### 6. Update DiffViewer
    ]);
    expect(blocks[3].type).toBe("code");
    expect(blocks[3].language).toBe("ts");
    expect(blocks[4].type).toBe("list-item");
    expect(blocks[5].type).toBe("heading");
  });
});

describe("parseMarkdownToBlocks — list continuation lines", () => {
  test("indented continuation line merges into preceding list item", () => {
    const md = "- First item with text\n  that continues here\n- Second item";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].content).toBe("First item with text\nthat continues here");
    expect(blocks[1].type).toBe("list-item");
    expect(blocks[1].content).toBe("Second item");
  });

  test("multiple continuation lines merge into one list item", () => {
    const md = "- Line one\n  line two\n  line three\n- Next";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].content).toBe("Line one\nline two\nline three");
  });

  test("non-indented line after list item starts a new paragraph", () => {
    const md = "- Item\nNot indented";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].content).toBe("Not indented");
  });

  test("blank line between list item and indented text merges as loose continuation", () => {
    const md = "- Item\n\n  Indented paragraph";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].content).toBe("Item\n\nIndented paragraph");
  });

  test("loose continuation with multiple paragraphs", () => {
    const md = "- Item\n\n  Para one\n\n  Para two";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].content).toBe("Item\n\nPara one\n\nPara two");
  });

  test("loose continuation stops at non-indented line", () => {
    const md = "- Item\n\n  Indented\n\nNot indented";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].content).toBe("Item\n\nIndented");
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].content).toBe("Not indented");
  });

  test("loose continuation stops at next list item", () => {
    const md = "- First\n\n  Body of first\n\n- Second";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].content).toBe("First\n\nBody of first");
    expect(blocks[1].type).toBe("list-item");
    expect(blocks[1].content).toBe("Second");
  });

  test("loose continuation works with ordered lists", () => {
    const md = "1. First\n\n   Body of first\n\n2. Second";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].ordered).toBe(true);
    expect(blocks[0].content).toBe("First\n\nBody of first");
    expect(blocks[1].type).toBe("list-item");
    expect(blocks[1].content).toBe("Second");
  });

  test("loose continuation with mixed tight and loose lines", () => {
    const md = "- Item\n\n  Para one\n  still para one\n\n  Para two";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].content).toBe("Item\n\nPara one\nstill para one\n\nPara two");
  });

  test("single-space indent after blank line does not merge (insufficient indentation)", () => {
    const md = "- Item\n\n Barely indented";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[1].type).toBe("paragraph");
  });

  test("continuation does not swallow nested list items", () => {
    const md = "- Parent\n  - Child\n- Sibling";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].content).toBe("Parent");
    expect(blocks[1].type).toBe("list-item");
    expect(blocks[1].content).toBe("Child");
    expect(blocks[2].type).toBe("list-item");
    expect(blocks[2].content).toBe("Sibling");
  });

  test("continuation works when list item follows a blank line", () => {
    const md = "Some paragraph\n\n- Item with continuation\n  that continues here";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[1].type).toBe("list-item");
    expect(blocks[1].content).toBe("Item with continuation\nthat continues here");
  });

  test("block-level elements after list items are not swallowed", () => {
    const md = "- Item\n# Heading";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[1].type).toBe("heading");
  });
});

describe("parseMarkdownToBlocks — ordered lists", () => {
  test("numeric markers produce ordered list items with orderedStart", () => {
    const md = "1. first\n2. second";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("list-item");
    expect(blocks[0].ordered).toBe(true);
    expect(blocks[0].orderedStart).toBe(1);
    expect(blocks[0].content).toBe("first");
    expect(blocks[1].ordered).toBe(true);
    expect(blocks[1].orderedStart).toBe(2);
    expect(blocks[1].content).toBe("second");
  });

  test("ordered list can start at an arbitrary number", () => {
    const md = "5. five\n6. six";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].orderedStart).toBe(5);
    expect(blocks[1].orderedStart).toBe(6);
  });

  test("bullet markers stay unordered (no ordered flag)", () => {
    const md = "- a\n* b";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].ordered).toBeUndefined();
    expect(blocks[0].orderedStart).toBeUndefined();
    expect(blocks[1].ordered).toBeUndefined();
  });

  test("mixed bullet/numeric/bullet run preserves per-item ordered flag", () => {
    const md = "- a\n1. b\n- c";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].ordered).toBeUndefined();
    expect(blocks[1].ordered).toBe(true);
    expect(blocks[1].orderedStart).toBe(1);
    expect(blocks[2].ordered).toBeUndefined();
  });

  test("nested ordered item inside an unordered parent keeps its ordered flag", () => {
    const md = "- parent\n  1. child\n  2. child two";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].ordered).toBeUndefined();
    expect(blocks[0].level).toBe(0);
    expect(blocks[1].ordered).toBe(true);
    expect(blocks[1].level).toBe(1);
    expect(blocks[1].orderedStart).toBe(1);
    expect(blocks[2].ordered).toBe(true);
    expect(blocks[2].level).toBe(1);
    expect(blocks[2].orderedStart).toBe(2);
  });

  test("continuation line on an ordered item merges into content and preserves ordered flag", () => {
    const md = "1. first item\n   continuation\n2. second";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].ordered).toBe(true);
    expect(blocks[0].content).toBe("first item\ncontinuation");
    expect(blocks[1].ordered).toBe(true);
    expect(blocks[1].orderedStart).toBe(2);
  });

  test("numeric checkbox sets both ordered and checked", () => {
    const md = "1. [ ] todo task\n2. [x] done task";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].ordered).toBe(true);
    expect(blocks[0].checked).toBe(false);
    expect(blocks[0].content).toBe("todo task");
    expect(blocks[1].ordered).toBe(true);
    expect(blocks[1].checked).toBe(true);
    expect(blocks[1].content).toBe("done task");
  });

  test("'1.5 second' is not parsed as a list item (no whitespace after the dot)", () => {
    const md = "1.5 second response time";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].ordered).toBeUndefined();
  });

  test("heading branch wins over list branch for '### 1. Foo'", () => {
    const md = "### 1. Foo";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("heading");
  });
});

describe("parseMarkdownToBlocks — blockquotes", () => {
  test("consecutive '>' lines merge into one blockquote block", () => {
    const md = "> line one\n> line two\n> line three";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].content).toBe("line one\nline two\nline three");
  });

  test("blank line between '>' lines starts a new blockquote block", () => {
    const md = "> first\n\n> second";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].content).toBe("first");
    expect(blocks[1].type).toBe("blockquote");
    expect(blocks[1].content).toBe("second");
  });

  test("blockquote followed by paragraph does not absorb the paragraph", () => {
    const md = "> quote\nparagraph";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].content).toBe("quote");
    expect(blocks[1].type).toBe("paragraph");
  });

  test("paragraph followed by blockquote does not merge", () => {
    const md = "intro\n> quote";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[1].type).toBe("blockquote");
    expect(blocks[1].content).toBe("quote");
  });

  test("single-line blockquote still produces one block", () => {
    const md = "> just one";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].content).toBe("just one");
  });

  test("quoted ordered list does NOT merge — each '> N.' line stays as its own block", () => {
    // Regression guard for review comment #7. Merging would flatten the
    // markers into run-on inline text; keeping them as separate blockquote
    // blocks preserves each line's visual identity.
    const md = "> 1. First item\n> 2. Second item\n> 3. Third item";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].content).toBe("1. First item");
    expect(blocks[1].type).toBe("blockquote");
    expect(blocks[1].content).toBe("2. Second item");
    expect(blocks[2].type).toBe("blockquote");
    expect(blocks[2].content).toBe("3. Third item");
  });

  test("quoted unordered list does NOT merge", () => {
    const md = "> - First\n> - Second\n> - Third";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks.every(b => b.type === "blockquote")).toBe(true);
    expect(blocks.map(b => b.content)).toEqual(["- First", "- Second", "- Third"]);
  });

  test("quoted heading does NOT merge into previous blockquote", () => {
    const md = "> intro text\n> # Heading inside quote\n> more text";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].content).toBe("intro text");
    expect(blocks[1].content).toBe("# Heading inside quote");
    expect(blocks[2].content).toBe("more text");
  });

  test("quoted code fence line does NOT merge", () => {
    const md = "> some prose\n> ```js\n> more prose";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].content).toBe("some prose");
    expect(blocks[1].content).toBe("```js");
    expect(blocks[2].content).toBe("more prose");
  });

  test("nested blockquote (> >) does NOT merge into the outer quote", () => {
    const md = "> outer quote\n> > nested quote\n> back to outer";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].content).toBe("outer quote");
    expect(blocks[1].content).toBe("> nested quote");
    expect(blocks[2].content).toBe("back to outer");
  });

  test("wrapped prose quote still merges (regression guard for the merge fix)", () => {
    // This is the case the merge fix was added for — a single logical
    // paragraph wrapped across multiple source lines. Must still merge.
    const md = "> This is a long quoted paragraph\n> that wraps across several\n> source lines for readability.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].content).toBe(
      "This is a long quoted paragraph\nthat wraps across several\nsource lines for readability."
    );
  });

  test("prose quote followed by a quoted list: prose merges, list lines stay separate", () => {
    const md = "> intro prose\n> that wraps here\n> 1. first step\n> 2. second step";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].content).toBe("intro prose\nthat wraps here");
    expect(blocks[1].content).toBe("1. first step");
    expect(blocks[2].content).toBe("2. second step");
  });

  test("multi-paragraph blockquote encodes paragraph break as double newline", () => {
    // The empty `>` line sits between two quoted paragraphs. We merge all
    // three `>` lines into one block, but the blank `>` becomes an empty
    // string, leaving a `\n\n` in the content so the renderer can split on
    // paragraph breaks and emit two <p> children.
    const md = "> first paragraph\n>\n> second paragraph";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].content).toBe("first paragraph\n\nsecond paragraph");
    expect(blocks[0].content.split(/\n\n+/)).toEqual([
      "first paragraph",
      "second paragraph",
    ]);
  });
});

describe("parseMarkdownToBlocks — GitHub alerts", () => {
  test("detects NOTE alert and strips marker from content", () => {
    const md = "> [!NOTE]\n> Useful information.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].alertKind).toBe("note");
    expect(blocks[0].content).toBe("Useful information.");
  });

  test("detects each GitHub alert kind, case-insensitive", () => {
    for (const kind of ["NOTE", "TIP", "WARNING", "CAUTION", "IMPORTANT"]) {
      const blocks = parseMarkdownToBlocks(`> [!${kind}]\n> body`);
      expect(blocks[0].alertKind).toBe(kind.toLowerCase() as 'note' | 'tip' | 'warning' | 'caution' | 'important');
    }
    const lower = parseMarkdownToBlocks("> [!note]\n> body");
    expect(lower[0].alertKind).toBe("note");
  });

  test("alert marker alone (no body) still tags the block", () => {
    const md = "> [!TIP]";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].alertKind).toBe("tip");
    expect(blocks[0].content).toBe("");
  });

  test("blockquote without marker has no alertKind", () => {
    const blocks = parseMarkdownToBlocks("> just a quote");
    expect(blocks[0].alertKind).toBeUndefined();
  });

  test("alert body absorbs a list, producing one block with list-formatted content", () => {
    const md = "> [!NOTE]\n> - first\n> - second";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].alertKind).toBe("note");
    expect(blocks[0].content).toBe("- first\n- second");
  });

  test("alert body absorbs a code fence", () => {
    const md = "> [!WARNING]\n> ```\n> danger\n> ```";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].alertKind).toBe("warning");
    expect(blocks[0].content).toBe("```\ndanger\n```");
  });

  test("blank line ends an alert", () => {
    const md = "> [!TIP]\n> body line\n\nafter";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].type).toBe("blockquote");
    expect(blocks[0].alertKind).toBe("tip");
    expect(blocks[0].content).toBe("body line");
    expect(blocks[1].type).toBe("paragraph");
  });

  test("marker-like text mid-quote is not treated as alert", () => {
    const md = "> intro\n> [!NOTE]";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].alertKind).toBeUndefined();
    expect(blocks[0].content).toBe("intro\n[!NOTE]");
  });
});

describe("parseMarkdownToBlocks — directive containers", () => {
  test("captures body between :::kind and :::", () => {
    const md = ":::note\nBody line.\n:::";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("directive");
    expect(blocks[0].directiveKind).toBe("note");
    expect(blocks[0].content).toBe("Body line.");
  });

  test("supports arbitrary kinds (info, success, danger)", () => {
    for (const kind of ["info", "success", "danger", "warning"]) {
      const blocks = parseMarkdownToBlocks(`:::${kind}\nbody\n:::`);
      expect(blocks[0].directiveKind).toBe(kind);
    }
  });

  test("multi-paragraph body keeps blank-line separator", () => {
    const md = ":::tip\npara 1\n\npara 2\n:::";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].content).toBe("para 1\n\npara 2");
  });

  test("unterminated directive absorbs rest of document", () => {
    // Not ideal, but prevents silent loss — user sees the whole body styled.
    const md = ":::note\nbody\nmore body";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("directive");
    expect(blocks[0].content).toBe("body\nmore body");
  });

  test(":::kind with extra spaces still parses", () => {
    const md = "::: note \nbody\n:::";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].type).toBe("directive");
    expect(blocks[0].directiveKind).toBe("note");
  });
});

describe("parseMarkdownToBlocks — raw HTML blocks", () => {
  test("<details>/<summary> parsed as a single html block", () => {
    const md = "<details>\n<summary>Title</summary>\nBody text\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(md);
  });

  test("blank line terminates the HTML block", () => {
    const md = "<details>\n<summary>T</summary>\n</details>\n\nAfter paragraph";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe("<details>\n<summary>T</summary>\n</details>");
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].content).toBe("After paragraph");
  });

  test("EOF terminates the HTML block", () => {
    const md = "<details>\n<summary>T</summary>\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("html");
  });

  test("paragraph before HTML block is separated correctly", () => {
    const md = "Some intro\n\n<details>\n<summary>T</summary>\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toBe("Some intro");
    expect(blocks[1].type).toBe("html");
  });

  test("non-allowlisted tag (<xyz>) falls through to paragraph — preserves prior behavior", () => {
    const md = "<xyz>not a block</xyz>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks[0].content).toBe("<xyz>not a block</xyz>");
  });

  test("inline HTML in the middle of a paragraph is NOT a block", () => {
    // Line does not start with `<tag`, so the paragraph path wins.
    const md = "Press <kbd>Ctrl</kbd> to submit";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });

  test("nested tags stay in one block", () => {
    const md = "<details>\n<summary>Outer</summary>\n<details>\n<summary>Inner</summary>\nnested\n</details>\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(md);
  });

  test("case-insensitive tag detection", () => {
    const md = "<DETAILS>\n<SUMMARY>T</SUMMARY>\n</DETAILS>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("html");
  });

  test("multiple HTML blocks separated by blank lines produce multiple blocks", () => {
    const md = "<details>\n<summary>A</summary>\n</details>\n\n<details>\n<summary>B</summary>\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("html");
    expect(blocks[1].type).toBe("html");
  });

  test("startLine points to first line of the HTML block", () => {
    const md = "intro\n\n<details>\n<summary>T</summary>\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[1].type).toBe("html");
    expect(blocks[1].startLine).toBe(3);
  });

  test("single-line inline HTML block (open + close on one line) is captured", () => {
    const md = "<details><summary>T</summary>body</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(md);
  });

  test("blank line inside <details> does NOT terminate the block (GitHub-flavored)", () => {
    const md = "<details>\n<summary>Title</summary>\n\nBody across blanks.\n\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(md);
  });

  test("nested same-tag open/close is balanced (not terminated by first close)", () => {
    const md = "<details>\n<summary>Outer</summary>\n<details>\n<summary>Inner</summary>\n</details>\nouter tail\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(md);
  });

  test("trailing paragraph after closed <details> is a separate block", () => {
    const md = "<details>\n<summary>T</summary>\n\nBody\n\n</details>\n\nAfter paragraph";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("html");
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].content).toBe("After paragraph");
  });
});

describe("parseMarkdownToBlocks / resolveReferenceLinks — unclosed-HTML-opener perf (PR #1168 follow-up)", () => {
  // Root cause: the balanced open/close depth scan for a multi-line HTML
  // block does not advance the outer index when it fails to find a closing
  // tag — so a document with many consecutive unclosed openers (e.g.
  // thousands of bare `<div>` lines with no `</div>` anywhere) makes EVERY
  // one of them independently re-scan all the way to end-of-document. That
  // is O(N^2) work for N such lines, a real DoS-shaped hazard well within
  // the 2MB annotate cap. Both markProtectedLines (used by
  // resolveReferenceLinks) and parseMarkdownToBlocks's own HTML-block
  // section duplicate this exact scan, so both must be fixed.
  const N = 8000;
  // Generous bound: a linear/bounded fix finishes in well under 100ms for
  // this input; the pre-fix O(N^2) scan takes multiple seconds (measured
  // ~2.2s for N=8000 during triage). 800ms leaves large machine-variance
  // headroom while still failing clearly against the quadratic behavior.
  const TIME_BOUND_MS = 800;

  test("parseMarkdownToBlocks stays fast with many consecutive unclosed <div> openers", () => {
    const md = Array.from({ length: N }, () => "<div>").join("\n");
    const start = performance.now();
    const blocks = parseMarkdownToBlocks(md);
    const elapsed = performance.now() - start;
    expect(blocks).toHaveLength(N);
    expect(blocks.every((b) => b.type === "html")).toBe(true);
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);
  });

  test("resolveReferenceLinks stays fast with many consecutive unclosed <div> openers", () => {
    const md =
      Array.from({ length: N }, () => "<div>").join("\n") +
      "\n\n[x][id]\n\n[id]: https://e.com";
    const start = performance.now();
    const result = resolveReferenceLinks(md);
    const elapsed = performance.now() - start;
    expect(result).toContain("[x](https://e.com)");
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);
  });

  test("parity: a real <details>...</details> block stays intact and identically protected/parsed among thousands of unclosed <div> decoys", () => {
    const decoyCount = 5000;
    const decoys = Array.from({ length: decoyCount }, () => "<div>").join("\n");
    const md =
      `${decoys}\n\n` +
      "<details>\n<summary>Notes</summary>\n\n[id]: https://from-details.com\n\n</details>" +
      "\n\nAfter.";

    const start = performance.now();
    const blocks = parseMarkdownToBlocks(md);
    const resolved = resolveReferenceLinks(md);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);

    // parseMarkdownToBlocks: the real <details> block is captured whole,
    // undisturbed by the decoys before it, followed by its own paragraph.
    const detailsBlock = blocks.find((b) => b.type === "html" && b.content.startsWith("<details>"));
    expect(detailsBlock).toBeDefined();
    expect(detailsBlock!.content).toBe(
      "<details>\n<summary>Notes</summary>\n\n[id]: https://from-details.com\n\n</details>",
    );
    const paragraph = blocks.find((b) => b.type === "paragraph" && b.content === "After.");
    expect(paragraph).toBeDefined();

    // resolveReferenceLinks: the SAME <details> span is protected — the
    // definition inside it is never consumed by anything, so it stays
    // visible verbatim, exactly mirroring the block parser's own boundary
    // for this block (not corrupted, not partially rewritten).
    expect(resolved).toContain("[id]: https://from-details.com");
  });
});

describe("parseMarkdownToBlocks / resolveReferenceLinks — long valid HTML blocks must not be truncated (owner follow-up on 9440be06)", () => {
  // Regression: a fixed MAX_HTML_BLOCK_SCAN_LINES cap on the balanced
  // open/close depth scan incorrectly cut off VALID HTML blocks whose
  // closing tag sits beyond the cap. closeExistsFromLine already rejects a
  // truly-unclosed opener in O(1) without scanning at all, so a genuinely
  // closed block — however long — should simply be scanned once to its
  // real end, not capped. A cap that can truncate valid parsing is not an
  // acceptable trade-off no matter how generous its value.
  const N_UNCLOSED = 40_000;
  const TIME_BOUND_MS = 1500;

  test("a <details> block with its closing tag more than 2000 lines below the opener stays one whole html block", () => {
    const innerLineCount = 2500; // deliberately past the old 2000-line cap
    const inner = Array.from({ length: innerLineCount }, (_, i) => `body line ${i}`).join("\n");
    const md = `<details>\n<summary>Big</summary>\n${inner}\n</details>\n\nAfter.`;

    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(`<details>\n<summary>Big</summary>\n${inner}\n</details>`);
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].content).toBe("After.");
  });

  test("a raw HTML <table> block with its closing tag more than 2000 lines below the opener stays one whole html block", () => {
    const rowCount = 2200; // deliberately past the old 2000-line cap
    const rows = Array.from({ length: rowCount }, (_, i) => `<tr><td>${i}</td></tr>`).join("\n");
    const md = `<table>\n${rows}\n</table>\n\nAfter table.`;

    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(`<table>\n${rows}\n</table>`);
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].content).toBe("After table.");
  });

  test("a link definition inside a long (>2000-line) <details> block stays protected by resolveReferenceLinks, and never wins over a real outside definition", () => {
    const innerLineCount = 2500;
    const filler = Array.from({ length: innerLineCount }, (_, i) => `body line ${i}`).join("\n");
    // Same label defined both inside the (protected) details block and
    // outside it. If the interior is genuinely protected, the inside
    // definition is never collected at all, so the outside one — the only
    // real candidate — wins and resolves the reference. If protection were
    // to end early (the truncation bug), the inside definition would be
    // collected FIRST (first-definition-wins) and incorrectly win instead,
    // and would incorrectly be blanked as "consumed" too.
    const md =
      `<details>\n<summary>Big</summary>\n${filler}\n\n[id]: https://inside-details.com\n\n</details>` +
      `\n\n[id]: https://outside.com\n\ntext [x][id]`;
    const resolved = resolveReferenceLinks(md);
    expect(resolved).toContain(`[id]: https://inside-details.com`); // stays visible, untouched
    expect(resolved).toContain("text [x](https://outside.com)"); // outside definition wins
    expect(resolved).not.toContain("[id]: https://outside.com\n"); // the real (consumed) one is blanked
  });

  test("40k unclosed <div> openers (no close anywhere) stay fast, with parity between parser and resolver", () => {
    const decoys = Array.from({ length: N_UNCLOSED }, () => "<div>").join("\n");
    const md = `${decoys}\n\n[x][id]\n\n[id]: https://e.com`;

    const parseStart = performance.now();
    const blocks = parseMarkdownToBlocks(md);
    const parseElapsed = performance.now() - parseStart;

    const resolveStart = performance.now();
    const resolved = resolveReferenceLinks(md);
    const resolveElapsed = performance.now() - resolveStart;

    expect(parseElapsed).toBeLessThan(TIME_BOUND_MS);
    expect(resolveElapsed).toBeLessThan(TIME_BOUND_MS);

    // Parity: every decoy is its own single-line html block to the parser...
    expect(blocks.filter((b) => b.type === "html")).toHaveLength(N_UNCLOSED);
    // ...and every decoy line is likewise individually protected (never
    // rewritten) by the resolver — same boundary, both call sites agree.
    expect(resolved).toContain("[x](https://e.com)");
    expect(resolved.split("\n").filter((l) => l === "<div>")).toHaveLength(N_UNCLOSED);
  });

  test("a long valid <details> block survives even when preceded by thousands of unclosed <div> decoys", () => {
    const decoyCount = 5000;
    const decoys = Array.from({ length: decoyCount }, () => "<div>").join("\n");
    const innerLineCount = 2500;
    const inner = Array.from({ length: innerLineCount }, (_, i) => `body line ${i}`).join("\n");
    const md = `${decoys}\n\n<details>\n<summary>Big</summary>\n${inner}\n</details>\n\nAfter.`;

    const start = performance.now();
    const blocks = parseMarkdownToBlocks(md);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);

    const detailsBlock = blocks.find((b) => b.type === "html" && b.content.startsWith("<details>"));
    expect(detailsBlock).toBeDefined();
    expect(detailsBlock!.content).toBe(`<details>\n<summary>Big</summary>\n${inner}\n</details>`);
    const paragraph = blocks.find((b) => b.type === "paragraph" && b.content === "After.");
    expect(paragraph).toBeDefined();
  });
});

describe("parseMarkdownToBlocks / resolveReferenceLinks — linear matching-close index (owner follow-up on a55db2b9)", () => {
  // Owner-flagged regression: removing the fixed cap fixed truncation but
  // reintroduced O(N^2) for a different adversarial shape — N unclosed
  // `<div>` openers followed by a SINGLE trailing `</div>`.
  // closeExistsFromLine's "does a close exist anywhere" pre-check is true
  // for every one of the N openers (the trailing close exists), so every
  // one of them still independently scans forward — most all the way to
  // end-of-document — before giving up. Measured (pre-fix): 5000 → ~1.0s,
  // 10000 → ~4.1s (textbook ~4x per doubling). Fixed by replacing the
  // scan entirely with a per-tag-name prefix-sum + "next smaller-or-equal
  // element" index (a classic O(N) monotonic-stack construction, built once
  // per tag name and cached per document), so every opener's closing
  // position — whether it exists, and exactly where if so, however far away
  // — is an O(1) lookup with no scanning at all.
  const N = 40_000;
  const TIME_BOUND_MS = 1500;

  test("N unclosed <div> openers followed by one trailing </div> stay fast", () => {
    const md = Array.from({ length: N }, () => "<div>").join("\n") + "\n</div>";

    const parseStart = performance.now();
    const blocks = parseMarkdownToBlocks(md);
    const parseElapsed = performance.now() - parseStart;
    expect(parseElapsed).toBeLessThan(TIME_BOUND_MS);

    // Only the LAST opener (immediately preceding the trailing close) can
    // actually pair with it — every earlier opener's cumulative depth
    // overshoots and never returns to its own baseline, so it stays an
    // unclosed, single-line block. N-1 singles + 1 paired block = N blocks.
    expect(blocks).toHaveLength(N);
    expect(blocks.slice(0, N - 1).every((b) => b.type === "html" && b.content === "<div>")).toBe(
      true,
    );
    expect(blocks[N - 1].type).toBe("html");
    expect(blocks[N - 1].content).toBe("<div>\n</div>");
  });

  test("resolveReferenceLinks stays fast and agrees with the parser on the same N-openers-plus-one-close document", () => {
    const md =
      Array.from({ length: N }, () => "<div>").join("\n") +
      "\n</div>\n\n[x][id]\n\n[id]: https://e.com";

    const start = performance.now();
    const resolved = resolveReferenceLinks(md);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(TIME_BOUND_MS);
    expect(resolved).toContain("[x](https://e.com)");
    // Every decoy line and the paired <div>/</div> stay literal (protected),
    // exactly mirroring the parser's block boundaries above.
    expect(resolved.split("\n").filter((l) => l === "<div>")).toHaveLength(N);
    expect(resolved).toContain("</div>");
  });

  test("nested same-tag blocks still balance correctly (depth, not just presence, matters)", () => {
    const md =
      "<details>\n<summary>Outer</summary>\n<details>\n<summary>Inner</summary>\n</details>\nouter tail\n</details>";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(md);
  });

  test("mixed tag types nest independently — a <table> inside a <details> does not confuse the details/details matcher", () => {
    const md =
      "<details>\n<summary>Notes</summary>\n<table>\n<tr><td>1</td></tr>\n</table>\nafter table\n</details>\n\nAfter.";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("html");
    expect(blocks[0].content).toBe(
      "<details>\n<summary>Notes</summary>\n<table>\n<tr><td>1</td></tr>\n</table>\nafter table\n</details>",
    );
    expect(blocks[1].content).toBe("After.");
  });

  test("a valid >2000-line <details> block still survives (no truncating cap reintroduced)", () => {
    const innerLineCount = 3000;
    const inner = Array.from({ length: innerLineCount }, (_, i) => `body line ${i}`).join("\n");
    const md = `<details>\n<summary>Big</summary>\n${inner}\n</details>\n\nAfter.`;
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe(`<details>\n<summary>Big</summary>\n${inner}\n</details>`);
  });
});

describe("computeListIndices", () => {
  test("all unordered → all null", () => {
    const blocks = [li(0, false), li(0, false), li(0, false)];
    expect(computeListIndices(blocks)).toEqual([null, null, null]);
  });

  test("simple ordered run numbers sequentially from orderedStart of first item", () => {
    const blocks = [li(0, true, 1), li(0, true, 2), li(0, true, 3)];
    expect(computeListIndices(blocks)).toEqual([1, 2, 3]);
  });

  test("ordered run starting at 5 numbers from 5", () => {
    const blocks = [li(0, true, 5), li(0, true, 6)];
    expect(computeListIndices(blocks)).toEqual([5, 6]);
  });

  test("renumbering ignores subsequent orderedStart values (CommonMark)", () => {
    // Source markdown `1. / 2. / 99.` should render as 1, 2, 3
    const blocks = [li(0, true, 1), li(0, true, 2), li(0, true, 99)];
    expect(computeListIndices(blocks)).toEqual([1, 2, 3]);
  });

  test("unordered item breaks the ordered streak; next ordered restarts from its orderedStart", () => {
    const blocks = [
      li(0, true, 1),
      li(0, true, 2),
      li(0, false),
      li(0, true, 1),
    ];
    expect(computeListIndices(blocks)).toEqual([1, 2, null, 1]);
  });

  test("unordered nested children do not break top-level numbering", () => {
    // 1. a
    //   - bullet
    //   - bullet
    // 2. b
    const blocks = [
      li(0, true, 1),
      li(1, false),
      li(1, false),
      li(0, true, 2),
    ];
    expect(computeListIndices(blocks)).toEqual([1, null, null, 2]);
  });

  test("nested ordered sublists number independently and reset between siblings", () => {
    // 1. a
    //   1. a.1
    //   2. a.2
    // 2. b
    //   1. b.1
    const blocks = [
      li(0, true, 1),
      li(1, true, 1),
      li(1, true, 2),
      li(0, true, 2),
      li(1, true, 1),
    ];
    expect(computeListIndices(blocks)).toEqual([1, 1, 2, 2, 1]);
  });

  test("ordered sublist after an unordered sub-bullet restarts from its source orderedStart", () => {
    // 1. a
    //   - bullet
    //   2. honored as 2 because the source said `2.`
    const blocks = [
      li(0, true, 1),
      li(1, false),
      li(1, true, 2),
    ];
    expect(computeListIndices(blocks)).toEqual([1, null, 2]);
  });

  test("mixed sub-bullets between ordered top-level items keep top-level streak alive", () => {
    // 1. a
    //   - sub
    // 2. b
    //   - sub
    // 3. c
    const blocks = [
      li(0, true, 1),
      li(1, false),
      li(0, true, 2),
      li(1, false),
      li(0, true, 3),
    ];
    expect(computeListIndices(blocks)).toEqual([1, null, 2, null, 3]);
  });

  test("empty input returns empty array", () => {
    expect(computeListIndices([])).toEqual([]);
  });

  test("single ordered item with no orderedStart defaults to 1", () => {
    const blocks = [{ ...li(0, true), orderedStart: undefined }];
    expect(computeListIndices(blocks)).toEqual([1]);
  });
});

describe("extractFrontmatter — contentStartLine", () => {
  test("no frontmatter → contentStartLine is 1", () => {
    const { contentStartLine } = extractFrontmatter("# Hello\nworld");
    expect(contentStartLine).toBe(1);
  });

  test("standard frontmatter offsets correctly", () => {
    const md = "---\ntitle: foo\ndate: bar\n---\n# Hello";
    const { contentStartLine, content } = extractFrontmatter(md);
    expect(content).toBe("# Hello");
    expect(contentStartLine).toBe(5);
  });

  test("frontmatter with blank line before content", () => {
    const md = "---\ntitle: foo\n---\n\n# Hello";
    const { contentStartLine } = extractFrontmatter(md);
    expect(contentStartLine).toBe(5);
  });

  test("unclosed frontmatter treated as no frontmatter", () => {
    const md = "---\ntitle: foo\n# Not closed";
    const { contentStartLine, content } = extractFrontmatter(md);
    expect(contentStartLine).toBe(1);
    expect(content).toBe(md);
  });
});

describe("extractFrontmatter — block scalars", () => {
  test("folded (>-) joins wrapped lines with spaces", () => {
    const md = `---
description: >-
  one two
  three four
---
# Hi`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.description).toBe("one two three four");
  });

  test("folded (>) treats a blank line as a paragraph break", () => {
    const md = `---
description: >
  one two
  three four

  five six
---
# Hi`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.description).toBe("one two three four\nfive six");
  });

  test("literal (|) preserves newlines", () => {
    const md = `---
note: |
  line one
  line two
---
# Hi`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.note).toBe("line one\nline two");
  });

  test("block scalar does not swallow the next key", () => {
    const md = `---
description: >-
  one two
  three
name: bar
---
# Hi`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.description).toBe("one two three");
    expect(frontmatter?.name).toBe("bar");
  });

  test("CRLF line endings do not leak \\r into the value", () => {
    const md = "---\r\ndescription: >-\r\n  one two\r\n  three\r\n---\r\n# Hi";
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.description).toBe("one two three");
  });

  test("plain single-line values and arrays still parse", () => {
    const md = `---
name: foo
tags:
  - a
  - b
---
# Hi`;
    const { frontmatter } = extractFrontmatter(md);
    expect(frontmatter?.name).toBe("foo");
    expect(frontmatter?.tags).toEqual(["a", "b"]);
  });
});

describe("parseMarkdownToBlocks — startLine accuracy", () => {
  test("basic blocks get correct startLine", () => {
    const md = "# Heading\n\nParagraph\n\n- Item";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].startLine).toBe(1); // # Heading
    expect(blocks[1].startLine).toBe(3); // Paragraph
    expect(blocks[2].startLine).toBe(5); // - Item
  });

  test("code block startLine points to the opening fence", () => {
    const md = "intro\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\noutro";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].startLine).toBe(1); // intro
    expect(blocks[1].startLine).toBe(3); // ```ts
    expect(blocks[1].type).toBe("code");
    expect(blocks[2].startLine).toBe(8); // outro
  });

  test("frontmatter shifts all startLines", () => {
    const md = "---\ntitle: test\n---\n\n# Heading\n\nParagraph";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[0].type).toBe("heading");
    expect(blocks[0].startLine).toBe(5);
    expect(blocks[1].type).toBe("paragraph");
    expect(blocks[1].startLine).toBe(7);
  });

  test("table gets correct startLine", () => {
    const md = "# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const blocks = parseMarkdownToBlocks(md);
    expect(blocks[1].type).toBe("table");
    expect(blocks[1].startLine).toBe(3);
  });
});

describe("exportAnnotations — line labels", () => {
  const blocks = parseMarkdownToBlocks("# Heading\n\nShort paragraph\n\n```ts\nline1\nline2\nline3\n```");

  test("single-line block shows 'line N'", () => {
    const anns = [{ blockId: blocks[0].id, type: "COMMENT", text: "fix this", originalText: "Heading", startOffset: 0 }];
    const output = exportAnnotations(blocks, anns);
    expect(output).toContain("(line 1)");
  });

  test("multi-line code block shows line range", () => {
    const codeBlock = blocks.find(b => b.type === "code")!;
    const anns = [{ blockId: codeBlock.id, type: "COMMENT", text: "refactor", originalText: "line1", startOffset: 0 }];
    const output = exportAnnotations(blocks, anns);
    expect(output).toMatch(/\(lines 5–9\)/);
  });

  test("GLOBAL_COMMENT has no line label", () => {
    const anns = [{ blockId: "global", type: "GLOBAL_COMMENT", text: "overall feedback", originalText: "", startOffset: 0 }];
    const output = exportAnnotations(blocks, anns);
    expect(output).not.toMatch(/\(line/);
  });

  test("diff-context annotation shows label instead of line number", () => {
    const anns = [{ blockId: blocks[0].id, type: "COMMENT", text: "change", originalText: "Heading", startOffset: 0, diffContext: "added" }];
    const output = exportAnnotations(blocks, anns);
    expect(output).not.toMatch(/\(line/);
    expect(output).toContain("[In diff content]");
  });

  test("sourceConverted adds caveat", () => {
    const output = exportAnnotations(blocks, [{ blockId: blocks[0].id, type: "COMMENT", text: "ok", originalText: "Heading", startOffset: 0 }], [], "Feedback", "plan", { sourceConverted: true });
    expect(output).toContain("converted markdown");
  });

  test("no sourceConverted means no caveat", () => {
    const output = exportAnnotations(blocks, [{ blockId: blocks[0].id, type: "COMMENT", text: "ok", originalText: "Heading", startOffset: 0 }]);
    expect(output).not.toContain("converted markdown");
  });

  test("math block line labels cover source fences", () => {
    const mathBlocks = parseMarkdownToBlocks("Intro\n\n$$\nx + y\n$$");
    const math = mathBlocks.find(b => b.type === "math")!;
    const anns = [{ blockId: math.id, type: "COMMENT", text: "clarify", originalText: "x + y", startOffset: 0 }];
    const output = exportAnnotations(mathBlocks, anns);
    expect(output).toContain("(lines 3–5)");
  });
});

describe("exportAnnotations — multi-target raw-HTML comments", () => {
  // HTML-surface annotations have blockId '' — no blocks apply.
  const htmlAnn = (extra: object = {}) => ({
    blockId: "",
    startOffset: 0,
    endOffset: 0,
    type: "COMMENT",
    text: "Unify these",
    originalText: "Primary chip",
    ...extra,
  });

  test("additional targets are listed with label + excerpt, primary first", () => {
    const output = exportAnnotations([], [htmlAnn({
      htmlAdditionalTargets: [
        { label: "Button", text: "Create", anchor: { selector: "span.btn", tagName: "span", text: "Create" } },
        // Fail-closed target (no anchor) still exports its label + text.
        { label: "rowchip", text: "adopted   by 1" },
      ],
    })]);
    expect(output).toContain('Feedback on: "Primary chip"');
    expect(output).toContain("Also applies to 2 more elements:");
    expect(output.indexOf("Primary chip")).toBeLessThan(output.indexOf("Also applies"));
    expect(output).toContain('- [Button] "Create"');
    expect(output).toContain('- [rowchip] "adopted by 1"'); // whitespace collapsed
    // A blank line separates the block from the `> comment` blockquote above,
    // or markdown lazy continuation folds it INTO the quote.
    expect(output).toContain('> Unify these\n\n**Also applies');
  });

  test("hostile labels with newlines cannot inject markdown structure into the export", () => {
    // Labels come from page-controlled attributes (aria-label). The DTO
    // boundary collapses whitespace, but persisted pre-fix drafts bypass it —
    // the exporter must collapse again so no line in agent-read feedback
    // starts with attacker-controlled markdown.
    const output = exportAnnotations([], [htmlAnn({
      htmlAdditionalTargets: [
        { label: "Save\n## INJECTED HEADING", text: "Save\n# ALSO INJECTED" },
      ],
    })]);
    expect(output).toContain('- [Save ## INJECTED HEADING] "Save # ALSO INJECTED"');
    expect(output).not.toContain("\n## INJECTED");
    expect(output).not.toContain("\n# ALSO");
  });

  test("long excerpts are clipped and label-less targets still list", () => {
    const output = exportAnnotations([], [htmlAnn({
      htmlAdditionalTargets: [{ text: "x".repeat(300) }],
    })]);
    expect(output).toContain("Also applies to 1 more element:");
    expect(output).toContain(`- "${"x".repeat(120)}…"`);
  });

  test("single-target output is byte-identical to the pre-feature format", () => {
    const single = exportAnnotations([], [htmlAnn()]);
    const empty = exportAnnotations([], [htmlAnn({ htmlAdditionalTargets: [] })]);
    expect(single).toBe(empty);
    expect(single).not.toContain("Also applies");
    expect(single).toBe(
      "# Plan Feedback\n\nI've reviewed this plan and have 1 piece of feedback:\n\n" +
      "## 1. Feedback on: \"Primary chip\"\n> Unify these\n\n---\n",
    );
  });
});

describe("parseMarkdownToBlocks — non-markdown plain text (#1029)", () => {
  /**
   * Annotate now accepts YAML/JSON/TOML-style config files and renders them
   * through the same pipeline as .txt. The parser must treat structured
   * config content as ordinary text without crashing or dropping lines.
   */
  test("YAML content parses into blocks without crashing", () => {
    const yaml = [
      "name: plannotator",
      "on:",
      "  push:",
      "    branches: [main]",
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: bun test",
    ].join("\n");
    const blocks = parseMarkdownToBlocks(yaml);
    expect(blocks.length).toBeGreaterThan(0);
    const joined = blocks.map((b) => b.content).join("\n");
    expect(joined).toContain("name: plannotator");
    expect(joined).toContain("uses: actions/checkout@v4");
  });

  test("JSON content parses into blocks without crashing", () => {
    const json = '{\n  "name": "plannotator",\n  "private": true\n}';
    const blocks = parseMarkdownToBlocks(json);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((b) => b.content).join("\n")).toContain('"name": "plannotator"');
  });

  test("multi-document YAML keeps its first document with frontmatter: false", () => {
    // A k8s-style multi-document YAML starts with `---`. With frontmatter
    // stripping disabled (the rule for non-markdown annotatable sources),
    // the FIRST document must survive parsing.
    const yaml = "---\napiVersion: v1\nkind: ConfigMap\n---\napiVersion: v1\nkind: Secret\n";
    const blocks = parseMarkdownToBlocks(yaml, { frontmatter: false });
    const joined = blocks.map((b) => b.content).join("\n");
    expect(joined).toContain("kind: ConfigMap");
    expect(joined).toContain("kind: Secret");
    // First real content line keeps its original line number (nothing consumed).
    expect(blocks[0].startLine).toBe(1);
  });

  test("default parse still strips markdown frontmatter", () => {
    const md = "---\ntitle: Plan\n---\n# Heading\nbody\n";
    const blocks = parseMarkdownToBlocks(md);
    const joined = blocks.map((b) => b.content).join("\n");
    expect(joined).not.toContain("title: Plan");
    expect(joined).toContain("body");
  });

  test("shouldStripFrontmatter keys off the source path", () => {
    expect(shouldStripFrontmatter(undefined)).toBe(true); // plans/messages
    expect(shouldStripFrontmatter("notes.md")).toBe(true);
    expect(shouldStripFrontmatter("guide.mdx")).toBe(true);
    expect(shouldStripFrontmatter("deploy.yaml")).toBe(false);
    expect(shouldStripFrontmatter("notes.txt")).toBe(false);
    expect(shouldStripFrontmatter("data.csv")).toBe(false);
    expect(shouldStripFrontmatter("https://example.com/page")).toBe(true); // converted source
  });
});
