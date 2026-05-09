/**
 * Auto-save annotation drafts to the server.
 *
 * Stores full Annotation[] objects directly (preserving all fields
 * including `source`, `id`, offsets, and meta). On mount, checks for
 * an existing draft and exposes banner state for the UI to offer restoration.
 *
 * Backward compatible: loads old tuple-serialized drafts via fromShareable().
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Annotation, CodeAnnotation, ImageAttachment } from '../types';
import { fromShareable, parseShareableImages } from '../utils/sharing';
import type { ShareableAnnotation } from '../utils/sharing';

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

function formatTimeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

interface UseAnnotationDraftOptions {
  annotations: Annotation[];
  codeAnnotations?: CodeAnnotation[];
  globalAttachments: ImageAttachment[];
  isApiMode: boolean;
  isSharedSession: boolean;
  submitted: boolean;
}

interface UseAnnotationDraftResult {
  draftBanner: { count: number; timeAgo: string } | null;
  restoreDraft: () => { annotations: Annotation[]; codeAnnotations: CodeAnnotation[]; globalAttachments: ImageAttachment[] };
  dismissDraft: () => void;
}

export function useAnnotationDraft({
  annotations,
  codeAnnotations = [],
  globalAttachments,
  isApiMode,
  isSharedSession,
  submitted,
}: UseAnnotationDraftOptions): UseAnnotationDraftResult {
  const [draftBanner, setDraftBanner] = useState<{ count: number; timeAgo: string } | null>(null);
  const draftDataRef = useRef<{ annotations: Annotation[]; codeAnnotations: CodeAnnotation[]; globalAttachments: ImageAttachment[] } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMountedRef = useRef(false);

  // Load draft on mount
  useEffect(() => {
    if (!isApiMode || isSharedSession) return;

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
          // Old tuple format — deserialize via fromShareable
          restoredAnnotations = data.a.length > 0 ? fromShareable(data.a, data.d) : [];
          restoredGlobal = data.g ? (parseShareableImages(data.g as Parameters<typeof parseShareableImages>[0]) ?? []) : [];
        } else if (Array.isArray(data.annotations)) {
          // New direct-object format
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
          draftDataRef.current = { annotations: restoredAnnotations, codeAnnotations: restoredCodeAnnotations, globalAttachments: restoredGlobal };
          setDraftBanner({
            count: totalCount,
            timeAgo: formatTimeAgo(data.ts || 0),
          });
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
      }).catch(() => {
        // Silent failure — draft is best-effort
      });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [annotations, codeAnnotations, globalAttachments, isApiMode, isSharedSession, submitted]);

  const restoreDraft = useCallback(() => {
    const data = draftDataRef.current;
    setDraftBanner(null);
    draftDataRef.current = null;

    if (!data) return { annotations: [], codeAnnotations: [], globalAttachments: [] };

    return data;
  }, []);

  const dismissDraft = useCallback(() => {
    setDraftBanner(null);
    draftDataRef.current = null;

    fetch('/api/draft', { method: 'DELETE' }).catch(() => {
      // Silent failure
    });
  }, []);

  return { draftBanner, restoreDraft, dismissDraft };
}
