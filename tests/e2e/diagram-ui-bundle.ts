/**
 * The diagram engine Plannotator's apps use (`packages/ui/utils/diagram-render.ts`
 * with real Mermaid and DOMPurify), bundled for a page with no CSP, so a fetch
 * or a navigation that got through would happen. Built with the VS Code Guides
 * webview's esbuild options (as vscode-guides-sanitize.spec.ts does), with this
 * entry. Used by diagram-label-scrub.spec.ts and diagram-label-scrub-webkit.spec.ts.
 *
 * The page's handle, `window.__d`:
 * - `render(source)`: `renderDiagram`, the drawn svg mounted in `#host`;
 *   `{ ok, refused, message }`.
 * - `measure(source)`: Mermaid alone, as `renderDiagram` runs it (same runtime,
 *   same config), with no sanitizer after it: what Mermaid's own drawing into
 *   the live page does. The raw svg, or null.
 * - `labelRulesChanged(markup)`: what the sanitizer's post-pass changed in the
 *   markup beyond the rules it always had (an `<a>` target, a `<style>` text):
 *   one line per element or attribute that differs from the DOMPurify parse alone.
 */
import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const EXTENSION = resolve(__dirname, '../../apps/vscode-extension');
const UI = resolve(__dirname, '../../packages/ui');

export function buildDiagramUiBundle(): string {
  const work = mkdtempSync(join(tmpdir(), 'pn-diagram-scrub-'));
  try {
    const entry = join(work, 'entry.ts');
    writeFileSync(entry, `
import { parseDiagramSvg, renderDiagram, sanitizeDiagramSvg } from ${JSON.stringify(join(UI, 'utils/diagram-render.ts'))};
import { loadMermaidRuntime } from ${JSON.stringify(join(UI, 'utils/mermaid.ts'))};
import { applyMermaidTheme, mermaidThemeKey } from ${JSON.stringify(join(UI, 'utils/mermaidTheme.ts'))};
const host = () => document.getElementById('host')!;
let seq = 0;
function describe(el: Element): string[] {
  return [el, ...Array.from(el.querySelectorAll('*'))].map((e) => {
    const attrs = e.localName === 'a' ? [] : Array.from(e.attributes).map((a) => a.name + '=' + a.value).sort();
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
  async measure(source: string) {
    const mermaid = await loadMermaidRuntime();
    applyMermaidTheme(mermaid, mermaidThemeKey('plannotator', 'light'));
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
await build({ ...options, absWorkingDir: ${JSON.stringify(EXTENSION)}, entryPoints: [${JSON.stringify(entry)}], outfile: ${JSON.stringify(out)}, logLevel: 'silent' });
`);
    execFileSync('bun', [build], { cwd: EXTENSION, stdio: 'pipe' });
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The utilities an app's stylesheet carries (Tailwind's own output for these class names). */
export const APP_UTILITIES = `.fixed{position:fixed}.absolute{position:absolute}.inset-0{inset:0}.top-0{top:0}.left-0{left:0}.z-50{z-index:50}.w-screen{width:100vw}.h-screen{height:100vh}.bg-red-500{background-color:rgb(239 68 68)}`;

/**
 * A page with the app's utilities, a button outside the diagram, and `#host`
 * inside `box` (the box's own CSS): every request that is not this page's is
 * recorded in `requests` and aborted, and every navigation of the page after
 * it loaded is recorded in `navigations`.
 */
export async function openDiagramPage(page: Page, bundle: string, box = 'position:relative;width:700px;height:450px;overflow:hidden') {
  const errors: string[] = [];
  const requests: string[] = [];
  const navigations: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^(?!data:|about:)/, (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.setContent(`<!DOCTYPE html><html><head><style>body{margin:0}${APP_UTILITIES}</style></head><body>
<div style="height:60px"><button id="app-button">Approve</button></div>
<div id="box" style="${box}"><div id="host" style="position:absolute;inset:0"></div></div>
<div style="height:300px;padding-left:300px"><button id="app-below">Send</button></div>
<script>${bundle.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`);
  await page.waitForFunction(() => !!(window as any).__d, null, { timeout: 30_000 }).catch(() => {
    throw new Error(`The diagram bundle did not load: ${errors.join(' | ') || 'no error reported'}`);
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  return { requests, navigations, errors };
}
