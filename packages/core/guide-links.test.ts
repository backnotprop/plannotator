import { describe, expect, test } from "bun:test";
import { findGuideLinks, isGuideLinkHref, parseGuideLink } from "./guide-links";

describe("parseGuideLink", () => {
  test("code links: file, line, range", () => {
    expect(parseGuideLink("code:src/a.ts")).toEqual({ ok: true, link: { kind: "code", href: "code:src/a.ts", path: "src/a.ts" } });
    expect(parseGuideLink("code:src/a.ts#L24")).toEqual({ ok: true, link: { kind: "code", href: "code:src/a.ts#L24", path: "src/a.ts", startLine: 24 } });
    expect(parseGuideLink("code:src/a.ts#L10-L20")).toEqual({
      ok: true,
      link: { kind: "code", href: "code:src/a.ts#L10-L20", path: "src/a.ts", startLine: 10, endLine: 20 },
    });
    const short = parseGuideLink("code:src/a.ts#L10-20");
    expect(short?.ok && short.link).toMatchObject({ startLine: 10, endLine: 20 });
    const one = parseGuideLink("code:src/a.ts#L7-L7");
    expect(one?.ok && one.link).toEqual({ kind: "code", href: "code:src/a.ts#L7-L7", path: "src/a.ts", startLine: 7 });
    const spaced = parseGuideLink("code:docs/my%20notes.md");
    expect(spaced?.ok && spaced.link.kind === "code" && spaced.link.path).toBe("docs/my notes.md");
  });

  test("code links refuse what cannot be a repo path or a line", () => {
    const cases: Array<[string, RegExp]> = [
      ["code:", /names no file/],
      ["code:/abs/a.ts", /without a leading \//],
      ["code:./a.ts", /without a leading \.\//],
      ["code:src/../a.ts", /may not contain \.\./],
      ["code:a.ts#24", /#L24/],
      ["code:a.ts#L0", /numbered from 1/],
      ["code:a.ts#L20-L10", /ends before it starts/],
      ["code:src\\a.ts", /not \\/],
      ["code:src/a%0Ab.ts", /control character/],
      ["code:src/a%00.ts", /control character/],
    ];
    for (const [href, message] of cases) {
      const parsed = parseGuideLink(href);
      expect(parsed?.ok).toBe(false);
      if (parsed && !parsed.ok) expect(parsed.error).toMatch(message);
    }
  });

  test("symbol links, with and without a file", () => {
    expect(parseGuideLink("symbol:deliverWebhook")).toEqual({ ok: true, link: { kind: "symbol", href: "symbol:deliverWebhook", name: "deliverWebhook" } });
    expect(parseGuideLink("symbol:src/webhooks/deliver.ts#deliverWebhook")).toEqual({
      ok: true,
      link: { kind: "symbol", href: "symbol:src/webhooks/deliver.ts#deliverWebhook", name: "deliverWebhook", path: "src/webhooks/deliver.ts" },
    });
    expect(parseGuideLink("symbol:")?.ok).toBe(false);
    expect(parseGuideLink("symbol:/x.ts#a")?.ok).toBe(false);
    expect(parseGuideLink("symbol:a%0Ab")?.ok).toBe(false);
    expect(parseGuideLink("symbol:src\\x.ts#a")?.ok).toBe(false);
  });

  test("chapter links are 1-based numbers", () => {
    expect(parseGuideLink("chapter:2")).toEqual({ ok: true, link: { kind: "chapter", href: "chapter:2", chapter: 2 } });
    expect(parseGuideLink("chapter:0")?.ok).toBe(false);
    expect(parseGuideLink("chapter:c2")?.ok).toBe(false);
  });

  test("ordinary URLs are not guide links", () => {
    expect(parseGuideLink("https://example.com")).toBeNull();
    expect(parseGuideLink("#anchor")).toBeNull();
    expect(isGuideLinkHref(" CODE:a.ts")).toBe(true);
    expect(isGuideLinkHref("mailto:x")).toBe(false);
  });
});

describe("findGuideLinks", () => {
  test("markdown: only guide-scheme links, with their labels", () => {
    const text = "See [`refresh`](symbol:refresh), [the line](code:src/a.ts#L2) and [docs](https://x.dev), then [ch](chapter:3).";
    expect(findGuideLinks(text, "markdown")).toEqual([
      { href: "symbol:refresh", label: "`refresh`" },
      { href: "code:src/a.ts#L2", label: "the line" },
      { href: "chapter:3", label: "ch" },
    ]);
  });

  test("markdown: balanced parentheses stay in the target (Next.js route groups)", () => {
    const text = "See [the page](code:app/(shop)/[id]/page.tsx#L4) and [the layout](code:app/(shop)/layout.tsx).";
    expect(findGuideLinks(text, "markdown").map((l) => l.href)).toEqual(["code:app/(shop)/[id]/page.tsx#L4", "code:app/(shop)/layout.tsx"]);
    const parsed = parseGuideLink("code:app/(shop)/[id]/page.tsx#L4");
    expect(parsed?.ok && parsed.link).toMatchObject({ kind: "code", path: "app/(shop)/[id]/page.tsx", startLine: 4 });
    expect(findGuideLinks("[x](code:a.ts) (aside)", "markdown").map((l) => l.href)).toEqual(["code:a.ts"]);
  });

  test("mermaid: click lines, quoted, with or without href", () => {
    const source = 'flowchart LR\n  a --> b\n  click a "symbol:deliver"\n  click b href \'code:src/b.ts#L4\'\n  click c "https://x.dev"\n  click d callback';
    expect(findGuideLinks(source, "mermaid").map((l) => l.href)).toEqual(["symbol:deliver", "code:src/b.ts#L4"]);
  });

  test("html: href and xlink:href attributes", () => {
    const html = '<a href="code:src/a.ts">a</a><svg><a xlink:href=\'chapter:1\'></a></svg><a href=https://x.dev>x</a><a href=symbol:run>r</a>';
    expect(findGuideLinks(html, "html").map((l) => l.href)).toEqual(["code:src/a.ts", "chapter:1", "symbol:run"]);
  });
});
