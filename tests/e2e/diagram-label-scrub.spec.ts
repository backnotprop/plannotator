/**
 * A Mermaid source is an agent's or a stranger's text (a plan, a shared link,
 * a message, an exported guide). What its labels may do once drawn, proven in
 * real Chromium with real Mermaid and DOMPurify, on a page with no CSP (so a
 * navigation that got through would happen):
 *
 * - nothing in a label navigates the tab or submits a form when clicked (an
 *   image map, a form, a submit or image input), and Mermaid's own drawing
 *   into the live page (before any sanitizer) never holds one either, even
 *   when a directive asks for a looser label config;
 * - every diagram that drew before draws the same: the label HTML real plans
 *   use, a label's picture (it still loads, as on main), a picture node, and
 *   sources that only mention `url(`, `image(` or `img:`.
 *
 * The engine is `packages/ui/utils/diagram-render.ts` (see diagram-ui-bundle.ts).
 * diagram-label-scrub-webkit.spec.ts proves the same clicks in WebKit, and
 * that a label cannot leave an Inbox tile there.
 */
import { expect, test, type Page } from '@playwright/test';
import { buildDiagramUiBundle, clickEveryLabelElement, NAVIGATING_LABELS, openDiagramPage, PICTURE_HOST } from './diagram-ui-bundle';

let bundle = '';
test.beforeAll(() => {
  bundle = buildDiagramUiBundle();
});

const flow = (label: string) => `flowchart LR\n  A["${label}"] --> B[ok]`;
const render = (page: Page, source: string) =>
  page.evaluate((s) => (window as any).__d.render(s) as Promise<{ ok: boolean; refused: boolean; message: string }>, source);
const measure = (page: Page, source: string) => page.evaluate((s) => (window as any).__d.measure(s) as Promise<string | null>, source);

/** What navigates or submits, in drawn markup. */
const NAVIGATING = /<(?:form|button|input|select|textarea|map|area|base)\b|\s(?:formaction|action|ping|usemap)=/i;

test('a click anywhere in a label never navigates the tab or submits a form', async ({ page }) => {
  const { requests, navigations } = await openDiagramPage(page, bundle);
  const start = page.url();
  for (const label of NAVIGATING_LABELS) {
    const r = await render(page, flow(label));
    expect(r.ok, `${label}: ${r.message}`).toBe(true);
    expect(await clickEveryLabelElement(page), label).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    expect([label, page.url(), navigations, requests.filter((x) => x.startsWith('document '))]).toEqual([label, start, [], []]);
    expect(NAVIGATING.test(await page.locator('#host').innerHTML()), label).toBe(false);
  }
  // A form's words are kept, as text.
  await render(page, flow(NAVIGATING_LABELS[1]!));
  expect(await page.locator('#host').textContent()).toContain('Go');
});

test("Mermaid's own drawing never holds what navigates, and a directive cannot loosen that", async ({ page }) => {
  await openDiagramPage(page, bundle);
  for (const label of NAVIGATING_LABELS) {
    const raw = await measure(page, flow(label));
    expect(raw, label).not.toBeNull();
    expect([label, NAVIGATING.test(raw!)]).toEqual([label, false]);
  }
  const loosened = `%%{init: {"dompurifyConfig": {"FORBID_TAGS": [], "FORBID_ATTR": []}, "secure": []}}%%\n${flow(NAVIGATING_LABELS[1]!)}`;
  const raw = await measure(page, loosened);
  expect(raw).not.toBeNull();
  expect(NAVIGATING.test(raw!)).toBe(false);
  // The control: the same markup without a label pass in the way is a form.
  expect(await page.evaluate((html) => { const d = document.createElement('div'); d.innerHTML = html; return d.querySelector('form button') !== null; }, NAVIGATING_LABELS[1]!)).toBe(true);
});

/** Diagrams that drew before this change, and draw the same now. */
const DRAWS = [
  'flowchart TD\n  A["<b>Bold</b> and <i>italic</i><br>next line"] --> B["<strong>s</strong> <em>e</em> <u>u</u> <code>c</code>"]',
  `flowchart LR\n  A["<span style='color:red'>red</span> <span style='font-weight:bold;font-size:18px;position:relative'>big</span>"] --> B`,
  'flowchart LR\n  A[fa:fa-car Car] --> B["one<br/>two<br />three"]',
  'flowchart LR\n  A["`**bold** _it_`"] --> B["see <a href=\'https://example.org/docs\'>docs</a>"]',
  'flowchart LR\n  A[Start] -->|yes| B{Decide}\n  B --> C(Done)\n  subgraph S [Group]\n    C\n  end\n  classDef hot fill:#f96,stroke:#333,color:#fff\n  class A hot\n  style B fill:#bbf,stroke:#f66,stroke-width:2px,color:#fff,stroke-dasharray: 5 5',
  'sequenceDiagram\n  participant A as Alice\n  A->>B: Hello <br> there\n  Note over A,B: a <b>note</b>\n  B-->>A: ok',
  'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving: push\n  Moving --> [*]',
  'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  'journey\n  title Day\n  section Go\n    Wake: 5: Me',
  'mindmap\n  root((Root))\n    A\n      B',
  'timeline\n  title History\n  2020 : one\n  2021 : two',
  // Sources that only mention a picture or a loader.
  'classDiagram\n  class Store {\n    +url(name: str) str\n    +image(path: String) Image\n  }',
  'sequenceDiagram\n  A->>B: image(id: 42)\n  B-->>A: ok',
  'flowchart LR\n  %% ref url(https://example.com/x.png)\n  A --> B',
  'flowchart LR\n  A@{ shape: rect, label: "img: hero" } --> B',
  'flowchart LR\n  A[".node rect { fill: url(#grad) } and url(img.png)"] --> B',
  // A picture: a node's, a label's.
  'flowchart LR\n  A@{ img: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", label: "pic", w: 40, h: 40 } --> B',
  `flowchart LR\n  A@{ img: "${PICTURE_HOST}/node.png", label: "pic", w: 40, h: 40 } --> B`,
  flow("<img src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' width=20 height=20> logo"),
  flow(`<img src='${PICTURE_HOST}/label.png' width=20 height=20> logo`),
];

test('every diagram that drew before draws the same, pictures included', async ({ page }) => {
  await openDiagramPage(page, bundle);
  for (const source of DRAWS) {
    const r = await render(page, source);
    expect([source, r.ok, r.refused, r.message]).toEqual([source, true, false, '']);
    const raw = await measure(page, source);
    expect(raw, source).not.toBeNull();
    // Nothing the post-pass's new rules do applies to these diagrams.
    expect([source, await page.evaluate((m) => (window as any).__d.labelRulesChanged(m), raw)]).toEqual([source, []]);
  }
  await render(page, DRAWS[0]!);
  expect(await page.evaluate(() => ['b', 'i', 'br', 'strong', 'em', 'u', 'code'].map((t) => document.querySelectorAll(`#host foreignObject ${t}`).length > 0))).toEqual([true, true, true, true, true, true, true]);
  await render(page, DRAWS[1]!);
  expect(await page.locator('#host foreignObject span', { hasText: 'red' }).last().evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 0, 0)');
  expect(await page.locator('#host foreignObject span', { hasText: 'big' }).last().evaluate((e) => getComputedStyle(e).position)).toBe('relative');
  await render(page, DRAWS[2]!);
  expect(await page.locator('#host foreignObject i.fa.fa-car').count()).toBe(1);
  await render(page, DRAWS[3]!);
  expect(await page.locator('#host foreignObject a').textContent()).toBe('docs');
  // A label's picture from the web still loads where the page allows it, as on main.
  await render(page, DRAWS[DRAWS.length - 1]!);
  const picture = page.locator('#host foreignObject img');
  expect(await picture.getAttribute('src')).toBe(`${PICTURE_HOST}/label.png`);
  await expect.poll(() => picture.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);
  // So does a picture node's.
  await render(page, DRAWS[DRAWS.length - 3]!);
  expect(await page.locator(`#host image[href="${PICTURE_HOST}/node.png"]`).count()).toBe(1);
});
