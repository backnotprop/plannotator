import { normalizeBrowserPath, pathIsInsideDir } from '@plannotator/core/browser-paths';
import type { Annotation } from '../types';
import { getItem, setItem } from './storage';

/** `current` = only the open document (the incumbent view). */
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
 * Group key for the open document when it has no path of its own — plan review, where the plan
 * is the document and `sourceFilePath` is annotate-only.
 */
export const ROOT_DOCUMENT_GROUP_KEY = '<plannotator-root-document>';

export interface AnnotationDocumentInput {
  path: string;
  annotations: readonly Annotation[];
  label?: string;
}

export interface AnnotationDocumentGroup {
  path: string;
  label: string;
  annotations: Annotation[];
  isCurrent: boolean;
}

/**
 * Display name for a document: its path relative to the deepest session root that contains it
 * (the same `${dir}/${node.path}` shape the file browser renders).
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
 * One group per document that actually carries feedback, the open document first and the rest
 * ordered by path.
 */
export function groupAnnotationsByDocument(
  documents: Iterable<AnnotationDocumentInput>,
  currentPath: string | null,
  roots: readonly string[] = [],
  order?: readonly string[] | null,
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
  if (order) {
    const ranks = new Map(order.map((path, index) => [normalizeBrowserPath(path), index]));
    const rank = (path: string) => ranks.get(path) ?? order.length;
    groups.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));
    return groups;
  }
  groups.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return groups;
}

/**
 * The panel's groups for a session: every cached document plus the OPEN one, whose live list
 * (externals included) is the same set its "This file" timeline renders.
 */
export function buildAnnotationDocumentGroups(input: {
  cached: Iterable<readonly [string, readonly Annotation[]]>;
  current: { key: string; label?: string; annotations: readonly Annotation[] };
  roots?: readonly string[];
  order?: readonly string[] | null;
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
    input.order,
  );
}

/** Which scope the panel opens on for the document that just became active. */
export function resolveInitialAnnotationScope(input: {
  saved: AnnotationScope | null;
  currentCount: number;
  otherCount: number;
}): AnnotationScope {
  if (input.saved === 'all') return 'all';
  if (input.currentCount === 0 && input.otherCount > 0) return 'all';
  return 'current';
}
