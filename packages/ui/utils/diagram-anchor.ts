/**
 * The Mermaid anchor codec: the ONE module that owns Mermaid's rendered id
 * grammar. The pure half (types, the wire parser, `sameTarget`, the names,
 * `diagramSourceLine`) lives in `@plannotator/core/diagram-anchor` and is
 * re-exported here so a host imports one module; this file adds the DOM
 * walkers that read a rendered svg.
 *
 * The anchor is the Mermaid id (edges: from and to), never the rendered
 * element id whole (`flowchart-B-3`: the trailing counter moves when nodes
 * are added) and never geometry (ELK and dagre place the same node at
 * different coordinates). Restore order: (1) the element whose id suffix
 * matches the family's pattern for the id, (2) a node whose label text
 * equals the stored label, (3) the source line as a gutter mark in the
 * Source pane (the pane's job, not this file's), (4) none: unanchored but
 * listed. The id patterns below are the ones captured from the real
 * rendered SVG (see HANDOFF.md "Mermaid 12"), byte-identical between
 * 11.17.2 and 12.0.0.
 *
 * Pure: no React, no DOM globals beyond the Element the caller hands in, so
 * the codec runs the same in the browser and in happy-dom over captured SVGs.
 */
import {
  diagramSourceLine,
  sameTarget,
  type DiagramFamily,
  type DiagramTarget,
} from '@plannotator/core/diagram-anchor';

export * from '@plannotator/core/diagram-anchor';

/**
 * The finder seam (the renderer slot pairs one with each engine): everything
 * the viewer needs to know about one engine's rendered id grammar. The
 * mermaid finder is this file; the Graphviz finder is
 * `diagram-anchor-graphviz.ts`. The viewer never branches on the kind itself.
 */
export interface DiagramFinder {
  /** The selector of every element the pointer can address. */
  readonly targetSelector: string;
  /** Describe the rendered element under the pointer, or null when it is
   * not one the engine addresses. */
  targetFromElement(svg: Element, el: Element, renderId: string): DiagramTarget | null;
  /** Restore steps (1) and (2): the element that names the target, else a
   * node whose label equals the stored label; null when neither holds. */
  findTarget(svg: Element, target: DiagramTarget, renderId: string): Element | null;
  /** Restore step (3): the 1-based line range that declares the part in
   * the source text, or null when the part is not found as a token. */
  sourceLine(source: string, target: DiagramTarget): readonly [number, number] | null;
}

/** The family a rendered svg declares (`aria-roledescription`), mapped to the
 * id grammar this file knows. Families without element ids (sequence,
 * gitGraph, pie) are `other`: a comment there is diagram-level. */
export function diagramFamilyOf(svg: Element): DiagramFamily {
  const role = svg.getAttribute('aria-roledescription') ?? '';
  if (role.startsWith('flowchart')) return 'flowchart';
  if (role === 'stateDiagram') return 'state';
  if (role === 'classDiagram') return 'class';
  if (role === 'er') return 'er';
  if (role === 'requirement') return 'requirement';
  return 'other';
}

/** `render(id, …)` prefixes every element id with `${id}-`; the marker
 * defs use `${id}_` and are never targets. */
function idSuffix(elementId: string, renderId: string): string | null {
  const prefix = `${renderId}-`;
  return elementId.startsWith(prefix) ? elementId.slice(prefix.length) : null;
}

function stripCounter(suffix: string): string | null {
  const m = /^(.+)-(\d+)$/u.exec(suffix);
  return m === null ? null : (m[1] ?? null);
}

/** The node ids a rendered flowchart or class diagram declares on its
 * `g.node` elements (`flowchart-{id}-{n}`, `classId-{Name}-{n}`), read once
 * per walk so an edge stem can be split against them. */
export function nodeIdsOf(svg: Element, family: DiagramFamily, renderId: string): ReadonlySet<string> {
  const ids = new Set<string>();
  const pattern =
    family === 'flowchart' ? /^flowchart-(.+)-\d+$/u : family === 'class' ? /^classId-(.+)-\d+$/u : null;
  if (pattern === null) return ids;
  for (const node of svg.querySelectorAll('g.node')) {
    const suffix = idSuffix(node.id, renderId);
    const id = suffix === null ? undefined : pattern.exec(suffix)?.[1];
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/**
 * Split an edge stem `{from}_{to}` where either end may itself carry
 * underscores (`user_login_check_auth` from `user_login --> check_auth`):
 * the split where both halves are node ids the svg declares, longest
 * `from` first; else the split whose `from` is a declared node; else the
 * first underscore (an end the svg does not list, which a rendered edge
 * never has).
 */
export function splitEdgeStem(
  stem: string,
  nodeIds: ReadonlySet<string>,
): { from: string; to: string } | null {
  const candidates: Array<{ from: string; to: string }> = [];
  for (let at = stem.indexOf('_'); at !== -1; at = stem.indexOf('_', at + 1)) {
    if (at > 0 && at < stem.length - 1) {
      candidates.push({ from: stem.slice(0, at), to: stem.slice(at + 1) });
    }
  }
  const longestFrom = (a: { from: string }, b: { from: string }) => b.from.length - a.from.length;
  const both = candidates.filter((c) => nodeIds.has(c.from) && nodeIds.has(c.to)).sort(longestFrom)[0];
  if (both !== undefined) return both;
  const fromOnly = candidates.filter((c) => nodeIds.has(c.from)).sort(longestFrom)[0];
  if (fromOnly !== undefined) return fromOnly;
  return candidates[0] ?? null;
}

/** The label a rendered part shows: the htmlLabels span, else the svg text. */
function partLabel(el: Element): string {
  const span = el.querySelector('.nodeLabel, .label');
  const text = (span ?? el.querySelector('text'))?.textContent ?? '';
  return text.replace(/\s+/gu, ' ').trim();
}

/** The edge label Mermaid renders in a sibling group keyed by the edge's
 * element id (`g.edgeLabels > g.edgeLabel > g.label[data-id]`; the
 * `data-id` sits on the inner `g.label`), empty when the edge has none. */
function edgeLabel(svg: Element, elementSuffix: string): string {
  const group = svg.querySelector(`.label[data-id="${cssEscape(elementSuffix)}"]`);
  return group === null ? '' : (group.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/gu, '\\$&');
}

/** The selector of every element the pointer can address. */
export const DIAGRAM_TARGET_SELECTOR =
  'g.node, g.cluster, g.statediagram-cluster, path.flowchart-link, path.transition, path.relation, path.relationshipLine';

/**
 * Describe the rendered element under the pointer as a target, or null when
 * the element is not one this family addresses (a marker, a label group, a
 * pseudo-state, the background). The caller hands the nearest ancestor that
 * matches DIAGRAM_TARGET_SELECTOR.
 */
export function targetFromElement(
  svg: Element,
  el: Element,
  renderId: string,
  /** The family's declared node ids, when the caller walks many elements
   * (findDiagramTarget); read from the svg otherwise. */
  nodeIds?: ReadonlySet<string>,
): DiagramTarget | null {
  const family = diagramFamilyOf(svg);
  const suffix = idSuffix(el.id, renderId);
  if (suffix === null) return null;
  const isPath = el.tagName.toLowerCase() === 'path';
  const declared = () => nodeIds ?? nodeIdsOf(svg, family, renderId);
  switch (family) {
    case 'flowchart': {
      if (isPath) {
        const stem = /^(L_.+)_\d+$/u.exec(suffix)?.[1];
        if (stem === undefined) return null;
        const pair = splitEdgeStem(stem.slice(2), declared());
        if (pair === null) return null;
        return { family, kind: 'edge', ...pair, label: edgeLabel(svg, suffix) };
      }
      if (el.classList.contains('cluster')) {
        return { family, kind: 'cluster', id: suffix, label: partLabel(el) };
      }
      const node = /^flowchart-(.+)-\d+$/u.exec(suffix)?.[1];
      if (node === undefined) return null;
      return { family, kind: 'node', id: node, label: partLabel(el) };
    }
    case 'state': {
      if (isPath) {
        if (!/^edge\d+$/u.test(suffix)) return null;
        return { family, kind: 'edge', id: suffix, label: edgeLabel(svg, suffix) };
      }
      const state = /^state-(.+)-\d+$/u.exec(suffix)?.[1];
      if (state === undefined || /_(?:start|end)$/u.test(state)) return null;
      return { family, kind: 'node', id: state, label: partLabel(el) };
    }
    case 'class': {
      if (isPath) {
        const stem = /^id_(.+)_\d+$/u.exec(suffix)?.[1];
        if (stem === undefined) return null;
        const pair = splitEdgeStem(stem, declared());
        if (pair === null) return null;
        return { family, kind: 'edge', ...pair, label: edgeLabel(svg, suffix) };
      }
      const name = /^classId-(.+)-\d+$/u.exec(suffix)?.[1];
      if (name === undefined) return null;
      return { family, kind: 'node', id: name, label: partLabel(el) };
    }
    case 'er': {
      if (isPath) {
        const m = /^id_entity-(.+)-\d+_entity-(.+)-\d+_\d+$/u.exec(suffix);
        if (m === null) return null;
        return { family, kind: 'edge', from: m[1] ?? '', to: m[2] ?? '', label: edgeLabel(svg, suffix) };
      }
      const entity = /^entity-(.+)-\d+$/u.exec(suffix)?.[1];
      if (entity === undefined) return null;
      return { family, kind: 'node', id: entity, label: partLabel(el) };
    }
    case 'requirement': {
      if (isPath) {
        const stem = stripCounter(suffix);
        if (stem === null) return null;
        return { family, kind: 'edge', id: stem, label: edgeLabel(svg, suffix) };
      }
      if (!el.classList.contains('node')) return null;
      return { family, kind: 'node', id: suffix, label: partLabel(el) };
    }
    case 'other':
    // A Graphviz svg never reaches this codec: its finder is
    // diagram-anchor-graphviz.ts, paired by the renderer slot.
    case 'graphviz':
      return null;
  }
}

/**
 * Step (1): the element whose id suffix names the target. Step (2): a node
 * whose label equals the stored label. Null when neither holds; the caller
 * treats that as unanchored (the gutter mark from `sourceLine` is the
 * Source pane's concern).
 */
export function findDiagramTarget(svg: Element, target: DiagramTarget, renderId: string): Element | null {
  const nodeIds = nodeIdsOf(svg, diagramFamilyOf(svg), renderId);
  for (const el of svg.querySelectorAll(DIAGRAM_TARGET_SELECTOR)) {
    const candidate = targetFromElement(svg, el, renderId, nodeIds);
    if (candidate !== null && sameTarget(candidate, target)) return el;
  }
  if (target.kind === 'node' && target.label !== '') {
    for (const el of svg.querySelectorAll('g.node')) {
      if (partLabel(el) === target.label) return el;
    }
  }
  return null;
}

/** The mermaid finder: this file's grammar behind the seam. */
export const MERMAID_FINDER: DiagramFinder = {
  targetSelector: DIAGRAM_TARGET_SELECTOR,
  targetFromElement: (svg, el, renderId) => targetFromElement(svg, el, renderId),
  findTarget: findDiagramTarget,
  sourceLine: diagramSourceLine,
};
