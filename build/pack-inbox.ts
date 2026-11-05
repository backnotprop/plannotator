import type { Plugin } from 'vite';
import { packApp, PACKED_ASSET_ROUTE_PREFIX, type PackedAsset } from '../packages/shared/packed-app';

/** `\uXXXX` for one UTF-16 code unit. */
const unit = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`;

/**
 * The same regular expression literal with every non-ASCII character written
 * as an escape: `→` for a character of the Basic Multilingual Plane;
 * above it `\u{1F600}` with the `u` or `v` flag, else its two surrogate
 * escapes (without those flags the pattern reads the character as those two
 * code units anyway). An identity escape (`\é`, allowed only without `u`)
 * becomes the plain escape. The pattern matches exactly what it matched.
 */
export function asciiRegExpLiteral(literal: string): string {
  const close = literal.lastIndexOf('/');
  const flags = literal.slice(close + 1);
  const unicode = /[uv]/.test(flags);
  const escape = (char: string) => {
    const point = char.codePointAt(0)!;
    if (point <= 0xffff) return unit(point);
    return unicode ? `\\u{${point.toString(16)}}` : unit(char.charCodeAt(0)) + unit(char.charCodeAt(1));
  };
  let out = '';
  const chars = [...literal.slice(0, close)];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char === '\\' && i + 1 < chars.length) {
      const next = chars[++i]!;
      out += next.charCodeAt(0) > 0x7f ? escape(next) : char + next;
    } else {
      out += char.charCodeAt(0) > 0x7f ? escape(char) : char;
    }
  }
  return out + literal.slice(close);
}

/**
 * esbuild's `charset: 'ascii'` escapes strings, templates and identifiers but
 * leaves regular expression literals as written, so this does those. `parse`
 * is Rollup's (`this.parse` in a plugin: ESTree, UTF-16 offsets). Returns the
 * code unchanged when it is ASCII already.
 */
export function asciiRegExps(code: string, parse: (code: string) => unknown): string {
  if (!/[^\x00-\x7f]/.test(code)) return code;
  const literals: { start: number; end: number }[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as { type?: string; regex?: unknown; start: number; end: number };
    if (n.type === 'Literal' && n.regex) {
      literals.push({ start: n.start, end: n.end });
      return;
    }
    for (const value of Object.values(n)) if (value && typeof value === 'object') walk(value);
  };
  walk(parse(code));
  literals.sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  for (const { start, end } of literals) {
    const literal = code.slice(start, end);
    if (!/[^\x00-\x7f]/.test(literal)) continue;
    out += code.slice(at, start) + asciiRegExpLiteral(literal);
    at = end;
  }
  return out + code.slice(at);
}

/**
 * A page whose entry script the Inbox no longer has reloads itself, once: without the script nothing else on the
 * page runs, so it would stay blank, with no stale-page notice, until the person reloaded. It happens when a browser
 * brings back the page from an older release (a restored tab, back and forward) and no longer holds that release's
 * script. Only on a 404: a network failure may pass, and the Inbox being down is not fixed by reloading. Nothing has
 * run, so nothing the person wrote is lost. `cache: "reload"` first, to refresh the browser's copy of the page, so the
 * reload should not get the same old page; a refresh that fails still reloads. The mark in sessionStorage keeps one
 * old page from reloading twice in a row: a store that keeps nothing never reloads, and an entry script that loads
 * clears it, so the same old page coming back later (a rollback, then forward again) reloads again. `load` reaches
 * the document's capture listeners but never the window's.
 */
export const INBOX_ENTRY_GONE_SCRIPT = `<script>(function(){
var mark="plannotator-entry-gone";
function entry(){return document.querySelector('script[type="module"][src^="/assets/"]')}
document.addEventListener("load",function(e){if(e.target===entry())try{sessionStorage.removeItem(mark)}catch(_){}},true);
addEventListener("error",function(e){
var s=entry();
if(!s||e.target!==s)return;
fetch(s.src,{method:"HEAD",cache:"no-store"}).then(function(r){
if(r.status!==404)return;
var at=s.getAttribute("src");
try{if(sessionStorage.getItem(mark)===at)return;sessionStorage.setItem(mark,at);if(sessionStorage.getItem(mark)!==at)return}catch(_){return}
function go(){location.reload()}
fetch(location.href,{cache:"reload"}).then(go,go);
},function(){});
},true);
})()</script>`;

/**
 * The Inbox window's build (apps/inbox/vite.config.ts, #2593): ONE file, as
 * before, which the binary embeds, but its scripts are code-split and packed
 * behind the page (packages/shared/packed-app.ts) instead of inlined. The
 * Inbox server answers them from memory (`/assets/<name>`, packages/server/inbox.ts),
 * so the window loads only its entry script up front, and the guided review
 * and code review (the review editor and its diff worker), the diagram
 * runtimes and the Shiki grammars arrive on first use. Inlined, every one of
 * them was parsed and evaluated at page load.
 *
 * Unlike the plan and review apps (build/pack-app.ts), the page keeps its
 * stylesheet inline, with its fonts and pictures as data URLs, exactly as the
 * single-file build had it, so the window paints as before; only `.js` is
 * packed. It has no "updated while open" line and none of their head script's
 * theme or load-failed work: only the binary that embeds this file serves it,
 * so no older server ever serves it raw, and the window's own stale-page notice
 * covers an Inbox restarted onto a new release under an open page. Its one script
 * in the head is for an older page that cannot get its entry script, which has
 * no notice to show, so it reloads (`INBOX_ENTRY_GONE_SCRIPT`).
 */
export function packedInboxApp(): Plugin {
  return {
    name: 'plannotator-packed-inbox',
    enforce: 'post',
    // Last in the hook, as packedApp(): vite:build-import-analysis fills in the
    // __VITE_PRELOAD__ dependency lists in Vite's own post plugins.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['index.html'];
        if (page?.type !== 'asset' || typeof page.source !== 'string') {
          throw new Error('packed-inbox: the build emitted no index.html');
        }
        if (!page.source.includes('</head>')) throw new Error('packed-inbox: index.html has no </head>');
        let html = page.source.replace('</head>', () => `${INBOX_ENTRY_GONE_SCRIPT}\n  </head>`);
        const assets: Record<string, PackedAsset> = {};
        let stylesheets = 0;
        for (const output of Object.values(bundle)) {
          if (output === page) continue;
          const path = `/${output.fileName}`;
          if (!path.startsWith(PACKED_ASSET_ROUTE_PREFIX)) throw new Error(`packed-inbox: ${output.fileName} is outside ${PACKED_ASSET_ROUTE_PREFIX}`);
          if (output.type === 'chunk') {
            // ASCII only (with esbuild's `charset: 'ascii'`, apps/inbox/vite.config.ts): one non-ASCII character
            // makes V8 keep the whole script at two bytes per character.
            const code = asciiRegExps(output.code, (source) => this.parse(source));
            const left = code.search(/[^\x00-\x7f]/);
            if (left >= 0) throw new Error(`packed-inbox: ${output.fileName} keeps a non-ASCII character outside a regular expression: ${JSON.stringify(code.slice(Math.max(0, left - 40), left + 10))}`);
            assets[path] = { type: 'text/javascript; charset=utf-8', text: code };
          } else if (path.endsWith('.css') && typeof output.source === 'string') {
            // The one stylesheet (cssCodeSplit: false), back into the page where its link was.
            const link = new RegExp(`<link rel="stylesheet"(?: crossorigin)? href="${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`);
            if (!link.test(html)) throw new Error(`packed-inbox: no link to ${path} in index.html`);
            if (/<\/style/i.test(output.source)) throw new Error(`packed-inbox: ${path} closes a style element`);
            const css = output.source;
            html = html.replace(link, () => `<style rel="stylesheet" crossorigin>${css}</style>`);
            stylesheets++;
          } else {
            // Fonts and pictures stay data URLs (assetsInlineLimit): a file here would be a request the page never made before.
            throw new Error(`packed-inbox: ${output.fileName} is not inlined (raise build.assetsInlineLimit)`);
          }
          delete bundle[output.fileName];
        }
        if (stylesheets !== 1) throw new Error(`packed-inbox: expected one stylesheet, found ${stylesheets}`);
        const entries = [...html.matchAll(/<script type="module"[^>]*\ssrc="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
        if (entries.length !== 1 || !assets[entries[0]!]) throw new Error(`packed-inbox: expected one packed entry script, found ${JSON.stringify(entries)}`);
        page.source = packApp(html, assets);
      },
    },
  };
}
