import type { CallFlowAnnotationTarget } from '@plannotator/ui/types';

export function formatCallFlowInstallSize(bytes: number): string {
  const megabytes = Math.ceil(bytes / (1024 * 1024));
  return `~${megabytes.toLocaleString()} MB`;
}

/** Split a repository-relative path into scan-friendly directory and name. */
export function splitCallFlowFilePath(filePath: string): { directory: string; name: string } {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) return { directory: '', name: filePath };
  return {
    directory: filePath.slice(0, lastSlash),
    name: filePath.slice(lastSlash + 1),
  };
}

export interface CallFlowSignatureParts {
  /** Receiver and `new ` prefix, shown muted: `ScheduleCheck.` in `ScheduleCheck.authorize(…)`. */
  readonly receiver: string;
  /** The called name, which the row leads with and never truncates. */
  readonly name: string;
  /** Arguments and any chained tail, shown most muted and truncated first. */
  readonly rest: string;
}

/**
 * Split a CallDiff call label so the called name leads the row:
 * `ScheduleCheck.authorize(session, name)` -> `ScheduleCheck.` / `authorize` / `(session, name)`.
 * The three parts always concatenate back to the label. A chained call keeps
 * its tail in `rest`; a label with no call keeps its text in `name`.
 */
export function splitCallFlowSignature(label: string): CallFlowSignatureParts {
  const open = label.indexOf('(');
  const head = open === -1 ? label : label.slice(0, open);
  const rest = open === -1 ? '' : label.slice(open);
  const prefix = head.startsWith('new ') ? 'new ' : '';
  const callee = head.slice(prefix.length);
  const dot = callee.lastIndexOf('.');
  if (dot <= 0 || dot === callee.length - 1) return { receiver: prefix, name: callee, rest };
  return { receiver: prefix + callee.slice(0, dot + 1), name: callee.slice(dot + 1), rest };
}

export type CallFlowRawLineKind = 'added' | 'removed' | 'context';

export interface CallFlowRawLine {
  readonly content: string;
  readonly kind: CallFlowRawLineKind;
  /** One-based position in the response-level canonical CallDiff output. */
  readonly rawLine: number;
}

export interface CallFlowRawSearchMatch {
  readonly lineIndex: number;
  readonly start: number;
  readonly end: number;
}

/** A raw-output annotation target with a required one-based line number. */
export type CallFlowRawAnnotationTarget = Extract<CallFlowAnnotationTarget, { rawLine: number }>;

/** Build the durable, review-scoped annotation target for one raw output line. */
export function annotationTargetForCallFlowRawLine(
  line: CallFlowRawLine,
): CallFlowRawAnnotationTarget {
  return {
    treePath: `raw:${line.rawLine}`,
    entry: 'Raw CallDiff output',
    label: line.content || '(blank line)',
    rawLine: line.rawLine,
    side: line.kind === 'removed' ? 'old' : 'new',
  };
}

/**
 * Classify canonical CallDiff output without rewriting it. CallDiff reserves
 * the first column for its status marker (`+`, `-`, or a space), so operators,
 * path hyphens, and headings later in a line remain neutral.
 */
export function getCallFlowRawLines(raw: string, rawLineStart = 1): CallFlowRawLine[] {
  return raw.split('\n').map((content, lineIndex) => {
    const marker = content.match(/^([+−-])(?=\s)/)?.[1];
    const kind: CallFlowRawLineKind = marker === '+'
      ? 'added'
      : marker === '-' || marker === '−'
        ? 'removed'
        : 'context';
    return { content, kind, rawLine: rawLineStart + lineIndex };
  });
}

/** Locate non-overlapping, case-insensitive matches without changing raw text. */
export function findCallFlowRawMatches(
  lines: readonly CallFlowRawLine[],
  query: string,
): CallFlowRawSearchMatch[] {
  if (query.length === 0) return [];
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escapedQuery, 'giu');
  const matches: CallFlowRawSearchMatch[] = [];
  lines.forEach((line, lineIndex) => {
    for (const match of line.content.matchAll(pattern)) {
      const start = match.index;
      matches.push({ lineIndex, start, end: start + match[0].length });
    }
  });
  return matches;
}
