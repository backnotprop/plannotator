import { useState, useEffect, useCallback, useRef } from 'react';
import type { EditorAnnotation } from '../types';

const POLL_INTERVAL = 500;
const IS_VSCODE = typeof window !== 'undefined' && (window as { __PLANNOTATOR_VSCODE?: boolean }).__PLANNOTATOR_VSCODE === true;

interface UseEditorAnnotationsReturn {
  editorAnnotations: EditorAnnotation[];
  deleteEditorAnnotation: (id: string) => void;
}

/**
 * Polls the server for editor annotations created by the VS Code extension.
 *
 * Only activates when running inside a VS Code webview (detected via
 * window.__PLANNOTATOR_VSCODE set by the theme bridge). In browser/shared URL
 * contexts, returns an empty array with zero network cost.
 */
export function useEditorAnnotations(): UseEditorAnnotationsReturn {
  const [annotations, setAnnotations] = useState<EditorAnnotation[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAnnotations = useCallback(async () => {
    try {
      const res = await fetch('/api/editor-annotations');
      if (!res.ok) return;
      const data = await res.json();
      const incoming: EditorAnnotation[] = data.annotations ?? [];
      setAnnotations((prev) => {
        if (prev.length === incoming.length && prev.every((a, i) => a.id === incoming[i].id)) return prev;
        return incoming;
      });
    } catch {
      // Silently fail — next poll will retry
    }
  }, []);

  useEffect(() => {
    if (!IS_VSCODE) return;

    // Initial fetch + start polling
    fetchAnnotations();
    intervalRef.current = setInterval(fetchAnnotations, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchAnnotations]);

  const deleteEditorAnnotation = useCallback(async (id: string) => {
    if (!IS_VSCODE) return;
    try {
      await fetch(`/api/editor-annotation?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // Silently fail — next poll will reconcile
    }
  }, []);

  return { editorAnnotations: annotations, deleteEditorAnnotation };
}
