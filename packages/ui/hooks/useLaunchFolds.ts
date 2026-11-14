import { useCallback, useState } from 'react';
import { getItem, setItem } from '../utils/storage';
import type { LaunchKind } from './useLaunchConfig';

export const LAUNCH_FOLDS_KEY = 'plannotator.launchpad';

type Folds = Record<LaunchKind, boolean>;

export function readLaunchFolds(): Folds {
  try {
    const parsed = JSON.parse(getItem(LAUNCH_FOLDS_KEY) ?? '{}') as Partial<Folds>;
    return { review: parsed.review === true, guide: parsed.guide === true };
  } catch {
    return { review: false, guide: false };
  }
}

export function useLaunchFolds() {
  const [folds, setFolds] = useState<Folds>(readLaunchFolds);
  const toggle = useCallback((kind: LaunchKind) => {
    setFolds((prev) => {
      const next = { ...prev, [kind]: !prev[kind] };
      setItem(LAUNCH_FOLDS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return { folds, toggle };
}
