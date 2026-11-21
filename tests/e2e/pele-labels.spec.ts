/**
 * Math and styled text in diagram labels drawn by Pele (`packages/ui/utils/pele-labels.ts`),
 * in a real browser: only a browser lays out MathML, measures text and paints a foreignObject.
 * The shipped switch keeps Pele out of every build, so this spec bundles `diagram-render.ts`
 * itself with the switch forced to Pele (`test-setup/pele.ts`) and KaTeX filled as Plannotator's
 * apps fill it. Runs in Chromium and WebKit (playwright.config.ts).
 *
 * What regresses if these fail: a `$$…$$` label under Pele prints its TeX or nothing, its
 * formula overflows the box Pele reserved or leaves its shape, a placeholder character reaches
 * the page, KaTeX's positioned wrapper makes WebKit paint the formula at the svg's origin, or a
 * colour, underline, strike or code run is lost.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const UI = resolve(__dirname, '../../packages/ui');
let bundle = '';
let katexCss = '';
let work = '';

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'pn-pele-labels-'));
  const entry = join(work, 'entry.ts');
  writeFileSync(
    entry,
    `
import ${JSON.stringify(join(UI, 'utils/math-eager.ts'))};
import { setPeleInBuildForTests } from ${JSON.stringify(join(UI, 'test-setup/pele.ts'))};
import { __setDiagramEngineModeForTests } from ${JSON.stringify(join(UI, 'utils/diagram-engine.ts'))};
import { renderDiagram } from ${JSON.stringify(join(UI, 'utils/diagram-render.ts'))};
setPeleInBuildForTests(true);
__setDiagramEngineModeForTests('pele');
let seq = 0;
(window as any).__pele = {
  async render(source: string) {
    const r = await renderDiagram('mermaid', 'pn-pele-' + ++seq, source, { colorTheme: 'plannotator', mode: 'light' });
    if (!r.ok) return { ok: false, message: r.message };
    document.getElementById('host')!.replaceChildren(r.svgNode);
    return { ok: true, message: '' };
  },
};
`,
  );
  const out = join(work, 'bundle.js');
  // ESM: Pele's and Mermaid's modules read `import.meta`, which a classic script cannot.
  execFileSync('bun', ['build', entry, '--outfile', out, '--target', 'browser', '--format', 'esm'], { cwd: UI, stdio: 'pipe' });
  bundle = readFileSync(out, 'utf8');
  katexCss = readFileSync(require.resolve('katex/dist/katex.min.css', { paths: [UI] }), 'utf8');
});

test.afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Nothing leaves the page: KaTeX's fonts fall back to the system's math font.
  await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
  await page.setContent(`<!DOCTYPE html><html><head><style>${katexCss}</style>
<style>:root{--font-sans:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;--font-mono:ui-monospace,Menlo,monospace}body{margin:0;padding:16px}</style>
</head><body><div id="host"></div></body></html>`);
  await page.addScriptTag({ content: bundle, type: 'module' });
  await page.waitForFunction(() => !!(window as any).__pele, null, { timeout: 30_000 }).catch(() => {
    throw new Error(`The bundle did not load: ${errors.join(' | ') || 'no error reported'}`);
  });
}

async function draw(page: Page, source: string) {
  const r = await page.evaluate((src) => (window as any).__pele.render(src), source);
  expect(r.ok, r.message).toBe(true);
}

/** Per formula: its TeX, whether it is MathML, its box against its foreignObject's and its shape's, and the wrapper's position. */
function inspect(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#host > svg')!;
    const inside = (a: DOMRect, b: DOMRect, slack: number) => a.left >= b.left - slack && a.right <= b.right + slack && a.top >= b.top - slack && a.bottom <= b.bottom + slack;
    const formulas = Array.from(svg.querySelectorAll('foreignObject.pele-math')).map((fo) => {
      const math = fo.querySelector('math');
      const m = math?.getBoundingClientRect();
      const group = fo.closest('g.pele-node, g.pele-edge-label, g.pele-note, g.pele-cluster, g.pele-task');
      const shape = group && Array.from(group.querySelectorAll(':scope > rect, :scope > path, :scope > polygon, :scope > circle')).find((s) => s.getBoundingClientRect().width > 0);
      return {
        tex: fo.getAttribute('data-pele-tex'),
        math: (math?.textContent ?? '').replace(/\s+/gu, ''),
        inBox: m !== undefined && inside(m, fo.getBoundingClientRect(), 1.5),
        inShape: m === undefined || !shape || inside(m, shape.getBoundingClientRect(), 0.5),
        inSvg: m !== undefined && inside(m, svg.getBoundingClientRect(), 0.5),
        wrapper: getComputedStyle(fo.querySelector('.katex') ?? fo).position,
      };
    });
    const texts = Array.from(svg.querySelectorAll('text'), (t) => t.textContent ?? '').join(' ');
    return { formulas, texts, codes: /[\uE000-\uF8FF]/u.test(svg.outerHTML) };
  });
}

const MATH = [
  'flowchart LR\n  A["$$x^2 + \\frac{a}{b}$$"] -- "$$\\lambda = 0.5$$" --> B["$$\\sum_{i=1}^{n} i^2$$"]\n  B --> C["Cost per batch $$O(n \\log n)$$ worst case"]\n  subgraph G ["Group $$\\alpha$$"]\n    C\n  end',
  'sequenceDiagram\n  Charlie->>Ada: send $$\\Delta t$$ now\n  Ada-->>Charlie: $$\\frac{1}{2}$$\n  Note over Charlie,Ada: budget $$\\sum_i c_i \\le B$$',
  'stateDiagram-v2\n  S1 : rate $$\\mu$$\n  S2 : $$\\frac{a}{b}$$\n  S1 --> S2 : when $$p > 0.5$$',
  'classDiagram\n  class Circle {\n    +area() $$\\pi r^2$$\n    +ratio() $$\\frac{a}{b}$$\n  }',
  'erDiagram\n  ORDER {\n    float total "sum $$\\sum p_i$$"\n  }',
  'gantt\n  title Plan $$T_0$$\n  dateFormat YYYY-MM-DD\n  Task $$\\frac{1}{2}$$ :a1, 2024-01-01, 3d',
];

test('every formula is MathML with its own content, inside its box and its shape, with no placeholder left', async ({ page }) => {
  await open(page);
  for (const source of MATH) {
    await draw(page, source);
    const seen = await inspect(page);
    const expected = source.match(/\$\$(.*?)\$\$/gu)?.map((m) => m.slice(2, -2)) ?? [];
    expect(seen.formulas.map((f) => f.tex).sort(), source).toEqual([...expected].sort());
    for (const f of seen.formulas) {
      expect(f.math, `${f.tex} is MathML`).not.toBe('');
      expect(f.inBox, `${f.tex} fits its box`).toBe(true);
      expect(f.inShape, `${f.tex} stays in its shape`).toBe(true);
      expect(f.inSvg, `${f.tex} stays in the drawing`).toBe(true);
      // KaTeX's stylesheet positions its wrapper, which WebKit then paints at the svg's origin.
      expect(f.wrapper, f.tex ?? '').toBe('static');
    }
    expect(seen.texts, source).not.toContain('$$');
    expect(seen.codes, source).toBe(false);
  }
  await draw(page, MATH[0] as string);
  const first = await inspect(page);
  expect(first.formulas.find((f) => f.tex === 'x^2 + \\frac{a}{b}')?.math).toBe('x2+ab');
});

test('colour, underline, strike and code runs are drawn, and no tag shows as text', async ({ page }) => {
  await open(page);
  await draw(
    page,
    "flowchart TD\n  A[\"<span style='color:#cf222e'>red</span> <font color='purple'>font</font> <u>under</u> <s>strike</s> <code>parse()</code>\"] --> B[\"pic <img src='https://example.com/a.png'/> and fa:fa-car icon\"]",
  );
  const runs = await page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll('#host tspan'), (t) => {
        const style = getComputedStyle(t);
        return [t.textContent ?? '', { fill: style.fill, decoration: style.textDecorationLine || style.textDecoration, font: style.fontFamily }];
      }),
    ),
  );
  expect(runs['red']?.fill).toBe('rgb(207, 34, 46)');
  expect(runs['font']?.fill).toBe('rgb(128, 0, 128)');
  expect(runs['under']?.decoration).toContain('underline');
  expect(runs['strike']?.decoration).toContain('line-through');
  expect(runs['parse()']?.font.toLowerCase()).toMatch(/mono|menlo/u);
  const text = await page.evaluate(() => document.querySelector('#host > svg')!.textContent ?? '');
  expect(text).not.toMatch(/<|img|fa:|https/u);
});
