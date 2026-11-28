/**
 * A Pele label wrapped over rows reads with a space between its rows.
 *
 * What regresses if this fails: a screen reader and find-in-page read a
 * wrapped node or edge label as "Detect installedagents" (Pele draws one
 * `tspan` per row with nothing between them), or the space is put where it
 * moves a row (between the rows, where it joins the row before and shifts a
 * centred row by half a space: measured in Chromium and WebKit, 2026-11-23,
 * where the space in its own placed `tspan` left every row and every pixel
 * as it was).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installInertDiagramSvgParser, parseInertSvg } from '../test-setup/diagramSvg';
import { setPeleInBuildForTests } from '../test-setup/pele';
import { PELE_FINDER } from './diagram-anchor-pele';
import { __setDiagramEngineModeForTests } from './diagram-engine';
import { renderDiagram } from './diagram-render';
import { spaceWrappedRows } from './peleRowSpaces';

const hasDom = typeof document !== 'undefined';

describe.if(hasDom)('a label Pele wraps over rows', () => {
  let restoreParser: (() => void) | undefined;
  beforeAll(() => {
    restoreParser = installInertDiagramSvgParser();
    __setDiagramEngineModeForTests('pele');
    setPeleInBuildForTests(true);
  });
  afterAll(() => {
    restoreParser?.();
    __setDiagramEngineModeForTests(undefined);
    setPeleInBuildForTests(false);
  });

  test('reads its words with a space between rows, each row where Pele put it', async () => {
    const words = 'Detect installed agents on this computer and ask which one to use';
    const result = await renderDiagram('mermaid', 'rows', `flowchart TD\n  A[${words}] -->|an edge label long enough to wrap over two rows| B[Done]`, { colorTheme: 'github', mode: 'light' });
    if (result.ok === false) throw new Error(result.message);
    const node = result.svgNode.querySelector('g.pele-node[data-id="A"] text')!;
    const rows = Array.from(node.children).filter((row) => (row.textContent ?? '').trim() !== '');
    expect(rows.length).toBeGreaterThan(1);
    expect(node.textContent).toBe(words);
    const edge = result.svgNode.querySelector('g.pele-edge-label text')!;
    expect(edge.textContent).toBe('an edge label long enough to wrap over two rows');
    // Every space is a chunk of its own at the start of the row after it.
    for (const space of Array.from(node.children).filter((row) => row.textContent === ' ')) {
      const next = space.nextElementSibling!;
      expect([space.getAttribute('x'), space.getAttribute('y')]).toEqual([next.getAttribute('x'), next.getAttribute('y')]);
    }
    // A comment's label is the same words.
    expect(PELE_FINDER.targetFromElement(result.svgNode, result.svgNode.querySelector('g.pele-node[data-id="A"]')!, 'rows')?.label).toBe(words);
  });

  test('a Chinese or Japanese label Pele wraps between characters reads run together, as its source has it', async () => {
    const words = '这是一个非常长的中文标签，用来测试换行是否正确，不应该把整个图拉得很宽很宽很宽';
    const result = await renderDiagram('mermaid', 'cjk', `flowchart TD\n  A["${words}"] --> B[Done]`, { colorTheme: 'github', mode: 'light' });
    if (result.ok === false) throw new Error(result.message);
    const node = result.svgNode.querySelector('g.pele-node[data-id="A"] text')!;
    expect(Array.from(node.children).filter((row) => (row.textContent ?? '').trim() !== '').length).toBeGreaterThan(1);
    expect(node.textContent).toBe(words);
    // A comment's label is the label as written, which is what Mermaid's finder reads for the same fence.
    expect(PELE_FINDER.targetFromElement(result.svgNode, result.svgNode.querySelector('g.pele-node[data-id="A"]')!, 'cjk')?.label).toBe(words);
  });

  test('a one-row label, a row that already ends in a space, and rows placed by a list are left as they are', () => {
    const svg = parseInertSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><text id="one"><tspan x="0" y="0">Alone</tspan></text>' +
        '<text id="spaced"><tspan x="0" y="0">Ends </tspan><tspan x="0" y="20">here</tspan></text>' +
        '<text id="list"><tspan x="0 4 8" y="0">abc</tspan><tspan x="0 4 8" y="20">def</tspan></text></svg>',
    )!;
    const before = svg.innerHTML;
    spaceWrappedRows(svg);
    expect(svg.innerHTML).toBe(before);
  });
});
