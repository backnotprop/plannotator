import { getExtraMarkdownExtensions } from '@plannotator/ui/utils/markdownExtensions';
import type { DiffFileStatus } from '../types';

const BUILTIN_MARKDOWN_PREVIEW_RE = /\.(md|mdx|markdown)$/i;

export const MARKDOWN_PREVIEW_SIZE_LIMIT = 300 * 1024;

export function isMarkdownPreviewPath(
  path: string,
  extra: readonly string[] = getExtraMarkdownExtensions(),
): boolean {
  const trimmed = path.trim();
  if (BUILTIN_MARKDOWN_PREVIEW_RE.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return extra.some((ext) => lower.endsWith(ext));
}

export function markdownPreviewSourcePath(
  filePath: string,
  oldPath: string | undefined,
  status: DiffFileStatus | undefined,
  extra?: readonly string[],
): string | null {
  const shown = status === 'deleted' ? (oldPath || filePath) : filePath;
  return isMarkdownPreviewPath(shown, extra) ? shown : null;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function resolveReviewRelativePath(fromFile: string, target: string): string | null {
  let raw = target.trim().replace(/[?#].*$/, '');
  if (raw === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null;
  if (raw.startsWith('//')) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
  }
  raw = raw.replace(/\\/g, '/');
  const fromRoot = raw.startsWith('/');
  const segments = fromRoot ? [] : dirnameOf(fromFile).split('/').filter(Boolean);
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join('/');
}

export const MARKDOWN_PREVIEW_IMAGE_ENDPOINT = '/api/review-markdown-image';

export function markdownPreviewImageUrl(options: {
  doc: string;
  side: 'old' | 'new';
  src: string;
  snapshot?: string;
}): string {
  const params = new URLSearchParams({ doc: options.doc, side: options.side, src: options.src });
  if (options.snapshot) params.set('snapshot', options.snapshot);
  return `${MARKDOWN_PREVIEW_IMAGE_ENDPOINT}?${params}`;
}

export function isRemoteImageSource(src: string): boolean {
  const normalized = src.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  return /^https?:/i.test(normalized) || /^[\\/]{2}/.test(normalized);
}

export const REMOTE_IMAGE_HELD_TITLE = 'Remote image, not loaded: loading it tells that server your IP address';

export function isExternalImageSource(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src.trim());
}

export function isMarkdownPreviewFile(
  file: { path: string; oldPath?: string; status?: DiffFileStatus },
  extra?: readonly string[],
): boolean {
  return markdownPreviewSourcePath(file.path, file.oldPath, file.status, extra) !== null;
}

export type MarkdownFileView = 'source' | 'changes' | 'read';

export const MARKDOWN_FILE_VIEWS: readonly MarkdownFileView[] = ['source', 'changes', 'read'];
const SINGLE_SIDE_VIEWS: readonly MarkdownFileView[] = ['source', 'read'];

export function parseMarkdownFileView(value: string | null | undefined): MarkdownFileView | null {
  return value === 'source' || value === 'changes' || value === 'read' ? value : null;
}

export function markdownViewsFor(file: { status?: DiffFileStatus; patch?: string }): readonly MarkdownFileView[] {
  if (file.status === 'added' || file.status === 'deleted') return SINGLE_SIDE_VIEWS;
  if (file.status === 'renamed' && !/^@@ /m.test(file.patch ?? '')) return SINGLE_SIDE_VIEWS;
  return MARKDOWN_FILE_VIEWS;
}

export function resolveMarkdownView(wanted: MarkdownFileView, views: readonly MarkdownFileView[]): MarkdownFileView {
  if (views.includes(wanted)) return wanted;
  return wanted === 'changes' && views.includes('read') ? 'read' : 'source';
}

export function nextMarkdownView(current: MarkdownFileView, views: readonly MarkdownFileView[]): MarkdownFileView {
  const index = views.indexOf(current);
  return views[(index + 1) % views.length] ?? 'source';
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function patchAgreesWithContent(patch: string, content: string, side: 'old' | 'new'): boolean {
  // Line endings never count: with core.autocrlf or `eol=crlf` git prints LF
  // while the file on disk (what /api/file-content returns) has CRLF.
  const lines = content.split('\n').map(stripCarriageReturn);
  const patchLines = patch.split('\n');
  let i = 0;
  while (i < patchLines.length) {
    const header = HUNK_RE.exec(patchLines[i]);
    i += 1;
    if (!header) continue;
    let oldLine = Number(header[1]);
    let newLine = Number(header[3]);
    let oldLeft = header[2] != null ? Number(header[2]) : 1;
    let newLeft = header[4] != null ? Number(header[4]) : 1;
    while (i < patchLines.length && (oldLeft > 0 || newLeft > 0)) {
      const line = patchLines[i];
      const tag = line === '' ? ' ' : line[0];
      const text = stripCarriageReturn(line.slice(1));
      if (tag === '\\') {
        i += 1;
        continue;
      }
      if (tag === ' ') {
        const expected = side === 'new' ? lines[newLine - 1] : lines[oldLine - 1];
        if (expected === undefined || squashWhitespace(expected) !== squashWhitespace(text)) return false;
        oldLine += 1; newLine += 1; oldLeft -= 1; newLeft -= 1;
      } else if (tag === '-') {
        if (side === 'old' && lines[oldLine - 1] !== text) return false;
        oldLine += 1; oldLeft -= 1;
      } else if (tag === '+') {
        if (side === 'new' && lines[newLine - 1] !== text) return false;
        newLine += 1; newLeft -= 1;
      } else {
        break;
      }
      i += 1;
    }
  }
  return true;
}

function stripCarriageReturn(text: string): string {
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const segments = content.split('\n').length;
  return content.endsWith('\n') ? segments - 1 : segments;
}

function hunkTotals(patch: string): { old: number; new: number } | null {
  let oldTotal = 0;
  let newTotal = 0;
  let saw = false;
  for (const line of patch.split('\n')) {
    const header = HUNK_RE.exec(line);
    if (!header) continue;
    saw = true;
    oldTotal += header[2] != null ? Number(header[2]) : 1;
    newTotal += header[4] != null ? Number(header[4]) : 1;
  }
  return saw ? { old: oldTotal, new: newTotal } : null;
}

export type MarkdownPreviewDocument =
  | { kind: 'ready'; content: string }
  | { kind: 'missing' }
  /** The file changed after the diff was captured: never shown as the reviewed version. */
  | { kind: 'stale' };

export function markdownPreviewDocument(
  patch: string,
  oldContent: string | null,
  newContent: string | null,
  status: DiffFileStatus | undefined,
): MarkdownPreviewDocument {
  const side = status === 'deleted' ? 'old' : 'new';
  const content = side === 'old' ? oldContent : newContent;
  if (content == null) return { kind: 'missing' };
  if (!patchAgreesWithContent(patch, content, side)) return { kind: 'stale' };
  const totals = hunkTotals(patch);
  if (totals) {
    if (status === 'added' && countContentLines(content) !== totals.new) return { kind: 'stale' };
    if (status === 'deleted' && countContentLines(content) !== totals.old) return { kind: 'stale' };
    if (
      oldContent != null && newContent != null &&
      countContentLines(newContent) - countContentLines(oldContent) !== totals.new - totals.old
    ) {
      return { kind: 'stale' };
    }
  }
  return { kind: 'ready', content };
}

export type MarkdownPreviewSides =
  | { kind: 'ready'; old: string | null; new: string | null }
  | { kind: 'missing' }
  | { kind: 'stale' };

export function markdownPreviewSides(
  patch: string,
  oldContent: string | null,
  newContent: string | null,
  status: DiffFileStatus | undefined,
): MarkdownPreviewSides {
  const shown = markdownPreviewDocument(patch, oldContent, newContent, status);
  if (shown.kind !== 'ready') return shown;
  if (status === 'added') return { kind: 'ready', old: null, new: newContent };
  if (status === 'deleted') return { kind: 'ready', old: oldContent, new: null };
  if (oldContent == null) return { kind: 'missing' };
  if (!patchAgreesWithContent(patch, oldContent, 'old')) return { kind: 'stale' };
  return { kind: 'ready', old: oldContent, new: newContent };
}
