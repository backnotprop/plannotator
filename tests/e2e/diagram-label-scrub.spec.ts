/**
 * A Mermaid source is an agent's or a stranger's text (a plan, a shared link,
 * a message, an exported guide). What its labels and styles may do once drawn,
 * proven in real Chromium with real Mermaid and DOMPurify, on a page with no
 * CSP (so a fetch or a navigation that got through would happen):
 *
 * - nothing in a label loads from the network, neither while Mermaid draws it
 *   into the live page to measure it (before any sanitizer) nor once mounted;
 * - nothing in a label navigates the tab when clicked (an image map, a form);
 * - CSS that names another host, and a picture node, are refused before
 *   Mermaid runs (the diagram shows as its source);
 * - the label HTML real plans use (bold, italics, line breaks, a coloured
 *   span, an icon, a link's words) still draws, and the new rules change
 *   nothing in a diagram that holds none of the above.
 *
 * The engine is `packages/ui/utils/diagram-render.ts` (see diagram-ui-bundle.ts).
 * diagram-label-scrub-webkit.spec.ts proves the label cannot leave its diagram in WebKit.
 */
import { expect, test } from '@playwright/test';
import { buildDiagramUiBundle, openDiagramPage } from './diagram-ui-bundle';

let bundle = '';
test.beforeAll(() => {
  bundle = buildDiagramUiBundle();
});

const E = 'https://evil.test';
const flow = (label: string) => `flowchart LR\n  A["${label}"] --> B[ok]`;
const render = (page: import('@playwright/test').Page, source: string) =>
  page.evaluate((s) => (window as any).__d.render(s) as Promise<{ ok: boolean; refused: boolean; message: string }>, source);
const measure = (page: import('@playwright/test').Page, source: string) => page.evaluate((s) => (window as any).__d.measure(s) as Promise<string | null>, source);

const URL_ATTRS = ['src', 'srcset', 'background', 'poster', 'ping', 'action', 'formaction', 'data', 'cite', 'longdesc', 'usemap'];
const LABEL_TAGS = ['img', 'picture', 'source', 'track', 'audio', 'video', 'input', 'area', 'map', 'form', 'button', 'select', 'textarea', 'iframe', 'object', 'embed'];

async function mounted(page: import('@playwright/test').Page) {
  return page.evaluate(([urlAttrs, labelTags]) => {
    const all = Array.from(document.querySelectorAll('#host *'));
    return {
      tags: [...new Set(all.map((e) => e.localName).filter((t) => labelTags.includes(t)))],
      refs: all.flatMap((e) =>
        e.getAttributeNames()
          .filter((n) => urlAttrs.includes(n.toLowerCase()) || ((n === 'href' || n.endsWith(':href')) && !(e.getAttribute(n) ?? '').startsWith('#')))
          .map((n) => `${e.localName}@${n}`),
      ),
    };
  }, [URL_ATTRS, LABEL_TAGS] as const);
}

/** Label HTML that loads something: kept out of Mermaid's own pass and out of the mounted tree. */
const LOADS = [
  `<img src='${E}/img.png' width=20 height=20>`,
  `<img srcset='${E}/srcset.png 1x' width=20 height=20>`,
  `<video poster='${E}/poster.png' width=40 height=20></video>`,
  `<video width=40 height=20><source src='${E}/v.mp4'></video>`,
  `<audio src='${E}/a.mp3' controls></audio>`,
  `<picture><source srcset='${E}/pic.png'><img width=20 height=20></picture>`,
  `<table background='${E}/tbg.png'><tr><td background='${E}/tdbg.png'>cell</td></tr></table>`,
  `<svg width=20 height=20><image href='${E}/svgimg.png' width=20 height=20></image></svg>`,
  `<form action='${E}/f'><input type='image' src='${E}/inp.png' width=60 height=20></form>`,
];

test('label HTML that loads fetches nothing, neither while Mermaid measures it nor once mounted', async ({ page }) => {
  const { requests } = await openDiagramPage(page, bundle);
  for (const label of LOADS) {
    const raw = await measure(page, flow(label));
    expect(raw, label).not.toBeNull();
    await page.waitForTimeout(150);
    expect(requests, `while Mermaid measured: ${label}`).toEqual([]);
    const r = await render(page, flow(label));
    expect(r.ok, `${label}: ${r.message}`).toBe(true);
    await page.waitForTimeout(150);
    expect(requests, `once mounted: ${label}`).toEqual([]);
    const seen = await mounted(page);
    expect(seen.tags, label).toEqual([]);
    expect(seen.refs, label).toEqual([]);
  }
  // The watch is live: a picture this page does load is seen.
  await page.evaluate((url) => {
    const img = document.createElement('img');
    img.src = url;
    document.body.append(img);
  }, `${E}/control.png`);
  await expect.poll(() => requests.includes(`${E}/control.png`)).toBe(true);
});

/** Label HTML that would take the tab away when clicked. */
const NAVIGATES = [
  `<img usemap='#m' width=200 height=40 alt=map><map name='m'><area shape='default' href='${E}/area'></map>`,
  `<form action='${E}/form'><button>Go</button></form>`,
  `<form><button formaction='${E}/formaction'>Go</button></form>`,
  `<form action='${E}/form2'><input type='submit' value='Send'></form>`,
  `<a href='${E}/link' ping='${E}/ping'>Go</a>`,
];

test('a click anywhere in a label never navigates the tab', async ({ page }) => {
  const { requests, navigations } = await openDiagramPage(page, bundle);
  for (const label of NAVIGATES) {
    const r = await render(page, flow(label));
    expect(r.ok, `${label}: ${r.message}`).toBe(true);
    const points = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#host foreignObject *'))
        .map((e) => e.getBoundingClientRect())
        .filter((b) => b.width > 0 && b.height > 0)
        .map((b) => [b.x + b.width / 2, b.y + b.height / 2] as const),
    );
    expect(points.length, label).toBeGreaterThan(0);
    for (const [x, y] of points) await page.mouse.click(x, y);
    await page.waitForTimeout(250);
    expect(navigations, label).toEqual([]);
    expect(requests, label).toEqual([]);
    expect((await mounted(page)).tags, label).toEqual([]);
  }
  // A form's words are kept, as text.
  await render(page, flow(`<form action='${E}/form'><button>Go</button></form>`));
  expect(await page.locator('#host').textContent()).toContain('Go');
});

/** Sources Mermaid would load from another host while drawing, before any sanitizer can run. */
const REFUSED = [
  flow(`<span style='background:url(${E}/bg.png)'>x</span>`),
  flow(`<span style='background-image:image-set(url(${E}/is.png) 1x)'>x</span>`),
  flow(`<span style='cursor:url(${E}/cur.png),auto'>x</span>`),
  flow(`<span style='background:url&#40;${E}/ent.png)'>x</span>`),
  `%%{init: {"themeCSS": ".nodeLabel { background-image: url(${E}/tc.png) }"}}%%\n${flow('x')}`,
  `%%{init: {"fontFamily": "x; background-image: url(${E}/ff.png)"}}%%\n${flow('x')}`,
  `---\nconfig:\n  themeCSS: ".nodeLabel { background-image: url(${E}/fm.png) }"\n---\n${flow('x')}`,
  `stateDiagram-v2\n  classDef bad background-image:url(${E}/scd.png)\n  [*] --> s1\n  class s1 bad`,
  `classDiagram\n  class A\n  style A fill:url(${E}/c.svg),background-image:url(${E}/cb.png)`,
  `flowchart LR\n  A@{ img: "${E}/shape.png", label: "pic", w: 40, h: 40 } --> B`,
];

test('CSS that names another host, and a picture node, are refused before Mermaid draws', async ({ page }) => {
  const { requests } = await openDiagramPage(page, bundle);
  for (const source of REFUSED) {
    const r = await render(page, source);
    expect([source, r.ok, r.refused]).toEqual([source, false, true]);
    await page.waitForTimeout(150);
    expect(requests, source).toEqual([]);
  }
  // The control: Mermaid itself, unguarded, does fetch while drawing one of them.
  await measure(page, REFUSED[4]!);
  await expect.poll(() => requests.some((u) => u.startsWith(`${E}/tc.png`))).toBe(true);
});

test('a directive cannot hand Mermaid a looser label config', async ({ page }) => {
  const { requests } = await openDiagramPage(page, bundle);
  const r = await render(page, `%%{init: {"dompurifyConfig": {"FORBID_TAGS": [], "FORBID_ATTR": []}}}%%\n${flow(`<img src='${E}/d.png' width=20 height=20>`)}`);
  expect(r.ok, r.message).toBe(true);
  await page.waitForTimeout(200);
  expect(requests).toEqual([]);
  expect((await mounted(page)).tags).toEqual([]);
});

/** Label HTML real plans use. */
const LEGIT = [
  'flowchart TD\n  A["<b>Bold</b> and <i>italic</i><br>next line"] --> B["<strong>s</strong> <em>e</em> <u>u</u> <code>c</code>"]',
  `flowchart LR\n  A["<span style='color:red'>red</span> <span style='font-weight:bold;font-size:18px'>big</span>"] --> B`,
  'flowchart LR\n  A[fa:fa-car Car] --> B["one<br/>two<br />three"]',
  'flowchart LR\n  A["`**bold** _it_`"] --> B["see <a href=\'https://example.org/docs\'>docs</a>"]',
  'flowchart LR\n  A[Start] -->|yes| B{Decide}\n  B --> C(Done)\n  subgraph S [Group]\n    C\n  end\n  classDef hot fill:#f96,stroke:#333,color:#fff\n  class A hot\n  style B fill:#bbf,stroke:#f66,stroke-width:2px,color:#fff,stroke-dasharray: 5 5',
  'flowchart LR\n  A[".node rect { fill: url(#grad) } and url(img.png)"] --> B',
  'sequenceDiagram\n  participant A as Alice\n  A->>B: Hello <br> there\n  Note over A,B: a <b>note</b>\n  B-->>A: ok',
  'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving: push\n  Moving --> [*]',
  'classDiagram\n  class Animal {\n    <<interface>>\n    +String name\n    +eat() void\n  }\n  Animal <|-- Duck',
  'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  'journey\n  title Day\n  section Go\n    Wake: 5: Me',
  'mindmap\n  root((Root))\n    A\n      B',
  'timeline\n  title History\n  2020 : one\n  2021 : two',
];

test('the label HTML real plans use still draws, and the new rules change nothing in it', async ({ page }) => {
  const { requests } = await openDiagramPage(page, bundle);
  for (const source of LEGIT) {
    const r = await render(page, source);
    expect(r.ok, `${source}: ${r.message}`).toBe(true);
    const raw = await measure(page, source);
    expect(raw, source).not.toBeNull();
    // Nothing the post-pass's label rules do applies to these diagrams.
    expect([source, await page.evaluate((m) => (window as any).__d.labelRulesChanged(m), raw)]).toEqual([source, []]);
  }
  await render(page, LEGIT[0]!);
  expect(await page.evaluate(() => ['b', 'i', 'br', 'strong', 'em', 'u', 'code'].map((t) => document.querySelectorAll(`#host foreignObject ${t}`).length > 0))).toEqual([true, true, true, true, true, true, true]);
  await render(page, LEGIT[1]!);
  const red = page.locator('#host foreignObject span', { hasText: 'red' }).last();
  expect(await red.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 0, 0)');
  await render(page, LEGIT[2]!);
  expect(await page.locator('#host foreignObject i.fa.fa-car').count()).toBe(1);
  await render(page, LEGIT[3]!);
  expect(await page.locator('#host foreignObject strong').count()).toBeGreaterThan(0);
  expect(await page.locator('#host foreignObject a').textContent()).toBe('docs');
  expect(requests).toEqual([]);
});
