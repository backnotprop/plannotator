import { useEffect } from 'react';

/**
 * The diff viewer can't render for B (no diff blocks), but the stale `isPlanDiffActive` flag would
 * otherwise keep the annotation toolstrip and sticky header hidden until the user pressed Escape.
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

export function usePlanDiffNavigationAutoExit(
  contentsVisible: boolean,
  exitPlanDiff: () => void,
): void {
  useEffect(() => {
    if (contentsVisible) exitPlanDiff();
  }, [contentsVisible, exitPlanDiff]);
}
