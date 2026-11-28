/**
 * A `$$...$$` label in a Mermaid diagram is drawn where its label belongs: in
 * its node, on its edge, over its sequence message. Mermaid typesets it with
 * KaTeX as MathML inside the label's `<foreignObject>`, and the apps load
 * KaTeX's stylesheet (packages/ui/theme.css), whose `.katex` wrapper is
 * `position: relative`. WebKit (Safari) paints positioned HTML inside a
 * `<foreignObject>` without the svg's placement, so the formula showed at the
 * diagram's top-left corner and its node stayed empty; Chromium drew it in
 * place. vscode-guides-sanitize.spec.ts proves the MathML survives the
 * sanitizer, in Chromium only and with no KaTeX stylesheet, so it never saw
 * this.
 *
 * Proven with the engine the apps use (diagram-ui-bundle.ts, with the real
 * KaTeX and its stylesheet), on what is painted: everything in the diagram but
 * the formula is hidden, the diagram is screenshotted, and the formula's ink
 * must lie inside its node (or edge label, or message label) and not be empty.
 * The formula's layout box is checked the same way.
 *
 * Runs in Chromium and WebKit (playwright.config.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { buildDiagramUiBundle, katexCss, openDiagramPage } from './diagram-ui-bundle';

let bundle = '';
test.beforeAll(() => {
  bundle = buildDiagramUiBundle({ realKatex: true });
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Leave only the formula painted: the svg's shapes, lines, text and label
 * backgrounds transparent, the formula in black on the white page. Not
 * `visibility: hidden`: WebKit then skips a foreignObject's content unless
 * it has a layer of its own, which is the very thing under test.
 */
const ONLY_THE_FORMULA = `
#host svg, #host svg * { fill: transparent !important; stroke: transparent !important; color: transparent !important; background: transparent !important; border-color: transparent !important; box-shadow: none !important; filter: none !important; }
#host svg math, #host svg math * { color: #000 !important; }
`;

/** Render, then read where the formula's label belongs (its node, edge label or foreignObject) and its own layout box. */
async function renderFormula(page: Page, source: string): Promise<{ slot: Box; math: Box; maths: number }> {
  const r = await page.evaluate((src) => (window as any).__d.render(src), source);
  expect(r.ok, r.message).toBe(true);
  return page.evaluate(() => {
    const maths = Array.from(document.getElementById('host')!.getElementsByTagNameNS('http://www.w3.org/1998/Math/MathML', 'math'));
    const math = maths[0]!;
    const slot = math.closest('g.node') ?? math.closest('g.edgeLabel') ?? math.closest('foreignObject')!;
    const box = (b: DOMRect) => ({ x: b.x, y: b.y, width: b.width, height: b.height });
    return { slot: box(slot.getBoundingClientRect()), math: box(math.getBoundingClientRect()), maths: maths.length };
  });
}

/** The box around every dark pixel painted in `#box`, in page coordinates; null when nothing is painted. */
async function inkBox(page: Page): Promise<Box | null> {
  await page.addStyleTag({ content: ONLY_THE_FORMULA });
  const shot = (await page.locator('#box').screenshot()).toString('base64');
  return page.evaluate(async (png) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const at = document.getElementById('box')!.getBoundingClientRect();
    const scale = canvas.width / at.width;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const i = (y * canvas.width + x) * 4;
        if (data[i]! < 128 && data[i + 1]! < 128 && data[i + 2]! < 128) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
    }
    if (x0 === Infinity) return null;
    return { x: at.x + x0 / scale, y: at.y + y0 / scale, width: (x1 - x0 + 1) / scale, height: (y1 - y0 + 1) / scale };
  }, shot);
}

const SLACK = 3;
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - SLACK &&
  inner.y >= outer.y - SLACK &&
  inner.x + inner.width <= outer.x + outer.width + SLACK &&
  inner.y + inner.height <= outer.y + outer.height + SLACK;
const show = (b: Box | null) => (b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}` : 'nothing');

const CASES: Record<string, string> = {
  'a flowchart node': 'flowchart LR\n  A[Read rows] --> B{Region?}\n  B -->|EU| C[eu.csv]\n  C --> E["$$f = 0.30$$"]',
  'a flowchart edge label': 'flowchart LR\n  A[Read rows] --> B[Split]\n  B -->|"$$x^2 + 1$$"| C[eu.csv]',
  'a sequence message': 'sequenceDiagram\n  participant A as Ada\n  participant B as Bob\n  A->>B: Hello\n  B->>A: $$\\frac{a}{b}$$',
};

for (const [where, source] of Object.entries(CASES)) {
  test(`a $$...$$ label in ${where} is drawn in its place, not at the diagram's corner`, async ({ page }) => {
    await openDiagramPage(page, bundle, { css: katexCss() });
    const { slot, math, maths } = await renderFormula(page, source);
    expect(maths).toBe(1);
    expect(math.width * math.height, `the formula's box is empty (${show(math)})`).toBeGreaterThan(0);
    expect(inside(math, slot), `the formula's box ${show(math)} is outside its label's place ${show(slot)}`).toBe(true);
    const ink = await inkBox(page);
    expect(ink, 'nothing of the formula is painted').not.toBeNull();
    expect(inside(ink!, slot), `the formula is painted at ${show(ink)}, outside its label's place ${show(slot)}`).toBe(true);
  });
}
