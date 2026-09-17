/**
 * Diagram anchors: the pure, browser-safe half of the diagram comment codec
 * (the DOM half — the finders that walk a rendered svg — lives in
 * `@plannotator/ui/utils/diagram-anchor` and `diagram-anchor-graphviz`).
 *
 * A comment on a rendered diagram part is stored as ONE additive field on
 * the annotation, `diagramAnchor`:
 *
 *   { v: 1, family: "flowchart", kind: "node", id: "B",
 *     label: "Validate order", sourceLine: [4, 4] }
 *
 * The anchor is the diagram's own id for the part (edges: `from` and `to`
 * where the family writes both into the element id, `id` alone where it
 * only numbers them), never the rendered element id whole (`flowchart-B-3`:
 * the trailing counter moves when nodes are added) and never geometry (ELK
 * and dagre place the same node at different coordinates). Restore order,
 * run by the ui finders: (1) the element whose id names the part, (2) a
 * node whose label text equals the stored label, (3) the source line as a
 * gutter mark in the Source pane, (4) none: unanchored but listed.
 *
 * `sourceLine` is 1-based and names DOCUMENT lines (a fence's lines are
 * offset by the fence's position in the markdown), so an agent's grep and
 * the pane's gutter mark land on real text.
 *
 * Same contract as `html-anchor.ts`: the types here are what
 * `@plannotator/ui/types`'s `Annotation.diagramAnchor` carries, and
 * `parseDiagramAnchor` is the one fail-closed validator every ingest
 * (external-annotation POST, the feedback archive, the ui codec) runs.
 */

export type DiagramFamily =
  | 'flowchart'
  | 'state'
  | 'class'
  | 'er'
  | 'requirement'
  // A sequence diagram. Mermaid gives its parts classes, not ids, so the
  // ids are ours: an actor is its `name`, a message is `msg-<n>`, a note
  // `note-<n>`, a loop/alt/opt frame `frame-<n>`, each by document order.
  | 'sequence'
  | 'other'
  // A Graphviz graph: the id is the DOT node name.
  | 'graphviz';

/** `diagram` is the WHOLE diagram: no id, the label is the diagram's first
 * source line and `sourceLine` is the fence's full range. It is what a click
 * that resolves no part anchors to, so a click never does nothing (gitGraph,
 * pie, anything a family does not address). Additive within `v: 1`. */
export type DiagramTargetKind = 'node' | 'edge' | 'cluster' | 'diagram';

/** One addressable part of a rendered diagram. `id` names a node, cluster,
 * class, entity or state; edges carry `from` and `to` where the family
 * writes them into the element id (flowchart, class, er, graphviz) and `id`
 * alone where it only numbers them (state `edge{n}`, requirement `{a}-{b}`). */
export interface DiagramTarget {
  readonly family: DiagramFamily;
  readonly kind: DiagramTargetKind;
  readonly id?: string;
  readonly from?: string;
  readonly to?: string;
  /** The part's text at write time: the node label, or the edge label. */
  readonly label: string;
}

export interface DiagramAnchor extends DiagramTarget {
  readonly v: 1;
  /** 1-based lines in the document that holds the source, or null when
   * the writer could not locate the part in the text. */
  readonly sourceLine: readonly [number, number] | null;
}

/** The diagram kinds the renderer slot knows. */
export type DiagramKind = 'mermaid' | 'graphviz';

const FAMILIES: ReadonlySet<string> = new Set<DiagramFamily>([
  'flowchart',
  'state',
  'class',
  'er',
  'requirement',
  'sequence',
  'other',
  'graphviz',
]);
const KINDS: ReadonlySet<string> = new Set<DiagramTargetKind>(['node', 'edge', 'cluster', 'diagram']);

/** Longest id, from, to or label the parser keeps; a rendered svg never
 * produces more, and the anchor is persisted (drafts, the archive). */
export const MAX_DIAGRAM_ANCHOR_STRING_LENGTH = 400;

/** The wire keys a host that stores anchors as an opaque JSON blob uses
 * (Workspaces' `anchor_json`); Plannotator carries the anchor on the
 * annotation itself under `diagramAnchor`. */
export const DIAGRAM_ANCHOR_KEY = 'diagram';
export const DIAGRAM_ADDITIONAL_TARGETS_KEY = 'diagramAdditionalTargets';

/** Two targets name the same part: same kind and the same id, or the same
 * from and to. The family is not compared: a foreign family with the same
 * id grammar would match by construction, and the render decides. */
export function sameTarget(a: DiagramTarget, b: DiagramTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'diagram') return true;
  if (a.id !== undefined || b.id !== undefined) return a.id === b.id;
  return a.from === b.from && a.to === b.to;
}

/** The comment's context line: the node label, else the edge's ends. */
export function diagramTargetText(target: DiagramTarget): string {
  if (target.label !== '') return target.label;
  if (target.from !== undefined && target.to !== undefined) return `${target.from} → ${target.to}`;
  return target.id ?? '';
}

/** The short part name for chips and the composer ("node C", "edge B → C"). */
export function diagramTargetName(target: DiagramTarget): string {
  if (target.kind === 'diagram') return 'whole diagram';
  if (target.kind === 'edge') {
    return target.from !== undefined && target.to !== undefined
      ? `edge ${target.from} → ${target.to}`
      : `edge ${target.id ?? ''}`;
  }
  return `${target.kind} ${target.id ?? ''}`;
}

/**
 * The one-line location an export prints under a diagram comment:
 * `Diagram node Approve? (D), line 4`. Edges name both ends, a part with no
 * label falls back to its id, and a null `sourceLine` prints no line.
 */
export function diagramAnchorLocationLine(anchor: DiagramAnchor): string {
  if (anchor.kind === 'diagram') {
    // The whole diagram: `Diagram (flowchart), lines 7–12`.
    let whole = `Diagram (${anchor.family})`;
    if (anchor.sourceLine !== null) {
      const [first, last] = anchor.sourceLine;
      whole += last > first ? `, lines ${first}–${last}` : `, line ${first}`;
    }
    return whole;
  }
  const ref =
    anchor.id !== undefined
      ? anchor.id
      : anchor.from !== undefined && anchor.to !== undefined
        ? `${anchor.from} → ${anchor.to}`
        : '';
  const label = anchor.label !== '' ? anchor.label : ref;
  let line = `Diagram ${anchor.kind} ${label}`;
  if (ref !== '' && ref !== label) line += ` (${ref})`;
  if (anchor.sourceLine !== null) {
    const [first, last] = anchor.sourceLine;
    line += last > first ? `, lines ${first}–${last}` : `, line ${first}`;
  }
  return line;
}

/** A word character for token matching: the `\w` class, spelled out so the
 * match below stays plain string work. A node id built from any other
 * character (a dot, a dash) ends the token, which is what the source text
 * does too. */
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_'
  );
}

/**
 * `line` names `token` as a WHOLE token (D does not match DR). Plain string
 * scanning, never a RegExp built from the token: the id comes from a
 * rendered svg and a `.` or `(` in it would otherwise compile into the
 * pattern.
 */
export function lineMentions(line: string, token: string): boolean {
  if (token === '') return false;
  for (let at = line.indexOf(token); at !== -1; at = line.indexOf(token, at + 1)) {
    const before = at === 0 ? undefined : line[at - 1];
    const after = line[at + token.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
  }
  return false;
}

/**
 * The 1-based line range that declares the part in the source text: the
 * first line that names the node id (a cluster: its `subgraph` line), or
 * the first line that names both ends of an edge. Null when the part is
 * not found as a token, which is what a node that exists only in an unsaved
 * draft reads as until it is saved. Mermaid grammar; the Graphviz finder
 * has its own (`subgraph` may sit mid-line there).
 */
/** A sequence message statement: `A->>B: text`, every arrow Mermaid has
 * (`->`, `-->`, `->>`, `-->>`, `-x`, `--x`, `-)`, `--)`, `<<->>`, `<<-->>`),
 * with the optional activation `+` / `-` on the receiver. */
const SEQUENCE_MESSAGE = /^\s*[^\s:][^:]*?\s*(?:<<)?--?(?:>>|>|x|\))\s*[+-]?\s*[^:]+:/u;
const SEQUENCE_NOTE = /^\s*note\s+(?:left\s+of|right\s+of|over)\b/iu;
const SEQUENCE_FRAME = /^\s*(?:loop|alt|opt|par|critical|break|rect)\b/iu;

/** The n-th (1-based) line that matches, as a line range. */
function nthMatchingLine(lines: readonly string[], pattern: RegExp, n: number): readonly [number, number] | null {
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!pattern.test(lines[i] ?? '')) continue;
    seen += 1;
    if (seen === n) return [i + 1, i + 1];
  }
  return null;
}

/** The whole source as a line range (leading and trailing blank lines
 * excluded); null for an empty source. */
export function diagramWholeSourceLines(source: string): readonly [number, number] | null {
  const lines = source.split('\n');
  let last = lines.length;
  while (last > 0 && (lines[last - 1] ?? '').trim() === '') last -= 1;
  let first = 1;
  while (first <= last && (lines[first - 1] ?? '').trim() === '') first += 1;
  return last === 0 || first > last ? null : [first, last];
}

/** The diagram's first non-blank source line: the whole-diagram label. */
export function diagramFirstSourceLine(source: string): string {
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
  }
  return '';
}

export function diagramSourceLine(
  source: string,
  target: DiagramTarget,
): readonly [number, number] | null {
  if (target.kind === 'diagram') return diagramWholeSourceLines(source);
  const lines = source.split('\n');
  if (target.family === 'sequence' && target.id !== undefined) {
    // Sequence ids are ordinals by document order, and the statements of a
    // sequence diagram sit in that same order in the text.
    const ordinal = /^(msg|note|frame)-(\d+)$/u.exec(target.id);
    if (ordinal !== null) {
      const pattern = ordinal[1] === 'msg' ? SEQUENCE_MESSAGE : ordinal[1] === 'note' ? SEQUENCE_NOTE : SEQUENCE_FRAME;
      return nthMatchingLine(lines, pattern, Number(ordinal[2]));
    }
  }
  const matches = (line: string): boolean => {
    if (target.kind === 'edge') {
      if (target.from !== undefined && target.to !== undefined) {
        return lineMentions(line, target.from) && lineMentions(line, target.to);
      }
      return false;
    }
    if (target.id === undefined) return false;
    if (target.kind === 'cluster') {
      return /^\s*subgraph\b/u.test(line) && lineMentions(line, target.id);
    }
    return lineMentions(line, target.id);
  };
  const index = lines.findIndex(matches);
  return index === -1 ? null : [index + 1, index + 1];
}

/** The wire shape of one target (no `sourceLine`, no version). */
function targetWire(target: DiagramTarget): Record<string, unknown> {
  return {
    family: target.family,
    kind: target.kind,
    ...(target.id !== undefined ? { id: target.id } : {}),
    ...(target.from !== undefined ? { from: target.from } : {}),
    ...(target.to !== undefined ? { to: target.to } : {}),
    label: target.label,
  };
}

/** The anchor value itself, as `Annotation.diagramAnchor` carries it. */
export function buildDiagramAnchorValue(
  primary: DiagramTarget,
  sourceLine: readonly [number, number] | null,
): DiagramAnchor {
  return {
    v: 1,
    family: primary.family,
    kind: primary.kind,
    ...(primary.id !== undefined ? { id: primary.id } : {}),
    ...(primary.from !== undefined ? { from: primary.from } : {}),
    ...(primary.to !== undefined ? { to: primary.to } : {}),
    label: primary.label,
    sourceLine: sourceLine === null ? null : [sourceLine[0], sourceLine[1]],
  };
}

/**
 * The opaque-blob wire shape a host that stores every anchor kind in one
 * JSON column writes (`originalText` is the primary target's label so a
 * comments panel's context line reads the same as a markdown or html
 * comment). Plannotator does not use this shape itself.
 */
export function buildDiagramAnchor(
  primary: DiagramTarget,
  sourceLine: readonly [number, number] | null,
  additional: readonly DiagramTarget[],
): Record<string, unknown> {
  return {
    originalText: diagramTargetText(primary),
    [DIAGRAM_ANCHOR_KEY]: buildDiagramAnchorValue(primary, sourceLine),
    ...(additional.length > 0
      ? { [DIAGRAM_ADDITIONAL_TARGETS_KEY]: additional.map(targetWire) }
      : {}),
  };
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > MAX_DIAGRAM_ANCHOR_STRING_LENGTH
    ? value.slice(0, MAX_DIAGRAM_ANCHOR_STRING_LENGTH)
    : value;
}

/** Read one target tolerantly: a foreign or partial value is null. */
export function parseDiagramTarget(value: unknown): DiagramTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const family = raw['family'];
  const kind = raw['kind'];
  if (typeof family !== 'string' || !FAMILIES.has(family)) return null;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  const id = boundedString(raw['id']);
  const from = boundedString(raw['from']);
  const to = boundedString(raw['to']);
  if (kind !== 'diagram' && id === undefined && (from === undefined || to === undefined)) return null;
  const label = boundedString(raw['label']) ?? '';
  return {
    family: family as DiagramFamily,
    kind: kind as DiagramTargetKind,
    ...(id !== undefined ? { id } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    label,
  };
}

/** Read an anchor tolerantly: a foreign, partial or unversioned value is
 * null, never a throw (the comment then lists as unanchored, the standing
 * rule). A malformed `sourceLine` drops to null while the target survives. */
export function parseDiagramAnchor(value: unknown): DiagramAnchor | null {
  const target = parseDiagramTarget(value);
  if (target === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw['v'] !== 1) return null;
  const line = raw['sourceLine'];
  const sourceLine =
    Array.isArray(line) &&
    line.length === 2 &&
    line.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)
      ? ([line[0] as number, line[1] as number] as const)
      : null;
  return { ...target, v: 1, sourceLine };
}

/** Read additional targets, capped at `max` entries; junk entries are
 * dropped, never thrown. */
export function parseDiagramAdditionalTargets(value: unknown, max: number): DiagramTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: DiagramTarget[] = [];
  for (const entry of value) {
    if (targets.length >= max) break;
    const target = parseDiagramTarget(entry);
    if (target !== null) targets.push(target);
  }
  return targets;
}
