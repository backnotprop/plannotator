/**
 * A Mermaid `$$...$$` label comes out of the render with KaTeX's wrapper
 * un-positioned (utils/diagram-render.ts, `keepMathLabelsInPlace`).
 *
 * What regresses if these fail: KaTeX's stylesheet makes `.katex`
 * `position: relative`, and WebKit (Safari) paints positioned html inside a
 * `<foreignObject>` without the svg's placement, so the formula shows at the
 * diagram's top-left corner and its node stays empty. The painting itself is
 * proven in Chromium and WebKit by tests/e2e/diagram-math-labels.spec.ts; this
 * pins that the Mermaid render sets the wrapper `static` and touches no other
 * label.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import katex from 'katex';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { renderDiagram } from './diagram-render';
import { getMathRenderer, getMathRendererSource, resetMathRenderer, setMathRenderer } from './math';
import { __setMermaidRuntimeLoaderForTests } from './mermaid';

const hasDom = typeof document !== 'undefined';
const THEME = { colorTheme: 'plannotator', mode: 'light' } as const;

/** What Mermaid puts in a math label: its flex row around KaTeX's MathML-only output (`renderKatexUnsanitized`). */
const MATH_LABEL = `<div style="display: flex; align-items: center; justify-content: center; white-space: nowrap;">${katex.renderToString('f = 0.30', { throwOnError: true, displayMode: true, output: 'mathml' })}</div>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" id="m1" viewBox="0 0 200 100">
<g class="node" id="flowchart-A-0" transform="translate(50, 50)"><rect class="basic label-container" x="-40" y="-20" width="80" height="40"/>
<g class="label" transform="translate(-30, -12)"><foreignObject width="60" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;"><span class="nodeLabel">${MATH_LABEL}</span></div></foreignObject></g></g>
<g class="node" id="flowchart-B-1" transform="translate(150, 50)"><rect class="basic label-container" x="-40" y="-20" width="80" height="40"/>
<g class="label" transform="translate(-30, -12)"><foreignObject width="60" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;"><span class="nodeLabel"><p>eu.csv</p></span></div></foreignObject></g></g>
</svg>`;

const savedRenderer = getMathRenderer();
const savedSource = getMathRendererSource();
let restoreParser: (() => void) | null = null;
beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  setMathRenderer(katex);
  __setMermaidRuntimeLoaderForTests(() => Promise.resolve({ initialize() {}, render: async () => ({ svg: SVG }) } as never));
});
afterAll(() => {
  restoreParser?.();
  __setMermaidRuntimeLoaderForTests(undefined);
  resetMathRenderer();
  if (savedRenderer) setMathRenderer(savedRenderer, savedSource ?? 'host');
});

describe.if(hasDom)('a Mermaid math label', () => {
  test("KaTeX's wrapper is static, so WebKit paints the formula in its node", async () => {
    const result = await renderDiagram('mermaid', 'math-label', 'flowchart LR\n  A["$$f = 0.30$$"] --> B[eu.csv]', THEME);
    if (result.ok === false) throw new Error(result.message);
    const wrappers = Array.from(result.svgNode.querySelectorAll('.katex')) as HTMLElement[];
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]!.style.position).toBe('static');
    // The formula and Mermaid's centring row around it are kept as drawn.
    expect(wrappers[0]!.querySelector('mn')?.textContent).toBe('0.30');
    expect((wrappers[0]!.parentElement as HTMLElement).style.display).toBe('flex');
  });

  test('a label with no math keeps no position of its own', async () => {
    const result = await renderDiagram('mermaid', 'plain-label', 'flowchart LR\n  A["$$f = 0.30$$"] --> B[eu.csv]', THEME);
    if (result.ok === false) throw new Error(result.message);
    const plain = Array.from(result.svgNode.querySelectorAll('.nodeLabel')).find((el) => el.textContent === 'eu.csv') as HTMLElement;
    expect(plain).toBeDefined();
    for (const el of [plain, ...Array.from(plain.querySelectorAll('*'))] as HTMLElement[]) expect(el.style.position).toBe('');
  });
});
