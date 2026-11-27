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
 * - as shipped ('pele-where-safe'): those same sources are drawn by Pele and
 *   load nothing, with the option on or off; a picture, an icon, a link, a
 *   style, an svg image or a font from another host never reaches the drawn
 *   diagram with the option off, whichever engine draws it; and a host's
 *   `accept` check is handed Pele's svg with no outside reference, Mermaid's
 *   with the reference it kept when the option is on, and without a label's
 *   picture when it is off.
 * - a host's source check (`DiagramSourceAcceptContext`, through
 *   `useDiagramRender` as the document draws a fence): refusing, every source
 *   above makes no request and loads no engine, with no CSP, whether Mermaid
 *   draws every fence or the switch is as shipped; accepting, the sources load
 *   exactly as with no check.
 *
 * Runs in Chromium and WebKit (playwright.config.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { buildDiagramUiBundle, openDiagramPage } from './diagram-ui-bundle';

let bundle = '';
let splitBundle = '';
/** The switch as shipped: Pele draws what it can, Mermaid the rest (a picture-only label, say). */
let shipped = '';
/** The same two, drawing through `useDiagramRender` under a host's source check (`__d.checked`). */
let checkedMermaid = '';
let checkedShipped = '';
test.beforeAll(() => {
  bundle = buildDiagramUiBundle();
  splitBundle = buildDiagramUiBundle({ splitPurify: true });
  shipped = buildDiagramUiBundle({ engine: 'pele-where-safe' });
  checkedMermaid = buildDiagramUiBundle({ sourceCheck: true });
  checkedShipped = buildDiagramUiBundle({ engine: 'pele-where-safe', sourceCheck: true });
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
 * picture nodes, a sequence actor's icon. When Mermaid draws them, only an
 * enforced page CSP stops these; as shipped, Pele drew each of them here and nothing loaded.
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

const render = (page: Page, source: string, refuse?: string) =>
  page.evaluate(([s, r]) => (window as any).__d.render(s, r) as Promise<{ ok: boolean; refused: boolean; message: string }>, [source, refuse] as const);
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

test('off, as shipped: nothing in a label, a style, a directive or front matter loads from another host, whichever engine draws it', async ({ page }) => {
  const seen = await open(page, undefined, shipped);
  await remoteLoads(page, false);
  const engines = new Set<string>();
  for (const [name, source] of Object.entries(CLOSED)) {
    seen.length = 0;
    const r = await render(page, source);
    expect([name, r.ok, r.message]).toEqual([name, true, '']);
    engines.add((await page.locator('#host > svg').getAttribute('class'))?.includes('pele') ? 'pele' : 'mermaid');
    await settle(page);
    expect([name, seen]).toEqual([name, []]);
  }
  // Both engines drew some of them: the shipped path and its fallback are both covered.
  expect([...engines].sort()).toEqual(['mermaid', 'pele']);
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

// ------------------------------------------------------------ as shipped
// The switch as it ships ('pele-where-safe'): Pele draws what it can, Mermaid
// the rest. What regresses if these fail: an engine change moves one of these
// sources from Pele to Mermaid (where what Mermaid loads before any sanitizer
// loads again without a CSP), Pele starts drawing a picture, an icon, a link
// or a style that loads, or what a host's `accept` check is handed changes.
// packages/ui/utils/hostDiagramSafety.test.ts pins the same cases in bun.

/** Where the drawn diagram in `#host` names another host: an attribute, or a `<style>`'s text. */
const outsideInHost = (page: Page) =>
  page.evaluate(() => [
    ...Array.from(document.querySelectorAll('#host *')).flatMap((e) => Array.from(e.attributes).filter((a) => a.value.includes('far.test')).map((a) => `${e.localName}@${a.name}`)),
    ...Array.from(document.querySelectorAll('#host style')).filter((e) => (e.textContent ?? '').includes('far.test')).map(() => 'style'),
  ]);
const engineInHost = async (page: Page) => ((await page.locator('#host > svg').getAttribute('class'))?.includes('pele') ? 'pele' : 'mermaid');

/** One of each kind a host's own check may look for, and which engine draws it as shipped. */
const HOSTILE: Record<string, { source: string; drawnBy: 'pele' | 'mermaid' }> = {
  'flowchart picture node': { drawnBy: 'pele', source: `flowchart LR\n  A@{ img: "${FAR}/hn.png", label: "pic", w: 40, h: 40 } --> B` },
  'picture beside words in a label': { drawnBy: 'pele', source: flow(`<img src='${FAR}/hb.png' width=20 height=20> pic`) },
  'a label that is only a picture': { drawnBy: 'mermaid', source: flow(`<img src='${FAR}/ho.png' width=20 height=20>`) },
  'sequence actor icon': { drawnBy: 'pele', source: `sequenceDiagram\n  participant A\n  properties A: {"icon": "${FAR}/hi.png"}\n  A->>B: hi` },
  'state style with url()': { drawnBy: 'pele', source: 'stateDiagram-v2\n  [*] --> s1\n  style s1 background-image:url(//far.test/hs.png)' },
  'click link with an href': { drawnBy: 'pele', source: `flowchart LR\n  A --> B\n  click A "${FAR}/go" _blank\n  click B href "${FAR}/go2"` },
  'svg image and use in a label': { drawnBy: 'pele', source: flow(`<svg width=20 height=20><image href='${FAR}/hsi.png' width=20 height=20></image><use href='${FAR}/hu.svg#x'></use></svg> x`) },
  'stylesheet and font in a style block': { drawnBy: 'pele', source: `%%{init: {"themeCSS": "@import url(${FAR}/hs.css); @font-face { font-family: x; src: url(${FAR}/hf.woff2) } .node { background: url(${FAR}/htc.png) }"}}%%\n${flow('x')}` },
};

test('as shipped: what Mermaid loads before any sanitizer is drawn by Pele, and nothing loads, remote loads off or on, with no CSP', async ({ browser }) => {
  for (const on of [false, true]) {
    const page = await browser.newPage();
    const seen = await open(page, undefined, shipped);
    await remoteLoads(page, on);
    for (const [name, { source }] of Object.entries(BEFORE_ANY_SANITIZER)) {
      seen.length = 0;
      const r = await render(page, source);
      expect([on, name, r.ok, r.message]).toEqual([on, name, true, '']);
      expect([on, name, await engineInHost(page)]).toEqual([on, name, 'pele']);
      await settle(page);
      expect([on, name, seen, await outsideInHost(page)]).toEqual([on, name, [], []]);
    }
    await page.close();
  }
});

test('as shipped, remote loads off: a picture, an icon, a link, a style, an svg image or a font from another host never reaches the drawn diagram, whichever engine draws it; under the HANDOFF policy nothing loads', async ({ browser }) => {
  for (const csp of [undefined, HOST_CSP]) {
    const page = await browser.newPage();
    const seen = await open(page, csp, shipped);
    await remoteLoads(page, false);
    for (const [name, { source, drawnBy }] of Object.entries(HOSTILE)) {
      seen.length = 0;
      const r = await render(page, source);
      expect([name, r.ok, r.message]).toEqual([name, true, '']);
      expect([name, await engineInHost(page)]).toEqual([name, drawnBy]);
      await settle(page);
      expect([name, await outsideInHost(page)]).toEqual([name, []]);
      // Pele draws none of it, so nothing loads even with no CSP; down the fallback the CSP is what holds.
      if (csp || drawnBy === 'pele') expect([name, seen]).toEqual([name, []]);
    }
    await page.close();
  }
});

test("as shipped: a host's accept check is handed Pele's svg with no outside reference in it, so it draws; down the Mermaid fallback it gets the reference Mermaid kept with remote loads on, and none of a label's picture with them off", async ({ browser }) => {
  for (const on of [true, false]) {
    const page = await browser.newPage();
    await open(page, undefined, shipped);
    await remoteLoads(page, on);
    for (const [name, { source, drawnBy }] of Object.entries(HOSTILE)) {
      const r = await render(page, source, 'far.test');
      if (drawnBy === 'pele' || !on) {
        // Off: Mermaid's own label pass removed the picture before the check ran, so there is nothing to refuse.
        expect([on, name, r.ok, r.refused]).toEqual([on, name, true, false]);
        expect([on, name, await engineInHost(page)]).toEqual([on, name, drawnBy]);
      } else {
        expect([on, name, r.ok, r.refused]).toEqual([on, name, false, true]);
      }
    }
    await page.close();
  }
});

// ------------------------------------------------------------ a host's source check
// `DiagramSourceAcceptContext`, asked by `useDiagramRender` before either
// engine runs. What regresses if these fail: a fence the host refused still
// reaches an engine, so what Mermaid fetches while it draws (above) is
// fetched again with no CSP; or a check that accepts changes anything.

type Checked = { ok: boolean; refused: boolean; message: string; asked: number };
const checked = (page: Page, source: string, accept: boolean) =>
  page.evaluate(([s, a]) => (window as any).__d.checked(s, a) as Promise<Checked>, [source, accept] as const);
const engines = (page: Page) => page.evaluate(() => (window as any).__d.engines() as { mermaid: boolean; pele: number });

/** Every source in this file: what Mermaid fetches before any sanitizer, the hostile kinds, and the label / style / directive classes. */
const EVERY_SOURCE: [string, string][] = [
  ...Object.entries(BEFORE_ANY_SANITIZER).map(([name, { source }]) => [name, source] as [string, string]),
  ...Object.entries(HOSTILE).map(([name, { source }]) => [name, source] as [string, string]),
  ...Object.entries(CLOSED),
];

test("a host's source check that refuses: no engine loads and nothing loads from another host, with no CSP, whether Mermaid draws every fence or as shipped", async ({ browser }) => {
  for (const [engine, built] of [['mermaid', checkedMermaid], ['pele-where-safe', checkedShipped]] as const) {
    for (const on of [false, true]) {
      const page = await browser.newPage();
      const seen = await open(page, undefined, built);
      await remoteLoads(page, on);
      for (const [name, source] of EVERY_SOURCE) {
        const r = await checked(page, source, false);
        expect([engine, on, name, r]).toEqual([engine, on, name, { ok: false, refused: true, message: 'The diagram is shown as its source.', asked: 1 }]);
      }
      await settle(page);
      expect([engine, on, seen]).toEqual([engine, on, []]);
      expect([engine, on, await engines(page)]).toEqual([engine, on, { mermaid: false, pele: 0 }]);
      expect([engine, on, await page.locator('#host *').count()]).toEqual([engine, on, 0]);
      await page.close();
    }
  }
});

test("a host's source check that accepts: the sources draw and load exactly as with no check", async ({ browser }) => {
  // Mermaid draws every fence: what it fetches before any sanitizer still loads with no CSP (so the refusal above is what stopped it).
  {
    const page = await browser.newPage();
    const seen = await open(page, undefined, checkedMermaid);
    await remoteLoads(page, false);
    for (const [name, { source, everywhere }] of Object.entries(BEFORE_ANY_SANITIZER)) {
      seen.length = 0;
      const r = await checked(page, source, true);
      expect([name, r.asked, r.refused]).toEqual([name, 1, false]);
      await settle(page);
      if (everywhere) expect([name, seen.length > 0]).toEqual([name, true]);
    }
    expect((await engines(page)).mermaid).toBe(true);
    await page.close();
  }
  // As shipped: the same engine draws each hostile source as with no check, and what Pele draws loads nothing.
  {
    const page = await browser.newPage();
    const seen = await open(page, undefined, checkedShipped);
    await remoteLoads(page, false);
    for (const [name, { source, drawnBy }] of Object.entries(HOSTILE)) {
      seen.length = 0;
      const r = await checked(page, source, true);
      expect([name, r]).toEqual([name, { ok: true, refused: false, message: '', asked: 1 }]);
      expect([name, await engineInHost(page)]).toEqual([name, drawnBy]);
      await settle(page);
      expect([name, await outsideInHost(page)]).toEqual([name, []]);
      if (drawnBy === 'pele') expect([name, seen]).toEqual([name, []]);
    }
    expect((await engines(page)).pele).toBeGreaterThan(0);
    await page.close();
  }
});
