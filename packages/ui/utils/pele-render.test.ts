// Guards the real Pele -> sanitizer -> viewer boundary, not just the npm API.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { diagramFinder, diagramHitSource, renderDiagram } from './diagram-render';
import { __setMermaidRuntimeLoaderForTests } from './mermaid';

const hasDom = typeof document !== 'undefined';
let restoreParser: (() => void) | undefined;
beforeAll(() => { if (hasDom) restoreParser = installInertDiagramSvgParser(); });
afterAll(() => restoreParser?.());
afterEach(() => __setMermaidRuntimeLoaderForTests(undefined));
const theme = { colorTheme: 'github', mode: 'dark', mermaidEngine: 'pele' } as const;

describe.if(hasDom)('Pele render integration', () => {
  test('sanitizes actual output and gives edges widened hit targets, excluding arrowheads', async () => {
    const result = await renderDiagram('mermaid', 'integration', 'flowchart TD\nsubgraph S[Group]\n A[Start] -->|next| B[Done]\nend\nclick A "https://example.com"', theme);
    expect(result.ok).toBe(true);
    if (result.ok === false) throw new Error(result.message);
    const svg = result.svgNode;
    expect(svg.querySelector('script, image, a[href]')).toBeNull();
    expect(svg.style.getPropertyValue('--pele-fg')).toBe('var(--foreground)');
    const edges = svg.querySelectorAll('g.pele-edge > path:not(.pele-marker)');
    const hits = svg.querySelectorAll('[data-diagram-hit]');
    expect(edges.length).toBeGreaterThan(0);
    expect(hits.length).toBe(edges.length);
    const finder = diagramFinder('mermaid');
    for (const hit of hits) {
      const source = diagramHitSource(hit)!;
      expect(source.classList.contains('pele-marker')).toBe(false);
      const edge = source.closest(finder.targetSelector)!;
      const target = finder.targetFromElement(svg, edge, 'integration')!;
      expect(target.kind).toBe('edge');
      expect(finder.findTarget(svg, target, 'integration')).toBe(edge);
    }
    const cluster = svg.querySelector('g.pele-cluster[data-id="S"]')!;
    const anchor = finder.targetFromElement(svg, cluster, 'integration')!;
    expect(anchor.kind).toBe('cluster');
    expect(finder.findTarget(svg, anchor, 'integration')).toBe(cluster);
  });

  test('keeps Mermaid as the default and dispatches the finder from the displayed SVG', async () => {
    let mermaidLoads = 0;
    __setMermaidRuntimeLoaderForTests(async () => {
      mermaidLoads++;
      return {
        initialize() {},
        async render(id: string) {
          return { svg: `<svg id="${id}" viewBox="0 0 10 10" aria-roledescription="flowchart"><g class="node" id="${id}-flowchart-A-0"><text>Start</text></g></svg>` };
        },
      } as any;
    });
    const pele = await renderDiagram('mermaid', 'alternative', 'flowchart TD\n A[Start] --> B', theme);
    expect(pele.ok).toBe(true);
    expect(mermaidLoads).toBe(0);
    const mermaid = await renderDiagram('mermaid', 'default', 'flowchart TD\n A --> B', { colorTheme: 'github', mode: 'dark' });
    expect(mermaid.ok).toBe(true);
    expect(mermaidLoads).toBe(1);
    if (!pele.ok || !mermaid.ok) throw new Error('render failed');
    const anchor = { family: 'flowchart', kind: 'node', id: 'A', label: 'Start' } as const;
    const finder = diagramFinder('mermaid');
    expect(finder.findTarget(pele.svgNode, anchor, 'alternative')?.getAttribute('data-id')).toBe('A');
    expect(finder.findTarget(mermaid.svgNode, anchor, 'default')?.id).toBe('default-flowchart-A-0');
  });

  test('keeps whole-diagram comments restorable on every rendered family', async () => {
    for (const source of ['pie\n "One": 1', 'sequenceDiagram\n A->>B: Hello', 'classDiagram\n class User']) {
      const result = await renderDiagram('mermaid', 'whole', source, theme);
      expect(result.ok).toBe(true);
      if (result.ok === false) throw new Error(result.message);
      expect(diagramFinder('mermaid').findTarget(result.svgNode, { family: 'other', kind: 'diagram', label: '' }, 'whole')).toBe(result.svgNode);
    }
  });

  test('keeps accessibility IDs unique when the same diagram appears twice', async () => {
    const source = 'flowchart TD\naccTitle: Review\naccDescr: Review flow\n A --> B';
    const first = await renderDiagram('mermaid', 'first', source, theme);
    const second = await renderDiagram('mermaid', 'second', source, theme);
    if (first.ok === false || second.ok === false) throw new Error('render failed');
    const firstIds = new Set(Array.from(first.svgNode.querySelectorAll('[id]'), el => el.id));
    const secondIds = Array.from(second.svgNode.querySelectorAll('[id]'), el => el.id);
    expect(firstIds.size).toBeGreaterThan(0);
    expect(secondIds.some(id => firstIds.has(id))).toBe(false);
    for (const svg of [first.svgNode, second.svgNode]) {
      for (const name of ['aria-labelledby', 'aria-describedby']) {
        const target = svg.getAttribute(name)!;
        expect(svg.querySelector(`[id="${target}"]`)).not.toBeNull();
      }
    }
  });

  test('reports malformed source without silently changing engines', async () => {
    let mermaidLoads = 0;
    __setMermaidRuntimeLoaderForTests(async () => { mermaidLoads++; throw new Error('must not load'); });
    const result = await renderDiagram('mermaid', 'invalid', 'not a diagram', theme);
    expect(result.ok).toBe(false);
    if (result.ok === true) throw new Error('invalid source rendered');
    expect(result.runtimeUnavailable).toBe(false);
    expect(mermaidLoads).toBe(0);
  });
});
