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
