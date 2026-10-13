import {
  diagramAnchorLocationLine,
  diagramTargetName,
  diagramTargetText,
  type DiagramAnchor,
  type DiagramKind,
  type DiagramTarget,
} from '@plannotator/core/diagram-anchor';
import type { CommentAskAIContext } from '../components/CommentPopover';

/**
 * Ask AI from a diagram comment: the question rides the same
 * `CommentAskAIContext` the markdown and html composers send, so the host's
 * one Ask AI path (an SDK provider, "Ask this session", the agent terminal)
 * carries it unchanged. `text` is the part's label (what the chat shows under
 * the question); `detail` is the agent-facing identity, which
 * `buildDefaultPrompt` puts on the USER message before the question, never in
 * the system prompt:
 *
 *   Diagram node Approve? (D), line 7          <- the export's location line
 *   Diagram type: Mermaid (flowchart)
 *   Diagram source, document lines 6–9:
 *   ````mermaid
 *   …
 *   ````
 *
 * The source is bounded (a window around the part when the diagram is long),
 * so a huge whole-file diagram never floods a turn.
 */

const ENGINE_LABELS: Record<DiagramKind, string> = { mermaid: 'Mermaid', graphviz: 'Graphviz' };
const FENCE_LANGUAGE: Record<DiagramKind, string> = { mermaid: 'mermaid', graphviz: 'dot' };

/** Most diagram source lines a question carries. */
export const MAX_ASK_AI_DIAGRAM_SOURCE_LINES = 40;
/** Most diagram source characters a question carries. */
export const MAX_ASK_AI_DIAGRAM_SOURCE_CHARS = 4000;

export interface DiagramAskAIInput {
  readonly kind: DiagramKind;
  /** The part the question is about; `sourceLine` names DOCUMENT lines. */
  readonly anchor: DiagramAnchor;
  /** Shift-click targets the draft also covers (absent or empty for most). */
  readonly additionalTargets?: readonly DiagramTarget[];
  /** The diagram text (the fence body, or the whole file). */
  readonly source: string;
  /** Lines to add to a diagram line to name the document line: the fence's
   * opening line for a fence, 0 when the document is the diagram. */
  readonly sourceLineOffset: number;
  /** The document the diagram lives in, as the other composers send it. */
  readonly sourcePath?: string;
}

/** A fence that no backtick run in the source can close early. */
function fenceFor(source: string): string {
  let longest = 0;
  for (const run of source.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(4, longest + 1));
}

/** A line longer than the whole budget is cut, with a visible marker. */
const TRUNCATION_MARKER = '…';

/**
 * The bounded slice of the source a question carries, grown outward from the
 * part's line (the top of the diagram when the part has no line), one line
 * below then one above, until the line cap or the character cap stops a
 * side. The part's own line is always in it; a part line longer than the
 * whole character budget is cut with a visible marker, so the slice never
 * exceeds MAX_ASK_AI_DIAGRAM_SOURCE_CHARS (newlines included). Returns
 * 1-based DIAGRAM lines and the text to quote.
 */
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

/** The agent-facing identity of a diagram part (the `detail` Ask AI sends). */
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

/** The Ask AI context for a question asked from a diagram comment. */
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
