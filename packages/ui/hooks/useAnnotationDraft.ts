/**
 * Auto-save and auto-restore annotation drafts.
 *
 * Stores full Annotation[] objects directly (preserving all fields
 * including `source`, `id`, offsets, and meta). On mount, if a draft
 * exists, it is restored silently via the onRestore callback.
 *
 * Backward compatible: loads old tuple-serialized drafts via fromShareable().
 */

import { useEffect, useRef } from 'react';
import type { Annotation, CodeAnnotation, ImageAttachment } from '../types';
import { fromShareable, parseShareableImages } from '../utils/sharing';
import type { ShareableAnnotation } from '../utils/sharing';
import { useSessionFetch } from './useSessionFetch';

const DEBOUNCE_MS = 500;

/** New format: full objects. */
interface DraftData {
  annotations: Annotation[];
  codeAnnotations?: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  ts: number;
}

/** Old format: compact tuples (for backward compat on load). */
interface LegacyDraftData {
  a: ShareableAnnotation[];
  g?: unknown[];
  d?: (string | null)[];
  ts: number;
}

function isLegacyDraft(data: unknown): data is LegacyDraftData {
  return !!data && typeof data === 'object' && 'a' in data && Array.isArray((data as LegacyDraftData).a);
}

interface UseAnnotationDraftOptions {
  annotations: Annotation[];
  codeAnnotations?: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  isApiMode: boolean;
  isSharedSession: boolean;
  submitted: boolean;
  onRestore: (annotations: Annotation[], codeAnnotations: CodeAnnotation[], globalAttachments: ImageAttachment[]) => void;
}

export function useAnnotationDraft({
  annotations,
  codeAnnotations = [],
  globalAttachments,
  isApiMode,
  isSharedSession,
  submitted,
  onRestore,
}: UseAnnotationDraftOptions): void {
  const fetch = useSessionFetch();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMountedRef = useRef(false);
  const restoredRef = useRef(false);

  // Load and auto-restore draft on mount
  useEffect(() => {
    if (!isApiMode || isSharedSession || restoredRef.current) return;

    fetch('/api/draft')
      .then(res => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data: DraftData | LegacyDraftData | null) => {
        if (!data) {
          hasMountedRef.current = true;
          return;
        }

        let restoredAnnotations: Annotation[];
        let restoredCodeAnnotations: CodeAnnotation[] = [];
        let restoredGlobal: ImageAttachment[];

        if (isLegacyDraft(data)) {
          restoredAnnotations = data.a.length > 0 ? fromShareable(data.a, data.d) : [];
          restoredGlobal = data.g ? (parseShareableImages(data.g as Parameters<typeof parseShareableImages>[0]) ?? []) : [];
        } else if (Array.isArray(data.annotations)) {
          restoredAnnotations = data.annotations;
          restoredCodeAnnotations = Array.isArray(data.codeAnnotations) ? data.codeAnnotations : [];
          restoredGlobal = Array.isArray(data.globalAttachments) ? data.globalAttachments : [];
        } else if (Array.isArray((data as DraftData).codeAnnotations) && (data as DraftData).codeAnnotations!.length > 0) {
          restoredAnnotations = [];
          restoredCodeAnnotations = (data as DraftData).codeAnnotations!;
          restoredGlobal = Array.isArray((data as DraftData).globalAttachments) ? (data as DraftData).globalAttachments : [];
        } else {
          hasMountedRef.current = true;
          return;
        }

        const totalCount = restoredAnnotations.length + restoredCodeAnnotations.length + restoredGlobal.length;
        if (totalCount > 0) {
          restoredRef.current = true;
          onRestore(restoredAnnotations, restoredCodeAnnotations, restoredGlobal);
        }
        hasMountedRef.current = true;
      })
      .catch(() => {
        hasMountedRef.current = true;
      });
  }, [isApiMode, isSharedSession]);

  // Debounced auto-save on annotation changes
  useEffect(() => {
    if (!isApiMode || isSharedSession || submitted) return;
    if (!hasMountedRef.current) return;
    if (annotations.length === 0 && codeAnnotations.length === 0 && globalAttachments.length === 0) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      const payload: DraftData = {
        annotations,
        codeAnnotations,
        globalAttachments,
        ts: Date.now(),
      };

      fetch('/api/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [annotations, codeAnnotations, globalAttachments, isApiMode, isSharedSession, submitted]);
}
