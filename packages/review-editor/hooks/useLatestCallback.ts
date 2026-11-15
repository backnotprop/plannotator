import { useCallback, useRef } from 'react';

export function useLatestCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R;
export function useLatestCallback<A extends unknown[], R>(callback: ((...args: A) => R) | undefined): ((...args: A) => R) | undefined;
export function useLatestCallback<A extends unknown[], R>(callback: ((...args: A) => R) | undefined): ((...args: A) => R) | undefined {
  const latest = useRef(callback);
  latest.current = callback;
  const stable = useCallback((...args: A) => latest.current!(...args), []);
  return callback ? stable : undefined;
}
