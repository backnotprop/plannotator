import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation } from '../types';
import { AnnotationType } from '../types';
import type { ViewerHandle } from '../components/Viewer';

export function useExternalAnnotationHighlights(params: {
  viewerRef: React.RefObject<ViewerHandle | null>;
  externalAnnotations: Annotation[];
  enabled: boolean;
  planKey: string;
}): { reset: () => void } {
  const { viewerRef, externalAnnotations, enabled, planKey } = params;

  const appliedRef = useRef<Map<string, string>>(new Map());

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

    const toAdd = eligible.filter(a => !applied.has(a.id));
    if (toAdd.length === 0) return;

    const timer = setTimeout(() => {
      const v = viewerRef.current;
      if (!v) return;
      v.applySharedAnnotations(toAdd);
      toAdd.forEach(a => applied.set(a.id, fingerprint(a)));
    }, 100);

    return () => clearTimeout(timer);
    // viewerRef is a stable ref object and intentionally omitted from deps.
  }, [externalAnnotations, enabled, planKey, resetCount]);

  // Callers invoke this after an external action has wiped the Viewer DOM out from under us (e.g.
  const reset = useCallback(() => {
    appliedRef.current.clear();
    setResetCount(c => c + 1);
  }, []);

  return { reset };
}

function fingerprint(a: Annotation): string {
  return `${a.type}\u0000${a.originalText}`;
}
