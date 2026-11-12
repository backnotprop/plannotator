export type DiagramFamily =
  | 'flowchart'
  | 'state'
  | 'class'
  | 'er'
  | 'requirement'
  | 'sequence'
  | 'other'
  | 'graphviz';

export type DiagramTargetKind = 'node' | 'edge' | 'cluster' | 'diagram';

export interface DiagramTarget {
  readonly family: DiagramFamily;
  readonly kind: DiagramTargetKind;
  readonly id?: string;
  readonly from?: string;
  readonly to?: string;
  readonly label: string;
}

export interface DiagramAnchor extends DiagramTarget {
  readonly v: 1;
  readonly sourceLine: readonly [number, number] | null;
}

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

export const MAX_DIAGRAM_ANCHOR_STRING_LENGTH = 400;

export const DIAGRAM_ANCHOR_KEY = 'diagram';
export const DIAGRAM_ADDITIONAL_TARGETS_KEY = 'diagramAdditionalTargets';

export function sameTarget(a: DiagramTarget, b: DiagramTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'diagram') return true;
  if (a.id !== undefined || b.id !== undefined) return a.id === b.id;
  return a.from === b.from && a.to === b.to;
}

export function diagramTargetText(target: DiagramTarget): string {
  if (target.label !== '') return target.label;
  if (target.from !== undefined && target.to !== undefined) return `${target.from} → ${target.to}`;
  return target.id ?? '';
}

export function diagramTargetName(target: DiagramTarget): string {
  if (target.kind === 'diagram') return 'whole diagram';
  if (target.kind === 'edge') {
    return target.from !== undefined && target.to !== undefined
      ? `edge ${target.from} → ${target.to}`
      : `edge ${target.id ?? ''}`;
  }
  return `${target.kind} ${target.id ?? ''}`;
}

export function diagramAnchorLocationLine(anchor: DiagramAnchor): string {
  if (anchor.kind === 'diagram') {
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

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_'
  );
}

export function lineMentions(line: string, token: string): boolean {
  if (token === '') return false;
  for (let at = line.indexOf(token); at !== -1; at = line.indexOf(token, at + 1)) {
    const before = at === 0 ? undefined : line[at - 1];
    const after = line[at + token.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
  }
  return false;
}

const SEQUENCE_MESSAGE = /^\s*[^\s:][^:]*?\s*(?:<<)?--?(?:>>|>|x|\))\s*[+-]?\s*[^:]+:/u;
const SEQUENCE_NOTE = /^\s*note\s+(?:left\s+of|right\s+of|over)\b/iu;
const SEQUENCE_FRAME = /^\s*(?:loop|alt|opt|par|critical|break|rect)\b/iu;

function nthMatchingLine(lines: readonly string[], pattern: RegExp, n: number): readonly [number, number] | null {
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!pattern.test(lines[i] ?? '')) continue;
    seen += 1;
    if (seen === n) return [i + 1, i + 1];
  }
  return null;
}

export function diagramWholeSourceLines(source: string): readonly [number, number] | null {
  const lines = source.split('\n');
  let last = lines.length;
  while (last > 0 && (lines[last - 1] ?? '').trim() === '') last -= 1;
  let first = 1;
  while (first <= last && (lines[first - 1] ?? '').trim() === '') first += 1;
  return last === 0 || first > last ? null : [first, last];
}

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
