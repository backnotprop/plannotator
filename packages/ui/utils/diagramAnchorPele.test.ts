import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInertSvg } from '../test-setup/diagramSvg';
import { diagramFamilyOf } from './diagram-anchor';
import { MERMAID_FINDER } from './diagram-anchor';
import { PELE_COMPAT_FINDER, PELE_FINDER } from './diagram-anchor-pele';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const RENDER_ID = 'diagram-fixture';

function load(name: string): SVGSVGElement {
  const svg = parseInertSvg(readFileSync(join(FIXTURES, `${name}.svg`), 'utf8'));
  if (svg === null) throw new Error(`fixture ${name} has no SVG root`);
  return svg;
}

describe.if(hasDom)('Pele 1.3.0 flowchart anchors', () => {
  test('detects Pele output and maps stable data-id groups to the shared anchor wire shape', () => {
    const svg = load('pele-flowchart');
    expect(diagramFamilyOf(svg)).toBe('flowchart');
    const node = svg.querySelector('.pele-node[data-id="B"]');
    const edge = svg.querySelector('.pele-edge[data-id="L_A_B_0"]');
    expect(node && PELE_FINDER.targetFromElement(svg, node, RENDER_ID)).toEqual({
      family: 'flowchart', kind: 'node', id: 'B', label: 'Approve?',
    });
    expect(edge && PELE_FINDER.targetFromElement(svg, edge, RENDER_ID)).toEqual({
      family: 'flowchart', kind: 'edge', from: 'A', to: 'B', label: 'yes',
    });
    const edgeLabel = svg.querySelector('.pele-edge-label[data-id="L_A_B_0"]');
    expect(edgeLabel && PELE_FINDER.targetFromElement(svg, edgeLabel, RENDER_ID)).toEqual({
      family: 'flowchart', kind: 'edge', from: 'A', to: 'B', label: 'yes',
    });
  });

  test('restores by stable ids, unique label fallback and source line, refusing ambiguous duplicate edges', () => {
    const svg = load('pele-flowchart');
    const node = PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'node', id: 'B', label: '' }, RENDER_ID);
    expect(node?.getAttribute('data-id')).toBe('B');
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'edge', from: 'A', to: 'B', label: '' }, RENDER_ID)?.getAttribute('data-id')).toBe('L_A_B_0');
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'node', id: 'old', label: 'Approve?' }, RENDER_ID)?.getAttribute('data-id')).toBe('B');
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'node', id: 'missing', label: 'Nowhere' }, RENDER_ID)).toBeNull();
    expect(PELE_FINDER.sourceLine('flowchart TD\n A[Reviewer] --> B[Approve?]\n B --> C[Done]', { family: 'flowchart', kind: 'node', id: 'B', label: '' })).toEqual([2, 2]);
    expect(PELE_FINDER.sourceLine('flowchart TD\n A --> B', { family: 'flowchart', kind: 'node', id: 'Missing', label: '' })).toBeNull();

    const edge = svg.querySelector('.pele-edge[data-id="L_A_B_0"]')!;
    const duplicate = edge.cloneNode(true) as Element;
    duplicate.setAttribute('data-id', 'L_A_B_1');
    edge.parentElement!.appendChild(duplicate);
    expect(PELE_FINDER.targetFromElement(svg, duplicate, RENDER_ID)).toBeNull();
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'edge', from: 'A', to: 'B', label: '' }, RENDER_ID)).toBeNull();
  });

  test('whole-diagram comments restore on non-flowcharts; foreign parts and duplicate labels do not bind', () => {
    const pie = parseInertSvg('<svg class="pele pele-pie" viewBox="0 0 100 100"/>')!;
    expect(PELE_FINDER.findTarget(pie, { family: 'other', kind: 'diagram', label: '' }, RENDER_ID)).toBe(pie);
    const svg = load('pele-flowchart');
    expect(PELE_FINDER.findTarget(svg, { family: 'class', kind: 'node', id: 'B', label: 'Approve?' }, RENDER_ID)).toBeNull();
    const node = svg.querySelector('.pele-node[data-id="B"]')!;
    const duplicate = node.cloneNode(true) as Element;
    duplicate.setAttribute('data-id', 'renamed');
    node.parentElement!.appendChild(duplicate);
    expect(PELE_FINDER.findTarget(svg, { family: 'flowchart', kind: 'node', id: 'gone', label: 'Approve?' }, RENDER_ID)).toBeNull();
  });

  test('compatibility finder chooses from the rendered SVG and leaves Mermaid SVG handling intact', () => {
    const pele = load('pele-flowchart');
    const peleNode = pele.querySelector('.pele-node[data-id="A"]')!;
    expect(PELE_COMPAT_FINDER.targetFromElement(pele, peleNode, RENDER_ID)?.id).toBe('A');

    const mermaid = load('06-flowchart-review-decision');
    const mermaidNode = mermaid.querySelector('g.node')!;
    expect(PELE_COMPAT_FINDER.targetFromElement(mermaid, mermaidNode, RENDER_ID)).toEqual(
      MERMAID_FINDER.targetFromElement(mermaid, mermaidNode, RENDER_ID),
    );
  });
});
