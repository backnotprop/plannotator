/**
 * Pure rules behind the single-file Markdown preview in code review.
 *
 * Which files offer a preview, which side of the change it shows, how a link
 * or image path inside the document resolves to a path in the repository,
 * where its images load from, and whether the full contents still agree with
 * the patch on screen.
 */
import { getExtraMarkdownExtensions } from '@plannotator/ui/utils/markdownExtensions';
import type { DiffFileStatus } from '../types';

/** Built-in extensions the preview renders as Markdown. */
const BUILTIN_MARKDOWN_PREVIEW_RE = /\.(md|mdx|markdown)$/i;

/** Above this many bytes the preview asks before rendering ("Preview anyway"). */
export const MARKDOWN_PREVIEW_SIZE_LIMIT = 300 * 1024;

/**
 * True when `path` is a Markdown document: `.md`, `.mdx`, `.markdown`, or an
 * extension the user listed in `markdownExtensions` (config.json, shipped
 * with the diff payload).
 */
export function isMarkdownPreviewPath(
  path: string,
  extra: readonly string[] = getExtraMarkdownExtensions(),
): boolean {
  const trimmed = path.trim();
  if (BUILTIN_MARKDOWN_PREVIEW_RE.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return extra.some((ext) => lower.endsWith(ext));
}

/**
 * The path whose content the preview shows, or null when the file offers no
 * preview. A deletion shows the old document; everything else shows the new
 * one, so a rename to a non-Markdown name (`notes.md` -> `notes.txt`) offers
 * no preview even though the old name was Markdown.
 */
export function markdownPreviewSourcePath(
  filePath: string,
  oldPath: string | undefined,
  status: DiffFileStatus | undefined,
  extra?: readonly string[],
): string | null {
  const shown = status === 'deleted' ? (oldPath || filePath) : filePath;
  return isMarkdownPreviewPath(shown, extra) ? shown : null;
}

/** UTF-8 byte length, for the size guard. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/**
 * Resolve a link or image target written inside the Markdown file at
 * `fromFile` (a repository-relative path) to a repository-relative path.
 *
 * - `?query` and `#fragment` are dropped, `%xx` is decoded.
 * - A leading `/` is the repository root (GitHub's rule for READMEs).
 * - Anything else is relative to the file's own folder.
 * - Returns null for an empty target, a URL with a scheme, or a path that
 *   climbs above the repository root.
 */
export function resolveReviewRelativePath(fromFile: string, target: string): string | null {
  let raw = target.trim().replace(/[?#].*$/, '');
  if (raw === '') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) return null;
  if (raw.startsWith('//')) return null;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Keep the raw text when it is not valid percent-encoding.
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

/** Where the preview loads an image a Markdown file references (both runtimes). */
export const MARKDOWN_PREVIEW_IMAGE_ENDPOINT = '/api/review-markdown-image';

/**
 * The URL of one image the Markdown file `doc` (its path as the patch names
 * it) references, read at that side's revision. The server serves it only
 * when the document at that side really references `src`, resolved against
 * the document's own folder, so a link or a guessed path never reads another
 * file.
 */
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

/**
 * True for an image a browser would fetch from another server. Read the way a
 * URL parser reads it: tabs and line breaks anywhere and leading controls or
 * spaces are dropped, and a backslash counts as a slash. So `https:host/a.png`,
 * `https:/host/a.png` and `https:\\host\\a.png` are remote (on a page of the
 * other scheme a parser reads each as `https://host/…`), as is any `//host`
 * or `\\host`. Every http(s): source counts, even one a parser would resolve
 * against this page: holding one image too many is harmless.
 */
export function isRemoteImageSource(src: string): boolean {
  const normalized = src.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+/, '');
  return /^https?:/i.test(normalized) || /^[\\/]{2}/.test(normalized);
}

/** The title of a remote image a PR review holds back until the reviewer loads it. */
export const REMOTE_IMAGE_HELD_TITLE = 'Remote image, not loaded: loading it tells that server your IP address';

/** True for an image source the page may load as written (remote or inline). */
export function isExternalImageSource(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src.trim());
}

/** Whether a file offers a Markdown preview at all (by name, before any fetch). */
export function isMarkdownPreviewFile(
  file: { path: string; oldPath?: string; status?: DiffFileStatus },
  extra?: readonly string[],
): boolean {
  return markdownPreviewSourcePath(file.path, file.oldPath, file.status, extra) !== null;
}

/**
 * How a Markdown file is shown: its source diff, its rendered changes, or the
 * whole document rendered with no diff marks. The same three words, in this
 * order, on the header menu, the phone sheet, the shortcut help and the docs.
 */
export type MarkdownFileView = 'source' | 'changes' | 'read';

export const MARKDOWN_FILE_VIEWS: readonly MarkdownFileView[] = ['source', 'changes', 'read'];
const SINGLE_SIDE_VIEWS: readonly MarkdownFileView[] = ['source', 'read'];

export function parseMarkdownFileView(value: string | null | undefined): MarkdownFileView | null {
  return value === 'source' || value === 'changes' || value === 'read' ? value : null;
}

/**
 * The views a Markdown file offers. Added and deleted files have one side, so
 * "Changes" would be that side again with every line marked: Source and Read
 * only. So does a rename that changed nothing (no hunks to show).
 */
export function markdownViewsFor(file: { status?: DiffFileStatus; patch?: string }): readonly MarkdownFileView[] {
  if (file.status === 'added' || file.status === 'deleted') return SINGLE_SIDE_VIEWS;
  if (file.status === 'renamed' && !/^@@ /m.test(file.patch ?? '')) return SINGLE_SIDE_VIEWS;
  return MARKDOWN_FILE_VIEWS;
}

/** `wanted` when the file offers it; a rendered wish stays rendered (Changes -> Read). */
export function resolveMarkdownView(wanted: MarkdownFileView, views: readonly MarkdownFileView[]): MarkdownFileView {
  if (views.includes(wanted)) return wanted;
  return wanted === 'changes' && views.includes('read') ? 'read' : 'source';
}

/** The view after `current` in Source -> Changes -> Read -> Source, skipping what the file lacks. */
export function nextMarkdownView(current: MarkdownFileView, views: readonly MarkdownFileView[]): MarkdownFileView {
  const index = views.indexOf(current);
  return views[(index + 1) % views.length] ?? 'source';
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * True when every line the patch shows for `side` (context lines plus that
 * side's added or removed lines) sits at the same line number in `content`.
 * Stricter than the line-count check used for hunk expansion: the preview
 * renders the whole document, so a file edited since the diff was captured
 * (even to the same length) must not be shown as the reviewed version.
 */
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
        // Whitespace-insensitive: under "hide whitespace" (`git diff -w`) a
        // context line may be printed from the other side.
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
  // A trailing newline does not start an extra line (git semantics).
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
  /** The side the preview shows was not returned. */
  | { kind: 'missing' }
  /** The file changed after the diff was captured: never shown as the reviewed version. */
  | { kind: 'stale' };

/**
 * The document the preview renders: the new side, or the old side for a
 * deletion, but only while it still agrees with the patch on screen. An
 * added (deleted) file must have exactly the patch's new (old) line count;
 * a modified one the patch's line-count delta.
 */
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

/**
 * Both sides the rendered diff compares, only while each still agrees with
 * the patch on screen. An added file has no old side and a deleted file no
 * new side; any other file needs both.
 */
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
