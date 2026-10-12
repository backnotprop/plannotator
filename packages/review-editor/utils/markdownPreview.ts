/**
 * Pure rules behind the single-file Markdown preview in code review.
 *
 * Which files offer a preview, which side of the change it shows, how a link
 * or image path inside the document resolves to a path in the repository,
 * and when the working tree is the revision the preview shows (the only case
 * where `/api/image` can read the right image today).
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

/**
 * Git diff types whose NEW side is the working tree (the same rows as
 * `resolveDiffSideSources`' `worktree(...)` sides). Only for these does a
 * working-tree read through `/api/image` show the revision under review.
 */
const WORKING_TREE_NEW_SIDE = new Set(['uncommitted', 'unstaged', 'since-base', 'local-vs-remote']);

/**
 * The folder preview images may be read from, or null when they must not be
 * shown: static patches, PR reviews, multi-repo workspaces, non-Git VCS
 * (jj, GitButler, P4), and every diff type whose new side is not the working
 * tree (staged, last commit, branch, a single commit, ...).
 *
 * TODO(review-image-route): read preview images from the reviewed revision
 * through a per-revision route (like `/api/review-image`) instead of the
 * working tree, so every mode and the old side of a deletion can show them.
 */
export function markdownPreviewImageRoot(options: {
  isStaticPatch: boolean;
  isPRMode: boolean;
  isWorkspace: boolean;
  vcsType: string | undefined;
  activeDiffBase: string;
  worktreePath: string | null;
  repoCwd: string | null | undefined;
}): string | null {
  if (options.isStaticPatch || options.isPRMode || options.isWorkspace) return null;
  if (options.vcsType !== 'git') return null;
  if (!WORKING_TREE_NEW_SIDE.has(options.activeDiffBase)) return null;
  return options.worktreePath ?? options.repoCwd ?? null;
}

/** Join an absolute folder and a repository-relative path. */
export function joinRepoPath(root: string, relative: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  return `${trimmed}/${relative}`;
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
  const lines = content.split('\n');
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
      const text = line.slice(1);
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
