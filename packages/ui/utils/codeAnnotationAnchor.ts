import type { DiffFile } from '@plannotator/core/diff-files';
import type { CodeAnnotation } from '../types';

export const MAX_ANCHOR_TEXT_CHARS = 20_000;
export const ANCHOR_CONTEXT_LINES = 2;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

function patchSideLines(filePatch: string, side: 'old' | 'new'): Map<number, string> & { hunkContext: Map<number, string> } {
  const lines = new Map<number, string>() as Map<number, string> & { hunkContext: Map<number, string> };
  lines.hunkContext = new Map<number, string>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let context = '';
  const put = (n: number, body: string) => {
    lines.set(n, body);
    lines.hunkContext.set(n, context);
  };
  for (const raw of filePatch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      context = header[3] ?? '';
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === ' ') {
      put(side === 'old' ? oldLine : newLine, body);
      oldLine += 1;
      newLine += 1;
    } else if (marker === '-') {
      if (side === 'old') put(oldLine, body);
      oldLine += 1;
    } else if (marker === '+') {
      if (side === 'new') put(newLine, body);
      newLine += 1;
    } else if (marker === '\\') {
    } else {
      inHunk = false;
    }
  }
  return lines;
}

function validRange(start: number, end: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start;
}

export function readPatchLines(
  filePatch: string,
  side: 'old' | 'new',
  start: number,
  end: number,
): string | null {
  if (!validRange(start, end)) return null;
  const all = patchSideLines(filePatch, side);
  const lines: string[] = [];
  for (let n = start; n <= end; n += 1) {
    const line = all.get(n);
    if (line === undefined) return null;
    lines.push(line);
  }
  return lines.join('\n');
}

interface AnchorReading {
  text: string;
  context: { before: (string | null)[]; after: (string | null)[]; hunk?: string };
}

function readAnchor(file: DiffFile, annotation: CodeAnnotation): AnchorReading | null {
  const { side, lineStart: start, lineEnd: end } = annotation;
  if (!validRange(start, end)) return null;
  const all = patchSideLines(file.patch, side);
  const lines: string[] = [];
  for (let n = start; n <= end; n += 1) {
    const line = all.get(n);
    if (line === undefined) return null;
    lines.push(line);
  }
  const before: (string | null)[] = [];
  for (let n = start - ANCHOR_CONTEXT_LINES; n < start; n += 1) before.push(n >= 1 ? all.get(n) ?? null : null);
  const after: (string | null)[] = [];
  for (let n = end + 1; n <= end + ANCHOR_CONTEXT_LINES; n += 1) after.push(all.get(n) ?? null);
  const hunk = all.hunkContext.get(start);
  return { text: lines.join('\n'), context: { before, after, ...(hunk ? { hunk } : {}) } };
}

function sameContext(a: AnchorReading['context'], b: CodeAnnotation['anchorContext']): boolean {
  if (!b || !Array.isArray(b.before) || !Array.isArray(b.after)) return false;
  const eq = (x: (string | null)[], y: (string | null)[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.before, b.before) && eq(a.after, b.after) && (a.hunk ?? '') === (b.hunk ?? '');
}

function isLineScoped(annotation: CodeAnnotation): boolean {
  return (annotation.scope ?? 'line') === 'line';
}

export function captureAnchor(
  annotation: CodeAnnotation,
  files: readonly DiffFile[],
): Pick<CodeAnnotation, 'anchorText' | 'anchorContext'> {
  if (!isLineScoped(annotation)) return {};
  const file = files.find((f) => f.path === annotation.filePath);
  if (!file) return {};
  const reading = readAnchor(file, annotation);
  if (!reading || reading.text.length > MAX_ANCHOR_TEXT_CHARS) return {};
  return { anchorText: reading.text, anchorContext: reading.context };
}

export function captureAnchorText(annotation: CodeAnnotation, files: readonly DiffFile[]): string | undefined {
  return captureAnchor(annotation, files).anchorText;
}

export function anchorStillMatches(annotation: CodeAnnotation, files: readonly DiffFile[]): boolean {
  if (annotation.anchorText === undefined) return false;
  const file = files.find((f) => f.path === annotation.filePath);
  if (!file) return false;
  const reading = readAnchor(file, annotation);
  return reading !== null && reading.text === annotation.anchorText && sameContext(reading.context, annotation.anchorContext);
}

export interface ReanchorOptions {
  currentSnapshot?: string;
  belongsToCurrentDiff?: (annotation: CodeAnnotation) => boolean;
  patchChanged?: boolean;
}

export function reanchorCodeAnnotations(
  annotations: readonly CodeAnnotation[],
  files: readonly DiffFile[],
  options: ReanchorOptions = {},
): CodeAnnotation[] {
  const { currentSnapshot, belongsToCurrentDiff = () => true, patchChanged = false } = options;
  let changed = false;
  const next = annotations.map((annotation) => {
    if (!isLineScoped(annotation) || annotation.outdated || annotation.outsideDiff || !belongsToCurrentDiff(annotation)) return annotation;
    if (annotation.anchorSnapshot !== undefined && annotation.anchorSnapshot === currentSnapshot) return annotation;
    if (annotation.anchorSnapshot === undefined && !patchChanged) return annotation;
    changed = true;
    if (anchorStillMatches(annotation, files)) {
      return currentSnapshot === undefined ? annotation : { ...annotation, anchorSnapshot: currentSnapshot };
    }
    return { ...annotation, outdated: true };
  });
  return changed ? next : (annotations as CodeAnnotation[]);
}

export function markOutdatedCodeAnnotations(
  annotations: readonly CodeAnnotation[],
  files: readonly DiffFile[],
  belongsToCurrentDiff: (annotation: CodeAnnotation) => boolean = () => true,
  currentSnapshot?: string,
): CodeAnnotation[] {
  return reanchorCodeAnnotations(annotations, files, { currentSnapshot, belongsToCurrentDiff, patchChanged: true });
}

export function restorableViewedFiles(
  viewedFiles: readonly string[],
  patchChanged: boolean,
  files: readonly DiffFile[],
): string[] {
  if (!patchChanged) return [...viewedFiles];
  const inDiff = new Set(files.map((f) => f.path));
  return viewedFiles.filter((path) => !inDiff.has(path));
}

export function canPostInline(
  annotation: CodeAnnotation,
  knownSnapshots: ReadonlyMap<string, string> | undefined,
  currentPrUrl: string | undefined,
): boolean {
  if (annotation.outdated || annotation.outsideDiff) return false;
  if (!knownSnapshots || annotation.anchorSnapshot === undefined) return true;
  const prUrl = annotation.prUrl ?? currentPrUrl;
  const known = prUrl === undefined ? undefined : knownSnapshots.get(prUrl);
  return known === undefined || known === annotation.anchorSnapshot;
}

export function annotationNavigation(annotation: CodeAnnotation): 'call-flow' | 'select-file' | 'scroll' {
  if (annotation.callFlowTargets?.length && (annotation.scope ?? 'line') !== 'line') return 'call-flow';
  if (annotation.outdated) return 'select-file';
  return 'scroll';
}
