/**
 * Drop KaTeX's `woff` and `ttf` font fallbacks from the single-file builds
 * (#1617), keeping only `woff2`.
 *
 * `katex.min.css` lists every face as `woff2, woff, truetype`. A browser takes
 * the first format it supports and never fetches the rest, and every browser
 * Plannotator runs in supports woff2 (Chromium 36+, which includes the VS Code
 * webview and Electron; Firefox 39+; Safari 12+, while the app already needs
 * Safari 17.4+ for Mermaid 12). In a normal build the fallbacks cost nothing,
 * but the single-file builds inline every `url()` as base64, so they shipped
 * ~1.1 MB of fonts no browser reads, in both the plan and the review HTML.
 *
 * Only `@font-face` rules whose family is `KaTeX_*` are touched. The plugin
 * runs in Vite's normal phase, after Tailwind has inlined theme.css's
 * `@import` of the KaTeX stylesheet, and matches both the path form
 * (`url(fonts/X.woff)`) and the inlined data-URI form, so it does not depend
 * on whether assets are already inlined when it sees the CSS.
 */
import type { Plugin } from 'vite';

const FONT_FACE = /@font-face\s*\{[^}]*\}/g;
const FALLBACK_SOURCE = /,\s*url\([^)]*\)\s*format\(\s*["']?(?:woff|truetype)["']?\s*\)/g;

export function stripKatexFontFallbacks(css: string): string {
  return css.replace(FONT_FACE, (rule) =>
    /font-family\s*:\s*["']?KaTeX_/.test(rule) ? rule.replace(FALLBACK_SOURCE, '') : rule,
  );
}

export function katexWoff2Only(): Plugin {
  return {
    name: 'plannotator:katex-woff2-only',
    apply: 'build',
    transform(code, id) {
      if (!/\.css(?:$|\?)/.test(id) || !code.includes('KaTeX_')) return null;
      const next = stripKatexFontFallbacks(code);
      return next === code ? null : { code: next, map: null };
    },
  };
}
