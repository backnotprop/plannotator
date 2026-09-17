/**
 * The Graphviz entry of the renderer slot over the REAL `@viz-js/viz` 3.30.0
 * engine (the wasm runs under Bun; happy-dom parses the svg it emits, so
 * every id, class and title below is the engine's own), and the Graphviz
 * finder beside the Mermaid codec.
 *
 * What regresses if these fail:
 * - the finder keys on the emitted `nodeN` id, which is a declaration
 *   counter: inserting `A -> Z` before `B -> C` moves C from node3 to node4,
 *   so every comment on C would restore onto Z. The anchor is the DOT name
 *   from the group's `<title>`;
 * - an edge is described without both ends, or a cluster is missed, so the
 *   composer cannot open on them; the label fallback (restore step 2) does
 *   not run when the name is gone;
 * - `graphvizSourceLine` points at the wrong statement;
 * - the Graphviz svg bypasses the scrub: a DOT `URL=` attribute emits
 *   `<a xlink:href>` around the node (a pinpoint click becomes a
 *   navigation) or a `javascript:` URL survives;
 * - the theme pass recolors an author's color, leaves the white page
 *   polygon (an opaque block on the dark canvas), or misses the default
 *   black strokes and text;
 * - a syntax error throws instead of resolving to a value with the line;
 * - `diagramFinder("graphviz")` and the render result's `findTarget`
 *   disagree (two seams).
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { buildDiagramAnchorValue, parseDiagramAnchor } from './diagram-anchor';
import {
  GRAPHVIZ_FINDER,
  GRAPHVIZ_TARGET_SELECTOR,
  graphvizFindTarget,
  graphvizSourceLine,
  graphvizTargetFromElement,
} from './diagram-anchor-graphviz';
import { diagramFinder, renderDiagram, themeGraphvizSvg } from './diagram-render';

const hasDom = typeof document !== 'undefined';
const THEME = { colorTheme: 'plannotator', mode: 'dark' } as const;

let restoreParser: (() => void) | null = null;
beforeAll(() => {
  if (hasDom) restoreParser = installInertDiagramSvgParser();
});
afterAll(() => restoreParser?.());

const CLUSTERED = ['digraph G {', '  A -> B', '  B -> C', '  subgraph cluster_0 { label="group"; B; C; }', '}', ''].join('\n');
const BEFORE = ['digraph G {', '  A -> B', '  B -> C', '}', ''].join('\n');
const AFTER = ['digraph G {', '  A -> B', '  A -> Z', '  B -> C', '}', ''].join('\n');

async function render(source: string, id = 'diagram-gv'): Promise<SVGSVGElement> {
  const result = await renderDiagram('graphviz', id, source, THEME);
  if (result.ok === false) throw new Error(`render failed: ${result.message}`);
  return result.svgNode;
}

function titled(svg: Element, selector: string, title: string): Element | null {
  for (const el of Array.from(svg.querySelectorAll(selector))) {
    const t = Array.from(el.children).find((c) => c.tagName.toLowerCase() === 'title');
    if ((t?.textContent ?? '').trim() === title) return el;
  }
  return null;
}

describe.if(hasDom)('the Graphviz renderer entry over the real engine', () => {
  test('renders a digraph with a cluster to the engine\'s own groups, and the finder describes every part by DOT name', async () => {
    const svg = await render(CLUSTERED);
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelector('g.graph > title')?.textContent).toBe('G');
    const parts = new Map<string, unknown>();
    for (const el of Array.from(svg.querySelectorAll(GRAPHVIZ_TARGET_SELECTOR))) {
      const target = graphvizTargetFromElement(svg, el);
      if (target !== null) parts.set(el.id, target);
    }
    expect(parts.get('node1')).toEqual({ family: 'graphviz', kind: 'node', id: 'A', label: 'A' });
    expect(parts.get('node2')).toEqual({ family: 'graphviz', kind: 'node', id: 'B', label: 'B' });
    expect(parts.get('node3')).toEqual({ family: 'graphviz', kind: 'node', id: 'C', label: 'C' });
    expect(parts.get('edge1')).toEqual({ family: 'graphviz', kind: 'edge', from: 'A', to: 'B', label: '' });
    expect(parts.get('edge2')).toMatchObject({ kind: 'edge', from: 'B', to: 'C' });
    expect(parts.get('clust1')).toEqual({ family: 'graphviz', kind: 'cluster', id: 'cluster_0', label: 'group' });
    expect(parts.has('graph0')).toBe(false);
  }, 30000);

  test('finds a node by name while the nodeN counter shifts under an insertion, and by label when the name is gone', async () => {
    const before = await render(BEFORE, 'diagram-gv-before');
    const after = await render(AFTER, 'diagram-gv-after');
    const c = { family: 'graphviz' as const, kind: 'node' as const, id: 'C', label: 'C' };
    expect(graphvizFindTarget(before, c)?.id).toBe('node3');
    // The insertion moved C: the same anchor now lands on node4, whose
    // title is C. An id-keyed finder would have returned Z (node3).
    expect(graphvizFindTarget(after, c)?.id).toBe('node4');
    expect(titled(after, 'g.node', 'Z')?.id).toBe('node3');
    const bc = { family: 'graphviz' as const, kind: 'edge' as const, from: 'B', to: 'C', label: '' };
    expect(graphvizFindTarget(before, bc)?.id).toBe('edge2');
    expect(graphvizFindTarget(after, bc)?.id).toBe('edge3');
    const relabeled = await render('digraph G { A -> B\n  B -> D [label=""]\n  D [label="C"] }', 'gv-l');
    expect(graphvizFindTarget(relabeled, { family: 'graphviz', kind: 'node', id: 'C', label: 'C' })?.id).toBe(titled(relabeled, 'g.node', 'D')?.id);
    expect(graphvizFindTarget(after, { family: 'graphviz', kind: 'node', id: 'Q', label: 'Q' })).toBeNull();
  }, 30000);

  test('maps a part to its first declaring line, quoted names inside their quotes, clusters to the subgraph line', () => {
    const source = ['digraph G {', '  "Order intake" -> Validate', '  Validate -> Ship', '  subgraph cluster_ops { label=ops; Validate; Ship }', '}'].join('\n');
    expect(graphvizSourceLine(source, { family: 'graphviz', kind: 'node', id: 'Order intake', label: 'Order intake' })).toEqual([2, 2]);
    expect(graphvizSourceLine(source, { family: 'graphviz', kind: 'node', id: 'Ship', label: 'Ship' })).toEqual([3, 3]);
    expect(graphvizSourceLine(source, { family: 'graphviz', kind: 'edge', from: 'Validate', to: 'Ship', label: '' })).toEqual([3, 3]);
    expect(graphvizSourceLine(source, { family: 'graphviz', kind: 'cluster', id: 'cluster_ops', label: 'ops' })).toEqual([4, 4]);
    expect(graphvizSourceLine('digraph { Shipping -> X }', { family: 'graphviz', kind: 'node', id: 'Ship', label: 'Ship' })).toBeNull();
  });

  test('passes the engine\'s svg through the scrub: no anchor href from URL=, no javascript:, no handler', async () => {
    const svg = await render(
      [
        'digraph G {',
        '  A [URL="javascript:alert(1)", label="Approve"]',
        '  B [href="https://example.com/away", target="_blank"]',
        '  C [label=<<b onclick="alert(1)">bold</b>>]',
        '  A -> B -> C',
        '}',
      ].join('\n'),
      'diagram-gv-hostile',
    );
    expect(svg.querySelector('script')).toBeNull();
    expect(svg.querySelector('a[href], a[xlink\\:href]')).toBeNull();
    expect(svg.querySelector('[onclick], [onload], [onerror]')).toBeNull();
    expect(svg.outerHTML).not.toContain('javascript:');
    expect(svg.outerHTML).not.toContain('example.com');
    expect(svg.textContent).toContain('Approve');
    expect(graphvizFindTarget(svg, { family: 'graphviz', kind: 'node', id: 'A', label: '' })).not.toBeNull();
  }, 30000);

  test('the theme pass recolors the Graphviz defaults onto the page tokens and leaves author colors alone', async () => {
    const svg = await render(
      ['digraph G {', '  A', '  B [style=filled, fillcolor="#fde68a", color=red, fontcolor=blue]', '  C [style=filled]', '  A -> B', '  subgraph cluster_0 { label="ops"; C }', '}'].join('\n'),
      'diagram-gv-theme',
    );
    expect(svg.querySelector('g.graph > polygon[fill="white"]')).toBeNull();
    const a = titled(svg, 'g.node', 'A')!;
    expect(a.querySelector('ellipse')?.getAttribute('fill')).toBe('var(--card)');
    expect(a.querySelector('ellipse')?.getAttribute('stroke')).toBe('var(--foreground)');
    expect(a.querySelector('text')?.getAttribute('fill')).toBe('var(--foreground)');
    const b = titled(svg, 'g.node', 'B')!;
    expect(b.querySelector('ellipse')?.getAttribute('fill')).toBe('#fde68a');
    expect(b.querySelector('ellipse')?.getAttribute('stroke')).toBe('red');
    expect(b.querySelector('text')?.getAttribute('fill')).toBe('blue');
    const c = titled(svg, 'g.node', 'C')!;
    expect(c.querySelector('ellipse')?.getAttribute('fill')).toBe('var(--muted)');
    expect(svg.querySelector('g.cluster > polygon')?.getAttribute('stroke')).toBe('var(--border)');
    expect(svg.querySelector('g.edge > path')?.getAttribute('stroke')).toBe('var(--foreground)');
    expect(svg.querySelector('g.edge > polygon')?.getAttribute('fill')).toBe('var(--foreground)');
    const before = svg.outerHTML;
    themeGraphvizSvg(svg);
    expect(svg.outerHTML).toBe(before);
  }, 30000);

  test('a syntax error resolves to a value with the line, never a throw', async () => {
    const result = await renderDiagram('graphviz', 'diagram-gv-bad', 'digraph G {\n  A ->\n}\n', THEME);
    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.message).toMatch(/syntax error/u);
    expect(result.line).toBe(3);
    expect(result.runtimeUnavailable).toBe(false);
  }, 30000);

  test('the codec writes and reads the graphviz family, and the slot\'s finder is the result\'s finder', async () => {
    const target = { family: 'graphviz' as const, kind: 'node' as const, id: 'Ship', label: 'Ship' };
    const anchor = buildDiagramAnchorValue(target, [3, 3]);
    expect(parseDiagramAnchor(anchor)).toEqual({ ...target, v: 1, sourceLine: [3, 3] });
    const result = await renderDiagram('graphviz', 'diagram-gv-seam', BEFORE, THEME);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.findTarget).toBe(GRAPHVIZ_FINDER.findTarget);
    expect(diagramFinder('graphviz')).toBe(GRAPHVIZ_FINDER);
    expect(diagramFinder('graphviz').targetSelector).toBe(GRAPHVIZ_TARGET_SELECTOR);
  }, 30000);
});
