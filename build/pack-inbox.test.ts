import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { asciiRegExpLiteral, asciiRegExps as escapeWith, INBOX_ENTRY_GONE_SCRIPT } from "./pack-inbox";

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

// The page from an older release, its entry script gone from the Inbox and from the browser: without this it stays blank.
describe("a page whose entry script cannot load", () => {
  const entry = { src: "http://localhost:1/assets/index-old.js", getAttribute: () => "/assets/index-old.js" };

  async function run(options: { head?: () => Promise<{ status: number }>; target?: unknown; stored?: Record<string, string>; storage?: "throws" }) {
    const stored = options.stored ?? {};
    const calls: string[] = [];
    const listeners: ((event: { target: unknown }) => void)[] = [];
    const fake = {
      addEventListener: (type: string, listener: (event: { target: unknown }) => void, capture: boolean) => {
        expect([type, capture]).toEqual(["error", true]); // An element's load error does not bubble.
        listeners.push(listener);
      },
      document: { querySelector: () => entry },
      location: { href: "http://localhost:1/#thread=t", reload: () => calls.push("reload") },
      sessionStorage:
        options.storage === "throws"
          ? { getItem: () => { throw new Error("denied"); }, setItem: () => {} }
          : { getItem: (key: string) => stored[key] ?? null, setItem: (key: string, value: string) => void (stored[key] = value) },
      fetch: async (url: string, init: { method?: string; cache: string }) => {
        calls.push(`${init.method ?? "GET"} ${url} ${init.cache}`);
        return init.method === "HEAD" ? (options.head ?? (async () => ({ status: 404 })))() : { status: 200 };
      },
    };
    const code = INBOX_ENTRY_GONE_SCRIPT.replace(/^<script>|<\/script>$/g, "");
    new Function(...Object.keys(fake), code)(...Object.values(fake));
    listeners[0]!({ target: options.target ?? entry });
    await new Promise((done) => setTimeout(done, 0));
    return { calls, stored };
  }

  const head = "HEAD http://localhost:1/assets/index-old.js no-store";

  test("a 404: the page is read afresh past the cache and reloaded", async () => {
    expect((await run({})).calls).toEqual([head, "GET http://localhost:1/#thread=t reload", "reload"]);
  });

  test("the same old page again does not reload again; another old page does", async () => {
    const { stored } = await run({});
    expect((await run({ stored })).calls).toEqual([head]);
    expect((await run({ stored: { "plannotator-entry-gone": "/assets/index-older.js" } })).calls).toContain("reload");
  });

  test("anything but a 404 reloads nothing: a passing network failure, the Inbox down, the script being there", async () => {
    expect((await run({ head: async () => ({ status: 200 }) })).calls).toEqual([head]);
    expect((await run({ head: async () => ({ status: 502 }) })).calls).toEqual([head]);
    expect((await run({ head: () => Promise.reject(new Error("offline")) })).calls).toEqual([head]);
  });

  test("another element's error is not the page's, and with no storage to keep the mark it never reloads", async () => {
    expect((await run({ target: { src: "x" } })).calls).toEqual([]);
    expect((await run({ storage: "throws" })).calls).toEqual([head]);
  });
});
