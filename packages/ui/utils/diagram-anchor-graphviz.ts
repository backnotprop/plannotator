import { diagramWholeSourceLines, lineMentions, sameTarget, type DiagramTarget } from '@plannotator/core/diagram-anchor';
import type { DiagramFinder } from './diagram-anchor';

/** The selector of every element the pointer can address in a Graphviz svg. */
export const GRAPHVIZ_TARGET_SELECTOR = 'g.node, g.edge, g.cluster';

function titleOf(el: Element): string | null {
  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() === 'title') {
      return (child.textContent ?? '').trim();
    }
  }
  return null;
}

function labelOf(el: Element): string {
  return Array.from(el.querySelectorAll('text'))
    .map((text) => text.textContent ?? '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Split at the FIRST operator: an unquoted DOT id never contains one, and a quoted name that
 * does is not worth a grammar of its own.
 */
function splitEdgeTitle(title: string): { from: string; to: string } | null {
  const m = /^(.*?)(?:->|--)(.*)$/u.exec(title);
  if (m === null) return null;
  const from = (m[1] ?? '').trim();
  const to = (m[2] ?? '').trim();
  if (from === '' || to === '') return null;
  return { from, to };
}

/** `renderId` is unused: Graphviz ids carry no prefix and the finder never reads them. */
export function graphvizTargetFromElement(_svg: Element, el: Element): DiagramTarget | null {
  const title = titleOf(el);
  if (title === null || title === '') return null;
  if (el.classList.contains('node')) {
    return { family: 'graphviz', kind: 'node', id: title, label: labelOf(el) };
  }
  if (el.classList.contains('edge')) {
    const ends = splitEdgeTitle(title);
    if (ends === null) return null;
    return { family: 'graphviz', kind: 'edge', ...ends, label: labelOf(el) };
  }
  if (el.classList.contains('cluster')) {
    return { family: 'graphviz', kind: 'cluster', id: title, label: labelOf(el) };
  }
  return null;
}

/** Step (1): the group whose title names the target. */
export function graphvizFindTarget(svg: Element, target: DiagramTarget): Element | null {
  if (target.kind === 'diagram') return svg;
  for (const el of Array.from(svg.querySelectorAll(GRAPHVIZ_TARGET_SELECTOR))) {
    const candidate = graphvizTargetFromElement(svg, el);
    if (candidate !== null && sameTarget(candidate, target)) return el;
  }
  if (target.kind === 'node' && target.label !== '') {
    const matches = Array.from(svg.querySelectorAll('g.node')).filter((el) => labelOf(el) === target.label);
    if (matches.length === 1) return matches[0] ?? null;
  }
  return null;
}

/** The 1-based line range that declares the part: DOT statements are one per line in the common case. */
export function graphvizSourceLine(source: string, target: DiagramTarget): readonly [number, number] | null {
  if (target.kind === 'diagram') return diagramWholeSourceLines(source);
  const lines = source.split('\n');
  const matches = (line: string): boolean => {
    if (target.kind === 'edge') {
      return (
        target.from !== undefined &&
        target.to !== undefined &&
        lineMentions(line, target.from) &&
        lineMentions(line, target.to)
      );
    }
    if (target.id === undefined) return false;
    if (target.kind === 'cluster') {
      return /\bsubgraph\b/u.test(line) && lineMentions(line, target.id);
    }
    return lineMentions(line, target.id);
  };
  const index = lines.findIndex(matches);
  return index === -1 ? null : [index + 1, index + 1];
}

/** The Graphviz finder behind the renderer slot's `graphviz` entry. */
export const GRAPHVIZ_FINDER: DiagramFinder = {
  targetSelector: GRAPHVIZ_TARGET_SELECTOR,
  targetFromElement: (svg, el) => graphvizTargetFromElement(svg, el),
  findTarget: (svg, target) => graphvizFindTarget(svg, target),
  sourceLine: graphvizSourceLine,
};
