import { useEffect } from 'react';

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
