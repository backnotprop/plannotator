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
