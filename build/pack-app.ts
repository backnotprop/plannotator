import { extname } from 'node:path';
import type { Plugin } from 'vite';
import { packApp, PACKED_ASSET_ROUTE_PREFIX, type PackedAsset } from '../packages/shared/packed-app';

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

export const UPDATED_WHILE_OPEN_MESSAGE =
  'Plannotator was updated while this session was open. Run /reload in Pi (or /restart in Oh My Pi), or restart your agent, to finish.';

const UPDATED_WHILE_OPEN_SCRIPT = `<script>(function(){
var shown=false;
function show(page){var h=document.documentElement;if(page&&!h.style.colorScheme)h.style.colorScheme="light dark";if(shown)return;shown=true;var p=document.createElement("p");p.setAttribute("role","alert");p.id="plannotator-updated";p.textContent=${JSON.stringify(UPDATED_WHILE_OPEN_MESSAGE)};p.style.cssText="position:fixed;top:0;left:0;right:0;margin:0;padding:12px 16px;font:14px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText;z-index:2147483647";(document.body||document.documentElement).prepend(p)}
function entry(){return document.querySelector('script[type="module"][src^="/assets/"]')}
function check(page){var s=entry();if(s)fetch(s.src,{method:"HEAD",cache:"no-store",redirect:"manual"}).then(function(r){if(r.ok&&/^text\\/html/i.test(r.headers.get("content-type")||""))show(page)},function(){})}
addEventListener("error",function(e){if(e.target===entry())check(true)},true);
addEventListener("vite:preloadError",function(){check(false)});
})()</script>`;

export const LOAD_FAILED_MESSAGE = "Plannotator couldn't finish loading.";

const PRELOADED_FONTS = [/^assets\/inter-latin-wght-normal-[^/]+\.woff2$/, /^assets\/geist-mono-latin-wght-normal-[^/]+\.woff2$/];

function headScript(core: string[]): string {
  return `<script>(function(){
var d=document,h=d.documentElement;
try{var m=(d.cookie.match(/(?:^|; )plannotator-theme=([^;]*)/)||[])[1];m=m?decodeURIComponent(m):"dark";if(m==="system")m=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";h.style.colorScheme=m==="light"?"light":"dark"}catch(e){}
var core=${JSON.stringify(core)},failed=false;
function show(){if(d.getElementById("plannotator-load-failed"))return;var p=d.createElement("p");p.id="plannotator-load-failed";p.setAttribute("role","alert");p.style.cssText="position:fixed;top:0;left:0;right:0;margin:0;padding:12px 16px;font:14px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText;z-index:2147483646";p.appendChild(d.createTextNode(${JSON.stringify(LOAD_FAILED_MESSAGE + ' ')}));var b=d.createElement("button");b.type="button";b.textContent="Reload";b.style.cssText="font:inherit;color:inherit;background:none;border:0;margin:-4px -6px;padding:4px 6px;min-height:28px;text-decoration:underline;cursor:pointer";b.onclick=function(){location.reload()};p.appendChild(b);var st=d.createElement("style");st.textContent="#root{display:none!important}@media (pointer:coarse){#plannotator-load-failed button{min-height:44px;margin-block:-12px}}";p.appendChild(st);(d.body||h).prepend(p)}
function fail(){if(failed)return;failed=true;var s=d.querySelector('script[type="module"][src^="/assets/"]');if(!s)return show();fetch(s.src,{method:"HEAD",cache:"no-store",redirect:"manual"}).then(function(r){if(!(r.ok&&/^text\\/html/i.test(r.headers.get("content-type")||"")))show()},show)}
addEventListener("error",function(e){var t=e.target,a=t&&t.tagName==="LINK"?"href":"src",u=t&&t.getAttribute&&t.getAttribute(a);if(!u||!(t.tagName==="LINK"||t.tagName==="SCRIPT"))return;if(t.hasAttribute("data-plannotator-retry"))return fail();if(core.indexOf(u)<0)return;var n=d.createElement(t.tagName);for(var i=0;i<t.attributes.length;i++)n.setAttribute(t.attributes[i].name,t.attributes[i].value);if(a==="href")n.setAttribute(a,u+(u.indexOf("?")<0?"?":"&")+"retry=1");n.setAttribute("data-plannotator-retry","");t.parentNode.insertBefore(n,t.nextSibling)},true);
})()</script>`;
}

export function packedApp(): Plugin {
  return {
    name: 'plannotator-packed-app',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['index.html'];
        if (page?.type !== 'asset' || typeof page.source !== 'string') {
          throw new Error('packed-app: the build emitted no index.html');
        }
        const assets: Record<string, PackedAsset> = {};
        for (const output of Object.values(bundle)) {
          if (output === page) continue;
          const type = CONTENT_TYPES[extname(output.fileName)];
          if (!type) throw new Error(`packed-app: no content type for ${output.fileName}`);
          const path = `/${output.fileName}`;
          if (!path.startsWith(PACKED_ASSET_ROUTE_PREFIX)) throw new Error(`packed-app: ${output.fileName} is outside ${PACKED_ASSET_ROUTE_PREFIX}`);
          const source = output.type === 'chunk' ? output.code : output.source;
          assets[path] = typeof source === 'string'
            ? { type, text: source }
            : { type, base64: Buffer.from(source).toString('base64') };
          delete bundle[output.fileName];
        }
        if (!page.source.includes('</head>')) throw new Error('packed-app: index.html has no </head>');
        const charset = /<meta charset="UTF-8"\s*\/?>/i.exec(page.source);
        if (!charset) throw new Error('packed-app: index.html has no <meta charset> to put the head script after');
        const core = [...page.source.matchAll(/<(?:script type="module"[^>]*\ssrc|link rel="stylesheet"[^>]*\shref)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
        if (!core.some((u) => u.endsWith('.js')) || !core.some((u) => u.endsWith('.css'))) {
          throw new Error(`packed-app: expected the entry script and stylesheet in index.html, found ${JSON.stringify(core)}`);
        }
        const fonts = PRELOADED_FONTS.map((pattern) => {
          const name = Object.keys(assets).map((path) => path.slice(1)).find((name) => pattern.test(name));
          if (!name) throw new Error(`packed-app: no font matching ${pattern} to preload`);
          return `<link rel="preload" as="font" type="font/woff2" crossorigin href="/${name}">`;
        });
        const head = `\n    ${headScript(core)}\n    ${fonts.join('\n    ')}`;
        const at = charset.index + charset[0].length;
        const source = page.source.slice(0, at) + head + page.source.slice(at);
        page.source = packApp(source.replace('</head>', `${UPDATED_WHILE_OPEN_SCRIPT}\n  </head>`), assets);
      },
    },
  };
}
