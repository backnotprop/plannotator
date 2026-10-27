/**
 * stripInlineMarkup, shared by the question parser (a Recommended: line naming
 * a markdown label) and the Inbox's cleanInline (thread rows, titles).
 *
 * What regresses if this fails: a link, wiki link or image stays in the plain
 * text (a row reads `[Pagefind](x.html)`, a recommendation names nothing), a
 * comparison like `a < b > c` loses its words, or a long run of brackets or
 * tags takes most of a second to read (every card render and every send).
 */
import { expect, test } from "bun:test";
import { cleanInline } from "./inbox-folding";
import { stripInlineMarkup } from "./inline-markdown";

test("links, wiki links, images and tags out, their words kept", () => {
  expect(stripInlineMarkup("[Pagefind](x.html) and [[Search|Pagefind]] or [[Lunr]]")).toBe("Pagefind and Pagefind or Lunr");
  expect(stripInlineMarkup("a ![shot](s.png)picture")).toBe("a picture");
  expect(stripInlineMarkup("press <kbd>Enter</kbd>")).toBe("press Enter");
  expect(stripInlineMarkup("a < b > c, [not a link] (x)")).toBe("a < b > c, [not a link] (x)");
  // A destination with one level of balanced parentheses (a Wikipedia URL, a Next.js route group).
  expect(stripInlineMarkup("[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) and [page](code:app/(shop)/[id]/page.tsx#L4)")).toBe("Foo and page");
  expect(stripInlineMarkup("see ![x](a_(1).png)here")).toBe("see here");
});

test("a 20,000-character run of brackets or tags is read in linear time, here and in cleanInline", () => {
  for (const run of ["[", "[[", "![", "<a", "[a](", "[[a|", "[a]((", "[a](x(", "![a](("]) {
    const text = run.repeat(Math.ceil(20_000 / run.length)).slice(0, 20_000);
    for (const strip of [stripInlineMarkup, cleanInline]) {
      const start = performance.now();
      strip(text);
      expect(performance.now() - start).toBeLessThan(50);
    }
  }
});
