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
    generateBundle(_options, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/(^|\/)KaTeX_[^/]*\.(?:woff|ttf)$/.test(name)) delete bundle[name];
      }
    },
  };
}
