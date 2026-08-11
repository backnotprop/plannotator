import React, { useSyncExternalStore } from 'react';
import type { EditSessionDirtyStore } from '../edit/useEditSession';

interface EditSessionHudProps {
  /** Finish the session; net changes become suggestion annotations. */
  onComplete: () => void;
  /** Discard the session; no annotations, pristine diff restored. */
  onCancel: () => void;
  /** Live net change count of the session (see useEditSession.dirtyStore). */
  dirtyStore: EditSessionDirtyStore;
}

function changeLabel(count: number): string {
  if (count === 0) return 'No changes yet';
  return count === 1 ? '1 change' : `${count} changes`;
}

/**
 * EXPERIMENTAL edit-to-suggestion session HUD: a slim strip rendered directly
 * below the file header (inside the file card, above the content) while an
 * edit session is active. Carries the session controls and state, so the
 * header itself keeps only the Edit entry button when no session is active.
 *
 * Lives inside Pierre's memoized custom-header slot portal, so it rides the
 * sticky header; the dirty count arrives via an external store subscription
 * because the portal only republishes on updateItem, never on keystrokes.
 */
export const EditSessionHud: React.FC<EditSessionHudProps> = ({
  onComplete,
  onCancel,
  dirtyStore,
}) => {
  const changeCount = useSyncExternalStore(dirtyStore.subscribe, dirtyStore.getSnapshot);

  return (
    <div
      className="flex flex-shrink-0 items-center gap-2 border-b border-warning/20 bg-warning/5 px-3 py-1 text-xs"
      data-testid="edit-session-hud"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="flex items-center gap-1 font-medium text-warning" data-testid="edit-session-badge">
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        Editing
      </span>
      <span
        className="rounded border border-border/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70"
        title="Edit Code to Suggest is experimental"
      >
        Experimental
      </span>
      <span
        className={changeCount > 0 ? 'text-foreground/80' : 'text-muted-foreground/70'}
        data-testid="edit-session-dirty"
      >
        {changeLabel(changeCount)}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onComplete}
          className="flex items-center gap-1 rounded bg-primary/15 px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/25"
          title="Finish editing — net changes become a suggestion"
          data-testid="edit-session-complete"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span>Suggest</span>
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Discard edits and restore the diff"
          data-testid="edit-session-cancel"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span>Discard</span>
        </button>
      </div>
    </div>
  );
};
