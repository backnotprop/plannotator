/**
 * `configurePlannotatorUI({ diagramRemoteLoads: false })`, for a host that
 * must never let a diagram call another host (a signed-in hosted app). Proven
 * with real Mermaid and DOMPurify (diagram-ui-bundle.ts), on a page served
 * from an http origin (so a protocol-relative `//host/…` resolves) with no
 * CSP, every request that reaches the network recorded (and aborted):
 *
 * - off: no diagram source in the classes Mermaid lets through to its label
 *   pass, its stylesheet or the drawn svg (a label's pictures and media and
 *   their attributes, a style that loads however it is spelled, a directive's
 *   or front matter's CSS) makes a single request, while Mermaid draws or
 *   after it is mounted;
 * - off: real diagrams still draw (bold, italic, line breaks, coloured text,
 *   classDef colours, a `data:` picture in a label and as a picture node);
 * - on (the default, every Plannotator app): exactly as before, and a host's
 *   late call reaches the next render;
 * - the label hook survives a host removing DOMPurify's hooks, and a bundle
 *   where Mermaid has its own DOMPurify falls back to the stricter label pass
 *   (still nothing loads);
 * - what Mermaid itself loads before any sanitizer (a diagram's own `style` /
 *   `classDef` statements, which Mermaid applies itself; picture nodes; a
 *   sequence actor's icon) does load without a CSP, and the page CSP the
 *   HANDOFF names stops all of it; under that CSP every such diagram draws
 *   (without the picture) except a picture node pointing at another host,
 *   which fails to draw.
 *
 * Runs in Chromium and WebKit (playwright.config.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { buildDiagramUiBundle, openDiagramPage } from './diagram-ui-bundle';

let bundle = '';
let splitBundle = '';
test.beforeAll(() => {
  bundle = buildDiagramUiBundle();
  splitBundle = buildDiagramUiBundle({ splitPurify: true });
});

/** The page's own origin (fulfilled by the test, nothing leaves the machine). */
const APP = 'http://app.test';

const FAR = 'https://far.test';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const flow = (label: string) => `flowchart LR\n  A["${label}"] --> B[ok]`;
const pad = 'x'.repeat(4200);

/** Classes Mermaid hands to a sanitizer or a config check: with the option off, none may load. */
const CLOSED: Record<string, string> = {
  'label img': flow(`<img src='${FAR}/img.png' width=20 height=20>`),
  'label img, leading space': flow(`<img src=' ${FAR}/img2.png' width=20 height=20>`),
  'label img, //host': flow(`<img src='//far.test/img3.png' width=20 height=20>`),
  'label style url, //host': flow(`<span style='background:url(//far.test/bg2.png)'>x</span>`),
  'label srcset': flow(`<img srcset='${FAR}/srcset.png 1x' width=20 height=20>`),
  'label picture': flow(`<picture><source srcset='${FAR}/pic.png'><img width=20 height=20></picture>`),
  'label video poster': flow(`<video poster='${FAR}/poster.png' width=40 height=20></video>`),
  'label video source': flow(`<video width=40 height=20><source src='${FAR}/v.mp4'><track src='${FAR}/t.vtt'></video>`),
  'label audio': flow(`<audio src='${FAR}/a.mp3' controls></audio>`),
  'label table background': flow(`<table background='${FAR}/tbg.png'><tr><td background='${FAR}/tdbg.png'>cell</td></tr></table>`),
  'label svg image': flow(`<svg width=20 height=20><image href='${FAR}/svgimg.png' width=20 height=20></image></svg>`),
  'label style url': flow(`<span style='background:url(${FAR}/bg.png)'>x</span>`),
  'label style image-set': flow(`<span style='background-image:image-set(url(${FAR}/is.png) 1x)'>x</span>`),
  'label style -webkit-image-set string': flow(`<span style='background-image:-webkit-image-set(#quot;${FAR}/wis.png#quot; 1x)'>x</span>`),
  'label style cross-fade': flow(`<span style='background-image:cross-fade(url(${FAR}/cf.png), url(${FAR}/cf2.png), 50%)'>x</span>`),
  'label style cursor': flow(`<span style='cursor:url(${FAR}/cur.png),auto'>x</span>`),
  'label style list-style-image': flow(`<ul style='list-style-image:url(${FAR}/li.png)'><li>x</li></ul>`),
  'label style escaped url': flow(`<span style='background:u\\72l(${FAR}/esc.png)'>x</span>`),
  'label style C0 escape in url': flow(`<span style='background:url(\\1 ${FAR}/c0.png)'>x</span>`),
  'label style entity paren': flow(`<span style='background:url&#40;${FAR}/ent.png)'>x</span>`),
  'directive themeCSS': `%%{init: {"themeCSS": ".nodeLabel { background-image: url(${FAR}/tc.png) }"}}%%\n${flow('x')}`,
  'directive themeCSS, JSON escape': `%%{init: {"themeCSS": ".nodeLabel { background-image: \\u0075rl(${FAR}/tcj.png) }"}}%%\n${flow('x')}`,
  'directive themeCSS, padded past 4096': `%%{init: {"themeCSS": "/*${pad}*/ .nodeLabel { background-image: url(${FAR}/tcp.png) }"}}%%\n${flow('x')}`,
  'directive fontFamily': `%%{init: {"fontFamily": "x; background-image: url(${FAR}/ff.png)"}}%%\n${flow('x')}`,
  'directive altFontFamily': `%%{init: {"altFontFamily": "x; background-image: url(${FAR}/aff.png)"}}%%\n${flow('x')}`,
  'front matter themeCSS': `---\nconfig:\n  themeCSS: ".nodeLabel { background-image: url(${FAR}/fm.png) }"\n---\n${flow('x')}`,
  'front matter themeCSS, YAML escape': `---\nconfig:\n  themeCSS: ".nodeLabel { background-image: \\x75rl(${FAR}/fmx.png) }"\n---\n${flow('x')}`,
  'front matter fontFamily': `---\nconfig:\n  fontFamily: "x; background-image: url(${FAR}/fmf.png)"\n---\n${flow('x')}`,
};

/** A CSS-escaped `https://far.test/<file>`: the style grammars reject a plain `https://`. */
const escaped = (file: string) => `https\\00003a\\00002f\\00002ffar.test\\00002f${file}`;

/**
 * What Mermaid loads while it draws, before any sanitizer or config check: a
 * diagram's own `style` / `classDef` statements (Mermaid applies them itself),
 * picture nodes, a sequence actor's icon. Only a page CSP stops these.
 * `everywhere`: loads in both Chromium and WebKit without a CSP (an external
 * svg paint server in `fill: url(…)` is fetched by Chromium only).
 */
const BEFORE_ANY_SANITIZER: Record<string, { source: string; everywhere: boolean }> = {
  'state classDef': { everywhere: true, source: `stateDiagram-v2\n  classDef bad background-image:url(${FAR}/scd.png)\n  [*] --> s1\n  class s1 bad` },
  'state classDef, //host': { everywhere: true, source: 'stateDiagram-v2\n  classDef bad background-image:url(//far.test/scd2.png)\n  [*] --> s1\n  class s1 bad' },
  'state classDef, escaped': { everywhere: true, source: `stateDiagram-v2\n  classDef bad background-image:url(${escaped('scd3.png')})\n  [*] --> s1\n  class s1 bad` },
  'state style, //host': { everywhere: true, source: 'stateDiagram-v2\n  [*] --> s1\n  style s1 background-image:url(//far.test/ssb.png)' },
  'state style, escaped': { everywhere: true, source: `stateDiagram-v2\n  [*] --> s1\n  style s1 background-image:url(${escaped('sse.png')})` },
  'state style fill, //host': { everywhere: false, source: 'stateDiagram-v2\n  [*] --> s1\n  style s1 fill:url(//far.test/sst.svg)' },
  'class diagram style': { everywhere: true, source: `classDiagram\n  class A\n  style A fill:url(${FAR}/c.svg),background-image:url(${FAR}/cb.png)` },
  'class diagram style, escaped': { everywhere: true, source: `classDiagram\n  class A\n  style A fill:#fff,background-image:url(${escaped('cse.png')})` },
  'class diagram style fill, //host': { everywhere: false, source: 'classDiagram\n  class A\n  style A fill:url(//far.test/csf.svg)' },
  'block classDef, //host': { everywhere: true, source: 'block-beta\n  a b\n  classDef bad background-image:url(//far.test/bcd.png)\n  class a bad' },
  'block classDef, escaped': { everywhere: true, source: `block-beta\n  a b\n  classDef bad background-image:url(${escaped('bcd2.png')})\n  class a bad` },
  'block style fill, //host': { everywhere: false, source: 'block-beta\n  a b\n  style a fill:url(//far.test/bst.svg)' },
  'treemap classDef, //host': { everywhere: true, source: 'treemap-beta\n"Root"\n    "A":::bad\n      "A1": 10\n    "B": 20\nclassDef bad background-image:url(//far.test/tcd.png)' },
  'treemap classDef, escaped': { everywhere: true, source: `treemap-beta\n"Root"\n    "A":::bad\n      "A1": 10\n    "B": 20\nclassDef bad background-image:url(${escaped('tce.png')})` },
  'sequence actor icon': { everywhere: true, source: `sequenceDiagram\n  participant A\n  properties A: {"icon": "${FAR}/icon.png"}\n  A->>B: hi` },
  'picture node': { everywhere: true, source: `flowchart LR\n  A@{ img: "${FAR}/shape.png", label: "pic", w: 40, h: 40 } --> B` },
  'picture node, quoted key': { everywhere: true, source: `flowchart LR\n  A@{ "img": "${FAR}/shape2.png" } --> B` },
  'picture node, //host': { everywhere: true, source: 'flowchart LR\n  A@{ img: "//far.test/shape3.png", label: "pic", w: 40, h: 40 } --> B' },
};

/** The policy the HANDOFF names for a host that must load nothing from another host. */
const HOST_CSP = "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:";

/** Every request that reaches the network (one the page's CSP blocks never does), recorded and aborted. */
async function open(page: Page, csp?: string, engine = bundle) {
  const { requests } = await openDiagramPage(page, engine, { csp, origin: APP });
  return requests;
}

const render = (page: Page, source: string) =>
  page.evaluate((s) => (window as any).__d.render(s) as Promise<{ ok: boolean; refused: boolean; message: string }>, source);
const remoteLoads = (page: Page, on: boolean) => page.evaluate((v) => (window as any).__d.remoteLoads(v), on);
const settle = (page: Page) => page.waitForTimeout(300);

test('off: nothing in a label, a style, a directive or front matter loads from another host', async ({ page }) => {
  const seen = await open(page);
  await remoteLoads(page, false);
  for (const [name, source] of Object.entries(CLOSED)) {
    seen.length = 0;
    const r = await render(page, source);
    expect([name, r.ok, r.message]).toEqual([name, true, '']);
    await settle(page);
    expect([name, seen]).toEqual([name, []]);
  }
});

test("off: Mermaid's own drawing into the live page already holds nothing from another host", async ({ page }) => {
  await open(page);
  await remoteLoads(page, false);
  for (const [name, source] of Object.entries(CLOSED)) {
    const raw = await page.evaluate((s) => (window as any).__d.measure(s) as Promise<string | null>, source);
    expect(raw, name).not.toBeNull();
    expect([name, raw!.includes('far.test')]).toEqual([name, false]);
  }
});

test('off: real diagrams still draw, data: pictures included', async ({ page }) => {
  const seen = await open(page);
  await remoteLoads(page, false);
  const drawn = async (source: string) => {
    const r = await render(page, source);
    expect(r.ok, r.message).toBe(true);
    return page.locator('#host');
  };
  await drawn('flowchart TD\n  A["<b>Bold</b> and <i>italic</i><br>next line"] --> B');
  expect(await page.locator('#host b').textContent()).toBe('Bold');
  expect(await page.locator('#host i').textContent()).toBe('italic');
  expect(await page.locator('#host br').count()).toBeGreaterThan(0);
  await drawn(`flowchart LR\n  A["<span id=red style='color:red;font-weight:bold'>red</span>"] --> B`);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#host #red, #host [id$=red]')!).color)).toBe('rgb(255, 0, 0)');
  await drawn('flowchart LR\n  A[Start] --> B\n  classDef hot fill:#ff9966,color:#ffffff\n  class A hot');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#host .node.hot rect, #host .node.hot path')!).fill)).toBe('rgb(255, 153, 102)');
  await drawn(flow(`<img src='${PNG}' width=20 height=20> logo`));
  await expect.poll(() => page.evaluate(() => (document.querySelector('#host img') as HTMLImageElement | null)?.naturalWidth ?? 0)).toBe(1);
  await drawn(`flowchart LR\n  A@{ img: "${PNG}", label: "pic", w: 40, h: 40 } --> B`);
  expect(await page.locator('#host image').getAttribute('href')).toBe(PNG);
  await settle(page);
  expect(seen).toEqual([]);
});

test('on (the default): as before, and a late call reaches the next render either way', async ({ page }) => {
  const seen = await open(page);
  const source = CLOSED['label style url']!;
  const html = () => page.evaluate(() => document.querySelector('#host')!.innerHTML.replace(/pn-scrub-\d+/g, 'ID'));
  // Default: the label's picture is the page's to decide (no CSP here, so it loads).
  await render(page, source);
  await settle(page);
  const before = await html();
  expect(seen.some((line) => line.includes(`${FAR}/bg.png`))).toBe(true);
  // A host's call after the first diagram applies to the next render...
  await remoteLoads(page, false);
  seen.length = 0;
  await render(page, source);
  await settle(page);
  expect(seen).toEqual([]);
  // ...and turning it back on gives exactly the default again.
  await remoteLoads(page, true);
  seen.length = 0;
  await render(page, source);
  await settle(page);
  expect(await html()).toBe(before);
  expect(seen.some((line) => line.includes(`${FAR}/bg.png`))).toBe(true);
});

test('the label hook survives a host removing DOMPurify hooks', async ({ page }) => {
  const seen = await open(page);
  await remoteLoads(page, false);
  const label = CLOSED['label img']!;
  const styled = CLOSED['label style url']!;
  for (const all of [true, false]) {
    await render(page, flow('first'));
    await page.evaluate((a) => (window as any).__d.removePurifyHooks(a), all);
    seen.length = 0;
    expect((await render(page, label)).ok).toBe(true);
    expect((await render(page, styled)).ok).toBe(true);
    await settle(page);
    expect([all ? 'removeAllHooks' : 'removeHooks', seen]).toEqual([all ? 'removeAllHooks' : 'removeHooks', []]);
    // Mermaid's label pass still ran the hook (not the fallback): the colour of a label is kept.
    await render(page, `flowchart LR\n  A["<span id=red style='color:red'>red</span>"] --> B`);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#host [id$=red]')!).color)).toBe('rgb(255, 0, 0)');
  }
});

test('where Mermaid has its own DOMPurify, the stricter label pass still loads nothing', async ({ page }) => {
  const seen = await open(page, undefined, splitBundle);
  await remoteLoads(page, false);
  for (const [name, source] of Object.entries(CLOSED)) {
    seen.length = 0;
    const r = await render(page, source);
    expect([name, r.ok, r.message]).toEqual([name, true, '']);
    await settle(page);
    expect([name, seen]).toEqual([name, []]);
  }
  // The fallback is what ran (the hook cannot reach that copy): a label keeps its words, not its colour.
  await render(page, `flowchart LR\n  A["<span id=red style='color:red'>red</span>"] --> B`);
  expect(await page.locator('#host').textContent()).toContain('red');
  expect(await page.evaluate(() => document.querySelector('#host [style*="color:red"], #host [style*="color: red"]'))).toBeNull();
});

test('what Mermaid loads before any sanitizer loads without a CSP, and the HANDOFF policy stops all of it', async ({ browser }) => {
  for (const csp of [undefined, HOST_CSP]) {
    const page = await browser.newPage();
    const seen = await open(page, csp);
    await remoteLoads(page, false);
    for (const [name, { source, everywhere }] of Object.entries(BEFORE_ANY_SANITIZER)) {
      seen.length = 0;
      await render(page, source);
      await settle(page);
      // Without the CSP these still load (so the HANDOFF's description is current); with it, none does.
      if (csp) expect([name, seen]).toEqual([name, []]);
      else if (everywhere) expect([name, seen.length > 0]).toEqual([name, true]);
    }
    await page.close();
  }
});

test('under the HANDOFF policy each of them draws without its picture, except a picture node pointing at another host', async ({ page }) => {
  const seen = await open(page, HOST_CSP);
  await remoteLoads(page, false);
  for (const [name, { source }] of Object.entries(BEFORE_ANY_SANITIZER)) {
    const r = await render(page, source);
    if (name.startsWith('picture node')) {
      // Mermaid sizes a picture node from the decoded picture; a blocked one fails the whole diagram.
      expect([name, r.ok]).toEqual([name, false]);
      continue;
    }
    expect([name, r.ok, r.message]).toEqual([name, true, '']);
    const far = await page.evaluate(() =>
      [
        ...Array.from(document.querySelectorAll('#host *')).flatMap((e) => Array.from(e.attributes).filter((a) => a.value.includes('far.test')).map((a) => `${e.localName}@${a.name}`)),
        ...Array.from(document.querySelectorAll('#host style')).filter((e) => (e.textContent ?? '').includes('far.test')).map(() => 'style'),
      ],
    );
    expect([name, far]).toEqual([name, []]);
  }
  // A data: picture node still shows.
  const r = await render(page, `flowchart LR\n  A@{ img: "${PNG}", label: "pic", w: 40, h: 40 } --> B`);
  expect(r.ok, r.message).toBe(true);
  expect(await page.locator('#host image').getAttribute('href')).toBe(PNG);
  await settle(page);
  expect(seen).toEqual([]);
});
