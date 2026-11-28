/**
 * State for a value a poll or an event reads again and again (the Ask of the open thread, the live sessions, who can
 * be tagged, the risk judgments): a read that brings the same value (as JSON, listSame.ts `keepSame`) sets nothing,
 * so nothing draws. Even an updater that hands back the held value makes React draw the component once before it
 * bails out; here the same value never reaches React at all.
 *
 * Returns the value, `keep` (set unless the same), and React's own setter for a change that must always land.
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { keepSame } from '../listSame';

export function useKeptState<T>(initial: T | (() => T)): [T, (next: T) => void, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(initial);
  const held = useRef(value);
  held.current = value;
  const keep = useCallback((next: T) => {
    const kept = keepSame(held.current, next);
    if (kept === held.current) return;
    held.current = kept;
    setValue(kept);
  }, []);
  return [value, keep, setValue];
}
