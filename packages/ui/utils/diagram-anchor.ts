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
  if (role === 'sequence') return 'sequence';
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

/** The sequence family's addressable elements. Mermaid gives them classes,
 * never ids: actor boxes and lifelines carry the actor's `name`, a message
 * is its text plus its line, a note its rect plus its text, a loop / alt /
 * opt frame the group that holds its `loopLine`s and its label. */
const SEQUENCE_TARGET_SELECTOR =
  'rect.actor, text.actor, line.actor-line, text.messageText, line.messageLine0, line.messageLine1, path.messageLine0, path.messageLine1, rect.note, text.noteText, line.loopLine, polygon.labelBox, text.labelText, text.loopText';

/** The selector of every element the pointer can address. An edge LABEL is
 * one too: it is painted over its edge and is where a person clicks an edge,
 * so it resolves to that edge. */
export const DIAGRAM_TARGET_SELECTOR = `g.node, g.cluster, g.statediagram-cluster, path.flowchart-link, path.transition, path.relation, path.relationshipLine, g.edgeLabel, ${SEQUENCE_TARGET_SELECTOR}`;

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

function sequenceMessageLines(svg: Element): Element[] {
  return Array.from(svg.querySelectorAll('.messageLine0, .messageLine1'));
}

/** The frames of a sequence diagram: the distinct groups that hold
 * `loopLine`s, in document order. */
function sequenceFrames(svg: Element): Element[] {
  const frames: Element[] = [];
  for (const line of Array.from(svg.querySelectorAll('line.loopLine'))) {
    const group = line.parentElement;
    if (group !== null && !frames.includes(group)) frames.push(group);
  }
  return frames;
}

function sequenceActorLabel(svg: Element, name: string): string {
  for (const rect of Array.from(svg.querySelectorAll('rect.actor'))) {
    if (rect.getAttribute('name') !== name) continue;
    const text = rect.parentElement?.querySelector('text.actor');
    if (text) return cleanText(text.textContent);
  }
  return name;
}

function sequenceMessageTarget(svg: Element, index: number): DiagramTarget | null {
  const lines = sequenceMessageLines(svg);
  const line = lines[index];
  if (line === undefined) return null;
  const texts = Array.from(svg.querySelectorAll('text.messageText'));
  // Texts and lines pair by document order; when the counts differ (a
  // renderer that splits a message text) the label is left empty rather
  // than guessed.
  const label = texts.length === lines.length ? cleanText(texts[index]?.textContent) : '';
  const from = line.getAttribute('data-from');
  const to = line.getAttribute('data-to');
  return {
    family: 'sequence',
    kind: 'edge',
    id: `msg-${index + 1}`,
    ...(from !== null && to !== null ? { from, to } : {}),
    label,
  };
}

function sequenceTargetFromElement(svg: Element, el: Element): DiagramTarget | null {
  const cl = el.classList;
  if (cl.contains('actor') || cl.contains('actor-line')) {
    const name = el.getAttribute('name') ?? el.parentElement?.querySelector('rect.actor[name]')?.getAttribute('name') ?? null;
    if (name === null || name === '') return null;
    return { family: 'sequence', kind: 'node', id: name, label: sequenceActorLabel(svg, name) };
  }
  if (cl.contains('messageText')) {
    const texts = Array.from(svg.querySelectorAll('text.messageText'));
    if (texts.length !== sequenceMessageLines(svg).length) return null;
    return sequenceMessageTarget(svg, texts.indexOf(el));
  }
  if (cl.contains('messageLine0') || cl.contains('messageLine1')) {
    return sequenceMessageTarget(svg, sequenceMessageLines(svg).indexOf(el));
  }
  if (cl.contains('note') || cl.contains('noteText')) {
    const group = el.parentElement;
    const notes = Array.from(svg.querySelectorAll('rect.note'));
    const index = notes.findIndex((note) => note === el || note.parentElement === group);
    if (index === -1) return null;
    return { family: 'sequence', kind: 'node', id: `note-${index + 1}`, label: cleanText(group?.querySelector('text.noteText')?.textContent) };
  }
  if (cl.contains('loopLine') || cl.contains('labelBox') || cl.contains('labelText') || cl.contains('loopText')) {
    const index = sequenceFrames(svg).indexOf(el.parentElement as Element);
    if (index === -1) return null;
    const group = el.parentElement;
    const label = cleanText(`${group?.querySelector('text.labelText')?.textContent ?? ''} ${group?.querySelector('text.loopText')?.textContent ?? ''}`);
    return { family: 'sequence', kind: 'cluster', id: `frame-${index + 1}`, label };
  }
  return null;
}

/** The element that stands for a sequence part by its id alone. */
function sequenceElementById(svg: Element, target: DiagramTarget): Element | null {
  if (target.id === undefined) return null;
  const ordinal = /^(msg|note|frame)-(\d+)$/u.exec(target.id);
  if (ordinal === null) {
    if (target.kind !== 'node') return null;
    const rects = Array.from(svg.querySelectorAll('rect.actor')).filter((rect) => rect.getAttribute('name') === target.id);
    return rects.find((rect) => rect.classList.contains('actor-top')) ?? rects[0] ?? null;
  }
  const index = Number(ordinal[2]) - 1;
  if (ordinal[1] === 'msg') return target.kind === 'edge' ? (sequenceMessageLines(svg)[index] ?? null) : null;
  if (ordinal[1] === 'note') return target.kind === 'node' ? (svg.querySelectorAll('rect.note')[index] ?? null) : null;
  return target.kind === 'cluster' ? (sequenceFrames(svg)[index] ?? null) : null;
}

/**
 * Sequence restore. Actors restore by name. Messages, notes and frames have
 * only ordinals for ids, and an ordinal moves when a statement is inserted
 * above it, so the label is checked too: the part at the ordinal when its
 * label still matches, else the ONE part that carries the stored label,
 * else the part at the ordinal (its text was edited in place).
 */
function findSequenceTarget(svg: Element, target: DiagramTarget): Element | null {
  const byId = sequenceElementById(svg, target);
  const isOrdinal = target.id !== undefined && /^(msg|note|frame)-\d+$/u.test(target.id);
  if (!isOrdinal) {
    if (byId !== null) return byId;
    if (target.kind !== 'node' || target.label === '') return null;
    const named = Array.from(svg.querySelectorAll('rect.actor.actor-top, rect.actor')).filter(
      (rect) => sequenceActorLabel(svg, rect.getAttribute('name') ?? '') === target.label,
    );
    const names = new Set(named.map((rect) => rect.getAttribute('name')));
    return names.size === 1 ? (named.find((rect) => rect.classList.contains('actor-top')) ?? named[0] ?? null) : null;
  }
  const labelOf = (el: Element): string => sequenceTargetFromElement(svg, el.matches('g') ? (el.querySelector('line.loopLine') ?? el) : el)?.label ?? '';
  if (byId !== null && (target.label === '' || labelOf(byId) === target.label)) return byId;
  if (target.label !== '') {
    const pool =
      target.kind === 'edge' ? sequenceMessageLines(svg) : target.kind === 'node' ? Array.from(svg.querySelectorAll('rect.note')) : sequenceFrames(svg);
    const matches = pool.filter((el) => labelOf(el) === target.label);
    if (matches.length === 1) return matches[0] ?? null;
  }
  return byId;
}

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
  if (family === 'sequence') return sequenceTargetFromElement(svg, el);
  if (el.classList.contains('edgeLabel')) {
    // An edge label names its edge through `data-id` (the edge's element
    // id without the render prefix); it IS that edge to the pointer.
    const dataId = (el.matches('[data-id]') ? el : el.querySelector('[data-id]'))?.getAttribute('data-id') ?? null;
    if (dataId === null) return null;
    const edge = svg.querySelector(`[id="${cssEscape(`${renderId}-${dataId}`)}"]`);
    return edge === null || edge === el ? null : targetFromElement(svg, edge, renderId, nodeIds);
  }
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
    // (`sequence` returned above: its parts carry classes, not ids.)
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
  if (target.kind === 'diagram') return svg;
  const family = diagramFamilyOf(svg);
  if (family === 'sequence') return findSequenceTarget(svg, target);
  const nodeIds = nodeIdsOf(svg, family, renderId);
  for (const el of Array.from(svg.querySelectorAll(DIAGRAM_TARGET_SELECTOR))) {
    // A label resolves to its edge; the edge itself is the element.
    if (el.classList.contains('edgeLabel')) continue;
    const candidate = targetFromElement(svg, el, renderId, nodeIds);
    if (candidate !== null && sameTarget(candidate, target)) return el;
  }
  if (target.kind === 'node' && target.label !== '') {
    // Step (2) holds only while the label names ONE node: with two nodes
    // carrying it, the first match is a coin toss onto the wrong node, so
    // the restore falls through to the source line instead.
    const matches = Array.from(svg.querySelectorAll('g.node')).filter((el) => partLabel(el) === target.label);
    if (matches.length === 1) return matches[0] ?? null;
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
