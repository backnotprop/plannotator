import { diagramSourceLine, sameTarget, type DiagramTarget } from '@plannotator/core/diagram-anchor';
import { diagramFamilyOf, MERMAID_FINDER, splitEdgeStem, type DiagramFinder } from './diagram-anchor';

/**
 * The Pele finder: Pele 1.3.0's svg grammar behind the same seam as the
 * Mermaid finder (`diagram-anchor.ts`). Pele does not write Mermaid's element
 * ids; it puts a stable `data-id` on the parts of every type this finder
 * addresses. For each type the target it builds is the one the Mermaid
 * finder builds for the same source (same kind, id or ends, label), so a
 * comment made under one engine restores under the other:
 *
 * - flowchart: node / subgraph / edge by Mermaid id and ends;
 * - sequence: actor by name, message `msg-<n>` (its ends read from where its
 *   line starts and stops: a lifeline, an activation bar's edge, a created
 *   actor's box), note `note-<n>`, frame `frame-<n>`, numbered as
 *   Mermaid numbers them;
 * - state: state and composite as `node`, transition `edge<n>`, note;
 * - class: class by name, relation by its ends;
 * - er: entity by name, relationship by its ends;
 * - requirement: requirement or element by name, relationship `{a}-{b}`.
 *
 * Where Mermaid's label is not the part's text (a requirement's stereotype
 * line, a class's annotation), the label here is the part's name, which the
 * Mermaid finder also reads now.
 */
// One string literal, not a joined array: a module-level call is kept by a
// bundler as a possible side effect, so a build with Pele out of it
// (`PELE_IN_BUILD`) would still carry it.
export const PELE_TARGET_SELECTOR =
  'g.pele-node[data-id], g.pele-cluster[data-id], g.pele-edge[data-id], g.pele-edge-label[data-id], ' +
  'g.pele-note[data-id], path.pele-lifeline[data-id], g.pele-frame';

function isPele(svg: Element): boolean {
  return svg.classList.contains('pele');
}

function peleRole(svg: Element): string | null {
  return Array.from(svg.classList).find((name) => name.startsWith('pele-'))?.slice(5) ?? null;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

/** Where the label step (`pele-labels.ts`, `PELE_TEX_ATTR`) keeps a formula's TeX: the line or gap it was drawn in. */
const TEX_ATTR = 'data-pele-tex';

/**
 * The words an element draws, as the source has them: a formula as
 * `$$tex$$` (its MathML box is skipped), a line (a positioned `tspan`)
 * joined to the one before by `lineJoin`, the styled runs inside a line
 * joined to it as they are drawn, and the outline copy Pele draws under a
 * cluster title read once (not at all).
 */
export function peleLabelText(el: Element | null | undefined, lineJoin: string): string {
  if (el === null || el === undefined) return '';
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.localName.toLowerCase() === 'foreignobject' && element.hasAttribute(TEX_ATTR)) return;
    if (element.localName === 'text' && element.getAttribute('fill') === 'none' && element.hasAttribute('stroke')) return;
    if (element.localName === 'tspan' && element.hasAttribute('y') && out !== '') out += lineJoin;
    const tex = element.getAttribute(TEX_ATTR);
    if (tex !== null) {
      out += ` $$${tex}$$ `;
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(el);
  return cleanText(out.replace(/\u200b/gu, ''));
}

function labelOf(el: Element): string {
  return peleLabelText(el, '');
}

/** A text's words: its lines joined by a space, never run together. */
function textOf(el: Element | null | undefined): string {
  return peleLabelText(el, ' ');
}

/** A part's name: its own `.pele-label` text. */
function nameOf(el: Element): string {
  return textOf(el.querySelector(':scope > .pele-label'));
}

function byDataId(svg: Element, selector: string, id: string): Element | null {
  return Array.from(svg.querySelectorAll(selector)).find((candidate) => candidate.getAttribute('data-id') === id) ?? null;
}

function edgeLabelText(svg: Element, id: string): string {
  return textOf(byDataId(svg, 'g.pele-edge-label[data-id]', id)?.querySelector('text'));
}

function nodeIds(svg: Element): ReadonlySet<string> {
  return new Set(Array.from(svg.querySelectorAll('g.pele-node[data-id]'), (node) => node.getAttribute('data-id') ?? ''));
}

// ---------------------------------------------------------------- flowchart

function flowchartTarget(svg: Element, el: Element, id: string): DiagramTarget | null {
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
  const edgeLabel = byDataId(svg, '.pele-edge-label[data-id]', id);
  return { family: 'flowchart', kind: 'edge', ...ends, label: labelOf(edgeLabel ?? el) };
}

// ------------------------------------------------------------------ sequence

/** The statement number Pele writes on a message or note (`i<n>`). */
function statementIndex(el: Element): number {
  const n = /^i(\d+)$/u.exec(el.getAttribute('data-id') ?? '')?.[1];
  return n === undefined ? Number.MAX_SAFE_INTEGER : Number(n);
}

/** Messages or notes in source order: by the statement number Pele writes. */
function inStatementOrder(svg: Element, selector: string): Element[] {
  return Array.from(svg.querySelectorAll(selector)).sort((a, b) => statementIndex(a) - statementIndex(b));
}

const sequenceMessages = (svg: Element): Element[] => inStatementOrder(svg, 'g.pele-edge.pele-message[data-id]');
const sequenceNotes = (svg: Element): Element[] => inStatementOrder(svg, 'g.pele-note[data-id]');
/** Frames in the order both engines draw them: a frame is drawn at its `end`, so a nested frame comes before the one around it. */
const sequenceFrames = (svg: Element): Element[] => Array.from(svg.querySelectorAll('g.pele-frame'));

function sequenceActorLabel(svg: Element, name: string): string {
  const actor = byDataId(svg, 'g.pele-actor[data-id]', name);
  return actor === null ? name : nameOf(actor);
}

interface Lifeline {
  readonly name: string;
  readonly x: number;
  /** Where the lifeline starts: below its actor's box, which for a `create`d actor is level with the message that creates it. */
  readonly top: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Each lifeline (`M{x},{y}V…`), by actor name. */
function lifelines(svg: Element): readonly Lifeline[] {
  return Array.from(svg.querySelectorAll('path.pele-lifeline[data-id]')).flatMap((line) => {
    const m = /^\s*M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/u.exec(line.getAttribute('d') ?? '');
    const name = line.getAttribute('data-id');
    return m === null || name === null ? [] : [{ name, x: Number(m[1]), top: Number(m[2]) }];
  });
}

/** Every point an absolute svg path visits, in order (Pele writes absolute commands only); null for anything else. */
function pathPoints(d: string): Point[] | null {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gu) ?? [];
  // Arguments per segment, and which of them are the segment's end x and y (-1: unchanged).
  const shape: Readonly<Record<string, readonly [number, number, number]>> = {
    M: [2, 0, 1],
    L: [2, 0, 1],
    T: [2, 0, 1],
    H: [1, 0, -1],
    V: [1, -1, 0],
    C: [6, 4, 5],
    S: [4, 2, 3],
    Q: [4, 2, 3],
    A: [7, 5, 6],
  };
  const points: Point[] = [];
  let x = 0;
  let y = 0;
  let command = '';
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i] ?? '';
    if (/^[A-Za-z]$/u.test(token)) {
      command = token;
      i += 1;
      if (command === 'Z' && points[0] !== undefined) points.push(points[0]);
      continue;
    }
    const spec = shape[command];
    if (spec === undefined) return null;
    const args = tokens.slice(i, i + spec[0]).map(Number);
    if (args.length < spec[0] || args.some((n) => Number.isNaN(n))) return null;
    if (spec[1] >= 0) x = args[spec[1]] ?? x;
    if (spec[2] >= 0) y = args[spec[2]] ?? y;
    points.push({ x, y });
    i += spec[0];
  }
  return points;
}

/** The actor whose lifeline is nearest to `x`, when one is clearly nearest (by 8 px) and within `limit`. */
function nearestLifeline(lines: readonly Lifeline[], x: number, limit: number): string | null {
  const sorted = [...lines].sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
  const nearest = sorted[0];
  if (nearest === undefined) return null;
  const distance = Math.abs(nearest.x - x);
  const runnerUp = sorted[1];
  if (distance > limit || (runnerUp !== undefined && Math.abs(runnerUp.x - x) - distance < 8)) return null;
  return nearest.name;
}

/** An arrowhead's length past the edge a line points at, and some rounding. */
const EDGE_REACH = 10;

const numberAttr = (el: Element, name: string): number => Number(el.getAttribute(name) ?? Number.NaN);

/** The actor whose activation bar a point sits on the edge of: a line from or
 * to a nested activation starts or stops at its innermost bar, ~5 px further
 * off the lifeline per level. Null when no bar, or bars of two actors, are there. */
function activationAt(svg: Element, p: Point): string | null {
  const names = new Set<string>();
  for (const bar of Array.from(svg.querySelectorAll('rect.pele-activation[data-id]'))) {
    const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) => numberAttr(bar, name)) as [number, number, number, number];
    if ([x, y, width, height].some((n) => Number.isNaN(n))) continue;
    if (p.y < y || p.y > y + height || p.x < x - EDGE_REACH || p.x > x + width + EDGE_REACH) continue;
    names.add(bar.getAttribute('data-id') ?? '');
  }
  const [name] = [...names];
  return names.size === 1 && name !== undefined && name !== '' ? name : null;
}

/** How far down an actor's box (or stick figure and its name) reaches. */
function verticalSpan(actor: Element): { top: number; bottom: number } | null {
  const ys: number[] = [];
  for (const el of Array.from(actor.querySelectorAll('rect, circle, path, text'))) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'rect') ys.push(numberAttr(el, 'y'), numberAttr(el, 'y') + numberAttr(el, 'height'));
    else if (tag === 'circle') ys.push(numberAttr(el, 'cy') - numberAttr(el, 'r'), numberAttr(el, 'cy') + numberAttr(el, 'r'));
    else if (tag === 'text') ys.push(numberAttr(el, 'y') - 16, numberAttr(el, 'y') + 4);
    else for (const point of pathPoints(el.getAttribute('d') ?? '') ?? []) ys.push(point.y);
  }
  const known = ys.filter((n) => !Number.isNaN(n));
  return known.length === 0 ? null : { top: Math.min(...known), bottom: Math.max(...known) };
}

/** The `create`d actor a point is level with: its box is drawn where the
 * message that creates it is, above its lifeline, and the line stops at the
 * box. The one such actor, when the point is also nearer its lifeline than
 * any other's. */
function createdActorAt(svg: Element, lines: readonly Lifeline[], p: Point): string | null {
  const level = Array.from(svg.querySelectorAll('g.pele-actor[data-id]:not(.pele-actor-footer)')).filter((actor) => {
    const line = lines.find((candidate) => candidate.name === actor.getAttribute('data-id'));
    if (line === undefined || line.top <= p.y) return false;
    const span = verticalSpan(actor);
    return span !== null && p.y >= span.top && p.y <= span.bottom;
  });
  const name = level.length === 1 ? level[0]?.getAttribute('data-id') : null;
  if (name === null || name === undefined) return null;
  return nearestLifeline(lines, p.x, Number.POSITIVE_INFINITY) === name ? name : null;
}

/** The actor a message line starts or stops at: its lifeline (an arrowhead
 * moves the end a few px off it), the edge of its activation bar, or the box
 * of an actor the message creates. Two readings that disagree, or a point
 * none of them names, name no actor: the message then has no ends, as
 * before, rather than wrong ones. */
function actorAtEnd(svg: Element, lines: readonly Lifeline[], p: Point): string | null {
  const byLifeline = nearestLifeline(lines, p.x, 24);
  const byBar = activationAt(svg, p);
  if (byLifeline !== null && byBar !== null) return byLifeline === byBar ? byLifeline : null;
  return byLifeline ?? byBar ?? createdActorAt(svg, lines, p);
}

function sequenceMessageTarget(svg: Element, index: number): DiagramTarget | null {
  const message = sequenceMessages(svg)[index];
  if (message === undefined) return null;
  const id = message.getAttribute('data-id') ?? '';
  const line = message.querySelector('path:not(.pele-marker)');
  const points = line === null ? null : pathPoints(line.getAttribute('d') ?? '');
  const first = points?.[0];
  const last = points?.[points.length - 1];
  const lines = lifelines(svg);
  const from = first === undefined ? null : actorAtEnd(svg, lines, first);
  const to = last === undefined ? null : actorAtEnd(svg, lines, last);
  return {
    family: 'sequence',
    kind: 'edge',
    id: `msg-${index + 1}`,
    ...(from !== null && to !== null ? { from, to } : {}),
    label: edgeLabelText(svg, id),
  };
}

function sequenceTarget(svg: Element, el: Element): DiagramTarget | null {
  const cl = el.classList;
  if (cl.contains('pele-actor') || cl.contains('pele-lifeline')) {
    const name = el.getAttribute('data-id');
    if (name === null || name === '') return null;
    return { family: 'sequence', kind: 'node', id: name, label: sequenceActorLabel(svg, name) };
  }
  if (cl.contains('pele-message') || cl.contains('pele-edge-label')) {
    const message = cl.contains('pele-message') ? el : byDataId(svg, 'g.pele-edge.pele-message[data-id]', el.getAttribute('data-id') ?? '');
    if (message === null) return null;
    return sequenceMessageTarget(svg, sequenceMessages(svg).indexOf(message));
  }
  if (cl.contains('pele-note')) {
    const index = sequenceNotes(svg).indexOf(el);
    if (index === -1) return null;
    return { family: 'sequence', kind: 'node', id: `note-${index + 1}`, label: nameOf(el) };
  }
  if (cl.contains('pele-frame')) {
    const index = sequenceFrames(svg).indexOf(el);
    if (index === -1) return null;
    // `alt [ok]`: the kind and the label beside it (an `else` label sits lower in the same group).
    const kind = el.querySelector(':scope > .pele-frame-kind');
    const next = kind?.nextElementSibling;
    const label = next?.classList.contains('pele-frame-label') === true ? textOf(next) : '';
    return { family: 'sequence', kind: 'cluster', id: `frame-${index + 1}`, label: cleanText(`${textOf(kind)} ${label}`) };
  }
  return null;
}

/** The ONE element that stands for a sequence part by its id alone. */
function sequenceElementById(svg: Element, target: DiagramTarget): Element | null {
  if (target.id === undefined) return null;
  const ordinal = /^(msg|note|frame)-(\d+)$/u.exec(target.id);
  if (ordinal === null) {
    if (target.kind !== 'node') return null;
    const actors = Array.from(svg.querySelectorAll('g.pele-actor[data-id]')).filter((actor) => actor.getAttribute('data-id') === target.id);
    return actors.find((actor) => !actor.classList.contains('pele-actor-footer')) ?? actors[0] ?? null;
  }
  const index = Number(ordinal[2]) - 1;
  if (ordinal[1] === 'msg') return target.kind === 'edge' ? (sequenceMessages(svg)[index] ?? null) : null;
  if (ordinal[1] === 'note') return target.kind === 'node' ? (sequenceNotes(svg)[index] ?? null) : null;
  return target.kind === 'cluster' ? (sequenceFrames(svg)[index] ?? null) : null;
}

/** The Mermaid finder's sequence restore, over Pele's parts: an actor by
 * name, else the one actor with the stored label; a message, note or frame
 * at its ordinal while its label still matches, else the ONE part with the
 * stored label, else the part at the ordinal (its text was edited). */
function findSequenceTarget(svg: Element, target: DiagramTarget): Element | null {
  const byId = sequenceElementById(svg, target);
  const isOrdinal = target.id !== undefined && /^(msg|note|frame)-\d+$/u.test(target.id);
  if (!isOrdinal) {
    if (byId !== null) return byId;
    if (target.kind !== 'node' || target.label === '') return null;
    const named = Array.from(svg.querySelectorAll('g.pele-actor[data-id]:not(.pele-actor-footer)')).filter((actor) => nameOf(actor) === target.label);
    return named.length === 1 ? (named[0] ?? null) : null;
  }
  const label = (el: Element): string => sequenceTarget(svg, el)?.label ?? '';
  if (byId !== null && (target.label === '' || label(byId) === target.label)) return byId;
  if (target.label !== '') {
    const pool = target.kind === 'edge' ? sequenceMessages(svg) : target.kind === 'node' ? sequenceNotes(svg) : sequenceFrames(svg);
    const matches = pool.filter((el) => label(el) === target.label);
    if (matches.length === 1) return matches[0] ?? null;
  }
  return byId;
}

// ------------------------------------------- state, class, er, requirement

/** Requirement relationship labels are stereotypes; Mermaid writes them `<<satisfies>>`, Pele `«satisfies»`. */
function requirementEdgeLabel(text: string): string {
  const stereotype = /^«(.*)»$/u.exec(text);
  return stereotype === null ? text : `<<${stereotype[1] ?? ''}>>`;
}

function stateTarget(svg: Element, el: Element, id: string): DiagramTarget | null {
  const cl = el.classList;
  if (cl.contains('pele-edge')) {
    // A note's dashed connector is not a transition; Mermaid offers none either.
    if (!cl.contains('pele-transition') || !/^edge\d+$/u.test(id)) return null;
    return { family: 'state', kind: 'edge', id, label: edgeLabelText(svg, id) };
  }
  if (cl.contains('pele-cluster')) {
    // Mermaid addresses a composite state as a node (its `state-{id}-{n}` group).
    return { family: 'state', kind: 'node', id, label: textOf(el.querySelector(':scope > .pele-cluster-label')) };
  }
  if (cl.contains('pele-note')) {
    const note = /^(.+)-\d+$/u.exec(id)?.[1];
    return note === undefined ? null : { family: 'state', kind: 'node', id: note, label: nameOf(el) };
  }
  if (!cl.contains('pele-node')) return null;
  if (cl.contains('pele-state-start') || cl.contains('pele-state-end') || /_(?:start|end)$/u.test(id)) return null;
  return { family: 'state', kind: 'node', id, label: nameOf(el) };
}

function edgeOrNodeTarget(svg: Element, el: Element, role: string, id: string): DiagramTarget | null {
  const cl = el.classList;
  if (role === 'state') return stateTarget(svg, el, id);
  if (role === 'class') {
    if (cl.contains('pele-edge')) {
      if (!cl.contains('pele-relation')) return null;
      const stem = /^id_(.+)_\d+$/u.exec(id)?.[1];
      const ends = stem === undefined ? null : splitEdgeStem(stem, classNames(svg));
      return ends === null ? null : { family: 'class', kind: 'edge', ...ends, label: edgeLabelText(svg, id) };
    }
    if (!cl.contains('pele-node') || !cl.contains('pele-class')) return null;
    return { family: 'class', kind: 'node', id, label: nameOf(el) };
  }
  if (role === 'er') {
    if (cl.contains('pele-edge')) {
      const m = /^id_entity-(.+)-\d+_entity-(.+)-\d+_\d+$/u.exec(id);
      return m === null ? null : { family: 'er', kind: 'edge', from: m[1] ?? '', to: m[2] ?? '', label: edgeLabelText(svg, id) };
    }
    if (!cl.contains('pele-node') || !cl.contains('pele-entity')) return null;
    return { family: 'er', kind: 'node', id, label: nameOf(el) };
  }
  if (role === 'requirement') {
    if (cl.contains('pele-edge')) {
      const stem = /^(.+)-\d+$/u.exec(id)?.[1];
      return stem === undefined ? null : { family: 'requirement', kind: 'edge', id: stem, label: requirementEdgeLabel(edgeLabelText(svg, id)) };
    }
    if (!cl.contains('pele-node') || !(cl.contains('pele-requirement') || cl.contains('pele-element'))) return null;
    return { family: 'requirement', kind: 'node', id, label: nameOf(el) };
  }
  return null;
}

function classNames(svg: Element): ReadonlySet<string> {
  return new Set(Array.from(svg.querySelectorAll('g.pele-node.pele-class[data-id]'), (node) => node.getAttribute('data-id') ?? ''));
}

/** The part an element draws, before the duplicate check. */
function rawTarget(svg: Element, el: Element): DiagramTarget | null {
  if (!isPele(svg)) return null;
  const role = peleRole(svg);
  if (role === 'sequence') return sequenceTarget(svg, el);
  if (el.classList.contains('pele-frame')) return null;
  const id = el.getAttribute('data-id');
  if (id === null || id === '') return null;
  if (el.classList.contains('pele-edge-label')) {
    const edge = byDataId(svg, 'g.pele-edge[data-id]', id);
    return edge === null ? null : rawTarget(svg, edge);
  }
  if (role === 'flowchart') return flowchartTarget(svg, el, id);
  if (role === null) return null;
  return edgeOrNodeTarget(svg, el, role, id);
}

/** Every element that stands for the same part as `target` (an edge label resolves to its edge). */
function matchingParts(svg: Element, target: DiagramTarget): Element[] {
  return Array.from(svg.querySelectorAll('g.pele-node[data-id], g.pele-cluster[data-id], g.pele-edge[data-id], g.pele-note[data-id]')).filter((el) => {
    const candidate = rawTarget(svg, el);
    return candidate !== null && sameTarget(candidate, target);
  });
}

/** Two relationships with the same ends (`User --> Order` twice) share one
 * identity; the label tells them apart. The part an element draws, or null
 * when nothing does: two parts with the same identity AND the same label
 * cannot be told apart after a reload, so neither is offered. */
function peleTargetFromElement(svg: Element, el: Element): DiagramTarget | null {
  const target = rawTarget(svg, el);
  if (target === null || target.kind !== 'edge' || peleRole(svg) === 'sequence' || peleRole(svg) === 'flowchart') return target;
  const twins = matchingParts(svg, target).filter((part) => rawTarget(svg, part)?.label === target.label);
  return twins.length === 1 ? target : null;
}

function peleFindTarget(svg: Element, target: DiagramTarget): Element | null {
  if (!isPele(svg)) return null;
  // Every Pele type supports a whole-diagram comment, even when no parts
  // have a codec. Restore it before narrowing to the addressed types.
  if (target.kind === 'diagram') return svg;
  const family = diagramFamilyOf(svg);
  if (family === 'other' || target.family !== family) return null;
  if (family === 'sequence') return findSequenceTarget(svg, target);
  const matches = matchingParts(svg, target);
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1) {
    // The same ends twice: the ONE whose label is the stored label, else none.
    const labelled = matches.filter((el) => rawTarget(svg, el)?.label === target.label);
    return labelled.length === 1 ? (labelled[0] ?? null) : null;
  }
  if (target.kind !== 'node' || target.label === '') return null;
  // The id is gone (renamed): the ONE node that still carries the label.
  const byLabel = Array.from(svg.querySelectorAll('g.pele-node[data-id], g.pele-cluster[data-id], g.pele-note[data-id]')).filter((el) => {
    const candidate = rawTarget(svg, el);
    return candidate !== null && candidate.kind === 'node' && candidate.label === target.label;
  });
  return byLabel.length === 1 ? (byLabel[0] ?? null) : null;
}

/** Pele 1.3.0's codec for flowchart, sequence, state, class, ER and
 * requirement diagrams; every other Pele type is a whole-diagram comment. */
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
  // A getter: read at module load, `MERMAID_FINDER.targetSelector` is a
  // property read a bundler keeps even where this finder is dropped.
  get targetSelector() {
    return `${PELE_TARGET_SELECTOR}, ${MERMAID_FINDER.targetSelector}`;
  },
  targetFromElement(svg, el, renderId) {
    return isPele(svg) ? PELE_FINDER.targetFromElement(svg, el, renderId) : MERMAID_FINDER.targetFromElement(svg, el, renderId);
  },
  findTarget(svg, target, renderId) {
    return isPele(svg) ? PELE_FINDER.findTarget(svg, target, renderId) : MERMAID_FINDER.findTarget(svg, target, renderId);
  },
  sourceLine(source, target) {
    // Both renderers' source locations use the shared token parser.
    return PELE_FINDER.sourceLine(source, target);
  },
};
