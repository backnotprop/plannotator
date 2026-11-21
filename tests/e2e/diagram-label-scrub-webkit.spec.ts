/**
 * In WebKit a label's HTML is not held inside its diagram the way Chromium and
 * Firefox hold it: content pinned to the window (`position: fixed`, from an
 * inline style or from one of the page's own utility classes such as
 * `fixed inset-0`) leaves the svg and its box, and is drawn over the app and
 * takes its clicks. The box here is the Inbox's artifact tile (relative,
 * overflow hidden, no transform), where that happened. After the sanitizer, a
 * label keeps only Mermaid's own classes and no `position: fixed` / `sticky`,
 * so the app's buttons stay the app's. See diagram-label-scrub.spec.ts for the
 * rest of what a label may do; the engine is `packages/ui/utils/diagram-render.ts`.
 */
import { expect, test } from '@playwright/test';
import { buildDiagramUiBundle, openDiagramPage } from './diagram-ui-bundle';

let bundle = '';
test.beforeAll(() => {
  bundle = buildDiagramUiBundle();
});

const TILE = 'position:relative;display:block;width:240px;aspect-ratio:4/3;overflow:hidden;margin:20px';
const flow = (label: string) => `flowchart LR\n  A["${label}"] --> B[ok]`;

const COVERS = [
  flow(`<div class='fixed top-0 left-0 w-screen h-screen z-50 bg-red-500' style='pointer-events:auto'>COVER</div>`),
  flow(`<div style='position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:99;background:red;pointer-events:auto'>COVER</div>`),
];

test("a label cannot leave its diagram and cover the app's own controls", async ({ page }) => {
  await openDiagramPage(page, bundle, TILE);
  for (const source of COVERS) {
    const r = await page.evaluate((s) => (window as any).__d.render(s), source);
    expect(r.ok, r.message).toBe(true);
    const hit = await page.evaluate(() =>
      ['app-button', 'app-below'].map((id) => {
        const b = document.getElementById(id)!.getBoundingClientRect();
        return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.id ?? null;
      }),
    );
    expect([source, hit]).toEqual([source, ['app-button', 'app-below']]);
    // The label's words are still drawn, inside the diagram.
    expect(await page.locator('#host').textContent()).toContain('COVER');
  }
  // A clicked app button is still the app's.
  await page.evaluate(() => document.getElementById('app-below')!.addEventListener('click', () => ((window as any).__clicked = true)));
  await page.locator('#app-below').click();
  expect(await page.evaluate(() => (window as any).__clicked)).toBe(true);
});
