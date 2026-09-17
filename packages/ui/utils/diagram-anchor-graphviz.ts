/**
 * The Graphviz finder: the ONE function that owns the id grammar of the
 * svg `@viz-js/viz` emits, beside the Mermaid codec in `diagram-anchor.ts`.
 * The anchor it writes is the same `DiagramAnchor` shape, family `graphviz`:
 *
 *   { family: "graphviz", kind: "node", id: "Validate", label: "Validate" }
 *   { family: "graphviz", kind: "edge", from: "Order", to: "Validate", label: "" }
 *   { family: "graphviz", kind: "cluster", id: "cluster_0", label: "group" }
 *
 * Graphviz writes every part as `<g id="nodeN" class="node"><title>NAME
 * </title>...`, `<g id="edgeN" class="edge"><title>A-&gt;B</title>` and
 * `<g id="clustN" class="cluster"><title>cluster_0</title>`. The `nodeN`,
 * `edgeN` and `clustN` ids are declaration-order counters and shift when a
 * part is inserted mid-source (inserting `A -> Z` before `B -> C` moves C
 * from node3 to node4), so the anchor is the DOT NAME from the group's
 * `<title>`, never the id. Edges carry both ends in the title (`A->B` in a
 * digraph, `A--B` in a graph); a port stays on its end (`A:p`) exactly as
 * the title spells it. Restore order is the codec's: (1) the part whose
 * name matches, (2) a node whose label text equals the stored label, (3)
 * the source line as a gutter mark (the pane's job), (4) none: unanchored
 * but listed.
 *
 * Pure: no React, no DOM globals beyond the Element the caller hands in.
 */
import { lineMentions, sameTarget, type DiagramTarget } from '@plannotator/core/diagram-anchor';
import type { DiagramFinder } from './diagram-anchor';

/** The selector of every element the pointer can address in a Graphviz svg. */
export const GRAPHVIZ_TARGET_SELECTOR = 'g.node, g.edge, g.cluster';

/** The group's own `<title>` (a direct child; nested groups carry their
 * own), which is the DOT name of the part. Entities (`&#45;&gt;`) come back
 * decoded by the parser. */
function titleOf(el: Element): string | null {
  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() === 'title') {
      return (child.textContent ?? '').trim();
    }
  }
  return null;
}

/** The text the part shows: every `<text>` under it, in order. A node
 * with no label attribute shows its name; a record label shows its fields. */
function labelOf(el: Element): string {
  return Array.from(el.querySelectorAll('text'))
    .map((text) => text.textContent ?? '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** An edge title is `tail->head` (digraph) or `tail--head` (graph). Split
 * at the FIRST operator: an unquoted DOT id never contains one, and a
 * quoted name that does is not worth a grammar of its own. */
function splitEdgeTitle(title: string): { from: string; to: string } | null {
  const m = /^(.*?)(?:->|--)(.*)$/u.exec(title);
  if (m === null) return null;
  const from = (m[1] ?? '').trim();
  const to = (m[2] ?? '').trim();
  if (from === '' || to === '') return null;
  return { from, to };
}

/**
 * Describe the rendered element under the pointer as a target, or null when
 * it is not one of the three groups (the graph root, the background, a
 * label group). `renderId` is unused: Graphviz ids carry no prefix and the
 * finder never reads them.
 */
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

/**
 * Step (1): the group whose title names the target. Step (2): a node whose
 * label equals the stored label. Null when neither holds.
 */
export function graphvizFindTarget(svg: Element, target: DiagramTarget): Element | null {
  for (const el of svg.querySelectorAll(GRAPHVIZ_TARGET_SELECTOR)) {
    const candidate = graphvizTargetFromElement(svg, el);
    if (candidate !== null && sameTarget(candidate, target)) return el;
  }
  if (target.kind === 'node' && target.label !== '') {
    for (const el of svg.querySelectorAll('g.node')) {
      if (labelOf(el) === target.label) return el;
    }
  }
  return null;
}

/**
 * The 1-based line range that declares the part: DOT statements are one
 * per line in the common case, so a node is the first line that names it
 * as a whole token (its declaration, or the first edge that mentions it),
 * an edge the first line that names both ends, a cluster its `subgraph`
 * line. A quoted name (`"my node"`) matches inside its quotes. Null when
 * the part is not found as a token, which is what a node that exists only
 * in an unsaved draft reads as until it is saved.
 */
export function graphvizSourceLine(source: string, target: DiagramTarget): readonly [number, number] | null {
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
