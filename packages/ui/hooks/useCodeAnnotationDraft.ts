/**
 * Auto-save and auto-restore code review annotation drafts.
 *
 * Drafts are keyed by a content hash of the diff on the server side.
 * Same diff = same draft. On mount, if a draft exists, it is restored
 * silently — no dialog, no user action needed.
 */

import { useEffect, useRef } from 'react';
import type { CodeAnnotation } from '../types';
import { useSessionFetch } from './useSessionFetch';

const DEBOUNCE_MS = 500;

interface DraftData {
  codeAnnotations: CodeAnnotation[];
  viewedFiles?: string[];
  ts: number;
}

interface UseCodeAnnotationDraftOptions {
  annotations: CodeAnnotation[];
  viewedFiles: Set<string>;
  isApiMode: boolean;
  submitted: boolean;
  onRestore: (annotations: CodeAnnotation[], viewedFiles: string[]) => void;
}

export function useCodeAnnotationDraft({
  annotations,
  viewedFiles,
  isApiMode,
  submitted,
  onRestore,
}: UseCodeAnnotationDraftOptions): void {
  const fetch = useSessionFetch();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMountedRef = useRef(false);
  const restoredRef = useRef(false);
  const draftExistsOnServerRef = useRef(false);

  // Load and auto-restore draft on mount
  useEffect(() => {
    if (!isApiMode || restoredRef.current) return;

    fetch('/api/draft')
      .then(res => {
        if (!res.ok) return null;
        return res.json();
      })
      .then((data: DraftData | null) => {
        const restoredAnnotations = Array.isArray(data?.codeAnnotations) ? data.codeAnnotations : [];
        const restoredViewed = Array.isArray(data?.viewedFiles) ? data.viewedFiles : [];
        if (restoredAnnotations.length > 0 || restoredViewed.length > 0) {
          restoredRef.current = true;
          draftExistsOnServerRef.current = true;
          onRestore(restoredAnnotations, restoredViewed);
        }
        hasMountedRef.current = true;
      })
      .catch(() => {
        hasMountedRef.current = true;
      });
  }, [isApiMode]);

  // Debounced auto-save on annotation/viewed changes
  useEffect(() => {
    if (!isApiMode || submitted) return;
    if (!hasMountedRef.current) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    if (annotations.length === 0 && viewedFiles.size === 0) {
      if (draftExistsOnServerRef.current) {
        timerRef.current = setTimeout(() => {
          fetch('/api/draft', { method: 'DELETE' }).catch(() => {});
          draftExistsOnServerRef.current = false;
        }, DEBOUNCE_MS);
      }
      return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    }

    timerRef.current = setTimeout(() => {
      const payload: DraftData = {
        codeAnnotations: annotations,
        viewedFiles: [...viewedFiles],
        ts: Date.now(),
      };

      fetch('/api/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(() => { draftExistsOnServerRef.current = true; }).catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [annotations, viewedFiles, isApiMode, submitted]);
}
