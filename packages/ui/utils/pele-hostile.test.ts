// Hostile sources under Pele: what a diagram's author controls must not hang
// the page, break a render, move a formula into another label, or paint
// sizes the browser chokes on. What regresses if these fail: a colour, a
// front matter line or a `%%{` run stalls the tab for a second or more; a
// formula KaTeX cannot handle leaves a block stuck on "rendering" and
// 'pele-where-safe' never falls back to Mermaid; formulas blow a diagram past
// the output limit; an entity forges a placeholder; an author's
// `stroke-dasharray:0.0001` or `stroke-width:9999px` reaches the svg; a
// multi-line `%%{init}%%` hides a class diagram from the one-line rule; an
// attribute smuggled into a sequence `rect` colour becomes a real attribute.
// The render cases are DOM-gated (DOM_TESTS=1); the rest run anywhere.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import katex from 'katex';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { loadRealPele, setPeleInBuildForTests } from '../test-setup/pele';
import { __setDiagramEngineModeForTests } from './diagram-engine';
import { renderDiagram } from './diagram-render';
import { getMathRenderer, resetMathRenderer, setMathRenderer, type MathRenderer } from './math';
import { __setPeleRuntimeLoaderForTests, PELE_OUTPUT_LIMIT, renderPeleSource, type PeleRuntime } from './pele';
import { PELE_MATH_TOTAL_LIMIT, preparePeleLabels, safeLabelColor, typesetPeleMath, type MathTypesetter } from './pele-labels';
import { readPeleAuthorColors } from './peleAuthorTheme';
import { clampPeleStyle } from './peleStyleClamp';

const hasDom = typeof document !== 'undefined';

const fake: MathTypesetter = {
  typeset: (tex) => `<math><mi>${tex}</mi></math>`,
  measure: (htmls) => htmls.map((html) => ({ w: 2, h: html.includes('tall') ? 2.4 : 1.2 })),
};

const elapsed = (run: () => unknown): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

describe('hostile input costs one pass', () => {
  test('a colour value with long runs of spaces is refused at once', () => {
    const spaces = ' '.repeat(800);
    const hostile = `rgb(1${spaces}1${spaces}1${spaces}x)`;
    expect(elapsed(() => safeLabelColor(hostile))).toBeLessThan(50);
    expect(safeLabelColor(hostile)).toBeNull();
    expect(elapsed(() => preparePeleLabels(`flowchart LR\n  A["<span style='color:${hostile}'>a</span>"]`, null))).toBeLessThan(50);
    // Still a colour: spaces or commas between the numbers, and nothing longer than a colour needs.
    expect(safeLabelColor('rgb(1   2   3)')).toBe('rgb(1   2   3)');
    expect(safeLabelColor('rgb( 1 , 2 ,3 )')).toBe('rgb( 1 , 2 ,3 )');
    expect(safeLabelColor(`rgb(1, 2, 3${' '.repeat(60)})`)).toBeNull();
  });

  test('an author colour, a front matter line, a run of `%%{` and an unclosed quoted string', () => {
    const spaces = ' '.repeat(800);
    const cases = [
      `%%{init: {'themeVariables': {'primaryColor': 'rgb(1${spaces}1${spaces}1${spaces}x)'}}}%%\nflowchart LR\n  A --> B`,
      `---\nconfig:\n  a:${' '.repeat(20_000)}x\n---\nflowchart LR\n  A --> B`,
      `---\nconfig:\n  a: x${' '.repeat(20_000)}x\n---\nflowchart LR\n  A --> B`,
      '%%{'.repeat(33_000),
      `%%{init: {'a': '${"\\'".repeat(45_000)}}}%%\nflowchart LR\n  A --> B`,
    ];
    for (const source of cases) expect(elapsed(() => readPeleAuthorColors(source))).toBeLessThan(50);
    expect(elapsed(() => preparePeleLabels(`${'%%{'.repeat(33_000)}\n<u>x</u>`, null))).toBeLessThan(50);
    // The readers still read what they did.
    expect(readPeleAuthorColors("---\nconfig:\n  themeVariables:\n    primaryColor: '#ff0000'   # a comment\n---\nflowchart LR\n  A --> B")).toEqual({ primaryColor: '#ff0000' });
    expect(readPeleAuthorColors("%%{init: {'themeVariables': {'lineColor': 'it\\'s', 'primaryColor': \"#00ff00\"}}}%%\n%%{ init: { themeVariables: { textColor: 'blue', } } }%%\nflowchart LR")).toEqual({ primaryColor: '#00ff00', textColor: 'blue' });
  });
});

describe('formulas that fail or grow', () => {
  test('a formula the typesetter throws on stays its TeX text, and the others are still typeset', () => {
    const throwing: MathTypesetter = {
      ...fake,
      typeset: (tex) => {
        if (tex === 'deep') throw new RangeError('Maximum call stack size exceeded');
        return fake.typeset(tex);
      },
    };
    const prepared = preparePeleLabels('flowchart LR\n  A["$$a$$"] --> B["$$deep$$"] --> C["$$c$$"]', throwing)!;
    expect(prepared.maths.map((m) => m.tex)).toEqual(['a', 'c']);
    expect(prepared.text).toContain('B["$$deep$$"]');
    expect(prepared.text).not.toContain('$$a$$');
    expect(prepared.text).not.toContain('$$c$$');
  });

  test('a nested `\\def` expands into a few hundred bytes, not hundreds of kilobytes', () => {
    const x = 'x'.repeat(60);
    const bomb = `\\def\\a{${x}}\\def\\b{\\a\\a\\a\\a\\a\\a\\a\\a\\a\\a}\\def\\c{\\b\\b\\b\\b\\b\\b\\b\\b\\b\\b}\\def\\d{\\c\\c\\c\\c\\c\\c\\c\\c\\c}\\d`;
    expect(typesetPeleMath(katex, bomb).length).toBeLessThan(10_000);
    // A real formula still typesets.
    expect(typesetPeleMath(katex, '\\begin{pmatrix} a_{11} & \\cdots \\\\ \\vdots & \\ddots \\end{pmatrix} \\neq \\sum_{i=1}^{n} \\frac{\\partial^2 f}{\\partial x_i^2}')).not.toContain('katex-error');
  });

  test("the diagram's MathML is capped in all: a formula past the cap stays its TeX text", () => {
    const big: MathTypesetter = { ...fake, typeset: () => `<math>${'<mi>x</mi>'.repeat(10_000)}</math>` };
    const source = `flowchart LR\n${Array.from({ length: 6 }, (_, i) => `  N${i}["$$f${i}$$"]`).join('\n')}`;
    const prepared = preparePeleLabels(source, big)!;
    const total = prepared.maths.reduce((sum, m) => sum + m.html.length, 0);
    expect(total).toBeLessThanOrEqual(PELE_MATH_TOTAL_LIMIT);
    expect(prepared.maths.length).toBeLessThan(6);
    expect(prepared.text).toContain('N5["$$f5$$"]');
  });
});

describe('an entity cannot forge a placeholder', () => {
  test('the codes avoid every character an entity in the source stands for', () => {
    const prepared = preparePeleLabels('flowchart LR\n  A["#57600;#57344;"] --> B["$$x^2$$"]', fake)!;
    expect(prepared.codes.has('\uE100\uE000')).toBe(false);
    const hex = preparePeleLabels('flowchart LR\n  A["&#xE100;&#xE000; #59648;#59392;"] --> B["$$x^2$$"]', fake)!;
    expect(hex.codes.has('\uE100\uE000\uE900\uE800')).toBe(false);
  });
});

describe('an author style held to sane sizes', () => {
  test('dash arrays, stroke width, font size and radius are clamped; Pele\'s own values pass', () => {
    expect(clampPeleStyle('rx:var(--_r);stroke-dasharray:0.0001;stroke-width:9999px;rx:9999;ry:9999;')).toBe('rx:var(--_r);stroke-dasharray:1;stroke-width:16px;rx:64px;ry:64px');
    expect(clampPeleStyle('font-size:999px;')).toBe('font-size:64px');
    expect(clampPeleStyle('font-size:99em')).toBe('font-size:64px');
    expect(clampPeleStyle('stroke-dasharray:1e-9 0.001')).toBe('stroke-dasharray:1 1');
    expect(clampPeleStyle(`stroke-dasharray:${Array.from({ length: 40 }, () => '3').join(',')}`)).toBe('');
    expect(clampPeleStyle('stroke-width:1e9;fill:#ff0000')).toBe('stroke-width:16px;fill:#ff0000');
    // Nothing to change: kept exactly.
    for (const style of ['rx:var(--_r)', 'stroke-dasharray:5 5;stroke-width:2px', 'stroke-dasharray:0', 'font-size:14px;', 'letter-spacing:normal;word-spacing:normal', 'font-size:small']) {
      expect(clampPeleStyle(style)).toBe(style);
    }
  });

  test("Pele's own drawing of every type is left as it is", async () => {
    const runtime = await loadRealPele();
    const sources = [
      'flowchart LR\n  A[Start] -.-> B{Choice} ==> C((Done))\n  subgraph G [Group]\n    C\n  end',
      'sequenceDiagram\n  participant A\n  A->>B: Hello\n  B-->>A: Hi\n  rect rgb(200, 220, 255)\n    A->>B: in a box\n  end\n  Note over A,B: a note',
      'stateDiagram-v2\n  [*] --> S1\n  S1 --> S2: go\n  S2 --> [*]',
      'classDiagram\n  class User {\n    +name: string\n  }\n  User <|-- Admin',
      'erDiagram\n  USER ||--o{ ORDER : places',
      'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2024-01-01, 3d',
      'pie\n  "One": 1\n  "Two": 2',
      'mindmap\n  root((Root))\n    A\n    B',
      'timeline\n  title History\n  2020 : one\n  2021 : two',
      'journey\n  title Day\n  section Morning\n    Wake: 3: Me',
    ];
    let styles = 0;
    for (const source of sources) {
      if (!(await runtime.supports(source))) continue;
      const { svg } = await renderPeleSource(runtime, source, 'own');
      for (const match of svg.matchAll(/\sstyle="([^"]*)"/gu)) {
        styles += 1;
        expect(clampPeleStyle(match[1] ?? '')).toBe(match[1] ?? '');
      }
    }
    expect(styles).toBeGreaterThan(20);
  });
});

describe('the type sniff', () => {
  test('a `%%{init}%%` over several lines still leaves a class member on one line', () => {
    const prepared = preparePeleLabels("%%{init: {\n  'theme': 'base'\n}}%%\nclassDiagram\n  class C {\n    +ratio() $$tall$$\n  }", fake)!;
    expect(prepared.maths.map((m) => m.fit)).toEqual([true]);
  });
});

// ------------------------------------------------------------------ drawn

let restoreParser: (() => void) | undefined;
let previousRenderer: MathRenderer | null = null;
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
const id = (): string => `hostile-${Math.random().toString(36).slice(2)}`;

describe.if(hasDom)('hostile sources drawn by Pele', () => {
  test('a formula KaTeX throws on is drawn as its TeX, and the render resolves', async () => {
    const throwing: MathRenderer = {
      renderToString: (tex, options) => {
        if (tex.startsWith('{{')) throw new RangeError('Maximum call stack size exceeded');
        return katex.renderToString(tex, options);
      },
    };
    setMathRenderer(throwing, 'host');
    try {
      const result = await renderDiagram('mermaid', id(), 'flowchart LR\n  A["$${{{x}}}$$"] --> B["$$y^2$$"]', theme);
      if (result.ok === false) throw new Error(result.message);
      expect(result.svgNode.querySelector('g.pele-node[data-id="A"]')?.textContent).toContain('$${{{x}}}$$');
      expect(result.svgNode.querySelector('g.pele-node[data-id="B"] foreignObject.pele-math')).not.toBeNull();
    } finally {
      setMathRenderer(katex, 'host');
    }
  });

  test('in pele-where-safe, a label step that throws falls back to Mermaid instead of rejecting', async () => {
    const broken: MathRenderer = {
      renderToString: () => {
        throw new RangeError('Maximum call stack size exceeded');
      },
    };
    setMathRenderer(broken, 'host');
    __setDiagramEngineModeForTests('pele-where-safe');
    try {
      // Whatever Mermaid makes of it here, the promise settles with a result.
      const result = await renderDiagram('mermaid', id(), 'flowchart LR\n  A["$$x$$"] --> B', theme);
      expect(typeof result.ok).toBe('boolean');
    } finally {
      __setDiagramEngineModeForTests('pele');
      setMathRenderer(katex, 'host');
    }
  });

  test('the output limit holds after the formulas are put in', async () => {
    const pad = `<!--${'p'.repeat(PELE_OUTPUT_LIMIT - 150_000)}-->`;
    const near: PeleRuntime = {
      supports: async () => true,
      render: async (source) => {
        const label = /A\["(.*)"\]/u.exec(source)?.[1] ?? '';
        return { svg: `<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-flowchart" viewBox="0 0 10 10"><g class="pele-node" data-id="A"><text x="0" y="0">${label}</text></g>${pad}</svg>`, type: 'flowchart' } as Awaited<ReturnType<PeleRuntime['render']>>;
      },
    };
    const big: MathRenderer = { renderToString: () => `<math>${'<mi>x</mi>'.repeat(10_000)}</math>` };
    __setPeleRuntimeLoaderForTests(async () => near);
    setMathRenderer(big, 'host');
    try {
      const result = await renderDiagram('mermaid', id(), 'flowchart LR\n  A["$$a$$ $$b$$"]', theme);
      expect(result.ok).toBe(false);
      if (result.ok === true) return;
      expect(result.message).toContain('character limit');
    } finally {
      setMathRenderer(katex, 'host');
      setPeleInBuildForTests(true);
    }
  });

  test("an entity in one label cannot pull another label's formula into it", async () => {
    const result = await renderDiagram('mermaid', id(), 'flowchart LR\n  A["#57600;#57344;"] --> B["$$x^2$$"]', theme);
    if (result.ok === false) throw new Error(result.message);
    expect(result.svgNode.querySelector('g.pele-node[data-id="A"] foreignObject.pele-math')).toBeNull();
    expect(result.svgNode.querySelector('g.pele-node[data-id="B"] foreignObject.pele-math')?.getAttribute('data-pele-tex')).toBe('x^2');
  });

  test("an author's dash array, stroke width, font size and radius reach the svg clamped", async () => {
    const source = 'flowchart TD\n  A --> B\n  classDef default stroke-dasharray:0.0001,stroke-width:9999px,font-size:999px,rx:9999\n  linkStyle 0 stroke-dasharray:0.001,stroke-width:9999px';
    const result = await renderDiagram('mermaid', id(), source, theme);
    if (result.ok === false) throw new Error(result.message);
    const styles = Array.from(result.svgNode.querySelectorAll('[style]'), (el) => el.getAttribute('style') ?? '').join(';');
    const values = (name: string): number[] => Array.from(styles.matchAll(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'giu')), (m) => m[1] ?? '').flatMap((v) => v.split(/[\s,]+/u)).map((v) => Number.parseFloat(v)).filter(Number.isFinite);
    expect(values('stroke-width').length).toBeGreaterThan(0);
    expect(Math.max(...values('stroke-width'))).toBeLessThanOrEqual(16);
    expect(Math.min(...values('stroke-dasharray'))).toBeGreaterThanOrEqual(1);
    expect(Math.max(...values('font-size'))).toBeLessThanOrEqual(64);
    expect(Math.max(...values('rx'))).toBeLessThanOrEqual(64);
  });

  test('an attribute smuggled into a sequence rect colour stays text inside its style', async () => {
    const result = await renderDiagram('mermaid', id(), 'sequenceDiagram\n  rect rgb(0,0,0)" onload="alert(1)\n    A->>B: hi\n  end', theme);
    if (result.ok === false) throw new Error(result.message);
    const all = [result.svgNode, ...Array.from(result.svgNode.querySelectorAll('*'))];
    expect(all.flatMap((el) => Array.from(el.attributes, (a) => a.name)).filter((name) => name.startsWith('on'))).toEqual([]);
    // The words are still there, as part of the style's value (an invalid colour), not as an attribute.
    expect(result.svgNode.querySelector('rect.pele-rect')?.getAttribute('style')).toContain('onload="alert(1)');
  });
});
