import type { CommentSite } from './find-comments.ts';

const BLANK = /^[ \t\r\f\v]*$/;
const NO_SEPARATOR_NEEDED = /[()[\]{},;]/;

interface Edit {
  start: number;
  end: number;
  replacement: string;
  removedLines: boolean;
}

function lineStartOf(text: string, position: number): number {
  if (position <= 0) return 0;
  return text.lastIndexOf('\n', position - 1) + 1;
}

function lineEndOf(text: string, position: number): number {
  const end = text.indexOf('\n', position);
  return end === -1 ? text.length : end;
}

function whitespaceBefore(text: string, position: number, floor: number): number {
  let start = position;
  while (start > floor && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  return position - start;
}

function whitespaceAfter(text: string, position: number, ceiling: number): number {
  let end = position;
  while (end < ceiling && (text[end] === ' ' || text[end] === '\t')) end++;
  return end - position;
}

function editFor(text: string, site: CommentSite): Edit {
  const { start, end } = site;
  const lineStart = lineStartOf(text, start);
  const lineEnd = lineEndOf(text, end);
  const codeBefore = !BLANK.test(text.slice(lineStart, start));
  const codeAfter = !BLANK.test(text.slice(end, lineEnd));
  const left = whitespaceBefore(text, start, lineStart);
  const right = whitespaceAfter(text, end, lineEnd);
  if (!codeBefore && !codeAfter) {
    if (lineEnd < text.length) return { start: lineStart, end: lineEnd + 1, replacement: '', removedLines: true };
    return { start: Math.max(0, lineStart - 1), end: lineEnd, replacement: '', removedLines: true };
  }
  if (codeBefore && !codeAfter) return { start: start - left, end: end + right, replacement: '', removedLines: false };
  if (!codeBefore && codeAfter) return { start, end: end + right, replacement: '', removedLines: false };
  if (site.jsxExpression) return { start, end, replacement: '', removedLines: false };
  const spansLines = text.slice(start, end).includes('\n');
  if (spansLines) {
    const indent = text.slice(lineStart, lineStart + whitespaceAfter(text, lineStart, start));
    return { start: start - left, end: end + right, replacement: `\n${indent}`, removedLines: false };
  }
  if (left > 0 && right > 0) return { start: start - left, end: end + right, replacement: ' ', removedLines: false };
  if (left > 0) return { start: start - left, end, replacement: '', removedLines: false };
  if (right > 0) return { start, end: end + right, replacement: '', removedLines: false };
  const needsSeparator = !NO_SEPARATOR_NEEDED.test(text[start - 1] ?? '') && !NO_SEPARATOR_NEEDED.test(text[end] ?? '');
  return { start, end, replacement: needsSeparator ? ' ' : '', removedLines: false };
}

function isBlankLine(text: string, lineStart: number): boolean {
  return BLANK.test(text.slice(lineStart, lineEndOf(text, lineStart)));
}

function previousLineStart(lineStart: number, text: string): number {
  return lineStartOf(text, lineStart - 1);
}

function collapseBlankRun(text: string, mark: number): { text: string; runStart: number } {
  if (mark > text.length) return { text, runStart: mark };
  let runStart = lineStartOf(text, mark);
  while (runStart > 0 && isBlankLine(text, previousLineStart(runStart, text))) runStart = previousLineStart(runStart, text);
  let runEnd = runStart;
  let blankLines = 0;
  while (runEnd < text.length && isBlankLine(text, runEnd) && lineEndOf(text, runEnd) < text.length) {
    runEnd = lineEndOf(text, runEnd) + 1;
    blankLines++;
  }
  if (blankLines === 0) return { text, runStart };
  const atFileStart = runStart === 0;
  const atFileEnd = runEnd >= text.length || BLANK.test(text.slice(runEnd));
  const lineBefore = atFileStart ? '' : text.slice(previousLineStart(runStart, text), runStart).trimEnd();
  const lineAfter = text.slice(runEnd, lineEndOf(text, runEnd)).trimStart();
  const afterOpener = /[{([]$/.test(lineBefore);
  const beforeCloser = /^[})\]]/.test(lineAfter);
  const keep = atFileStart || atFileEnd || afterOpener || beforeCloser ? 0 : 1;
  if (blankLines <= keep) return { text, runStart };
  const keptText = keep === 1 ? text.slice(runStart, lineEndOf(text, runStart) + 1).replace(/[ \t\f\v]+/g, '') : '';
  return { text: text.slice(0, runStart) + keptText + text.slice(runEnd), runStart };
}

export function stripSites(text: string, sites: CommentSite[]): string {
  const ordered = [...sites].sort((a, b) => b.start - a.start);
  let out = text;
  const marks: number[] = [];
  for (const site of ordered) {
    const edit = editFor(out, site);
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
    const shift = edit.replacement.length - (edit.end - edit.start);
    for (let i = 0; i < marks.length; i++) if (marks[i]! >= edit.end) marks[i] = marks[i]! + shift;
    if (edit.removedLines) marks.push(edit.start);
  }
  let collapsedFrom = Number.POSITIVE_INFINITY;
  for (const mark of marks.sort((a, b) => b - a)) {
    if (mark >= collapsedFrom) continue;
    const collapsed = collapseBlankRun(out, mark);
    out = collapsed.text;
    collapsedFrom = collapsed.runStart;
  }
  if (text.endsWith('\n') && !out.endsWith('\n') && out.length > 0) out += '\n';
  return out;
}
