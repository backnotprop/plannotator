import { diagramSourceLine, sameTarget, type DiagramTarget } from '@plannotator/core/diagram-anchor';
import { MERMAID_FINDER, splitEdgeStem, type DiagramFinder } from './diagram-anchor';

/** Pele 1.3.0's addressable flowchart output uses stable data-id values on
 * `.pele-node` and `.pele-edge` groups (not Mermaid's generated SVG ids). */
export const PELE_TARGET_SELECTOR = 'g.pele-node[data-id], g.pele-cluster[data-id], g.pele-edge[data-id], g.pele-edge-label[data-id]';

function isPele(svg: Element): boolean {
  return svg.classList.contains('pele');
}

function peleRole(svg: Element): string | null {
  return Array.from(svg.classList).find((name) => name.startsWith('pele-'))?.slice(5) ?? null;
}

function nodeIds(svg: Element): ReadonlySet<string> {
  return new Set(Array.from(svg.querySelectorAll('g.pele-node[data-id]'), (node) => node.getAttribute('data-id') ?? ''));
}

function labelOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function peleTargetFromElement(svg: Element, el: Element): DiagramTarget | null {
  if (!isPele(svg) || peleRole(svg) !== 'flowchart') return null;
  const id = el.getAttribute('data-id');
  if (id === null || id === '') return null;
  if (el.classList.contains('pele-edge-label')) {
    const edge = Array.from(svg.querySelectorAll('g.pele-edge[data-id]')).find((candidate) => candidate.getAttribute('data-id') === id);
    return edge === undefined ? null : peleTargetFromElement(svg, edge);
  }
  if (el.classList.contains('pele-node') || el.classList.contains('pele-cluster')) {
    return { family: 'flowchart', kind: el.classList.contains('pele-cluster') ? 'cluster' : 'node', id, label: labelOf(el) };
  }
  if (!el.classList.contains('pele-edge')) return null;
  const stem = /^L_(.+)_\d+$/u.exec(id)?.[1];
  if (stem === undefined) return null;
  const ends = splitEdgeStem(stem, nodeIds(svg));
  if (ends === null) return null;
  // The v1 anchor has no occurrence index. Repeated edges with the same ends
  // therefore cannot be safely distinguished and are deliberately unaddressed.
  const matches = Array.from(svg.querySelectorAll('g.pele-edge[data-id]')).filter((edge) => {
    const edgeStem = /^L_(.+)_\d+$/u.exec(edge.getAttribute('data-id') ?? '')?.[1];
    if (edgeStem === undefined) return false;
    const candidateEnds = splitEdgeStem(edgeStem, nodeIds(svg));
    return candidateEnds !== null && candidateEnds.from === ends.from && candidateEnds.to === ends.to;
  });
  if (matches.length !== 1) return null;
  const edgeLabel = Array.from(svg.querySelectorAll('.pele-edge-label[data-id]')).find(
    (candidate) => candidate.getAttribute('data-id') === id,
  );
  return { family: 'flowchart', kind: 'edge', ...ends, label: labelOf(edgeLabel ?? el) };
}

function peleFindTarget(svg: Element, target: DiagramTarget): Element | null {
  if (!isPele(svg)) return null;
  // Every Pele type supports a whole-diagram comment, even when no parts
  // have a codec. Restore it before narrowing to addressable flowcharts.
  if (target.kind === 'diagram') return svg;
  if (peleRole(svg) !== 'flowchart' || target.family !== 'flowchart') return null;
  const matches = Array.from(svg.querySelectorAll('g.pele-node[data-id], g.pele-cluster[data-id], g.pele-edge[data-id]')).filter((el) => {
    const candidate = peleTargetFromElement(svg, el);
    return candidate !== null && sameTarget(candidate, target);
  });
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length !== 0 || target.kind !== 'node' || target.label === '') return null;
  const byLabel = Array.from(svg.querySelectorAll('g.pele-node')).filter((el) => labelOf(el) === target.label);
  return byLabel.length === 1 ? (byLabel[0] ?? null) : null;
}

/** Pele 1.3.0 flowchart codec; other Pele types stay whole-diagram comments. */
export const PELE_FINDER: DiagramFinder = {
  targetSelector: PELE_TARGET_SELECTOR,
  targetFromElement: (svg, el) => peleTargetFromElement(svg, el),
  findTarget: peleFindTarget,
  sourceLine(source, target) {
    return diagramSourceLine(source, target);
  },
};


/** Select the codec from the SVG actually displayed, not the user's current
 * engine preference. This lets a cached/restored SVG keep its own grammar. */
export const PELE_COMPAT_FINDER: DiagramFinder = {
  targetSelector: `${PELE_TARGET_SELECTOR}, ${MERMAID_FINDER.targetSelector}`,
  targetFromElement(svg, el, renderId) {
    return isPele(svg) ? PELE_FINDER.targetFromElement(svg, el, renderId) : MERMAID_FINDER.targetFromElement(svg, el, renderId);
  },
  findTarget(svg, target, renderId) {
    return isPele(svg) ? PELE_FINDER.findTarget(svg, target, renderId) : MERMAID_FINDER.findTarget(svg, target, renderId);
  },
  sourceLine(source, target) {
    // Both renderers' flowchart source locations use the shared token parser.
    return PELE_FINDER.sourceLine(source, target);
  },
};
