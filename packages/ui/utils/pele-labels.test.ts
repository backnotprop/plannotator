// The label step around a Pele render (`pele-labels.ts`): math typeset into
// the box Pele reserved, styled runs drawn, and nothing of the placeholders
// left. What regresses if these fail: a `$$` label under Pele prints its TeX
// (or nothing), a formula's box no longer matches the space reserved for it,
// a styled run loses its colour or lets an unsafe one through, a picture or
// icon leaves a broken tag, a placeholder character reaches the page, or a
// part whose label is only math is anchored with an empty label.
// The render cases are DOM-gated (DOM_TESTS=1); the rest run anywhere.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import katex from 'katex';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { setPeleInBuildForTests } from '../test-setup/pele';
import { MERMAID_FINDER } from './diagram-anchor';
import { PELE_FINDER, peleLabelText } from './diagram-anchor-pele';
import { __setDiagramEngineModeForTests } from './diagram-engine';
import { diagramFinder, renderDiagram } from './diagram-render';
import { getMathRenderer, resetMathRenderer, setMathRenderer } from './math';
import {
  estimateMathSize,
  needsPeleLabels,
  PELE_TEX_ATTR,
  peleLabelMeasurer,
  preparePeleLabels,
  restorePeleLabelMessage,
  safeLabelColor,
  typesetPeleMath,
  type MathTypesetter,
} from './pele-labels';

const hasDom = typeof document !== 'undefined';

/** A typesetter with fixed sizes: `tall` formulas are 2.4 em high, others 1.2. */
const fake: MathTypesetter = {
  typeset: (tex) => `<math data-tex="${tex}"><mi>${tex}</mi></math>`,
  measure: (htmls) => htmls.map((html) => ({ w: 2, h: html.includes('tall') ? 2.4 : 1.2 })),
};

const codesIn = (text: string): string[] => text.match(/[\uE000-\uF8FF]/gu) ?? [];

describe('preparing a source for Pele', () => {
  test('a short formula beside words stays on their line; a tall one takes lines of its own', () => {
    const prepared = preparePeleLabels('flowchart LR\n  A["cost $$n$$ here"] --> B["$$tall$$"] --> C["before $$tall$$ after"]', fake)!;
    expect(prepared.maths.map((m) => m.tex)).toEqual(['n', 'tall', 'tall']);
    const [a, b, c] = prepared.text.split('-->');
    expect(a).not.toContain('<br>');
    expect(codesIn(a ?? '')).toHaveLength(2);
    // 2.4 em is two lines of 1.5 em.
    expect(b?.match(/<br>/gu)).toHaveLength(1);
    expect(c?.match(/<br>/gu)).toHaveLength(3);
    expect(prepared.text).not.toContain('$$');
  });

  test('a class member and a gantt task, drawn on one line, keep a tall formula on it, shrunk to fit', () => {
    const cls = preparePeleLabels('classDiagram\n  class C {\n    +ratio() $$tall$$\n  }\n  C --> D : $$tall$$', fake)!;
    expect(cls.maths.map((m) => m.fit)).toEqual([true, false]);
    expect(cls.text.split('\n')[2]).not.toContain('<br>');
    const gantt = preparePeleLabels('gantt\n  title Plan $$tall$$\n  Task $$tall$$ :a1, 2024-01-01, 3d', fake)!;
    expect(gantt.maths.map((m) => m.fit)).toEqual([false, true]);
    // A shrunk formula reserves the width it is drawn at: 2 em scaled to 1.5 / 2.4.
    const measure = peleLabelMeasurer({ width: () => 0 }, gantt);
    const token = gantt.text.split('\n')[2]?.match(/[\uE000-\uF8FF]{2}/u)?.[0] ?? '';
    expect(measure.width(token, 10, 0)).toBeCloseTo(2 * (1.5 / 2.4) * 10, 5);
  });

  test('a label that already holds private-use characters keeps them, and the codes use another block', () => {
    const source = 'flowchart LR\n  A["\uE100\uE000 and \uE800 $$z$$"]';
    const prepared = preparePeleLabels(source, fake)!;
    expect(prepared.codes.base).toBe(0xf000);
    expect(prepared.text).toContain('\uE100\uE000 and \uE800');
    // Every block taken: the source is drawn as it is.
    expect(preparePeleLabels('flowchart LR\n  A["\uE000\uE800\uF000 $$z$$"]', fake)).toBeNull();
  });

  test('a comment line and the front matter are left alone', () => {
    const prepared = preparePeleLabels('---\ntitle: $$t$$\n---\nflowchart LR\n  %% $$c$$\n  A["$$a$$"]', fake)!;
    expect(prepared.maths.map((m) => m.tex)).toEqual(['a']);
    expect(prepared.text).toContain('title: $$t$$');
    expect(prepared.text).toContain('%% $$c$$');
  });

  test('with no math renderer, a formula stays as its text and styled runs are still drawn', () => {
    const prepared = preparePeleLabels('flowchart LR\n  A["$$x$$ <u>y</u>"]', null)!;
    expect(prepared.maths).toEqual([]);
    expect(prepared.text).toContain('$$x$$');
    expect(prepared.styles).toEqual([{ decoration: 'underline' }]);
    expect(needsPeleLabels('flowchart LR\n  A --> B')).toBe(false);
    expect(preparePeleLabels('flowchart LR\n  A --> B', fake)).toBeNull();
  });

  test('a `<code>` run is measured in the mono font, and a marker measures nothing', () => {
    const prepared = preparePeleLabels('flowchart LR\n  A["a <code>bc</code> d"]', null)!;
    const seen: [string, number][] = [];
    const measure = peleLabelMeasurer({ width: (text, _size, style) => (seen.push([text, style]), text.length) }, prepared);
    const label = /A\["(.*)"\]/u.exec(prepared.text)?.[1] ?? '';
    expect(measure.width(label, 16, 0)).toBe('a bc d'.length);
    expect(seen).toEqual([['a ', 0], ['bc', 4], [' d', 0]]);
  });

  test('an error message names a placeholder as the formula it stands for', () => {
    const prepared = preparePeleLabels('flowchart LR\n  A["$$x^2$$"]', fake)!;
    const token = codesIn(prepared.text).join('');
    expect(restorePeleLabelMessage(`Unexpected "${token}"`, prepared)).toBe('Unexpected "$$x^2$$"');
  });
});

describe('colours an author gives a run', () => {
  test('names, hex, and rgb()/hsl() with numbers only', () => {
    for (const ok of ['red', 'RebeccaPurple', '#0969da', '#abc', '#11223344', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'rgb(1 2 3 / 50%)', 'hsl(120, 50%, 40%)', 'hsla(120deg 50% 40% / 0.3)']) {
      expect(safeLabelColor(ok)).toBe(ok);
    }
  });

  test('nothing that can fetch, reach a variable, run script or end the declaration', () => {
    for (const bad of ['url(https://x)', 'var(--x)', 'expression(alert(1))', 'red;background:url(x)', 'rgb(1,2,3);x', 'rgb(calc(1),2,3)', 'inherit', 'currentColor', '', 'javascript:x', '#ggg']) {
      expect(safeLabelColor(bad)).toBeNull();
    }
  });

  test('a run whose colour is not safe keeps its words and loses only the colour', () => {
    const prepared = preparePeleLabels('flowchart LR\n  A["<span style=\'color:url(https://x)\'>a</span> <font color=\'var(--y)\'>b</font>"]', null);
    expect(prepared?.styles ?? []).toEqual([]);
    expect(prepared?.text).toContain('A["a b"]');
  });
});

describe('typesetting', () => {
  test('MathML as Mermaid typesets it, with no annotation, no display margins and no positioned wrapper', () => {
    const html = typesetPeleMath(katex, '\\frac{a}{b}');
    expect(html.startsWith('<span class="katex" style="position:static"><math')).toBe(true);
    expect(html).not.toContain('annotation');
    expect(html).not.toContain('katex-display');
  });

  test('with no layout, the size is estimated from the formula', () => {
    expect(estimateMathSize(typesetPeleMath(katex, 'x')).h).toBeLessThan(1.5);
    expect(estimateMathSize(typesetPeleMath(katex, '\\frac{a}{b}')).h).toBeGreaterThan(1.5);
  });
});

let restoreParser: (() => void) | undefined;
let previousRenderer: ReturnType<typeof getMathRenderer> = null;
beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  __setDiagramEngineModeForTests('pele');
  setPeleInBuildForTests(true);
  previousRenderer = getMathRenderer();
  setMathRenderer(katex, 'host');
});
afterAll(() => {
  if (!hasDom) return;
  restoreParser?.();
  __setDiagramEngineModeForTests(undefined);
  setPeleInBuildForTests(false);
  resetMathRenderer();
  if (previousRenderer !== null) setMathRenderer(previousRenderer, 'host');
});

const theme = { colorTheme: 'github', mode: 'light' } as const;
async function draw(source: string): Promise<SVGSVGElement> {
  const result = await renderDiagram('mermaid', `labels-${Math.random().toString(36).slice(2)}`, source, theme);
  if (result.ok === false) throw new Error(result.message);
  return result.svgNode;
}
const formulas = (svg: Element): Element[] => Array.from(svg.querySelectorAll('foreignObject.pele-math'));
const anyCode = (svg: Element): boolean => /[\uE000-\uF8FF]/u.test(svg.outerHTML);

describe.if(hasDom)('math labels drawn by Pele', () => {
  test('every formula of a flowchart is MathML in a box, the words around it stay text, and no placeholder is left', async () => {
    const svg = await draw('flowchart LR\n  A["$$x^2$$"] -- "$$\\lambda$$" --> B["Cost $$O(n)$$ worst"]\n  subgraph G ["Group $$\\alpha$$"]\n    B\n  end');
    expect(formulas(svg).map((fo) => fo.getAttribute(PELE_TEX_ATTR))).toEqual(expect.arrayContaining(['x^2', '\\lambda', 'O(n)', '\\alpha']));
    expect(formulas(svg)).toHaveLength(4);
    for (const fo of formulas(svg)) {
      expect(fo.getElementsByTagName('math').length).toBe(1);
      expect(Number(fo.getAttribute('width'))).toBeGreaterThan(2);
      expect(Number(fo.getAttribute('height'))).toBeGreaterThan(0);
    }
    expect(anyCode(svg)).toBe(false);
    expect(Array.from(svg.querySelectorAll('text'), (t) => t.textContent).join(' ')).not.toContain('$$');
    // The words beside a formula are still the node's text.
    expect(svg.querySelector('g.pele-node[data-id="B"] text')?.textContent?.replace(/\u200b/gu, '')).toContain('Cost');
  });

  test('a formula takes the colour its label is drawn in', async () => {
    const svg = await draw('flowchart LR\n  subgraph G ["T $$t$$"]\n    A["$$a$$"]\n  end');
    const ink = (tex: string) => formulas(svg).find((fo) => fo.getAttribute(PELE_TEX_ATTR) === tex)?.firstElementChild?.getAttribute('style') ?? '';
    expect(ink('a')).toContain('color:var(--_fg)');
    // A cluster title is drawn in the muted colour.
    expect(ink('t')).toContain('color:var(--_m)');
  });

  test('sequence messages and notes, state descriptions and transitions, class members, ER attributes, mindmap, gantt and timeline', async () => {
    const sources = [
      'sequenceDiagram\n  Charlie->>Ada: send $$\\Delta t$$\n  Note over Ada: $$\\frac{1}{2}$$',
      'stateDiagram-v2\n  S1 : rate $$\\mu$$\n  S1 --> S2 : when $$p$$',
      'classDiagram\n  class C {\n    +area() $$\\pi r^2$$\n  }',
      'erDiagram\n  ORDER {\n    float total "sum $$\\sum p$$"\n  }',
      'mindmap\n  root(($$\\pi$$))\n    child[ratio $$c$$]',
      'gantt\n  title Plan $$T$$\n  dateFormat YYYY-MM-DD\n  Task $$\\frac{1}{2}$$ :a1, 2024-01-01, 3d',
      'timeline\n  title Growth $$e^x$$\n  2020 : launch $$v_1$$',
    ];
    for (const source of sources) {
      const svg = await draw(source);
      const expected = source.match(/\$\$(.*?)\$\$/gu)?.length ?? 0;
      expect(formulas(svg).filter((fo) => fo.getElementsByTagName('math').length === 1).length, source).toBe(expected);
      expect(anyCode(svg), source).toBe(false);
    }
  });

  test('a tall formula on lines of its own reserves their height; one beside words reserves a gap on its line', async () => {
    const svg = await draw('flowchart TD\n  A["above<br>$$\\frac{a}{b}$$<br>below"] --> B["cost $$n$$ here"]');
    const tall = formulas(svg).find((fo) => fo.getAttribute(PELE_TEX_ATTR) === '\\frac{a}{b}')!;
    const lines = svg.querySelectorAll('g.pele-node[data-id="A"] text > tspan[y]');
    const pitch = Math.abs(Number(lines[1]?.getAttribute('y')) - Number(lines[0]?.getAttribute('y')));
    expect(Number(tall.getAttribute('height'))).toBeGreaterThanOrEqual(pitch * 2 - 0.01);
    const gap = svg.querySelector(`g.pele-node[data-id="B"] tspan[${PELE_TEX_ATTR}][dx]`);
    expect(gap?.getAttribute(PELE_TEX_ATTR)).toBe('n');
    const inline = formulas(svg).find((fo) => fo.getAttribute(PELE_TEX_ATTR) === 'n')!;
    expect(Number(inline.getAttribute('width'))).toBeCloseTo(Number(gap?.getAttribute('dx')) + 2, 1);
  });

  test('the outline copy Pele draws under a cluster title gets a gap but no second formula', async () => {
    const svg = await draw('flowchart TD\n  A --> B\n  subgraph S ["Title $$t$$"]\n    B\n  end');
    const title = svg.querySelector('g.pele-cluster-title');
    expect(title).not.toBeNull();
    expect(title!.querySelectorAll(`tspan[${PELE_TEX_ATTR}]`)).toHaveLength(2);
    expect(formulas(svg).filter((fo) => fo.getAttribute(PELE_TEX_ATTR) === 't')).toHaveLength(1);
  });

  test('a part whose label is only math is anchored with its TeX, and the source line is found from it', async () => {
    const source = 'flowchart LR\n  A["$$x^2$$"] -- "$$\\lambda$$" --> B\n  B --> C["Cost $$O(n)$$ worst"]';
    const svg = await draw(source);
    const finder = diagramFinder('mermaid');
    const node = svg.querySelector('g.pele-node[data-id="A"]')!;
    const target = finder.targetFromElement(svg, node, 'x')!;
    expect(target.label).toBe('$$x^2$$');
    expect(finder.findTarget(svg, target, 'x')).toBe(node);
    const edge = finder.targetFromElement(svg, svg.querySelector('g.pele-edge[data-id="L_A_B_0"]')!, 'x')!;
    expect(edge.label).toBe('$$\\lambda$$');
    expect(finder.sourceLine(source, edge)).toEqual([2, 2]);
    expect(finder.targetFromElement(svg, svg.querySelector('g.pele-node[data-id="C"]')!, 'x')?.label).toBe('Cost $$O(n)$$ worst');
  });

  test('a sequence message and note made of math keep their TeX as their label', async () => {
    const svg = await draw('sequenceDiagram\n  Charlie->>Ada: $$\\frac{1}{2}$$\n  Note over Ada: budget $$B$$');
    const labels = Array.from(svg.querySelectorAll(PELE_FINDER.targetSelector), (el) => PELE_FINDER.targetFromElement(svg, el, 'x')?.label);
    expect(labels).toContain('$$\\frac{1}{2}$$');
    expect(labels).toContain('budget $$B$$');
  });

  test('a comment anchored on a math node under Mermaid restores on the same node under Pele, and back', async () => {
    // Mermaid draws `U` with the MathML's text as its label; Pele with the TeX. Both find the node by its id.
    const svg = await draw('flowchart LR\n  U(["$$x$$"]) --> D{"$$y$$"}');
    const fromMermaid = { family: 'flowchart', kind: 'node', id: 'U', label: 'x' } as const;
    expect(PELE_FINDER.findTarget(svg, fromMermaid, 'x')).toBe(svg.querySelector('g.pele-node[data-id="U"]'));
    const fromPele = PELE_FINDER.targetFromElement(svg, svg.querySelector('g.pele-node[data-id="U"]')!, 'x')!;
    const mermaidSvg = new DOMParser().parseFromString(
      await Bun.file(`${import.meta.dir}/../test-setup/fixtures/diagrams/06-flowchart-review-decision.svg`).text(),
      'image/svg+xml',
    ).documentElement;
    const found = MERMAID_FINDER.findTarget(mermaidSvg, fromPele, 'diagram-fixture');
    expect(found?.getAttribute('id') ?? '').toContain('flowchart-U-');
  });

  test('peleLabelText reads styled runs once, inside their line', async () => {
    const svg = await draw('flowchart LR\n  A["<b>Bold</b>tail and <span style=\'color:red\'>red</span>"]');
    expect(peleLabelText(svg.querySelector('g.pele-node[data-id="A"] text'), ' ')).toBe('Boldtail and red');
  });
});

describe.if(hasDom)('styled label text drawn by Pele', () => {
  test('colour, underline, strike and code runs become styled tspans; tags never show as text', async () => {
    const svg = await draw(
      'flowchart TD\n  A["<span style=\'color:#cf222e\'>red</span> <font color=\'purple\'>font</font> <u>under</u> <ins>ins</ins> <s>strike</s> <del>del</del> <code>parse()</code> <kbd>Ctrl</kbd>"]',
    );
    const run = (words: string) => Array.from(svg.querySelectorAll('tspan')).find((t) => t.textContent === words);
    expect(run('red')?.getAttribute('fill')).toBe('#cf222e');
    expect(run('font')?.getAttribute('fill')).toBe('purple');
    expect(run('under')?.getAttribute('text-decoration')).toBe('underline');
    expect(run('ins')?.getAttribute('text-decoration')).toBe('underline');
    expect(run('strike')?.getAttribute('text-decoration')).toBe('line-through');
    expect(run('del')?.getAttribute('text-decoration')).toBe('line-through');
    expect(run('parse()')?.getAttribute('font-family')).toBe('var(--_fm)');
    expect(run('Ctrl')?.getAttribute('font-family')).toBe('var(--_fm)');
    expect(svg.textContent).not.toMatch(/<|&lt;/u);
    expect(anyCode(svg)).toBe(false);
  });

  test('a coloured run that wraps keeps its colour on every line', async () => {
    const svg = await draw("flowchart TD\n  A[\"A long label that wraps with <span style='color:#cf222e'>a coloured run that crosses the wrap point</span> and more\"]");
    const lines = Array.from(svg.querySelectorAll('g.pele-node[data-id="A"] text > tspan[y]'));
    expect(lines.length).toBeGreaterThan(2);
    const red = Array.from(svg.querySelectorAll('tspan[fill="#cf222e"]'));
    expect(red.map((t) => t.textContent).join(' ').replace(/\s+/gu, ' ').trim()).toBe('a coloured run that crosses the wrap point');
    // The run is cut at the line breaks, and each piece keeps the colour.
    expect(new Set(red.map((t) => t.closest('tspan[y]'))).size).toBeGreaterThan(1);
  });

  test('styled runs in a sequence message and note, a state description, a class relation and an ER relationship', async () => {
    for (const source of [
      'sequenceDiagram\n  Charlie->>Bob: <span style="color:red">urgent</span>\n  Note over Bob: <u>check</u>',
      'stateDiagram-v2\n  S1 : <span style="color:#0a0">ready</span>\n  S1 --> S2 : <code>go()</code>',
      'classDiagram\n  Account --> Ledger : <u>uses</u>',
      'erDiagram\n  ORDER ||--o{ LINE : "<s>has</s>"',
    ]) {
      const svg = await draw(source);
      expect(svg.querySelectorAll('tspan[fill], tspan[text-decoration], tspan[font-family]').length, source).toBeGreaterThan(0);
      expect(svg.textContent, source).not.toMatch(/<|&lt;/u);
    }
  });

  test('a picture and a Font Awesome icon in a label are dropped, with no broken tag left', async () => {
    const svg = await draw('flowchart LR\n  A["pic <img src=\'https://example.com/a.png\'/> and fa:fa-car icon"]');
    expect(svg.querySelector('image, img, foreignObject')).toBeNull();
    const text = svg.querySelector('g.pele-node[data-id="A"] text')?.textContent ?? '';
    expect(text).not.toMatch(/img|fa:|https/u);
    expect(text.replace(/\s+/gu, ' ')).toBe('pic and icon');
  });
});
