import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation } from '../types';
import { AnnotationType } from '../types';
import type { ViewerHandle } from '../components/Viewer';

/**
 * Bridges SSE-delivered external annotations into the Viewer's imperative
 * highlight API so tools can POST annotations with `originalText` and have
 * them highlight real spans of the rendered plan.
 *
 * The Viewer's `applySharedAnnotations` already searches the DOM for
 * `originalText` and dedupes against already-applied marks, so this hook
 * just needs to drive it when the external list changes.
 *
 * - Annotations without `originalText` (or `GLOBAL_COMMENT`) stay sidebar-only.
 * - Annotations with `diffContext` are skipped (diff view owns those).
 * - On plan markdown change the applied set is cleared so re-rendered blocks
 *   get re-highlighted.
 * - Callers can invoke the returned `reset()` to force a full re-apply — used
 *   by the share-import path in App.tsx after it calls `clearAllHighlights()`,
 *   which would otherwise leave our bookkeeping stale against a wiped DOM.
 * - Disabled state no-ops WITHOUT clearing the applied set. This preserves the
 *   bookkeeping while the Viewer DOM is hidden (diff view / linked doc) so that
 *   any SSE removals that arrive while hidden are correctly reconciled when the
 *   hook re-enables.
 */
export function useExternalAnnotationHighlights(params: {
  viewerRef: React.RefObject<ViewerHandle | null>;
  externalAnnotations: Annotation[];
  enabled: boolean;
  /** Bump to force a full re-apply (e.g. plan markdown changed and blocks re-rendered). */
  planKey: string;
}): { reset: () => void } {
  const { viewerRef, externalAnnotations, enabled, planKey } = params;

  // Tracks annotation IDs currently materialized as DOM highlights, along
  // with a fingerprint so updates trigger remove+reapply.
  const appliedRef = useRef<Map<string, string>>(new Map());

  // Bumped to force the main effect to treat every current external as a
  // fresh application target — used by `reset()` below.
  const [resetCount, setResetCount] = useState(0);

  // Clear tracking when plan content changes — the Viewer re-parses blocks
  // and wipes marks, so our bookkeeping is stale.
  useEffect(() => {
    appliedRef.current.clear();
  }, [planKey]);

  useEffect(() => {
    if (!enabled) return;

    const viewer = viewerRef.current;
    if (!viewer) return;

    const eligible = externalAnnotations.filter(
      a => a.type !== AnnotationType.GLOBAL_COMMENT && !a.diffContext && a.originalText,
    );
    const applied = appliedRef.current;

    // Removals: previously applied but no longer present, or fingerprint changed.
    const toRemove: string[] = [];
    for (const [id, fp] of applied) {
      const match = eligible.find(a => a.id === id);
      if (!match || fingerprint(match) !== fp) {
        toRemove.push(id);
      }
    }
    toRemove.forEach(id => {
      viewer.removeHighlight(id);
      applied.delete(id);
    });

    // Additions: eligible but not yet applied (includes re-adds from updates).
    const toAdd = eligible.filter(a => !applied.has(a.id));
    if (toAdd.length === 0) return;

    // Paint delay matches the existing draft/share restore pattern —
    // ensures blocks are mounted before we walk the DOM.
    const timer = setTimeout(() => {
      const v = viewerRef.current;
      if (!v) return;
      v.applySharedAnnotations(toAdd);
      toAdd.forEach(a => applied.set(a.id, fingerprint(a)));
    }, 100);

    return () => clearTimeout(timer);
    // viewerRef is a stable ref object and intentionally omitted from deps.
  }, [externalAnnotations, enabled, planKey, resetCount]);

  // Forget everything we've tracked and force a full re-apply on the next
  // effect run. Callers invoke this after an external action has wiped the
  // Viewer DOM out from under us (e.g. `clearAllHighlights()` during share
  // import) so live externals get repainted.
  const reset = useCallback(() => {
    appliedRef.current.clear();
    setResetCount(c => c + 1);
  }, []);

  return { reset };
}

function fingerprint(a: Annotation): string {
  return `${a.type}\u0000${a.originalText}`;
}
