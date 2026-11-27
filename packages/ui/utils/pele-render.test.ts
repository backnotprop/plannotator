// Guards the real Pele -> sanitizer -> viewer boundary, not just the npm API,
// with the engine switch (`diagram-engine.ts`) sending fences to Pele.
// DOM-gated (DOM_TESTS=1).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import { setPeleInBuildForTests } from '../test-setup/pele';
import { __setDiagramEngineModeForTests } from './diagram-engine';
import { diagramFinder, diagramHitSource, renderDiagram } from './diagram-render';

const hasDom = typeof document !== 'undefined';
let restoreParser: (() => void) | undefined;
beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  __setDiagramEngineModeForTests('pele');
  setPeleInBuildForTests(true);
});
afterAll(() => {
  restoreParser?.();
  __setDiagramEngineModeForTests(undefined);
  setPeleInBuildForTests(false);
});
const theme = { colorTheme: 'github', mode: 'dark' } as const;

describe.if(hasDom)('Pele render integration', () => {
  test('sanitizes actual output and gives edges widened hit targets, excluding arrowheads', async () => {
    const result = await renderDiagram('mermaid', 'integration', 'flowchart TD\nsubgraph S[Group]\n A[Start] -->|next| B[Done]\nend\nclick A "https://example.com"', theme);
    expect(result.ok).toBe(true);
    if (result.ok === false) throw new Error(result.message);
    const svg = result.svgNode;
    expect(svg.querySelector('script, image, a[href]')).toBeNull();
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

  test('an author style that paints is kept; one that would fetch never reaches the page', async () => {
    const paints = await renderDiagram('mermaid', 'styles', 'flowchart TD\n A --> B\n style A fill:#ff0000', theme);
    if (paints.ok === false) throw new Error(paints.message);
    expect(Array.from(paints.svgNode.querySelectorAll('[style]'), (el) => el.getAttribute('style')).join(' ')).toContain('#ff0000');
    // Pele 1.3.0 refuses the url() itself; the scrub in diagram-render is the belt if a later Pele accepts it.
    const fetches = await renderDiagram('mermaid', 'fetches', 'flowchart TD\n A --> B\n style B fill:url(https://example.com/x.png)', theme);
    if (fetches.ok === true) {
      expect(Array.from(fetches.svgNode.querySelectorAll('[style]'), (el) => el.getAttribute('style')).join(' ')).not.toContain('example.com');
    } else {
      expect(fetches.runtimeUnavailable).toBe(false);
    }
  });

  test('a fence the switch sends to Pele is drawn by Pele and its parts resolve through the matching finder', async () => {
    const result = await renderDiagram('mermaid', 'default', 'flowchart TD\n A[Start] --> B', theme);
    expect(result.ok).toBe(true);
    if (result.ok === false) throw new Error(result.message);
    expect(result.svgNode.id).toBe('plannotator-pele-default');
    const anchor = { family: 'flowchart', kind: 'node', id: 'A', label: 'Start' } as const;
    expect(diagramFinder('mermaid').findTarget(result.svgNode, anchor, 'default')?.getAttribute('data-id')).toBe('A');
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

  test('reports malformed source without silently changing renderers', async () => {
    const result = await renderDiagram('mermaid', 'invalid', 'not a diagram', theme);
    expect(result.ok).toBe(false);
    if (result.ok === true) throw new Error('invalid source rendered');
    expect(result.runtimeUnavailable).toBe(false);
  });

  test('the Diagram Shadow setting draws one scoped rule on the nodes, and none when it is off', async () => {
    const on = await renderDiagram('mermaid', 'shadow-on', 'flowchart LR\n  A --> B', { ...theme, shadowAmount: 1 });
    const off = await renderDiagram('mermaid', 'shadow-off', 'flowchart LR\n  A --> B', { ...theme, shadowAmount: 0 });
    if (on.ok === false || off.ok === false) throw new Error('render failed');
    const sheets = Array.from(on.svgNode.querySelectorAll('style'), (style) => style.textContent ?? '');
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toStartWith(`#${on.svgNode.id} g.pele-node > :first-child`);
    expect(sheets[0]).toContain('filter: drop-shadow(');
    expect(off.svgNode.querySelector('style')).toBeNull();
  });

  test("only the colours an author spells out reach the drawing: a theme name changes nothing, and no panel is painted", async () => {
    const named = await renderDiagram('mermaid', 'named', "%%{init: {'theme': 'forest'}}%%\nflowchart LR\n  A --> B", theme);
    const plain = await renderDiagram('mermaid', 'plain', 'flowchart LR\n  A --> B', theme);
    const typed = await renderDiagram('mermaid', 'typed', "%%{init: {'theme': 'forest', 'themeVariables': {'primaryColor': '#ffd6e8', 'background': '#000000'}}}%%\nflowchart LR\n  A --> B", theme);
    if (named.ok === false || plain.ok === false || typed.ok === false) throw new Error('render failed');
    const vars = (svg: SVGSVGElement): string => Array.from(svg.style).filter((n) => n.startsWith('--pele-')).map((n) => `${n}:${svg.style.getPropertyValue(n)}`).join(';');
    expect(vars(named.svgNode)).toBe(vars(plain.svgNode));
    expect(typed.svgNode.style.getPropertyValue('--pele-surface')).toBe('#ffd6e8');
    expect(typed.svgNode.style.getPropertyValue('--pele-bg')).toBe(plain.svgNode.style.getPropertyValue('--pele-bg'));
    expect(typed.svgNode.style.backgroundColor).toBe('');
  });
});
