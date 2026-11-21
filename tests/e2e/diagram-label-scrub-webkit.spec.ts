/**
 * In WebKit a label's HTML is not clipped by its diagram the way Chromium and
 * Firefox clip it: content pinned to the window (`position: fixed`, from an
 * inline style, a custom property, the diagram's own sheet, or one of the
 * page's utility classes such as `fixed inset-0`) leaves the svg and is drawn
 * over the app, taking its clicks. Inside the diagram canvas the transformed
 * wrapper holds it; the Inbox's artifact tile (Artifacts grid and Wall) had
 * nothing to hold it until the tile's box was paint-contained. Proven here on
 * the tile's real CSS (packages/inbox/inbox.css): nothing drawn reaches a
 * point outside the tile (hit testing) or paints there (pixels), and the
 * containment changes nothing in a real diagram's tile.
 *
 * Also the navigation clicks of diagram-label-scrub.spec.ts, in WebKit (it
 * follows an image map with no picture loaded, which Chromium does not).
 */
import { expect, test, type Page } from '@playwright/test';
import { buildDiagramUiBundle, clickEveryLabelElement, NAVIGATING_LABELS, openDiagramPage } from './diagram-ui-bundle';

let bundle = '';
test.beforeAll(() => {
  bundle = buildDiagramUiBundle();
});

const flow = (label: string) => `flowchart LR\n  A["${label}"] --> B[ok]`;
const render = (page: Page, source: string) =>
  page.evaluate((s) => (window as any).__d.render(s) as Promise<{ ok: boolean; message: string }>, source);
const COVER = 'left:0;top:0;width:100vw;height:100vh;z-index:99;background:red;pointer-events:auto';

const OVERLAYS: Record<string, string> = {
  'a page utility class': flow(`<div class='fixed top-0 left-0 w-screen h-screen z-50 bg-red-500' style='pointer-events:auto'>COVER</div>`),
  'an inline style': flow(`<div style='position:fixed;${COVER}'>COVER</div>`),
  'a custom property': flow(`<div style='--p:fixed;position:var(--p);${COVER}'>COVER</div>`),
  'an inherited custom property': flow(`<div style='--p:fixed'><div style='position:var(--p);${COVER}'>COVER</div></div>`),
  'a themeCSS rule': `%%{init: {"themeCSS": ".nodeLabel { position: fixed; ${COVER.replaceAll(';', '; ')} }"}}%%\n${flow('COVER')}`,
  'a classDef rule': `stateDiagram-v2\n  classDef bad position:fixed,${COVER.replaceAll(';', ',')}\n  [*] --> s1\n  s1: COVER\n  class s1 bad`,
  'a huge absolute box': flow(`<div style='position:absolute;left:-500px;top:-500px;width:3000px;height:3000px;z-index:99;background:red;pointer-events:auto'>COVER</div>`),
  'a huge transform': flow(`<div style='transform:scale(40);background:red;pointer-events:auto'>COVER</div>`),
};

/** Points outside the tile where something of the diagram is hit, and red pixels painted outside it. */
async function outsideTheTile(page: Page): Promise<{ hits: string[]; red: number; buttons: (string | null)[] }> {
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const tile = document.getElementById('box')!.getBoundingClientRect();
    const outside = (x: number, y: number) => x < tile.left - 1 || x > tile.right + 1 || y < tile.top - 1 || y > tile.bottom + 1;
    const hits: string[] = [];
    for (let x = 4; x < innerWidth; x += 24) for (let y = 4; y < innerHeight; y += 24) {
      if (outside(x, y) && document.elementFromPoint(x, y)?.closest('#host')) hits.push(`${x},${y}`);
    }
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const g = canvas.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const scale = img.width / innerWidth;
    let red = 0;
    for (let x = 4; x < innerWidth; x += 12) for (let y = 4; y < innerHeight; y += 12) {
      if (!outside(x, y)) continue;
      const [r, gr, b] = g.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
      if (r! > 200 && gr! < 120 && b! < 120) red += 1;
    }
    const buttons = ['app-button', 'app-below'].map((id) => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.id ?? null;
    });
    return { hits, red, buttons };
  }, shot);
}

test('nothing a label draws leaves an Inbox tile: no point outside it is hit or painted', async ({ page }) => {
  await openDiagramPage(page, bundle, { tile: true });
  for (const [name, source] of Object.entries(OVERLAYS)) {
    const r = await render(page, source);
    expect(r.ok, `${name}: ${r.message}`).toBe(true);
    expect([name, await outsideTheTile(page)]).toEqual([name, { hits: [], red: 0, buttons: ['app-button', 'app-below'] }]);
    // The label's words are still drawn, inside the tile.
    expect(await page.locator('#host').textContent()).toContain('COVER');
  }
  // A clicked app button is still the app's.
  await page.evaluate(() => document.getElementById('app-below')!.addEventListener('click', () => ((window as any).__clicked = true)));
  await page.locator('#app-below').click();
  expect(await page.evaluate(() => (window as any).__clicked)).toBe(true);
});

test("the tile's containment changes nothing in a real diagram's tile", async ({ page }) => {
  await openDiagramPage(page, bundle, { tile: true });
  const sources = [
    'flowchart LR\n  A["<b>Bold</b> and <i>italic</i>"] -->|yes| B{Decide}\n  B --> C(Done)\n  classDef hot fill:#f96,stroke:#333\n  class A hot',
    'sequenceDiagram\n  A->>B: Hello <br> there\n  Note over A,B: a note',
    'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving: push\n  Moving --> [*]',
  ];
  for (const source of sources) {
    expect((await render(page, source)).ok, source).toBe(true);
    const contained = await page.locator('#box').screenshot();
    await page.addStyleTag({ content: '.ib-art-svg { contain: none !important; }' });
    const loose = await page.locator('#box').screenshot();
    await page.evaluate(() => document.querySelector('style:last-of-type')?.remove());
    expect(contained.equals(loose), source).toBe(true);
  }
});

test('a click anywhere in a label never navigates the tab or submits a form', async ({ page }) => {
  const { requests, navigations } = await openDiagramPage(page, bundle);
  const start = page.url();
  for (const label of NAVIGATING_LABELS) {
    const r = await render(page, flow(label));
    expect(r.ok, `${label}: ${r.message}`).toBe(true);
    expect(await clickEveryLabelElement(page), label).toBeGreaterThan(0);
    await page.waitForTimeout(250);
    expect([label, page.url(), navigations, requests.filter((x) => x.startsWith('document '))]).toEqual([label, start, [], []]);
  }
});
