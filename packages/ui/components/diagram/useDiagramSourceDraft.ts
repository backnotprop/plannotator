import { useCallback, useEffect, useRef, useState } from 'react';

/** The runtime re-lays out the whole diagram per render, so a typing burst is one render, not one per key. */
export const PREVIEW_DEBOUNCE_MS = 250;

/**
 * `ok` means the text is the new baseline; `stale` means someone else saved first and the host
 * hands back what is there now, which Reload adopts.
 */
export type SaveResult = { readonly status: 'ok' } | { readonly status: 'stale'; readonly currentSource: string };

export interface DiagramSourceDraft {
  readonly draft: string;
  readonly preview: string;
  readonly baseline: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly stale: boolean;
  readonly saveError: string | null;
  readonly setDraft: (next: string) => void;
  readonly save: () => Promise<void>;
  readonly discard: () => void;
  readonly reload: () => void;
}

export function useDiagramSourceDraft({
  source,
  editable,
  onSave,
}: {
  readonly source: string;
  readonly editable: boolean;
  readonly onSave: ((source: string) => Promise<SaveResult>) | undefined;
}): DiagramSourceDraft {
  const [baseline, setBaseline] = useState(source);
  const [draft, setDraftState] = useState(source);
  const [preview, setPreview] = useState(source);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The newer text the host holds, when it differs from the baseline: a
  // prop that moved under a dirty draft, or a stale save's answer.
  const [newer, setNewer] = useState<string | null>(null);
  const dirty = draft !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (dirtyRef.current) {
      setBaseline((current) => {
        if (current !== source) setNewer(source);
        return current;
      });
      return;
    }
    setBaseline(source);
    setDraftState(source);
    setPreview(source);
    setNewer(null);
  }, [source]);

  useEffect(() => {
    if (draft === preview) return;
    const timer = setTimeout(() => setPreview(draft), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, preview]);

  const setDraft = useCallback(
    (next: string) => {
      if (!editable) return;
      setDraftState(next);
      setSaveError(null);
    },
    [editable],
  );

  const stale = newer !== null && newer !== baseline;

  const save = useCallback(async () => {
    if (!editable || saving || !dirtyRef.current || onSave === undefined) return;
    const text = draft;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await onSave(text);
      if (result.status === 'stale') {
        setNewer(result.currentSource);
      } else {
        setBaseline(text);
        setNewer(null);
      }
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : 'The diagram could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [draft, editable, onSave, saving]);

  const discard = useCallback(() => {
    setDraftState(baseline);
    setPreview(baseline);
    setSaveError(null);
  }, [baseline]);

  const reload = useCallback(() => {
    if (newer === null) return;
    setBaseline(newer);
    setSaveError(null);
    if (!dirtyRef.current) {
      setDraftState(newer);
      setPreview(newer);
    }
    setNewer(null);
  }, [newer]);

  return { draft, preview, baseline, dirty, saving, stale, saveError, setDraft, save, discard, reload };
}
