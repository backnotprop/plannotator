/** The thread's "↓ N new" pill, and the small store its count lives in (so a scroll step redraws only the pill). */
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { Icon } from '../icons';

/** A number that changes often, read by one small component (useSyncExternalStore) so a change redraws only that component. */
export interface CountStore {
  get: () => number;
  set: (next: number) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createCountStore(): CountStore {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * The "↓ N new" pill. Its count changes on most scroll steps past new messages; it reads it from `count` so that
 * only this button redraws then, not the thread. `onDrawn` runs after each of its draws (the phone's foot row
 * places the pill by its width, which its count changes).
 */
export function NewPill({ count, onJump, onDrawn }: { count: CountStore; onJump: (below: boolean) => void; onDrawn?: () => void }) {
  const n = useSyncExternalStore(count.subscribe, count.get, count.get);
  useLayoutEffect(() => {
    onDrawn?.();
  });
  return (
    <button type="button" className="ib-npill" data-new-pill="" data-off={n > 0 ? undefined : ''} tabIndex={n > 0 ? 0 : -1} aria-hidden={n === 0} onClick={() => onJump(true)}>
      <Icon name="arrowDown" size={15} />
      {Math.max(1, n)} new
    </button>
  );
}
