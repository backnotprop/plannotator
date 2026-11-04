import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { asciiRegExpLiteral, asciiRegExps as escapeWith } from "./pack-inbox";

// Rollup's parser, the one the build hands in (`this.parse`), through the Inbox app's Vite.
const { parseAst } = (await import(Bun.resolveSync("vite", join(import.meta.dir, "../apps/inbox")))) as { parseAst: (code: string) => unknown };
const asciiRegExps = (code: string) => escapeWith(code, parseAst);

// The Inbox window's scripts are made ASCII so V8 keeps their source at one
// byte per character (#2593). esbuild leaves regular expression literals as
// written, so build/pack-inbox.ts escapes them; an escape that changed what a
// pattern matches would break the window with no build error.

const evaluate = (literal: string): RegExp => new Function(`return ${literal}`)() as RegExp;

/** Each literal with strings it must treat exactly as the original does. */
const CASES: Array<[literal: string, probes: string[]]> = [
  // The shapes the window's own dependencies use (KaTeX, Mermaid, the diagram parsers, the Inbox).
  ["/[îïíì]/", ["î", "i", "ì", "x"]],
  ["/ﬂ°°/g", ["ﬂ°°", "ﬂ°", "a ﬂ°° b"]],
  ["/[─━│┃└┗├┣]/", ["─", "├", "-", "|"]],
  ["/^[\\s>*_#`]*(?:[-=‐-―−]{2,}\\s*(?:BEGIN|END))/", ["‐‐ BEGIN", "―− END", "-- BEGIN", "~~ BEGIN"]],
  ["/[\\s([{\"'“‘「]/u", ["“", "「", "x", " "]],
  // A range across the escape, a quantifier after it, and a class negation.
  ["/[a-é]+/i", ["É", "ab", "z", "ê"]],
  ["/→+$/", ["→→", "->", "→ "]],
  ["/[^…]/", ["…", "."]],
  // Above the Basic Multilingual Plane: with `u` one code point, without it two code units.
  ["/😀+/u", ["😀😀", "😀", "\uD83D"]],
  ["/😀+/", ["😀\uDE00", "😀😀", "\uD83D"]],
  ["/[😀]/", ["\uD83D", "\uDE00", "x"]],
  ["/[😀]/v", ["😀", "\uD83D"]],
  // An identity escape of a non-ASCII character (allowed without `u`).
  ["/\\é/", ["é", "\\é"]],
  // ASCII escapes around it are kept as they are.
  ["/\\/é\\\\/", ["/é\\", "/é"]],
];

describe("asciiRegExpLiteral", () => {
  test.each(CASES)("%s matches what it matched, in ASCII", (literal, probes) => {
    const before = evaluate(literal);
    const escaped = asciiRegExpLiteral(literal);
    expect(escaped).not.toMatch(/[^\x00-\x7f]/);
    const after = evaluate(escaped);
    expect(after.flags).toBe(before.flags);
    for (const probe of probes) {
      expect({ probe, match: probe.match(after)?.[0] ?? null }).toEqual({ probe, match: probe.match(before)?.[0] ?? null });
    }
  });
});

describe("asciiRegExps", () => {
  test("rewrites only regular expression literals, at their own offsets", () => {
    // A non-ASCII string ahead of the literal would shift byte offsets; the parser's are UTF-16, as the code is.
    const code = 'const a="\\u2192",b=x=>x.replace(/[“”]/g,"\\""),c=/é/u.test(y);';
    const out = asciiRegExps(code);
    expect(out).toBe('const a="\\u2192",b=x=>x.replace(/[\\u201c\\u201d]/g,"\\""),c=/\\u00e9/u.test(y);');
    // Division and a regex-looking string are not literals.
    expect(asciiRegExps('const d=a/b/c,e="/é/";')).toBe('const d=a/b/c,e="/é/";');
  });

  test("leaves ASCII code untouched", () => {
    const code = "const r=/[a-z]+/g;export{r};";
    expect(asciiRegExps(code)).toBe(code);
  });
});
