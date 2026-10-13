import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { stripKatexFontFallbacks } from "./katex-woff2-only";

const requireFromUi = createRequire(join(import.meta.dir, "../packages/ui/package.json"));
const katexCss = readFileSync(requireFromUi.resolve("katex/dist/katex.min.css"), "utf8");

function fontFaces(css: string): string[] {
  return css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
}

describe("stripKatexFontFallbacks", () => {
  test("every KaTeX face keeps exactly its woff2 source", () => {
    const before = fontFaces(katexCss);
    const after = fontFaces(stripKatexFontFallbacks(katexCss));
    // Guards the regex against a KaTeX release that changes the src shape.
    expect(before.length).toBeGreaterThan(10);
    expect(after.length).toBe(before.length);
    for (const face of after) {
      expect(face).toMatch(/font-family:"?KaTeX_/);
      const sources = face.match(/url\([^)]*\)/g) ?? [];
      expect(sources).toHaveLength(1);
      expect(sources[0]).toMatch(/\.woff2\)$/);
    }
  });

  test("matches the inlined data-URI form too", () => {
    const inlined =
      '@font-face{font-family:KaTeX_Main;src:url(data:font/woff2;base64,AAA=) format("woff2"),url(data:font/woff;base64,BBB=) format("woff"),url(data:font/ttf;base64,CCC=) format("truetype")}';
    expect(stripKatexFontFallbacks(inlined)).toBe(
      '@font-face{font-family:KaTeX_Main;src:url(data:font/woff2;base64,AAA=) format("woff2")}',
    );
  });

  test("leaves non-KaTeX faces and everything outside @font-face alone", () => {
    const other =
      '@font-face{font-family:Inter;src:url(a.woff2) format("woff2"),url(a.woff) format("woff")}.katex{font:normal 1.21em KaTeX_Main}';
    expect(stripKatexFontFallbacks(other)).toBe(other);
  });
});
