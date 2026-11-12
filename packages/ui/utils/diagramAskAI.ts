import {
  diagramAnchorLocationLine,
  diagramTargetName,
  diagramTargetText,
  type DiagramAnchor,
  type DiagramKind,
  type DiagramTarget,
} from '@plannotator/core/diagram-anchor';
import type { CommentAskAIContext } from '../components/CommentPopover';

const ENGINE_LABELS: Record<DiagramKind, string> = { mermaid: 'Mermaid', graphviz: 'Graphviz' };
const FENCE_LANGUAGE: Record<DiagramKind, string> = { mermaid: 'mermaid', graphviz: 'dot' };

export const MAX_ASK_AI_DIAGRAM_SOURCE_LINES = 40;
export const MAX_ASK_AI_DIAGRAM_SOURCE_CHARS = 4000;

export interface DiagramAskAIInput {
  readonly kind: DiagramKind;
  readonly anchor: DiagramAnchor;
  readonly additionalTargets?: readonly DiagramTarget[];
  readonly source: string;
  readonly sourceLineOffset: number;
  readonly sourcePath?: string;
}

function fenceFor(source: string): string {
  let longest = 0;
  for (const run of source.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(4, longest + 1));
}

const TRUNCATION_MARKER = '…';

function sourceWindow(
  lines: readonly string[],
  anchor: DiagramAnchor,
  offset: number,
): { first: number; last: number; body: string; excerpt: boolean } | null {
  let wholeFirst = 1;
  let wholeLast = lines.length;
  while (wholeLast > 0 && (lines[wholeLast - 1] ?? '').trim() === '') wholeLast -= 1;
  while (wholeFirst <= wholeLast && (lines[wholeFirst - 1] ?? '').trim() === '') wholeFirst += 1;
  if (wholeLast === 0 || wholeFirst > wholeLast) return null;

  const partLine = anchor.kind !== 'diagram' && anchor.sourceLine !== null ? anchor.sourceLine[0] - offset : null;
  const center = partLine !== null && partLine >= wholeFirst && partLine <= wholeLast ? partLine : wholeFirst;

  let centerText = lines[center - 1] ?? '';
  let truncated = false;
  if (centerText.length > MAX_ASK_AI_DIAGRAM_SOURCE_CHARS) {
    centerText = centerText.slice(0, MAX_ASK_AI_DIAGRAM_SOURCE_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
    truncated = true;
  }
  let chars = centerText.length;
  let count = 1;
  let first = center;
  let last = center;
  let growDown = true;
  let growUp = true;
  while ((growDown || growUp) && count < MAX_ASK_AI_DIAGRAM_SOURCE_LINES) {
    if (growDown) {
      const next = last + 1;
      const cost = (lines[next - 1] ?? '').length + 1;
      if (next > wholeLast || chars + cost > MAX_ASK_AI_DIAGRAM_SOURCE_CHARS) growDown = false;
      else {
        last = next;
        chars += cost;
        count += 1;
      }
    }
    if (growUp && count < MAX_ASK_AI_DIAGRAM_SOURCE_LINES) {
      const next = first - 1;
      const cost = (lines[next - 1] ?? '').length + 1;
      if (next < wholeFirst || chars + cost > MAX_ASK_AI_DIAGRAM_SOURCE_CHARS) growUp = false;
      else {
        first = next;
        chars += cost;
        count += 1;
      }
    }
  }
  const body = [...lines.slice(first - 1, center - 1), centerText, ...lines.slice(center, last)].join('\n');
  return { first, last, body, excerpt: truncated || first > wholeFirst || last < wholeLast };
}

export function diagramIdentityForAskAI(input: DiagramAskAIInput): string {
  const { kind, anchor, source, sourceLineOffset } = input;
  const out: string[] = [diagramAnchorLocationLine(anchor)];
  for (const extra of input.additionalTargets ?? []) {
    const text = diagramTargetText(extra);
    out.push(`Also: ${diagramTargetName(extra)}${text !== '' && text !== extra.id ? ` "${text}"` : ''}`);
  }
  out.push(`Diagram type: ${ENGINE_LABELS[kind]} (${anchor.family})`);

  const lines = source.split('\n');
  const window = sourceWindow(lines, anchor, sourceLineOffset);
  if (window !== null) {
    const body = window.body;
    const docFirst = window.first + sourceLineOffset;
    const docLast = window.last + sourceLineOffset;
    const range = docLast > docFirst ? `lines ${docFirst}–${docLast}` : `line ${docFirst}`;
    const partial = window.excerpt ? ' (excerpt)' : '';
    const fence = fenceFor(body);
    out.push(`Diagram source${partial}, document ${range}:`);
    out.push(`${fence}${FENCE_LANGUAGE[kind]}\n${body}\n${fence}`);
  }
  return out.join('\n');
}

export function diagramAskAIContext(input: DiagramAskAIInput): CommentAskAIContext {
  const { kind, anchor } = input;
  const engine = ENGINE_LABELS[kind];
  return {
    kind: 'selection',
    label: anchor.kind === 'diagram' ? `${engine} diagram` : `${engine} diagram ${diagramTargetName(anchor)}`,
    text: diagramTargetText(anchor),
    ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
    detail: diagramIdentityForAskAI(input),
  };
}
