import { useEffect } from 'react';

/** Leave the diff view when the document has no baseline; a stale active flag would keep the toolstrip hidden. */
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
