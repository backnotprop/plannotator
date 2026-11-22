/**
 * The VS Code Guides webviews render agent-written markdown and Mermaid
 * (apps/vscode-extension/src/guides/webview). Nothing an agent writes may run
 * or navigate. happy-dom cannot run DOMPurify faithfully (it keeps a
 * `<script>`), so this proof runs the webview's own `markdown.ts` and
 * `diagram.ts`, bundled as the extension bundles them, in real Chromium under
 * the webview's CSP. No binary or VS Code is needed.
 *
 * The last tests prove the diagram sanitizer itself (`diagram-render.ts`, the
 * one Plannotator's app uses) on what only a real browser shows: the MathML
 * a `$$...$$` label is drawn with, and MathML mutation XSS. The webview
 * stubs KaTeX out, so they run the same engine bundled with real KaTeX, on a
 * page with no CSP, so a handler or a fetch that survived would happen.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const EXTENSION = resolve(__dirname, '../../apps/vscode-extension');
const WEBVIEW = join(EXTENSION, 'src/guides/webview');
const UI = resolve(__dirname, '../../packages/ui');
let bundle = '';
let uiBundle = '';
let work = '';

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'pn-guides-sanitize-'));
  const entry = join(work, 'entry.ts');
  writeFileSync(entry, `
import { renderInlineMarkdown, renderMarkdown } from ${JSON.stringify(join(WEBVIEW, 'markdown.ts'))};
import { renderMermaid } from ${JSON.stringify(join(WEBVIEW, 'diagram.ts'))};
const host = () => document.getElementById('host')!;
(window as any).__guides = {
  markdown(text: string) { host().replaceChildren(renderMarkdown(text)); return host().innerHTML; },
  inline(text: string) { host().replaceChildren(renderInlineMarkdown(text)); return host().innerHTML; },
  async mermaid(source: string) {
    const r = await renderMermaid(source);
    if (!r.ok) return { ok: false, message: r.message };
    host().replaceChildren(r.svg);
    return { ok: true, html: host().innerHTML };
  },
};
`);
  const uiEntry = join(work, 'ui-entry.ts');
  writeFileSync(uiEntry, `
import DOMPurify from 'dompurify';
import { renderDiagram, sanitizeDiagramSvg } from ${JSON.stringify(join(UI, 'utils/diagram-render.ts'))};
const host = () => document.getElementById('host')!;
// The test's handle on the sanitizer's own DOMPurify call (the one asking for a
// DOM fragment): it records the markup that call parsed, and can turn the
// MathML profile off for one sanitize, with no switch in the product.
const purify = DOMPurify as any;
const sanitize = purify.sanitize;
let parsed = '';
let mathProfileOff = false;
purify.sanitize = (dirty: unknown, cfg?: any) => {
  if (cfg && cfg.RETURN_DOM_FRAGMENT) {
    if (typeof dirty === 'string') parsed = dirty;
    if (mathProfileOff) cfg = { ...cfg, USE_PROFILES: { ...cfg.USE_PROFILES, mathMl: false } };
  }
  return sanitize(dirty, cfg);
};
let seq = 0;
(window as any).__ui = {
  async render(source: string) {
    parsed = '';
    const r = await renderDiagram('mermaid', 'pn-ui-diagram-' + ++seq, source, { colorTheme: 'plannotator', mode: 'light' });
    if (!r.ok) return { ok: false, message: r.message, raw: '' };
    host().replaceChildren(r.svgNode);
    return { ok: true, message: '', raw: parsed };
  },
  mount(markup: string, how: 'node' | 'markup') {
    const svg = sanitizeDiagramSvg(markup);
    if (!svg) return false;
    if (how === 'node') host().replaceChildren(svg);
    else host().innerHTML = svg.outerHTML;
    return true;
  },
  sanitized(markup: string, mathProfile: boolean) {
    mathProfileOff = !mathProfile;
    try {
      return sanitizeDiagramSvg(markup)?.outerHTML ?? null;
    } finally {
      mathProfileOff = false;
    }
  },
};
`);
  const out = join(work, 'bundle.js');
  const uiOut = join(work, 'ui-bundle.js');
  // The extension's own webview build options (define, aliases, minify), with this entry.
  // The ui bundle drops the KaTeX stub (Mermaid's math labels need the real one) and
  // points every 'dompurify' import at the file packages/ui resolves, so the entry's
  // handle is the sanitizer's own instance.
  const purifyModule = join(dirname(realpathSync(require.resolve('dompurify', { paths: [UI] }))), 'purify.es.mjs');
  const build = join(work, 'build.ts');
  writeFileSync(build, `
import { build } from ${JSON.stringify(join(EXTENSION, 'node_modules/esbuild/lib/main.js'))};
import { configs } from ${JSON.stringify(join(EXTENSION, 'scripts/esbuild.config.ts'))};
const webview = configs.find((c) => String(c.outdir ?? '').endsWith('dist') && c.format === 'iife');
if (!webview) throw new Error('no webview build config');
const { entryPoints: _e, outdir: _o, ...options } = webview;
await build({ ...options, absWorkingDir: ${JSON.stringify(EXTENSION)}, entryPoints: [${JSON.stringify(entry)}], outfile: ${JSON.stringify(out)}, logLevel: 'silent' });
const alias = { ...Object.fromEntries(Object.entries(options.alias ?? {}).filter(([name]) => name !== 'katex')), dompurify: ${JSON.stringify(purifyModule)} };
await build({ ...options, alias, absWorkingDir: ${JSON.stringify(EXTENSION)}, entryPoints: [${JSON.stringify(uiEntry)}], outfile: ${JSON.stringify(uiOut)}, logLevel: 'silent' });
`);
  execFileSync('bun', [build], { cwd: EXTENSION, stdio: 'pipe' });
  bundle = readFileSync(out, 'utf8');
  uiBundle = readFileSync(uiOut, 'utf8');
});

test.afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/** The webview's CSP: scripts only by nonce, inline styles allowed (webview-host.ts). */
async function open(page: import('@playwright/test').Page) {
  const nonce = 'pn-test-nonce';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setContent(`<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
</head><body class="vscode-dark"><div id="host"></div>
<script nonce="${nonce}">window.__pwned = 0;</script>
<script nonce="${nonce}">${bundle.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`);
  await page.waitForFunction(() => !!(window as any).__guides, null, { timeout: 30_000 }).catch(() => {
    throw new Error(`The webview bundle did not load: ${errors.join(' | ') || 'no error reported'}`);
  });
}

const allAttributes = (page: import('@playwright/test').Page) =>
  page.evaluate(() => Array.from(document.querySelectorAll('#host *')).flatMap((el) => Array.from(el.attributes).map((a) => `${el.tagName.toLowerCase()}@${a.name}=${a.value}`)));

test('hostile markdown comes out inert', async ({ page }) => {
  await open(page);
  await page.evaluate((text) => (window as any).__guides.markdown(text), [
    'Intro',
    '',
    '<script>window.__pwned = 1</script>',
    '<img src="x" onerror="window.__pwned = 2">',
    '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">',
    '<form action="https://evil.example"><input name="a"><button>go</button></form>',
    '<style>#host { display: none }</style>',
    '<p style="background:url(https://evil.example/x)" onclick="window.__pwned = 3" id="root" class="pn-btn">Hello</p>',
    '<svg onload="window.__pwned = 4"><script>window.__pwned = 5</script></svg>',
    '<details open ontoggle="window.__pwned = 6"><summary>s</summary>d</details>',
    '![tracker](https://evil.example/pixel.png)',
    '',
    '[click](javascript:window.__pwned=7) [js2](JaVaScRiPt:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=)',
    '<a href="javascript:window.__pwned=8">raw</a>',
    '',
    '[symbol](symbol:computeBackoff) [chapter](chapter:2) [web](https://example.com/docs)',
  ].join('\n'));
  await page.waitForTimeout(200);

  const tags = await page.evaluate(() => Array.from(document.querySelectorAll('#host *')).map((el) => el.tagName.toLowerCase()));
  for (const tag of ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'style', 'svg', 'img']) expect(tags).not.toContain(tag);
  const attrs = await allAttributes(page);
  expect(attrs.filter((a) => /@on|@style=|@id=|@href=|@target=|javascript:|data:text/i.test(a))).toEqual([]);
  expect(attrs.filter((a) => /@class=/.test(a) && !/@class=pn-(link|ext)$/.test(a))).toEqual([]);

  const links = await page.evaluate(() => Array.from(document.querySelectorAll('#host a')).map((a) => [a.textContent, a.getAttribute('data-link'), a.getAttribute('data-external')]));
  expect(links).toContainEqual(['symbol', 'symbol:computeBackoff', null]);
  expect(links).toContainEqual(['chapter', 'chapter:2', null]);
  expect(links).toContainEqual(['web', null, 'https://example.com/docs']);
  for (const t of ['click', 'js2', 'data', 'raw']) {
    const l = links.find((x) => x[0] === t);
    if (l) expect([l[1], l[2]]).toEqual([null, null]);
  }
  await page.locator('#host details').evaluate((el) => (el as HTMLDetailsElement).open = !(el as HTMLDetailsElement).open);
  await page.locator('#host a').first().click();
  expect(await page.evaluate(() => (window as any).__pwned)).toBe(0);
  expect(await page.textContent('#host')).toContain('Hello');
});

test('a file summary (inline markdown) is inert too', async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as any).__guides.inline('Adds `retry` <img src=x onerror="window.__pwned=1"> <a href="javascript:window.__pwned=2">x</a> <script>window.__pwned=3</script>'));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.querySelectorAll('#host img, #host script').length)).toBe(0);
  expect((await allAttributes(page)).filter((a) => /@on|javascript:/i.test(a))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__pwned)).toBe(0);
});

test("a diagram cannot loosen Mermaid's security level or bind a click to script", async ({ page }) => {
  await open(page);
  const r = await page.evaluate((src) => (window as any).__guides.mermaid(src), [
    "%%{init: {'securityLevel': 'loose'}}%%",
    'flowchart LR',
    '  A["<img src=x onerror=window.__pwned=1>"]-->B',
    '  B-->D["<img src=https://evil.example/pixel.png>"]',
    '  B-->C',
    '  click A call window.__pwnedCall()',
    '  click B href "javascript:window.__pwned=2"',
    '  click C "symbol:computeBackoff"',
  ].join('\n'));
  expect(r.ok).toBe(true);
  await page.evaluate(() => { (window as any).__pwnedCall = () => ((window as any).__pwned = 9); });
  for (const node of await page.locator('#host g.node').all()) await node.click({ force: true });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__pwned)).toBe(0);
  const attrs = await allAttributes(page);
  expect(attrs.filter((a) => /@on|javascript:/i.test(a))).toEqual([]);
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('#host img, #host script, #host a[href]')).map((e) => e.outerHTML))).toEqual([]);
  // Only the guide link survives, as a data-link the webview's own handler acts on.
  expect(await page.evaluate(() => Array.from(document.querySelectorAll('#host [data-link]')).map((e) => e.getAttribute('data-link')))).toEqual(['symbol:computeBackoff']);
});

test('agent text cannot set the attributes the webview acts on (data-external, data-link, data-popover-*)', async ({ page }) => {
  await open(page);
  await page.evaluate((text) => (window as any).__guides.markdown(text), [
    '<span data-external="https://evil.example/a">a span</span> <p data-link="code:x.ts" data-popover-action="open" data-popover-link="code:y.ts">p</p>',
    '<a href="https://example.com/ok" data-external="https://evil.example/b">a real link</a> [md](https://example.com/md) [sym](symbol:computeBackoff)',
  ].join('\n\n'));
  const marked = await page.evaluate(() => Array.from(document.querySelectorAll('#host [data-external], #host [data-link], #host [data-popover-action], #host [data-popover-link]')).map((el) => [el.tagName.toLowerCase(), el.textContent, el.getAttribute('data-external'), el.getAttribute('data-link')]));
  // Only real links carry them, set from their own href by the extension.
  expect(marked).toEqual([
    ['a', 'a real link', 'https://example.com/ok', null],
    ['a', 'md', 'https://example.com/md', null],
    ['a', 'sym', null, 'symbol:computeBackoff'],
  ]);
  const anyData = (await allAttributes(page)).filter((a) => /@data-/.test(a) && !/@data-(external|link)=/.test(a));
  expect(anyData).toEqual([]);
});

test('a diagram label cannot carry data-external or data-link either', async ({ page }) => {
  await open(page);
  const r = await page.evaluate((src) => (window as any).__guides.mermaid(src), [
    'flowchart LR',
    `  A["<span data-external='https://evil.example/x' data-link='code:z.ts'>label</span>"]-->B`,
    '  click B "chapter:2"',
  ].join('\n'));
  expect(r.ok).toBe(true);
  const attrs = await page.evaluate(() => Array.from(document.querySelectorAll('#host [data-external], #host [data-link]')).map((el) => [el.getAttribute('data-external'), el.getAttribute('data-link')]));
  expect(attrs).toEqual([[null, 'chapter:2']]);
});

// The diagram sanitizer itself (see the header): real Mermaid, KaTeX and DOMPurify, no CSP.

const MATHML = 'http://www.w3.org/1998/Math/MathML';

async function openUi(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent(`<!DOCTYPE html><html><head></head><body><div id="host"></div>
<script>window.__pwned = 0;</script>
<script>${uiBundle.replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`);
  await page.waitForFunction(() => !!(window as any).__ui, null, { timeout: 30_000 }).catch(() => {
    throw new Error(`The diagram bundle did not load: ${errors.join(' | ') || 'no error reported'}`);
  });
}

const MATH_DIAGRAM = 'flowchart LR\n  A["$$x^2+\\frac{a}{b}$$"] --> B';

test('a $$...$$ label in a Mermaid diagram is drawn as MathML, not an empty box', async ({ page }) => {
  // What regresses: the sanitizer's parse drops <math> with its content (no
  // MathML profile), so the node draws with no label.
  await openUi(page);
  const r = await page.evaluate((src) => (window as any).__ui.render(src), MATH_DIAGRAM);
  expect(r.ok, r.message).toBe(true);
  const maths = await page.evaluate((ns) => Array.from(document.getElementById('host')!.getElementsByTagNameNS(ns, 'math')).map((m) => ({
    msup: Array.from(m.getElementsByTagNameNS(ns, 'msup')).map((e) => (e.textContent ?? '').replace(/\s+/g, '')),
    mfrac: Array.from(m.getElementsByTagNameNS(ns, 'mfrac')).map((e) => (e.textContent ?? '').replace(/\s+/g, '')),
  })), MATHML);
  expect(maths.length).toBeGreaterThan(0);
  for (const m of maths) {
    expect(m.msup).toEqual(['x2']);
    expect(m.mfrac).toEqual(['ab']);
  }
});

test('a link or a picture on a MathML element is dropped, and nothing is fetched', async ({ page }) => {
  await openUi(page);
  const fetched: string[] = [];
  await page.route(/evil\.test/, (route) => {
    fetched.push(route.request().url());
    return route.abort();
  });
  const markup = '<svg id="r"><foreignObject><div><math><mrow href="https://evil.test/a"><mi xlink:href="https://evil.test/b" src="https://evil.test/c">x</mi></mrow><mglyph src="https://evil.test/g.png"/></math></div></foreignObject></svg>';
  expect(await page.evaluate((m) => (window as any).__ui.mount(m, 'node'), markup)).toBe(true);
  await page.waitForTimeout(300);
  const seen = await page.evaluate((ns) => {
    const host = document.getElementById('host')!;
    return {
      refs: Array.from(host.querySelectorAll('*')).flatMap((el) => Array.from(el.attributes).filter((a) => a.localName === 'href' || a.localName === 'src').map((a) => `${el.localName}@${a.name}`)),
      mathGlyphs: host.getElementsByTagNameNS(ns, 'mglyph').length,
      anyGlyphs: host.getElementsByTagName('mglyph').length,
      maths: host.getElementsByTagNameNS(ns, 'math').length,
      text: host.textContent,
    };
  }, MATHML);
  expect(seen.refs).toEqual([]);
  expect(seen.mathGlyphs).toBe(0);
  expect(seen.anyGlyphs).toBe(0);
  expect(seen.maths).toBe(1);
  expect(seen.text).toBe('x');
  expect(fetched).toEqual([]);
  // The watch is live: a picture this page does load is seen.
  await page.evaluate(() => {
    const img = document.createElement('img');
    img.src = 'https://evil.test/control.png';
    document.body.append(img);
  });
  await expect.poll(() => fetched.includes('https://evil.test/control.png')).toBe(true);
});

/** Known MathML mutation-XSS shapes (namespace confusion through mglyph, annotation-xml, an svg in mi, maction). */
const MXSS = [
  '<math><mtext><table><mglyph><style><img src=x onerror=window.__pwned=1>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=window.__pwned=2&gt;">',
  '<math><annotation-xml encoding="text/html"><style><img src=x onerror=window.__pwned=3>',
  '<math><mi><svg><style><img src=x onerror=window.__pwned=4>',
  '<math><maction actiontype="statusline" xlink:href="https://evil.test"><mi>x</mi></maction>',
];

for (const how of ['node', 'markup'] as const) {
  test(`MathML mutation XSS stays inert, mounted as ${how === 'node' ? 'the sanitized node' : 'its markup parsed again'}`, async ({ page }) => {
    // `markup`: the sanitized tree serialized and parsed again, where a
    // namespace confusion would turn text into elements.
    await openUi(page);
    for (const payload of MXSS) {
      expect(await page.evaluate(([m, h]) => (window as any).__ui.mount(m, h), [`<svg><foreignObject><div>${payload}`, how] as const), payload).toBe(true);
      await page.waitForTimeout(100);
      const seen = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('#host *'));
        return {
          tags: els.map((el) => el.localName),
          handlers: els.flatMap((el) => el.getAttributeNames().filter((n) => /^on/i.test(n)).map((n) => `${el.localName}@${n}`)),
        };
      });
      expect(seen.tags.filter((t) => t === 'annotation-xml' || t === 'maction' || t === 'semantics'), payload).toEqual([]);
      expect(seen.handlers, payload).toEqual([]);
      expect(await page.evaluate(() => (window as any).__pwned), payload).toBe(0);
    }
  });
}

test('a diagram with no math sanitizes the same with or without the MathML profile', async ({ page }) => {
  await openUi(page);
  const sanitized = (markup: string, mathProfile: boolean) =>
    page.evaluate(([m, p]) => (window as any).__ui.sanitized(m, p) as string | null, [markup, mathProfile] as const);
  // The toggle reaches the sanitizer's own call: with the profile off, a math label loses its math.
  const math = await page.evaluate((src) => (window as any).__ui.render(src), MATH_DIAGRAM);
  expect(math.ok, math.message).toBe(true);
  expect(math.raw).toContain('<math');
  expect(await sanitized(math.raw, true)).toContain('<mfrac');
  expect(await sanitized(math.raw, false)).not.toContain('<math');

  const plain = await page.evaluate((src) => (window as any).__ui.render(src), [
    'flowchart LR',
    '  A[Start] -->|yes| B{Decide}',
    '  B --> C(Done)',
    '  subgraph S [Group]',
    '    C',
    '  end',
    '  classDef hot fill:#f96',
    '  class A hot',
  ].join('\n'));
  expect(plain.ok, plain.message).toBe(true);
  expect(plain.raw.toLowerCase()).toContain('<foreignobject');
  const withProfile = await sanitized(plain.raw, true);
  expect(withProfile).toContain('Decide');
  expect(withProfile).toBe(await sanitized(plain.raw, false));
});
