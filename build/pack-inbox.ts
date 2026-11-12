import type { Plugin } from 'vite';
import { packApp, PACKED_ASSET_ROUTE_PREFIX, type PackedAsset } from '../packages/shared/packed-app';

const unit = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`;

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

export function packedInboxApp(): Plugin {
  return {
    name: 'plannotator-packed-inbox',
    enforce: 'post',
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
            const code = asciiRegExps(output.code, (source) => this.parse(source));
            const left = code.search(/[^\x00-\x7f]/);
            if (left >= 0) throw new Error(`packed-inbox: ${output.fileName} keeps a non-ASCII character outside a regular expression: ${JSON.stringify(code.slice(Math.max(0, left - 40), left + 10))}`);
            assets[path] = { type: 'text/javascript; charset=utf-8', text: code };
          } else if (path.endsWith('.css') && typeof output.source === 'string') {
            const link = new RegExp(`<link rel="stylesheet"(?: crossorigin)? href="${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`);
            if (!link.test(html)) throw new Error(`packed-inbox: no link to ${path} in index.html`);
            if (/<\/style/i.test(output.source)) throw new Error(`packed-inbox: ${path} closes a style element`);
            const css = output.source;
            html = html.replace(link, () => `<style rel="stylesheet" crossorigin>${css}</style>`);
            stylesheets++;
          } else {
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
