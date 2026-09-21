/**
 * Cross-file annotation scope (multi-document annotate sessions).
 *
 * A folder session spreads one body of feedback across many documents, but the
 * annotations panel only ever showed the open file's comments. This module owns
 * the pure half of the "All files" view: which documents have feedback, how
 * they are ordered and labelled, and which scope the panel opens on.
 *
 * Everything here is pure except the two preference accessors, which use the
 * shared storage backend (cookies by default) like the other panel prefs.
 */

import { normalizeBrowserPath, pathIsInsideDir } from '@plannotator/core/browser-paths';
import type { Annotation } from '../types';
import { getItem, setItem } from './storage';

/** `current` = only the open document (the incumbent view). `all` = every document. */
export type AnnotationScope = 'current' | 'all';

const ANNOTATION_SCOPE_KEY = 'plannotator-annotation-scope';

/** The user's explicit last choice, or null when they have never chosen. */
export function getAnnotationScopePreference(): AnnotationScope | null {
  const raw = getItem(ANNOTATION_SCOPE_KEY);
  return raw === 'all' || raw === 'current' ? raw : null;
}

export function setAnnotationScopePreference(scope: AnnotationScope): void {
  setItem(ANNOTATION_SCOPE_KEY, scope);
}

/**
 * Group key for the open document when it has no path of its own — plan review,
 * where the plan is the document and `sourceFilePath` is annotate-only. Without
 * a key the root document forms no group at all, so the "All files" view hid the
 * plan's own comments while listing every linked document's. It contains no path
 * separator, so `normalizeBrowserPath` leaves it alone, and the angle brackets
 * keep it from colliding with a real file path (illegal in Windows paths, and
 * absent from the absolute paths these groups carry).
 */
export const ROOT_DOCUMENT_GROUP_KEY = '<plannotator-root-document>';

export interface AnnotationDocumentInput {
  /** Absolute path of the document. */
  path: string;
  annotations: readonly Annotation[];
  /** Display name override. Only the pathless root document needs one: every
   *  other group derives its label from its path. */
  label?: string;
}

export interface AnnotationDocumentGroup {
  path: string;
  /** Path relative to the nearest session root, else the bare file name. */
  label: string;
  annotations: Annotation[];
  isCurrent: boolean;
}

/**
 * Display name for a document: its path relative to the deepest session root
 * that contains it (the same `${dir}/${node.path}` shape the file browser
 * renders), falling back to the bare file name when no root matches.
 */
export function documentLabel(path: string, roots: readonly string[] = []): string {
  const normalized = normalizeBrowserPath(path);
  let best = '';
  for (const root of roots) {
    if (!root) continue;
    const normalizedRoot = normalizeBrowserPath(root);
    if (!pathIsInsideDir(normalized, normalizedRoot)) continue;
    if (normalizedRoot.length > best.length) best = normalizedRoot;
  }
  if (best && normalized.length > best.length) {
    return normalized.slice(best.endsWith('/') ? best.length : best.length + 1);
  }
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

/**
 * One group per document that actually carries feedback, the open document
 * first and the rest ordered by path. Documents without annotations are
 * dropped: the view answers "where is my feedback", not "what files exist".
 */
export function groupAnnotationsByDocument(
  documents: Iterable<AnnotationDocumentInput>,
  currentPath: string | null,
  roots: readonly string[] = [],
): AnnotationDocumentGroup[] {
  const normalizedCurrent = currentPath ? normalizeBrowserPath(currentPath) : null;
  const groups: AnnotationDocumentGroup[] = [];
  const seen = new Set<string>();
  for (const doc of documents) {
    const path = normalizeBrowserPath(doc.path);
    if (!path || seen.has(path) || doc.annotations.length === 0) continue;
    seen.add(path);
    groups.push({
      path,
      label: doc.label ?? documentLabel(path, roots),
      annotations: [...doc.annotations],
      isCurrent: path === normalizedCurrent,
    });
  }
  groups.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return groups;
}

/**
 * The panel's groups for a session: every cached document plus the OPEN one,
 * whose live list (externals included) is the same set its "This file" timeline
 * renders — the cache copy behind it can be stale.
 *
 * The open document is always contributed, under `current.key`. In plan review
 * that key is {@link ROOT_DOCUMENT_GROUP_KEY}: the plan has no path, and keying
 * groups by path alone dropped it from the list, so the "All files" view hid
 * the reviewer's own comments on the document in front of them.
 */
export function buildAnnotationDocumentGroups(input: {
  /** Documents held in the linked-doc cache, keyed by path. */
  cached: Iterable<readonly [string, readonly Annotation[]]>;
  current: { key: string; label?: string; annotations: readonly Annotation[] };
  roots?: readonly string[];
}): AnnotationDocumentGroup[] {
  const byPath = new Map<string, readonly Annotation[]>();
  for (const [path, annotations] of input.cached) byPath.set(path, annotations);
  byPath.set(input.current.key, input.current.annotations);
  return groupAnnotationsByDocument(
    Array.from(byPath, ([path, annotations]) => ({
      path,
      annotations,
      label: path === input.current.key ? input.current.label : undefined,
    })),
    input.current.key,
    input.roots ?? [],
  );
}

/**
 * Which scope the panel opens on for the document that just became active.
 *
 * The saved preference wins, with one exception that is the whole point of the
 * feature: landing on a file with no feedback while feedback exists elsewhere
 * would otherwise show "No annotations yet" next to a session full of comments.
 */
export function resolveInitialAnnotationScope(input: {
  saved: AnnotationScope | null;
  /** Annotations on the document that is open now. */
  currentCount: number;
  /** Annotations on every other document in the session. */
  otherCount: number;
}): AnnotationScope {
  if (input.saved === 'all') return 'all';
  if (input.currentCount === 0 && input.otherCount > 0) return 'all';
  return 'current';
}
