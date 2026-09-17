import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The draft-and-save model behind the Source pane: the pane's buffer is
 * LOCAL until Save. The canvas re-renders from the draft after a short
 * debounce (the live preview); Save hands the whole text to the host's
 * `onSave` and makes one save point on the host's side; Discard drops the
 * draft. A source that changed underneath (the host's `source` prop moved
 * while the draft was dirty, or `onSave` answered `stale`) shows "Changed
 * since you opened" with Reload before Save is allowed again; Reload
 * adopts the newer text as the baseline and keeps a dirty draft's text (no
 * three-way merge).
 *
 * No continuous save exists here on purpose: a diagram mid-edit is a
 * broken diagram, and every keystroke saved would ship broken versions.
 */

/** The canvas re-renders the draft this long after the last keystroke. The
 * runtime re-lays out the whole diagram per render, so a typing burst is
 * one render, not one per key. A design constant, not a limit on the
 * person. */
export const PREVIEW_DEBOUNCE_MS = 250;

/** What the host answers a Save with. `ok` means the text is the new
 * baseline; `stale` means someone else saved first and the host hands back
 * what is there now, which Reload adopts. Any other failure is a thrown
 * error, shown as the save error with its message. */
export type SaveResult = { readonly status: 'ok' } | { readonly status: 'stale'; readonly currentSource: string };

export interface DiagramSourceDraft {
  /** The buffer's text. */
  readonly draft: string;
  /** The debounced draft the canvas renders. */
  readonly preview: string;
  /** The last saved text: the anchor writer's source. */
  readonly baseline: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** The source moved under the draft (the prop, or a stale answer). */
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
  /** The host's current text for the diagram. */
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

  // A new source (the host's refresh, our own save echoed back) is adopted
  // when the draft is clean; a dirty draft keeps its text and the strip
  // asks for Reload.
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

  // The live preview: one render per typing burst.
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
