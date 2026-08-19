import { useEffect } from 'react';

/**
 * Exit the plan-diff view when the active document loses its diff baseline —
 * e.g. folder annotate: diff view is active on file A, then the user opens a
 * history-less file B. The diff viewer can't render for B (no diff blocks),
 * but the stale `isPlanDiffActive` flag would otherwise keep the annotation
 * toolstrip and sticky header hidden until the user pressed Escape.
 *
 * Callers must pass `active: false` for surfaces whose diff view is NOT
 * driven by usePlanDiff's markdown baseline (the --render-html surface uses
 * `htmlDiffHtml` with usePlanDiff fed nulls — auto-exiting there would kill
 * the HTML diff toggle immediately).
 *
 * Safe for plan review: the root document's baseline (`hasPreviousVersion`)
 * never goes false while the diff view is open there — versionInfo is stable
 * for the session and selectBaseVersion never clears the base plan — so this
 * effect only ever fires on document switches.
 */
export function usePlanDiffViewAutoExit(
  active: boolean,
  hasPreviousVersion: boolean,
  exitPlanDiff: () => void,
): void {
  useEffect(() => {
    if (active && !hasPreviousVersion) {
      exitPlanDiff();
    }
  }, [active, hasPreviousVersion, exitPlanDiff]);
}

/**
 * Exits the diff only when navigation moves into the document-contents view.
 *
 * `diffActive` is intentionally not an input. A desktop sidebar may already
 * remember the Contents tab while closed; activating the diff must not cause
 * that unchanged navigation state to close it in the same commit phase.
 */
export function usePlanDiffNavigationAutoExit(
  contentsVisible: boolean,
  exitPlanDiff: () => void,
): void {
  useEffect(() => {
    if (contentsVisible) exitPlanDiff();
  }, [contentsVisible, exitPlanDiff]);
}
