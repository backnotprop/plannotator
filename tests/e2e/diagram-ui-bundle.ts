/**
 * The diagram engine Plannotator's apps use (`packages/ui/utils/diagram-render.ts`
 * with real Mermaid and DOMPurify), bundled for a page with no CSP, so a
 * navigation that got through would happen. Built with the VS Code Guides
 * webview's esbuild options (as vscode-guides-sanitize.spec.ts does), with this
 * entry. Used by diagram-label-scrub.spec.ts and diagram-label-scrub-webkit.spec.ts.
 *
 * The page's handle, `window.__d`:
 * - `render(source)`: `renderDiagram`, the drawn svg mounted in `#host`;
 *   `{ ok, refused, message }`.
 * - `measure(source)`: Mermaid alone, as `renderDiagram` runs it (same runtime,
 *   same config), with no sanitizer after it: what Mermaid's own drawing into
 *   the live page holds. The raw svg, or null.
 * - `labelRulesChanged(markup)`: what the sanitizer's post-pass changed in the
 *   markup beyond the rules it always had (an `<a>`'s link, a `<style>`'s text,
 *   a reference that is not a fragment or http(s)): one line per element or
 *   attribute that differs from the DOMPurify parse alone.
 * - `remoteLoads(on)`: `configurePlannotatorUI({ diagramRemoteLoads: on })`,
 *   as a host calls it (diagram-remote-loads.spec.ts).
 * - `removePurifyHooks(all)`: what a host's own code may do to the shared
 *   DOMPurify: `removeAllHooks()`, or (`all` false) `removeHooks('uponSanitizeAttribute')`.
 *
 * `buildDiagramUiBundle({ splitPurify: true })` gives Mermaid its own copy of
 * DOMPurify, as a host bundle that does not dedupe it would.
 * `buildDiagramUiBundle({ realKatex: true })` keeps the real KaTeX (the webview
 * options stub it out) so a `$$...$$` label is typeset as in the apps
 * (diagram-math-labels.spec.ts, with `katexCss()` on the page).
 */
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const EXTENSION = resolve(__dirname, '../../apps/vscode-extension');
const UI = resolve(__dirname, '../../packages/ui');

export function buildDiagramUiBundle(options: { splitPurify?: boolean; realKatex?: boolean } = {}): string {
  const work = mkdtempSync(join(tmpdir(), 'pn-diagram-scrub-'));
  try {
    const entry = join(work, 'entry.ts');
    // The ES build of DOMPurify, the file ui's own `import DOMPurify from 'dompurify'` bundles.
    const purify = join(dirname(createRequire(join(UI, 'package.json')).resolve('dompurify')), 'purify.es.mjs');
    const purifyCopy = join(work, 'purify-copy.mjs');
    if (options.splitPurify) copyFileSync(purify, purifyCopy);
    writeFileSync(entry, `
import DOMPurify from ${JSON.stringify(purify)};
import { parseDiagramSvg, renderDiagram, sanitizeDiagramSvg } from ${JSON.stringify(join(UI, 'utils/diagram-render.ts'))};
import { loadMermaidRuntime } from ${JSON.stringify(join(UI, 'utils/mermaid.ts'))};
import { applyMermaidTheme, mermaidThemeKey } from ${JSON.stringify(join(UI, 'utils/mermaidTheme.ts'))};
import { configurePlannotatorUI } from ${JSON.stringify(join(UI, 'configure.ts'))};
const host = () => document.getElementById('host')!;
let seq = 0;
/** A reference the post-pass always dropped (not a fragment, not http(s)). */
const oldRule = (name: string, value: string) =>
  ['href', 'xlink:href', 'src'].includes(name) && !/^(#|https?:[/][/]|$)/i.test(value.trim());
function describe(el: Element): string[] {
  return [el, ...Array.from(el.querySelectorAll('*'))].map((e) => {
    const attrs = e.localName === 'a' ? [] : Array.from(e.attributes).filter((a) => !oldRule(a.name, a.value)).map((a) => a.name + '=' + a.value).sort();
    return e.localName + (e.localName === 'style' ? '' : ' ' + attrs.join(' '));
  });
}
(window as any).__d = {
  async render(source: string) {
    const r = await renderDiagram('mermaid', 'pn-scrub-' + ++seq, source, { colorTheme: 'plannotator', mode: 'light' });
    if (!r.ok) return { ok: false, refused: r.refused === true, message: r.message };
    host().replaceChildren(r.svgNode);
    return { ok: true, refused: false, message: '' };
  },
  remoteLoads(on: boolean) {
    configurePlannotatorUI({ diagramRemoteLoads: on });
  },
  removePurifyHooks(all: boolean) {
    if (all) DOMPurify.removeAllHooks();
    else DOMPurify.removeHooks('uponSanitizeAttribute');
  },
  async measure(source: string) {
    // One render first, so the runtime carries the config renderDiagram gives it (the theme, and the remote-loads policy).
    await renderDiagram('mermaid', 'pn-warm-' + ++seq, 'flowchart LR\\n  W[w]', { colorTheme: 'plannotator', mode: 'light' });
    const mermaid = await loadMermaidRuntime();
    const id = 'pn-measure-' + ++seq;
    try {
      return (await mermaid.render(id, source)).svg;
    } catch {
      return null;
    } finally {
      document.getElementById('d' + id)?.remove();
    }
  },
  labelRulesChanged(markup: string) {
    const parsed = parseDiagramSvg(markup);
    const clean = sanitizeDiagramSvg(markup);
    if (!parsed || !clean) return ['no svg'];
    const a = describe(parsed);
    const b = describe(clean);
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) out.push((a[i] ?? '-') + '  =>  ' + (b[i] ?? '-'));
    return out;
  },
};
`);
    const out = join(work, 'bundle.js');
    const build = join(work, 'build.ts');
    writeFileSync(build, `
import { build } from ${JSON.stringify(join(EXTENSION, 'node_modules/esbuild/lib/main.js'))};
import { configs } from ${JSON.stringify(join(EXTENSION, 'scripts/esbuild.config.ts'))};
const webview = configs.find((c) => String(c.outdir ?? '').endsWith('dist') && c.format === 'iife');
if (!webview) throw new Error('no webview build config');
const { entryPoints: _e, outdir: _o, ...options } = webview;
// splitPurify: Mermaid's own import of dompurify resolves to a second copy.
const split = ${JSON.stringify(options.splitPurify ? purifyCopy : '')};
const plugins = [...(options.plugins ?? []), ...(split ? [{ name: 'split-purify', setup(b) { b.onResolve({ filter: /^dompurify$/ }, (a) => (/[\\/\\\\]mermaid[\\/\\\\]dist[\\/\\\\]/.test(a.importer) ? { path: split } : undefined)); } }] : [])];
// realKatex: Mermaid's math labels get the real KaTeX, not the webview's stub.
const alias = ${JSON.stringify(!!options.realKatex)} ? Object.fromEntries(Object.entries(options.alias ?? {}).filter(([name]) => name !== 'katex')) : options.alias;
await build({ ...options, alias, plugins, absWorkingDir: ${JSON.stringify(EXTENSION)}, entryPoints: [${JSON.stringify(entry)}], outfile: ${JSON.stringify(out)}, logLevel: 'silent' });
`);
    execFileSync('bun', [build], { cwd: EXTENSION, stdio: 'pipe' });
    return asciiOnly(readFileSync(out, 'utf8'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The bundle with every non-ASCII code unit written as `\uXXXX`, so the page reads the same
 * whatever charset a browser decodes it with (WebKit read the fulfilled page as windows-1252
 * even with `charset=utf-8`, and Pele's raw `[ -‍﻿]` became a range out of
 * order). esbuild leaves them raw only inside regex literals, where the escape means the same
 * character; after a backslash it would not, so that throws instead.
 */
function asciiOnly(code: string): string {
  if (/\\[^\x00-\x7f]/.test(code)) throw new Error('the diagram bundle escapes a non-ASCII character; asciiOnly cannot rewrite it safely');
  return code.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** KaTeX's own stylesheet, as the apps load it (packages/ui/theme.css imports it). Its font URLs resolve to nothing on the test page. */
export function katexCss(): string {
  return readFileSync(createRequire(join(UI, 'package.json')).resolve('katex/dist/katex.min.css'), 'utf8');
}

/** The utilities an app's stylesheet carries (Tailwind's own output for these class names). */
export const APP_UTILITIES = `.fixed{position:fixed}.absolute{position:absolute}.inset-0{inset:0}.top-0{top:0}.left-0{left:0}.z-50{z-index:50}.w-screen{width:100vw}.h-screen{height:100vh}.bg-red-500{background-color:rgb(239 68 68)}`;

/** The Inbox's artifact tile, from its own stylesheet (Artifacts grid and Wall: `ArtifactDiagramFace`). */
export function artifactTileCss(): string {
  const css = readFileSync(resolve(__dirname, '../../packages/inbox/inbox.css'), 'utf8');
  const rules = ['.ib-art-prev {', '.ib-art-svg {', '.ib-art-svg > svg {'].map((head) => css.split('\n').find((line) => line.startsWith(head)));
  if (rules.some((rule) => rule === undefined)) throw new Error('the artifact tile rules moved in inbox.css');
  return rules.join('\n');
}

/** Pictures from this host load (a 1x1 png): a label's picture still shows. */
export const PICTURE_HOST = 'https://img.test';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Label HTML that would take the tab away, or submit, when clicked. */
export const NAVIGATING_LABELS = [
  `<img src='${PICTURE_HOST}/map.png' usemap='#m' width=200 height=40 alt=map><map name='m'><area shape='default' href='https://evil.test/area'></map>`,
  `<form action='https://evil.test/form'><button>Go</button></form>`,
  `<form><button formaction='https://evil.test/formaction'>Go</button></form>`,
  `<form action='https://evil.test/form2'><input type='submit' value='Send'></form>`,
  `<form action='https://evil.test/form3'><input type='image' src='${PICTURE_HOST}/in.png' width=60 height=20></form>`,
  `<form action='https://evil.test/form4' target='_top'><input name=q value=x><button type=submit>Find</button></form>`,
];

/**
 * A page with the app's utilities, a button above the diagram and one below,
 * and `#host` inside `#box`: a plain clipped box, or (`tile`) the Inbox's
 * artifact tile with its real CSS. Pictures from PICTURE_HOST load; every
 * other request is recorded in `requests` (a form submission as `document`)
 * and aborted; every navigation of the page after it loaded is recorded in
 * `navigations`. `csp`: the page's Content-Security-Policy (a meta tag).
 * `origin` (e.g. `http://app.test`): the page is served from that origin
 * (fulfilled here, nothing leaves the machine) instead of about:blank, so a
 * protocol-relative `//host/…` resolves and is requested as in an app.
 * `css`: more stylesheet text for the page (KaTeX's, `katexCss()`).
 */
export async function openDiagramPage(page: Page, bundle: string, options: { tile?: boolean; csp?: string; origin?: string; css?: string } = {}) {
  const errors: string[] = [];
  const requests: string[] = [];
  const navigations: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const home = options.origin ? `${options.origin}/` : '';
  let html = '';
  await page.route(/^(?!data:|about:)/, (route) => {
    const url = route.request().url();
    // UTF-8 said out loud: without it the page decodes as windows-1252, and the bundle's raw
    // non-ASCII (Pele's own `[ -‍﻿]` class) turns into a range out of order.
    if (home && url === home) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    if (url.startsWith(`${PICTURE_HOST}/`)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    requests.push(`${route.request().resourceType()} ${url}`);
    return route.abort();
  });
  const box = options.tile
    ? `<div class="ib-art-prev" id="box" style="width:240px;margin:20px 0 0 20px"><span class="ib-art-svg" id="host" data-drawn></span></div>`
    : `<div id="box" style="position:relative;width:700px;height:450px;overflow:hidden"><div id="host" style="position:absolute;inset:0"></div></div>`;
  html = `<!DOCTYPE html><html><head>${options.csp ? `<meta http-equiv="Content-Security-Policy" content="${options.csp}">` : ''}<style>body{margin:0}${APP_UTILITIES}${options.tile ? artifactTileCss() : ''}</style>${options.css ? `<style>${options.css}</style>` : ''}</head><body>
<div style="height:60px"><button id="app-button">Approve</button></div>
${box}
<div style="height:300px;padding:20px 0 0 300px"><button id="app-below">Send</button></div>
<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`;
  // `origin`: served from a (route-fulfilled) http origin, so a protocol-relative `//host/…` resolves and loads as it would in an app.
  if (home) await page.goto(home);
  else await page.setContent(html);
  await page.waitForFunction(() => !!(window as any).__d, null, { timeout: 30_000 }).catch(() => {
    throw new Error(`The diagram bundle did not load: ${errors.join(' | ') || 'no error reported'}`);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  return { requests, navigations, errors };
}

/** Click the middle of every element drawn in a label, then press Enter in each field. */
export async function clickEveryLabelElement(page: Page): Promise<number> {
  const points = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#host foreignObject *'))
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0)
      .map((b) => [b.x + b.width / 2, b.y + b.height / 2] as const),
  );
  for (const [x, y] of points) await page.mouse.click(x, y);
  for (const field of await page.locator('#host input, #host textarea').all()) await field.press('Enter').catch(() => {});
  return points.length;
}
